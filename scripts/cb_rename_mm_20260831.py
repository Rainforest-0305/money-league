# -*- coding: utf-8 -*-
"""[1회성 · -24] 사용자 노출 문자열 「중앙은행」 → 「마켓 메이커(LP)」 / 「Central bank」 → 「Market Maker (LP)」, 「개입」 → 「괴리 해소」. 코드 식별자·저장 키 무변경."""
import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent


def rw(p, pairs):
    f = ROOT / p
    s = f.read_text(encoding='utf-8')
    for a, b in pairs:
        if s.count(a) < 1:
            raise SystemExit('FAIL %s: not found %r' % (p, a[:60]))
        s = s.replace(a, b)
    f.write_text(s, encoding='utf-8', newline='')


rw('src/locales/ko.json', [
    ('"cbName": "중앙은행"', '"cbName": "마켓 메이커(LP)"'),
    ('"cbActive": "{{n}}회 개입"', '"cbActive": "괴리 해소 {{n}}회"'),
    ('"cbIntro": "마켓 메이커(LP)는 시장의 유동성 공급자예요.', '"cbIntro": "마켓 메이커(LP)는 지수와 구성 종목 사이 가격 차이를 맞춰 스프레드를 없애는 유동성 공급자예요.') if False else ('"cbIntro": "중앙은행은 시장의 유동성 공급자예요.', '"cbIntro": "마켓 메이커(LP)는 지수와 구성 종목 사이 가격 차이를 맞춰 스프레드를 없애는 유동성 공급자예요.'),
    ('"cbNoFills": "아직 개입한 적이 없어요. 지수가 제자리를 지키고 있어요."', '"cbNoFills": "아직 괴리를 해소한 적이 없어요. 지수가 제자리를 지키고 있어요."'),
    ('"cbFillGap": "개입 전 괴리 {{v}}"', '"cbFillGap": "해소 전 괴리 {{v}}"'),
])
rw('src/locales/en.json', [
    ('"cbName": "Central bank"', '"cbName": "Market Maker (LP)"'),
    ("\"cbIntro\": \"The central bank is the market's liquidity provider.", '"cbIntro": "The Market Maker (LP) is a liquidity provider that closes the spread between an index and its member stocks.'),
])
s = (ROOT / 'src/locales/en.json').read_text(encoding='utf-8')
for k in ('cbActive', 'cbNoFills', 'cbFillGap', 'cbIdle', 'cbIntro'):
    m = re.search(r'    "%s": "(.*)",' % k, s)
    print(k, '=', (m.group(1) if m else None))
rw('public/privacy.html', [
    ('중앙은행(게임 안 유동성 공급자)의 최근 체결 100건과 누적 개입 횟수. 순위표의 중앙은행 화면에 보여주는 데만 씁니다',
     '마켓 메이커(LP · 게임 안 유동성 공급자)의 최근 체결 100건과 누적 괴리 해소 횟수. 순위표의 마켓 메이커 화면에 보여주는 데만 씁니다'),
    ("The in-game central bank's last 100 fills and its total number of interventions, shown only on the leaderboard's central bank sheet",
     "The in-game Market Maker (LP)'s last 100 fills and its total number of spread closes, shown only on the leaderboard's Market Maker sheet"),
])
print('renamed')
