/**
 * 중앙은행(LP) — 지수 «시장가»가 «공정가(구성종목 가중합)»에서 벗어나면 되돌린다.
 *
 * ★★[2026-08-29 President 지시 원문]
 *   「중앙은행을 도입해서, LP 역할을 수행하고 과도한 스프레드가 벌어지는 걸 막도록 해. 예컨대
 *    S&P500은 각 기초자산의 가중합과 같이 움직여야 되는데 만약 스프레드가 벌어지는 상태가 있으면
 *    이를 막고자 중앙은행이 개입하도록 해. 더불어, 순위표에서 중앙은행의 포지션 및 거래 기록을
 *    확인할 수 있게 해.(전체 자산은 무제한이니까 자산은 명시하지 말고)」
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────
 *   괴리 basis = 시장가 / 공정가 − 1  (priceEngine.basisOf — 지수에만 있다)
 *   |basis| > CB_SPREAD_THRESHOLD 이면 «반대 방향»으로 지수를 사고판다.
 *     basis > 0 (비싸다) → 판다   ·   basis < 0 (싸다) → 산다
 *   개입량 = 괴리를 «그대로» 닫는 데 필요한 명목 (= |basis| / ORDER_FLOW_WEIGHT × 깊이) × 무작위 계수
 *   ★프레임(틱)당 상한 = world.maxOrderNotional(지수) × CB_MAX_ORDER_FRAC — 플레이어와 «같은 상한».
 *
 * ── ⛔규칙을 우회하지 않는다 ────────────────────────────────────────────────
 *   체결은 `World.centralBankTrade` 하나를 지나고, 그 안은 «플레이어와 같은» fillPrice(자기 임팩트)
 *   + addOrderFlow(다음 틱 가격 반영) 다. 깊이 상수·임팩트 상수를 «하나도» 새로 만들지 않았다.
 *   중앙은행이 다른 것은 «현금 검사가 없다»는 것뿐이다(자산 무제한 = 잔고 개념 없음).
 *
 * ── 악용 방지 (선행매매) ──────────────────────────────────────────────────
 *   임계를 넘은 «그 틱»에 개입하지 않는다. CB_DELAY_TICKS 범위에서 «무작위» 지연 뒤, 그때도
 *   여전히 |basis| 가 임계의 절반을 넘으면 개입한다(히스테리시스). 개입량에도 ±CB_SIZE_JITTER
 *   무작위를 준다 ⇒ 「언제·얼마나」를 정확히 예측해 앞서 사는 것이 어렵다.
 *   ★근거 수치는 scripts/bench/cbank.ts 가 «실측»한다(개입 전후 괴리·개입 횟수·봇/플레이어 수익 분포).
 *
 * ── 저장 ─────────────────────────────────────────────────────────────────
 *   세션 스코프. ⛔저장하지 않는다(SAVE_VERSION·저장키 무변경). 봇과 같은 지위다.
 */
import { ORDER_FLOW_WEIGHT } from '../constants';
import { Rng } from './rng';
import type { Side } from './types';

/** 표시 이름 조회용 식별자. ⛔World 계정이 «아니다» — 랭킹·명부·스냅샷 어디에도 들어가지 않는다 */
export const CB_ACCOUNT_ID = 'centralbank';

/**
 * 개입 임계 — 시장가가 공정가에서 이만큼(비율) 벗어나면 «과도한 스프레드»로 본다.
 *
 * ★★[2026-08-29 실측으로 정했다 · scripts/bench/run.mjs cbank · 봇 10,000 · 24시드 × 1,500틱]
 *   자연 상태(플레이어 없음)의 |괴리| : 평균 0.0015% · p99 0.005% · 24시드 최대 0.254%
 *   ⇒ ★0.5% 로 두면 24시드 × 10게임일 동안 개입이 «0회»다 — 순위표의 중앙은행 시트가 항상 비어 있다.
 *   ⇒ 0.1% 는 자연 p99 의 «20배»라 잡음이 아니고, 12시드 평균 2.3회/10게임일 개입한다.
 *     그때 |괴리| 평균 0.0017% → 0.0008%(−53%) · 임계 초과 틱 0.21% → 0.11%.
 *     봇 수익률 분포 p10/p50/p90 «동일»(−1.34/0.45/2.34%) · 틱 비용 p99 2.91 → 2.96ms(잡음).
 *   ★플레이어 «펌프 앤 덤프»(SPX 상한 명목 매수 → k틱 뒤 매도) 왕복 손익, CB 전 → 후:
 *     k=3  −292 → −387bp   ·   k=7  −355 → −478bp   ·   k=15  −424 → −478bp
 *     ⇒ 중앙은행이 펌프를 «더 비싸게» 만든다(되돌림을 앞당겨 덤프 가격을 낮춘다).
 *   ★«선행매매»(괴리 < −임계일 때 $200k 매수 → 6틱 뒤 매도) 기대손익 −26.2bp(n=206), CB 전후 «같다»
 *     ⇒ 중앙은행 개입을 예측해 앞서 사도 수수료·자기 임팩트를 못 넘는다. 착취 경로 없음.
 * ⛔이 값을 올리면(예: 0.5%) 중앙은행은 사실상 «플레이어 대형 주문에만» 반응한다. 내리면 잡음에 반응한다.
 */
