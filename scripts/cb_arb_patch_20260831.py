# -*- coding: utf-8 -*-
"""
[1회성 · 2026-08-31 · -24] 중앙은행 개입 = «지수 vs 구성종목 가중합 바스켓 동시 반대매매» (President: 「스프레드를 없애라 … 같은 가중합 포트폴리오랑 동시에 반대 방향으로」).
  엔진 접촉은 «체결 훅»뿐: centralBank.ts(사이징·두 다리 실행·체결 기록) · world.ts(바스켓 체결 3 메서드) · gameWorld.ts(보기: 바스켓 포지션 평가).
  ⛔가격 엔진·봇·주문·청산·수수료 로직 무변경. CB OFF 경로 무변경(개입 없는 구간 바이트 동일 = cbank/cbarb BEFORE 대조).
  각 치환은 정확히 1건 매치를 강제한다.
"""
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


# ── centralBank.ts ────────────────────────────────────────────────────────────
p = 'src/lib/engine/centralBank.ts'
s = rd(p)
s = sub1(
    s,
    "  /** 개입 «직전» 괴리(비율) */\n  basisBefore: number;\n}\n",
    "  /** 개입 «직전» 괴리(비율) */\n  basisBefore: number;\n"
    "  /**\n"
    "   * ★[-24] 바스켓 다리 — 지수 다리와 «반대 방향»으로 같은 틱에 체결한 구성종목 가중합. 한 쌍이 한 체결 기록이다.\n"
    "   *   basketSide 는 side 의 반대 · basketPrice 는 바스켓 «단위가»(체결 직전 공정가 × 체결 비율)\n"
    "   */\n"
    "  basketSide: Side;\n  basketNotional: number;\n  basketPrice: number;\n}\n",
    'cb fill type',
)
s = sub1(
    s,
    "  /** 체결. 돌려주는 값은 «실제 체결가» */\n  fill(ticker: string, side: Side, notional: number): number;\n}\n",
    "  /** 체결. 돌려주는 값은 «실제 체결가» */\n  fill(ticker: string, side: Side, notional: number): number;\n"
    "  /** ★[-24] 지수의 «공정가»(구성종목 가중합/divisor) */\n  fairOf(ticker: string): number;\n"
    "  /** ★[-24] 바스켓 «유효 깊이»: 바스켓 명목 N 이 공정가를 W·N/깊이 만큼 움직이게 하는 깊이 = 1/Σ(v_k²/depth_k), v_k = 가치가중 */\n  basketDepth(ticker: string): number;\n"
    "  /** ★[-24] 바스켓 명목 상한 = min_k(구성종목 k 단일주문 상한 / v_k) — 어느 종목도 자기 상한을 넘지 않게 */\n  basketMaxNotional(ticker: string): number;\n"
    "  /** ★[-24] 바스켓 체결: 구성종목 전부에 가치가중으로 나눠 fillPrice+addOrderFlow. 돌려주는 값은 바스켓 «단위 체결가»(공정가 × 가중 체결비율) */\n  fillBasket(ticker: string, side: Side, notional: number): number;\n}\n",
    'cb market iface',
)
s = sub1(
    s,
    "      const want = (ab / ORDER_FLOW_WEIGHT) * m.liquidityDepth(tk) * (1 + (this.rng.range(-1, 1)) * CB_SIZE_JITTER);\n"
    "      const cap = m.maxOrderNotional(tk) * CB_MAX_ORDER_FRAC;\n"
    "      const notional = Math.min(cap, want);\n"
    "      if (!(notional > 1)) continue;\n"
    "      const side: Side = b > 0 ? 'sell' : 'buy';\n"
    "      this.execute(m, tk, side, notional, b);\n",
    "      /*\n"
    "       * ★[-24] 차익거래 — 괴리 Δ 를 «양쪽에서 절반씩» 닫는다: 지수 다리는 지수 가격을 Δ/2, 바스켓 다리는 공정가를 Δ/2(반대 방향).\n"
    "       *   지수 명목 N_i = (Δ/2)/W × depth_idx · 바스켓 명목 N_b = (Δ/2)/W × basketDepth. 상한은 «공통 배율» f 로 같이 줄인다 —\n"
    "       *   한쪽만 줄면 짝이 깨져 지수 단독 매매(옛 구조)로 되돌아간다. 무작위 ±jitter 도 두 다리에 같이.\n"
    "       */\n"
    "      const jitter = 1 + this.rng.range(-1, 1) * CB_SIZE_JITTER;\n"
    "      const half = (ab / 2) / ORDER_FLOW_WEIGHT;\n"
    "      const wantIdx = half * m.liquidityDepth(tk) * jitter;\n"
    "      const wantBk = half * m.basketDepth(tk) * jitter;\n"
    "      const capIdx = m.maxOrderNotional(tk) * CB_MAX_ORDER_FRAC;\n"
    "      const capBk = m.basketMaxNotional(tk);\n"
    "      const f = Math.min(1, capIdx / wantIdx, capBk / wantBk);\n"
    "      const notional = wantIdx * f;\n"
    "      const basketNotional = wantBk * f;\n"
    "      if (!(notional > 1) || !(basketNotional > 1)) continue;\n"
    "      const side: Side = b > 0 ? 'sell' : 'buy';\n"
    "      this.execute(m, tk, side, notional, basketNotional, b);\n",
    'cb sizing',
)
s = sub1(
    s,
    "  private execute(m: CbMarket, ticker: string, side: Side, notional: number, basisBefore: number): void {\n"
    "    const price = m.fill(ticker, side, notional);\n"
    "    if (!(price > 0)) return;\n"
    "    const qty = (notional / price) * (side === 'buy' ? 1 : -1);\n"
    "    const pos = this.positions.get(ticker) ?? { ticker, qty: 0, avgCost: 0 };\n",
    "  private execute(m: CbMarket, ticker: string, side: Side, notional: number, basketNotional: number, basisBefore: number): void {\n"
    "    const price = m.fill(ticker, side, notional);\n"
    "    if (!(price > 0)) return;\n"
    "    /* ★[-24] 반대 다리 — 같은 틱, 반대 방향, 구성종목 가중합. 포지션 키는 `${지수}:basket`(단위 = 바스켓 1단위 = 공정가 1) */\n"
    "    const basketSide: Side = side === 'buy' ? 'sell' : 'buy';\n"
    "    const basketPrice = m.fillBasket(ticker, basketSide, basketNotional);\n"
    "    if (basketPrice > 0) this.book(`${ticker}:basket`, basketSide, basketNotional, basketPrice);\n"
    "    this.book(ticker, side, notional, price);\n"
    "    this.interventions++;\n"
    "    this.notionalTotal += notional + basketNotional;\n"
    "    this.fills.unshift({ id: ++this.fillId, tick: m.tick, gameDay: m.gameDay, ticker, side, notional, price, basisBefore, basketSide, basketNotional, basketPrice });\n"
    "    if (this.fills.length > CB_FILLS_MAX) this.fills.pop();\n"
    "  }\n\n"
    "  /** 포지션 장부 — 지수 다리·바스켓 다리가 «같은 규칙»(평균단가 가중 · 반대면 줄이거나 뒤집음)으로 기록된다 */\n"
    "  private book(ticker: string, side: Side, notional: number, price: number): void {\n"
    "    const qty = (notional / price) * (side === 'buy' ? 1 : -1);\n"
    "    const pos = this.positions.get(ticker) ?? { ticker, qty: 0, avgCost: 0 };\n",
    'cb execute head',
)
s = sub1(
    s,
    "    if (Math.abs(pos.qty) < 1e-9) this.positions.delete(ticker);\n"
    "    else this.positions.set(ticker, pos);\n"
    "    this.interventions++;\n"
    "    this.notionalTotal += notional;\n"
    "    this.fills.unshift({ id: ++this.fillId, tick: m.tick, gameDay: m.gameDay, ticker, side, notional, price, basisBefore });\n"
    "    if (this.fills.length > CB_FILLS_MAX) this.fills.pop();\n"
    "  }\n",
    "    if (Math.abs(pos.qty) < 1e-9) this.positions.delete(ticker);\n"
    "    else this.positions.set(ticker, pos);\n"
    "  }\n",
    'cb execute tail',
)
wr(p, s)

