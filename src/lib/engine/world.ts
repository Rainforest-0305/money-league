/**
 * 게임 월드 — 서버 `build/server/src/world/world.ts` 이식본.
 * 가격·체결·청산·랭킹의 단일 소스 오브 트루스. 정적 빌드에서는 브라우저 안에서 돈다.
 *
 * 구 mockWorld.ts 와의 결정적 차이: **계정이 여러 개다.**
 * mockWorld 는 플레이어 1계정만 있고 봇은 통계 근사(botEquity[i] *= 1+mkt*beta)였다.
 * 여기서는 봇 210개가 각자 Account 를 갖고 placeSpotOrder / openLeverage / buyOption
 * 이라는 **플레이어와 완전히 동일한 주문 경로**를 탄다(ARCHITECTURE.md 6장).
 *
 * 서버 원본에서 옮긴 것: `portfolio(accountId)` 뷰 변환은 gameWorld.ts 로 이동
 * (화면 타입 lib/types.ts 에 맞추는 계층이라 계산 코어와 분리했다). 계산식은 동일.
 * WS 브로드캐스트 관련(broadcastLeaderboard/lastLeaderboard)은 전송 계층이라 삭제.
 * 서버 원본에 더한 것 2건 — 아래 [정적 빌드 추가] 표기 참조.
 *   1) 'lev_closed' 이벤트 (자발 청산도 피드에 쓰기 위해)
 *   2) computeLeaderboard 의 `alwaysInclude` (내 순위가 100위 밖이어도 내 행은 준다)
 */
import {
  ALLOWED_LEVERAGE,
  ARCHETYPE_VIEW_BIAS_BP,
  BANKRUPT_EQUITY_THRESHOLD,
  BP,
  CARRY_SPREAD_MULT,
  FORWARD_EXPIRY_GAME_DAYS,
  FORWARD_MARGIN_RATIO,
  FORWARD_REF_VWAP_TICKS,
  FORWARD_SPREAD_BP,
  OPTION_SHORT_MARGIN_RATIO,
  QUOTE_COUNT,
  QUOTE_NOISE_SD_BP,
  SWAP_SPREAD_BP,
  TRADING_DAYS_PER_YEAR,
  DRIFT_WEIGHT,
  FEE_LEVERAGE_BP,
  FEE_OPTION_BP,
  FEE_SPOT_BP,
  FUNDING_BP_PER_GAME_DAY,
  MAINTENANCE_BASIS,
  MAINTENANCE_MARGIN_RATIO,
  MAX_SINGLE_ORDER_DEPTH_FRAC,
  MIN_PRICE,
  OPTION_MAX_EXPIRY_DAYS,
  OPTION_MIN_EXPIRY_DAYS,
  SEED_CASH,
  ORDER_FLOW_WEIGHT,
  SHARES_PER_CONTRACT,
  sharesPerContractFor,
  TICKS_PER_GAME_DAY,
  CREDIT_SCORE_BASE,
  CREDIT_SCORE_MIN,
  CREDIT_SCORE_MAX,
  CREDIT_PENALTY_LIQUIDATION,
  CREDIT_PENALTY_LIQUIDATION_CAP,
  CREDIT_PENALTY_DELINQUENCY,
  CREDIT_PENALTY_DELINQUENCY_CAP,
  CREDIT_PENALTY_TOPUP,
  CREDIT_PENALTY_TOPUP_CAP,
  CREDIT_PENALTY_BANKRUPTCY,
  CREDIT_PENALTY_BANKRUPTCY_CAP,
  LOAN_TERM_CHOICES,
  LOAN_TERM_DEFAULT,
  LOAN_OVERDRAFT_PENALTY_BP,
  CREDIT_BONUS_AGE_MAX,
  CREDIT_BONUS_AGE_FULL_GAME_DAYS,
  CREDIT_BONUS_SIZE_MAX,
  CREDIT_GRADE_CUTS,
  LOAN_SPREAD_BP,
  LOAN_LTV_MAX,
  LOAN_MARGIN_CALL_LTV,
  LOAN_GRACE_GAME_DAYS,
  LOAN_UNSECURED_MULT,
  LOAN_MIN_PRINCIPAL,
  LOAN_PREPAYMENT_FEE_BP,
  LOAN_DELINQUENT_MARK_DAYS,
  LOAN_DELINQUENT_PENALTY_BP,
  LOAN_DEFAULT_DAYS,
  type CreditGrade,
  type MaintenanceBasis,
} from '../constants';
import { optionDelta, optionPayoff, optionPremium } from '../options';
import { PriceEngine, clip } from './priceEngine';
import { CentralBank, type CbMarket } from './centralBank';
import { exDivFactor, stepDividends, type DividendEvent, type DividendWorldLike } from './dividends';
import { MacroEngine, type MacroEvent, type RateEvent } from './macro';
import { Rng } from './rng';
import type {
  Account,
  BotStrategy,
  CounterQuote,
  EngineTickDiag,
  ForwardPosition,
  SwapPosition,
  Instrument,
  LevSide,
  LeveragePosition,
  Loan,
  LoanKind,
  OptionKind,
  OptionPosition,
  Side,
} from './types';
import type { RankEntry } from '../types';

/**
 * ★풀링 캐리 EWMA 가 «데워졌다»고 볼 최소 표본(틱).
 * 실측: 100종목 풀링이면 6,765틱(≈45 게임일)에서 오차 50% 수준에 도달한다.
 * 그 전에는 캐리 0 을 쓴다 — 0 은 보수적으로 안전하다.
 */
const CARRY_WARM_TICKS = 6765;

/**
 * 정상적 거절(잔고부족 등). 화면은 code 로 메시지를 고른다.
 *
 * ⛔`constructor(public code: string, ...)`(파라미터 프로퍼티)로 되돌리지 마라 — 2026-09-05.
 *   Node 의 «타입 스트립» 모드가 그 문법을 지원하지 않아서(ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
 *   `scripts/check_*.mjs` 가 이 파일을 «불러올 수 없게» 된다. 즉 엔진을 실제로 띄워서 하는
 *   검사(check_option_arb 의 ⑧ 선도가 일치)가 통째로 죽는다. 동작은 완전히 동일하다.
 */
export class GameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GameError';
  }
}

export type WorldEvent =
  | { type: 'tick'; tick: number; gameDay: number; diags: EngineTickDiag[] }
  /**
   * ★배당 지급 (2026-08-22). ⛔세션 한정 — «저장하지 않는다»(SAVE_VERSION 무변경).
   *   현금은 계좌에 이미 반영돼 저장되므로, 이 이벤트는 «알림»만을 위한 것이다.
   */
  | DividendEvent
  | {
      type: 'liquidation';
      accountId: string;
      nickname: string;
      isBot: boolean;
      ticker: string;
      positionId: string;
      leverage: number;
      side: LevSide;
      loss: number;
      returned: number;
      price: number;
      tick: number;
    }
  /** [정적 빌드 추가] 자발 청산 — 홈 피드의 "이만큼 벌었어요" 항목 원천 */
  | {
      type: 'lev_closed';
      accountId: string;
      nickname: string;
      isBot: boolean;
      ticker: string;
      roiPct: number;
      pnl: number;
      tick: number;
    }
  | { type: 'option_settled'; accountId: string; nickname: string; isBot: boolean; positionId: string; ticker: string; payoff: number; tick: number }
  | { type: 'trade'; accountId: string; nickname: string; isBot: boolean; ticker: string; side: Side; qty: number; price: number; notional: number; tick: number }
  /** [2026-08-20 추가] 거시 이벤트 발생 — 홈 피드/배너가 쓴다 */
  | { type: 'macro'; event: MacroEvent; tick: number }
  /**
   * ★[2026-08-21 추가] 포지션 «정산» — 만기 도래 또는 강제 정리.
   *
   * ★왜 필요한가: 엔진이 만기에 포지션을 delete 하면 화면에서 카드가 «그냥 사라진다».
   *   정산은 «손익이 확정되는 순간»인데 유저는 아무것도 못 본다 — 돈이 바뀌는데 조용하다.
   *   ⇒ 화면이 「{{ticker}} 정산 {{v}}」 토스트를 띄우도록 이 이벤트를 흘린다(i18n `toast.settled`).
   * ★세션 한정이다 — ⛔저장하지 않는다(SAVE_VERSION 무변경).
   * ★워밍업 3,000틱 동안은 `muted` 라 흐르지 않는다. 유저가 못 본 구간이니 그게 «맞다».
   * ★기존 `option_settled` 는 «그대로 둔다» — 이미 소비자가 있다(gameWorld 피드).
   *   이 이벤트는 4종을 «한 모양»으로 주는 별개 채널이다.
   */
  | {
      type: 'settled';
      kind: 'forward' | 'swap' | 'futures' | 'option';
      accountId: string;
      nickname: string;
      isBot: boolean;
      positionId: string;
      ticker: string;
      /** 스왑만 채워진다 (A vs B) */
      tickerB?: string;
      /** 증거금 대비 손익 (음수 가능) */
      pnl: number;
      /** 정산으로 계좌에 돌아온 금액 */
      returned: number;
      /** true = 강제 정리(증거금 소진) · false = 만기 도래 */
      forced: boolean;
      tick: number;
    }
  /* ── 대출 (2026-09-05 President 지시) ──────────────────────────────────
   * ★전부 «세션 한정 알림»이다 — ⛔저장하지 않는다(대출 «상태»는 Account.loans 에 저장된다).
   * ★`policy_rate` 는 중앙은행 «정례 회합»의 공시다. 시황 이벤트(`macro`)와 채널을 나눈 이유는
   *   성격이 다르기 때문이다: 저쪽은 가격을 밀고, 이쪽은 «빌린 돈의 값»을 바꾼다.
   */
  | { type: 'policy_rate'; event: RateEvent; tick: number }
  | {
      type: 'loan_opened';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string;
      loanKind: LoanKind;
      amount: number;
      rate: number;
      grade: string;
      tick: number;
    }
  | {
      type: 'loan_repaid';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string;
      amount: number;
      closed: boolean;
      tick: number;
    }
  | {
      type: 'loan_delinquent';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string;
      days: number;
      tick: number;
    }
  | { type: 'loan_margin_call'; accountId: string; nickname: string; isBot: boolean; loanId: string; ltv: number; tick: number }
  | {
      type: 'loan_liquidated';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string;
      reason: 'margin_call' | 'default';
      /** 다 팔고도 «남은» 부채. 0 이 아니면 순자산이 음수로 남는다 */
      shortfall: number;
      tick: number;
    }
  /* ── 만기 자동상환 · 마이너스 계좌 (2026-09-05 President 추가 지시) ─────── */
  | {
      type: 'loan_matured';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string;
      /** 만기 시점 원리금 */
      owed: number;
      /** 담보 반대매매로 «회수»한 현금 (0 = 현금으로 다 갚았거나 담보가 없었다) */
      soldNotional: number;
      /** 그래도 모자라 «마이너스 계좌»로 넘어간 금액 */
      shortfall: number;
      tick: number;
    }
  | {
      type: 'overdraft_entered';
      accountId: string;
      nickname: string;
      isBot: boolean;
      loanId: string | null;
      amount: number;
      /** 연체금리(연율) = 정책금리 + 무담보 스프레드 + 연체 가산 */
      rate: number;
      tick: number;
    }
  | { type: 'overdraft_cleared'; accountId: string; nickname: string; isBot: boolean; tick: number }
  | {
      type: 'overdraft_bankrupt';
      accountId: string;
      nickname: string;
      isBot: boolean;
      /** 전량 청산 후에도 남아 «탕감»된 채무. 0 이면 팔아서 다 갚았다 */
      writeOff: number;
      cashBefore: number;
      netWorthBefore: number;
      tick: number;
    };

type Listener = (e: WorldEvent) => void;

/** 배당 판정에 필요한 종목 메타 (섹터·자산군). data.ts 가 공급한다 */
export interface WorldTickerMeta {
  sectorKo: string;
  assetClass?: string;
}

