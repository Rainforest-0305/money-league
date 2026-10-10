/**
 * 로컬 엔진 내부 타입 — 서버 `build/server/src/types.ts` 이식본.
 *
 * 서버 원본과의 차이 1건:
 *   서버 Instrument 는 companyName/sector/sectorTier 를 들고 있었으나(응답 직렬화용),
 *   정적 빌드에서는 표시용 메타가 `src/data/tickers.generated.ts`(TickerMeta) 에 이미
 *   있으므로 엔진은 계산에 쓰는 필드만 갖는다. 중복 보관을 피하기 위한 축소이며
 *   가격·체결 계산에 쓰이는 필드는 하나도 빠지지 않았다.
 */
import type { LevSide, OptionKind, Side } from '../types';

export type { LevSide, OptionKind, Side };

/**
 * 참가자 전략(콘셉트) 식별자.
 * ★앞 5종 = 원년 아키타입. 뒤 8종 = 2026-08-20 추가된 콘셉트(concepts.ts 가 정본).
 * ★여기에 문자열을 «직접» 나열하는 이유: concepts.ts 를 import 하면 순환참조가 된다.
 *   값을 바꿀 때는 concepts.ts 의 NEW_CONCEPTS 와 «반드시» 같이 고쳐라.
 */
export type LegacyBotStrategy =
  | 'momentum'
  | 'mean_reversion'
  | 'whale'
  | 'noise'
  | 'derivatives_heavy';

export type BotStrategy =
  | LegacyBotStrategy
  | 'blue_chip'
  | 'dip_buyer'
  | 'all_in'
  | 'diversifier'
  | 'day_trader'
  | 'hodler'
  | 'short_seller'
  | 'low_vol'
  | 'liquidation_hunter';

export interface Instrument {
  rank: number;
  ticker: string;
  initialPrice: number;
  /** 연율 드리프트 */
  mu: number;
  /** 연율 변동성 */
  sigma: number;
  /** 유동성 깊이 (USD) */
  liquidityDepth: number;
}

export interface BotDef {
  botId: string;
  nickname: string;
  strategy: BotStrategy;
}

export interface Holding {
  qty: number;
  /** 주당 평균 매입단가 (수수료 포함) */
  avgCost: number;
}

export interface LeveragePosition {
  id: string;
  ticker: string;
  side: LevSide;
  leverage: number;
  /** 초기 증거금 (USD, 이미 현금에서 차감됨) */
  margin: number;
  /** 진입 명목가치 = margin * leverage */
  notional: number;
  /** notional / entryPrice */
  qty: number;
  entryPrice: number;
  openedTick: number;
  fundingPaid: number;
  lastFundingTick: number;
  /**
   * ★선물 전용 만기 틱. undefined 면 «무기한 레버리지»(기존 동작).
   * ★기존 저장본에는 이 필드가 «없다» — undefined 로 복원되어 그대로 무기한이 된다.
   *   즉 SAVE_VERSION 을 올리지 않고도 안전하다(President 하드게이트).
   */
  expiryTick?: number;
}

/** ★대출 종류 — 담보(보유자산 담보) · 신용(무담보) */
export type LoanKind = 'secured' | 'unsecured';

/**
 * ★대출 1건 (2026-09-05).
 *
 * ★★«변동금리»다(President 명시). 그래서 여기에 «금리»를 저장하지 않고 «가산금리»만 둔다.
 *   실효금리 = 정책금리(지금 값) + spreadBp/1e4 (+ 연체 중이면 연체가산).
 *   ⛔`rate` 를 필드로 넣지 마라 — 넣는 순간 고정금리가 되고, 기준금리가 바뀌어도
 *     기존 대출이 안 따라온다. 그게 이 지시의 정반대다.
 * ★가산금리는 «개시 시점의 신용등급»으로 고정한다 — 실제 대출도 그렇다(약정 스프레드).
 *   신용이 나빠졌다고 소급해 올리지 않는다. 대신 «연체»는 그 자리에서 가산된다.
 */
