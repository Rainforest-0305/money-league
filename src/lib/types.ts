/**
 * 화면이 쓰는 뷰 타입.
 *
 * 원래는 "서버 REST/WS 응답 타입 미러"였다. 정적 단독 빌드에는 서버가 없으므로
 * 이제 로컬 엔진(lib/engine)이 만들어 주는 값의 형태를 정의한다.
 * (삭제: ConnState — 연결상태 개념 자체가 없다. OptionQuote — REST 견적 응답 타입.)
 */

export type Side = 'buy' | 'sell';
export type LevSide = 'long' | 'short';
export type OptionKind = 'call' | 'put';

export interface Quote {
  ticker: string;
  price: number;
  prevPrice: number;
  /** 직전 틱 대비 % */
  changePct: number;
  /** 초기가(=오늘 시작가) 대비 % — 화면의 "오늘" 등락 */
  totalChangePct: number;
  initialPrice: number;
}

export interface HoldingView {
  ticker: string;
  qty: number;
  avgCost: number;
  price: number;
  value: number;
  pnl: number;
  pnlPct: number;
}

export interface LeverageView {
  id: string;
  ticker: string;
  side: LevSide;
  leverage: number;
  margin: number;
  notional: number;
  qty: number;
  entryPrice: number;
  price: number;
  equity: number;
  maintenanceMargin: number;
  liquidationPrice: number;
  funding: number;
  pnl: number;
}
/**
 * ★선물 «남은 만기»는 LeverageView 에 «없다» — portfolio() 가 안 채운다.
 *   store.levRemainGameDays(id) 로 원장에서 직접 읽는다(읽기 전용).
 * ★null = «무기한»(기존 레버리지 동작). ⛔화면은 그때 빈칸이 아니라 「무기한」을 그린다.
 */

export interface OptionView {
  id: string;
  ticker: string;
  kind: OptionKind;
  strike: number;
  /** 계약 수. ★1계약이 담는 주수는 «종목마다 다르다» — store.sharesPerContractOf(ticker) */
  contracts: number;
  /** 매수면 «지불», 매도면 «수취» 프리미엄 (부호 없는 절대금액) */
  premiumPaid: number;
  value: number;
  remainGameDays: number;
  pnl: number;
  /*
   * ── 2026-08-20 파생 확장: 옵션 «매도» ────────────────────────────────
   * ★side·margin 은 optional 이다. ⛔필수로 만들면 안 된다 —
   *   SAVE_VERSION 을 올리지 않은 채 복원되는 «옛 매수 포지션»에는 그 값이 «없다»
   *   (engine/types.ts 의 OptionPosition.side 규칙과 «같은 약속»: undefined = 'buy').
   */
  /** 'sell' 이면 권리 «매도»(숏). undefined = 'buy' */
  side?: 'buy' | 'sell';
  /** 매도 포지션의 예치 증거금. 매수는 undefined */
  margin?: number;
  /**
   * ★지금 «되사는 데 드는 값»(현재 프리미엄 평가액). 매수·매도 모두 같은 뜻이다.
   * ★화면은 이 값을 «그대로» 쓴다 — 엔진의 프리미엄 모델(sigma·잔여만기)을 복제하지 않는다.
   *   복제하면 엔진이 모델을 바꾸는 날 화면만 옛 식으로 남는다.
   */
  mark: number;
}

