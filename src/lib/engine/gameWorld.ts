/**
 * GameWorld — 화면이 붙는 단일 게임 파사드.
 *
 * 서버 `world/gameService.ts`(World + 봇 + DB + 틱루프) 에 해당한다.
 * 정적 단독 빌드에는 서버가 없으므로 이 클래스가 게임의 전부다:
 *   World(체결·청산·랭킹) + BotEngine(봇 210) + localStorage(영속) + 충전 규칙.
 *
 * 구 mockWorld.ts 를 대체한다. "오프라인 폴백"이 아니라 **이게 본체다** —
 * 연결 상태·연습 데이터 같은 개념은 존재하지 않는다.
 */
import {
  BANKRUPT_EQUITY_THRESHOLD,
  BP,
  LOAN_DELINQUENT_PENALTY_BP,
  LOAN_OVERDRAFT_PENALTY_BP,
  LOAN_SPREAD_BP,
  LOCAL_ACCOUNT_ID,
  PUBLIC_PORTFOLIO_DELAY_MS,
  SEED_CASH,
  SHARE_REWARD_DAILY_MAX,
  SHARE_REWARD_MAX_USD,
  SHARES_PER_CONTRACT,
  SNAPSHOT_EVERY_TICKS,
  FORWARD_EXPIRY_GAME_DAYS,
  FORWARD_REF_VWAP_TICKS,
  TICKS_PER_GAME_DAY,
  TOPUP_AD_BONUS_MAX,
  TOPUP_AMOUNT,
  TOPUP_COOLDOWN_MS,
  TOPUP_DAILY_LIMIT,
  TRADER_VIEW_AD_BONUS_MAX,
  TRADER_VIEW_DAILY_LIMIT,
  WARMUP_TICKS,
} from '../constants';
import { loadBasketMetas, loadBots, loadInstruments, loadTickerMeta } from './data';
import { BotEngine } from './bots';
import { buildIndexes } from './indexBasket';
import { Rng } from './rng';
import { GameError, World, type WorldEvent } from './world';
import type { LoanKind } from './types';
/* ★KST 날짜 정본 — 이식 단위는 `lib/daykey.ts` «파일 하나»다 */
import { kstDateKey } from '../daykey';
import {
  clearGame,
  loadGame,
  saveGame,
  SAVE_VERSION,
  type SavedAccount,
  type SavedGame,
  type SavedTopup,
  type SavedDaily,
  emptyDaily,
} from './persistence';
import type {
  Account,
  BotStrategy,
  CounterQuote,
  ForwardView,
  LevSide,
  OptionKind,
  Side,
  SwapView,
} from './types';
import type { CentralBankView, DailyStatus, FeedItem, Portfolio, PublicPortfolio, Quote, RankEntry, TopupStatus } from '../types';

export { GameError };

/** KST 날짜키 'YYYY-MM-DD' — 충전 카운터 리셋 기준(ARCHITECTURE 4장, 서버 db.ts:26-31) */
/**
 * KST 날짜키 — ★정본은 `src/lib/daykey.ts` 다. 여기는 «재수출»이다.
 * ⛔여기에 구현을 되살리지 마라. 그 순간 두 벌이 된다.
 */
export { kstDateKey };

/**
 * 세션 시드.
 *  - 기본: 매 세션 다른 시드 -> 장세가 매번 다르다.
 *    (구 mockWorld.ts:113 은 rng(20260802) 하드코딩이라 누가 언제 켜도 완전히 같은 장이었다.)
 *  - 디버그: `?seed=12345` 쿼리스트링 또는 localStorage `ml.seed` 로 고정할 수 있다.
 *    재현이 필요한 QA/버그리포트용이며 정상 플레이 경로에는 영향이 없다.
 */
