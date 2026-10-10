/**
 * 배당 이벤트 (President 지시 ⑨, 2026-08-22).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★설계 결정 5건 — 왜 이렇게 됐는지 여기 남긴다
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① 주기 = 5 게임일 (실제 25분). 현실 분기(63거래일)를 그대로 쓰면 «평생 못 본다».
 *    게임 1일 = 150틱 = 실제 5분이고 가격 이력은 900틱(6게임일)뿐이다.
 *    ★종목마다 «시차»를 준다(티커 해시). 배당락일이 현실에서도 한 날에 안 몰린다[실측].
 *
 * ② 금액 = «연 배당수익률»에서 유도한다.  1회 = q × 가격 × (5 / 252)
 *    ⛔「현실의 분기배당액을 5게임일마다」로 하지 마라 — 실효 연수익률이 12.6배가 되어
 *      존버·우량주 콘셉트가 무조건 이긴다.
 *
 * ③ ★배당락을 «반드시» 반영한다. 지급 틱에 price × (1 − d).
 *    안 하면 「배당 직전 매수 → 직후 매도」가 «공짜 돈»이다. 이 앱이 이미 겪은
 *    「급락 직후 현물 매수 +68.44%」와 «같은 유형»의 구멍이다.
 *    ⛔`rescaleTo` 를 쓰지 «마라» — 그건 곡선 «전체»를 옮긴다. 배당락은 «현재가만» 내린다
 *      (캔들에 갭이 남는 게 현실이고 정확하다).
 *
 * ④ ★μ 보정 — `DIVIDEND_DRIFT_OFFSET` = 0 «이어야 한다» (2026-08-22 런타임 실측으로 정정)
 *    [실측] `mu` 는 총수익도 가격수익도 «아니다». 티어별 밴드에서 난수 생성한 «합성값»이다
 *    (원문: research/sp100_source.md:22-25 「전부 게임용 합성값 … 난수 생성(seed=42)」
 *     + 구조 증거: 티어 밴드 완전 분리, sigma 에 0.250→0.351 공백 폭 0.101 관측 0개).
 *    ⇒ «이중계상»은 원리상 없다. 그러나 배당을 그냥 얹으면 «총수익이 올라간다».
 *    ⇒ 그리고 그 상승은 고배당 티어에만 간다 ⇒ ★티어 역전.
 *      [실측] 배당 전 실효 CAGR: 빅테크 7.78% > 우량배당 5.52% > 성장주 4.52% > 중소형 1.26%
 *      우량배당에 2.5%p 를 얹으면 8.02% 로 «빅테크를 추월»한다.
 *    ⛔★내가 처음에 여기서 «틀렸다». 기록을 남긴다 — 같은 실수를 반복하지 마라.
 *
 *    처음 추론: 「배당을 얹으면 총수익이 q 만큼 올라간다 ⇒ mu 에서 q/DRIFT_WEIGHT 를 빼야
 *               총수익이 보존된다」 ⇒ OFFSET = 1 을 기본값으로 뒀다.
 *    ★그건 «배당락을 잊은» 추론이다. 배당락(③)이 지급 시점에 가격에서 이미 q 를 «빼간다».
 *      배당 현금이 그 q 를 «돌려준다». ⇒ 총수익은 **원래부터 보존된다**.
 *      여기에 mu 를 또 깎으면 q 를 «두 번» 빼앗는 것이다.
 *
 *    [실측 · scripts/bench/run.mjs divruntime · sigma=0 · 봇 off · 1년]
 *      배당 없음   가격 −1.6424% · 현금 0        · 총수익 −1.6424%
 *      OFFSET=0   가격 −3.1303% · 현금 +1.5560% · 총수익 −1.5743%   <- 기준과 «같다»
 *      OFFSET=1   가격 −4.5874% · 현금 +1.5401% · 총수익 −3.0473%   <- 기준보다 ★1.40%p 낮다
 *      (−3.1303 − (−1.6424) = −1.4879%p 가 배당락. 배당현금 +1.5560%p 이 그걸 상쇄한다)
 *
 *    ⇒ ★**0 이 «올바른» 값이다.** 밸런스 무변경도 0 이다.
 *      ⛔0 이 아닌 값은 「배당을 넣으면서 총수익을 «의도적으로» 깎겠다」는 뜻이다 —
 *        그건 밸런스 변경이라 President 게이트다.
 *    ★잔여 편차 +0.068%p 는 «오차가 아니다»: 배당은 현금으로 나가 재투자되지 않으므로
 *      복리 경로가 미세하게 다르다. 드리프트가 음수인 구간에서는 일찍 빼내는 쪽이 약간 유리하다.
 *
 *    ★교훈: **산술만으로 판단하지 마라.** `divcheck` 의 해석적 계산은
 *      「배당 = 순수 추가분」이라는 «틀린 모델»을 그대로 반영해 OFFSET=1 을 정답이라 말했다.
 *      엔진을 실제로 돌린 `divruntime` 이 잡았다.
 *
 * ⑤ ★참가자도 받는다. 안 받으면 플레이어만 유리해져 랭킹이 왜곡된다.
 *    비용은 750틱에 «한 번» 전 계정 1회 순회다 — 매 틱 스캔(구조 수정 A 가 없애는 그것)과
 *    성격이 완전히 다르다. 무시 가능하다.
 *
 * ⛔저장하지 «않는다». 현금은 이미 저장되므로 배당 «내역»만 세션 한정이다
 *   (SAVE_VERSION 무변경 — President 하드게이트).
 */