export interface Portfolio {
  accountId: string;
  nickname: string;
  cash: number;
  equity: number;
  holdingsValue: number;
  realizedPnl: number;
  feesPaid: number;
  tradeCount: number;
  liquidationCount: number;
  topupCount: number;
  /**
   * ★수익률의 «분모» — 엔진이 계산해 준다(`world.investedBase`).
   *   `seedCash × (1 + topupCount) + 공유 리워드 등 추가 주입분`.
   * ⛔화면이 `SEED_CASH * (1 + topupCount)` 로 다시 만들지 마라 —
   *   랭킹은 엔진 값을 쓰므로 «같은 계정의 수익률이 화면마다 달라진다».
   */
  investedBase: number;
  bankrupt: boolean;
  /**
   * ★대출 잔액(원금 + 미납이자) — 2026-09-05 신설.
   * ★순자산 = 총자산(equity) − 부채(debt). ⛔화면이 그 뺄셈을 «다시» 하지 마라.
   *   파산·랭킹·프로모션이 전부 엔진의 `netWorth` 를 쓴다 — 두 벌이면 화면과 판정이 갈린다.
   */
  debt: number;
  netWorth: number;
  /**
   * ★연체(마이너스 계좌) 잔액 — «양수»로 온다. 0 = 정상.
   * ⛔화면이 `-cash` 로 다시 세지 마라. 파산·충전 차단 판정이 엔진과 갈린다.
   */
  overdraft: number;
  /** 연체금리(연율, 변동). 연체가 아니면 0 */
  overdraftRate: number;
  /** 연체 파산 이력(영구) · 연체 이력 — 신용등급의 근거 */
  bankruptcyCount: number;
  delinquencyCount: number;
  creditScore: number;
  creditGrade: string;
  holdings: HoldingView[];
  leverage: LeverageView[];
  options: OptionView[];
  loans: LoanView[];
}

/** ★대출 1건의 «화면용» 뷰 (2026-09-05) */
export interface LoanView {
  id: string;
  kind: 'secured' | 'unsecured';
  principal: number;
  accruedInterest: number;
  /** ★지금 실효 연이자율(변동). 엔진이 매번 다시 계산해 준다 */
  rate: number;
  spreadBp: number;
  grade: string;
  delinquentDays: number;
  /** 마진콜이 걸린 게임일. −1 = 정상 */
  marginCallDay: number;
  interestPaid: number;
  openedTick: number;
}

export interface RankEntry {
  rank: number;
  accountId: string;
  nickname: string;
  isBot: boolean;
  equity: number;
  pnlPct: number;
  /** 클라이언트 계산: 직전 스냅샷 대비 순위 변동 */
  delta?: number;
}

export interface TopupStatus {
  remainingToday: number;
  usedToday: number;
  cooldownRemainMs: number;
  equity: number;
  bankrupt: boolean;
  bankruptThreshold: number;
  topupAmount: number;
  /** 지금 «무엇이든» 한 번 받을 수 있는가 (무료든 광고분이든) */
  eligible: boolean;
  dailyLimit?: number;

  /* ── 2026-08-20: 무료/광고 «역할 분리» ─────────────────────────────
   * 무료 3회 = 파산 구제 전용(쿨다운 있음) · 광고 10회 = 파산 무관(쿨다운 없음).
   * 화면이 「무엇을 권할지」 고르는 근거이므로 상태를 «따로» 내려준다. */
  /** 오늘 남은 «무료» 충전 (파산일 때만 쓸 수 있다) */
  freeRemaining: number;
  /** 지금 무료 충전을 받을 수 있는가 (파산 + 잔여 + 쿨다운 0) */
  freeEligible: boolean;
  /** 광고를 «이미 봐서» 적립됐는데 아직 안 받아간 몫 — 광고를 다시 볼 필요가 없다 */
  adPending: number;
  /** 오늘 광고로 더 받을 수 있는 총 횟수 (적립분 + 아직 안 본 몫) */
  adRemaining: number;

  /* ── 2026-09-05: 연체(마이너스 계좌) ───────────────────────────────
   * President 「연체되면 무료충전 없애.」 ★광고 충전도 같이 막는다(엔진 판단).
   * ⛔화면이 `portfolio.cash < 0` 으로 «다시» 판정하지 마라 — 엔진이 답한 이 값을 써라. */
  /** 연체 잔액(양수). 0 = 정상 */
  overdraft?: number;
  /** 연체 중인가. true 면 무료·광고 충전이 «둘 다» 잠긴다 */
  overdrawn?: boolean;
}

