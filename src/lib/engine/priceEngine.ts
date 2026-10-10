/**
 * 가격 엔진 — 서버 `build/server/src/engine/priceEngine.ts` 이식본.
 * ARCHITECTURE.md 1장 공식 그대로. 상수는 lib/constants.ts.
 *
 * 구 mockWorld.ts:182-195 도 같은 공식을 쓰고 있었으나 (1) 히스토리가 배열 shift
 * 기반이라 O(n), (2) sma/returnOver/priceAgo 지표가 없어 봇 전략을 태울 수 없었다.
 * 서버 원본(링버퍼 + 지표 4종)을 그대로 가져온다.
 */
import {
  CARRY_EWMA_LAMBDA,
  DRIFT_WEIGHT,
  DT_YEARS,
  IMPACT_DECAY_LAMBDA,
  IMPACT_PERMANENT_ALPHA,
  MIN_PRICE,
  ORDER_FLOW_WEIGHT,
  PRICE_HISTORY_LEN,
  PRICING_SIGMA_FLOOR,
  PRICING_SIGMA_MAX_MULT,
  PRICING_SIGMA_MIN_MULT,
  VOL_EWMA_LAMBDA,
} from '../constants';
import { indexPriceOf, type IndexDef } from './indexBasket';
import type { Rng } from './rng';
import type { EngineTickDiag, Instrument } from './types';

const SQRT_DT = Math.sqrt(DT_YEARS);

export function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface PriceState {
  inst: Instrument;
  price: number;
  prevPrice: number;
  /** 링버퍼 */
  history: Float64Array;
  historyLen: number;
  historyHead: number;
  /** 이번 틱 동안 누적된 순주문금액(USD, 매수 +, 매도 -) */
  netOrderFlow: number;
  /**
   * 이번 틱 동안 오간 «총» 주문금액(USD, 절대값 합) = 방향과 무관한 «거래대금».
   * ★netOrderFlow 와 «다르다»: 100만 매수 + 100만 매도면 net=0 이지만 gross=200만이다.
   *   거래량 막대는 gross 로 그려야 한다 — net 으로 그리면 「가장 치열했던 틱」이 0이 된다.
   */
  grossOrderFlow: number;
  /**
   * 틱별 «거래대금» 링버퍼 (Float32).
   * ★세션 한정이다 — 저장하지 않는다(SAVE_VERSION 무변경).
   * ★메모리 실계산: 900틱 × 4B × 100종목 = 360,000B = 352KB. net 까지 두 벌이면 703KB.
   *   (가격 history 는 Float64 라 이미 703KB 를 쓰고 있다 — 같은 자릿수다.)
   * ★왜 Float32 인가: 막대 «높이»에만 쓴다. 유효숫자 7자리면 달러 단위로 충분하고,
   *   Float64 로 하면 같은 그림에 두 배(1.4MB)를 쓴다.
   * ★head/len 은 가격 history 와 «공유»한다 — 같은 자리에서 같이 쓰이기 때문이다.
   *   따로 두면 언젠가 어긋나고, 어긋나면 막대와 캔들이 다른 시각을 가리킨다.
   */
  volHistory: Float32Array;
  /** 틱별 순주문흐름(매수 + / 매도 -) 링버퍼. 막대 «색»(누가 이겼나)에 쓴다 */
  netHistory: Float32Array;
  /**
   * ★«되돌릴» 임팩트 잔량 (누적 수익률 단위).
   * 매 틱 (ORDER_FLOW_WEIGHT − ALPHA)·orderFlowRaw 만큼 쌓이고, λ 비율로 되돌려진다.
   * ★세션 한정이다 — 저장하지 않는다(SAVE_VERSION 무변경).
   */
  tempAccum: number;
  /**
   * ★지수 전용 — «시장가 / 공정가 − 1» (프리미엄·디스카운트). 종목은 항상 0 이다.
   *
   * ★★[2026-08-29 President 지시 · 중앙은행 도입] 「S&P500 은 각 기초자산의 가중합과 같이
   *   움직여야 되는데 만약 스프레드가 벌어지는 상태가 있으면 이를 막고자 중앙은행이 개입」
   * ★[실측 · 수정 전] 지수는 `s.price = 가중합` 이라 괴리가 «구조적으로 0» 이었다 —
   *   즉 중앙은행이 할 일이 «없었다». 지수에 들어온 주문흐름은 `netOrderFlow` 에 쌓였다가
   *   그냥 버려졌다(가격에 안 실림).
   * ⇒ 지수에도 종목과 «같은 임팩트 식»(같은 상수·같은 감쇠)을 적용해 «시장가»를 만든다:
   *      시장가 = 공정가 × (1 + basis)   ·   basis 는 종목의 «누적 임팩트»와 같은 식으로 움직인다
   *   공정가(가중합)는 그대로 «닻»이고, basis 가 그 위에서 벌어졌다 되돌아온다. 중앙은행은
   *   |basis| 가 임계를 넘으면 반대 매매로 basis 를 0 쪽으로 끌어당긴다(centralBank.ts).
   * ⛔되먹임 없음은 «그대로»다 — basis 는 구성종목으로 흘러가지 않는다(indexBasket.ts 머리주석).
   * ★세션 한정 — 저장하지 않는다(SAVE_VERSION 무변경). 복원은 rescaleTo() 가 «저장 시장가/공정가»로 되살린다.
   */
  basis: number;
  lastDiag: EngineTickDiag | null;
  /** 게임일 시작가 (등락률 표시용) */
  dayOpen: number;
  /**
   * ★«가격 책정용» 실현분산 EWMA — 틱당 분산. 근거·설계는 constants.VOL_EWMA_HALFLIFE_TICKS 주석.
   *
   * ★초깃값 = (DRIFT_WEIGHT·inst.sigma)² · DT_YEARS.
   *   그래야 첫 틱의 `sigmaOf()` 가 «엔진이 실제로 만드는» 변동성(= DRIFT_WEIGHT × 데이터 sigma)
   *   에서 출발한다. ⛔데이터 sigma 그대로로 초기화하면 워밍업 동안 2배 비싼 값이 그대로 노출된다.
   * ★세션 한정 — 저장하지 않는다(SAVE_VERSION 무변경). 복원 직후에는 초깃값에서 다시 데워진다.
   */
  varEwma: number;
}

