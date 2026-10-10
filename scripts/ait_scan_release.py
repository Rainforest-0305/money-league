# -*- coding: utf-8 -*-
"""
.ait 번들 «출시 전» 계수 — ★양성대조를 «먼저» 통과시킨 뒤에만 0건을 말한다.

  python scripts/ait_scan_release.py [ait 경로]

★★왜 양성대조가 «먼저»인가 (auto-memory 「0건은 부재의 증거가 아니다」)
  이 조직에서 번들 검사가 «죽어 있던» 사고가 여러 번 나왔다 — zip 을 안 풀거나,
  이스케이프된 문자열을 놓치거나, 재수출 배럴 때문에 참조를 못 세거나.
  ⇒ ★«반드시 있어야 하는 문자열»을 먼저 세서 검사기가 살아 있음을 증명한다.
    그게 0 이면 검사기가 죽은 것이고, 그 실행의 모든 0건은 무효다.

★검사
  ① 양성대조 — 「트레이더」·「머니 리그」·「whale」·「청산」 이 «잡히는가»
  ② ⛔「봇」/「bot」 표기 0 (President 지시)
  ③ ⛔「머니리그」(붙여쓰기) 0 — 8/19 에 3초 자동반려된 그 항목
  ④ ⛔raw i18n 키 패턴 0 (번들에 «문구 대신 키»가 남아 있지 않은가)
  ⑤ ⛔blur / backdrop-filter 0 (CSS)
  ⑥ 광고 지면 9종 «전부» 존재
  ⑦ MS Store 자산 제외 확인
"""
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AIT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'moneyleague.ait'

# ★광고 지면 — lib/ads.ts 의 ★`AD_IDS` 객체에서 «유도»한다(손으로 적으면 그 목록이 다음 사고다).
#   ⛔이름 정규식(`banner[A-Z]\w+`)으로 긁으면 «함수 이름»까지 잡힌다 —
#     실제로 `bannerSupported()`(지원 여부 판정 «함수»)를 지면으로 오인해 FAIL 이 났다.
#   ⇒ ★AD_IDS 블록 «안»의 `key: 'ait.v2.live.…'` 쌍만 센다. 그게 «지면의 정의»다.
ADS_TS = (ROOT / 'src' / 'lib' / 'ads.ts').read_text(encoding='utf-8')
_blk = ADS_TS[ADS_TS.index('export const AD_IDS'):]
_blk = _blk[:_blk.index('} as const')]
SLOT_IDS = dict(re.findall(r"(\w+):\s*'(ait\.v2\.live\.[0-9a-f]+)'", _blk))

raw = AIT.read_bytes()
texts = []
with zipfile.ZipFile(AIT) as z:
    names = z.namelist()
    for n in names:
        if n.endswith(('.js', '.css', '.html', '.json', '.map')):
            try:
                texts.append((n, z.read(n).decode('utf-8', 'replace')))
            except Exception:  # noqa: BLE001
                pass


def unescape_u(t: str) -> str:
    r"""
    ★★ `\uXXXX` 이스케이프를 «실제 글자»로 되돌린다.

    ⛔이걸 안 하면 「봇 0건」이 ★거짓이 될 수 있다 — 번들 안에 한글이
      `\uc120\ub3c4`(선도) 처럼 «이스케이프된 채로» 들어 있는 구간이 실제로 있다.
      (이번 빌드 실측: bootstrap.js 에 선도 2건이 «리터럴», 2건이 «이스케이프»)
    ★auto-memory 「죽은 검사기 5형」의 ★이스케이프 케이스가 바로 이것이다.
      금칙어를 이스케이프로 넣으면 검사기가 조용히 통과시킨다.
    """
    return re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), t)


texts = [(n, unescape_u(t)) for n, t in texts]
blob = '\n'.join(t for _, t in texts)
# ★★웹 자산만 따로 — ⛔`bundle.{ios,android}.*.js` 는 «앱인토스 RN 프레임워크»다.
#   그 안에는 `@react-native-community/blur` 모듈 등록이 들어 있어 `blur(` 이 잡힌다.
#   ★그건 «내 CSS」가 아니다. 프레임워크를 내가 고칠 수도 없다.
#   ⇒ blur 검사는 «내가 쓴 자산»에만 건다. 안 그러면 영원히 FAIL 이고, 그럼 검사기를 끄게 된다.
web_blob = '\n'.join(t for n, t in texts if not n.startswith('bundle.'))
# ★preamble(zip 밖)도 문자열이 산다 — 통째로 붙여서 센다
blob_all = blob + '\n' + unescape_u(raw.decode('utf-8', 'replace'))

fails = []


def count(label, pattern, expect_zero, flags=0, scope=None):
    hits = re.findall(pattern, scope if scope is not None else blob_all, flags)
    n = len(hits)
    ok = (n == 0) if expect_zero else (n > 0)
    mark = 'PASS' if ok else '*** FAIL ***'
    sample = str(sorted(set(hits))[:4]) if hits else ''
    print(f"  {mark:12s} {label:44s} {n:>6}건  {sample[:70]}")
    if not ok:
        fails.append((label, n, sample))
    return n


print(f'대상: {AIT}  ({len(raw):,} B) · zip 엔트리 {len(names)}')
print(f'스캔한 텍스트 파일 {len(texts)}개 · 총 {len(blob):,}자 (+preamble)')

