# -*- coding: utf-8 -*-
"""
.ait 안에 «광고 지면 ID 13종»이 «실렸는가» + deploymentId 추출 (2026-08-29).

  python scripts/ait_scan_adids.py <file.ait>

★소스(src/lib/ads.ts)의 AD_IDS 를 «읽어서» 기대 목록을 만든다 — 목록을 여기 다시 박지 않는다.
★.ait 는 zip 이다 → 풀어서 본다. 웹 경로 앱이라 web/assets/*.js 에 있어야 한다(전 엔트리를 훑는다).
★양성대조: 없는 ID('ait.v2.live.XXXXXXXXXXXXXXXX')는 0 이어야 한다(거짓양성 방지).
"""
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADS = (ROOT / 'src' / 'lib' / 'ads.ts').read_text(encoding='utf-8')
IDS = dict(re.findall(r"^\s*(\w+): '(ait\.v2\.live\.[0-9a-f]{16})'", ADS, re.M))
FAKE = 'ait.v2.live.XXXXXXXXXXXXXXXX'


def main(path):
    z = zipfile.ZipFile(path)
    blob = ''.join(z.read(n).decode('utf-8', 'ignore') for n in z.namelist() if not n.endswith('.map'))
    fails = []
    print('지면 %d종 (src/lib/ads.ts 에서 읽음)' % len(IDS))
    for k, v in IDS.items():
        c = blob.count(v)
        print('  %-24s %s  %d' % (k, v, c))
        if c < 1:
            fails.append(k)
    fake = blob.count(FAKE)
    print('  %-24s %s  %d  (양성대조: 0 이어야 정상)' % ('(없는 ID)', FAKE, fake))
    if fake != 0:
        fails.append('fake-id-hit')
    i = blob.find('deploymentId')
    dep = ''
    if i >= 0:
        m = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', blob[i:i + 200])
        dep = m.group(0) if m else ''
    print('deploymentId: %s' % (dep or '(없음)'))
    print('RESULT:', 'ALL PASS' if not fails else '*** FAIL *** %s' % fails)
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