export class PriceEngine {
  readonly states = new Map<string, PriceState>();
  readonly order: string[] = [];
  tickIndex = 0;
  /**
   * ★거시 이벤트가 거는 «드리프트 보정»(연율). macro.ts 가 갱신한다.
   *
   * ★왜 orderFlow 가 아니라 drift 인가: orderFlow 로 밀면 임팩트 감쇠에 걸려
   *   «되돌아온다». 거시 이벤트는 «시황이 바뀐 것»이라 되돌아오면 안 된다.
   * ★⛔r(무위험이자율)은 «여전히 0»이다. 「금리 인하」는 서사일 뿐 optionPremium 에
   *   먹이지 «않는다» — 먹이면 라이브 유저의 옵션 평가액이 전부 바뀐다.
   */
  readonly driftBonus = new Map<string, number>();
  /**
   * ★«전 종목 풀링» 실현수익률 EWMA (틱당 단순수익률).
   *
   * ⛔종목별로 두지 «않는다». 틱당 신호 0.0227bp 대 잡음 9.32bp 로 신호대잡음이 1/400 이라
   *   종목별 추정은 28,185 게임일이 필요하다 — 「틀린 상수보다 더 나쁜 값」이 나온다.
   *   100종목을 풀링하면 표준편차가 19.71 → 1.96bp 로 정확히 1/√100 줄어든다(실측 540만 표본).
   * ★단순수익률의 평균을 쓴다(로그수익률 아님). 선도는 S_T 에 «선형»으로 정산되므로
   *   필요한 값은 산술기대값이고, 그래야 옌센 보정이 필요 없다.
   */
  carryEwmaPerTick = 0;
  /** EWMA 가 아직 데워지지 않았으면 폴백을 쓴다 */
  carrySamples = 0;
  /**
   * ★지수 정의 (President 지시 ③). 비어 있으면 «아무 동작도 바뀌지 않는다» —
   *   종목 100개 데이터에는 지수가 없으므로 기존 시장이 완전히 동일하다(회귀 0).
   * ★여기 등록된 티커는 GBM 을 타지 않고 «구성종목 가중합»으로 가격이 정해진다.
   * ⛔되먹임 없음: 지수에 들어온 주문흐름은 구성종목으로 «되돌아가지 않는다».
   *   단 체결가 슬리피지는 world.fillPrice() 가 지수 자신의 liquidityDepth 로 «자동으로» 문다
   *   — 가격은 안 밀리지만 크게 사면 비싸게 산다. 두 성질이 같이 있어야 안전하다.
   */
  readonly indexes = new Map<string, IndexDef>();
  private rng: Rng;

