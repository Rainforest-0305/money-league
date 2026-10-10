# -*- coding: utf-8 -*-
"""
★제출용 `.ait` 가 «지금 소스»로 만들어진 것인가 — 한 줄로 답한다.

  python scripts/ait_freshness.py [ait]

왜 생겼나 (2026-09-10 · 레인 A 사고):
  소스를 고친 «뒤» 재빌드를 잊고 옛 패키지를 제출했다. 검사기·타입체크는 소스를 보고 전부 통과하는데
  실제로 나가는 물건에는 그 수정이 «없다». 통과했는데 틀리는 전형이다.
⇒ 「.ait 의 mtime 이 모든 소스 파일보다 «뒤»인가」를 기계가 본다. 사람의 기억에 맡기지 않는다.
⇒ ⛔ 조용히 고쳐 주지 않는다. 낡았으면 EXIT 1 로 죽고 «무엇이 더 새로운지»를 찍는다.
"""
import sys
import time
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
AIT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'moneyleague.ait'
WATCH = [('src', ('*.ts', '*.tsx', '*.json', '*.css')), ('public', ('*.html', '*.json')), ('.', ('index.html',))]


def main():
    if not AIT.exists():
        print('★FAIL  .ait 가 없다: %s' % AIT)
        return 1
    ait_m = AIT.stat().st_mtime
    newer = []
    total = 0
    for sub, pats in WATCH:
        base = ROOT / sub
        for pat in pats:
            it = base.rglob(pat) if sub != '.' else base.glob(pat)
            for p in it:
                if 'node_modules' in p.parts or 'dist' in p.parts:
                    continue
                total += 1
                if p.stat().st_mtime > ait_m + 1:
                    newer.append((p.relative_to(ROOT).as_posix(), p.stat().st_mtime))
    stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ait_m))
    print('%s  mtime %s  · 대상 소스 %d개' % (AIT.name, stamp, total))
    if newer:
        newer.sort(key=lambda x: -x[1])
        print('★FAIL  .ait 보다 «새로운» 소스가 %d개 있다 — 재빌드 없이 제출하면 그 수정은 안 나간다:' % len(newer))
        for rel, m in newer[:12]:
            print('   %s  (%s)' % (rel, time.strftime('%H:%M:%S', time.localtime(m))))
        return 1
    print('PASS  모든 소스가 .ait 보다 «오래됐다» = 이 패키지는 지금 소스로 만들어졌다')
    return 0


if __name__ == '__main__':
    sys.exit(main())
