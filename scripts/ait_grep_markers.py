# -*- coding: utf-8 -*-
"""번들 안 문자열 계수(압축 해제 뒤) — 금지 표지(1조·DEV·TEST_) 0 과 이번 패치 표지 ≥1 을 한 번에.
  python scripts/ait_grep_markers.py [ait] [키워드...]
"""
import io
import sys
import zipfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ait = sys.argv[1] if len(sys.argv) > 1 else 'moneyleague.ait'
keys = sys.argv[2:] or ['secretGrant', 'ml.grant', '__ML_DEV_GRANT__', 'RIMI-1T', 'TEST_01M', 'ml.equity', 'ml.cbfills', 'cbSession', 'assetFlowSeam', 'cbsession', 'backdrop-filter']
z = zipfile.ZipFile(ait)
js = ''.join(z.read(n).decode('utf-8', 'replace') for n in z.namelist() if n.startswith('web/assets') and n.endswith('.js'))
css = ''.join(z.read(n).decode('utf-8', 'replace') for n in z.namelist() if n.startswith('web/assets') and n.endswith('.css'))
html = ''.join(z.read(n).decode('utf-8', 'replace') for n in z.namelist() if n.startswith('web/') and n.endswith('.html'))
for k in keys:
    print('%-20s JS=%-3d CSS=%-3d HTML=%d' % (k, js.count(k), css.count(k), html.count(k)))