  constructor(instruments: Instrument[], rng: Rng) {
    this.rng = rng;
    for (const inst of instruments) {
      this.states.set(inst.ticker, {
        inst,
        price: inst.initialPrice,
        prevPrice: inst.initialPrice,
        history: new Float64Array(PRICE_HISTORY_LEN),
        historyLen: 0,
        historyHead: 0,
        netOrderFlow: 0,
        grossOrderFlow: 0,
        volHistory: new Float32Array(PRICE_HISTORY_LEN),
        netHistory: new Float32Array(PRICE_HISTORY_LEN),
        tempAccum: 0,
        basis: 0,
        lastDiag: null,
        dayOpen: inst.initialPrice,
        varEwma: (DRIFT_WEIGHT * inst.sigma) ** 2 * DT_YEARS,
      });
      this.order.push(inst.ticker);
    }
  }

  get(ticker: string): PriceState | undefined {
    return this.states.get(ticker);
  }

  priceOf(ticker: string): number {
    const s = this.states.get(ticker);
    if (!s) throw new Error(`unknown ticker ${ticker}`);
    return s.price;
  }

  /**
   * ★지수의 «공정가»(구성종목 가중합). 지수가 아니면 undefined.
   * 중앙은행이 「시장가와 얼마나 벌어졌나」를 재는 «유일한» 통로다 — 화면도 이걸 쓴다(식 복제 금지).
   */
  fairPriceOf(ticker: string): number | undefined {
    const def = this.indexes.get(ticker);
    if (!def) return undefined;
    return indexPriceOf(def, (t) => this.states.get(t)?.price);
  }

  /** ★지수의 «괴리» = 시장가/공정가 − 1. 지수가 아니면 0 */
  basisOf(ticker: string): number {
    return this.states.get(ticker)?.basis ?? 0;
  }

  /**
   * ★★옵션 «가격 책정용» 변동성(연율) — 이 게임에서 sigma 를 말할 수 있는 «단 하나»의 통로.
   *
   * ⛔`Instrument.sigma`(생성 데이터 값)를 옵션 식에 직접 넣지 «마라».
   *   그건 GBM 입력이지 «엔진이 실제로 만드는» 변동성이 아니다. 실측으로 종목 약 2배,
   *   지수 약 6배 어긋난다 — 근거·수치는 constants.VOL_EWMA_HALFLIFE_TICKS 머리주석.
   *   ⇒ 소비처는 `world.optionQuote` · `world.optionMarkValue` · `bots.ts` 예산추정 셋뿐이고,
   *     ★셋이 «같은 함수»를 부른다. 두 벌이 되면 화면·엔진·봇이 조용히 갈린다(U-4).
   *
   * ★난간(clamp)은 밸런스 손잡이가 아니라 수치 안전장치다. 평상시엔 걸리지 않는다.
   * ★모르는 티커에는 throw 하지 않고 0 을 준다 — 호출부(옵션 식)는 sigma 0 이면
   *   내재가치로 떨어질 뿐 죽지 않는다. `priceOf` 가 이미 throw 로 막고 있다.
   */
  sigmaOf(ticker: string): number {
    const s = this.states.get(ticker);
    if (!s) return 0;
    const raw = Math.sqrt(Math.max(0, s.varEwma) / DT_YEARS);
    const base = s.inst.sigma;
    const lo = Math.max(PRICING_SIGMA_FLOOR, PRICING_SIGMA_MIN_MULT * base);
    const hi = Math.max(lo, PRICING_SIGMA_MAX_MULT * base);
    return clip(raw, lo, hi);
  }

  /** 주문 흐름 누적 (USD 명목금액, 매수 양수 / 매도 음수) */
  addOrderFlow(ticker: string, signedNotional: number): void {
    const s = this.states.get(ticker);
    if (!s) throw new Error(`unknown ticker ${ticker}`);
    s.netOrderFlow += signedNotional;
    /* ★거래대금은 «절대값 합»이다. 가격 계산에는 전혀 쓰이지 않는다(표시 전용). */
    s.grossOrderFlow += Math.abs(signedNotional);
  }