export interface Loan {
  id: string;
  kind: LoanKind;
  /** 남은 원금 */
  principal: number;
  /** 못 낸 이자(연체 누적). 상환은 «이자 먼저» */
  accruedInterest: number;
  /** 개시 시점에 확정된 가산금리(bp) = 신용 스프레드 + 상품 스프레드 */
  spreadBp: number;
  /** 개시 시점 신용등급 — 표시·감사용 */
  grade: string;
  openedTick: number;
  /**
   * ★만기 틱 (2026-09-05 President 「만기 때 현금에서 자동상환되게」).
   *   ⛔optional 이다 — 만기 개념이 없던 첫 구현의 저장본을 위해서다. 없으면 «만기 없음»으로 읽고
   *     자동상환을 걸지 않는다(빚이 임의로 사라지는 것보다 안전한 쪽).
   */
  maturityTick?: number;
  /** 마지막으로 이자를 «정산한» 게임일. 매 틱 부동소수 누적을 막는 장치다 */
  lastAccrualDay: number;
  /** 연속 연체 게임일 수. 상환하면 0 으로 돌아간다 */
  delinquentDays: number;
  /** 마진콜이 «걸린» 게임일 (없으면 −1). 유예 안에 해소 못 하면 강제청산 */
  marginCallDay: number;
  /** 누적 지급 이자 — 화면 표시·감사용 */
  interestPaid: number;
}

export interface OptionPosition {
  id: string;
  ticker: string;
  kind: OptionKind;
  strike: number;
  contracts: number;
  /** 총 지불 프리미엄 (수수료 제외) */
  /** 총 지불(매수) 또는 수취(매도) 프리미엄 — 부호 없는 절대금액 */
  premiumPaid: number;
  feePaid: number;
  openedTick: number;
  expiryTick: number;
  /**
   * ★'buy' = 권리 매수(기존) · 'sell' = 권리 «매도»(숏 개시).
   * ★undefined 면 'buy' 로 읽는다 — 기존 저장본 호환(SAVE_VERSION 무변경).
   */
  side?: 'buy' | 'sell';
  /** ★매도 포지션의 예치 증거금. 매수는 undefined */
  margin?: number;
  /**
   * ★★이 계약 «하나»가 담는 주(단위) 수 — 개시 시점에 «찍어서 보관»한다.
   *
   * ★왜 저장하는가 (⛔종목에서 매번 다시 구하지 마라):
   *   계약 크기는 종목마다 다르고(`constants.sharesPerContractFor`), 규칙이 바뀌는 날
   *   «이미 열려 있는 포지션»의 평가·정산이 통째로 어긋난다. 개시 때의 값을 들고 있으면
   *   포지션은 «자기가 체결된 조건»으로 끝까지 계산된다.
   * ★undefined 면 SHARES_PER_CONTRACT(=10) 로 읽는다 — ★2026-09-05 이전 저장본 호환.
   *   그때는 전 종목이 10 이었으므로 «옛 포지션의 값이 한 푼도 변하지 않는다»
   *   (증명: scripts/check_option_arb.mjs --selftest 의 legacy-position 케이스).
   */
  sharesPerContract?: number;
}

/**
 * ★선도(Forward) 포지션 — 만기 «3 게임일 고정»(OPTION 과 달리 선택 없음).
 *
 * ★선물과의 차이: 선물은 진입가가 «현물가»이고 캐리를 펀딩비로 걷는다.
 *   선도는 캐리를 «가격 안»에 심는다(contractPrice = 기준가 x exp(carry)).
 *   ⇒ 그래서 만기를 늘리면 콜-풋 패리티 차익거래가 열린다. 3게임일 고정이 그 방어다.
 * ★기준가(refPrice)는 «체결 시점 현재가»가 아니라 «최근 VWAP»이다 — 자기/타인 펌프의
 *   일시 임팩트가 계약 조건에 실리지 않게 한다(FORWARD_REF_VWAP_TICKS).
 */
export interface ForwardPosition {
  id: string;
  ticker: string;
  side: LevSide;
  /** 계약 명목가치 (USD) */
  notional: number;
  /** notional / contractPrice */
  qty: number;
  /** 체결된 선도가 F (스프레드 포함) */
  contractPrice: number;
  /** 산출에 쓴 기준가 (VWAP) — 검증·표시용 */
  refPrice: number;
  /** 예치 증거금 */
  margin: number;
  /** 상대 트레이더 아키타입 (표시용. ⛔화면 문구에 「봇」이라 쓰지 않는다) */
  counterparty: BotStrategy;
  openedTick: number;
  expiryTick: number;
  feePaid: number;
}