export const CB_SPREAD_THRESHOLD = 0.001;
/** 지연 뒤 재판정 문턱 = 임계 × 이 비율 (히스테리시스). 그 사이 스스로 돌아왔으면 개입하지 않는다 */
export const CB_REARM_FRAC = 0.5;
/** 임계 초과 후 개입까지 지연(틱) — [min, max] 사이 무작위 */
export const CB_DELAY_TICKS: readonly [number, number] = [1, 3];
/** 개입량 무작위 폭 (±). 0.25 = 계산량의 75%~125% */
export const CB_SIZE_JITTER = 0.25;
/** 틱당 개입 상한 = maxOrderNotional(지수) × 이 값. 1 = 플레이어 단일주문 상한과 같다 */
export const CB_MAX_ORDER_FRAC = 1;
/** 체결 기록 보관 수(세션) */
export const CB_FILLS_MAX = 60;

export interface CbFill {
  id: number;
  tick: number;
  gameDay: number;
  ticker: string;
  side: Side;
  notional: number;
  price: number;
  /** 개입 «직전» 괴리(비율) */
  basisBefore: number;
  /**
   * ★[-24] 바스켓 다리 — 지수 다리와 «반대 방향»으로 같은 틱에 체결한 구성종목 가중합. 한 쌍이 한 체결 기록이다.
   *   basketSide 는 side 의 반대 · basketPrice 는 바스켓 «단위가»(체결 직전 공정가 × 체결 비율)
   */
  basketSide: Side;
  basketNotional: number;
  basketPrice: number;
}

export interface CbPosition {
  ticker: string;
  /** 부호 있는 수량(+ 롱 / − 숏). 무제한 자산이라 숏도 «그냥» 가능하다 */
  qty: number;
  avgCost: number;
}

/** 중앙은행이 체결을 «요청»하는 통로. World 가 구현한다(fillPrice + addOrderFlow) */
export interface CbMarket {
  tick: number;
  gameDay: number;
  indexTickers(): Iterable<string>;
  basisOf(ticker: string): number;
  maxOrderNotional(ticker: string): number;
  liquidityDepth(ticker: string): number;
  /** 체결. 돌려주는 값은 «실제 체결가» */
  fill(ticker: string, side: Side, notional: number): number;
  /** ★[-24] 지수의 «공정가»(구성종목 가중합/divisor) */
  fairOf(ticker: string): number;
  /** ★[-24] 바스켓 «유효 깊이»: 바스켓 명목 N 이 공정가를 W·N/깊이 만큼 움직이게 하는 깊이 = 1/Σ(v_k²/depth_k), v_k = 가치가중 */
  basketDepth(ticker: string): number;
  /** ★[-24] 바스켓 명목 상한 = min_k(구성종목 k 단일주문 상한 / v_k) — 어느 종목도 자기 상한을 넘지 않게 */
  basketMaxNotional(ticker: string): number;
  /** ★[-24] 바스켓 체결: 구성종목 전부에 가치가중으로 나눠 fillPrice+addOrderFlow. 돌려주는 값은 바스켓 «단위 체결가»(공정가 × 가중 체결비율) */
  fillBasket(ticker: string, side: Side, notional: number): number;
}

export class CentralBank {
  readonly positions = new Map<string, CbPosition>();
  readonly fills: CbFill[] = [];
  /** 누적 개입 횟수(세션) */
  interventions = 0;
  /** 누적 개입 명목(세션, USD) */
  notionalTotal = 0;
  /** ★false 면 감시만 하고 개입하지 않는다(벤치 대조군 · 비상 차단) */
  enabled = true;
  /** intervention threshold (fraction). Default = CB_SPREAD_THRESHOLD; the bench sweeps it, the app never changes it */
  threshold = CB_SPREAD_THRESHOLD;
  private readonly rng: Rng;
  /** 임계를 넘은 지수의 «개입 예정 틱» */
  private readonly armed = new Map<string, number>();
  private fillId = 0;

  constructor(seed: number) {
    this.rng = new Rng((seed ^ 0xc3b1e0ba) >>> 0);
  }

