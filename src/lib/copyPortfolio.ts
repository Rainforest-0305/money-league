/**
 * 포트폴리오 «복사» 계획 — ★순수 모듈. React·엔진·저장소 무의존.
 *
 * ── 왜 하는가 (President 지시 2026-08-30) ───────────────────────────────
 *   「포트폴리오 조회에서 포트폴리오 복사하기 버튼이 있으면 좋겠어. 현재 보유 현금 규모에 맞게
 *    포트폴리오 비중을 조정해서 복사 구매하는 거야. 기존에 보유하던 종목들이 있으면 청산하고
 *    전체 현금으로 살지, 아니면 현재 보유 현금으로만 살지 선택하게 해.」 + 「파생도 복사하라고.」
 *
 * ── 여기 있는 것은 «계산»뿐이다 ──────────────────────────────────────────
 *   주문은 ★`store.copyPortfolio()` 가 «기존 주문 경로»(orderSpot·openLeverage·close*)로 낸다.
 *   ⛔이 파일이 잔고를 만지거나 엔진을 부르면 안 된다 — 같은 입력이면 같은 출력이라야
 *     `scripts/check_copy_plan.mjs` 가 화면 없이 숫자로 검증할 수 있다.
 *
 * ── 비중 규칙 ────────────────────────────────────────────────────────────
 *   대상의 «주식 평가액 + 레버리지 증거금 합»을 분모로 각 줄의 비중을 낸다.
 *   내 가용 현금 × 비중 = 줄별 배정액. 주식은 현재가(임팩트·수수료 반영)로 수량 floor,
 *   레버리지는 배정액을 증거금으로(수수료 선반영) 배율·방향은 대상 그대로.
 *   ★1주도 못 사는 줄 · 증거금이 최소치(LEV_MIN_MARGIN) 미만인 줄은 «건너뛴다»(사유와 함께).
 *   ⛔[2026-09-05 President 결정] 단일 주문 상한 클립을 «제거»했다 — 카피는 대상 비중을 그대로 따른다.
 *     대신 큰 줄일수록 체결 임팩트를 그대로 문다(q.priceImpactFrac). 그것이 유일한 제동이다.
 *   ⇒ 줄마다 실투입 ≤ 배정액이고 Σ배정액 = 현금이라 ★Σ실투입 ≤ 현금이 구조적으로 보장된다.
 *
 * ── 대상 스냅샷은 «10분 전 기준»이다 ───────────────────────────────────
 *   `PublicPortfolio` 는 지연 스냅샷이다(gameWorld.publicPortfolio). 비중도 그 시점 수량 × «지금» 가격이다.
 *   같은 가격에 살 수 없다는 사실은 화면 문구(delayNote)가 이미 말한다.
 *
 * ── 파생 범위 ────────────────────────────────────────────────────────────
 *   공개 스냅샷이 싣는 파생은 ★레버리지 포지션뿐이다(옵션은 «개수»만, 선도·스왑은 없음).
 *   ⇒ 복사 대상 파생 = 레버리지. 옵션·선도·스왑은 스냅샷에 «없어서» 복사할 수 없다(엔진 규칙 무변경).
 */
import { ALLOWED_LEVERAGE, BP, FEE_LEVERAGE_BP, FEE_SPOT_BP } from './constants';
import type { PublicPortfolio } from './types';

/** 레버리지 최소 증거금(USD) — ★기존 레버리지 주문 화면(LeverageOrder)의 하한 100 과 같은 값 */
export const LEV_MIN_MARGIN = 100;

export type CopyMode = 'all' | 'cash';

export type SkipReason = 'tooSmall' | 'noPrice' | 'badLeverage';

export interface CopySpotLine {
  kind: 'spot';
  ticker: string;
  /** 대상 안 비중(0..1) */
  weight: number;
  /** 배정액(USD) = 내 현금 × 비중 */
  alloc: number;
  /** 지금 가격 */
  price: number;
  /** 살 수량(정수). 0 이면 건너뜀 */
  qty: number;
  /** 예상 투입(임팩트·수수료 포함) */
  cost: number;
  skip?: SkipReason;
}