# ── world.ts: 바스켓 체결 훅 3 + cbMarket 배선 ───────────────────────────────────
p = 'src/lib/engine/world.ts'
s = rd(p)
s = sub1(
    s,
    "    fill: (t, side, notional) => this.centralBankTrade(t, side, notional),\n  };\n",
    "    fill: (t, side, notional) => this.centralBankTrade(t, side, notional),\n"
    "    /* ★[-24] 바스켓 다리 — 지수 정의(engine.indexes)의 구성종목·가중치에서 «유도». 지수마다 자기 바스켓(SPX 500 · NDX 100) */\n"
    "    fairOf: (t) => this.engine.fairPriceOf(t) ?? this.engine.priceOf(t),\n"
    "    basketDepth: (t) => this.basketDepth(t),\n"
    "    basketMaxNotional: (t) => this.basketMaxNotional(t),\n"
    "    fillBasket: (t, side, notional) => this.centralBankBasketTrade(t, side, notional),\n"
    "  };\n",
    'world cbMarket',
)
s = sub1(
    s,
    "  // ── 이벤트 ────────────────────────────────────────────────────────────\n  on(fn: Listener): () => void {\n",
    "  /**\n"
    "   * ★[-24] 지수 구성종목의 «가치가중» v_k = w_k·p_k / Σ w·p (지금 가격 기준). 공정가의 상대 변화 = Σ v_k · r_k 라\n"
    "   *   바스켓 명목을 v_k 로 나누면 «시총가중 포트폴리오»를 사는 것과 같다.\n"
    "   */\n"
    "  private basketWeights(index: string): Array<{ ticker: string; v: number }> {\n"
    "    const def = this.engine.indexes.get(index);\n"
    "    if (!def) return [];\n"
    "    let tot = 0;\n"
    "    const raw = def.constituents.map((c) => {\n"
    "      const x = c.weight * this.engine.priceOf(c.ticker);\n"
    "      tot += x;\n"
    "      return { ticker: c.ticker, x };\n"
    "    });\n"
    "    return tot > 0 ? raw.map((r) => ({ ticker: r.ticker, v: r.x / tot })) : [];\n"
    "  }\n\n"
    "  /** 바스켓 유효 깊이 = 1/Σ(v_k²/depth_k). 지수 다리의 liquidityDepth 와 같은 «W·N/깊이» 식으로 공정가가 움직인다 */\n"
    "  basketDepth(index: string): number {\n"
    "    let inv = 0;\n"
    "    for (const { ticker, v } of this.basketWeights(index)) inv += (v * v) / this.instrumentOf(ticker).liquidityDepth;\n"
    "    return inv > 0 ? 1 / inv : 0;\n"
    "  }\n\n"
    "  /** 바스켓 명목 상한 = min_k(maxOrderNotional_k / v_k) — 어느 구성종목도 단일주문 상한을 넘지 않는다 */\n"
    "  basketMaxNotional(index: string): number {\n"
    "    let m = Infinity;\n"
    "    for (const { ticker, v } of this.basketWeights(index)) if (v > 0) m = Math.min(m, this.maxOrderNotional(ticker) / v);\n"
    "    return Number.isFinite(m) ? m : 0;\n"
    "  }\n\n"
    "  /**\n"
    "   * ★[-24] 중앙은행 바스켓 체결 — 구성종목 «전부»에 가치가중으로 나눠 플레이어 현물과 같은 식(fillPrice + addOrderFlow).\n"
    "   *   ⇒ 지수 다리와 «반대 방향» 압력이 구성종목 가격(=공정가)에 대칭으로 간다. 돌려주는 값 = 바스켓 단위가(공정가 × 가중 체결비율).\n"
    "   *   stats.orders 는 «1 회»로 센다(벤치의 틱당 주문 수 지표를 500배 부풀리지 않기 위해).\n"
    "   */\n"
    "  centralBankBasketTrade(index: string, side: Side, notional: number): number {\n"
    "    if (!Number.isFinite(notional) || notional <= 0) return 0;\n"
    "    const ws = this.basketWeights(index);\n"
    "    if (ws.length === 0) return 0;\n"
    "    let ratio = 0;\n"
    "    for (const { ticker, v } of ws) {\n"
    "      const n = notional * v;\n"
    "      if (!(n > 0)) continue;\n"
    "      const signed = side === 'buy' ? n : -n;\n"
    "      const p0 = this.engine.priceOf(ticker);\n"
    "      const price = this.fillPrice(ticker, signed);\n"
    "      this.engine.addOrderFlow(ticker, signed);\n"
    "      ratio += v * (p0 > 0 ? price / p0 : 1);\n"
    "    }\n"
    "    this.stats.orders++;\n"
    "    const fair = this.engine.fairPriceOf(index) ?? this.engine.priceOf(index);\n"
    "    return fair * ratio;\n"
    "  }\n\n"
    "  // ── 이벤트 ────────────────────────────────────────────────────────────\n  on(fn: Listener): () => void {\n",
    'world basket trade',
)
wr(p, s)