/**
 * 다른 참가자에게 «공개»되는 포트폴리오.
 *
 * ★ 실시간이 아니다 — 10분 이상 지난 스냅샷이다(President 결정 2026-08-19).
 *   1등 포지션을 실시간으로 그대로 베끼면 랭킹 경쟁이 무너지기 때문에,
 *   「보여주되 따라 살 수는 없게」가 설계 의도다.
 * ★ 총자산·수익률·자산곡선은 «지연 대상이 아니다» — 이미 랭킹에 실시간으로
 *   떠 있는 값이라 여기서만 늦추면 두 화면이 서로 모순된다.
 *   지연이 필요한 건 «따라 살 수 있는 정보» = 보유종목·포지션뿐이다.
 */
export interface PublicPortfolio {
  /** 이 스냅샷을 뜬 시각(ms). 화면은 「몇 분 전 기준」을 여기서 만든다 */
  asOf: number;
  holdings: { ticker: string; qty: number; avgCost: number }[];
  leverage: { ticker: string; side: 'long' | 'short'; leverage: number; margin: number }[];
  optionCount: number;
  tradeCount: number;
  liquidationCount: number;
}

/**
 * 하루짜리 카운터 현황 — 트레이더 열람권 + 리워드 보너스.
 * ★ 리셋 시각은 충전(TopupStatus)과 «같다»(KST 자정 · gameWorld.kstDateKey).
 */
export interface DailyStatus {
  /** 오늘 «새로» 연 트레이더 수 (같은 사람 재열람은 세지 않는다) */
  viewsUsed: number;
  /** 무료 한도 + 광고 보너스 */
  viewsLimit: number;
  viewsLeft: number;
  /** 광고로 받은 열람권 / 하루 상한 */
  viewBonus: number;
  viewBonusMax: number;
  /** 광고로 받은 충전권 / 하루 상한 */
  topupBonus: number;
  topupBonusMax: number;
  /** 그중 실제로 받아간 횟수 */
  topupAdUsed: number;
  /** ★오늘 공유 리워드를 «지급받은» 횟수 / 하루 상한 / 남은 횟수 */
  shareGrants: number;
  shareGrantsMax: number;
  shareLeft: number;
  /** 오늘 공유 리워드로 받은 누적 금액(USD) */
  shareUsd: number;
}

export interface TradeResult {
  ok: true;
  ticker: string;
  side: Side;
  qty: number;
  price: number;
  gross: number;
  fee: number;
  cashAfter: number;
}

/** 홈 "방금 이런 거래가 있었어요" 피드 아이템 */
export type FeedItem =
  | { id: number; at: number; kind: 'trade'; nickname: string; ticker: string; side: Side; qty: number }
  | { id: number; at: number; kind: 'liquidation'; nickname: string; ticker: string; leverage: number; side: LevSide; loss: number }
  | { id: number; at: number; kind: 'gain'; nickname: string; ticker: string; pnlPct: number };

/* ── 거시 이벤트(시황) 뷰 ──────────────────────────────────────────────
 * ★엔진(`lib/engine/macro.ts`)의 `MacroEvent` 를 화면이 «그대로» 쓰지 않는다.
 *   MacroEvent 는 「무엇을 적용했는가」(magnitude·startTick·durationTicks)를 담는 «엔진 언어»고,
 *   화면이 필요한 건 「지금 얼마나 남았고 어디가 움직이나」다. 그 변환은 store 가 한다.
 * ⛔여기에 「사라/팔라」에 해당하는 필드를 만들지 마라 — 사실만 전달한다.
 */
export type MacroType = 'rate_cut' | 'earnings_season' | 'recession_fear';

export interface MacroSector {
  nameKo: string;
  nameEn: string;
  /** 이 업종에 «적용된» 드리프트 보정의 부호. +1 오르는 쪽 / -1 내리는 쪽 */
  dir: 1 | -1;
  /** 정렬용 세기(절대값 평균). ★화면에 «숫자로» 노출하지 않는다 — 등수만 만든다 */
  weight: number;
}