import { TICKS_PER_GAME_DAY, TRADING_DAYS_PER_YEAR } from '../constants';

/** 배당 지급 간격(게임일). 실제 25분 */
export const DIVIDEND_INTERVAL_GAME_DAYS = 5;
export const DIVIDEND_INTERVAL_TICKS = DIVIDEND_INTERVAL_GAME_DAYS * TICKS_PER_GAME_DAY;

/**
 * ★μ 보정 계수. **0 = 올바른 값이자 밸런스 무변경**(배당락이 이미 상쇄하므로).
 * ⛔0 이 «아닌» 값으로 바꾸면 총수익을 그만큼 «깎는» 것이다 — 밸런스 변경이라 President 게이트.
 * ★근거는 위 ④ 의 런타임 실측. 산술로 다시 추론하지 마라 — 그렇게 해서 한 번 틀렸다.
 */
export const DIVIDEND_DRIFT_OFFSET = 0;

/**
 * 섹터별 «연» 배당수익률.
 *
 * ★출처: 섹터 ETF 공식 자료 + 교차검증(편차 <= 0.05%p) [실측].
 *   부동산 3.2 · 유틸리티 2.9 · 필수소비재 2.6 · 에너지 2.5 · 소재 1.8 · 헬스케어 1.6
 *   금융 1.5 · 커뮤니케이션 1.3 · 산업재 1.1 · 임의소비재 0.9 · 정보기술 0.6
 * ★통신(VZ·T)은 광역 커뮤니케이션 1.31% 를 쓰면 «통신주를 살 이유가 사라진다»
 *   (VZ 실측 5.74%). 그래서 별도로 4.5% 를 준다.
 * ★여기 없는 섹터는 DEFAULT_YIELD.
 */
export const SECTOR_YIELD: Record<string, number> = {
  리츠: 0.032,
  유틸리티: 0.029,
  통신: 0.045,          // ★광역 평균이 아니라 통신주 실측 기준
  생활용품: 0.026, 식품: 0.026, 음료: 0.026,
  에너지: 0.025, 에너지설비: 0.025,
  소재: 0.018, 화학소재: 0.018,
  헬스케어: 0.016, 제약: 0.016, 헬스보험: 0.016, 헬스케어유통: 0.016, 의료기기: 0.012,
  은행: 0.015, 보험: 0.015, 금융지주: 0.015, 증권: 0.015, 자산운용: 0.015,
  카드금융: 0.010, 결제: 0.006, 금융정보: 0.010,
  미디어: 0.013, 광고테크: 0.006,
  산업기계: 0.011, 철도: 0.011, 항공엔진: 0.011, 방산: 0.011, 전력기기: 0.011,
  항공기: 0.009, 자동차: 0.009, 모빌리티: 0.006, 여행: 0.009, 외식: 0.012, 유통: 0.012,
  반도체: 0.006, 반도체장비: 0.006, 소프트웨어: 0.006, IT서비스: 0.006,
  IT기기: 0.006, 인터넷: 0.002, 이커머스: 0.000, 네트워크장비: 0.010,
  전자부품: 0.010, 저장장치: 0.010, 보안SW: 0.000, 바이오장비: 0.000,
  컨설팅: 0.011, 농기계: 0.011, 기타: 0.010,
};
export const DEFAULT_YIELD = 0.010;

/**
 * ★무배당 종목 명단 (실측 확인분).
 * ⛔「성장주니까 무배당」 같은 «규칙»으로 하지 마라 — 규칙은 눈에 안 보이지만
 *   명단은 «세어볼 수 있다»(인계문서 U-4 파생규율).
 */