# ── gameWorld.ts: 보기 — 바스켓 포지션은 «공정가»로 평가 ───────────────────────────
p = 'src/lib/engine/gameWorld.ts'
s = rd(p)
s = sub1(
    s,
    "    const positions = [...cb.positions.values()].map((p) => {\n"
    "      const price = w.engine.priceOf(p.ticker);\n"
    "      return { ticker: p.ticker, qty: p.qty, avgCost: p.avgCost, price, pnl: (price - p.avgCost) * p.qty };\n"
    "    });\n",
    "    const positions = [...cb.positions.values()].map((p) => {\n"
    "      /* ★[-24] `${지수}:basket` 는 구성종목 가중합 포지션 — 현재가는 그 지수의 «공정가»다 */\n"
    "      const i = p.ticker.indexOf(':basket');\n"
    "      const base = i > 0 ? p.ticker.slice(0, i) : p.ticker;\n"
    "      const price = i > 0 ? (w.engine.fairPriceOf(base) ?? w.engine.priceOf(base)) : w.engine.priceOf(p.ticker);\n"
    "      return { ticker: p.ticker, qty: p.qty, avgCost: p.avgCost, price, pnl: (price - p.avgCost) * p.qty };\n"
    "    });\n",
    'gameWorld view',
)
wr(p, s)