  /** 한 틱 — 가격 엔진이 «갱신된 뒤» 부른다 */
  step(m: CbMarket): void {
    for (const tk of m.indexTickers()) {
      const b = m.basisOf(tk);
      const ab = Math.abs(b);
      const at = this.armed.get(tk);
      if (at === undefined) {
        if (ab > this.threshold) {
          const [lo, hi] = CB_DELAY_TICKS;
          this.armed.set(tk, m.tick + lo + this.rng.int(hi - lo + 1));
        }
        continue;
      }
      if (m.tick < at) continue;
      this.armed.delete(tk);
      if (!this.enabled) continue;
      /* 히스테리시스 — 지연 사이에 스스로 돌아왔으면 «개입하지 않는다» */
      if (ab <= this.threshold * CB_REARM_FRAC) continue;
      /*
       * 개입량: 괴리 Δ 를 닫는 임팩트는 W·(N/깊이) 이므로 N = Δ/W × 깊이.
       * ★상수는 constants.ORDER_FLOW_WEIGHT 그대로(가격 엔진과 같은 식). 무작위 ±jitter.
       */
      /*
       * ★[-24] 차익거래 — 괴리 Δ 를 «양쪽에서 절반씩» 닫는다: 지수 다리는 지수 가격을 Δ/2, 바스켓 다리는 공정가를 Δ/2(반대 방향).
       *   지수 명목 N_i = (Δ/2)/W × depth_idx · 바스켓 명목 N_b = (Δ/2)/W × basketDepth. 상한은 «공통 배율» f 로 같이 줄인다 —
       *   한쪽만 줄면 짝이 깨져 지수 단독 매매(옛 구조)로 되돌아간다. 무작위 ±jitter 도 두 다리에 같이.
       */
      const jitter = 1 + this.rng.range(-1, 1) * CB_SIZE_JITTER;
      const half = (ab / 2) / ORDER_FLOW_WEIGHT;
      const wantIdx = half * m.liquidityDepth(tk) * jitter;
      const wantBk = half * m.basketDepth(tk) * jitter;
      const capIdx = m.maxOrderNotional(tk) * CB_MAX_ORDER_FRAC;
      const capBk = m.basketMaxNotional(tk);
      const f = Math.min(1, capIdx / wantIdx, capBk / wantBk);
      const notional = wantIdx * f;
      const basketNotional = wantBk * f;
      if (!(notional > 1) || !(basketNotional > 1)) continue;
      const side: Side = b > 0 ? 'sell' : 'buy';
      this.execute(m, tk, side, notional, basketNotional, b);
    }
  }

  private execute(m: CbMarket, ticker: string, side: Side, notional: number, basketNotional: number, basisBefore: number): void {
    const price = m.fill(ticker, side, notional);
    if (!(price > 0)) return;
    /* ★[-24] 반대 다리 — 같은 틱, 반대 방향, 구성종목 가중합. 포지션 키는 `${지수}:basket`(단위 = 바스켓 1단위 = 공정가 1) */
    const basketSide: Side = side === 'buy' ? 'sell' : 'buy';
    const basketPrice = m.fillBasket(ticker, basketSide, basketNotional);
    if (basketPrice > 0) this.book(`${ticker}:basket`, basketSide, basketNotional, basketPrice);
    this.book(ticker, side, notional, price);
    this.interventions++;
    this.notionalTotal += notional + basketNotional;
    this.fills.unshift({ id: ++this.fillId, tick: m.tick, gameDay: m.gameDay, ticker, side, notional, price, basisBefore, basketSide, basketNotional, basketPrice });
    if (this.fills.length > CB_FILLS_MAX) this.fills.pop();
  }

  /** 포지션 장부 — 지수 다리·바스켓 다리가 «같은 규칙»(평균단가 가중 · 반대면 줄이거나 뒤집음)으로 기록된다 */
  private book(ticker: string, side: Side, notional: number, price: number): void {
    const qty = (notional / price) * (side === 'buy' ? 1 : -1);
    const pos = this.positions.get(ticker) ?? { ticker, qty: 0, avgCost: 0 };
    const same = pos.qty === 0 || Math.sign(pos.qty) === Math.sign(qty);
    if (same) {
      /* 같은 방향으로 늘린다 — 평균단가 가중 */
      const tot = Math.abs(pos.qty) + Math.abs(qty);
      pos.avgCost = tot > 0 ? (pos.avgCost * Math.abs(pos.qty) + price * Math.abs(qty)) / tot : price;
      pos.qty += qty;
    } else {
      /* 반대 방향 — 줄이거나 뒤집는다. 뒤집히면 새 평균단가는 체결가 */
      const next = pos.qty + qty;
      if (Math.sign(next) !== Math.sign(pos.qty) && next !== 0) pos.avgCost = price;
      pos.qty = next;
    }
    if (Math.abs(pos.qty) < 1e-9) this.positions.delete(ticker);
    else this.positions.set(ticker, pos);
  }
}