export interface MacroView {
  id: string;
  type: MacroType;
  titleKey: string;
  bodyKey: string;
  /** 0~1. 진행바가 쓴다 */
  progress: number;
  remainGameDays: number;
  remainSeconds: number;
  /** 부호가 일관된 업종만. 비어 있을 수 있다 */
  sectors: MacroSector[];
  /** true = 업종이 아니라 «종목별»로 갈리는 이벤트(실적 시즌) */
  splitsByStock: boolean;
}

/**
 * ★파생 «정산» 소식 — 홈 피드에 섞인다.
 * ★내 정산은 «토스트»로, 남의 정산은 «피드»로 간다(같은 것을 두 번 알리지 않는다).
 */
export interface SettledLogItem {
  id: string;
  at: number;
  gameDay: number;
  kind: 'forward' | 'swap' | 'futures' | 'option';
  nickname: string;
  ticker: string;
  tickerB?: string;
  pnl: number;
  /** true = 강제 정리(증거금 소진) · false = 만기 도래 — ★문구가 다르다 */
  forced: boolean;
}

/** 홈 피드에 섞이는 «지나간 소식» */
export interface MacroLogItem {
  id: string;
  at: number;
  gameDay: number;
  type: MacroType;
  titleKey: string;
  bodyKey: string;
}

export interface Session {
  userId: string;
  token: string;
  nickname: string;
}

/* ── 중앙은행(LP) 보기 (2026-08-29) ────────────────────────────────────────
 * ⛔자산 총액·순위가 «없다» — President 「전체 자산은 무제한이니까 자산은 명시하지 말고」.
 *   포지션(수량·평균가·평가손익)과 체결 기록, 그리고 지수별 «괴리»만 준다.
 */
export interface CentralBankPositionView {
  ticker: string;
  /** 부호 있는 수량(+ 롱 / − 숏) */
  qty: number;
  avgCost: number;
  price: number;
  /** 평가손익(USD). 부호 있는 수량 × (현재가 − 평균가) */
  pnl: number;
}

export interface CentralBankFillView {
  id: number;
  tick: number;
  gameDay: number;
  ticker: string;
  side: Side;
  notional: number;
  price: number;
  /** 개입 «직전» 괴리(비율, + 프리미엄 / − 디스카운트) */
  basisBefore: number;
  /** ★[-24] 반대 다리(구성종목 가중합 바스켓). 옛 저장본(-23 이전 원장)에는 없다 → optional */
  basketSide?: Side;
  basketNotional?: number;
  basketPrice?: number;
  /** ★[-23] 스토어 원장이 붙이는 세션 정보(엔진 값에는 없다) — 체결 벽시계(ms) · 세션 id(부팅 시각) */
  at?: number;
  sid?: number;
}

export interface CentralBankSpreadView {
  ticker: string;
  price: number;
  fair: number;
  basis: number;
}

export interface CentralBankView {
  positions: CentralBankPositionView[];
  fills: CentralBankFillView[];
  spreads: CentralBankSpreadView[];
  interventions: number;
  /** 개입 임계(비율) — 소개 문구가 «상수에서 유도»한다 */
  threshold: number;
}

/* ── 거래 일지 (2026-08-21 신설) ─────────────────────────────────────────
 * ★★엔진은 «개별 체결»을 저장하지 않는다 [실측].
 *   `Account` 에 있는 건 누적치 3개뿐이다 — `realizedPnl` · `feesPaid` · `tradeCount`.
 *   즉 「거래 내역 N건」의 N 은 «있었지만» 그 N 건이 무엇이었는지는 «어디에도 없었다».
 *   ⇒ 그래서 일지는 UI 레인이 «새로 기록»한다(엔진 파일은 읽기만 한다 — U-7 경계).
 *
 * ★★손익·수수료를 화면이 «다시 계산하지 않는다».
 *   `realized` · `fee` 는 주문 «직전/직후» 엔진 원장(`acc.realizedPnl` · `acc.feesPaid`)의
 *   ★«증분»이다. 엔진이 프리미엄 모델이나 수수료 규칙을 바꿔도 일지는 따라온다.
 *   ⛔`store.ts` 의 「옵션 매도에 매수식을 쓰면 수수료 이중부과 + realizedPnl 매수기준」
 *     경고가 가리키는 함정이 바로 «화면이 자기 식으로 다시 계산하는 것»이다.
 */