export interface WorldOptions {
  instruments: Instrument[];
  /**
   * ★배당용 종목 메타. «없으면 배당이 아예 안 돈다» — 그래서 기존 테스트·벤치는 무영향이다.
   *   (지수 `indexes` 가 비면 동작이 안 바뀌는 것과 같은 규율)
   */
  tickerMeta?: Map<string, WorldTickerMeta>;
  seed?: number;
  /** 봇 자동매매 on/off (순수 가격엔진 검증 시 off) */
  botsEnabled?: boolean;
  maintenanceBasis?: MaintenanceBasis;
  allowedLeverage?: readonly number[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export class World {
  readonly engine: PriceEngine;
  readonly instruments: Instrument[];
  readonly accounts = new Map<string, Account>();
  /**
   * ★파생 포지션을 «가진» 계정 색인 (P1 구조 수정, 2026-08-22).
   *
   * ⛔왜 있나 [실측]: `checkLiquidations` + `settleExpired*` 4종은 매 틱 «전 계정»을
   *   Map 순회했고, 99%가 「포지션 없음」으로 continue 했다.
   *   워밍업 비용의 **66.4%**가 이 5개 스캔이었다(`run.mjs profile`).
   *   실제 포지션 보유 계정은 10,000 중 **최대 538명(5.4%)** 뿐이다.
   * ★효과: 틱 −58.6% · 워밍업 −74% · catchup −76%.
   * ★동치: 12,000틱 «전 상태 지문» 완전 일치 (`run.mjs p1rehearse`).
   *
   * ⛔⛔**포지션이 생기는 «모든» 경로에서 `trackPositions()` 를 불러야 한다.**
   *   개시 5경로(`openLeverage`·`buyOption`·`writeOption`·`openForward`·`openSwap`)뿐 아니라
   *   ★**저장본 복원**(`gameWorld.deserialize`)도 포함된다 — 거기서는 Map 을 «통째로 갈아끼우므로»
   *   개시 경로를 안 탄다. 빠뜨리면 **복원된 유저의 포지션이 영영 청산·정산되지 않는다**
   *   (에러가 안 난다. 조용히 안 돈다).
   *   ⇒ `scripts/check_position_paths.mjs` 가 이 경로를 검사한다.
   */
  private readonly posIndex = new Set<Account>();

  /**
   * 계정을 «포지션 보유» 색인에 등록한다.
   * ★넣는 것은 싸고(Set.add) 빼는 것은 스캔이 알아서 한다 — 중복 호출은 무해하다.
   * ★그래서 «의심되면 부르는» 쪽이 항상 안전하다.
   */
  trackPositions(acc: Account): void {
    this.posIndex.add(acc);
  }

  /**
   * 파생 포지션을 «실제로 가진» 계정만 돌려준다. 비어 버린 계정은 여기서 색인에서 뺀다.
   * ★Set 은 순회 중 삭제가 안전하다(이미 방문했거나 현재 원소).
   */
  private *positionHolders(): IterableIterator<Account> {
    for (const acc of this.posIndex) {
      if (
        acc.levPositions.size > 0 || acc.optPositions.size > 0 ||
        acc.fwdPositions.size > 0 || acc.swapPositions.size > 0
      ) {
        yield acc;
      } else {
        this.posIndex.delete(acc);
      }
    }
  }
  readonly rng: Rng;
  tick = 0;
  botsEnabled: boolean;
  readonly maintenanceBasis: MaintenanceBasis;
  readonly allowedLeverage: readonly number[];
  /** 배당용 종목 메타 (비어 있으면 배당이 돌지 않는다) */
  readonly tickerMeta: Map<string, WorldTickerMeta>;
  stats = { orders: 0, liquidations: 0, optionSettlements: 0, feesCollected: 0 };
  /** 거시 이벤트 엔진 (섹터별 시황) */
  readonly macro: MacroEngine;
  /**
   * ★중앙은행(LP) — 2026-08-29 President 지시. ⛔계정(`accounts`)이 «아니다».
   *   자산 무제한이라 랭킹·명부·스냅샷·포지션 색인 어디에도 들어가지 않는다. 지수 «시장가»가
   *   «공정가»에서 벗어나면 반대 매매로 되돌린다. 체결은 `centralBankTrade` 하나를 지난다.
   * ★`engine.indexes` 가 비면(지수 없는 데이터) 아무 동작도 하지 않는다 — 기존 벤치 무영향.
   */
  readonly centralBank: CentralBank;
  /**
   * ★종목별 «청산 임박» 레버리지 노출 (매 틱 갱신).
   * 청산 사냥꾼 콘셉트가 읽는다. ★계정을 구분하지 «않는다» — 봇이든 사람이든
   * 「과열된 포지션 일반」만 본다. 특정 플레이어를 지목하면 공정하지 않다.
   */
  readonly vulnerable = new Map<string, { long: number; short: number }>();
  /** 아키타입별 표시 닉네임 색인 (지연 생성) */
  private nickByStrategy: Map<string, string[]> | null = null;
  private listeners: Listener[] = [];
  /** 이벤트 방출 억제 (워밍업 3000틱 동안 피드/토스트를 만들지 않는다) */
  muted = false;
  /**
   * ★대출 이자·건전성을 «마지막으로» 돌린 게임일. −1 = 아직 한 번도 안 돌았다.
   * ⛔매 틱 돌리지 마라 — 이자는 게임일 단위 정산이고, 매 틱 누적하면 부동소수 오차가 쌓인다.
   */
  private lastLoanDay = -1;
  /** ★파산(연체 경로) 판정을 마지막으로 돌린 게임일. 틱 노이즈로 파산이 튀지 않게 일 단위다 */
  private lastBankruptcyDay = -1;

  constructor(opts: WorldOptions) {
    this.instruments = opts.instruments;
    this.rng = new Rng(opts.seed ?? (Date.now() & 0x7fffffff));
    this.engine = new PriceEngine(opts.instruments, this.rng);
    this.botsEnabled = opts.botsEnabled ?? true;
    this.maintenanceBasis = opts.maintenanceBasis ?? MAINTENANCE_BASIS;
    this.macro = new MacroEngine(opts.seed ?? 0);
    this.allowedLeverage = opts.allowedLeverage ?? ALLOWED_LEVERAGE;
    this.tickerMeta = opts.tickerMeta ?? new Map();
    this.centralBank = new CentralBank(opts.seed ?? 0);
  }

  /**
   * ★중앙은행이 보는 시장 — «플레이어와 같은 규칙»으로 체결한다.
   *   fillPrice(자기 임팩트를 체결가에 먼저 문다) + addOrderFlow(다음 틱 가격에 반영).
   *   다른 것은 «현금 검사가 없다»는 것뿐이다. 깊이·임팩트 상수를 우회하지 않는다.
   */
  private readonly cbMarket: CbMarket & { tick: number; gameDay: number } = {
    tick: 0,
    gameDay: 0,
    indexTickers: () => this.engine.indexes.keys(),
    basisOf: (t) => this.engine.basisOf(t),
    maxOrderNotional: (t) => this.maxOrderNotional(t),
    liquidityDepth: (t) => this.instrumentOf(t).liquidityDepth,
    fill: (t, side, notional) => this.centralBankTrade(t, side, notional),
    /* ★[-24] 바스켓 다리 — 지수 정의(engine.indexes)의 구성종목·가중치에서 «유도». 지수마다 자기 바스켓(SPX 500 · NDX 100) */
    fairOf: (t) => this.engine.fairPriceOf(t) ?? this.engine.priceOf(t),
    basketDepth: (t) => this.basketDepth(t),
    basketMaxNotional: (t) => this.basketMaxNotional(t),
    fillBasket: (t, side, notional) => this.centralBankBasketTrade(t, side, notional),
  };

  /** 중앙은행 체결 1건. ★자기 임팩트 + 주문흐름은 플레이어 현물과 «같은 식»이다 */
  centralBankTrade(ticker: string, side: Side, notional: number): number {
    this.instrumentOf(ticker);
    if (!Number.isFinite(notional) || notional <= 0) return 0;
    const signed = side === 'buy' ? notional : -notional;
    const price = this.fillPrice(ticker, signed);
    this.engine.addOrderFlow(ticker, signed);
    this.stats.orders++;
    return price;
  }

  /**
   * ★[-24] 지수 구성종목의 «가치가중» v_k = w_k·p_k / Σ w·p (지금 가격 기준). 공정가의 상대 변화 = Σ v_k · r_k 라
   *   바스켓 명목을 v_k 로 나누면 «시총가중 포트폴리오»를 사는 것과 같다.
   */
  private basketWeights(index: string): Array<{ ticker: string; v: number }> {
    const def = this.engine.indexes.get(index);
    if (!def) return [];
    let tot = 0;
    const raw = def.constituents.map((c) => {
      const x = c.weight * this.engine.priceOf(c.ticker);
      tot += x;
      return { ticker: c.ticker, x };
    });
    return tot > 0 ? raw.map((r) => ({ ticker: r.ticker, v: r.x / tot })) : [];
  }

  /** 바스켓 유효 깊이 = 1/Σ(v_k²/depth_k). 지수 다리의 liquidityDepth 와 같은 «W·N/깊이» 식으로 공정가가 움직인다 */
  basketDepth(index: string): number {
    let inv = 0;
    for (const { ticker, v } of this.basketWeights(index)) inv += (v * v) / this.instrumentOf(ticker).liquidityDepth;
    return inv > 0 ? 1 / inv : 0;
  }

  /** 바스켓 명목 상한 = min_k(maxOrderNotional_k / v_k) — 어느 구성종목도 단일주문 상한을 넘지 않는다 */
  basketMaxNotional(index: string): number {
    let m = Infinity;
    for (const { ticker, v } of this.basketWeights(index)) if (v > 0) m = Math.min(m, this.maxOrderNotional(ticker) / v);
    return Number.isFinite(m) ? m : 0;
  }

  /**
   * ★[-24] 중앙은행 바스켓 체결 — 구성종목 «전부»에 가치가중으로 나눠 플레이어 현물과 같은 식(fillPrice + addOrderFlow).
   *   ⇒ 지수 다리와 «반대 방향» 압력이 구성종목 가격(=공정가)에 대칭으로 간다. 돌려주는 값 = 바스켓 단위가(공정가 × 가중 체결비율).
   *   stats.orders 는 «1 회»로 센다(벤치의 틱당 주문 수 지표를 500배 부풀리지 않기 위해).
   */
  centralBankBasketTrade(index: string, side: Side, notional: number): number {
    if (!Number.isFinite(notional) || notional <= 0) return 0;
    const ws = this.basketWeights(index);
    if (ws.length === 0) return 0;
    let ratio = 0;
    for (const { ticker, v } of ws) {
      const n = notional * v;
      if (!(n > 0)) continue;
      const signed = side === 'buy' ? n : -n;
      const p0 = this.engine.priceOf(ticker);
      const price = this.fillPrice(ticker, signed);
      this.engine.addOrderFlow(ticker, signed);
      ratio += v * (p0 > 0 ? price / p0 : 1);
    }
    this.stats.orders++;
    const fair = this.engine.fairPriceOf(index) ?? this.engine.priceOf(index);
    return fair * ratio;
  }

  // ── 이벤트 ────────────────────────────────────────────────────────────
  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: WorldEvent): void {
    if (this.muted || this.listeners.length === 0) return;
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[world] listener error', err);
      }
    }
  }

  get gameDay(): number {
    return Math.floor(this.tick / TICKS_PER_GAME_DAY);
  }

  // ── 계정 ──────────────────────────────────────────────────────────────
  createAccount(id: string, nickname: string, isBot = false, cash = SEED_CASH, strategy?: BotStrategy): Account {
    if (this.accounts.has(id)) throw new GameError('DUPLICATE_ACCOUNT', `account exists: ${id}`);
    const acc: Account = {
      id,
      nickname,
      isBot,
      strategy,
      cash,
      seedCash: cash,
      holdings: new Map(),
      levPositions: new Map(),
      optPositions: new Map(),
      fwdPositions: new Map(),
      swapPositions: new Map(),
      loans: new Map(),
      delinquencyCount: 0,
      overdraft: null,
      bankruptcyCount: 0,
      realizedPnl: 0,
      feesPaid: 0,
      tradeCount: 0,
      liquidationCount: 0,
      topupCount: 0,
      bonusSeed: 0,
      createdAt: Date.now(),
    };
    this.accounts.set(id, acc);
    return acc;
  }

  getAccount(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new GameError('NO_ACCOUNT', `unknown account ${id}`);
    return a;
  }

  instrumentOf(ticker: string): Instrument {
    const s = this.engine.get(ticker);
    if (!s) throw new GameError('NO_TICKER', `unknown ticker ${ticker}`);
    return s.inst;
  }

  /**
   * ★옵션 1계약이 담는 주(단위) 수 — «종목마다 다르다». 근거는 constants.sharesPerContractFor.
   * ⛔화면·봇·검사기가 `SHARES_PER_CONTRACT` 를 직접 곱하지 마라. 이 통로로 받아라(U-7).
   * ★개시가에서 «유도»하므로 장중에 바뀌지 않는다.
   */
  sharesPerContractOf(ticker: string): number {
    return sharesPerContractFor(this.instrumentOf(ticker).initialPrice);
  }

  /**
   * ★이미 열린 포지션의 계약 크기 — «포지션에 찍힌 값»이 우선이다.
   * ⛔종목에서 다시 구하지 마라. 규칙이 바뀌는 날 옛 포지션의 평가가 조용히 어긋난다.
   */
  private posShares(pos: OptionPosition): number {
    return pos.sharesPerContract ?? SHARES_PER_CONTRACT;
  }

  /** 단일 주문 명목금액 상한 (유동성 깊이의 5%) — 플레이어·봇 동일 적용 */
  maxOrderNotional(ticker: string): number {
    return this.instrumentOf(ticker).liquidityDepth * MAX_SINGLE_ORDER_DEPTH_FRAC;
  }

  /**
   * ★체결가 — «자기 주문이 만들 가격 임팩트»를 체결가에 «먼저» 반영한다.
   *
   * ★왜 필요한가 [실측, 2026-08-20]:
   *   예전에는 체결가로 engine.priceOf() = «임팩트 반영 전» 가격을 썼고, 그 주문의
   *   임팩트는 «다음 틱»에 붙었다. 그래서 내 주문이 만든 상승이 내 체결가에 안 들어갔다.
   *   호가창도 상대방도 없으니 그 차액은 누구의 손실도 아니고 «그냥 생성»됐다.
   *   실측: 20배 레버리지 $10,000 이 120틱(실제 4분)에 +1,317%. 현물 $700,000 왕복
   *   1틱에 +1.39%p(수수료 차감 후). 보유 시간과 무관하게 영구히 남았다.
   *
   * ★수정 후: 매수 P0(1+i) -> 매도 P0(1+i)(1-i) 이므로 왕복이 «구조적으로 음수»가 된다.
   *   i = ORDER_FLOW_WEIGHT x clip(주문명목/유동성깊이, -1, 1) 로 다음 틱 임팩트와 «같은 식»이다.
   *
   * ★부호 규약: signedNotional 은 매수 +, 매도 −. 결과는 «항상 주문자에게 불리»하다.
   *   매수/롱개시 -> 비싸게, 매도/숏개시/청산 -> 싸게. 반대로 넣으면 익스플로잇이 «커진다».
   * ★orderFlow 누적은 그대로 둔다 — 다음 틱 가격에 반영되는 것 자체는 정상이다.
   *   바꾸는 건 «체결가»뿐이다.
   */
  fillPrice(ticker: string, signedNotional: number): number {
    const p0 = this.engine.priceOf(ticker);
    return Math.max(MIN_PRICE, p0 * (1 + this.priceImpactFrac(ticker, signedNotional)));
  }

  /**
   * 이 주문이 «체결가»를 미는 비율 (매수 +, 매도 −).
   *
   * ★★[2026-08-23 신설] `fillPrice` 가 «실제로 무는» 바로 그 값이다 — 같은 식을 두 번 쓰지 않는다.
   *
   * ⛔★왜 «화면에 주려고» 이걸 만들었나 — 실사고 기록:
   *   주문 시트가 이 식을 «자기 손으로 복제»하고 있었다(OrderSheet.tsx:53,66):
   *       depth = LIQUIDITY_DEPTH_BASE_USD * depthFactorForRank(rank)
   *   그런데 엔진은 지수(assetClass==='index')에 `LIQUIDITY_DEPTH_BASE_USD * INDEX_DEPTH_MULT(4)`
   *   를 쓴다(data.ts:61). 화면은 `assetClass` 를 «모르니» 지수를 rank 로만 봐서 0.25배로 셌다.
   *   ⇒ ★SPX·NDX 에서 «16배» 갈렸다. [실측 · scripts/bench/run.mjs depthaudit · 전수 1,000종목]
   *     · 최대 주문금액: 화면 $181,250  vs  엔진 $2,900,000
   *       ⇒ 유저가 현금을 «들고도» 주문이 막혔다. ★에러 메시지조차 없다(조용한 실패)
   *     · 표시 임팩트: 2.500%  vs  엔진 실제 0.156%  ⇒ 16배 «과장»
   *   ⇒ 고침의 핵심은 「화면에 assetClass 를 넘겨 분기시키기」가 «아니다».
   *     ★**깊이를 아는 건 엔진뿐이어야 한다.** 그래야 자산군이 하나 더 늘어도 안 갈린다.
   *     ⇒ 화면에서 공식을 «지우고» 이 함수를 부르게 했다.
   * ⛔이 함수를 화면이 다시 흉내내지 마라. 그게 이 사고의 원인이었다.
   */
  /**
   * ★«여러 다리»에 «같은 명목»이 동시에 걸리는 주문(스왑)의 상한.
   *
   * ⛔왜 화면이 아니라 «여기»에 있나 (2026-08-23):
   *   깊이 공식을 아는 것은 엔진뿐이다. 화면이 다시 세면 조용히 갈린다(위 사고 기록 참조).
   *   ⇒ 규칙이 있는 자리(여기)에서 상한도 같이 낸다.
   * ★다리가 하나면 `maxOrderNotional` 과 «같은 값»이다.
   *
   * ⚠[2026-09-05] 이 값은 더 이상 «파생 주문을 거절하는» 기준이 아니다.
   *   President 지시로 파생 5경로(레버리지·옵션 매수/매도·선도·스왑)의 `assertOrderSize` 를
   *   전부 제거했다. 남은 소비처는 «사이징 힌트»다 — 봇(`bots.ts`)·중앙은행(`centralBank.ts`)·
   *   `concepts.ts`·`copyPortfolio.ts`가 주문 크기를 정하는 데 쓰고, 현물(`placeSpotOrder`)만
   *   여전히 «거절»에 쓴다. ⛔이 두 함수를 지우거나 Infinity 로 만들면 봇이 폭주한다.
   */
  maxOrderNotionalAll(tickers: readonly string[]): number {
    let m = Infinity;
    for (const t of tickers) m = Math.min(m, this.maxOrderNotional(t));
    return Number.isFinite(m) ? m : 0;
  }

  priceImpactFrac(ticker: string, signedNotional: number): number {
    const inst = this.instrumentOf(ticker);
    return ORDER_FLOW_WEIGHT * clip(signedNotional / inst.liquidityDepth, -1, 1);
  }

  /*
   * ⛔[2026-09-05 President 결정] `assertOrderSize()` 를 «함수째» 제거했다.
   *   호출처가 0 이 된 상태로 남겨두면 그게 곧 죽은 코드이고, 다음 사람이
   *   「어딘가에서 상한이 걸리는 모양이다」로 오독한다.
   *   ★같이 죽은 것: GameError 코드 `ORDER_TOO_LARGE` 는 이제 «엔진 어디에서도 던지지 않는다».
   *     i18n 문구(common.err.ORDER_TOO_LARGE / 「나눠서 주문해주세요」)는 남겨 뒀다 —
   *     지우는 것은 이득이 없고, 되살릴 때 문구부터 다시 만드는 비용이 더 크다.
   *   ⛔`maxOrderNotional()`·`maxOrderNotionalAll()` 은 «지우지 않았다» — 봇·중앙은행·
   *     concepts 가 «사이징 힌트»로 쓴다. 무한으로 만들면 봇이 폭주한다.
   */

  // ── 평가 ──────────────────────────────────────────────────────────────
  holdingsValue(acc: Account): number {
    let v = 0;
    for (const [t, h] of acc.holdings) v += h.qty * this.engine.priceOf(t);
    return v;
  }

  levPositionEquity(pos: LeveragePosition): number {
    const p = this.engine.priceOf(pos.ticker);
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (p - pos.entryPrice) * pos.qty * dir;
    return pos.margin + pnl - this.accruedFunding(pos);
  }

  accruedFunding(pos: LeveragePosition): number {
    const gameDaysHeld = (this.tick - pos.openedTick) / TICKS_PER_GAME_DAY;
    return pos.notional * FUNDING_BP_PER_GAME_DAY * BP * gameDaysHeld;
  }

  maintenanceMargin(pos: LeveragePosition): number {
    return this.maintenanceBasis === 'entry_notional'
      ? MAINTENANCE_MARGIN_RATIO * pos.notional
      : MAINTENANCE_MARGIN_RATIO * pos.margin;
  }

  /**
   * ★만기 전 «확정된» 배당락을 미리 반영한 **실효 기초자산가**.
   *
   * ⛔★이 함수를 «거치지 않고» 옵션·선도 가격을 매기면 배당락 착취가 즉시 부활한다.
   *   [실측 2026-08-22] 반영 전 풋 ATM x20000 왕복 12사이클 **+12.54%**(규모에 선형).
   * ★배당이 없거나 `tickerMeta` 가 비면 **정확히 1** 을 돌려준다 ⇒ 기존 동작 무변경.
   * ★`(1 − rate)^횟수` 로 «엔진이 실제로 적용하는 식»과 같게 센다 — 연속 근사를 쓰지 마라.
   */
  divFactor(ticker: string, gameDays: number): number {
    if (this.tickerMeta.size === 0) return 1;
    const m = this.tickerMeta.get(ticker);
    if (!m) return 1;
    const to = this.tick + Math.round(gameDays * TICKS_PER_GAME_DAY);
    return exDivFactor(ticker, m.sectorKo, m.assetClass, this.tick, to);
  }

  /** 옵션 «현재 프리미엄 평가액» (부호 없음) */
  optionMarkValue(pos: OptionPosition): number {
    const S = this.engine.priceOf(pos.ticker);
    const remainDays = Math.max(0, (pos.expiryTick - this.tick) / TICKS_PER_GAME_DAY);
    /* ★평가에도 «같은» 선도가를 쓴다. 개시 때만 반영하고 평가에서 빼면
       보유 중에 평가액이 튀어 그 자체가 새 차익 경로가 된다.
       ★[2026-09-05] `divFactor`(배당만) → `forwardPrice`(배당 + 시장캐리 + 이벤트).
       ⛔divFactor 로 되돌리지 마라 — 선도와 옵션의 선도가가 다시 갈린다. */
    const Sd = this.forwardPrice(pos.ticker, S, remainDays);
    /* ★[2026-09-05] sigma 는 «실현변동성 EWMA»다(engine.sigmaOf). ⛔inst.sigma 로 되돌리지 마라 —
       그건 GBM 입력값이라 엔진이 실제로 만드는 변동성의 약 2배(지수는 약 6배)다. */
    /* ★계약 크기는 «포지션에 찍힌 값»이다 — 종목 규칙이 바뀌어도 옛 포지션은 안 흔들린다 */
    return (
      optionPremium(pos.kind, Sd, pos.strike, this.engine.sigmaOf(pos.ticker), remainDays) *
      pos.contracts *
      this.posShares(pos)
    );
  }

  /**
   * 자산에 더할 «옵션 포지션 가치».
   * ★매수: 프리미엄 평가액 그대로.
   * ★매도(숏): 예치증거금 − 되사야 할 값. 수취 프리미엄은 «개시 때 이미 현금»에 들어갔다.
   * ★side 가 undefined 면 'buy' 로 읽는다 — 기존 저장본 호환(SAVE_VERSION 무변경).
   */
  optionValue(pos: OptionPosition): number {
    const mark = this.optionMarkValue(pos);
    if (pos.side === 'sell') return (pos.margin ?? 0) - mark;
    return mark;
  }

  equity(acc: Account): number {
    let v = acc.cash + this.holdingsValue(acc);
    for (const pos of acc.levPositions.values()) v += Math.max(0, this.levPositionEquity(pos));
    for (const pos of acc.optPositions.values()) v += this.optionValue(pos);
    for (const pos of acc.fwdPositions.values()) v += Math.max(0, this.forwardEquity(pos));
    for (const pos of acc.swapPositions.values()) v += Math.max(0, this.swapEquity(pos));
    return v;
  }

  /* ══════════════════════════════════════════════════════════════════════
     대출 (2026-09-05 President 지시) — ⛔봇은 대출하지 않는다
     ══════════════════════════════════════════════════════════════════════ */

  /** 지금 기준(정책)금리. 중앙은행 정례 회합이 정한다(macro.updatePolicyRate) */
  get policyRate(): number {
    return this.macro.policyRate;
  }

  /** 대출 잔액 = 남은 원금 + 못 낸 이자 */
  loanDebt(acc: Account): number {
    let d = 0;
    for (const l of acc.loans.values()) d += l.principal + l.accruedInterest;
    return d;
  }

  /**
   * ★«마이너스 계좌» 잔액(양수로 돌려준다). 0 = 정상.
   * ★★잔액은 «현금이 음수인 것» 그 자체다 — 별도 장부를 두지 않는다(types.ts Account.overdraft 주석).
   */
  overdraftBalance(acc: Account): number {
    return Math.max(0, -acc.cash);
  }

  /** 지금 마이너스 계좌에 붙는 연이자율(변동). 마이너스가 아니면 0 */
  overdraftRate(acc: Account): number {
    if (!acc.overdraft) return 0;
    return this.policyRate + acc.overdraft.spreadBp * BP;
  }

  /**
   * ★현금이 «음수»면 새 돈 나가는 행위를 막는다 (President 지시:
   *   「cash<0 이면 신규 매수·파생 개설·신규 대출 불가. 매도·상환·충전은 가능」).
   * ⛔봇에는 걸지 «않는다» — 봇은 대출을 하지 않으므로 음수가 될 수 없고,
   *   혹시라도 펀딩비로 음수가 된 봇을 여기서 멈추면 시장 조성이 죽는다(밸런스 회귀).
   */
  private assertNotOverdrawn(acc: Account): void {
    if (!acc.isBot && acc.cash < 0)
      throw new GameError('OVERDRAWN', `overdraft ${this.overdraftBalance(acc).toFixed(2)} must be repaid first`);
  }

  /**
   * ★★«순자산» = 총자산 − 대출 잔액. 이 게임의 «진짜 내 돈»이다.
   *
   * ★★왜 도입했나 (President 지시 원문):
   *   「프로모션 10만 달러, 100만 달러 요건들은 순자산 기준으로 해서
   *     대출로 바로 프로모션을 달성하는 일을 방지해.」
   * ★대출 «직후»에는 이 값이 변하지 않는다 — 현금이 늘고 부채가 «같은 만큼» 늘기 때문이다.
   *   그게 이 정의의 존재 이유이고, `check_loans.mjs` 가 그것을 수치로 지킨다.
   * ★소비처(전수): 파산 판정 · 리더보드 정렬 · 프로모션(cash100k·equity1m) · 신용점수 규모 가점.
   *   ⛔새 소비처를 만들 때 `equity()` 를 쓰지 마라 — 그 자리가 곧 「대출로 우회」 경로다.
   */
  netWorth(acc: Account): number {
    /*
     * ★★President 표현은 「equity − 대출잔액 − |마이너스잔액|」이다. 여기서는 «두 항»만 뺀다 —
     *   ⛔|마이너스잔액| 을 «또» 빼면 이중 차감이다: `equity()` 의 첫 항이 `acc.cash` 이고,
     *     마이너스 계좌란 바로 그 `cash` 가 음수인 상태다. 이미 들어가 있다.
     *   ⇒ 즉 이 식은 President 의 식과 «수치가 같다». 검산: cash=−8,000 · 주식 5,000 · 대출 0 이면
     *     equity = −3,000, netWorth = −3,000 = (0 + 5,000) − 0 − 8,000. ✔
     *   ★`check_loans.mjs` 가 이 등식을 매 시나리오에서 다시 검산한다.
     */
    return this.equity(acc) - this.loanDebt(acc);
  }

  /**
   * ★담보가치 — 담보대출이 잡는 자산. «현물 평가액 + 파생 포지션 평가액».
   *   ⛔현금은 담보가 «아니다» — 현금을 담보로 현금을 빌리는 것은 순환이고,
   *     빌린 돈이 그대로 담보가 되어 한도가 무한히 늘어난다.
   */
  collateralValue(acc: Account): number {
    let v = this.holdingsValue(acc);
    for (const pos of acc.levPositions.values()) v += Math.max(0, this.levPositionEquity(pos));
    for (const pos of acc.optPositions.values()) v += Math.max(0, this.optionValue(pos));
    for (const pos of acc.fwdPositions.values()) v += Math.max(0, this.forwardEquity(pos));
    for (const pos of acc.swapPositions.values()) v += Math.max(0, this.swapEquity(pos));
    return v;
  }

  /**
   * ★신용점수 — 게임 «안에서 측정 가능한» 4가지만 쓴다. 근거는 constants.CREDIT_SCORE_BASE 주석.
   * ⛔현실의 소득·직업 같은 항목을 흉내내지 마라. 이 게임에 없는 것을 지어내면 그건 난수다.
   */
  creditScore(acc: Account): number {
    let s = CREDIT_SCORE_BASE;
    s -= Math.min(CREDIT_PENALTY_LIQUIDATION_CAP, CREDIT_PENALTY_LIQUIDATION * acc.liquidationCount);
    s -= Math.min(CREDIT_PENALTY_DELINQUENCY_CAP, CREDIT_PENALTY_DELINQUENCY * (acc.delinquencyCount ?? 0));
    s -= Math.min(CREDIT_PENALTY_TOPUP_CAP, CREDIT_PENALTY_TOPUP * acc.topupCount);
    /* ★파산 이력 — 가장 무겁다. 1회로도 «등급 최하(D)»로 떨어뜨리는 크기다.
       ★President 결정에 따라 «대출 금지»가 아니라 «스프레드 최대»로 벌한다 —
         이 기능의 목적이 「유동성 공급」이라 길을 아주 막으면 목적과 어긋난다. */
    s -= Math.min(CREDIT_PENALTY_BANKRUPTCY_CAP, CREDIT_PENALTY_BANKRUPTCY * (acc.bankruptcyCount ?? 0));
    // 계좌 나이 — 플레이한 «게임일»이 20일이면 만점
    s += CREDIT_BONUS_AGE_MAX * clip(this.gameDay / CREDIT_BONUS_AGE_FULL_GAME_DAYS, 0, 1);
    /* 규모 — 순자산/시드 배수를 로그로 본다. 8배에서 만점.
       ⛔선형으로 하면 웨일급 자산이 점수를 천장까지 밀어 등급이 «자산 순위»가 된다. */
    const base = acc.seedCash > 0 ? acc.seedCash : SEED_CASH;
    const ratio = Math.max(0, this.netWorth(acc)) / base;
    s += CREDIT_BONUS_SIZE_MAX * clip(Math.log(Math.max(ratio, 1e-6)) / Math.log(8), 0, 1);
    return Math.round(clip(s, CREDIT_SCORE_MIN, CREDIT_SCORE_MAX));
  }

  creditGrade(acc: Account): CreditGrade {
    const s = this.creditScore(acc);
    for (const [g, cut] of CREDIT_GRADE_CUTS) if (s >= cut) return g;
    return 'D';
  }

  /**
   * ★대출 «조건 견적» — 화면과 엔진이 «같은 식»을 쓰게 하는 단 하나의 통로.
   *   ⛔화면이 한도·금리를 다시 계산하지 마라. 깊이 공식이 갈렸던 사고와 «같은 형태»가 된다.
   */
  loanTerms(accountId: string, kind: LoanKind) {
    const acc = this.getAccount(accountId);
    const score = this.creditScore(acc);
    const grade = this.creditGrade(acc);
    const spreadBp = LOAN_SPREAD_BP[grade][kind];
    const rate = this.policyRate + spreadBp * BP;
    const outstanding = this.loanDebt(acc);
    const collateral = this.collateralValue(acc);
    /* ★한도는 «총 한도»다 — 이미 빌린 것을 뺀 값이 «더 빌릴 수 있는 돈»이다.
       ⛔건별 한도로 하면 여러 건으로 쪼개서 무한히 빌릴 수 있다. */
    const limit =
      kind === 'secured'
        ? collateral * LOAN_LTV_MAX
        : Math.max(0, this.netWorth(acc)) * LOAN_UNSECURED_MULT[grade];
    const available = Math.max(0, limit - outstanding);
    return {
      kind,
      score,
      grade,
      policyRate: this.policyRate,
      spreadBp,
      /** 실효 연이자율(변동). 기준금리가 바뀌면 이 값도 바뀐다 */
      rate,
      limit,
      outstanding,
      available,
      collateral,
      netWorth: this.netWorth(acc),
      ltv: collateral > 0 ? outstanding / collateral : 0,
      /** 하루(게임일)당 이자 — 「얼마 나가나」를 화면이 계산하지 않게 */
      dailyInterestPerDollar: rate / TRADING_DAYS_PER_YEAR,
    };
  }

  /**
   * 대출 실행. 현금이 «늘고» 부채가 «같은 만큼» 는다 ⇒ ★순자산 불변.
   * ⛔수수료를 붙이지 마라 — 붙이면 대출 순간 순자산이 줄어 「빌리면 손해」가 된다.
   *   비용은 «이자»로만 받는다(President: 「금리로 건전성을 잡아」).
   */
  openLoan(accountId: string, kind: LoanKind, amount: number, termGameDays = LOAN_TERM_DEFAULT) {
    const acc = this.getAccount(accountId);
    /* ★연체 중에는 새 대출이 «없다» (President: 「cash<0 이면 신규 대출 불가」) */
    this.assertNotOverdrawn(acc);
    if (!Number.isFinite(amount) || amount < LOAN_MIN_PRINCIPAL)
      throw new GameError('LOAN_TOO_SMALL', `min ${LOAN_MIN_PRINCIPAL}`);
    if (!(LOAN_TERM_CHOICES as readonly number[]).includes(termGameDays))
      throw new GameError('BAD_TERM', `term must be one of ${LOAN_TERM_CHOICES.join(',')}`);
    const t = this.loanTerms(accountId, kind);
    if (amount > t.available + 1e-9)
      throw new GameError('LOAN_OVER_LIMIT', `available ${t.available.toFixed(2)}, want ${amount.toFixed(2)}`);
    const loan: Loan = {
      id: nextId('loan'),
      kind,
      principal: amount,
      accruedInterest: 0,
      spreadBp: t.spreadBp,
      grade: t.grade,
      openedTick: this.tick,
      maturityTick: this.tick + Math.round(termGameDays * TICKS_PER_GAME_DAY),
      lastAccrualDay: this.gameDay,
      delinquentDays: 0,
      marginCallDay: -1,
      interestPaid: 0,
    };
    acc.loans.set(loan.id, loan);
    acc.cash += amount;
    this.emit({
      type: 'loan_opened',
      accountId: acc.id,
      nickname: acc.nickname,
      isBot: acc.isBot,
      loanId: loan.id,
      loanKind: kind,
      amount,
      rate: t.rate,
      grade: t.grade,
      tick: this.tick,
    });
    return { ok: true as const, loan, rate: t.rate, cashAfter: acc.cash };
  }

  /**
   * 상환. ★이자 «먼저», 그 다음 원금 — 실무 순서이고, 반대로 하면 연체가 안 풀린다.
   * ★★중도상환 수수료 «0» (President 명시). `LOAN_PREPAYMENT_FEE_BP` 는 0 으로 «남겨 뒀다» —
   *   상수가 있어야 나중에 슬그머니 붙지 않는다.
   */
  repayLoan(accountId: string, loanId: string, amount: number) {
    const acc = this.getAccount(accountId);
    const loan = acc.loans.get(loanId);
    if (!loan) throw new GameError('NO_LOAN', `unknown loan ${loanId}`);
    if (!Number.isFinite(amount) || amount <= 0) throw new GameError('BAD_AMOUNT', 'amount must be > 0');
    const owed = loan.principal + loan.accruedInterest;
    const pay = Math.min(amount, owed, acc.cash);
    if (pay <= 0) throw new GameError('INSUFFICIENT_CASH', `need ${Math.min(amount, owed).toFixed(2)}, have ${acc.cash.toFixed(2)}`);
    const fee = pay * LOAN_PREPAYMENT_FEE_BP * BP; // ★항상 0. 식을 남겨 「0 이라는 결정」을 보이게 한다
    acc.cash -= pay + fee;
    const toInterest = Math.min(pay, loan.accruedInterest);
    loan.accruedInterest -= toInterest;
    loan.principal -= pay - toInterest;
    loan.interestPaid += toInterest;
    if (loan.accruedInterest <= 1e-9) loan.delinquentDays = 0;
    const closed = loan.principal <= 1e-9 && loan.accruedInterest <= 1e-9;
    if (closed) acc.loans.delete(loan.id);
    this.emit({
      type: 'loan_repaid',
      accountId: acc.id,
      nickname: acc.nickname,
      isBot: acc.isBot,
      loanId: loan.id,
      amount: pay,
      closed,
      tick: this.tick,
    });
    return { ok: true as const, paid: pay, fee, closed, remaining: closed ? 0 : loan.principal + loan.accruedInterest, cashAfter: acc.cash };
  }

  /**
   * ★이자 정산 — «게임일 단위». ⛔매 틱 누적하지 마라(부동소수 오차 + 성능).
   *   각 대출이 `lastAccrualDay` 를 들고 있어 며칠이 밀려도 «밀린 날 수만큼» 한 번에 센다
   *   (백그라운드 복귀 catchup 에서도 값이 맞는다).
   * ★변동금리: 금리를 매 정산 시점에 «다시 조회»한다 — 기준금리가 바뀌면 그 다음 이자부터 반영된다.
   * ★현금이 모자라면 «미납 이자»로 쌓이고 연체일이 는다. 연체 중에는 가산금리가 더 붙는다.
   */
  accrueLoans(): number {
    let charged = 0;
    for (const acc of this.accounts.values()) {
      if (acc.loans.size === 0) continue;
      for (const loan of [...acc.loans.values()]) {
        const days = this.gameDay - loan.lastAccrualDay;
        if (days <= 0) continue;
        loan.lastAccrualDay = this.gameDay;
        const penaltyBp = loan.delinquentDays > 0 ? LOAN_DELINQUENT_PENALTY_BP : 0;
        const rate = this.policyRate + (loan.spreadBp + penaltyBp) * BP;
        const interest = loan.principal * (rate / TRADING_DAYS_PER_YEAR) * days;
        if (interest <= 0) continue;
        charged += interest;
        if (acc.cash >= interest) {
          acc.cash -= interest;
          loan.interestPaid += interest;
          loan.delinquentDays = 0;
        } else {
          /* ★현금이 있는 만큼은 낸다 — 「전부 아니면 전무」로 하면 $1 부족에 전액 연체가 된다 */
          const part = Math.max(0, acc.cash);
          acc.cash -= part;
          loan.interestPaid += part;
          loan.accruedInterest += interest - part;
          const was = loan.delinquentDays;
          loan.delinquentDays += days;
          /* ★연체 «이력»은 문턱을 처음 넘을 때 딱 한 번 박는다. 매일 박으면 며칠 만에 D 등급이 된다 */
          if (was < LOAN_DELINQUENT_MARK_DAYS && loan.delinquentDays >= LOAN_DELINQUENT_MARK_DAYS) {
            acc.delinquencyCount = (acc.delinquencyCount ?? 0) + 1;
            this.emit({
              type: 'loan_delinquent',
              accountId: acc.id,
              nickname: acc.nickname,
              isBot: acc.isBot,
              loanId: loan.id,
              days: loan.delinquentDays,
              tick: this.tick,
            });
          }
        }
      }
    }
    return charged;
  }

  /**
   * ★건전성 점검 — 마진콜 · 연체 디폴트 → 강제청산.
   *   ⛔레버리지 청산과 «같은 문법»을 쓴다: 문턱을 넘으면 시장가로 정리하고 이벤트를 흘린다.
   * ★담보대출만 마진콜이 있다(신용대출은 담보가 없으니 LTV 개념이 없다).
   *   신용대출의 제동은 «연체 → 가산금리 → 디폴트 청산»이다(President: 「금리로 건전성을」).
   */
  checkLoanHealth(): number {
    let liquidated = 0;
    for (const acc of this.accounts.values()) {
      if (acc.loans.size === 0) continue;
      const collateral = this.collateralValue(acc);
      for (const loan of [...acc.loans.values()]) {
        const owed = loan.principal + loan.accruedInterest;
        if (owed <= 1e-9) continue;
        let mustLiquidate = false;
        let reason: 'margin_call' | 'default' = 'margin_call';

        if (loan.kind === 'secured') {
          const ltv = collateral > 0 ? owed / collateral : Infinity;
          if (ltv > LOAN_MARGIN_CALL_LTV) {
            if (loan.marginCallDay < 0) {
              loan.marginCallDay = this.gameDay;
              this.emit({
                type: 'loan_margin_call',
                accountId: acc.id,
                nickname: acc.nickname,
                isBot: acc.isBot,
                loanId: loan.id,
                ltv,
                tick: this.tick,
              });
            } else if (this.gameDay - loan.marginCallDay >= LOAN_GRACE_GAME_DAYS) {
              mustLiquidate = true;
            }
          } else if (loan.marginCallDay >= 0) {
            loan.marginCallDay = -1; // 해소됐다
          }
        }
        if (!mustLiquidate && loan.delinquentDays >= LOAN_DEFAULT_DAYS) {
          mustLiquidate = true;
          reason = 'default';
        }
        if (mustLiquidate) {
          this.liquidateForLoan(acc, loan, reason);
          liquidated++;
        }
      }
    }
    return liquidated;
  }

  /**
   * ★★만기 처리 — President 지시(2026-09-05) 5단계를 «이 순서 그대로» 집행한다.
   *   ⛔순서를 바꾸지 마라. 순서가 곧 규칙이고, 검증기가 이 순서를 검산한다.
   *
   *   ① 만기 도달 → 현금에서 원리금 «자동 상환». 충분하면 여기서 끝(대출 소멸).
   *   ② 현금 부족 + 담보대출 → 부족분만큼 «담보 반대매매»(평가액 큰 종목부터).
   *      ★매도는 `placeSpotOrder` 를 그대로 탄다 — 임팩트·수수료가 정상적으로 붙는다.
   *      ⛔전용 특가 매도 경로를 만들지 마라. 그건 시장을 안 거치는 새 차익 경로다.
   *   ③ 그래도 부족(또는 신용대출) → 남은 원리금을 «현금에서 차감»해 마이너스 계좌로.
   *      대출 포지션은 소멸하고 부채는 «연체 잔액(= 음수 현금)»으로 전환된다.
   *   ④ 마이너스에는 연체금리가 «게임일 단위로 복리» 붙는다(accrueOverdraft).
   *   ⑤ 이후 모든 현금 유입이 «우선 상환»된다 — 별도 코드가 없다. cash 가 하나뿐이라 자동이다.
   */
  settleMaturedLoans(): number {
    let n = 0;
    for (const acc of this.accounts.values()) {
      if (acc.loans.size === 0) continue;
      for (const loan of [...acc.loans.values()]) {
        if (loan.maturityTick === undefined || this.tick < loan.maturityTick) continue;
        const owed0 = loan.principal + loan.accruedInterest;
        /* ① 현금 자동 상환 */
        this.applyLoanPayment(acc, loan, acc.cash);
        let soldNotional = 0;
        /* ② 담보 반대매매 — 담보대출만. 신용대출은 담보가 «없다»(무담보의 정의) */
        if (loan.principal + loan.accruedInterest > 1e-9 && loan.kind === 'secured') {
          soldNotional = this.sellCollateralFor(acc, loan);
        }
        /* ③ 남은 원리금 → 마이너스 계좌 */
        const shortfall = Math.max(0, loan.principal + loan.accruedInterest);
        if (shortfall > 1e-9) this.enterOverdraft(acc, shortfall, loan);
        acc.loans.delete(loan.id);
        n++;
        this.emit({
          type: 'loan_matured',
          accountId: acc.id,
          nickname: acc.nickname,
          isBot: acc.isBot,
          loanId: loan.id,
          owed: owed0,
          soldNotional,
          shortfall,
          tick: this.tick,
        });
      }
    }
    return n;
  }

  /** 현금에서 `budget` 만큼 이자→원금 순으로 갚는다. ★현금이 음수면 아무것도 안 한다 */
  private applyLoanPayment(acc: Account, loan: Loan, budget: number): number {
    const owed = loan.principal + loan.accruedInterest;
    const pay = Math.min(Math.max(0, budget), owed);
    if (pay <= 0) return 0;
    acc.cash -= pay;
    const toInterest = Math.min(pay, loan.accruedInterest);
    loan.accruedInterest -= toInterest;
    loan.principal -= pay - toInterest;
    loan.interestPaid += toInterest;
    return pay;
  }

  /**
   * ★담보 반대매매 — «부족분만큼만» 판다. 잔여 담보는 보존된다(President 명시).
   * ★+2% 여유를 두고 판다: 체결 임팩트와 수수료로 손에 들어오는 돈이 명목보다 적기 때문이다.
   *   ⛔여유 없이 팔면 한 번에 못 갚고 다음 종목까지 번져 «필요 이상»으로 팔린다.
   * @returns 매도한 «명목» 합계
   */
  private sellCollateralFor(acc: Account, loan: Loan): number {
    let sold = 0;
    const rows = [...acc.holdings.entries()]
      .map(([t, h]) => ({ t, v: h.qty * this.engine.priceOf(t) }))
      .sort((a, b) => b.v - a.v);
    for (const r of rows) {
      const need = loan.principal + loan.accruedInterest;
      if (need <= 1e-9) break;
      const h = acc.holdings.get(r.t);
      if (!h || h.qty <= 0) continue;
      const px = this.engine.priceOf(r.t);
      const want = Math.min(h.qty, (need * 1.02) / Math.max(px, MIN_PRICE));
      if (want <= 0) continue;
      const before = acc.cash;
      try {
        this.placeSpotOrder(acc.id, r.t, 'sell', want);
      } catch {
        continue; // 개별 종목 실패는 넘어간다
      }
      sold += Math.max(0, acc.cash - before);
      this.applyLoanPayment(acc, loan, acc.cash);
    }
    return sold;
  }

  /**
   * ★마이너스 계좌 «진입» — 남은 원리금을 현금에서 차감한다(현금이 음수가 된다).
   * ★가산금리는 «그때의 신용등급 기준 무담보 스프레드 + 연체 가산»으로 고정한다.
   *   ⛔담보대출이었어도 무담보 스프레드를 쓴다 — 담보는 이미 팔려서 «없다».
   * ★연체 «이력»을 여기서 한 번 박는다(신용점수 감점). 상환해도 사라지지 않는다.
   */
  private enterOverdraft(acc: Account, amount: number, loan: Loan | null): void {
    acc.cash -= amount;
    if (!acc.overdraft) {
      const grade = this.creditGrade(acc);
      acc.overdraft = {
        spreadBp: LOAN_SPREAD_BP[grade].unsecured + LOAN_OVERDRAFT_PENALTY_BP,
        sinceDay: this.gameDay,
        lastAccrualDay: this.gameDay,
      };
      acc.delinquencyCount = (acc.delinquencyCount ?? 0) + 1;
      this.emit({
        type: 'overdraft_entered',
        accountId: acc.id,
        nickname: acc.nickname,
        isBot: acc.isBot,
        loanId: loan?.id ?? null,
        amount,
        rate: this.overdraftRate(acc),
        tick: this.tick,
      });
    }
  }

  /**
   * ★마이너스 계좌 이자 — «게임일 단위 복리». 이자가 원금(=음수 현금)에 합산돼 더 음수가 된다.
   *   ⛔매 틱 붙이지 마라(부동소수 누적). ⛔단리로 하지 마라 — President 「계속 붙여」의 뜻이 복리다.
   * ★변동금리 규칙 그대로: 정책금리가 바뀌면 그 다음 정산부터 반영된다.
   */
  accrueOverdraft(): number {
    let charged = 0;
    for (const acc of this.accounts.values()) {
      if (!acc.overdraft) continue;
      /* ★0 이상으로 돌아왔으면 «연체 해소». 이력(delinquencyCount)은 남는다 */
      if (acc.cash >= 0) {
        acc.overdraft = null;
        this.emit({
          type: 'overdraft_cleared',
          accountId: acc.id,
          nickname: acc.nickname,
          isBot: acc.isBot,
          tick: this.tick,
        });
        continue;
      }
      const days = this.gameDay - acc.overdraft.lastAccrualDay;
      if (days <= 0) continue;
      acc.overdraft.lastAccrualDay = this.gameDay;
      const rate = this.overdraftRate(acc);
      /* 복리: 잔액 × (1 + 일이자)^days − 잔액 */
      const bal = this.overdraftBalance(acc);
      const grown = bal * Math.pow(1 + rate / TRADING_DAYS_PER_YEAR, days);
      const interest = grown - bal;
      if (!(interest > 0)) continue;
      acc.cash -= interest;
      charged += interest;
    }
    return charged;
  }

  /**
   * ★강제청산 — «갚을 수 있을 만큼만» 판다. 전량 청산이 아니다.
   *   순서: ①현금 ②현물(평가액 큰 것부터) ③파생 포지션. 갚고 남는 건 계좌에 남긴다.
   * ⛔전량 청산으로 만들지 마라 — 이자 몇 달러 때문에 포트폴리오 전체가 날아가면
   *   그건 건전성 장치가 아니라 사고다.
   */
  private liquidateForLoan(acc: Account, loan: Loan, reason: 'margin_call' | 'default'): void {
    const need = () => loan.principal + loan.accruedInterest;
    const payFromCash = () => {
      const pay = Math.min(acc.cash, need());
      if (pay <= 0) return;
      acc.cash -= pay;
      const toInterest = Math.min(pay, loan.accruedInterest);
      loan.accruedInterest -= toInterest;
      loan.principal -= pay - toInterest;
      loan.interestPaid += toInterest;
    };
    payFromCash();
    if (need() > 1e-9) {
      const rows = [...acc.holdings.entries()]
        .map(([t, h]) => ({ t, v: h.qty * this.engine.priceOf(t) }))
        .sort((a, b) => b.v - a.v);
      for (const r of rows) {
        if (need() <= 1e-9) break;
        const h = acc.holdings.get(r.t);
        if (!h || h.qty <= 0) continue;
        /* 필요한 만큼만 판다(+2% 여유 — 임팩트·수수료로 손에 덜 들어온다) */
        const px = this.engine.priceOf(r.t);
        const want = Math.min(h.qty, (need() * 1.02) / Math.max(px, MIN_PRICE));
        if (want <= 0) continue;
        try {
          this.placeSpotOrder(acc.id, r.t, 'sell', want);
        } catch {
          /* 개별 종목 실패는 삼킨다 — 다음 종목으로 간다 */
        }
        payFromCash();
      }
    }
    if (need() > 1e-9) {
      for (const pos of [...acc.levPositions.values()]) {
        if (need() <= 1e-9) break;
        try {
          this.closeLeverage(acc.id, pos.id, true);
        } catch {
          /* 무시 */
        }
        payFromCash();
      }
    }
    const shortfall = Math.max(0, need());
    if (shortfall <= 1e-9) acc.loans.delete(loan.id);
    else {
      /* ★다 팔아도 모자라면 «부채가 남는다». 지우지 마라 — 지우면 「빌리고 안 갚기」가 이득이 된다.
         순자산이 음수가 되고 파산 판정에 걸린다. */
      loan.delinquentDays = Math.max(loan.delinquentDays, LOAN_DEFAULT_DAYS);
      loan.marginCallDay = this.gameDay;
    }
    acc.liquidationCount++;
    this.stats.liquidations++;
    this.emit({
      type: 'loan_liquidated',
      accountId: acc.id,
      nickname: acc.nickname,
      isBot: acc.isBot,
      loanId: loan.id,
      reason,
      shortfall,
      tick: this.tick,
    });
  }

  /**
   * ★파산 판정 «A 경로» — 순자산이 파산선 아래. 무료 충전 구제의 조건이다(현행 동작).
   * ⛔`equity()` 로 되돌리지 마라: 대출로 현금을 채우면 총자산은 그대로인데
   *   부채만 늘어난 상태를 「파산이 아니다」로 읽게 된다.
   * ★대출이 0 이면 순자산 = 총자산이므로 ★기존 유저 판정이 비트 단위로 동일하다.
   */
  isBankrupt(acc: Account): boolean {
    return this.netWorth(acc) < BANKRUPT_EQUITY_THRESHOLD;
  }

  /**
   * ★★파산 판정 «B 경로»(연체 파산) — President 2026-09-05:
   *   「연체이면서 총자산 평가액도 (-)면 파산처리하고 자산 청산하라는 거야.
   *     단순 연체로 파산 처리는 하지 마.」
   *
   * ★「총자산 평가액 (-)」의 구현 해석: ★«순자산 < 0» 이다.
   *   = 총자산 − 대출잔액 − |연체잔액| < 0 = 가진 것을 다 팔아도 빚을 못 갚는 상태.
   *   (netWorth() 가 이미 그 값이다 — 마이너스 현금이 equity 안에 들어 있다)
   * ★두 조건은 «AND» 다. cash<0 이어도 순자산이 +면 파산이 아니다 — 연체 유지·연체금리·
   *   무료충전 차단만 걸린다. 그게 지시의 「단순 연체로 파산 처리는 하지 마」다.
   */
  isOverdraftBankrupt(acc: Account): boolean {
    return acc.cash < 0 && this.netWorth(acc) < 0;
  }

  /**
   * ★B 경로 집행 — 전량 청산 → 연체 상환 → 남은 빚 «탕감»(write-off) → 계좌 리셋.
   *
   * ★청산은 «기존 경로»를 그대로 탄다: 현물은 `placeSpotOrder`(임팩트·수수료 포함),
   *   파생은 각 상품의 forced 청산. ⛔전용 청산가를 만들면 그게 새 차익 경로다.
   * ★남은 연체는 «탕감»한다(President 「채무 소멸 — 계좌 리셋」).
   *   ⛔그 대신 신용 이력에 «영구» 기록이 남는다 — 안 그러면 「빌리고 파산하기」가 최적 전략이 된다.
   * ★파산 «뒤»에는 연체가 없으므로 무료 충전이 다시 열린다(A 경로와 같은 취급).
   */
  private declareOverdraftBankruptcy(acc: Account): void {
    const before = { cash: acc.cash, netWorth: this.netWorth(acc) };
    /* ① 현물 전량 매도 — 평가액 큰 것부터(임팩트를 작은 종목에 몰지 않는다) */
    const rows = [...acc.holdings.entries()]
      .map(([t, h]) => ({ t, qty: h.qty, v: h.qty * this.engine.priceOf(t) }))
      .sort((a, b) => b.v - a.v);
    for (const r of rows) {
      if (r.qty <= 0) continue;
      try {
        this.placeSpotOrder(acc.id, r.t, 'sell', r.qty);
      } catch {
        /* 개별 실패는 넘어간다 — 다음 종목으로 */
      }
    }
    /* ① 파생 전량 강제 청산 */
    for (const p of [...acc.levPositions.values()]) {
      try {
        this.closeLeverage(acc.id, p.id, true);
      } catch {
        /* 무시 */
      }
    }
    for (const p of [...acc.optPositions.values()]) {
      try {
        if (p.side === 'sell') this.buybackOption(acc.id, p.id, true);
        else acc.cash += this.optionMarkValue(p);
      } catch {
        /* 무시 */
      }
      acc.optPositions.delete(p.id);
    }
    for (const p of [...acc.fwdPositions.values()]) {
      try {
        this.closeForward(acc.id, p.id, true);
      } catch {
        acc.fwdPositions.delete(p.id);
      }
    }
    for (const p of [...acc.swapPositions.values()]) {
      try {
        this.closeSwap(acc.id, p.id, true);
      } catch {
        acc.swapPositions.delete(p.id);
      }
    }
    /* ② 남은 대출도 회수 현금으로 갚는다 */
    for (const loan of [...acc.loans.values()]) {
      this.applyLoanPayment(acc, loan, acc.cash);
      acc.loans.delete(loan.id);
    }
    /* ③ 남은 연체는 «탕감» — 계좌 리셋 */
    const writeOff = Math.max(0, -acc.cash);
    acc.cash = 0;
    acc.holdings.clear();
    acc.levPositions.clear();
    acc.optPositions.clear();
    acc.fwdPositions.clear();
    acc.swapPositions.clear();
    acc.loans.clear();
    acc.overdraft = null;
    acc.bankruptcyCount = (acc.bankruptcyCount ?? 0) + 1;
    acc.liquidationCount++;
    this.stats.liquidations++;
    this.trackPositions(acc);
    this.emit({
      type: 'overdraft_bankrupt',
      accountId: acc.id,
      nickname: acc.nickname,
      isBot: acc.isBot,
      /** 탕감된 채무 — 0 이면 팔아서 다 갚은 것이다 */
      writeOff,
      cashBefore: before.cash,
      netWorthBefore: before.netWorth,
      tick: this.tick,
    });
  }

  /** 게임일마다 B 경로 파산을 «전 계정» 훑는다. 봇은 대출을 안 하므로 실질적으로 플레이어만 걸린다 */
  checkOverdraftBankruptcy(): number {
    let n = 0;
    for (const acc of this.accounts.values()) {
      if (!this.isOverdraftBankrupt(acc)) continue;
      this.declareOverdraftBankruptcy(acc);
      n++;
    }
    return n;
  }

  // ── 현물 주문 ─────────────────────────────────────────────────────────
  /**
   * 시장가 현물 체결. 체결가는 현재 틱 가격.
   * 가격 임팩트는 다음 틱에 netOrderFlow 를 통해 반영된다.
   */
  placeSpotOrder(accountId: string, ticker: string, side: Side, qty: number) {
    const acc = this.getAccount(accountId);
    this.instrumentOf(ticker);
    if (!Number.isFinite(qty) || qty <= 0) throw new GameError('BAD_QTY', 'qty must be > 0');
    // ★체결가에 «자기 임팩트»를 먼저 반영한다 (fillPrice 주석 참조)
    const gross0 = qty * this.engine.priceOf(ticker);
    const price = this.fillPrice(ticker, side === 'buy' ? gross0 : -gross0);
    const gross = qty * price;
    /*
     * ⛔[2026-09-05 President 결정] 「괜찮아. 캡 풀어.」 — 여기 있던 `this.assertOrderSize(ticker, gross)`
     *   를 «제거»했다. 파생 5경로에 이어 ★현물까지 유동성 상한이 사라졌다. 되살리지 마라.
     *
     * ★그럼 남는 브레이크는 무엇인가 — `fillPrice` 하나뿐이다. 그리고 그건 «작지 않다»:
     *   체결가 = P₀ × (1 + ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1))
     *   ⇒ 깊이만큼 사면 체결가가 ★+50% 다(클립 상한). 깊이의 5% 였던 옛 상한에서는 +2.5% 였다.
     *   ⇒ 즉 큰 주문은 «거절»되는 대신 «자기 체결가를 그만큼 물게» 된다. 왕복은 여전히 음수다
     *     (매수 P₀(1+i) → 매도 P₀(1+i)(1−i) = P₀(1−i²)).
     * ★President 는 이 숫자(+50% 임팩트 · 카피 비대칭)를 보고 감수하기로 했다.
     */
    const fee = gross * FEE_SPOT_BP * BP;

    if (side === 'buy') {
      /* ★연체 중(현금 음수)에는 신규 «매수»가 없다 (President 2026-09-05).
         ⛔매도는 막지 «않는다» — 파는 것이 연체를 갚는 유일한 길이다. */
      this.assertNotOverdrawn(acc);
      if (acc.cash < gross + fee)
        throw new GameError('INSUFFICIENT_CASH', `need ${(gross + fee).toFixed(2)}, have ${acc.cash.toFixed(2)}`);
      acc.cash -= gross + fee;
      const h = acc.holdings.get(ticker) ?? { qty: 0, avgCost: 0 };
      const newQty = h.qty + qty;
      h.avgCost = (h.avgCost * h.qty + gross + fee) / newQty;
      h.qty = newQty;
      acc.holdings.set(ticker, h);
      this.engine.addOrderFlow(ticker, gross);
    } else {
      const h = acc.holdings.get(ticker);
      if (!h || h.qty < qty - 1e-9) throw new GameError('INSUFFICIENT_QTY', `holding ${h?.qty ?? 0} < ${qty}`);
      acc.cash += gross - fee;
      acc.realizedPnl += (price - h.avgCost) * qty - fee;
      h.qty -= qty;
      if (h.qty <= 1e-9) acc.holdings.delete(ticker);
      this.engine.addOrderFlow(ticker, -gross);
    }
    acc.feesPaid += fee;
    acc.tradeCount++;
    this.stats.orders++;
    this.stats.feesCollected += fee;
    this.emit({
      type: 'trade',
      accountId: acc.id,
      nickname: acc.nickname,
      isBot: acc.isBot,
      ticker,
      side,
      qty,
      price,
      notional: gross,
      tick: this.tick,
    });
    return { ok: true as const, tick: this.tick, ticker, side, qty, price, gross, fee, cashAfter: acc.cash };
  }

  /**
   * 방금 낸 «현물» 주문 취소 — 되돌리기 전용(반대매매가 아니다).
   *
   * 옵션/레버리지와 달리 현물은 «평균단가»가 기존 보유분과 섞이기 때문에
   * 되돌릴 때 산술로 역산하면 부동소수 오차가 남는다. 그래서 주문 «직전»
   * 보유 스냅샷(prevQty/prevAvgCost)을 그대로 되돌려 놓는다.
   *
   * false 를 돌려주는 경우 = 되돌릴 수 없는 상태로 변한 것:
   *   · 보유수량이 그사이 줄었다(다른 매도가 끼어들었다)
   *   · 매수 취소인데 되돌릴 만큼의 수량이 남아 있지 않다
   * ★ orderFlow 는 되감지 않는다 — 이유는 cancelOption 주석 참조.
   */
  cancelSpot(
    accountId: string,
    snap: { ticker: string; side: Side; qty: number; gross: number; fee: number; prevQty: number; prevAvgCost: number }
  ): boolean {
    const acc = this.getAccount(accountId);
    const { ticker, side, qty, gross, fee, prevQty, prevAvgCost } = snap;
    const h = acc.holdings.get(ticker);

    if (side === 'buy') {
      if (!h || h.qty + 1e-9 < qty) return false;
      acc.cash += gross + fee;
    } else {
      const back = gross - fee;
      if (acc.cash + 1e-9 < back) return false; // 환급받은 돈을 이미 다 써버렸다
      acc.cash -= back;
      // 매도로 확정됐던 실현손익도 함께 되돌린다
      acc.realizedPnl -= (gross / qty - prevAvgCost) * qty - fee;
    }

    if (prevQty <= 1e-9) acc.holdings.delete(ticker);
    else acc.holdings.set(ticker, { qty: prevQty, avgCost: prevAvgCost });

    acc.feesPaid = Math.max(0, acc.feesPaid - fee);
    acc.tradeCount = Math.max(0, acc.tradeCount - 1);
    this.stats.feesCollected = Math.max(0, this.stats.feesCollected - fee);
    this.stats.orders = Math.max(0, this.stats.orders - 1);
    return true;
  }

  /** 금액 기준 시장가 주문 (notional USD) */
  placeSpotOrderByNotional(accountId: string, ticker: string, side: Side, notional: number) {
    // ★체결가(임팩트 반영분)로 수량을 잡는다. 기준가로 잡으면 체결 단계에서 금액이 불어나
    //   «현금 부족»으로 거절된다.
    const price = this.fillPrice(ticker, side === 'buy' ? notional : -notional);
    const qty = notional / price;
    return this.placeSpotOrder(accountId, ticker, side, qty);
  }

  // ── 레버리지 ──────────────────────────────────────────────────────────
  openLeverage(accountId: string, ticker: string, side: LevSide, leverage: number, margin: number) {
    const acc = this.getAccount(accountId);
    /* ★연체 중(현금 음수)에는 «신규 파생 개시»가 없다 (President 2026-09-05).
       ⛔청산·정산은 막지 않는다 — 그게 연체를 갚는 길이다. */
    this.assertNotOverdrawn(acc);
    this.instrumentOf(ticker);
    if (!this.allowedLeverage.includes(leverage))
      throw new GameError('BAD_LEVERAGE', `leverage must be one of ${this.allowedLeverage.join(',')}`);
    if (!Number.isFinite(margin) || margin <= 0) throw new GameError('BAD_MARGIN', 'margin must be > 0');

    const notional = margin * leverage;
    /*
     * ⛔[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
     *   여기 있던 `this.assertOrderSize(ticker, notional)` 를 «제거»했다. 되살리지 마라.
     * ★현물(`placeSpotOrder`)의 검사는 «그대로 남아 있다» — 지시는 「파생」이다.
     * ★상한이 사라져도 «무마찰»이 되는 것은 아니다: 체결가는 여전히 `fillPrice` 를 거치고
     *   그 임팩트는 `priceImpactFrac` = ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1) 다.
     *   ⇒ 깊이를 넘는 주문일수록 «자기 체결가가 불리해져» 자연히 제동이 걸린다.
     *   ⛔`priceImpactFrac`·`maxOrderNotional` 함수 자체는 지우지 마라 — 봇·중앙은행이 쓴다.
     */
    // ★진입가에도 자기 임팩트를 반영한다 — 롱은 비싸게, 숏은 싸게(둘 다 불리)
    const price = this.fillPrice(ticker, side === 'long' ? notional : -notional);
    const fee = notional * FEE_LEVERAGE_BP * BP;
    if (acc.cash < margin + fee)
      throw new GameError('INSUFFICIENT_CASH', `need ${(margin + fee).toFixed(2)}, have ${acc.cash.toFixed(2)}`);

    acc.cash -= margin + fee;
    acc.feesPaid += fee;
    acc.tradeCount++;
    this.stats.feesCollected += fee;

    const pos: LeveragePosition = {
      id: nextId('lev'),
      ticker,
      side,
      leverage,
      margin,
      notional,
      qty: notional / price,
      entryPrice: price,
      openedTick: this.tick,
      fundingPaid: 0,
      lastFundingTick: this.tick,
    };
    acc.levPositions.set(pos.id, pos);
    this.trackPositions(acc);   // ★P1 색인 — 빠뜨리면 청산·정산이 조용히 안 돈다
    this.engine.addOrderFlow(ticker, side === 'long' ? notional : -notional);
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, position: pos, fee, cashAfter: acc.cash };
  }

  closeLeverage(accountId: string, positionId: string, forced = false) {
    const acc = this.getAccount(accountId);
    const pos = acc.levPositions.get(positionId);
    if (!pos) throw new GameError('NO_POSITION', `unknown position ${positionId}`);
    const dir = pos.side === 'long' ? 1 : -1;
    // ★청산도 반대방향 물량이 시장에 나가므로 체결가가 불리해진다
    const price = this.fillPrice(pos.ticker, -dir * pos.qty * this.engine.priceOf(pos.ticker));
    const pnl = (price - pos.entryPrice) * pos.qty * dir;
    const closeNotional = pos.qty * price;
    const fee = closeNotional * FEE_LEVERAGE_BP * BP;
    const funding = this.accruedFunding(pos);
    const returned = Math.max(0, pos.margin + pnl - funding - fee);

    acc.cash += returned;
    acc.realizedPnl += returned - pos.margin;
    acc.feesPaid += fee + funding;
    this.stats.feesCollected += fee + funding;
    acc.levPositions.delete(positionId);
    // 청산 시 반대방향 물량이 시장에 나간다 (동일 orderFlow 파이프라인)
    this.engine.addOrderFlow(pos.ticker, -dir * closeNotional);
    this.stats.orders++;
    if (forced) {
      acc.liquidationCount++;
      this.stats.liquidations++;
      this.emit({
        type: 'liquidation',
        accountId: acc.id,
        nickname: acc.nickname,
        isBot: acc.isBot,
        ticker: pos.ticker,
        positionId,
        leverage: pos.leverage,
        side: pos.side,
        loss: pos.margin - returned,
        returned,
        price,
        tick: this.tick,
      });
    } else {
      this.emit({
        type: 'lev_closed',
        accountId: acc.id,
        nickname: acc.nickname,
        isBot: acc.isBot,
        ticker: pos.ticker,
        roiPct: pos.margin > 0 ? (returned / pos.margin - 1) * 100 : 0,
        pnl: returned - pos.margin,
        tick: this.tick,
      });
    }
    return { ok: true as const, tick: this.tick, positionId, pnl, fee, funding, returned, forced, cashAfter: acc.cash };
  }

  // ── 옵션 ──────────────────────────────────────────────────────────────

  /**
   * ★옵션 주문 «견적» — 화면과 엔진이 «같은 식»을 쓰게 하는 단 하나의 통로.
   *   ⛔상태를 바꾸지 않는다(순수 조회). 렌더 중에 불러도 안전하다.
   *
   * ★★왜 생겼나 [2026-08-21 실렌더로 잡은 결함]
   *   화면(`screens/OptionOrder.tsx`)은 필요현금을 `optionPremium(kind, spot, ...)` 으로
   *   ★«현재가» 기준으로 계산했다. 그런데 엔진은 «델타헤지 물량이 기초자산을 미는 만큼»
   *   불리해진 `fillPrice()` 를 쓴다. 계약 수가 커질수록 둘이 벌어진다.
   *   실측(NVDA · 시드 $10,000 · 화면의 「최대」 계약수 그대로 확정):
   *     ★«현금이 모자라요»(INSUFFICIENT_CASH) — 화면이 「살 수 있다」고 한 값이었다.
   *     현금 $3,000 에서도 같았고, $800·$300 에서는 계약 수가 작아 «우연히» 통과했다.
   *   ⇒ 임팩트는 계약 수에 «비선형»이라 화면이 1계약 비용에 곱해서 맞힐 수 없다.
   *     그리고 U-7 규율상 ⛔엔진 계산식을 화면에 복제하면 안 된다.
   *   ⇒ 그래서 «엔진이 견적을 준다». `buyOption`·`writeOption` 이 이 함수를 그대로 쓰므로
   *     두 벌로 갈릴 수 없다(U-4: 표가 두 벌이면 언젠가 갈린다).
   *
   * ★`side` 를 반드시 본다 — 매도는 계산식이 매수와 «완전히 다르다»(8-4장).
   *   매수 need = 프리미엄 + 수수료
   *   매도 need = 증거금 + 수수료 − 받은 프리미엄 = 명목가 × 비율 + 수수료
   */
  optionQuote(
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number,
    side: 'buy' | 'sell' = 'buy'
  ) {
    this.instrumentOf(ticker); // 종목 존재 검증
    const S0 = this.engine.priceOf(ticker);
    /* ★[2026-09-05] sigma 는 «실현변동성 EWMA»다(engine.sigmaOf) — 프리미엄·델타가 «같은 값»을 쓴다.
       ⛔`inst.sigma` 로 되돌리지 마라(GBM 입력값 ≠ 실현변동성). 근거는 constants 의 VOL_EWMA 주석. */
    const sigma = this.engine.sigmaOf(ticker);
    /* ★배당 반영 실효가. ⛔프리미엄과 델타가 «같은» S 를 써야 한다 —
       하나만 고치면 헤지 물량과 가격이 어긋나 그 틈이 곧 차익이다. */
    /* ★[2026-09-05 President 결정 ③] 선도가 = 현물 × 선도계수(배당 + 시장캐리 + 이벤트).
       ⛔`divFactor`(배당만)로 되돌리지 마라 — 선도(quotesFor)와 옵션의 선도가가 갈리고,
         그 차이가 곧 «합성 롱 vs 선도 매도» 차익이다. 근거는 `carryFactor` 머리주석. */
    const cf = this.carryFactor(ticker, expiryGameDays);
    const d0 = optionDelta(kind, S0 * cf, strike, sigma, expiryGameDays);
    // ★델타헤지 물량이 기초자산을 미는 만큼 프리미엄 산정 기준가도 «불리»해진다.
    //   매도는 헤지 방향이 반대다 — 부호를 여기 «한 곳»에서만 정한다.
    /* ★계약 크기는 «종목마다» 다르다(constants.sharesPerContractFor).
       ⛔SHARES_PER_CONTRACT 를 여기 직접 곱하지 마라 — BTC 1계약이 $680,000 이 되어
         시드 $10,000 으로는 단 1계약도 못 사는 상태로 되돌아간다(2026-09-05 실측). */
    const shares = this.sharesPerContractOf(ticker);
    const hedge = d0 * S0 * contracts * shares;
    const S = this.fillPrice(ticker, side === 'sell' ? -hedge : hedge);
    /** ★이 견적이 쓰는 선도가. 패리티 C − P = F − K 의 F 가 바로 이 값이다 */
    const F = S * cf;
    const premium = optionPremium(kind, F, strike, sigma, expiryGameDays);
    const total = premium * contracts * shares;
    const delta0 = optionDelta(kind, F, strike, sigma, expiryGameDays);
    const notional = S * contracts * shares;
    const fee = total * FEE_OPTION_BP * BP;
    const margin = total + notional * OPTION_SHORT_MARGIN_RATIO;
    return {
      S,
      /** ★이 견적의 선도가 = S × carryFactor. 검증기(check_option_arb)가 패리티에 쓴다 */
      F,
      carryFactor: cf,
      premium,
      total,
      delta0,
      notional,
      fee,
      margin,
      /** ★이 주문에 «실제로» 필요한 현금 */
      need: side === 'sell' ? margin + fee - total : total + fee,
      /** 델타 헤지 명목가(절대값). ★2026-09-05 유동성 상한이 사라져 «진단용»으로만 남는다 */
      hedgeNotional: Math.abs(delta0) * notional,
    };
  }

  buyOption(
    accountId: string,
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number
  ) {
    const acc = this.getAccount(accountId);
    /* ★연체 중(현금 음수)에는 «신규 파생 개시»가 없다 (President 2026-09-05).
       ⛔청산·정산은 막지 않는다 — 그게 연체를 갚는 길이다. */
    this.assertNotOverdrawn(acc);
    this.instrumentOf(ticker); // 종목 존재 검증(값은 optionQuote 가 다시 읽는다)
    if (!Number.isFinite(strike) || strike <= 0) throw new GameError('BAD_STRIKE', 'strike must be > 0');
    if (!Number.isFinite(contracts) || contracts <= 0) throw new GameError('BAD_CONTRACTS', 'contracts must be > 0');
    if (expiryGameDays < OPTION_MIN_EXPIRY_DAYS || expiryGameDays > OPTION_MAX_EXPIRY_DAYS)
      throw new GameError('BAD_EXPIRY', `expiry must be ${OPTION_MIN_EXPIRY_DAYS}~${OPTION_MAX_EXPIRY_DAYS} game days`);

    // ★식은 `optionQuote` 한 벌뿐이다 — 화면이 보는 값과 «같은 값»이다
    /* ★delta0 를 더 이상 «구조분해하지 않는다» — 옵션이 orderFlow 를 안 넣으므로 쓸 데가 없다.
       ★[2026-09-05] `hedgeNotional` 도 빠졌다 — 유동성 상한이 사라져 쓸 데가 없어졌다.
       (optionQuote 는 «진단용»으로 여전히 돌려준다) */
    const { premium, total, fee, need } = this.optionQuote(
      ticker,
      kind,
      strike,
      expiryGameDays,
      contracts,
      'buy'
    );
    /*
     * ⛔[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
     *   여기 있던 `this.assertOrderSize(ticker, hedgeNotional)` 를 «제거»했다. 되살리지 마라.
     * ★현물(`placeSpotOrder`)의 검사는 «그대로 남아 있다» — 지시는 「파생」이다.
     * ★상한이 사라져도 «무마찰»이 되는 것은 아니다: 체결가는 여전히 `fillPrice` 를 거치고
     *   그 임팩트는 `priceImpactFrac` = ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1) 다.
     *   ⇒ 깊이를 넘는 주문일수록 «자기 체결가가 불리해져» 자연히 제동이 걸린다.
     *   ⛔`priceImpactFrac`·`maxOrderNotional` 함수 자체는 지우지 마라 — 봇·중앙은행이 쓴다.
     */
    if (acc.cash < need)
      throw new GameError('INSUFFICIENT_CASH', `need ${need.toFixed(2)}, have ${acc.cash.toFixed(2)}`);

    acc.cash -= total + fee;
    acc.feesPaid += fee;
    acc.tradeCount++;
    this.stats.feesCollected += fee;

    const pos: OptionPosition = {
      id: nextId('opt'),
      ticker,
      kind,
      strike,
      contracts,
      premiumPaid: total,
      feePaid: fee,
      openedTick: this.tick,
      expiryTick: this.tick + Math.round(expiryGameDays * TICKS_PER_GAME_DAY),
      /* ★체결 조건을 «찍어 둔다» — 종목 계약 크기 규칙이 바뀌어도 이 포지션은 안 흔들린다 */
      sharesPerContract: this.sharesPerContractOf(ticker),
    };
    acc.optPositions.set(pos.id, pos);
    this.trackPositions(acc);   // ★P1 색인 — 빠뜨리면 청산·정산이 조용히 안 돈다

    /*
     * ⛔⛔★옵션은 `addOrderFlow` 를 «넣지 않는다» (2026-08-22, 무한돈 사고 대응).
     *
     * ★이건 새 규칙이 아니라 **⛔10 의 누락 보정**이다:
     *   「선도·스왑은 addOrderFlow 를 넣지 않는다 — 넣으면 «체결가에 자기 임팩트를 물지 않으면서
     *     가격만 미는» 경로가 생겨 fillPrice 로 막아둔 자가펌핑이 부활한다」
     *   ⇒ 규율이 «있었는데 옵션만 안 따랐다».
     *
     * ⛔왜 fillPrice 로 안 막히나: 옵션의 체결 마찰은 «프리미엄»에 걸리는데
     *   이득은 «명목»에 붙는다. 프리미엄 ≪ 명목이라 마찰이 이득을 못 덮는다.
     *   ★콜은 헤지가 +라 가격을 올리고 풋은 −라 내린다 — 둘 다 «자기 포지션에 유리»하다.
     *
     * [실측] 제거 전: 시드 $10,000 이 6.7분에 **+685%** (콜 +$68,478 · 풋 +$67,456).
     *        제거 후: 콜 −$111,971 · 풋 −$116,707 로 **부호가 뒤집힌다**.
     *        ⛔되감기(H1)·매도마찰(H2)로는 «안 닫혔다» — 경로 자체를 없애야 닫힌다.
     * ⇒ 재현: node scripts/bench/run.mjs optpump --ticker VZ --spacing 10 --start 10000
     */
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, position: pos, premium, total, fee, cashAfter: acc.cash };
  }

  /**
   * ★옵션 «매도(숏) 개시». 권리를 팔고 프리미엄을 «받는다».
   *
   * ⛔President 지시로 «승인 레벨·적격성 심사·위험 고지 동의»를 만들지 않는다.
   *   실거래가 아니므로 규제 대응 UI 를 옮기지 않는다. 증거금이 모자라면
   *   «버튼이 비활성화»될 뿐이고, 조작 흐름을 끊는 모달은 없다.
   *   (참고: 로빈후드는 네이키드 매도를 아예 금지한다 — 그건 규제 장치이지 기술 제약이 아니다.)
   * ★증거금 = 수취 프리미엄 + 명목가 × OPTION_SHORT_MARGIN_RATIO.
   *   실무 공식을 그대로 옮기지 않고 «게임 자체 기준»을 쓴다. 손실이 커지면
   *   기존 레버리지 청산 스캔이 같은 자리에서 되사서 정리한다 — 새 루프가 없다.
   * ★buyOption 과 «별도 메서드»로 둔 이유: 봇들이 buyOption 시그니처를 그대로 쓰고 있고
   *   그 파일은 다른 레인 소유다. 시그니처를 바꾸면 남의 빌드가 깨진다.
   */
  writeOption(
    accountId: string,
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number
  ) {
    const acc = this.getAccount(accountId);
    /* ★연체 중(현금 음수)에는 «신규 파생 개시»가 없다 (President 2026-09-05).
       ⛔청산·정산은 막지 않는다 — 그게 연체를 갚는 길이다. */
    this.assertNotOverdrawn(acc);
    this.instrumentOf(ticker); // 종목 존재 검증(값은 optionQuote 가 다시 읽는다)
    if (!Number.isFinite(strike) || strike <= 0) throw new GameError('BAD_STRIKE', 'strike must be > 0');
    if (!Number.isFinite(contracts) || contracts <= 0) throw new GameError('BAD_CONTRACTS', 'contracts must be > 0');
    if (expiryGameDays < OPTION_MIN_EXPIRY_DAYS || expiryGameDays > OPTION_MAX_EXPIRY_DAYS)
      throw new GameError('BAD_EXPIRY', `expiry must be ${OPTION_MIN_EXPIRY_DAYS}~${OPTION_MAX_EXPIRY_DAYS} game days`);

    // ★식은 `optionQuote` 한 벌뿐이다 — 화면이 보는 값과 «같은 값»이다.
    //   프리미엄은 받고 증거금은 잠근다 ⇒ 필요 현금은 (수수료 + 명목가 비율)뿐이다.
    /* ★delta0·notional 미사용 — 위와 같은 이유(옵션은 orderFlow 를 안 넣는다) */
    const { premium, total, fee, margin, need } = this.optionQuote(
      ticker,
      kind,
      strike,
      expiryGameDays,
      contracts,
      'sell'
    );
    /*
     * ⛔[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
     *   여기 있던 `this.assertOrderSize(ticker, hedgeNotional)` 를 «제거»했다. 되살리지 마라.
     * ★현물(`placeSpotOrder`)의 검사는 «그대로 남아 있다» — 지시는 「파생」이다.
     * ★상한이 사라져도 «무마찰»이 되는 것은 아니다: 체결가는 여전히 `fillPrice` 를 거치고
     *   그 임팩트는 `priceImpactFrac` = ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1) 다.
     *   ⇒ 깊이를 넘는 주문일수록 «자기 체결가가 불리해져» 자연히 제동이 걸린다.
     *   ⛔`priceImpactFrac`·`maxOrderNotional` 함수 자체는 지우지 마라 — 봇·중앙은행이 쓴다.
     */
    if (acc.cash < need)
      throw new GameError('INSUFFICIENT_CASH', `need ${need.toFixed(2)}, have ${acc.cash.toFixed(2)}`);

    acc.cash += total - fee - margin;
    acc.feesPaid += fee;
    acc.tradeCount++;
    this.stats.feesCollected += fee;

    const pos: OptionPosition = {
      id: nextId('opt'),
      ticker,
      kind,
      strike,
      contracts,
      premiumPaid: total,
      feePaid: fee,
      openedTick: this.tick,
      expiryTick: this.tick + Math.round(expiryGameDays * TICKS_PER_GAME_DAY),
      side: 'sell',
      margin,
      /* ★매수와 «같은 규율» — 체결 조건을 찍어 둔다 */
      sharesPerContract: this.sharesPerContractOf(ticker),
    };
    acc.optPositions.set(pos.id, pos);
    this.trackPositions(acc);   // ★P1 색인 — 빠뜨리면 청산·정산이 조용히 안 돈다

    /*
     * ⛔⛔★옵션은 `addOrderFlow` 를 «넣지 않는다» (2026-08-22, 무한돈 사고 대응).
     *
     * ★이건 새 규칙이 아니라 **⛔10 의 누락 보정**이다:
     *   「선도·스왑은 addOrderFlow 를 넣지 않는다 — 넣으면 «체결가에 자기 임팩트를 물지 않으면서
     *     가격만 미는» 경로가 생겨 fillPrice 로 막아둔 자가펌핑이 부활한다」
     *   ⇒ 규율이 «있었는데 옵션만 안 따랐다».
     *
     * ⛔왜 fillPrice 로 안 막히나: 옵션의 체결 마찰은 «프리미엄»에 걸리는데
     *   이득은 «명목»에 붙는다. 프리미엄 ≪ 명목이라 마찰이 이득을 못 덮는다.
     *   ★콜은 헤지가 +라 가격을 올리고 풋은 −라 내린다 — 둘 다 «자기 포지션에 유리»하다.
     *
     * [실측] 제거 전: 시드 $10,000 이 6.7분에 **+685%** (콜 +$68,478 · 풋 +$67,456).
     *        제거 후: 콜 −$111,971 · 풋 −$116,707 로 **부호가 뒤집힌다**.
     *        ⛔되감기(H1)·매도마찰(H2)로는 «안 닫혔다» — 경로 자체를 없애야 닫힌다.
     * ⇒ 재현: node scripts/bench/run.mjs optpump --ticker VZ --spacing 10 --start 10000
     */
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, position: pos, premium, total, fee, margin, cashAfter: acc.cash };
  }

  /** ★매도 포지션 «되사기»(중도 청산 또는 강제 정리) */
  buybackOption(accountId: string, positionId: string, forced = false) {
    const acc = this.getAccount(accountId);
    const pos = acc.optPositions.get(positionId);
    if (!pos) throw new GameError('NO_POSITION', `unknown option ${positionId}`);
    if (pos.side !== 'sell') throw new GameError('NOT_SHORT', 'not a short option position');
    const mark = this.optionMarkValue(pos);
    const returned = Math.max(0, (pos.margin ?? 0) - mark);
    acc.cash += returned;
    acc.realizedPnl += pos.premiumPaid - pos.feePaid - mark;
    if (forced) acc.liquidationCount++;
    acc.optPositions.delete(pos.id);
    return { ok: true as const, tick: this.tick, positionId, mark, returned, forced, cashAfter: acc.cash };
  }

  /**
   * 방금 낸 주문 «취소» — 되돌리기(undo) 전용. «청산/전매가 아니다».
   *
   * 왜 sellOption/closeLeverage 로 대신하지 않는가:
   *   그건 «반대매매»라 수수료가 한 번 더 붙고, 그사이 시세가 움직였으면
   *   손익이 남는다. 유저가 「되돌리기」를 눌렀는데 돈이 줄어 있으면 그건
   *   되돌리기가 아니다. 그래서 원장을 «주문 직전 상태로» 그대로 복원한다.
   *
   * ★ 시세 변동과 무관하다: 환불액이 «체결 당시 지불액»이라 그사이 가격이
   *   어디로 갔든 결과가 같다. 다른 주문이 사이에 끼어도 각자의 포지션만
   *   건드리므로 서로 간섭하지 않는다.
   * ★ 반대로 `engine.addOrderFlow` 는 «되감지 않는다». 그 임펄스는 이미 그 틱의
   *   가격에 반영돼 시장 전체(봇 210 포함)가 그 가격으로 거래했다. 뒤늦게 반대
   *   임펄스를 넣으면 «없던 주문»이 시장을 한 번 더 미는 셈이라 더 나쁘다.
   *   유저 계좌는 완전복구되고, 시장에 남는 건 이미 지나간 체결 흔적뿐이다.
   */
  cancelOption(accountId: string, positionId: string): boolean {
    const acc = this.getAccount(accountId);
    const pos = acc.optPositions.get(positionId);
    if (!pos) return false; // 이미 만기소멸/전매됐다 — 되돌릴 대상이 없다
    /*
     * ★현금 복원은 «개시식의 정확한 역»이어야 한다. 매수와 매도가 «다르다».
     *   매수 개시:  cash -= total + fee        ⇒ 되돌리기: cash += total + fee
     *   매도 개시:  cash += total - fee - margin ⇒ 되돌리기: cash += margin + fee - total
     * ★매수 식을 매도에 쓰면 (2·total − margin) 만큼 «없는 돈»이 생기고,
     *   예치한 margin 은 포지션과 함께 사라진다. 에러 없이 «숫자만» 틀리는 종류다.
     */
    acc.cash +=
      pos.side === 'sell'
        ? (pos.margin ?? 0) + pos.feePaid - pos.premiumPaid
        : pos.premiumPaid + pos.feePaid;
    acc.feesPaid = Math.max(0, acc.feesPaid - pos.feePaid);
    acc.tradeCount = Math.max(0, acc.tradeCount - 1);
    this.stats.feesCollected = Math.max(0, this.stats.feesCollected - pos.feePaid);
    this.stats.orders = Math.max(0, this.stats.orders - 1);
    acc.optPositions.delete(positionId);
    return true;
  }

  /** 방금 연 레버리지 포지션 «취소» — cancelOption 과 같은 원칙 */
  cancelLeverage(accountId: string, positionId: string): boolean {
    const acc = this.getAccount(accountId);
    const pos = acc.levPositions.get(positionId);
    if (!pos) return false; // 이미 강제청산됐다
    const fee = pos.notional * FEE_LEVERAGE_BP * BP;
    acc.cash += pos.margin + fee;
    acc.feesPaid = Math.max(0, acc.feesPaid - fee);
    acc.tradeCount = Math.max(0, acc.tradeCount - 1);
    this.stats.feesCollected = Math.max(0, this.stats.feesCollected - fee);
    this.stats.orders = Math.max(0, this.stats.orders - 1);
    acc.levPositions.delete(positionId);
    return true;
  }

  /**
   * ★선도 «취소» — 되돌리기(undo) 전용. ⛔closeForward 와 «다르다».
   *
   * ★왜 closeForward 로 대신하면 안 되나: 그건 손익을 «실현»한다. 개시 직후 닫아도
   *   스프레드(15bp 이상)를 문다. 유저가 「되돌리기」를 눌렀는데 돈이 줄어 있으면
   *   그건 되돌리기가 아니다. 그래서 원장을 «주문 직전 상태»로 그대로 복원한다.
   * ★선도는 개시 때 수수료를 따로 받지 않으므로(마찰은 스프레드로 한 번만 걷는다)
   *   되돌릴 현금은 증거금뿐이다.
   * ★addOrderFlow 되감기 문제가 «없다» — 선도는 애초에 orderFlow 를 넣지 않는다.
   *   (넣으면 체결가에 자기 임팩트를 물지 않으면서 가격만 미는 경로가 열린다.)
   */
  cancelForward(accountId: string, positionId: string): boolean {
    const acc = this.getAccount(accountId);
    const pos = acc.fwdPositions.get(positionId);
    if (!pos) return false; // 이미 만기정산/청산됐다 — 되돌릴 대상이 없다
    acc.cash += pos.margin + pos.feePaid;
    acc.feesPaid = Math.max(0, acc.feesPaid - pos.feePaid);
    acc.tradeCount = Math.max(0, acc.tradeCount - 1);
    this.stats.feesCollected = Math.max(0, this.stats.feesCollected - pos.feePaid);
    this.stats.orders = Math.max(0, this.stats.orders - 1);
    acc.fwdPositions.delete(positionId);
    return true;
  }

  /** ★스왑 «취소» — cancelForward 와 같은 원칙(원장을 주문 직전으로 복원) */
  cancelSwap(accountId: string, positionId: string): boolean {
    const acc = this.getAccount(accountId);
    const pos = acc.swapPositions.get(positionId);
    if (!pos) return false;
    acc.cash += pos.margin + pos.feePaid;
    acc.feesPaid = Math.max(0, acc.feesPaid - pos.feePaid);
    acc.tradeCount = Math.max(0, acc.tradeCount - 1);
    this.stats.feesCollected = Math.max(0, this.stats.feesCollected - pos.feePaid);
    this.stats.orders = Math.max(0, this.stats.orders - 1);
    acc.swapPositions.delete(positionId);
    return true;
  }

  /** 만기 전 매도(전매). European 이라 조기행사는 불가하지만 계약 매도는 허용. */
  sellOption(accountId: string, positionId: string) {
    const acc = this.getAccount(accountId);
    const pos = acc.optPositions.get(positionId);
    if (!pos) throw new GameError('NO_POSITION', `unknown option ${positionId}`);
    /*
     * ★매도(숏) 포지션은 «전매»가 성립하지 않는다 — 되사야 한다(buybackOption).
     *   막지 않으면 optionValue 가 (margin − mark) 를 돌려줘서 현금은 그럴듯하게 들어오는데
     *   수수료가 한 번 더 붙고 realizedPnl 이 «매수 기준»으로 기록된다. 에러 없이 숫자만 틀린다.
     */
    if (pos.side === 'sell') throw new GameError('IS_SHORT', 'short option: use buybackOption');
    const value = this.optionMarkValue(pos);
    const fee = value * FEE_OPTION_BP * BP;
    acc.cash += value - fee;
    acc.realizedPnl += value - fee - pos.premiumPaid - pos.feePaid;
    acc.feesPaid += fee;
    this.stats.feesCollected += fee;
    acc.optPositions.delete(positionId);
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, positionId, value, fee, cashAfter: acc.cash };
  }

  // ── 틱 ────────────────────────────────────────────────────────────────
  /** 봇 훅 — bots 모듈이 주입 */
  botStep: ((w: World) => void) | null = null;

  /**
   * 한 틱 전진.
   *  1) 봇 주문 -> orderFlow
   *  2) 가격 엔진 step
   *  3) 마진 체크 -> 강제청산
   *  4) 옵션 만기 정산
   */
  step(): EngineTickDiag[] {
    if (this.botsEnabled && this.botStep) this.botStep(this);
    const diags = this.engine.step();
    this.tick++;
    /* ★중앙은행 — 가격이 «갱신된 뒤» 괴리를 보고 주문을 낸다. 주문은 다음 틱 가격에 실린다(봇과 같다) */
    if (this.engine.indexes.size > 0) {
      this.cbMarket.tick = this.tick;
      this.cbMarket.gameDay = this.gameDay;
      this.centralBank.step(this.cbMarket);
    }
    const ev = this.macro.update(this.tick, this.engine);
    if (ev) this.emit({ type: 'macro', event: ev, tick: this.tick });
    /* ★정책금리 «정례 회합» (2026-09-05). 난수 스트림이 시황 이벤트와 «분리»돼 있어
       대출 기능을 붙여도 가격 경로가 비트 동일하다(macro.ts rateRng 주석). */
    const rateEv = this.macro.updatePolicyRate(this.tick);
    if (rateEv) this.emit({ type: 'policy_rate', event: rateEv, tick: this.tick });
    /* ★대출 이자·건전성 — «게임일이 넘어갈 때만» 돈다. 매 틱 도는 비용이 없다.
       ⛔순서: 이자를 먼저 물리고 그 결과로 건전성을 본다. 반대로 하면 오늘 붙은 이자가
         내일까지 판정에서 빠져 연체 판정이 하루씩 늦는다. */
    if (this.gameDay !== this.lastLoanDay) {
      this.lastLoanDay = this.gameDay;
      this.accrueLoans();
      /* ★마이너스 계좌 이자 — 이자 정산과 «같은 게임일 경계»에서 돈다.
         ⛔`accrueLoans` 앞에 두지 마라: 오늘 대출 이자를 못 내 마이너스로 들어간 금액이
           같은 날 또 이자를 무는 이중 부과가 된다. */
      this.accrueOverdraft();
      this.checkLoanHealth();
    }
    /* ★만기 자동상환 — «매 틱» 본다(만기는 틱 단위이고, 게임일 경계까지 미루면 최대 150틱 늦다).
       ⛔파생 정산(settleExpired*)보다 «뒤»에 둔다: 만기 당일 파생이 정산돼 들어온 현금으로
         대출을 갚을 수 있어야 한다. 순서를 뒤집으면 있는 돈을 두고 담보를 판다. */
    this.checkLiquidations();
    this.settleExpiredOptions();
    this.settleExpiredForwards();
    this.settleExpiredSwaps();
    this.settleExpiredFutures();
    this.settleMaturedLoans();
    this.stepDividends();
    /*
     * ★★파산 판정 — «게임일 경계에서만» 본다 (President 2026-09-05).
     *   ⛔매 틱 보지 마라: 가격 노이즈 한 틱에 순자산이 0 을 스쳤다고 계좌를 청산하면
     *     그건 판정이 아니라 사고다. 일 단위면 유저가 볼 시간과 손 쓸 시간이 생긴다.
     * ★`lastLoanDay` 를 위에서 이미 갱신했으므로 여기서는 «따로» 센다.
     */
    if (this.gameDay !== this.lastBankruptcyDay) {
      this.lastBankruptcyDay = this.gameDay;
      this.checkOverdraftBankruptcy();
    }
    this.emit({ type: 'tick', tick: this.tick, gameDay: this.gameDay, diags });
    return diags;
  }

  /**
   * 배당 지급 + 배당락 (President 지시 ⑨). 규칙 본문은 `dividends.ts` 에 있다.
   *
   * ★호출 위치가 «정산·청산 뒤»인 것은 의도적이다.
   *   배당락은 가격을 내린다. 이걸 `checkLiquidations` «앞»에 두면
   *   「배당 때문에 내 레버리지가 청산됐다」가 «같은 틱 안에서» 벌어진다.
   *   뒤에 두면 배당락 가격은 «다음 틱»의 청산 판정부터 쓰인다 — 유저가 볼 시간이 생긴다.
   * ⚠️알아둘 것: 레버리지·선도 보유자는 배당락으로 «가치가 내려가는데 배당은 못 받는다».
   *   (현물 보유자만 받는다) 이건 현실의 파생과 같은 방향이지만 밸런스 영향은 미측정이다.
   *
   * ★`tickerMeta` 가 비어 있으면 `tickers()` 가 아무것도 안 돌려줘 «배당이 통째로 안 돈다».
   *   기존 벤치·테스트가 무영향인 이유다.
   */
  private stepDividends(): void {
    if (this.tickerMeta.size === 0) return;
    const view: DividendWorldLike = {
      tick: this.tick,
      accounts: this.accounts,
      priceOf: (t) => this.engine.get(t)?.price,
      applyExDividend: (t, rate) => {
        const st = this.engine.get(t);
        /* ⛔«현재가만» 내린다. rescaleTo(곡선 전체 이동)를 쓰지 마라 — 캔들에 갭이 남는 게 맞다 */
        if (st) st.price = Math.max(MIN_PRICE, st.price * (1 - rate));
      },
      metaOf: (t) => this.tickerMeta.get(t),
      tickers: () => this.tickerMeta.keys(),
    };
    for (const e of stepDividends(view)) this.emit(e);
  }

  /** 매 틱 전체 오픈 레버리지 포지션 마진 체크 (강제청산) */
  checkLiquidations(): number {
    let count = 0;
    this.vulnerable.clear();
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.levPositions.size === 0) continue;
      for (const pos of [...acc.levPositions.values()]) {
        const eq = this.levPositionEquity(pos);
        const mm = this.maintenanceMargin(pos);
        if (eq < mm) {
          this.closeLeverage(acc.id, pos.id, true);
          count++;
          continue;
        }
        // 안전거리 25% 이내면 «청산 임박»으로 본다 (계정은 구분하지 않는다)
        if (eq < mm * 1.25) {
          let v = this.vulnerable.get(pos.ticker);
          if (!v) { v = { long: 0, short: 0 }; this.vulnerable.set(pos.ticker, v); }
          if (pos.side === 'long') v.long += pos.notional; else v.short += pos.notional;
        }
      }
    }
    /*
     * ★옵션 «매도» 증거금 점검 — 기존 레버리지 스캔과 «같은 자리»에서 돈다.
     * 새 루프를 만들지 않는다(틱 예산). 증거금이 유지수준 밑으로 가면 되사서 정리한다.
     */
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.optPositions.size === 0) continue;
      for (const pos of [...acc.optPositions.values()]) {
        if (pos.side !== 'sell') continue;
        const m = pos.margin ?? 0;
        if (m - this.optionMarkValue(pos) < MAINTENANCE_MARGIN_RATIO * m) {
          const r = this.buybackOption(acc.id, pos.id, true);
          this.emit({
            type: 'settled', kind: 'option', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
            positionId: pos.id, ticker: pos.ticker,
            pnl: pos.premiumPaid - pos.feePaid - r.mark, returned: r.returned,
            forced: true, tick: this.tick,
          });
          count++;
        }
      }
    }
    return count;
  }

  settleExpiredOptions(): number {
    let count = 0;
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.optPositions.size === 0) continue;
      for (const pos of [...acc.optPositions.values()]) {
        if (this.tick < pos.expiryTick) continue;
        const S = this.engine.priceOf(pos.ticker);
        /* ★정산도 «포지션에 찍힌» 계약 크기로 한다 — 평가(optionMarkValue)와 같은 값이어야
           만기 순간에 평가액과 정산액이 «점프하지 않는다». */
        const payoff = optionPayoff(pos.kind, S, pos.strike) * pos.contracts * this.posShares(pos);
        if (pos.side === 'sell') {
          /* ★매도: 지급 의무를 증거금에서 빼고 남은 것만 돌려받는다.
             수취 프리미엄은 «개시 때 이미 현금»에 들어갔으므로 여기서 또 더하지 않는다. */
          acc.cash += Math.max(0, (pos.margin ?? 0) - payoff);
          acc.realizedPnl += pos.premiumPaid - pos.feePaid - payoff;
        } else {
          acc.cash += payoff;
          acc.realizedPnl += payoff - pos.premiumPaid - pos.feePaid;
        }
        acc.optPositions.delete(pos.id);
        this.stats.optionSettlements++;
        count++;
        {
          const isSell = pos.side === 'sell';
          const settledReturn = isSell ? Math.max(0, (pos.margin ?? 0) - payoff) : payoff;
          const settledPnl = isSell
            ? pos.premiumPaid - pos.feePaid - payoff
            : payoff - pos.premiumPaid - pos.feePaid;
          this.emit({
            type: 'settled', kind: 'option', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
            positionId: pos.id, ticker: pos.ticker, pnl: settledPnl, returned: settledReturn,
            forced: false, tick: this.tick,
          });
        }
        this.emit({
          type: 'option_settled',
          accountId: acc.id,
          nickname: acc.nickname,
          isBot: acc.isBot,
          positionId: pos.id,
          ticker: pos.ticker,
          payoff,
          tick: this.tick,
        });
      }
    }
    return count;
  }

  // ── 파생 확장: 캐리 · 호가 · 선도 · 스왑 · 선물만기 ────────────────────

  /**
   * ★계약 캐리 — 만기까지의 «기대 수익률»(단순수익률 단위).
   *
   * ★핵심 설계: «모르는 부분은 추정하고, 아는 부분은 조회한다».
   *   1) 시장 기저 드리프트 = «모른다» → 전 종목 풀링 EWMA 로 추정
   *   2) 거시 이벤트 몫      = «엔진이 안다» → driftBonus 와 «잔여 지속»을 그대로 읽는다
   *
   * ★왜 이벤트를 이론식으로 안 매기나 [실측]: driftBonus 를 만기 «전 구간»에 곱하면
   *   +184.5bp 로 호가하는데 실현은 +72.5bp 라 «반대편»에 112bp 구멍이 난다.
   *   이벤트 지속이 평균 2게임일이고 계약 시점이 그 중간이라 잔여가 평균 1게임일뿐이기 때문이다.
   *   잔여를 쓰면 예상 비율 1/3, 실측 0.34~0.39 로 일치한다 — 보정계수가 필요 없다.
   * ★폴백: EWMA 가 덜 데워졌으면 «캐리 0». 0 은 보수적으로 안전하다 —
   *   만기 3게임일이면 최대 오차가 스프레드 안에 들어온다.
   */
  /**
   * ★캐리를 «두 조각»으로 나눠 돌려준다. 스프레드 산정이 이 구분을 «쓴다».
   *   base  = 시장 기저 — ★«모른다». 풀링 EWMA 로 «추정»한 값이다
   *   event = 거시 이벤트 — ★«엔진이 안다». driftBonus 와 잔여 지속을 «조회»한 값이다
   * ★공정가에는 둘 다 들어가고, ★스프레드 마진은 base 에만 붙는다(spreadBpFor 주석 참조).
   */
  carryParts(ticker: string, gameDays: number): { base: number; event: number; total: number } {
    const ticks = gameDays * TICKS_PER_GAME_DAY;
    const base = this.engine.carrySamples >= CARRY_WARM_TICKS ? this.engine.carryEwmaPerTick * ticks : 0;
    const bonus = this.engine.driftBonus.get(ticker) ?? 0;
    let event = 0;
    if (bonus !== 0) {
      const ev = this.macro.active;
      const remain = ev ? Math.max(0, Math.min(ticks, ev.startTick + ev.durationTicks - this.tick)) : 0;
      event = (DRIFT_WEIGHT * bonus * (remain / TICKS_PER_GAME_DAY)) / TRADING_DAYS_PER_YEAR;
    }
    /* ★배당 드래그 — 만기 전 배당락만큼 선도가가 «내려가야» 한다.
       ⛔안 넣으면 「배당 직전에 선도 매도」가 옵션과 «같은» 구멍이 된다.
       ★base(추정)가 아니라 total 에만 더한다 — 스프레드 마진은 «추정 오차»에 물리는 것이지
         결정론적으로 «아는» 값에 물릴 이유가 없다(8-3장 규율과 같다). */
    const divDrag = this.divFactor(ticker, gameDays) - 1;   // 배당 없으면 0
    const b = Number.isFinite(base) ? base : 0;
    const e = Number.isFinite(event) ? event : 0;
    const d = Number.isFinite(divDrag) ? divDrag : 0;
    return { base: b, event: e, total: b + e + d };
  }

  carryOf(ticker: string, gameDays: number): number {
    return this.carryParts(ticker, gameDays).total;
  }

  /**
   * ★★★만기 `gameDays` 의 «선도 계수» — 현물가를 선도가로 바꾸는 배수.
   *
   * ★★[2026-09-05 President 결정 ③] 「선도–옵션 캐리 불일치를 고쳐라」
   *   그전에는 상품마다 «다른 선도가»를 썼다:
   *     선도(quotesFor) : F = ref × (1 + base + event + divDrag)   ← 캐리 «전부»
   *     옵션(optionQuote): F = S   × divFactor                      ← ★배당만
   *   ⇒ 같은 만기·같은 종목인데 두 상품의 선도가가 «달랐다». 그 차이가 곧 차익이다:
   *     콜 매수 + 풋 매도(합성 롱)와 선도 매도를 같이 걸면 캐리분이 공짜로 남는다.
   *   [실측 · 워밍업 9,000틱 · ATM 콜] 캐리를 먹였을 때 프리미엄이 −0.25% ~ −6.97% 변한다
   *   = 그만큼 옵션이 «틀린 선도가»로 매겨지고 있었다.
   *
   * ★배당 이중 반영이 «구조적으로» 불가능하다: `carryParts.total` 안에
   *   `divDrag = divFactor(ticker, gameDays) − 1` 이 이미 들어 있으므로
   *   `1 + total = divFactor + base + event` 다. ⛔여기에 divFactor 를 «또» 곱하지 마라.
   *
   * ★만기에서 정확히 1 로 수렴한다(gameDays=0 ⇒ base 0 · event 0 · divDrag 0).
   *   그래서 `optionMarkValue` 가 만기 순간 `settleExpiredOptions` 의 페이오프와 «점프 없이» 만난다.
   * ⛔r(무위험이자율)은 «여전히 0»이다 — 이 게임의 현금은 이자를 낳지 않는다.
   *   할인은 하지 않고 «선도만» 옮긴다. 그래서 패리티는 C − P = F − K 다.
   */
  carryFactor(ticker: string, gameDays: number): number {
    const f = 1 + this.carryOf(ticker, gameDays);
    return Number.isFinite(f) && f > 0 ? f : 1;
  }

  /**
   * ★선도가 = 기준가 × 선도 계수. ★이 게임에서 선도가를 만드는 «단 하나»의 통로다.
   *
   * ★«기준가»만 호출자가 정한다 — 그건 상품마다 달라야 하기 때문이다:
   *   · 선도·스왑 : `refPrice`(21틱 중앙값) — 계약 «조건»이 한 틱 펌프에 흔들리면 안 된다
   *   · 옵션      : `fillPrice`(자기 델타헤지 임팩트 반영 체결가) — 평가가 시세를 따라가야 한다
   *   ⇒ 다른 것은 «기준가»뿐이고 «캐리 규칙»은 하나다. 그게 이 함수의 존재 이유다.
   */
  forwardPrice(ticker: string, basePrice: number, gameDays: number): number {
    return basePrice * this.carryFactor(ticker, gameDays);
  }

  /** ★선도·스왑 견적의 «공정가» — 기준가가 refPrice 로 «고정»된 forwardPrice 다 */
  forwardFairPrice(ticker: string, gameDays: number): number {
    return this.forwardPrice(ticker, this.engine.refPrice(ticker, FORWARD_REF_VWAP_TICKS), gameDays);
  }

  /**
   * ★스프레드(bp).
   *
   * ★인자는 «추정» 캐리다 — 전체 캐리가 아니다. 이 구분이 중요하다:
   *   마진은 «모르는 것»에 대한 값이다. ★«아는 값»에 물리면 그건 마진이 아니라 그냥 세금이다.
   *   거시 이벤트분은 driftBonus 와 잔여 지속을 «조회»한 값이라 추정 오차가 없다 ⇒ 마진 대상이 아니다.
   *   ★실측: 전체 캐리에 배수를 물렸더니 플레이어 EV 가 −6.45bp 목표 대비 ★−53.32bp 로 8배 무거워졌다.
   *   추정분에만 물리면 −6.44bp 로 «소수점까지» 목표에 복귀한다(66,612 계약).
   *
   * ⛔바닥(baseBp, 기본 15bp)은 «절대 낮추지 마라».
   *   ★계약 «도중» 새 거시 이벤트가 시작되면 그때는 driftBonus 조회값도 틀린다 —
   *   즉 「아는 값」이 아니게 된다. 그 잔여 위험을 덮는 것이 이 바닥이다.
   */
  spreadBpFor(estimatedCarry: number, baseBp: number): number {
    return Math.max(baseBp, CARRY_SPREAD_MULT * Math.abs(estimatedCarry) * 1e4);
  }

  /** 아키타입 → 표시용 닉네임 색인 (지연 생성) */
  private strategyNicknames(strategy: string): string[] {
    if (!this.nickByStrategy) {
      const m = new Map<string, string[]>();
      for (const a of this.accounts.values()) {
        if (!a.isBot || !a.strategy) continue;
        const arr = m.get(a.strategy) ?? [];
        if (arr.length < 8) arr.push(a.nickname);
        m.set(a.strategy, arr);
      }
      this.nickByStrategy = m;
    }
    return this.nickByStrategy.get(strategy) ?? [];
  }

  /** 아키타입 풀을 seed 로 섞어 «비복원» 추출한다 */
  private pickArchetypes(rng: Rng, n: number): string[] {
    const pool = Object.keys(ARCHETYPE_VIEW_BIAS_BP);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    return pool.slice(0, Math.min(n, pool.length));
  }

  /**
   * ★상대 트레이더 호가 N개 (선도용).
   *
   * ⛔차익거래 방지 3장치 — 밸런스가 아니라 «방어»다. 하나라도 빠지면 설계가 무너진다:
   *   ① 서로 «다른» 아키타입에서 비복원 추출 — 같은 상대가 두 번 나오면 안 된다
   *   ② 플레이어가 상대를 «지정 불가» — 배정은 seed 로만 정해진다
   *   ③ ★«재추첨 금지» — sessionSeed 가 같으면 «항상 같은 3장»이 나온다.
   *      ★호출자는 «주문 세션 ID»를 넘겨야 한다. 시각·난수를 넘기면 그게 곧 재추첨이고,
   *      실측상 3회만 다시 뽑아도 기대손익이 −6.45bp → −0.31bp(사실상 공짜)가 된다.
   *   ★덤: 결정론적이라 틱마다 다시 계산할 필요가 없다(프레임 이득).
   *
   * ★편향 불변식은 constants.ARCHETYPE_VIEW_BIAS_BP 주석 참조(합계 0 · |편향| < 스프레드).
   */
  quotesFor(
    ticker: string,
    side: LevSide,
    sessionSeed: number,
    gameDays = FORWARD_EXPIRY_GAME_DAYS
  ): CounterQuote[] {
    const c = this.carryParts(ticker, gameDays);
    /* ★공정가에는 «전부»(추정 + 조회) 들어간다 — 그래야 이벤트 방향으로 공짜 이득이 안 생긴다.
       ★[2026-09-05] 식을 여기서 «쓰지 않는다» — `forwardFairPrice` 하나가 만든다.
       ⛔`ref * (1 + c.total)` 로 되돌리지 마라: 옵션이 같은 함수를 쓰기 때문에,
         여기서 손으로 다시 계산하면 두 상품의 선도가가 «또» 갈린다(이번에 고친 결함 그 자체다). */
    const fair = this.forwardFairPrice(ticker, gameDays);
    // ★마진은 «추정분»에만 — 조회값(c.event)에 배수를 물리면 상품이 못 쓰게 비싸진다
    const spBp = this.spreadBpFor(c.base, FORWARD_SPREAD_BP);
    const rng = new Rng((sessionSeed ^ 0x9e3779b9) >>> 0);
    const dir = side === 'long' ? 1 : -1;
    const out: CounterQuote[] = [];
    for (const st of this.pickArchetypes(rng, QUOTE_COUNT)) {
      const epsBp = (ARCHETYPE_VIEW_BIAS_BP[st] ?? 0) + rng.gauss() * QUOTE_NOISE_SD_BP;
      const price = fair * (1 + epsBp / 1e4) * (1 + (dir * spBp) / 1e4);
      const names = this.strategyNicknames(st);
      out.push({
        strategy: st as BotStrategy,
        nickname: names.length ? names[rng.int(names.length)] : st,
        price: Math.max(MIN_PRICE, price),
        vsFairBp: dir * (price / fair - 1) * 1e4,
      });
    }
    out.sort((x, y) => x.vsFairBp - y.vsFairBp);
    return out;
  }

  // ── 선도 ──────────────────────────────────────────────────────────────
  forwardEquity(pos: ForwardPosition): number {
    const S = this.engine.refPrice(pos.ticker, FORWARD_REF_VWAP_TICKS);
    const dir = pos.side === 'long' ? 1 : -1;
    return pos.margin + (S - pos.contractPrice) * pos.qty * dir;
  }

  /**
   * 선도 개시. 만기는 FORWARD_EXPIRY_GAME_DAYS «고정»이다(선택 인자가 없다).
   *
   * ★⛔orderFlow 를 «넣지 않는다». 현물 매매가 아니라 상대와의 현금정산 계약이다.
   *   넣으면 «체결가에 자기 임팩트를 물지 않으면서 가격만 미는» 경로가 생겨
   *   fillPrice 로 막아둔 자가펌핑이 선도를 통해 되살아난다.
   * ★수수료를 따로 받지 «않는다» — 마찰은 스프레드로 한 번만 걷는다(이중부과 금지).
   */
  openForward(
    accountId: string,
    ticker: string,
    side: LevSide,
    notional: number,
    sessionSeed: number,
    quoteIndex = 0
  ) {
    const acc = this.getAccount(accountId);
    /* ★연체 중(현금 음수)에는 «신규 파생 개시»가 없다 (President 2026-09-05).
       ⛔청산·정산은 막지 않는다 — 그게 연체를 갚는 길이다. */
    this.assertNotOverdrawn(acc);
    this.instrumentOf(ticker);
    if (!Number.isFinite(notional) || notional <= 0) throw new GameError('BAD_NOTIONAL', 'notional must be > 0');
    /*
     * ⛔[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
     *   여기 있던 `this.assertOrderSize(ticker, notional)` 를 «제거»했다. 되살리지 마라.
     * ★현물(`placeSpotOrder`)의 검사는 «그대로 남아 있다» — 지시는 「파생」이다.
     * ★상한이 사라져도 «무마찰»이 되는 것은 아니다: 체결가는 여전히 `fillPrice` 를 거치고
     *   그 임팩트는 `priceImpactFrac` = ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1) 다.
     *   ⇒ 깊이를 넘는 주문일수록 «자기 체결가가 불리해져» 자연히 제동이 걸린다.
     *   ⛔`priceImpactFrac`·`maxOrderNotional` 함수 자체는 지우지 마라 — 봇·중앙은행이 쓴다.
     */
    const quotes = this.quotesFor(ticker, side, sessionSeed);
    const q = quotes[Math.max(0, Math.min(quoteIndex, quotes.length - 1))];
    if (!q) throw new GameError('NO_QUOTE', 'no counterparty quote');
    const margin = notional * FORWARD_MARGIN_RATIO;
    if (acc.cash < margin)
      throw new GameError('INSUFFICIENT_CASH', `need ${margin.toFixed(2)}, have ${acc.cash.toFixed(2)}`);
    acc.cash -= margin;
    acc.tradeCount++;
    const pos: ForwardPosition = {
      id: nextId('fwd'),
      ticker,
      side,
      notional,
      qty: notional / q.price,
      contractPrice: q.price,
      refPrice: this.engine.refPrice(ticker, FORWARD_REF_VWAP_TICKS),
      margin,
      counterparty: q.strategy,
      openedTick: this.tick,
      expiryTick: this.tick + FORWARD_EXPIRY_GAME_DAYS * TICKS_PER_GAME_DAY,
      feePaid: 0,
    };
    acc.fwdPositions.set(pos.id, pos);
    this.trackPositions(acc);   // ★P1 색인 — 빠뜨리면 청산·정산이 조용히 안 돈다
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, position: pos, quotes };
  }

  /** 선도 청산(중도 또는 만기). 정산가는 «중앙값 기준가» — 마지막 틱 펌프를 막는다 */
  closeForward(accountId: string, positionId: string, forced = false) {
    const acc = this.getAccount(accountId);
    const pos = acc.fwdPositions.get(positionId);
    if (!pos) throw new GameError('NO_POSITION', `unknown forward ${positionId}`);
    const S = this.engine.refPrice(pos.ticker, FORWARD_REF_VWAP_TICKS);
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (S - pos.contractPrice) * pos.qty * dir;
    const returned = Math.max(0, pos.margin + pnl);
    acc.cash += returned;
    acc.realizedPnl += returned - pos.margin;
    if (forced) acc.liquidationCount++;
    acc.fwdPositions.delete(pos.id);
    return { ok: true as const, tick: this.tick, positionId, pnl, returned, forced, cashAfter: acc.cash };
  }

  settleExpiredForwards(): number {
    let n = 0;
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.fwdPositions.size === 0) continue;
      for (const pos of [...acc.fwdPositions.values()]) {
        if (this.tick < pos.expiryTick) continue;
        const r = this.closeForward(acc.id, pos.id, false);
        this.emit({
          type: 'settled', kind: 'forward', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
          positionId: pos.id, ticker: pos.ticker, pnl: r.returned - pos.margin, returned: r.returned,
          forced: false, tick: this.tick,
        });
        n++;
      }
    }
    return n;
  }

  // ── 스왑 ──────────────────────────────────────────────────────────────
  /**
   * 스왑 평가 — 「A 수익률 − B 수익률 − 계약 캐리스프레드」에 명목을 곱한다.
   * ★시장 방향과 «무관»한 유일한 상품이다. 감쇠로 방향성이 약해진 시장에서도 살아남는다.
   * ★정통 IRS(고정 대 변동)를 안 쓴 이유: r=0 이라 변동금리 다리의 기준이 «존재하지 않는다».
   */
  swapEquity(pos: SwapPosition): number {
    const a = this.engine.refPrice(pos.tickerA, FORWARD_REF_VWAP_TICKS);
    const b = this.engine.refPrice(pos.tickerB, FORWARD_REF_VWAP_TICKS);
    const rel = a / pos.entryA - b / pos.entryB - pos.carrySpread;
    const dir = pos.side === 'a' ? 1 : -1;
    return pos.margin + pos.notional * rel * dir;
  }

  /** 스왑 호가 — 가격이 아니라 «상대 캐리스프레드»를 부른다 */
  swapQuotesFor(tickerA: string, tickerB: string, side: 'a' | 'b', sessionSeed: number): CounterQuote[] {
    const ca = this.carryParts(tickerA, FORWARD_EXPIRY_GAME_DAYS);
    const cb = this.carryParts(tickerB, FORWARD_EXPIRY_GAME_DAYS);
    // ★계약에 실리는 상대 캐리는 «전부», 마진은 «추정분 차이»에만 — 선도와 같은 원칙이다
    const relCarry = ca.total - cb.total;
    const spBp = this.spreadBpFor(ca.base - cb.base, SWAP_SPREAD_BP);
    const rng = new Rng((sessionSeed ^ 0x85ebca6b) >>> 0);
    const dir = side === 'a' ? 1 : -1;
    const out: CounterQuote[] = [];
    for (const st of this.pickArchetypes(rng, QUOTE_COUNT)) {
      const epsBp = (ARCHETYPE_VIEW_BIAS_BP[st] ?? 0) + rng.gauss() * QUOTE_NOISE_SD_BP;
      const cs = relCarry + (dir * (spBp + epsBp)) / 1e4;
      const names = this.strategyNicknames(st);
      out.push({
        strategy: st as BotStrategy,
        nickname: names.length ? names[rng.int(names.length)] : st,
        price: cs,
        vsFairBp: dir * (cs - relCarry) * 1e4,
      });
    }
    out.sort((x, y) => x.vsFairBp - y.vsFairBp);
    return out;
  }

  openSwap(
    accountId: string,
    tickerA: string,
    tickerB: string,
    side: 'a' | 'b',
    notional: number,
    sessionSeed: number,
    quoteIndex = 0
  ) {
    const acc = this.getAccount(accountId);
    if (tickerA === tickerB) throw new GameError('SAME_TICKER', 'pick two different stocks');
    /* ★연체 중(현금 음수)에는 «신규 파생 개시»가 없다 (President 2026-09-05).
       ⛔청산·정산은 막지 않는다 — 그게 연체를 갚는 길이다. */
    this.assertNotOverdrawn(acc);
    this.instrumentOf(tickerA);
    this.instrumentOf(tickerB);
    if (!Number.isFinite(notional) || notional <= 0) throw new GameError('BAD_NOTIONAL', 'notional must be > 0');
    /*
     * ⛔[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
     *   여기 있던 `this.assertOrderSize(tickerA/tickerB, notional)` 를 «제거»했다. 되살리지 마라.
     * ★현물(`placeSpotOrder`)의 검사는 «그대로 남아 있다» — 지시는 「파생」이다.
     * ★상한이 사라져도 «무마찰»이 되는 것은 아니다: 체결가는 여전히 `fillPrice` 를 거치고
     *   그 임팩트는 `priceImpactFrac` = ORDER_FLOW_WEIGHT × clip(명목/깊이, −1, 1) 다.
     *   ⇒ 깊이를 넘는 주문일수록 «자기 체결가가 불리해져» 자연히 제동이 걸린다.
     *   ⛔`priceImpactFrac`·`maxOrderNotional` 함수 자체는 지우지 마라 — 봇·중앙은행이 쓴다.
     */
    const quotes = this.swapQuotesFor(tickerA, tickerB, side, sessionSeed);
    const q = quotes[Math.max(0, Math.min(quoteIndex, quotes.length - 1))];
    if (!q) throw new GameError('NO_QUOTE', 'no counterparty quote');
    const margin = notional * FORWARD_MARGIN_RATIO;
    if (acc.cash < margin)
      throw new GameError('INSUFFICIENT_CASH', `need ${margin.toFixed(2)}, have ${acc.cash.toFixed(2)}`);
    acc.cash -= margin;
    acc.tradeCount++;
    const pos: SwapPosition = {
      id: nextId('swp'),
      tickerA,
      tickerB,
      side,
      notional,
      entryA: this.engine.refPrice(tickerA, FORWARD_REF_VWAP_TICKS),
      entryB: this.engine.refPrice(tickerB, FORWARD_REF_VWAP_TICKS),
      carrySpread: q.price,
      margin,
      counterparty: q.strategy,
      openedTick: this.tick,
      expiryTick: this.tick + FORWARD_EXPIRY_GAME_DAYS * TICKS_PER_GAME_DAY,
      feePaid: 0,
    };
    acc.swapPositions.set(pos.id, pos);
    this.trackPositions(acc);   // ★P1 색인 — 빠뜨리면 청산·정산이 조용히 안 돈다
    this.stats.orders++;
    return { ok: true as const, tick: this.tick, position: pos, quotes };
  }

  closeSwap(accountId: string, positionId: string, forced = false) {
    const acc = this.getAccount(accountId);
    const pos = acc.swapPositions.get(positionId);
    if (!pos) throw new GameError('NO_POSITION', `unknown swap ${positionId}`);
    const returned = Math.max(0, this.swapEquity(pos));
    acc.cash += returned;
    acc.realizedPnl += returned - pos.margin;
    if (forced) acc.liquidationCount++;
    acc.swapPositions.delete(pos.id);
    return {
      ok: true as const,
      tick: this.tick,
      positionId,
      pnl: returned - pos.margin,
      returned,
      forced,
      cashAfter: acc.cash,
    };
  }

  settleExpiredSwaps(): number {
    let n = 0;
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.swapPositions.size === 0) continue;
      for (const pos of [...acc.swapPositions.values()]) {
        if (this.tick < pos.expiryTick) continue;
        const r = this.closeSwap(acc.id, pos.id, false);
        this.emit({
          type: 'settled', kind: 'swap', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
          positionId: pos.id, ticker: pos.tickerA, tickerB: pos.tickerB,
          pnl: r.returned - pos.margin, returned: r.returned, forced: false, tick: this.tick,
        });
        n++;
      }
    }
    return n;
  }

  /** ★선물 = 레버리지 + 만기. expiryTick 이 없으면 «무기한»이라 건드리지 않는다 */
  settleExpiredFutures(): number {
    let n = 0;
    for (const acc of this.positionHolders()) {   // ★P1: 전 계정 -> 포지션 보유 계정만
      if (acc.levPositions.size === 0) continue;
      for (const pos of [...acc.levPositions.values()]) {
        if (pos.expiryTick === undefined || this.tick < pos.expiryTick) continue;
        const r = this.closeLeverage(acc.id, pos.id, false);
        /* ★closeLeverage 는 'lev_closed' 도 흘린다(홈 피드용). 이건 «만기»임을 알리는 별개 채널이다 */
        this.emit({
          type: 'settled', kind: 'futures', accountId: acc.id, nickname: acc.nickname, isBot: acc.isBot,
          positionId: pos.id, ticker: pos.ticker, pnl: r.returned - pos.margin, returned: r.returned,
          forced: false, tick: this.tick,
        });
        n++;
      }
    }
    return n;
  }

  // ── 랭킹 ──────────────────────────────────────────────────────────────
  /**
   * ★«투입 원금» — 수익률의 분모다. ★이 식은 «여기 한 벌»만 존재한다.
   *
   *   seedCash × (1 + 충전 횟수)   +   충전 외 경로로 주입된 현금(bonusSeed)
   *
   * ★왜 함수인가 (U-4 「주석은 막지 못한다」의 적용):
   *   같은 식이 랭킹·홈·충전화면에 «네 벌» 있었다. 한 벌만 고치면
   *   「랭킹 수익률과 홈 수익률이 다른」 상태가 되고 ★에러는 나지 않는다.
   *   ⇒ 랭킹은 여기서, 화면은 `Portfolio.investedBase` 로 «같은 값»을 받는다.
   * ⛔현금을 늘리면서 이 분모를 안 늘리는 지급 경로를 만들지 마라 —
   *   그 순간 「충전만으로 수익률 +1000%」가 된다(constants.ts 의 오래된 경고).
   */
  investedBase(acc: Account): number {
    return acc.seedCash * (1 + acc.topupCount) + acc.bonusSeed;
  }

  /**
   * 자산평가액 내림차순 (ARCHITECTURE.md 8장).
   *
   * [정적 빌드 추가] `alwaysInclude`: 상위 size 명에 안 들어도 그 계정 행은 붙여준다.
   * 봇 시드가 플레이어(1만)보다 크기 때문에(노이즈 2만 ~ 화이트웨일 200만)
   * 초반 플레이어는 200위권이다 — 목업도 "랭킹 187위"를 전제로 그려져 있다
   * (design/ui_spec.md:143). 내 행이 아예 없으면 MyRankBar 가 죽으므로 붙인다.
   * 순위 숫자는 전체 기준 실제 순위 그대로다(가공하지 않는다).
   */
  computeLeaderboard(size = Number.POSITIVE_INFINITY, humansOnly = false, alwaysInclude?: string): RankEntry[] {
    const rows: RankEntry[] = [];
    for (const acc of this.accounts.values()) {
      if (humansOnly && acc.isBot) continue;
      /* ★[2026-09-05] 랭킹 기준을 «순자산»으로 바꿨다(President 「순자산 기준으로」).
         ⛔`equity()` 로 되돌리지 마라 — 대출을 받으면 총자산은 그대로인데 현금만 늘어
           「빌려서 순위 올리기」가 된다. 봇은 대출을 안 하므로 봇 행은 값이 «완전히 동일»하다. */
      const eq = this.netWorth(acc);
      /*
       * [정적 빌드 수정] 수익률 분모를 **계정별 시드**로 바꿨다.
       * 서버 원본: `SEED_CASH * (1 + topupCount)` — 모든 계정에 1만을 분모로 썼다.
       * 그 결과 시드 200만인 화이트웨일이 손실 중에도 "+19,900%" 로 표시됐다.
       * 랭킹 화면에 "수익률순" 정렬 칩이 있으므로(ui_spec 3.5) 그대로 두면
       * 정렬 자체가 시드 크기순이 되어 의미가 없다.
       * 플레이어는 seedCash = SEED_CASH 라 서버와 값이 완전히 동일하다(무영향).
       * 자산 순위·체결·청산 등 게임 경제에는 아무 영향이 없는 표시 계층 수정이다.
       */
      const base = this.investedBase(acc);
      rows.push({
        rank: 0,
        accountId: acc.id,
        nickname: acc.nickname,
        isBot: acc.isBot,
        equity: eq,
        pnlPct: base > 0 ? (eq / base - 1) * 100 : 0,
      });
    }
    rows.sort((a, b) => b.equity - a.equity);
    rows.forEach((r, i) => (r.rank = i + 1));
    if (!Number.isFinite(size) || rows.length <= size) return rows;
    const top = rows.slice(0, size);
    if (alwaysInclude && !top.some((r) => r.accountId === alwaysInclude)) {
      const mine = rows.find((r) => r.accountId === alwaysInclude);
      if (mine) top.push(mine);
    }
    return top;
  }
}