export const NO_DIVIDEND = new Set([
  'TSLA', 'AMZN', 'PLTR', 'NFLX', 'CRWD', 'ISRG', 'UBER', 'VRTX', 'APP', 'BA',
]);

/** 종목의 «연» 배당수익률. 주식이 아니면 0 */
export function annualYieldOf(ticker: string, sectorKo: string, assetClass?: string): number {
  if (assetClass && assetClass !== 'stock') return 0;   // 지수·원자재·코인은 배당 없음
  if (NO_DIVIDEND.has(ticker)) return 0;
  return SECTOR_YIELD[sectorKo] ?? DEFAULT_YIELD;
}

/** 1회 지급 «비율» (가격 대비). 연수익률을 지급 횟수로 나눈다 */
export function perPayoutRate(annualYield: number): number {
  return (annualYield * DIVIDEND_INTERVAL_GAME_DAYS) / TRADING_DAYS_PER_YEAR;
}

/**
 * ★μ 보정량 = OFFSET × q / DRIFT_WEIGHT.
 * ⛔기본 OFFSET 이 0 이므로 «평상시 0 을 돌려준다». 함수를 남겨 둔 이유는
 *   나중에 「배당을 넣으면서 총수익을 의도적으로 조정」하고 싶을 때 한 곳에서 하기 위해서다.
 * @param driftWeight lib/constants 의 DRIFT_WEIGHT (순환참조를 피해 인자로 받는다)
 */
export function driftAdjustment(annualYield: number, driftWeight: number): number {
  if (!(driftWeight > 0)) return 0;
  return (DIVIDEND_DRIFT_OFFSET * annualYield) / driftWeight;
}

/**
 * 종목별 «지급 틱» 여부. 티커 해시로 시차를 준다.
 * ★결정론적이다 — 같은 틱이면 항상 같은 종목이 지급한다(재현 가능).
 */
export function offsetOf(ticker: string): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (Math.imul(h, 31) + ticker.charCodeAt(i)) >>> 0;
  return h % DIVIDEND_INTERVAL_TICKS;
}

export function isPayoutTick(ticker: string, tick: number): boolean {
  return tick > 0 && tick % DIVIDEND_INTERVAL_TICKS === offsetOf(ticker);
}

// ══════════════════════════════════════════════════════════════════════════
// 적용기 — ★코어(world.ts)가 «한 줄»만 부르면 되게 만든다
// ══════════════════════════════════════════════════════════════════════════
/**
 * ⛔`World` 를 import 하지 «않는다». 구조적 인터페이스만 받는다.
 * ★이유 2개:
 *   ① `world.ts` 는 다른 레인과 공유되는 코어라, 이 파일이 그걸 import 하면
 *      순환참조와 «동시 편집 충돌»이 둘 다 생긴다.
 *   ② 벤치가 «가짜 월드»로 이 로직만 따로 검증할 수 있다.
 */
export interface DividendAccountLike {
  id: string;
  nickname: string;
  isBot: boolean;
  cash: number;
  holdings: Map<string, { qty: number; avgCost: number }>;
}
export interface DividendWorldLike {
  tick: number;
  accounts: Map<string, DividendAccountLike>;
  /** 현재가 조회. 모르는 티커면 undefined */
  priceOf(ticker: string): number | undefined;
  /** 배당락 — ★«현재가만» 내린다. 이력을 건드리지 않는다 */
  applyExDividend(ticker: string, rate: number): void;
  /** 종목 메타 */
  metaOf(ticker: string): { sectorKo: string; assetClass?: string } | undefined;
  /** 이번 틱에 존재하는 전 티커 */
  tickers(): Iterable<string>;
}

/**
 * 한 틱분 배당 처리. `world.step()` 에서 «한 번» 부른다.
 *
 * 순서가 중요하다:
 *   ① 이번 틱에 지급할 종목을 «먼저» 고른다 (보통 0~6개)
 *   ② 그 종목을 보유한 계정에 현금 지급
 *   ③ ★그 «다음»에 배당락을 적용한다
 * ⛔②③ 순서를 바꾸지 마라 — 배당락 후 가격으로 지급액을 계산하면 금액이 미세하게 작아진다.
 *
 * ★비용: 지급 종목이 있는 틱에만 계정을 순회한다. 실측상 750틱 중 560틱에서
 *   평균 1.77종목이 지급되고, 한 틱 최대 6종목이다. 매 틱 전 계정 스캔과 «성격이 다르다».
 * @returns 발생한 이벤트 (호출부가 emit 한다)
 */