export function resolveSeed(): number {
  try {
    const q = new URLSearchParams(window.location.search).get('seed');
    if (q && Number.isFinite(Number(q))) return Number(q) >>> 0;
    const ls = window.localStorage?.getItem('ml.seed');
    if (ls && Number.isFinite(Number(ls))) return Number(ls) >>> 0;
  } catch {
    /* 접근 불가 환경 — 랜덤 시드로 간다 */
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

/**
 * 보너스 현금 지급 «종류». 리터럴 유니언이라 오타가 타입에서 죽는다.
 * ★새 지급 경로를 만들 때는 여기 종류를 «추가»하고 `grantBonusCash` 를 거쳐라.
 *   ⛔현금을 직접 더하는 새 함수를 만들지 마라 — 수익률 분모가 조용히 어긋난다.
 */
export type BonusCashKind = 'share' | 'attendance';

/**
 * 보너스 현금 «1회» 상한 (종류별).
 * ★일일 «횟수» 상한은 종류마다 규칙이 달라 «호출자 책임»으로 남긴다(합의된 경계).
 *   여기 있는 것은 「한 번에 이보다 많이 줄 수 없다」는 금액 상한뿐이다.
 * ⛔값을 올리려면 그 종류의 하루 총량이 다른 경로와 어긋나지 않는지 먼저 확인하라.
 */
const BONUS_CASH_CAP: Record<BonusCashKind, number> = {
  share: SHARE_REWARD_MAX_USD,
  attendance: SHARE_REWARD_MAX_USD,
};

export interface GameWorldOptions {
  seed?: number;
  nickname?: string;
  warmupTicks?: number;
  /** 저장된 진행 상황을 무시하고 새로 시작 */
  fresh?: boolean;
}

export class GameWorld {
  readonly world: World;
  readonly bots: BotEngine;
  readonly seed: number;
  readonly playerId = LOCAL_ACCOUNT_ID;
  nickname: string;
  feed: FeedItem[] = [];

  /** 내 포지션이 강제청산될 때 (store 가 시트를 띄운다) */
  onLiquidation: ((ticker: string, leverage: number, side: LevSide, loss: number, returned: number) => void) | null = null;
  /** 내 옵션이 만기 정산될 때 */
  onOptionSettled: ((ticker: string, payoff: number) => void) | null = null;

  private readonly warmupTicks: number;
  private readonly saved: SavedGame | null;
  private readonly uiRng: Rng;
  private topupState: SavedTopup;
  private dailyState: SavedDaily;
  /**
   * 공개용 포트폴리오 스냅샷 2장 — 「10분 지연」을 «실제로» 구현하는 장치.
   *
   * ★ 왜 2장뿐인가(메모리·프레임 예산): 210계정 × 보유종목의 이력을 통째로
   *   들고 있으면 수십 MB 가 된다. 그래서 «지금 뜬 것(pending)» 과
   *   «공개 중인 것(published)» 딱 두 장만 유지하고, PUBLIC_DELAY_MS 가
   *   지날 때마다 자리를 바꾼다. 스냅샷을 뜨는 비용은 10분에 한 번뿐이라
   *   틱 루프(2초)에 실질적으로 얹히지 않는다.
   * ★ 결과적으로 공개 데이터는 «10~20분 전» 것이다. 즉 「10분 지연」은
   *   최소 보장이며 실제로는 그보다 더 오래됐다. 화면 문구도 그렇게 적는다.
   */
  private publishedSnap: Map<string, PublicPortfolio> | null = null;
  private pendingSnap: Map<string, PublicPortfolio> | null = null;
  private snapRotatedAt = 0;
  private warmed = false;
  private feedId = 0;
  private ticksSinceSave = 0;

  constructor(opts: GameWorldOptions = {}) {
    this.seed = opts.seed ?? resolveSeed();
    this.warmupTicks = opts.warmupTicks ?? WARMUP_TICKS;
    this.saved = opts.fresh ? null : loadGame();
    this.nickname = opts.nickname ?? '';
    this.uiRng = new Rng(this.seed ^ 0x5bf03635);
    this.topupState = this.saved?.topup ?? { dateKey: kstDateKey(), usedToday: 0, lastTopupAt: 0 };
    // ★ 기존 저장본에는 daily 키가 «없다». undefined 로 들어와도 NaN 이 안 나게 기본값.
    this.dailyState = this.saved?.daily ?? emptyDaily(kstDateKey());

    const instruments = loadInstruments();
    this.world = new World({ instruments, seed: this.seed, tickerMeta: loadTickerMeta() });
    /*
     * ★지수 배선 (President 지시 ③ 「가중합을 추종하도록」).
     *   여기 등록된 티커는 priceEngine 에서 GBM 을 «타지 않고» 구성종목 가중합으로 값이 정해진다.
     * ★데이터에 지수가 없으면 이 Map 이 비고, 그러면 «동작이 전혀 바뀌지 않는다»(회귀 0).
     * ⛔되먹임 없음 — 지수 주문은 구성종목을 «밀지 않는다». 근거는 indexBasket.ts 머리주석.
     */
    for (const [tk, def] of buildIndexes(instruments, loadBasketMetas())) {
      this.world.engine.indexes.set(tk, def);
    }
    this.bots = new BotEngine(loadBots(), (this.seed + 777) >>> 0);
    this.bots.attach(this.world);

    // 플레이어 계정 — 봇과 같은 World 안의 하나의 계정이다(같은 파이프라인).
    this.world.createAccount(this.playerId, this.nickname || '나', false, SEED_CASH);

    this.world.on((e) => this.onWorldEvent(e));
  }

  // ── 워밍업 / 복원 ────────────────────────────────────────────────────
  /**
   * 시장 워밍업 3000틱(서버 index.ts:14 동일). 첫 프레임을 그린 뒤 1회만 돈다.
   * 이 3000틱 동안 봇 210개가 실제로 매매하면서
   *   (1) 가격 히스토리(차트·이평선)를 채우고
   *   (2) 봇들의 자산 격차를 실매매 결과로 벌린다.
   * 저장본이 있으면 워밍업이 끝난 뒤 가격 곡선을 저장 시점 가격으로 평행이동하고
   * 내 계좌를 복원한다 -> 유저 입장에서 가격·자산이 이어진다.
   */
  warmup(): void {
    while (!this.warmupChunk(this.warmupTicks)) {
      /* 한 번에 끝난다 — ensureWarm() 안전망 전용 동기 경로 */
    }
  }

  /** 워밍업 진행률 0~1 (부팅 화면 표시용) */
  get warmupProgress(): number {
    return this.warmed ? 1 : Math.min(1, this.warmProgress / this.warmupTicks);
  }

  /**
   * 워밍업을 «조금씩» 돌린다. 다 끝났으면 true.
   *
   * ★왜 나누는가: 3,000틱을 한 루프로 돌리면 그동안 메인 스레드가 통째로 멈춘다.
   *   봇 레인 실측(폰 추정): 210명 1.8초 → 3,310명 ★3.5초. 그 시간 동안 앱은
   *   탭도 스크롤도 먹지 않는다(OS 가 「응답 없음」으로 볼 수 있는 길이다).
   * ★★그런데 «그냥 나누기만» 하면 더 나빠진다: 저장본 복원(restore)은 워밍업이
   *   «끝난 뒤»에 일어나므로, 나누는 동안 화면은 시드 $10,000 을 보여 준다.
   *   멈춰 있을 때는 못 보던 것이 이제 «만질 수 있는 상태»로 보인다 —
   *   유저는 「내 돈이 날아갔다」로 읽고, 그 상태에서 주문까지 낼 수 있다.
   *   ⇒ 그래서 store 가 «부팅 화면»으로 덮고 끝나면 걷는다. 나누는 것과 한 쌍이다.
   */
  warmupChunk(ticks: number): boolean {
    if (this.warmed) return true;
    this.world.muted = true;
    try {
      const end = Math.min(this.warmupTicks, this.warmProgress + Math.max(1, ticks));
      for (let i = this.warmProgress; i < end; i++) this.world.step();
      this.warmProgress = end;
    } finally {
      // 중간에 터져도 음소거가 남으면 이후 피드·강제청산 알림이 전부 죽는다
      this.world.muted = false;
    }
    if (this.warmProgress < this.warmupTicks) return false;
    this.warmed = true;
    if (this.saved) this.restore(this.saved);
    return true;
  }

  /** 워밍업으로 이미 돈 틱 수 (청크 재개 지점) */
  private warmProgress = 0;

  private ensureWarm(): void {
    if (!this.warmed) this.warmup();
  }

  private restore(s: SavedGame): void {
    // 1) 가격 연속성 — 워밍업으로 만들어진 곡선을 저장 시점 가격에 맞춰 평행이동
    for (const [ticker, price] of Object.entries(s.prices)) {
      const f = this.world.engine.rescaleTo(ticker, price);
      if (f !== 1) this.rescaleAccounts(ticker, f);
    }
    // 2) 게임일 연속성 — 틱 카운터를 이어받고 봇 포지션의 틱 기준도 같이 민다
    if (s.tick > this.world.tick) {
      const delta = s.tick - this.world.tick;
      this.world.tick = s.tick;
      this.rebaseTicks(delta);
    }
    // 3) 내 계좌 복원
    this.deserialize(this.world.getAccount(this.playerId), s.account);
  }

  /** 가격을 f 배 옮겼으면 그 종목에 물린 원가·진입가·행사가도 같이 옮겨야 손익이 보존된다 */
  private rescaleAccounts(ticker: string, f: number): void {
    for (const acc of this.world.accounts.values()) {
      const h = acc.holdings.get(ticker);
      if (h) h.avgCost *= f;
      for (const p of acc.levPositions.values()) {
        if (p.ticker !== ticker) continue;
        p.entryPrice *= f;
        p.qty /= f;
      }
      for (const p of acc.optPositions.values()) {
        if (p.ticker !== ticker) continue;
        p.strike *= f;
        p.premiumPaid *= f;
        /*
         * ★매도 포지션의 증거금도 «가격 단위»다 — 평가식이 (margin − mark) 인데
         *   mark 만 f 배 되고 margin 이 그대로면 복귀 직후 손익이 통째로 어긋난다.
         */
        if (p.margin !== undefined) p.margin *= f;
      }
      /*
       * ★선도 — 계약가·기준가는 가격이라 f 배, 수량은 명목을 보존하려고 f 로 나눈다.
       *   (S − contractPrice) × qty 가 그대로 유지된다. margin 은 «예치한 현금»이라 손대지 않는다
       *   — 레버리지 margin 을 안 건드리는 것과 같은 원칙이다.
       */
      for (const p of acc.fwdPositions.values()) {
        if (p.ticker !== ticker) continue;
        p.contractPrice *= f;
        p.refPrice *= f;
        p.qty /= f;
      }
      /*
       * ★스왑 — 두 다리 «각각» 자기 종목일 때만 진입가를 옮긴다.
       *   평가가 a/entryA − b/entryB 라 분자·분모가 같이 f 배 되면 비율이 보존된다.
       */
      for (const p of acc.swapPositions.values()) {
        if (p.tickerA === ticker) p.entryA *= f;
        if (p.tickerB === ticker) p.entryB *= f;
      }
    }
  }

  /** 워밍업 중 열린 봇 포지션의 틱 기준을 delta 만큼 민다 (펀딩비·만기 계산 보존) */
  private rebaseTicks(delta: number): void {
    for (const acc of this.world.accounts.values()) {
      for (const p of acc.levPositions.values()) {
        p.openedTick += delta;
        p.lastFundingTick += delta;
      }
      for (const p of acc.optPositions.values()) {
        p.openedTick += delta;
        p.expiryTick += delta;
      }
    }
  }

  // ── 저장 ─────────────────────────────────────────────────────────────
  private serialize(acc: Account): SavedAccount {
    return {
      cash: acc.cash,
      holdings: [...acc.holdings.entries()],
      levPositions: [...acc.levPositions.values()],
      optPositions: [...acc.optPositions.values()],
      fwdPositions: [...acc.fwdPositions.values()],
      swapPositions: [...acc.swapPositions.values()],
      realizedPnl: acc.realizedPnl,
      feesPaid: acc.feesPaid,
      tradeCount: acc.tradeCount,
      liquidationCount: acc.liquidationCount,
      topupCount: acc.topupCount,
      bonusSeed: acc.bonusSeed,
      /* ★대출 (2026-09-05). 구 저장본엔 없던 키다 — 대출이 0건이면 빈 배열이라 무해하다 */
      loans: [...acc.loans.values()],
      delinquencyCount: acc.delinquencyCount ?? 0,
      /* ★마이너스 계좌 «상태»(금리·시점). 잔액은 위 `cash` 가 음수인 것 그 자체다 */
      overdraft: acc.overdraft ?? null,
      bankruptcyCount: acc.bankruptcyCount ?? 0,
    };
  }

  private deserialize(acc: Account, s: SavedAccount): void {
    acc.cash = s.cash;
    acc.holdings = new Map(s.holdings);
    acc.levPositions = new Map(s.levPositions.map((p) => [p.id, p]));
    acc.optPositions = new Map(s.optPositions.map((p) => [p.id, p]));
    /* ★기존 저장본엔 키가 «없다». persistence 가 빈 배열로 채워 주지만 여기서도 방어한다 */
    acc.fwdPositions = new Map((s.fwdPositions ?? []).map((p) => [p.id, p]));
    acc.swapPositions = new Map((s.swapPositions ?? []).map((p) => [p.id, p]));
    acc.realizedPnl = s.realizedPnl;
    acc.feesPaid = s.feesPaid;
    acc.tradeCount = s.tradeCount;
    acc.liquidationCount = s.liquidationCount;
    acc.topupCount = s.topupCount;
    /* ★기존 저장본엔 키가 «없다» — 0 이 기본값이다(SAVE_VERSION 불변) */
    acc.bonusSeed = s.bonusSeed ?? 0;
    /* ★대출 (2026-09-05). 2026-09-05 이전 저장본엔 키가 «없다» → 빈 Map = 대출 없음.
       ⇒ 순자산 = 총자산이 되어 «지금까지와 완전히 같은 게임»이다(check_loans 가 증명). */
    acc.loans = new Map((s.loans ?? []).map((l) => [l.id, l]));
    acc.delinquencyCount = s.delinquencyCount ?? 0;
    acc.bankruptcyCount = s.bankruptcyCount ?? 0;
    acc.overdraft = s.overdraft ?? null;
    /*
     * ★★현금이 음수인데 «연체 상태»가 없으면 여기서 만들어 준다.
     *   ⛔안 만들면 이자가 «영원히 안 붙는» 마이너스 계좌가 된다 — 즉 공짜 무이자 대출이다.
     *   (구 저장본이 펀딩비 초과로 음수인 경우도 여기로 들어온다. 그건 원래 있던 상태이고,
     *    이제부터는 연체금리가 붙는 것이 맞다 — 「빌린 돈」이 아니어도 마이너스는 마이너스다.)
     */
    if (acc.cash < 0 && !acc.overdraft) {
      acc.overdraft = {
        spreadBp: LOAN_SPREAD_BP[this.world.creditGrade(acc)].unsecured + LOAN_OVERDRAFT_PENALTY_BP,
        sinceDay: this.world.gameDay,
        lastAccrualDay: this.world.gameDay,
      };
    }
    /*
     * ⛔★P1 색인 등록 — «빠뜨리면 조용히 안 돈다».
     *   위에서 levPositions·optPositions·fwdPositions·swapPositions 를 «새 Map 으로 갈아끼웠다».
     *   즉 이 경로는 world.openLeverage 등 «개시 경로를 타지 않는다».
     *   등록하지 않으면 복원된 유저의 포지션이 checkLiquidations·settleExpired* 스캔에
     *   ★영영 안 잡혀 청산도 만기정산도 «일어나지 않는다». 에러는 나지 않는다.
     *   (2026-08-22 P1 적용 중 발견 — 벤치 리허설은 저장본을 안 태워서 못 잡는 자리다)
     */
    this.world.trackPositions(acc);
  }

  /** 내 계좌 + 종목가격 저장. 실패해도 게임은 계속된다(persistence.ts 방어). */
  save(): void {
    if (!this.warmed) return;
    const prices: Record<string, number> = {};
    for (const [ticker, st] of this.world.engine.states) prices[ticker] = st.price;
    const g: SavedGame = {
      v: SAVE_VERSION,
      savedAt: Date.now(),
      tick: this.world.tick,
      account: this.serialize(this.world.getAccount(this.playerId)),
      topup: this.topupState,
      daily: this.dailyState,
      prices,
    };
    saveGame(g);
    this.ticksSinceSave = 0;
  }

  /**
   * 계정 초기화(설정 > 로그아웃).
   * 서버가 없으니 "다른 기기에서 다시 로그인" 이 성립하지 않는다 —
   * 로그아웃은 곧 처음부터 다시 시작이므로 저장본까지 지운다.
   * 시장(가격·봇)은 그대로 두고 내 계좌만 시드 상태로 되돌린다.
   */
  resetPlayer(): void {
    clearGame();
    const acc = this.me;
    acc.cash = SEED_CASH;
    acc.holdings = new Map();
    acc.levPositions = new Map();
    acc.optPositions = new Map();
    acc.fwdPositions = new Map();
    acc.swapPositions = new Map();
    acc.realizedPnl = 0;
    acc.feesPaid = 0;
    acc.tradeCount = 0;
    acc.liquidationCount = 0;
    acc.topupCount = 0;
    acc.bonusSeed = 0;
    /*
     * ★★부채와 «신용 이력»까지 지운다 — 2026-09-10 President 결정.
     *   「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」
     *
     *   발견 경위(실기기): 시즌 초기화 뒤 총자산 $9,988.27 · 부채 $14,614.00 · 순자산 −$4,625.73 · 10001위(꼴찌).
     *   포지션·손익·카운터는 전부 0 인데 «부채만» 남아 순자산이 즉시 마이너스였다.
     *   ⛔`clearGame()` 만으로는 부족하다 — 저장본은 지워도 «메모리 계좌»에 대출이 남아,
     *     이후 `step()` 의 주기 저장(SNAPSHOT_EVERY_TICKS)이 그 부채를 다시 써넣는다.
     *   ★`overdraft` 는 «금리와 시점»만 든 값이고 잔액은 `cash` 그 자체라(types.ts Account.overdraft),
     *     `cash = SEED_CASH` 로 양수가 된 이상 null 이 맞다.
     *   ★`delinquencyCount`·`bankruptcyCount` 는 «파산 탕감 경로에서는» 영구 기록이다(world.ts declareOverdraftBankruptcy).
     *     ⛔그 경로의 `bankruptcyCount += 1` 은 그대로 둔다 — 지우면 「빌리고 파산하기」가 최적 전략이 된다.
     *     다만 «계정 초기화·시즌 초기화»는 계좌를 통째로 새로 시작하는 것이라 이력까지 지운다.
     *     그래야 신용등급(`world.creditGrade`)이 최고 등급으로 돌아와 「다시 출발」이 실제로 성립한다.
     */
    acc.loans.clear();
    acc.overdraft = null;
    acc.delinquencyCount = 0;
    acc.bankruptcyCount = 0;
    acc.nickname = '나';
    this.nickname = '';
    this.topupState = { dateKey: kstDateKey(), usedToday: 0, lastTopupAt: 0 };
    this.dailyState = emptyDaily(kstDateKey());
    this.feed = [];
  }

  /**
   * ★새 시즌 — 내 계좌만 SEED_CASH 로 되돌린다(2026-08-29 President 「새 시즌 시작」 선택지).
   *
   * ★`resetPlayer()`(로그아웃) 와 «다르다»: 닉네임·세션·하루 카운터(충전·열람권)는 «그대로»다.
   *   하루 몫은 «날짜» 규칙이지 시즌 규칙이 아니다 — 새 시즌이 하루 충전을 다시 채워 주면
   *   「새 시즌 시작」이 곧 «무료 충전 13회»가 된다. 그래서 건드리지 않는다.
   * ★시장·봇·가격은 그대로다(봇과 같은 세계에서 «다시 출발»하는 것이지 세계가 바뀌는 게 아니다).
   * ★저장은 «즉시» 한다 — 초기화 뒤 죽으면 옛 잔고가 되살아난다.
   */
  resetSeason(): void {
    const acc = this.me;
    acc.cash = SEED_CASH;
    acc.holdings = new Map();
    acc.levPositions = new Map();
    acc.optPositions = new Map();
    acc.fwdPositions = new Map();
    acc.swapPositions = new Map();
    acc.realizedPnl = 0;
    acc.feesPaid = 0;
    acc.tradeCount = 0;
    acc.liquidationCount = 0;
    acc.topupCount = 0;
    acc.bonusSeed = 0;
    /* ★★부채와 신용 이력까지 지운다 — President 2026-09-10 「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」.
       근거·경위는 위 `resetPlayer()` 주석(같은 누락이 두 경로에 있었다).
       ⛔파산 탕감 경로(`world.declareOverdraftBankruptcy`)의 `bankruptcyCount += 1` 은 그대로다. */
    acc.loans.clear();
    acc.overdraft = null;
    acc.delinquencyCount = 0;
    acc.bankruptcyCount = 0;
    this.save();
  }

  /**
   * ★중앙은행 «보기» — 순위표 시트가 그린다. ⛔자산 금액·순위는 «없다»(무제한).
   *   포지션은 «현재가 평가»로, 체결은 «최근 것부터». 괴리는 엔진 값 그대로(식 복제 없음).
   */
  centralBankView(): CentralBankView {
    const w = this.world;
    const cb = w.centralBank;
    const positions = [...cb.positions.values()].map((p) => {
      /* ★[-24] `${지수}:basket` 는 구성종목 가중합 포지션 — 현재가는 그 지수의 «공정가»다 */
      const i = p.ticker.indexOf(':basket');
      const base = i > 0 ? p.ticker.slice(0, i) : p.ticker;
      const price = i > 0 ? (w.engine.fairPriceOf(base) ?? w.engine.priceOf(base)) : w.engine.priceOf(p.ticker);
      return { ticker: p.ticker, qty: p.qty, avgCost: p.avgCost, price, pnl: (price - p.avgCost) * p.qty };
    });
    const spreads = [...w.engine.indexes.keys()].map((tk) => ({
      ticker: tk,
      price: w.engine.priceOf(tk),
      fair: w.engine.fairPriceOf(tk) ?? w.engine.priceOf(tk),
      basis: w.engine.basisOf(tk),
    }));
    return { positions, fills: cb.fills.slice(0, 20), spreads, interventions: cb.interventions, threshold: cb.threshold };
  }

  // ── 틱 ───────────────────────────────────────────────────────────────
  /** 한 틱 전진 */
  step(): void {
    this.ensureWarm();
    this.world.step();
    if (++this.ticksSinceSave >= SNAPSHOT_EVERY_TICKS) this.save();
  }

  /** n틱 전진 (백그라운드 탭 복귀 시 따라잡기). 상한은 호출부에서 건다. */
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  get tick(): number {
    return this.world.tick;
  }
  get gameDay(): number {
    return this.world.gameDay;
  }

  // ── 이벤트 -> 피드 ───────────────────────────────────────────────────
  /**
   * 홈 "방금 이런 거래가 있었어요" 피드.
   * 구 mockWorld.pushFeed():220-259 는 닉네임·종목·손실액을 전부 난수로 지어냈다.
   * 여기서는 **실제로 체결된 봇 주문/청산 이벤트**만 올린다. 다만 틱당 봇 체결이
   * 20건 넘게 나오므로 표본추출한다(피드가 1초 만에 흘러가버리는 걸 막는다).
   */
  private onWorldEvent(e: WorldEvent): void {
    switch (e.type) {
      case 'trade': {
        if (!e.isBot || !this.uiRng.bool(0.03)) return;
        this.pushFeed({
          id: ++this.feedId,
          at: Date.now(),
          kind: 'trade',
          nickname: e.nickname,
          ticker: e.ticker,
          side: e.side,
          // 피드는 문장 안에 그대로 박히는 값이라 정수로 반올림한다(소수 주식수 노출 방지)
          qty: Math.max(1, Math.round(e.qty)),
        });
        return;
      }
      case 'liquidation': {
        if (e.accountId === this.playerId) {
          this.onLiquidation?.(e.ticker, e.leverage, e.side, e.loss, e.returned);
          return;
        }
        this.pushFeed({
          id: ++this.feedId,
          at: Date.now(),
          kind: 'liquidation',
          nickname: e.nickname,
          ticker: e.ticker,
          leverage: e.leverage,
          side: e.side,
          loss: Math.round(e.loss),
        });
        return;
      }
      case 'lev_closed': {
        if (e.accountId === this.playerId || e.roiPct < 2 || !this.uiRng.bool(0.35)) return;
        this.pushFeed({
          id: ++this.feedId,
          at: Date.now(),
          kind: 'gain',
          nickname: e.nickname,
          ticker: e.ticker,
          pnlPct: Number(e.roiPct.toFixed(1)),
        });
        return;
      }
      case 'option_settled': {
        if (e.accountId === this.playerId) this.onOptionSettled?.(e.ticker, e.payoff);
        return;
      }
      default:
        return;
    }
  }

  private pushFeed(item: FeedItem): void {
    this.feed.unshift(item);
    if (this.feed.length > 40) this.feed.pop();
  }

  // ── 시세 ─────────────────────────────────────────────────────────────
  priceOf(ticker: string): number {
    return this.world.engine.get(ticker)?.price ?? 0;
  }

  quote(ticker: string): Quote | null {
    const s = this.world.engine.get(ticker);
    if (!s) return null;
    return {
      ticker,
      price: s.price,
      prevPrice: s.prevPrice,
      changePct: s.prevPrice > 0 ? (s.price / s.prevPrice - 1) * 100 : 0,
      totalChangePct: s.inst.initialPrice > 0 ? (s.price / s.inst.initialPrice - 1) * 100 : 0,
      initialPrice: s.inst.initialPrice,
    };
  }

  /** 차트용 시계열 (오래된 -> 최신) */
  series(ticker: string, points: number): number[] {
    const out = this.world.engine.series(ticker, points);
    // 워밍업 전(첫 프레임)에는 히스토리가 비어 있다 — 현재가 1점이라도 준다
    return out.length ? out : [this.priceOf(ticker)];
  }

  /**
   * 차트용 «거래대금 / 순주문흐름» 시계열 (오래된 -> 최신).
   * ★series() 와 «같은 창·같은 길이»다. 길이가 어긋나면 거래량 막대가 캔들과 한 칸씩 밀린다.
   * ★세션 한정 링버퍼에서 읽는다 — 저장하지 않는다(SAVE_VERSION 무관).
   */
  flowSeries(ticker: string, points: number): { gross: number[]; net: number[] } {
    return this.world.engine.flowSeries(ticker, points);
  }

  maxOrderNotional(ticker: string): number {
    return this.world.maxOrderNotional(ticker);
  }

  sigmaOf(ticker: string): number {
    return this.world.engine.get(ticker)?.inst.sigma ?? 0.3;
  }

  // ── 주문 (플레이어) ──────────────────────────────────────────────────
  spot(ticker: string, side: Side, qty: number) {
    this.ensureWarm();
    const r = this.world.placeSpotOrder(this.playerId, ticker, side, qty);
    this.save();
    return r;
  }

  /** 주문 «직전» 보유 스냅샷 — 되돌리기가 평균단가를 정확히 복원하는 데 쓴다 */
  holdingSnapshot(ticker: string): { qty: number; avgCost: number } {
    const h = this.me.holdings.get(ticker);
    return { qty: h?.qty ?? 0, avgCost: h?.avgCost ?? 0 };
  }

  /** 되돌리기 — 현물. 성공하면 true */
  cancelSpot(snap: {
    ticker: string;
    side: Side;
    qty: number;
    gross: number;
    fee: number;
    prevQty: number;
    prevAvgCost: number;
  }): boolean {
    const ok = this.world.cancelSpot(this.playerId, snap);
    if (ok) this.save();
    return ok;
  }

  openLev(ticker: string, side: LevSide, leverage: number, margin: number) {
    this.ensureWarm();
    const r = this.world.openLeverage(this.playerId, ticker, side, leverage, margin);
    this.save();
    return r;
  }

  closeLev(positionId: string) {
    this.ensureWarm();
    const r = this.world.closeLeverage(this.playerId, positionId);
    this.save();
    return r;
  }

  /** 되돌리기 — 옵션. 성공하면 true */
  cancelOption(positionId: string): boolean {
    const ok = this.world.cancelOption(this.playerId, positionId);
    if (ok) this.save();
    return ok;
  }

  /** 되돌리기 — 레버리지. 성공하면 true */
  cancelLeverage(positionId: string): boolean {
    const ok = this.world.cancelLeverage(this.playerId, positionId);
    if (ok) this.save();
    return ok;
  }

  buyOption(ticker: string, kind: OptionKind, strike: number, expiryGameDays: number, contracts: number) {
    this.ensureWarm();
    const r = this.world.buyOption(this.playerId, ticker, kind, strike, expiryGameDays, contracts);
    this.save();
    return r;
  }

  sellOption(positionId: string) {
    this.ensureWarm();
    const r = this.world.sellOption(this.playerId, positionId);
    this.save();
    return r;
  }

  // ── 조회 ─────────────────────────────────────────────────────────────
  private get me(): Account {
    return this.world.getAccount(this.playerId);
  }

  setNickname(nickname: string): void {
    this.nickname = nickname;
    this.me.nickname = nickname;
    this.save();
  }

  equity(): number {
    return this.world.equity(this.me);
  }

  /** 서버 world.ts:499-565 portfolio() 이식 (화면 타입으로 변환) */
  portfolio(): Portfolio {
    const acc = this.me;
    const w = this.world;
    const eq = w.equity(acc);
    return {
      accountId: acc.id,
      nickname: acc.nickname,
      cash: acc.cash,
      equity: eq,
      /*
       * ★[2026-09-05] 부채·순자산 (President 지시). 화면은 세 값을 «같이» 본다:
       *   총자산(equity) − 부채(debt) = 순자산(netWorth).
       * ⛔화면이 `equity − debt` 를 손으로 빼지 마라 — 엔진 `world.netWorth()` 한 벌이 정본이고
       *   파산·랭킹·프로모션이 «그 값»을 쓴다. 두 벌이 되면 화면과 판정이 갈린다.
       */
      debt: w.loanDebt(acc),
      netWorth: w.netWorth(acc),
      /*
       * ★연체(마이너스 계좌) — 잔액은 «음수 현금» 그 자체다. 화면이 부호를 뒤집어 세지 않게
       *   엔진이 «양수»로 답한다. ⛔`Math.max(0, -cash)` 를 화면에서 다시 쓰지 마라.
       */
      overdraft: w.overdraftBalance(acc),
      overdraftRate: w.overdraftRate(acc),
      /** ★파산 «이력»(영구). 신용등급에 흉터로 남는다 */
      bankruptcyCount: acc.bankruptcyCount ?? 0,
      delinquencyCount: acc.delinquencyCount ?? 0,
      creditScore: w.creditScore(acc),
      creditGrade: w.creditGrade(acc),
      holdingsValue: w.holdingsValue(acc),
      realizedPnl: acc.realizedPnl,
      feesPaid: acc.feesPaid,
      tradeCount: acc.tradeCount,
      liquidationCount: acc.liquidationCount,
      topupCount: acc.topupCount,
      /* ★수익률 분모. ⛔화면이 `SEED_CASH * (1 + topupCount)` 로 다시 계산하지 마라 —
         공유 리워드(bonusSeed)가 빠져 랭킹 수익률과 «다른 값»이 된다(world.investedBase 한 벌). */
      investedBase: w.investedBase(acc),
      /* ★[2026-09-05] 파산 판정도 «순자산» 기준이다 — 엔진 `world.isBankrupt` 와 같은 식.
         ⛔`eq`(총자산)로 되돌리지 마라: 대출로 현금만 채운 상태가 「파산 아님」으로 읽힌다. */
      bankrupt: w.isBankrupt(acc),
      /*
       * ★대출 목록 — 화면이 상환 UI 를 그리는 데 필요한 «전부»를 여기서 준다.
       *   ⛔화면이 금리를 다시 계산하지 마라(변동금리라 매번 달라진다) — 엔진이 답한다.
       */
      loans: [...acc.loans.values()].map((l) => ({
        id: l.id,
        kind: l.kind,
        principal: l.principal,
        accruedInterest: l.accruedInterest,
        /** 지금 실효 연이자율 = 정책금리 + 가산(+연체가산). ★매 틱 다시 읽힌다 */
        rate: w.policyRate + (l.spreadBp + (l.delinquentDays > 0 ? LOAN_DELINQUENT_PENALTY_BP : 0)) * BP,
        spreadBp: l.spreadBp,
        grade: l.grade,
        delinquentDays: l.delinquentDays,
        marginCallDay: l.marginCallDay,
        interestPaid: l.interestPaid,
        openedTick: l.openedTick,
      })),
      holdings: [...acc.holdings.entries()].map(([ticker, h]) => {
        const price = w.engine.priceOf(ticker);
        return {
          ticker,
          qty: h.qty,
          avgCost: h.avgCost,
          price,
          value: h.qty * price,
          pnl: (price - h.avgCost) * h.qty,
          pnlPct: h.avgCost > 0 ? (price / h.avgCost - 1) * 100 : 0,
        };
      }),
      leverage: [...acc.levPositions.values()].map((p) => {
        const price = w.engine.priceOf(p.ticker);
        const pe = w.levPositionEquity(p);
        const mm = w.maintenanceMargin(p);
        const dir = p.side === 'long' ? 1 : -1;
        return {
          id: p.id,
          ticker: p.ticker,
          side: p.side,
          leverage: p.leverage,
          margin: p.margin,
          notional: p.notional,
          qty: p.qty,
          entryPrice: p.entryPrice,
          price,
          equity: pe,
          maintenanceMargin: mm,
          // equity == maintenanceMargin 이 되는 가격
          liquidationPrice: p.entryPrice + (mm - p.margin + w.accruedFunding(p)) / (p.qty * dir),
          funding: w.accruedFunding(p),
          pnl: pe - p.margin,
        };
      }),
      options: [...acc.optPositions.values()].map((p) => {
        const value = w.optionValue(p);
        /*
         * ★mark = «되사기 비용»(현재 프리미엄 평가액). 매수·매도 모두 같은 뜻이다.
         *   화면이 이 값을 그대로 쓰면 엔진의 프리미엄 모델(sigma·잔여만기)을 복제하지 않아도 된다.
         */
        const mark = w.optionMarkValue(p);
        const isSell = p.side === 'sell';
        return {
          id: p.id,
          ticker: p.ticker,
          kind: p.kind,
          strike: p.strike,
          contracts: p.contracts,
          premiumPaid: p.premiumPaid,
          value,
          remainGameDays: Math.max(0, (p.expiryTick - w.tick) / TICKS_PER_GAME_DAY),
          /*
           * ★손익식이 매수와 매도가 «다르다».
           *   매수: 지금 팔면 받는 값 − 낸 프리미엄 − 수수료   = mark − premiumPaid − feePaid
           *   매도: 받은 프리미엄 − 수수료 − 지금 되사는 값     = premiumPaid − feePaid − mark
           *   ★매수식을 매도에 쓰면 (margin − 2·premiumPaid) 만큼 어긋난다.
           *   ★equity() 는 optionValue() 에 sell 분기가 있어 «맞는데» 이 항목만 틀리면
           *     유저는 「총액과 항목이 안 맞는」 화면을 본다 — 더 헷갈린다.
           */
          pnl: isSell ? p.premiumPaid - p.feePaid - mark : mark - p.premiumPaid - p.feePaid,
          /** ★undefined 면 매수다 (기존 저장본 호환) */
          side: p.side,
          margin: p.margin,
          mark,
        };
      }),
    };
  }

  /**
   * 랭킹 — 자산평가액 내림차순(ARCHITECTURE 8장), 봇 210 + 나.
   * 전체 211행을 그대로 준다(ui_spec 6장 "랭킹 211행은 가상 스크롤").
   */
  // ── 파생 확장 API (2026-08-20) — ★전부 «추가»다. 기존 시그니처는 손대지 않았다 ──

  /**
   * ★주문 세션 ID → 호가 seed.
   *
   * ⛔★UI 주의: 이 값은 «주문 화면을 여는 순간 한 번» 만들어 그 주문이 끝날 때까지 «고정»해야 한다.
   *   ★Date.now()·Math.random() 을 매 렌더 넘기면 그게 곧 «재추첨»이고,
   *   실측상 3회만 다시 뽑아도 플레이어 기대손익이 −6.45bp → −0.31bp(사실상 공짜)가 된다.
   *   ★뒤로 갔다 다시 들어와도 «같은 3장»이 나와야 한다.
   */
  quoteSeed(sessionId: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < sessionId.length; i++) {
      h ^= sessionId.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** 만기까지의 기대 수익률(표시용). 화면에 「예상 캐리」로 쓸 수 있다 */
  carryOf(ticker: string, gameDays = FORWARD_EXPIRY_GAME_DAYS): number {
    return this.world.carryOf(ticker, gameDays);
  }

  /* ── 대출 (2026-09-05 President 지시) ────────────────────────────────
   * ★엔진 통로를 그대로 흘린다. ⛔여기서 한도·금리를 «다시» 계산하지 마라.
   */

  /** 지금 기준(정책)금리 — 중앙은행 정례 회합이 정한다 */
  get policyRate(): number {
    return this.world.policyRate;
  }

  /** 대출 조건 견적(한도·금리·신용등급). 화면이 그대로 그린다 */
  loanTerms(kind: LoanKind) {
    return this.world.loanTerms(this.playerId, kind);
  }

  openLoan(kind: LoanKind, amount: number, termGameDays?: number) {
    const r = this.world.openLoan(this.playerId, kind, amount, termGameDays);
    this.save();
    return r;
  }

  repayLoan(loanId: string, amount: number) {
    const r = this.world.repayLoan(this.playerId, loanId, amount);
    this.save();
    return r;
  }

  /** ★선도 호가 3장 — 최량이 index 0 이다(미리 선택된 상태로 그리면 탭이 안 는다) */
  forwardQuotes(ticker: string, side: LevSide, seed: number): CounterQuote[] {
    return this.world.quotesFor(ticker, side, seed);
  }

  openForward(ticker: string, side: LevSide, notional: number, seed: number, quoteIndex = 0) {
    const r = this.world.openForward(this.playerId, ticker, side, notional, seed, quoteIndex);
    this.save();
    return r;
  }

  closeForward(positionId: string) {
    const r = this.world.closeForward(this.playerId, positionId);
    this.save();
    return r;
  }

  /** ★스왑 호가 3장. 가격이 아니라 «상대 캐리스프레드»를 부른다 */
  swapQuotes(tickerA: string, tickerB: string, side: 'a' | 'b', seed: number): CounterQuote[] {
    return this.world.swapQuotesFor(tickerA, tickerB, side, seed);
  }

  openSwap(tickerA: string, tickerB: string, side: 'a' | 'b', notional: number, seed: number, quoteIndex = 0) {
    const r = this.world.openSwap(this.playerId, tickerA, tickerB, side, notional, seed, quoteIndex);
    this.save();
    return r;
  }

  closeSwap(positionId: string) {
    const r = this.world.closeSwap(this.playerId, positionId);
    this.save();
    return r;
  }

  /**
   * ★선물 = 레버리지 + 만기.
   * ★world.openLeverage 의 «시그니처를 바꾸지 않으려고» 개시 후 만기만 얹는다 —
   *   그 메서드는 봇(다른 레인 소유 파일)이 쓰고 있어서 인자를 늘리면 남의 코드가 깨진다.
   */
  openFutures(ticker: string, side: LevSide, leverage: number, margin: number, expiryGameDays: number) {
    const r = this.world.openLeverage(this.playerId, ticker, side, leverage, margin);
    r.position.expiryTick = this.world.tick + Math.round(expiryGameDays * TICKS_PER_GAME_DAY);
    this.save();
    return r;
  }

  /** ★옵션 «매도» 개시 */
  writeOption(ticker: string, kind: OptionKind, strike: number, expiryGameDays: number, contracts: number) {
    const r = this.world.writeOption(this.playerId, ticker, kind, strike, expiryGameDays, contracts);
    this.save();
    return r;
  }

  /** ★옵션 매도 포지션 되사기 */
  buybackOption(positionId: string) {
    const r = this.world.buybackOption(this.playerId, positionId);
    this.save();
    return r;
  }

  /**
   * ★선도 «되돌리기» (5초 창). ⛔closeForward 가 아니다 — 그건 스프레드를 물어 손해가 남는다.
   * ★이미 만기정산됐으면 false 를 돌려준다. 화면은 그때 토스트를 조용히 닫으면 된다.
   */
  cancelForward(positionId: string): boolean {
    const ok = this.world.cancelForward(this.playerId, positionId);
    if (ok) this.save();
    return ok;
  }

  /** ★스왑 «되돌리기» (5초 창) */
  cancelSwap(positionId: string): boolean {
    const ok = this.world.cancelSwap(this.playerId, positionId);
    if (ok) this.save();
    return ok;
  }

  /** ★내 선도 포지션 뷰 */
  forwardViews(): ForwardView[] {
    const acc = this.me;
    const out: ForwardView[] = [];
    for (const pos of acc.fwdPositions.values()) {
      const price = this.world.engine.refPrice(pos.ticker, FORWARD_REF_VWAP_TICKS);
      const eq = this.world.forwardEquity(pos);
      out.push({
        id: pos.id,
        ticker: pos.ticker,
        side: pos.side,
        notional: pos.notional,
        contractPrice: pos.contractPrice,
        price,
        margin: pos.margin,
        equity: eq,
        pnl: eq - pos.margin,
        counterparty: pos.counterparty,
        counterpartyName: this.counterpartyName(pos.counterparty),
        remainGameDays: Math.max(0, (pos.expiryTick - this.world.tick) / TICKS_PER_GAME_DAY),
      });
    }
    return out;
  }

  /** ★내 스왑 포지션 뷰 */
  swapViews(): SwapView[] {
    const acc = this.me;
    const out: SwapView[] = [];
    for (const pos of acc.swapPositions.values()) {
      const a2 = this.world.engine.refPrice(pos.tickerA, FORWARD_REF_VWAP_TICKS);
      const b2 = this.world.engine.refPrice(pos.tickerB, FORWARD_REF_VWAP_TICKS);
      const eq = this.world.swapEquity(pos);
      out.push({
        id: pos.id,
        tickerA: pos.tickerA,
        tickerB: pos.tickerB,
        side: pos.side,
        notional: pos.notional,
        margin: pos.margin,
        equity: eq,
        pnl: eq - pos.margin,
        relPct: (a2 / pos.entryA - b2 / pos.entryB) * 100,
        counterparty: pos.counterparty,
        counterpartyName: this.counterpartyName(pos.counterparty),
        remainGameDays: Math.max(0, (pos.expiryTick - this.world.tick) / TICKS_PER_GAME_DAY),
      });
    }
    return out;
  }

  /** 아키타입 → 표시용 이름. ⛔화면 문구에 「봇」이라는 말은 쓰지 않는다 */
  private counterpartyName(strategy: BotStrategy): string {
    for (const a of this.world.accounts.values()) {
      if (a.isBot && a.strategy === strategy) return a.nickname;
    }
    return String(strategy);
  }

  leaderboard(humansOnly: boolean): RankEntry[] {
    return this.world.computeLeaderboard(Number.POSITIVE_INFINITY, humansOnly, this.playerId);
  }

  // ── 무료 충전 (ARCHITECTURE 4장) ─────────────────────────────────────
  /** KST 00:00 캘린더 리셋. 구 mockWorld 에는 이 리셋이 아예 없었다(카운터가 영원히 안 돌아감). */
  private syncTopupDay(now = Date.now()): void {
    const key = kstDateKey(now);
    if (this.topupState.dateKey !== key) {
      this.topupState = { dateKey: key, usedToday: 0, lastTopupAt: this.topupState.lastTopupAt };
    }
  }

  /**
   * 남에게 공개되는 포트폴리오(지연본). 없으면 null.
   *
   * ★ 내 계정은 지연하지 않는다 — 내 포지션을 내가 10분 늦게 보면 그건 버그다.
   */
  publicPortfolio(accountId: string, now = Date.now()): PublicPortfolio | null {
    this.rotateSnapshots(now);
    return this.publishedSnap?.get(accountId) ?? null;
  }

  private rotateSnapshots(now: number): void {
    if (this.publishedSnap === null) {
      // 첫 호출 때만 한 번 뜬다(부팅 비용을 지연시킨다).
      this.pendingSnap = this.takeSnapshot(now);
      this.publishedSnap = this.pendingSnap;
      this.snapRotatedAt = now;
      return;
    }
    if (now - this.snapRotatedAt < PUBLIC_PORTFOLIO_DELAY_MS) return;
    this.publishedSnap = this.pendingSnap;
    this.pendingSnap = this.takeSnapshot(now);
    this.snapRotatedAt = now;
  }

  private takeSnapshot(now: number): Map<string, PublicPortfolio> {
    const out = new Map<string, PublicPortfolio>();
    for (const acc of this.world.accounts.values()) {
      if (acc.id === this.playerId) continue; // 내 것은 실데이터를 그대로 쓴다
      out.set(acc.id, {
        asOf: now,
        holdings: [...acc.holdings.entries()].map(([ticker, h]) => ({
          ticker,
          qty: h.qty,
          avgCost: h.avgCost,
        })),
        leverage: [...acc.levPositions.values()].map((p) => ({
          ticker: p.ticker,
          side: p.side,
          leverage: p.leverage,
          margin: p.margin,
        })),
        optionCount: acc.optPositions.size,
        tradeCount: acc.tradeCount,
        liquidationCount: acc.liquidationCount,
      });
    }
    return out;
  }

  /* ── 일일 카운터 (충전 보너스 · 트레이더 열람권) ──────────────────
   * ★ 리셋 기준은 충전과 «완전히 같은» kstDateKey 다. 두 번째 리셋 시각을
   *   만들지 않는다 — 유저가 「무엇이 언제 초기화되는지」를 하나만 외우게.
   */
  private syncDailyDay(now = Date.now()): void {
    const key = kstDateKey(now);
    if (this.dailyState.dateKey !== key) this.dailyState = emptyDaily(key);
  }

  /** 트레이더 열람 현황. 화면은 «열기 전»에 이 값을 보여줘야 한다 */
  dailyStatus(now = Date.now()): DailyStatus {
    this.syncDailyDay(now);
    const d = this.dailyState;
    const limit = TRADER_VIEW_DAILY_LIMIT + d.viewBonus;
    return {
      viewsUsed: d.viewedTraders.length,
      viewsLimit: limit,
      viewsLeft: Math.max(0, limit - d.viewedTraders.length),
      viewBonus: d.viewBonus,
      viewBonusMax: TRADER_VIEW_AD_BONUS_MAX,
      topupBonus: d.topupBonus,
      topupBonusMax: TOPUP_AD_BONUS_MAX,
      topupAdUsed: d.topupAdUsed,
      shareGrants: d.shareGrants,
      shareGrantsMax: SHARE_REWARD_DAILY_MAX,
      shareLeft: Math.max(0, SHARE_REWARD_DAILY_MAX - d.shareGrants),
      shareUsd: d.shareUsd,
    };
  }

  /** 오늘 이미 연 트레이더인가 (재열람은 «세지 않는다») */
  hasViewedTrader(accountId: string, now = Date.now()): boolean {
    this.syncDailyDay(now);
    return this.dailyState.viewedTraders.includes(accountId);
  }

  /**
   * 트레이더 열람 1회 소비.
   * @returns true = 볼 수 있다(재열람이거나 잔여가 있었다) / false = 소진
   */
  consumeTraderView(accountId: string, now = Date.now()): boolean {
    this.syncDailyDay(now);
    if (accountId === this.playerId) return true; // 내 프로필은 세지 않는다
    if (this.dailyState.viewedTraders.includes(accountId)) return true;
    if (this.dailyStatus(now).viewsLeft <= 0) return false;
    this.dailyState = {
      ...this.dailyState,
      viewedTraders: [...this.dailyState.viewedTraders, accountId],
    };
    this.save();
    return true;
  }

  /**
   * 리워드 광고 보상 지급. ★상한을 «여기서» 씌운다 —
   * 지면 설정(unitAmount)이 바뀌거나 조작돼도 게임이 안 깨지게.
   * @returns 실제로 지급된 수량(0 이면 상한 도달)
   */
  grantAdReward(kind: 'topup' | 'view', amount: number, now = Date.now()): number {
    this.syncDailyDay(now);
    const asked = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
    if (asked <= 0) return 0;
    if (kind === 'topup') {
      const room = Math.max(0, TOPUP_AD_BONUS_MAX - this.dailyState.topupBonus);
      const give = Math.min(asked, room);
      if (give > 0) this.dailyState = { ...this.dailyState, topupBonus: this.dailyState.topupBonus + give };
      if (give > 0) this.save();
      return give;
    }
    const room = Math.max(0, TRADER_VIEW_AD_BONUS_MAX - this.dailyState.viewBonus);
    const give = Math.min(asked, room);
    if (give > 0) {
      this.dailyState = { ...this.dailyState, viewBonus: this.dailyState.viewBonus + give };
      this.save();
    }
    return give;
  }

  /**
   * ★공유 리워드 지급 — 앱인토스 `contactsViral` 의 `sendViral` 이벤트가 오면 부른다.
   *
   * ── ★★지급 경로는 «여기 하나»다 ─────────────────────────────────────
   *   ⛔화면이 `acc.cash` 를 직접 만지지 마라. 현금과 «수익률 분모»(bonusSeed)를
   *     한 곳에서 «같이» 올려야 랭킹이 안 깨진다(world.investedBase).
   *     충전이 `topup()` 하나를 지나는 것과 같은 이유·같은 규율이다.
   *
   * ── ★★중복 지급 방지 ────────────────────────────────────────────────
   *   토스는 `sendViral` 에 ★이벤트 식별자를 «주지 않는다»
   *   [실측: node_modules/@apps-in-toss/web-bridge/dist/contactsViral.d.ts —
   *    data 는 `rewardAmount`·`rewardUnit` 두 개뿐이다].
   *   ⇒ 「이벤트 id 기준 멱등」이 ★원천적으로 불가능하다. 지어낸 id 로 멱등한 척하면
   *     그건 검사기만 통과하고 실제로는 아무것도 막지 못한다.
   *   ⇒ 그래서 멱등의 «단위»를 ★«하루 슬롯»으로 잡는다:
   *     같은 이벤트가 재전달·재실행돼도 오늘 슬롯이 이미 찼으면 ★0 을 돌려준다.
   *     카운터는 ★저장본(SavedDaily.shareGrants)에 있어 «앱 재시작 후에도» 유지된다.
   *   ★★그리고 «있는 그대로» 적어 둔다 — 이게 이 방어의 «한계»다:
   *     상한이 1 이면 재전달이 «부수적으로» 전부 막힌다.
   *     상한이 2 이상이면(현재 President 결정 10) 재전달 1건과 「두 번째 친구에게 공유 성공」
   *     1건이 ★구별되지 않는다. 즉 상한 안에서는 재전달도 지급된다.
   *     ⇒ 하루 상한이 ★유일한 방어선이고, 그래서 그 상한이 «저장본»에 있어야 한다.
   *     ⇒ 토스가 이벤트 id 를 주기 시작하면 그때 «진짜» 멱등으로 올려라.
   *   ★그리고 이 함수는 «현금 가산과 카운터 증가»를 ★같은 save() 한 번에 넣는다 —
   *     따로 저장하면 「돈은 들어갔는데 카운터는 안 남는」 창이 생긴다.
   *   ⛔「토스가 하루 1회를 막아 준다」고 «가정하지 마라». 공식 문구의 「한 사용자에게
   *     하루에 한 번」은 ★받는 친구 쪽 기준이다(constants.ts SHARE_REWARD_DAILY_MAX 근거 참조).
   *
   * @param amount 콘솔이 내려준 지급 수량(`sendViral.data.rewardAmount`). ⛔코드에 금액을 박지 않는다.
   * @returns 실제로 지급된 금액(USD). 0 = 오늘 몫 소진이거나 값이 쓸 수 없는 값이었다.
   */
/**
   * ★«보너스 현금» 지급의 **유일한 통로** (2026-08-22, frontend 제안 + Chief 승인).
   *
   * ⛔⛔왜 하나로 합치나: 현금을 늘리면서 `bonusSeed`(수익률 «분모»)를 «안» 올리는 경로가
   *   하나라도 생기면 그 순간 **「지급만으로 수익률 +1000%」**가 된다.
   *   ⇒ 지급 종류마다 함수를 따로 만들면 다음 사람이 «분모 줄을 빠뜨린 네 번째 함수»를 만든다.
   *   ⇒ 그래서 두 줄을 **여기 한 곳에 묶고** 종류별 함수는 이걸 «반드시» 거치게 한다.
   *     (`topup()` 이 한 곳인 것과 같은 규율)
   *
   * ★일일 상한·카운터는 «종류마다 다르므로» 여기서 다루지 «않는다». 호출자 책임이다.
   * ★`save()` 도 호출자가 한다 — 카운터까지 갱신한 «뒤에» 저장해야 한 번만 쓴다.
   * @returns 실제로 지급된 금액(클램프 후). 0 이면 아무 일도 안 일어났다.
   */
  grantBonusCash(amount: number, kind: BonusCashKind, _now = Date.now()): number {
    const capUsd = BONUS_CASH_CAP[kind] ?? SHARE_REWARD_MAX_USD;
    /* ★클램프는 «엔진»이 한다 — 콘솔 설정이 바뀌거나 조작돼도 게임이 안 깨지게.
       NaN·음수·Infinity 는 여기서 전부 0 이 된다. */
    const asked = Number.isFinite(amount) ? Math.floor(amount) : 0;
    const give = Math.min(Math.max(0, asked), capUsd);
    if (asked > capUsd) {
      console.warn('[bonus] 지급 요청이 상한을 넘어 잘렸다', { kind, asked, cap: capUsd });
    }
    if (give <= 0) return 0;
    const acc = this.me;
    acc.cash += give;
    /* ⛔★이 두 줄을 «절대» 떼어놓지 마라. 위 주석이 그 이유다. */
    acc.bonusSeed += give;
    return give;
  }

  grantShareReward(amount: number, now = Date.now()): number {
    this.syncDailyDay(now);
    if (this.dailyState.shareGrants >= SHARE_REWARD_DAILY_MAX) return 0;
    /* ★상한 클램프는 «엔진»이 한다 — 콘솔 설정이 바뀌거나 조작돼도 게임이 안 깨지게
       (grantAdReward 와 같은 규율). NaN·음수·Infinity 는 여기서 전부 0 이 된다.
       ★현재 상한(=$100,000)은 정상 지급액과 «정확히 같다» — 막지 않는다.
       ⛔콘솔 수량을 이 값보다 크게 올리려면 SHARE_REWARD_MAX_USD 도 같이 올려야 한다.
         안 올리면 «조용히» 잘린다 — 그래서 잘리는 순간 console.warn 으로 소리를 낸다. */
    /* ★지급 자체는 grantBonusCash 한 곳을 거친다 — 분모(bonusSeed)를 빠뜨릴 수 없게 */
    const give = this.grantBonusCash(amount, 'share');
    if (give <= 0) return 0;
    this.dailyState = {
      ...this.dailyState,
      shareGrants: this.dailyState.shareGrants + 1,
      shareUsd: this.dailyState.shareUsd + give,
    };
    this.save();
    return give;
  }

  topupStatus(now = Date.now()): TopupStatus {
    this.syncTopupDay(now);
    const eq = this.equity();
    const cooldown = this.topupState.lastTopupAt
      ? Math.max(0, TOPUP_COOLDOWN_MS - (now - this.topupState.lastTopupAt))
      : 0;
    // 리워드 광고로 얻은 «오늘» 보너스를 무료 한도에 더한다.
    // ★ 기존 유저가 예전 한도(5)로 이미 4회를 썼다면 3-4 = -1 이 될 수 있어
    //   Math.max(0, ...) 가 반드시 필요하다(음수 잔여 = 화면·검증 붕괴).
    this.syncDailyDay(now);
    const bankrupt = eq < BANKRUPT_EQUITY_THRESHOLD;

    /*
     * ★2026-08-20 (President 지시 · Partner 승인): «무료»와 «광고»의 역할을 나눈다.
     *   - 무료 3회 : 파산 «구제». 파산이 아니면 못 쓴다. 10분 쿨다운 유지.
     *   - 광고 10회: 파산과 «무관». 언제든. ★쿨다운 없음.
     *     └ 근거: 광고 1회 = 30초 시청 + 하루 10회 상한 자체가 이미 마찰이다.
     *       여기에 10분 쿨다운까지 걸면 「잔고 부족 → 광고 보고 받기」가 사실상 한 번뿐이라
     *       President 지시(「광고 보고 게임 머니 추가를 많이 하도록」)와 정면으로 어긋난다.
     *   ★랭킹 안전: 지급은 어느 쪽이든 아래 topup() 한 곳을 지나고 topupCount 가 반드시 오른다
     *     ⇒ 수익률 분모 seedCash*(1+topupCount) 가 같이 커진다(실측 확인분).
     */
    const freeRemaining = Math.max(0, TOPUP_DAILY_LIMIT - this.topupState.usedToday);
    const adPending = Math.max(0, this.dailyState.topupBonus - this.dailyState.topupAdUsed);
    const adRemaining = Math.max(0, TOPUP_AD_BONUS_MAX - this.dailyState.topupAdUsed);
    /*
     * ★★[2026-09-05 President 「연체되면 무료충전 없애.」]
     *   ⛔화면이 「연체 중인가」를 스스로 판단하지 않게 «여기서» 잠근다 — 판정이 두 벌이면 갈린다.
     *   ★무료·광고 «둘 다» 잠근다(광고 차단은 President 지시에 없던 내 판단 — 보고에 명시).
     *   ★쿨다운·일일 한도는 그대로 남는다(소모되지 않는다) — 갚으면 그대로 돌아온다.
     */
    const overdraft = this.world.overdraftBalance(this.me);
    const overdrawn = overdraft > 0;
    const freeEligible = !overdrawn && bankrupt && freeRemaining > 0 && cooldown === 0;
    const remaining = freeRemaining + adPending;
    return {
      remainingToday: remaining,
      usedToday: this.topupState.usedToday,
      cooldownRemainMs: cooldown,
      equity: eq,
      bankrupt,
      bankruptThreshold: BANKRUPT_EQUITY_THRESHOLD,
      topupAmount: TOPUP_AMOUNT,
      dailyLimit: TOPUP_DAILY_LIMIT + this.dailyState.topupBonus,
      eligible: !overdrawn && (freeEligible || adPending > 0),
      freeRemaining,
      freeEligible,
      adPending,
      adRemaining,
      /** ★연체 잔액(양수). 0 이 아니면 충전이 «전부» 잠긴다 */
      overdraft,
      overdrawn,
    };
  }

  /**
   * 충전 1회.
   *
   * ★★지급 경로는 «여기 하나»뿐이다. 무료든 광고든 전부 이 함수를 지난다.
   *   그래서 `acc.topupCount++` 를 빠뜨리는 것이 «구조적으로 불가능»하다.
   *   ⛔현금을 직접 더해 주는 새 경로를 만들지 마라 — 그 순간 수익률 분모
   *     seedCash*(1+topupCount) 가 어긋나 랭킹이 +1000% 로 붕괴한다.
   *
   * @param kind 'free' = 파산 구제분 · 'ad' = 광고 적립분 · 미지정 = 가능한 쪽을 자동 선택
   *             (무료가 가능하면 «무료 먼저». 광고를 안 봐도 되는 길을 먼저 준다)
   */
  topup(kind?: 'free' | 'ad'): TopupStatus & { ok: true; amount: number; kind: 'free' | 'ad' } {
    const st = this.topupStatus();
    const use: 'free' | 'ad' = kind ?? (st.freeEligible ? 'free' : 'ad');

    /*
     * ★★[2026-09-05 President 지시] 「연체되면 무료충전 없애.」
     *   ⛔연체 중(현금 음수)에는 충전을 «주지 않는다». 충전은 유입이라 자동으로 연체를 메우는데,
     *     그러면 「빌리고 연체하고 충전으로 때우기」가 무한히 돈다 — 대출의 건전성 장치가 통째로 무력해진다.
     * ★★광고 충전도 «같이» 막는다 — 이건 President 지시에 «없던» 판단이다(보고에 명시).
     *   근거: 광고 충전만 열어두면 그게 그대로 연체 회피 경로가 되어 무료 충전을 막은 의미가 사라진다.
     *   ⛔되돌릴 때는 아래 `use === 'free'` 조건 하나만 붙이면 된다 — 그 한 줄이 전부다.
     * ★쿨다운·일일 한도는 «소모되지 않는다» — 여기서 던지므로 카운터를 건드리기 «전»이다.
     *   즉 연체를 갚고 나면 충전 권리가 그대로 남아 있다(검증기가 이 성질을 지킨다).
     */
    if (this.world.overdraftBalance(this.me) > 0)
      throw new GameError('OVERDRAWN', '연체 잔액을 먼저 갚아야 충전할 수 있습니다.');

    if (use === 'free') {
      if (!st.bankrupt) throw new GameError('NOT_BANKRUPT', '아직 충전할 수 없습니다.');
      if (st.freeRemaining <= 0) throw new GameError('DAILY_LIMIT', '오늘 무료 충전을 모두 사용했습니다.');
      if (st.cooldownRemainMs > 0) throw new GameError('COOLDOWN', '충전 쿨다운 중입니다.');
    } else {
      /* ★광고분은 파산 여부·쿨다운을 보지 않는다. «이미 광고를 본 몫»만 확인한다. */
      if (st.adPending <= 0) throw new GameError('DAILY_LIMIT', '오늘 광고로 받을 몫을 모두 사용했습니다.');
    }

    const acc = this.me;
    acc.cash += TOPUP_AMOUNT;
    acc.topupCount++;
    if (use === 'free') {
      this.topupState.usedToday++;
      this.topupState.lastTopupAt = Date.now();
    } else {
      this.dailyState = { ...this.dailyState, topupAdUsed: this.dailyState.topupAdUsed + 1 };
    }
    this.save();
    return { ok: true, amount: TOPUP_AMOUNT, kind: use, ...this.topupStatus() };
  }

  /**
   * ★옵션 1계약이 담는 주(단위) 수 — «종목마다 다르다»(2026-09-05).
   * ⛔화면이 `SHARES_PER_CONTRACT` 를 직접 쓰면 BTC·NDX 표기가 실제 체결과 갈린다.
   */
  sharesPerContractOf(ticker: string): number {
    return this.world.sharesPerContractOf(ticker);
  }

  /** @deprecated 종목을 아는 자리에서는 `sharesPerContractOf(ticker)` 를 써라. 기본값일 뿐이다. */
  get sharesPerContract(): number {
    return SHARES_PER_CONTRACT;
  }
}