/**
 * ★스왑(Swap) — 「A 와 B 중 어느 쪽이 더 오르나」. 상대성과 교환.
 *
 * ★정통 IRS(고정 대 변동)를 쓰지 않은 이유: 이 게임은 r=0 이라 변동금리 다리의
 *   기준이 «존재하지 않는다». 종목 대 종목 상대성과는 이 게임에서 실체가 있는 유일한 스왑이고,
 *   시장 방향과 무관한 플레이를 열어 전략 폭을 넓힌다.
 * ★다리가 2개라 스프레드도 2배다(SWAP_SPREAD_BP). 선도보다 싸게 두면
 *   「스왑 + 선도B」로 선도A 를 합성하는 차익거래가 열린다 — 하한 10bp.
 */
export interface SwapPosition {
  id: string;
  tickerA: string;
  tickerB: string;
  /** 'a' = A 가 더 오른다에 건다 · 'b' = B */
  side: 'a' | 'b';
  notional: number;
  entryA: number;
  entryB: number;
  /** 계약에 반영된 «상대 캐리» (A−B, 수익률 단위). 정산 시 차감된다 */
  carrySpread: number;
  margin: number;
  counterparty: BotStrategy;
  openedTick: number;
  expiryTick: number;
  feePaid: number;
}

/** ★상대 트레이더가 제시한 호가 1건 (선도·스왑 공용) */
export interface CounterQuote {
  /** 상대 아키타입 */
  strategy: BotStrategy;
  /** 상대 표시명 */
  nickname: string;
  /** 제시 가격(선도) 또는 제시 캐리스프레드(스왑) */
  price: number;
  /** 공정가 대비 (양수 = 플레이어에게 불리) */
  vsFairBp: number;
}

/**
 * ★UI 용 «선도» 뷰. lib/types.ts(Portfolio)를 «건드리지 않기» 위해 여기 둔다 —
 *   그 파일은 store/screens 와 함께 UI 레인이 읽는 계약이라 임의 변경이 위험하다.
 */
export interface ForwardView {
  id: string;
  ticker: string;
  side: LevSide;
  notional: number;
  contractPrice: number;
  /** 현재 기준가 */
  price: number;
  margin: number;
  /** 증거금 포함 현재 가치 */
  equity: number;
  pnl: number;
  counterparty: BotStrategy;
  counterpartyName: string;
  remainGameDays: number;
}

/** ★UI 용 «스왑» 뷰 */
export interface SwapView {
  id: string;
  tickerA: string;
  tickerB: string;
  side: 'a' | 'b';
  notional: number;
  margin: number;
  equity: number;
  pnl: number;
  /** A 수익률 − B 수익률 (계약 캐리 차감 전) */
  relPct: number;
  counterparty: BotStrategy;
  counterpartyName: string;
  remainGameDays: number;
}

