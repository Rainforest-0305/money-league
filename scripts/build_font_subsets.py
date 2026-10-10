# -*- coding: utf-8 -*-
"""Pretendard 서브셋 + unicode-range 청크 분할.

정적 단독 빌드는 외부 요청 0건이 요건이라 폰트를 동봉하는데, 변수폰트 전체가
2.0MB 라 앱 번들(gzip 142KB)의 14배가 된다.

전략:
  chunk0 : 라틴/기호 + **앱이 실제 렌더하는 한글 음절**을 명시 코드포인트로 지정 → 항상 로드
  chunk1~: 나머지 현대 한글(AC00-D7A3)을 연속 range 로 분할 → 유저가 그 음절을
           직접 입력(닉네임)할 때만 브라우저가 받아온다.
서브셋만 하고 끝내면 유저가 입력한 이름이 두부(tofu)로 깨진다. 그래서 청크 분할이 필수다.
"""
import io, glob, os, subprocess, sys

SRC = r'C:\Users\USER\Downloads\Pretendard-1.3.9\public\variable\PretendardVariable.ttf'
OUT = 'public/fonts'
N_CHUNKS = 20

# 1) 앱이 실제로 렌더하는 문자 수집
chars = set()
for p in ['src/**/*.ts', 'src/**/*.tsx', 'src/locales/*.json', 'index.html']:
    for f in glob.glob(p, recursive=True):
        try: chars |= set(io.open(f, encoding='utf-8').read())
        except Exception: pass

HANGUL0, HANGUL1 = 0xAC00, 0xD7A3
used_hangul = sorted({ord(c) for c in chars if HANGUL0 <= ord(c) <= HANGUL1})
base = set(range(0x20, 0x7F)) | {ord(c) for c in '…·—–“”‘’₩％°±×÷≤≥→←↑↓★☆♥✓⚠'}
base |= {ord(c) for c in chars if ord(c) < 0xAC00 or ord(c) > HANGUL1}
base |= set(range(0x3131, 0x3164))          # 호환 자모(조합 중 표시)
base = sorted(c for c in base if c >= 0x20)

def fmt(cps):
    """연속 구간을 U+XXXX-YYYY 로 압축."""
    out, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1: j += 1
        out.append('U+%04X' % cps[i] if i == j else 'U+%04X-%04X' % (cps[i], cps[j]))
        i = j + 1
    return ','.join(out)

def subset(cps, path):
    subprocess.run([sys.executable, '-m', 'fontTools.subset', SRC,
        '--unicodes=' + ','.join('U+%04X' % c for c in cps),
        '--flavor=woff2', '--layout-features=*', '--output-file=' + path],
        check=True, capture_output=True)
    return os.path.getsize(path)

os.makedirs(OUT, exist_ok=True)
faces, total = [], 0

cps0 = sorted(set(base) | set(used_hangul))
sz = subset(cps0, f'{OUT}/pretendard-0.woff2')
faces.append(('pretendard-0.woff2', fmt(cps0), sz, True))
total += sz
print('chunk0 (라틴+기호+앱 실사용 한글 %d자): %s bytes' % (len(used_hangul), f'{sz:,}'))

rest = [c for c in range(HANGUL0, HANGUL1 + 1) if c not in set(used_hangul)]
per = -(-len(rest) // N_CHUNKS)
for i in range(N_CHUNKS):
    part = rest[i * per:(i + 1) * per]
    if not part: break
    sz = subset(part, f'{OUT}/pretendard-{i+1}.woff2')
    faces.append((f'pretendard-{i+1}.woff2', fmt(part), sz, False))
    total += sz
print('나머지 한글 %d자 → %d청크, 합계 %s bytes' % (len(rest), len(faces) - 1, f'{total - faces[0][2]:,}'))

css = ['/* 자동 생성 — scripts/build_font_subsets.py. 직접 수정하지 말 것.',
       ' * Pretendard 1.3.9 (SIL OFL 1.1, OFL.txt 동봉).',
       ' * chunk0 만 초기 로드된다. 나머지는 해당 음절이 실제로 렌더될 때만 받아온다.',
       ' */']
for name, urange, sz, eager in faces:
    css.append('@font-face{font-family:"Pretendard Variable";font-style:normal;'
               'font-weight:45 920;font-display:swap;'
               'src:url("./%s") format("woff2-variations");unicode-range:%s}' % (name, urange))
io.open(f'{OUT}/pretendard.css', 'w', encoding='utf-8', newline='\n').write('\n'.join(css) + '\n')

print('---')
print('초기 로드(chunk0)      : %s bytes' % f'{faces[0][2]:,}')
print('전체 동봉(청크 %2d개)   : %s bytes' % (len(faces), f'{total:,}'))
print('기존 단일 변수폰트     : 2,057,688 bytes')
print('초기 전송 절감         : %.1f%%' % (100 * (1 - faces[0][2] / 2057688)))