export interface CopyLevLine {
  kind: 'lev';
  ticker: string;
  side: 'long' | 'short';
  leverage: number;
  weight: number;
  alloc: number;
  /** 넣을 증거금(정수 USD). 0 이면 건너뜀 */
  margin: number;
  /** 예상 투입(증거금 + 수수료) */
  cost: number;
  price: number;
  skip?: SkipReason;
}

export type CopyLine = CopySpotLine | CopyLevLine;

export interface CopyPlan {
  /** 계획의 분모가 된 가용 현금 */
  cash: number;
  spot: CopySpotLine[];
  lev: CopyLevLine[];
  /** Σ예상 투입 */
  spend: number;
  /** 남는 현금(예상) */
  leftover: number;
  /** 대상에 복사할 줄이 하나도 없다(빈 포트폴리오) */
  empty: boolean;
}

/** 계획이 엔진에게 묻는 것 — 전부 store 가 이미 열어 둔 통로다(깊이 공식을 «복제하지 않는다») */
export interface CopyQuoteSource {
  priceOf(ticker: string): number;
  /**
   * 매수 + · 매도 − 명목에 대한 체결가 임팩트 비율.
   * ★[2026-09-05] `maxOrderNotional` 을 이 인터페이스에서 «뺐다» — 상한이 사라졌으므로
   *   계획이 그 값을 알 이유가 없다. ⛔다시 넣지 마라. 알면 언젠가 다시 클립한다.
   */
  priceImpactFrac(ticker: string, signedNotional: number): number;
}

const SPOT_FEE = FEE_SPOT_BP * BP;
const LEV_FEE = FEE_LEVERAGE_BP * BP;