  /**
   * 한 틱 전진. 반환: 종목별 진단값 (분산분해 검증용).
   *
   *   driftRW      = mu*dt + sigma*sqrt(dt)*Z
   *   orderFlowRaw = clip(netOrderFlow / liquidityDepth, -1, 1)
   *   impact       = ORDER_FLOW_WEIGHT * orderFlowRaw   (감쇠항 포함 — 아래 본문 참조)
   *   drift        = DRIFT_WEIGHT * driftRW
   *   returnTick   = drift + impact
   *   price_{t+1}  = price_t * (1 + returnTick)
   *
   * ⛔★여기에 «숫자»를 적지 마라. 예전에 「impact = 0.30」·「drift70 = 0.70」으로 적혀 있었는데
   *   President 가 ORDER_FLOW_WEIGHT 를 0.30 -> 0.50 으로 올린 뒤에도 «주석만 옛날 값»으로 남았다.
   *   실제 값은 ORDER_FLOW_WEIGHT = 0.50 · DRIFT_WEIGHT = 1 - 0.50 = ★0.50 이다.
   *   [실사고 2026-08-22] 이 주석을 믿고 손계산해 티어 실효 CAGR 을 «7.78%»로 잘못 냈다.
   *   실제는 5.82% 였다 — 벤치가 상수를 «읽어» 계산해서 잡았다. ⇒ 상수에서 «유도»해라.
   * ⚠️변수명 `drift70` 은 그대로 뒀다 — EngineTickDiag 필드명이라 바꾸면 타입·소비처가 같이 움직인다.
   *   ★이름이 값을 말하지 «않는다». 이름 대신 이 주석을 믿어라.
   */
  step(): EngineTickDiag[] {
    const diags: EngineTickDiag[] = [];
    for (const ticker of this.order) {
      // ★지수는 GBM 을 «타지 않는다» — 2차 패스에서 구성종목 가중합으로 정한다.
      //   President 지시 ③ 「가중합을 추종하도록」. 난수 드리프트로 굴리면 그 지시 위반이다.
      if (this.indexes.has(ticker)) continue;
      const s = this.states.get(ticker)!;
      const { mu, sigma, liquidityDepth } = s.inst;

      const Z = this.rng.gauss();
      const muEff = mu + (this.driftBonus.get(ticker) ?? 0);
      const driftRW = muEff * DT_YEARS + sigma * SQRT_DT * Z;
      const orderFlowRaw = clip(s.netOrderFlow / liquidityDepth, -1, 1);
      /*
       * ★임팩트 = «영구분» + «일시분» − «되돌림»  (합계는 여전히 ORDER_FLOW_WEIGHT 캡 안)
       *   영구분 α·ofr        : 가격에 남는다 (정보가 있었던 주문의 몫)
       *   일시분 (W−α)·ofr    : 이번 틱엔 그대로 반영되지만 tempAccum 에 쌓인다
       *   되돌림 −λ·tempAccum : 쌓인 일시분을 반감기에 맞춰 되돌린다
       * ⇒ 정보 없는 주문은 99%가 되돌아온다(부분적 효율적 시장). 근거는 constants 주석.
       */
      const tempPart = (ORDER_FLOW_WEIGHT - IMPACT_PERMANENT_ALPHA) * orderFlowRaw;
      const reversal = -IMPACT_DECAY_LAMBDA * s.tempAccum;
      const impact = IMPACT_PERMANENT_ALPHA * orderFlowRaw + tempPart + reversal;
      s.tempAccum += tempPart + reversal;
      const drift70 = DRIFT_WEIGHT * driftRW;
      const returnTick = drift70 + impact;

      s.prevPrice = s.price;
      s.price = Math.max(MIN_PRICE, s.price * (1 + returnTick));

      const diag: EngineTickDiag = {
        ticker,
        driftRW,
        drift70,
        orderFlowRaw,
        impact,
        returnTick,
        netOrderFlow: s.netOrderFlow,
        price: s.price,
      };
      s.lastDiag = diag;
      diags.push(diag);
      /* ★가격 책정용 실현분산 EWMA. ⛔`returnTick` 이 아니라 «drift70»(임팩트 제외분)이다 —
         근거는 constants.VOL_EWMA_HALFLIFE_TICKS 머리주석(조작 경로 차단).
         비용: 종목당 곱셈 2 + 덧셈 2. 이미 도는 루프 안이라 새 순회가 없다. */
      s.varEwma += VOL_EWMA_LAMBDA * (drift70 * drift70 - s.varEwma);

      // 히스토리 기록 후 주문흐름 리셋
      // ★가격·거래대금·순흐름을 «같은 인덱스»에 쓴다. 인덱스가 갈라지면 막대가 다른 시각을 가리킨다.
      s.history[s.historyHead] = s.price;
      s.volHistory[s.historyHead] = s.grossOrderFlow;
      s.netHistory[s.historyHead] = s.netOrderFlow;
      s.historyHead = (s.historyHead + 1) % PRICE_HISTORY_LEN;
      if (s.historyLen < PRICE_HISTORY_LEN) s.historyLen++;
      s.netOrderFlow = 0;
      s.grossOrderFlow = 0;
    }
    /*
     * ★2차 패스 — 지수. 구성종목이 «모두 갱신된 뒤»에 돌아야 한다.
     *   ⛔`order` 순서에 의존하지 않는다. 별도 패스라 데이터 순서가 바뀌어도 안전하다.
     */
    for (const [ticker, def] of this.indexes) {
      const s = this.states.get(ticker);
      if (!s) continue;
      const fair = indexPriceOf(def, (t) => this.states.get(t)?.price);
      /*
       * ★[2026-08-29] 지수 «시장가» = 공정가 × (1 + basis).
       *   basis 는 종목과 «완전히 같은 임팩트 식»(영구분 α + 일시분 − 되돌림)으로 움직인다 —
       *   상수를 새로 만들지 않았다. 주문 없는 틱에는 되돌림만 남아 basis 가 0 으로 수렴한다.
       * ⛔GBM(mu·sigma)은 여전히 «타지 않는다» — 지수의 방향은 오직 구성종목이 정한다.
       * ⛔basis 는 구성종목으로 «되돌아가지 않는다»(되먹임 없음 유지).
       */
      const ofr = clip(s.netOrderFlow / s.inst.liquidityDepth, -1, 1);
      const tempPart = (ORDER_FLOW_WEIGHT - IMPACT_PERMANENT_ALPHA) * ofr;
      const reversal = -IMPACT_DECAY_LAMBDA * s.tempAccum;
      const impact = IMPACT_PERMANENT_ALPHA * ofr + tempPart + reversal;
      s.tempAccum += tempPart + reversal;
      s.basis = (1 + s.basis) * (1 + impact) - 1;
      s.prevPrice = s.price;
      s.price = Math.max(MIN_PRICE, fair * (1 + s.basis));
      const returnTick = s.prevPrice > 0 ? s.price / s.prevPrice - 1 : 0;
      /* ★지수의 «공정가 변화분» = 임팩트를 뺀 나머지 = 구성종목 가중합이 실제로 움직인 몫.
         ★지수는 GBM 을 타지 않으므로 «자기 sigma 는 아무 의미가 없다» — 가격 책정용
         변동성은 오직 이 값에서 나온다. 실측 SPX 0.169배 · NDX 0.154배(분산효과). */
      const fairRet = returnTick - impact;
      const diag: EngineTickDiag = {
        ticker,
        driftRW: fairRet,
        drift70: fairRet,
        orderFlowRaw: ofr,
        impact,
        returnTick,
        netOrderFlow: s.netOrderFlow,
        price: s.price,
      };
      s.lastDiag = diag;
      diags.push(diag);
      // ★종목과 «같은 식»으로 실현분산을 쌓는다(임팩트 제외분 기준)
      s.varEwma += VOL_EWMA_LAMBDA * (fairRet * fairRet - s.varEwma);
      // 히스토리는 «똑같이» 남긴다 — 차트·거래량 막대가 종목과 같은 규칙이어야 한다
      s.history[s.historyHead] = s.price;
      s.volHistory[s.historyHead] = s.grossOrderFlow;
      s.netHistory[s.historyHead] = s.netOrderFlow;
      s.historyHead = (s.historyHead + 1) % PRICE_HISTORY_LEN;
      if (s.historyLen < PRICE_HISTORY_LEN) s.historyLen++;
      // ★리셋을 «빠뜨리지 마라» — 안 하면 grossOrderFlow 가 무한히 누적돼 거래량 막대가 망가진다
      s.netOrderFlow = 0;
      s.grossOrderFlow = 0;
    }

    /*
     * ★풀링 캐리 추정 갱신 — 이번 틱 전 종목의 «평균 수익률»을 EWMA 에 넣는다.
     * ★비용: 종목당 덧셈 1회 + 곱셈 2회. 이미 도는 루프의 결과를 쓰므로 새 루프가 없다.
     *   프레임 영향은 측정 불가 수준이다.
     */
    if (diags.length > 0) {
      let acc = 0;
      for (const d of diags) acc += d.returnTick;
      const m = acc / diags.length;
      this.carryEwmaPerTick += CARRY_EWMA_LAMBDA * (m - this.carryEwmaPerTick);
      this.carrySamples++;
    }
    this.tickIndex++;
    return diags;
  }

