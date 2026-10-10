# -*- coding: utf-8 -*-
"""
.ait 번들에 «정정본» privacy.html 이 실제로 실렸는지 검사.

왜 필요한가 (2026-08-22~23)
--------------------------------------------------------------------------
vite.config.ts 의 `ait-public-allowlist` 플러그인은 AIT_BUILD=1 일 때
public/ 의 «허용목록 밖»을 fs.rmSync 로 지운다. 전에는 목록이
['fonts','404.html'] 이라 ★privacy.html 이 .ait 에서 «삭제»됐다.
= 앱 안 방침 링크가 «토스에서만» 404 나는 상태였고, 라이브에서 우리 눈에 안 보인다.

그래서 목록에 privacy.html 을 넣었는데 — ★「소스를 고쳤으니 번들에 있을 것이다」는
«추론»이다. 그건 원래 결함의 형태와 «똑같다»(「public 에 있으니 번들에 있을 것이다」).
⇒ 번들을 «열어서» 확인한다. 이 파일이 그 확인을 사람 기억에서 떼어낸다.

무엇을 보는가
--------------------------------------------------------------------------
 1. web/privacy.html 이 «있다»
 2. 그 내용이 public/privacy.html 과 «md5 까지 같다»  ← 동봉본≠게시본이면 그게 새 사고다
 3. 방침 «내용 불변식» (금지문장 0 · SDK-DECLARE 1)  ← md5 는 서식만 바뀌어도 달라진다
 4. 허용목록이 실제로 «일했다» (MS Store/PWA 자산이 안 실렸다)
 5. 증분 KB 를 «실측»으로 보고 (추론값을 쓰지 않는다)

사용법:  python scripts/check_ait_privacy.py [경로.ait]
"""
import hashlib
import sys
import zipfile
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public' / 'privacy.html'
MEMBER = 'web/privacy.html'
PASS = FAIL = 0


def check(label, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  OK   ' + label + (('  ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  ★FAIL ' + label + (('  ' + detail) if detail else ''))


def main():
    ait = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'moneyleague.ait'
    if not ait.exists():
        print('★.ait 가 없다: %s' % ait)
        return 2
    if not SRC.exists():
        print('★정본이 없다: %s' % SRC)
        return 2

    src = SRC.read_bytes()
    src_md5 = hashlib.md5(src).hexdigest()
    print('.ait   : %s' % ait.name)
    print('정본   : public/privacy.html  %s · %d B\n' % (src_md5[:8], len(src)))

    z = zipfile.ZipFile(ait)
    names = z.namelist()

    check('★번들에 %s 이 «있다»' % MEMBER, MEMBER in names,
          '없으면 토스에서만 404 난다')
    if MEMBER not in names:
        print('\n결과: PASS %d · FAIL %d' % (PASS, FAIL))
        return 1

    blob = z.read(MEMBER)
    got = hashlib.md5(blob).hexdigest()
    check('★동봉본이 정본과 md5 까지 같다', got == src_md5,
          '%s vs %s' % (got[:8], src_md5[:8]))

    # ★md5 는 서식만 바뀌어도 달라진다. «내용 불변식»이 더 강하다.
    txt = blob.decode('utf-8', 'replace')
    gone = ['외부와 네트워크 통신을 하지 않습니다',
            '전송 구간이 존재하지 않으므로',
            '210명의 트레이더', 'no network requests',
            'no advertising SDKs', 'The 210 other traders', 'The 210 traders']
    left = [g for g in gone if g in txt]
    check('★금지문장 0건 (ko+en)', not left, left or '0건')
    check('SDK-DECLARE 가 살아 있다', txt.count('SDK-DECLARE') == 1,
          '%d개' % txt.count('SDK-DECLARE'))

    # ★허용목록이 «일했는가» — 안 들어가야 할 것이 안 들어갔는지
    junk = [n for n in names
            if any(k in n.lower() for k in ('screenshot', 'manifest.json', 'sw.js', 'icon-'))]
    check('허용목록이 일했다 (스토어·PWA 자산 미포함)', not junk,
          junk[:3] or '0건')

    print('\n  ★증분 실측: %s = %d B (%.1f KB)' % (MEMBER, len(blob), len(blob) / 1024))
    print('\n결과: PASS %d · FAIL %d' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