export function stepDividends(w: DividendWorldLike): DividendEvent[] {
  const due: Array<{ ticker: string; rate: number; price: number }> = [];
  for (const ticker of w.tickers()) {
    if (!isPayoutTick(ticker, w.tick)) continue;
    const meta = w.metaOf(ticker);
    if (!meta) continue;
    const q = annualYieldOf(ticker, meta.sectorKo, meta.assetClass);
    if (q <= 0) continue;
    const price = w.priceOf(ticker);
    if (price === undefined || !(price > 0)) continue;
    due.push({ ticker, rate: perPayoutRate(q), price });
  }
  if (due.length === 0) return [];

  const events: DividendEvent[] = [];
  for (const acc of w.accounts.values()) {
    if (acc.holdings.size === 0) continue;
    for (const d of due) {
      const h = acc.holdings.get(d.ticker);
      if (!h || !(h.qty > 0)) continue;
      const perShare = d.price * d.rate;
      const amount = perShare * h.qty;
      if (!(amount > 0)) continue;
      acc.cash += amount;
      /* ★avgCost 를 «내리지 않는다». 배당은 «수익 실현»이지 원가 회수가 아니다.
         내리면 미실현 손익이 부풀어 랭킹 수익률이 왜곡된다. */
      events.push({
        type: 'dividend', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
        ticker: d.ticker, perShare, amount, tick: w.tick,
      });
    }
  }
  // ③ 지급이 «끝난 뒤» 배당락
  for (const d of due) w.applyExDividend(d.ticker, d.rate);
  return events;
}

// ══════════════════════════════════════════════════════════════════════════
// ★만기 전 배당 «예보» — 옵션·선도 가격이 이걸 알아야 착취가 닫힌다
// ══════════════════════════════════════════════════════════════════════════
/**
 * ⛔★[2026-08-22 실측으로 잡은 구멍] 배당락은 «완전한 결정론»이다:
 *      isPayoutTick(t, tick) = tick % 750 === hash(ticker) % 750
 *   그런데 `optionPremium(kind, S, K, sigma, tGameDays)` 에는 **배당 인자가 없다**.
 *   ⇒ 「곧 떨어질 것을 아는데 가격에 없다」 ⇒ 직전에 풋을 사면 그 차이가 그대로 이익.
 *   [실측] 풋 ATM x20000 왕복 12사이클 **+12.54%** · 규모에 «선형». 무배당 틱 대조군은 0.
 *
 * ⇒ 표준 재무 그대로 고친다: **만기 전 예상 배당을 반영한 «실효 기초자산가»로 가격을 매긴다.**
 *   콜·풋에 동시에 적용되므로 한쪽만 싸지지 않는다.
 * ★이산 배당이므로 연속 근사(S·e^(−qT))를 쓰지 «않는다» — 실제 적용 방식과 «같은 식»으로 센다.
 *   엔진은 지급 시 `price *= (1 − rate)` 를 하므로 예보도 `(1 − rate)^횟수` 여야 정확히 상쇄된다.
 */
export function payoutCountBetween(ticker: string, fromTick: number, toTick: number): number {
  if (!(toTick > fromTick)) return 0;
  const off = offsetOf(ticker);
  /* (fromTick, toTick] 구간에서 t % L === off 인 t 의 개수 — O(1) */
  const L = DIVIDEND_INTERVAL_TICKS;
  const f = Math.floor((fromTick - off) / L);
  const t = Math.floor((toTick - off) / L);
  return Math.max(0, t - f);
}

/**
 * 만기까지의 «실효 기초자산가 배수». 배당이 없으면 1 이다.
 * @returns (1 − rate)^(만기 전 지급 횟수)
 */
export function exDivFactor(
  ticker: string,
  sectorKo: string,
  assetClass: string | undefined,
  fromTick: number,
  toTick: number
): number {
  const q = annualYieldOf(ticker, sectorKo, assetClass);
  if (q <= 0) return 1;
  const n = payoutCountBetween(ticker, fromTick, toTick);
  if (n <= 0) return 1;
  return Math.pow(1 - perPayoutRate(q), n);
}

/** 배당 이벤트 — 세션 한정. ⛔저장하지 않는다 */
export interface DividendEvent {
  type: 'dividend';
  accountId: string;
  nickname: string;
  isBot: boolean;
  ticker: string;
  /** 주당 배당금 */
  perShare: number;
  /** 지급 총액 */
  amount: number;
  tick: number;
}