  /**
   * ★계약 «기준가» — 최근 n틱 가격의 «중앙값».
   *
   * ★왜 중앙값인가 (거래대금 가중 VWAP 을 «쓰지 않는» 이유):
   *   거래대금으로 가중하면 «한 틱에 큰 금액을 밀어넣은» 주문이 그 틱의 가중치를 지배해
   *   기준가가 곧 «펌프된 가격»이 된다. 막으려던 공격이 그대로 통한다.
   *   중앙값은 21틱 중 «한 틱»이 아무리 튀어도 전혀 움직이지 않는다 — 이 공격에 구조적으로 면역이다.
   * ★체결가(world.fillPrice)와 역할이 다르다: fillPrice 는 자기 임팩트를 «체결가»에 물리고,
   *   이 함수는 «계약 조건»이 일시 변동에 흔들리지 않게 한다. 둘 다 있어야 한다.
   */
  refPrice(ticker: string, n: number): number {
    const s = this.states.get(ticker);
    if (!s) return NaN;
    if (s.historyLen === 0) return s.price;
    const len = Math.min(n, s.historyLen);
    const buf: number[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const idx = (s.historyHead - 1 - i + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
      buf[i] = s.history[idx];
    }
    buf.sort((x, y) => x - y);
    const mid = len >> 1;
    const v = len % 2 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2;
    return v > 0 && Number.isFinite(v) ? v : s.price;
  }

  /** n틱 전 가격 (없으면 가장 오래된 값) */
  priceAgo(ticker: string, n: number): number {
    const s = this.states.get(ticker);
    if (!s || s.historyLen === 0) return s ? s.price : NaN;
    const back = Math.min(n, s.historyLen - 1);
    const idx = (s.historyHead - 1 - back + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
    return s.history[idx];
  }

  /** 최근 n틱 단순이동평균 */
  sma(ticker: string, n: number): number {
    const s = this.states.get(ticker);
    if (!s || s.historyLen === 0) return s ? s.price : NaN;
    const len = Math.min(n, s.historyLen);
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const idx = (s.historyHead - 1 - i + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
      acc += s.history[idx];
    }
    return acc / len;
  }

  /**
   * 최근 n틱 «거래대금 합» (gross). 정렬·인기도용.
   *
   * ★왜 신설했나 (2026-08-23): 종목 화면에 「거래량순」 정렬을 넣는데
   *   `Quote` 에는 거래량이 «없다». 화면이 직접 세면 그건 «엔진 규칙의 복제»다
   *   (오늘 지수 깊이 16배 사고와 같은 형태). ⇒ 엔진이 «조회 함수»로 준다.
   * ⛔`flowSeries()` 를 쓰지 «마라» — 배열을 «새로 할당»한다. 1,000종목 정렬이면
   *   배열 1,000개가 생긴다. 여기는 «합»만 필요하므로 할당 없이 돈다(sma 와 같은 패턴).
   * ★`volHistory` 는 틱마다 `grossOrderFlow` 스냅샷이 들어간다(step 의 두 push 지점).
   */
  volumeOver(ticker: string, n: number): number {
    const s = this.states.get(ticker);
    if (!s || s.historyLen === 0) return 0;
    const len = Math.min(n, s.historyLen);
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const idx = (s.historyHead - 1 - i + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
      acc += s.volHistory[idx];
    }
    return acc;
  }

  /** 최근 n틱 수익률 */
  returnOver(ticker: string, n: number): number {
    const p0 = this.priceAgo(ticker, n);
    const p1 = this.priceOf(ticker);
    if (!Number.isFinite(p0) || p0 <= 0) return 0;
    return p1 / p0 - 1;
  }

  /** 차트용 최근 n틱 시계열 (오래된 -> 최신) */
  series(ticker: string, n: number): number[] {
    const s = this.states.get(ticker);
    if (!s) return [];
    const len = Math.min(n, s.historyLen);
    const out: number[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const idx = (s.historyHead - len + i + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
      out[i] = s.history[idx];
    }
    return out;
  }

  /**
   * 차트용 최근 n틱 «거래대금 / 순주문흐름» (오래된 -> 최신).
   *
   * ★가격 series() 와 «같은 창»을 돌려준다 — 같은 인덱스 규칙이라 길이도 같다.
   *   길이가 어긋나면 거래량 막대가 캔들과 한 칸씩 밀려 그려진다.
   * ★gross = 막대 높이(얼마나 많이 오갔나) · net = 막대 색(매수가 이겼나 매도가 이겼나).
   */
  flowSeries(ticker: string, n: number): { gross: number[]; net: number[] } {
    const s = this.states.get(ticker);
    if (!s) return { gross: [], net: [] };
    const len = Math.min(n, s.historyLen);
    const gross: number[] = new Array(len);
    const net: number[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const idx = (s.historyHead - len + i + PRICE_HISTORY_LEN * 2) % PRICE_HISTORY_LEN;
      gross[i] = s.volHistory[idx];
      net[i] = s.netHistory[idx];
    }
    return { gross, net };
  }

  /**
   * [정적 빌드 추가] 종목 가격 곡선을 통째로 배율 조정하고 배율을 돌려준다.
   *
   * 서버에는 없던 기능이다. 새로고침 복귀 시 "워밍업으로 만든 시장"의 마지막
   * 가격을 "유저가 떠날 때의 가격"에 정확히 맞추기 위해서만 쓴다.
   * (가격만 갈아끼우면 히스토리·이평선이 어긋나므로 곡선 전체를 같은 비율로 옮긴다.)
   */
  rescaleTo(ticker: string, targetPrice: number): number {
    const s = this.states.get(ticker);
    if (!s || !(targetPrice > 0) || !(s.price > 0)) return 1;
    const f = targetPrice / s.price;
    if (!Number.isFinite(f) || f <= 0) return 1;
    /*
     * ★지수는 다음 틱에 «공정가 × (1 + basis)» 로 다시 계산된다. 저장된 시장가를 그냥 꽂으면
     *   다음 틱에 공정가로 «튀어» 되돌아간다(저장 시점의 프리미엄이 증발). ⇒ 저장 시장가와
     *   «복원된 구성종목으로 만든 공정가»의 비에서 basis 를 되살린다. 구성종목은 order 상
     *   지수보다 «먼저» 복원된다(지수 rank 999·1000 = 맨 뒤) — 그래서 여기서 공정가를 읽을 수 있다.
     * ★basis 가 «저장본에 없어도» 되살아나는 이유: prices 에는 지수의 «시장가»가 저장되기 때문이다.
     */
    const def = this.indexes.get(ticker);
    if (def) {
      const fair = indexPriceOf(def, (t) => this.states.get(t)?.price);
      const b = fair > 0 ? targetPrice / fair - 1 : 0;
      s.basis = Number.isFinite(b) ? b : 0;
      s.tempAccum = 0;
    }
    s.price = targetPrice;
    s.prevPrice *= f;
    s.dayOpen *= f;
    for (let i = 0; i < s.history.length; i++) {
      s.history[i] *= f;
      /* 거래«대금»은 금액 단위라 가격 곡선을 옮기면 같이 옮겨야 축척이 맞는다.
         (막대는 상대 높이만 쓰므로 사실상 무해하지만, 두 곡선이 다른 축척을 갖는 상태를 남기지 않는다) */
      s.volHistory[i] *= f;
      s.netHistory[i] *= f;
    }
    return f;
  }
}
