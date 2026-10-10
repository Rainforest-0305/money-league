# -*- coding: utf-8 -*-
"""[1회성 · -24] 중앙은행 시트 — 체결을 «지수 −/바스켓 +» 한 쌍으로, 포지션의 바스켓 다리는 「{지수명} 바스켓」으로. ko/en 키 3개."""
import io
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
        raise SystemExit('FAIL %s: expected 1 match got %d for %r' % (label, n, a[:70]))
    return s.replace(a, b)


p = 'src/screens/Leaderboard.tsx'
s = rd(p)
# 이름: `SPX:basket` → 「S&P 500 바스켓」
s = sub1(
    s,
    "  const nameOf = (tk: string) => (ko ? metaOf(tk).nameKo : metaOf(tk).nameEn);\n",
    "  const nameOf = (tk: string) => {\n"
    "    /* ★[-24] 바스켓 다리 포지션 키 `${지수}:basket` — 「S&P 500 바스켓」 */\n"
    "    const i = tk.indexOf(':basket');\n"
    "    const base = i > 0 ? tk.slice(0, i) : tk;\n"
    "    const nm = ko ? metaOf(base).nameKo : metaOf(base).nameEn;\n"
    "    return i > 0 ? (t('cbBasketName', { name: nm }) as string) : nm;\n"
    "  };\n",
    'lb nameOf',
)
s = sub1(
    s,
    "              <div className=\"kv\" style={{ padding: '10px 0' }}>\n"
    "                <span style={{ minWidth: 0 }}>\n"
    "                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>\n"
    "                    <span className={`badge ${f.side === 'buy' ? 'badge--up' : 'badge--down'}`} style={{ marginRight: 6 }}>\n"
    "                      {t(f.side === 'buy' ? 'cbBuy' : 'cbSell')}\n"
    "                    </span>\n"
    "                    {nameOf(f.ticker)}\n"
    "                  </span>\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>\n"
    "                    {t('cbFillGap', { v: gapPct(f.basisBefore) })}\n"
    "                  </span>\n"
    "                </span>\n"
    "                <span style={{ textAlign: 'right' }}>\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 15, fontWeight: 800 }}>{money(f.notional, 0)}</span>\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>\n"
    "                    {t('home:macroFeedDay', { n: f.gameDay + 1 })} · {money(f.price)}\n"
    "                  </span>\n"
    "                </span>\n"
    "              </div>\n",
    "              {/*\n"
    "                ★[-24] 한 체결 = «두 다리» — 지수(선물) 한 방향 + 구성종목 가중합 바스켓 반대 방향(같은 틱).\n"
    "                  두 줄을 한 카드 행에 쌓는다: 줄마다 [배지 매도/매수] 이름 · 오른쪽 명목. 옛 원장 체결(-23 이전, 바스켓 없음)은 한 줄만.\n"
    "              */}\n"
    "              <div className=\"kv\" style={{ padding: '10px 0', alignItems: 'flex-start' }}>\n"
    "                <span style={{ minWidth: 0 }}>\n"
    "                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>\n"
    "                    <span className={`badge ${f.side === 'buy' ? 'badge--up' : 'badge--down'}`} style={{ marginRight: 6 }}>\n"
    "                      {t(f.side === 'buy' ? 'cbBuy' : 'cbSell')}\n"
    "                    </span>\n"
    "                    {t('cbLegIndex', { name: nameOf(f.ticker) })}\n"
    "                  </span>\n"
    "                  {f.basketSide && (\n"
    "                    <span style={{ display: 'block', fontSize: 15, fontWeight: 700, marginTop: 4 }}>\n"
    "                      <span className={`badge ${f.basketSide === 'buy' ? 'badge--up' : 'badge--down'}`} style={{ marginRight: 6 }}>\n"
    "                        {t(f.basketSide === 'buy' ? 'cbBuy' : 'cbSell')}\n"
    "                      </span>\n"
    "                      {t('cbBasketName', { name: nameOf(f.ticker) })}\n"
    "                    </span>\n"
    "                  )}\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>\n"
    "                    {t('cbFillGap', { v: gapPct(f.basisBefore) })}\n"
    "                  </span>\n"
    "                </span>\n"
    "                <span style={{ textAlign: 'right', flex: '0 0 auto' }}>\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 15, fontWeight: 800 }}>{money(f.notional, 0)}</span>\n"
    "                  {f.basketNotional !== undefined && (\n"
    "                    <span className=\"num\" style={{ display: 'block', fontSize: 15, fontWeight: 800, marginTop: 4 }}>{money(f.basketNotional, 0)}</span>\n"
    "                  )}\n"
    "                  <span className=\"num\" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>\n"
    "                    {t('home:macroFeedDay', { n: f.gameDay + 1 })} · {money(f.price)}\n"
    "                  </span>\n"
    "                </span>\n"
    "              </div>\n",
    'lb fill pair',
)
wr(p, s)

p = 'src/locales/ko.json'
s = rd(p)
s = sub1(s, '    "cbFills": "최근 체결",\n', '    "cbFills": "최근 체결",\n    "cbLegIndex": "{{name}} 지수",\n    "cbBasketName": "{{name}} 바스켓",\n', 'ko keys')
s = sub1(
    s,
    '    "cbIntro": "중앙은행은 시장의 유동성 공급자예요. 지수 가격이 구성 종목의 가중합에서 {{p}} 넘게 벗어나면 반대 방향으로 사고팔아 제자리로 되돌려요. 자산이 무제한이라 순위에는 들어가지 않아요.",\n',
    '    "cbIntro": "중앙은행은 시장의 유동성 공급자예요. 지수 가격이 구성 종목의 가중합에서 {{p}} 넘게 벗어나면, 비싼 쪽을 팔고 싼 쪽을 사요. 지수와 구성 종목 바스켓을 같은 순간에 반대 방향으로 거래해 괴리를 좁혀요. 자산이 무제한이라 순위에는 들어가지 않아요.",\n',
    'ko intro',
)
wr(p, s)
p = 'src/locales/en.json'
s = rd(p)
s = sub1(s, '    "cbFills": "Recent fills",\n', '    "cbFills": "Recent fills",\n    "cbLegIndex": "{{name}} index",\n    "cbBasketName": "{{name}} basket",\n', 'en keys')
i = s.index('    "cbIntro": ')
j = s.index('\n', i)
s = s[:i] + '    "cbIntro": "The central bank is the market\'s liquidity provider. When an index drifts more than {{p}} from the weighted sum of its members, it sells the expensive side and buys the cheap side, trading the index and its member basket in opposite directions at the same moment to close the gap. Its funds are unlimited, so it never appears in the rankings.",' + s[j:]
wr(p, s)
print('cb arb ui patch applied')