# ── types.ts: 체결 보기 바스켓 필드 ─────────────────────────────────────────────
p = 'src/lib/types.ts'
s = rd(p)
s = sub1(
    s,
    "  /** ★[-23] 스토어 원장이 붙이는 세션 정보(엔진 값에는 없다) — 체결 벽시계(ms) · 세션 id(부팅 시각) */\n  at?: number;\n  sid?: number;\n}\n",
    "  /** ★[-24] 반대 다리(구성종목 가중합 바스켓). 옛 저장본(-23 이전 원장)에는 없다 → optional */\n"
    "  basketSide?: Side;\n  basketNotional?: number;\n  basketPrice?: number;\n"
    "  /** ★[-23] 스토어 원장이 붙이는 세션 정보(엔진 값에는 없다) — 체결 벽시계(ms) · 세션 id(부팅 시각) */\n  at?: number;\n  sid?: number;\n}\n",
    'types fill view',
)
wr(p, s)

# ── store/history.ts: 원장 sane 에 바스켓 필드 ────────────────────────────────────
p = 'src/store/history.ts'
s = rd(p)
s = sub1(
    s,
    "    basisBefore: n('basisBefore') ?? 0,\n  };\n}\n",
    "    basisBefore: n('basisBefore') ?? 0,\n"
    "    /* ★[-24] 바스켓 다리(있을 때만) */\n"
    "    ...(n('basketNotional') !== null && n('basketPrice') !== null\n"
    "      ? { basketSide: (e.basketSide === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell', basketNotional: n('basketNotional')!, basketPrice: n('basketPrice')! }\n"
    "      : {}),\n"
    "  };\n}\n",
    'history sane basket',
)
wr(p, s)
print('cb arb patch applied')