function finitePos(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

/**
 * ★계획 — 대상 스냅샷 + 내 가용 현금 → 줄별 배정.
 * @param cash 이 계획이 쓸 수 있는 현금(USD). (A)면 청산 «뒤» 실제 현금으로 «다시» 부른다.
 */
export function planCopy(pub: Pick<PublicPortfolio, 'holdings' | 'leverage'>, cash: number, q: CopyQuoteSource): CopyPlan {
  const budget = Number.isFinite(cash) && cash > 0 ? cash : 0;

  /* ── 분모: 주식 평가액 + 레버리지 증거금 ───────────────────────────── */
  const spotVals = pub.holdings.map((h) => {
    const price = q.priceOf(h.ticker);
    const value = finitePos(price) && finitePos(h.qty) ? h.qty * price : 0;
    return { ticker: h.ticker, price, value };
  });
  const levVals = pub.leverage.map((p) => ({ ...p, value: finitePos(p.margin) ? p.margin : 0 }));
  const total = spotVals.reduce((a, x) => a + x.value, 0) + levVals.reduce((a, x) => a + x.value, 0);

  const spot: CopySpotLine[] = spotVals.map((x) => {
    const weight = total > 0 ? x.value / total : 0;
    const alloc = budget * weight;
    const line: CopySpotLine = { kind: 'spot', ticker: x.ticker, weight, alloc, price: x.price, qty: 0, cost: 0 };
    if (!finitePos(x.price)) return { ...line, skip: 'noPrice' };
    /*
     * ⛔[2026-09-05 President 결정] 「괜찮아. 캡 풀어.」
     *   여기 있던 `alloc = min(alloc, q.maxOrderNotional(ticker))` 클립을 «제거»했다.
     *   ⇒ 카피는 이제 대상의 «비중을 그대로» 따라간다. 상한에 눌려 비중이 틀어지는 일이 없다.
     * ★대신 비용은 그대로 는다 — 아래 `impact` 가 엔진의 체결 임팩트를 그대로 물린다.
     *   상한이 사라졌으므로 이 항이 «유일한» 제동이다. ⛔지우지 마라.
     */
    const impact = Math.max(0, q.priceImpactFrac(x.ticker, alloc));
    const unit = x.price * (1 + impact) * (1 + SPOT_FEE);
    const qty = Math.floor(alloc / unit);
    if (qty < 1) return { ...line, alloc, skip: 'tooSmall' };
    return { ...line, alloc, qty, cost: qty * unit };
  });

  const lev: CopyLevLine[] = levVals.map((p) => {
    const weight = total > 0 ? p.value / total : 0;
    const alloc = budget * weight;
    const price = q.priceOf(p.ticker);
    const base: CopyLevLine = {
      kind: 'lev', ticker: p.ticker, side: p.side, leverage: p.leverage, weight, alloc, margin: 0, cost: 0, price,
    };
    if (!finitePos(price)) return { ...base, skip: 'noPrice' };
    if (!(ALLOWED_LEVERAGE as readonly number[]).includes(p.leverage)) return { ...base, skip: 'badLeverage' };
    /* 증거금 + 수수료(명목 × 5bp) ≤ 배정액.
       ⛔[2026-09-05 President 결정] 여기 있던 `margin = min(margin, cap / leverage)` 클립도 제거했다.
         현물 쪽과 «같은 이유»다 — 상한이 엔진에 없으므로 화면에도 없어야 한다. */
    const margin = Math.floor(alloc / (1 + LEV_FEE * p.leverage));
    if (margin < LEV_MIN_MARGIN) return { ...base, skip: 'tooSmall' };
    return { ...base, margin, cost: margin * (1 + LEV_FEE * p.leverage) };
  });

  const spend = spot.reduce((a, l) => a + l.cost, 0) + lev.reduce((a, l) => a + l.cost, 0);
  return {
    cash: budget,
    spot,
    lev,
    spend,
    leftover: Math.max(0, budget - spend),
    empty: spot.length + lev.length === 0,
  };
}

/** 내 보유를 «전량 청산»했을 때 손에 남을 현금의 «예상» — 화면 미리보기 전용. 실행은 실제 청산 뒤 실잔고로 다시 계획한다 */
export interface LiquidationEstimate {
  /** 주식 청산 예상액(임팩트·수수료 차감) */
  spot: number;
  /** 파생(레버리지·옵션·선도·스왑) 정리 예상 회수액 */
  deriv: number;
  /** 청산할 항목 수 */
  count: number;
}

export function estimateLiquidation(
  mine: {
    holdings: { ticker: string; qty: number }[];
    leverage: { notional: number; equity: number }[];
    options: { side?: 'buy' | 'sell'; value: number; margin?: number; premiumPaid: number }[];
    forwards: { equity: number }[];
    swaps: { equity: number }[];
  },
  q: CopyQuoteSource
): LiquidationEstimate {
  let spot = 0;
  for (const h of mine.holdings) {
    const price = q.priceOf(h.ticker);
    if (!finitePos(price) || !finitePos(h.qty)) continue;
    const gross0 = h.qty * price;
    const impact = Math.min(0, q.priceImpactFrac(h.ticker, -gross0));
    const gross = gross0 * (1 + impact);
    spot += gross * (1 - SPOT_FEE);
  }
  let deriv = 0;
  for (const p of mine.leverage) deriv += Math.max(0, p.equity - p.notional * LEV_FEE);
  for (const o of mine.options) deriv += o.side === 'sell' ? Math.max(0, (o.margin ?? 0) - o.value) : Math.max(0, o.value);
  for (const f of mine.forwards) deriv += Math.max(0, f.equity);
  for (const s of mine.swaps) deriv += Math.max(0, s.equity);
  const count =
    mine.holdings.length + mine.leverage.length + mine.options.length + mine.forwards.length + mine.swaps.length;
  return { spot, deriv, count };
}