/**
 * ★`reward` 는 «매매가 아니다» — 공유 리워드로 잔고가 늘어난 기록이다.
 *   ⛔거래 통계(tradeCount·realizedPnl·feesPaid)에 섞지 마라. 일지 요약은
 *     엔진 원장에서 오는데 원장에는 이 건이 «없다» — 섞으면 요약과 행이 어긋난다.
 */
/**
 * ★`dividend` 는 «매매가 아닌» 둘째 상품이다(`reward` 에 이어).
 *   ⛔`reward` 에 합치지 마라 — 출석·공유는 «게임이 주는 돈»이고 배당은 «내 종목이 주는 돈»이다.
 *     합치면 「거래 횟수」 요약과 「리워드」 필터가 둘 다 뜻이 흐려진다.
 *   ★이 유니온은 `ml.journal` 소속이다 — ⛔`ml.game`(SAVE_VERSION) 과 «무관»하다.
 */
export type JournalProduct = 'spot' | 'leverage' | 'futures' | 'option' | 'forward' | 'swap' | 'reward' | 'dividend';
/** open=개시(매수) · close=내가 정리 · settle=만기 정산 · liquidated=강제 정리 · grant=지급받음 */
export type JournalAction = 'open' | 'close' | 'settle' | 'liquidated' | 'grant';

export interface JournalEntry {
  id: string;
  /** 실제 시각(ms) — 「오늘 14:22」 표기용 */
  at: number;
  tick: number;
  /** 게임 일차 — 이 앱의 기본 시간 단위 */
  gameDay: number;
  product: JournalProduct;
  action: JournalAction;
  ticker: string;
  /** 스왑만 — 상대 종목 */
  tickerB?: string;
  /** 현물 buy/sell · 레버리지·선물·선도 long/short · 스왑 a/b */
  side?: string;
  /** 현물 = 주식 수 · 옵션 = 계약 수 */
  qty?: number;
  /** 체결가(현물) · 진입가(레버리지·선물) · 계약가(선도) */
  price?: number;
  /** 명목가 */
  notional?: number;
  /** 예치 증거금 */
  margin?: number;
  leverage?: number;
  optKind?: OptionKind;
  /** 옵션 매수/매도 — ★청산식이 «갈리는» 축이라 반드시 남긴다 */
  optSide?: Side;
  strike?: number;
  /** ★엔진 `acc.feesPaid` 증분 (화면이 계산한 값이 아니다) */
  fee: number;
  /** ★엔진 `acc.realizedPnl` 증분. open 건에는 없다 */
  realized?: number;
  /** 되돌리기가 성사되면 이 id 로 일지에서 «지운다» — 없던 일이 되어야 한다 */
  posId?: string;
  /**
   * ★배당만 — 한 줄이 «몇 종목»을 묶었는지. 1종목이면 없고 `ticker` 에 그 종목이 들어간다.
   * ⛔`qty`(주식 수)로 대신하지 마라 — 종목이 다르면 주식 수는 «더할 수 없는 값»이다.
   */
  count?: number;
  /**
   * ★포트폴리오 «복사»로 낸 주문 — 누구를 따라 샀는지(닉네임). 일지가 「복사」 배지로 보여준다.
   *   ⛔잔고·손익식에는 «무관»한 표지다. 저장본 형식 변경 없음(선택 필드 하나 추가).
   */
  via?: string;
}