export interface Account {
  id: string;
  nickname: string;
  isBot: boolean;
  strategy?: BotStrategy;
  cash: number;
  /**
   * 이 계정의 시드 자본. 플레이어 = SEED_CASH(1만), 봇 = 아키타입별 시드
   * (노이즈 2만 ~ 화이트웨일 200만). 수익률 표시의 분모다 — 서버는 모든 계정에
   * SEED_CASH 를 분모로 썼는데(world.ts:471) 봇 시드가 제각각이라 화이트웨일이
   * 항상 "+19,900%" 로 찍혔다. 계정별 시드를 들고 있으면 그 왜곡이 사라진다.
   */
  seedCash: number;
  holdings: Map<string, Holding>;
  levPositions: Map<string, LeveragePosition>;
  /**
   * ★대출 (2026-09-05 President 지시). 기존 저장본엔 없다 — 복원 시 «빈 Map» 이 기본값이다.
   * ⛔봇은 대출하지 «않는다». 지시 범위 밖이고, 봇에 부채를 주면 랭킹·파산 판정이
   *   전부 흔들려 밸런스 검증을 처음부터 다시 해야 한다.
   */
  loans: Map<string, Loan>;
  /**
   * ★대출 연체 «이력» 횟수 — 신용점수 감점에 쓴다(`world.creditGrade`).
   *
   * ★★두 경로를 «구분»한다 (2026-09-10 President 결정으로 갱신):
   *   ① 게임 «안»에서 일어나는 일 — 상환·청산·파산 탕감으로는 ⛔사라지지 «않는다».
   *      갚았다고 이력이 지워지면 감점이 무의미해진다.
   *   ② 계좌를 통째로 새로 시작하는 «초기화» — `gameWorld.resetSeason()`(새 시즌) ·
   *      `resetPlayer()`(로그아웃) 에서는 **0 으로 지운다.**
   *      President 원문: 「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」.
   *      ⇒ 새 시즌은 시드 $10,000 으로 «다시 출발»하는 것이라 신용등급도 최고 등급에서 시작한다.
   * ⛔①과 ②를 헷갈려 초기화의 0 대입을 「버그」로 보고 지우지 마라 — 그건 President 결정을 되돌리는 것이다.
   */
  delinquencyCount: number;
  /**
   * ★★«마이너스 계좌»(연체 잔액) 상태 — 2026-09-05 President 지시.
   *   「연체되면 원리금을 차감해서 마이너스 계좌로 만들고, 마이너스 금액에 대해
   *     연체금리로 이자를 계속 붙여.」
   *
   * ★★연체 잔액은 «별도 필드가 아니라 `cash` 가 음수인 것» 그 자체다.
   *   ⛔`overdraftBalance` 같은 필드를 새로 만들지 마라 — 그러면 잔액이 «두 벌»이 되고,
   *     현금 유입이 어느 쪽을 줄이는지가 경로마다 갈린다.
   *   ⇒ 이 필드는 «금리와 시점»만 들고 있다. 잔액은 언제나 `Math.max(0, -acc.cash)` 다.
   *   ⇒ 덕분에 President 의 「유입은 우선 마이너스 상환」이 «공짜로» 성립한다:
   *     매도·배당·충전·리워드가 전부 `cash += x` 라서 자동으로 음수를 메운다.
   * ★null = 마이너스 아님(정상).
   */
  overdraft: { spreadBp: number; sinceDay: number; lastAccrualDay: number } | null;
  /**
   * ★«파산 이력» — 연체 파산(B 경로)으로 채무가 탕감된 횟수. 2026-09-05 신설.
   *
   * ★★두 경로를 «구분»한다 (2026-09-10 President 결정으로 갱신):
   *   ① 파산 «탕감» 경로(`world.declareOverdraftBankruptcy`) — 영구 기록이다.
   *      ⛔청산 뒤에 0 으로 되돌리지 마라. 남은 빚을 탕감해 주는 «대가»가 신용의 흉터다.
   *      지우면 「빌리고 파산하기」가 최적 전략이 된다. 그 경로의 `+= 1` 은 손대지 마라.
   *   ② 계좌 «초기화» — `gameWorld.resetSeason()`(새 시즌) · `resetPlayer()`(로그아웃) 에서는
   *      **0 으로 지운다.** President 원문: 「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」.
   *      시즌 초기화는 빚을 «탕감»받는 것이 아니라 계좌를 버리고 다시 시작하는 것이라 성격이 다르다.
   * ⛔①과 ②를 헷갈리지 마라. 초기화의 0 대입을 지우면 President 결정을 되돌리는 것이고,
   *   탕감 경로에 0 을 넣으면 게임이 망가진다.
   */
  bankruptcyCount: number;
  optPositions: Map<string, OptionPosition>;
  /** ★선도 포지션. 기존 저장본엔 없다 — 복원 시 «빈 Map» 이 기본값이다 */
  fwdPositions: Map<string, ForwardPosition>;
  /** ★스왑 포지션. 위와 같다 */
  swapPositions: Map<string, SwapPosition>;
  realizedPnl: number;
  feesPaid: number;
  tradeCount: number;
  liquidationCount: number;
  /** 누적(전체 기간) 충전 횟수 */
  topupCount: number;
  /**
   * ★충전 «외» 경로로 주입된 시드(USD). 2026-08-22 신설 — 공유 리워드가 여기 쌓인다.
   *
   * ★왜 topupCount 로 못 세는가: 수익률 분모가 `seedCash * (1 + topupCount)` 라
   *   «TOPUP_AMOUNT 배수»만 표현할 수 있다. 공유 리워드 금액은 앱인토스 «콘솔»이 정하고
   *   이벤트로 내려오므로 배수라는 보장이 없다. 배수로 반올림하면 분모가 조용히 어긋난다.
   * ⇒ 그래서 «금액 그대로» 더하는 항을 따로 둔다. 분모는 `world.investedBase(acc)` 하나가 계산한다.
   * ★기존 저장본에는 이 키가 «없다» — 복원 시 0 이다(SAVE_VERSION 불변).
   */
  bonusSeed: number;
  createdAt: number;
}

export interface EngineTickDiag {
  ticker: string;
  driftRW: number;
  drift70: number;
  orderFlowRaw: number;
  impact: number;
  returnTick: number;
  netOrderFlow: number;
  price: number;
}