print('\n① ★양성대조 — «있어야 하는» 것이 잡히는가 (검사기 생존 증명)')
alive = 0
alive += count('「트레이더」가 있다', r'트레이더', False)
alive += count('「머니 리그」(띄어쓰기)가 있다', r'머니 리그', False)
alive += count('「청산」이 있다', r'청산', False)
alive += count('「whale」이 있다', r'whale', False)
alive += count('「선도」·「스왑」(신규)이 있다', r'선도|스왑', False)
if fails:
    print('\n⛔양성대조 실패 — 검사기가 죽었다. 아래 0건은 «무효»다.')
    sys.exit(1)

print('\n② ⛔없어야 하는 것')
count('「봇」 표기', r'봇', True)
count('bot/Bot 표기(닉네임·문구)', r'[""\'>]\s*[Bb]ot\b', True)
count('★「머니리그」(붙여쓰기)', r'머니리그', True)
count('raw i18n 키 노출 패턴(derivatives.*)', r'["\'>]derivatives\.[a-z]+\.[a-z]', True)
count('raw i18n 키 노출 패턴(traders.concept.*.name 문자열)', r'>traders\.concept\.', True)
count('★blur()  ※웹 자산만(RN 프레임워크 제외)', r'blur\(', True, scope=web_blob)
count('★backdrop-filter  ※웹 자산만', r'backdrop-filter|backdropFilter', True, scope=web_blob)
# ★프레임워크 쪽 blur 는 «보고만» 한다 — 판정 대상이 아니지만 «숨기지도» 않는다
fw = len(re.findall(r'blur\(', '\n'.join(t for n, t in texts if n.startswith('bundle.'))))
print(f"  (참고)       RN 프레임워크 번들의 blur( 참조                {fw:>6}건  ← 내 자산 아님")

print('\n③ 광고 지면 (lib/ads.ts 의 AD_IDS 에서 유도)')
print(f'  지면 {len(SLOT_IDS)}종: {sorted(SLOT_IDS)}')
# ★이름이 아니라 ★«실제 지면 ID»가 번들에 있는지 센다. 이름은 minify 로 사라질 수 있다.
missing = [k for k, v in SLOT_IDS.items() if v not in blob_all]
print(f"  {'PASS' if not missing else '*** FAIL ***':12s} 지면 ID {len(SLOT_IDS) - len(missing)}/{len(SLOT_IDS)} 존재  누락={missing}")
if missing:
    fails.append(('광고 지면 누락', len(missing), str(missing)))
# ★양성대조 — «없는» 지면 ID 는 안 잡혀야 한다(거짓 PASS 방지)
bogus = 'ait.v2.live.XXXXXXXXXXXXXXXX'
print(f"  {'PASS' if bogus not in blob_all else '*** FAIL ***':12s} [양성대조] 가짜 지면 ID 는 «안» 잡힌다")

print('\n④ MS Store / 불필요 자산 제외')


# ⚠★[2026-08-21 실측 — 이 검사가 «맞는 빌드에 FAIL» 을 찍었다]
#   옛 판정은 `'sw.js' in 경로.lower()` 였다. vite 의 콘텐츠 해시가 우연히 `...sW` 로 끝나면
#   `web/assets/bootstrap-D_cYnOsW.js` 가 ★sw.js 로 «잡힌다». 실제로 이번 빌드에서 났다.
#   (ait_header.py stale 기대값 사고와 같은 형태 — 검사기가 틀리면 맞는 것을 틀렸다고 말한다)
# ⇒ 파일명은 «파일명끼리», 폴더는 «경로 조각»으로 본다. 부분 문자열 포함으로 판정하지 않는다.
EXCLUDE_FILES = ('manifest.json', 'privacy.html', 'sw.js')
EXCLUDE_DIRS = ('screenshots', 'icons')


def is_excluded(path: str) -> bool:
    parts = path.lower().split('/')
    if parts[-1] in EXCLUDE_FILES:
        return True
    return any(d in parts[:-1] for d in EXCLUDE_DIRS)


# ★대조 — 이 판정기가 «살아 있는지»와 «과잉 검거하지 않는지»를 둘 다 본다
_pos = ['web/sw.js', 'web/icons/a.png', 'web/screenshots/s1.png', 'web/manifest.json']
_neg = ['web/assets/bootstrap-D_cYnOsW.js', 'web/assets/index-Nosw.js', 'web/fonts/pretendard-0.woff2']
_ctl_ok = all(is_excluded(x) for x in _pos) and not any(is_excluded(x) for x in _neg)
print(f"  {'PASS' if _ctl_ok else '*** FAIL ***':12s} [양성/음성 대조] 제외 판정기가 살아 있고 «과잉 검거»하지 않는다")
if not _ctl_ok:
    fails.append(('제외 판정기 대조 실패', 0, str([x for x in _neg if is_excluded(x)])))

heavy = [n for n in names if is_excluded(n)]
print(f"  {'PASS' if not heavy else '*** FAIL ***':12s} 제외 대상 잔존 {len(heavy)}건  {heavy[:5]}")
if heavy:
    fails.append(('MS Store 자산 잔존', len(heavy), str(heavy[:5])))

print('\n⑤ 폰트 subset 존재(제외되면 안 되는 것)')
fonts = [n for n in names if 'font' in n.lower() or n.endswith(('.woff2', '.woff'))]
print(f"  {'PASS' if fonts else '*** FAIL ***':12s} 폰트 {len(fonts)}건  {fonts[:3]}")
if not fonts:
    fails.append(('폰트 누락', 0, ''))

print()
if fails:
    for f in fails:
        print('  ★FAIL', f)
    print(f'\nFAILED: {len(fails)}건')
    sys.exit(1)
print('RESULT: ALL PASS  (★양성대조 통과 후의 0건이다)')
