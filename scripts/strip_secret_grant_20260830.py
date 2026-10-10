# -*- coding: utf-8 -*-
"""
[1회성 · 2026-08-30] 죽은 전 레인이 라이브 소스에 넣어 둔 «숨김 1조 지급»(설정 7탭 → 코드)을 «전부» 제거한다.
  President 지시 「1조 달러 패치 하지마」 · Partner 지시 「라이브 코드에 숨김 기능을 넣지 않는다 · 엔진 무접촉」.
  ★각 치환은 «정확히 1건» 매치를 강제한다(0건·2건이면 즉시 중단).
  ★끝나면 gameWorld/store/Settings/ko/en 이 -21 빌드 baseline(md5)과 «일치»해야 한다 — 그게 «무흔적»의 증거다.
"""
import hashlib
import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent


def rd(p):
    return (ROOT / p).read_text(encoding='utf-8')


def wr(p, s):
    (ROOT / p).write_text(s, encoding='utf-8', newline='')


def sub1(s, a, b, label):
    n = s.count(a)
    if n != 1:
        raise SystemExit('FAIL %s: expected 1 match got %d for %r' % (label, n, a[:60]))
    return s.replace(a, b)


def cut1(s, pattern, label):
    ms = list(re.finditer(pattern, s, re.S))
    if len(ms) != 1:
        raise SystemExit('FAIL %s: expected 1 block got %d' % (label, len(ms)))
    m = ms[0]
    return s[:m.start()] + s[m.end():]


def md5(p):
    return hashlib.md5((ROOT / p).read_bytes()).hexdigest()


# ── gameWorld.ts (엔진) ──────────────────────────────────────────
p = 'src/lib/engine/gameWorld.ts'
s = rd(p)
s = sub1(s, "import { SECRET_GRANT_USD } from '../secretGrant';\n", '', 'gw import')
s = sub1(
    s,
    "/** ★'grant' = 숨김 1회 지급(lib/secretGrant). 같은 통로(현금 + bonusSeed)를 지나되 상한만 그 금액이다 */\n"
    "export type BonusCashKind = 'share' | 'attendance' | 'grant';",
    "export type BonusCashKind = 'share' | 'attendance';",
    'gw kind',
)
s = sub1(s, "  grant: SECRET_GRANT_USD,\n", '', 'gw cap')
wr(p, s)

# ── store.ts ─────────────────────────────────────────────────────
p = 'src/store/store.ts'
s = rd(p)
s = sub1(s, "import { LS_GRANT_1T, SECRET_GRANT_USD, isSecretCode } from '../lib/secretGrant';\n", '', 'store import')
s = cut1(s, r"  /\* ── 숨김 1회 지급 \(President 지시 2026-08-30.*?\n    return 'ok';\n  \}\n\n", 'store block')
wr(p, s)

# ── Settings.tsx ─────────────────────────────────────────────────
p = 'src/screens/Settings.tsx'
s = rd(p)
s = sub1(s, "import { useRef, useState } from 'react';", "import { useState } from 'react';", 'settings react import')
s = sub1(s, "import { bigMoney, money, pct } from '../lib/format';", "import { money, pct } from '../lib/format';", 'settings format import')
s = sub1(s, "import { SECRET_TAP_COUNT, SECRET_TAP_WINDOW_MS } from '../lib/secretGrant';\n", '', 'settings secret import')
s = sub1(
    s,
    "type SheetKind = 'lang' | 'theme' | 'updown' | 'rules' | 'code' | null;",
    "type SheetKind = 'lang' | 'theme' | 'updown' | 'rules' | null;",
    'settings sheetkind',
)
s = cut1(s, r"  /\*\n   \* ★숨김 진입점.*?t\('codeBad'\)\);\n  \};\n\n", 'settings taps block')
s = sub1(
    s,
    '<p className="num hint verlbl" style={{ marginTop: 10 }} onClick={onVersionTap}>',
    '<p className="num hint" style={{ marginTop: 10 }}>',
    'settings verlbl',
)
s = cut1(s, r"      \{sheet === 'code' && \(\n.*?        </Sheet>\n      \)\}\n(?=      \{sheet === 'rules')", 'settings code sheet')
wr(p, s)

# ── Journal.tsx ──────────────────────────────────────────────────
p = 'src/screens/Journal.tsx'
s = rd(p)
s = sub1(
    s,
    "                : e.side === 'grant'\n                  ? t('grantReward')\n                  : t('rewardShare')",
    "                : t('rewardShare')",
    'journal grant',
)
wr(p, s)

# ── locales ──────────────────────────────────────────────────────
LOC = {
    'src/locales/ko.json': [
        '    "codeTitle": "코드 입력",\n',
        '    "codePlaceholder": "코드",\n',
        '    "codeBad": "맞지 않는 코드예요",\n',
        '    "codeAlready": "이미 적용됐어요",\n',
        '    "codeDone": "적용됐어요 · 현금 {{v}}",\n',
        '    "grantReward": "특별 지급",\n',
    ],
    'src/locales/en.json': [
        '    "codeTitle": "Enter code",\n',
        '    "codePlaceholder": "Code",\n',
        '    "codeBad": "That code is not right",\n',
        '    "codeAlready": "Already applied",\n',
        '    "codeDone": "Applied · cash {{v}}",\n',
        '    "grantReward": "Special grant",\n',
    ],
}
for p, keys in LOC.items():
    s = rd(p)
    for k in keys:
        s = sub1(s, k, '', p + ' ' + k.strip()[:24])
    wr(p, s)

# ── app.css ──────────────────────────────────────────────────────
p = 'src/styles/app.css'
s = rd(p)
s = cut1(s, r"\n/\* ── 설정: 버전 라벨\(숨김 진입점.*?\.codein:focus \{\n  border-color: var\(--brand\);\n\}\n", 'css block')
wr(p, s)

# ── package.json ─────────────────────────────────────────────────
p = 'package.json'
s = rd(p)
s = sub1(s, 'npm run check:grant && ', '', 'pkg check:all')
s = sub1(s, '    "check:grant": "node scripts/check_secret_grant.mjs --selftest && node scripts/check_secret_grant.mjs",\n', '', 'pkg script')
wr(p, s)

for f in ['src/lib/secretGrant.ts', 'scripts/check_secret_grant.mjs', 'scripts/verify_grant1t.py']:
    (ROOT / f).unlink()
    print('deleted', f)

base = {}
for line in rd('_baseline/src_md5_after_attend_copy_20260830.txt').splitlines():
    if ' *' in line:
        h, f = line.split(' *', 1)
        base[f.strip()] = h.strip()
bad = 0
for f in ['src/lib/engine/gameWorld.ts', 'src/store/store.ts', 'src/screens/Settings.tsx', 'src/locales/ko.json', 'src/locales/en.json']:
    ok = md5(f) == base[f]
    bad += 0 if ok else 1
    print('%-34s %s  (baseline -21 %s)' % (f, 'MATCH' if ok else '★DIFF', base[f][:8]))
print('strip done · baseline mismatch %d' % bad)
sys.exit(1 if bad else 0)
