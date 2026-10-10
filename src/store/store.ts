/**
 * GameStore — 화면이 보는 유일한 상태 소스.
 *
 * ★ 정적 단독 빌드(2026-08-05, 트랙 C): **서버가 없다.**
 *   REST/WS·연결상태·모드전환(server/mock) 개념을 전부 걷어냈다.
 *   게임 전체가 브라우저 안의 GameWorld(봇 210 + 종목 100) 하나로 돈다.
 *   따라서 "연결 끊김/오프라인/연습용 데이터" 같은 상태도, 그 UI 도 존재하지 않는다.
 */
import i18next from 'i18next';
import { GameWorld, Rng } from '../lib/engine';
import { TICKERS } from '../data/tickers.generated';
/**
 * 저장 지점은 lsSet/lsRemove 를 «직접» 부른다 — localStorage 에 즉시 쓰고
 * 토스 안에서는 네이티브 Storage 에도 미러링한다(iOS ITP 7일 삭제 대비).
 * ★ «읽기»는 그대로 localStorage 동기 호출을 쓴다. 네이티브 읽기는 비동기라
 *   생성자에서 쓸 수 없다 — 부팅 «전» main.tsx 의 primeAppStorage() 가
 *   네이티브 값을 localStorage 로 역주입해 두는 구조다(toss/storage.ts 참고).
 */
import { lsSet, lsRemove } from '../toss/storage';
import { CbLedger, EquityHistory } from './history';
/*
 * 프로모션 리워드 훅 3종(★2026-08-29 개편). 규칙(문턱)은 lib/promoRules.ts 한 곳,
 * 지급·락은 toss/promotion.ts(→ promoCore.ts). 둘 다 절대 throw 하지 않는다.
 *   streak3 → boot()/onVisibility 의 touchStreak · hold10 → afterOrder · cash100k → afterOrder + boot() 1회
 * ★ 2026-09-01 훅 2종 추가: equity1m → afterOrder + boot() + «매 틱»(syncFromWorld, 가격만으로 넘는다) · play1h → startLoop 의 «벽시계 비트»
 * ⛔「100위 안에 들기」(top100)는 콘솔 «반려»로 08-29 제거 — 랭킹 갱신 지점의 훅 호출도 같이 뗐다.
 * ⛔옛 훅 「거래 성공」은 콘솔에서 «종료»돼 호출을 제거했다(2026-08-29).
 */
import {
  maybeClaimPromo,
  promoSettled,
  touchStreak,
  playtimeResume,
  playtimeBeat,
  playtimePause,
  claimPromoOnTransition,
  promoBaselined,
  promoIneligible,
} from '../toss/promotion';
import { distinctHoldings, holdReached, cashReached, equityReached, PROMO_PLAY_BEAT_MS } from '../lib/promoRules';
import { Journal } from './journal';
import { AttendanceLedger } from './attendance';
import { planCopy, type CopyMode, type CopyPlan } from '../lib/copyPortfolio';
import {
  ATTENDANCE_AD_MULTIPLIER,
  decideAttendance,
  nextReward,
  rewardForStreak,
  type AttendanceDecision,
} from '../lib/attendance';
import { kstDateKey } from '../lib/daykey';
/*
 * ★[2026-09-10 · -33] 전면 광고(세션 3번째 «완료» 거래) · 출석 추가지급 «해제» 안내.
 *   가드(60초·10분·일 3회·리워드 후 60초)·지면 ID·N번째 판정은 전부 lib/ads 한 곳이다 — 여기서 다시 적지 않는다.
 */
import { hasPlacement, rewardedSupported, runInterstitialAd, tradeInterstitialDue } from '../lib/ads';
import { noteAd } from '../lib/adStats';
import {
  SEASON_KEY,
  extendSeason as extendSeasonState,
  freshSeason,
  newSeason as newSeasonState,
  saneSeason,
  seasonEnded,
  seasonRemainMs,
  type SeasonState,
} from '../lib/season';
import { GameError } from '../lib/engine/world';
import type { DividendEvent } from '../lib/engine/dividends';
import { money as fmtMoney, signedMoney as fmtSignedMoney } from '../lib/format';
import {
  SNAPSHOT_EVERY_TICKS,
  LEADERBOARD_SIZE,
  LOCAL_ACCOUNT_ID,
  WATCHED_TRADERS_MAX,
  MACRO_LOG_MAX,
  SETTLED_FEED_MIN_PNL,
  SETTLED_FEED_SAMPLE,
  SETTLED_LOG_MAX,
  MACRO_SECTOR_CONSISTENCY,
  MACRO_SECTOR_SHOWN,
  MAINTENANCE_BASIS,
  MAX_CATCHUP_TICKS,
  WARMUP_CHUNK_BUDGET_MS,
  WARMUP_CHUNK_MIN_TICKS,
  RANK_RESORT_THROTTLE_MS,
  SHARES_PER_CONTRACT,
  TICKS_PER_GAME_DAY,
  TICK_MS,
  UNDO_WINDOW_MS,
  type MaintenanceBasis,
} from '../lib/constants';
import type { CounterQuote, ForwardView, LoanKind, SwapView } from '../lib/engine/types';
import type {
  CentralBankView,
  FeedItem,
  LevSide,
  MacroLogItem,
  MacroSector,
  MacroType,
  MacroView,
  SettledLogItem,
  OptionKind,
  Portfolio,
  Quote,
  RankEntry,
  JournalEntry,
  Session,
  Side,
  TopupStatus,
  DailyStatus,
  PublicPortfolio,
} from '../lib/types';

export type ThemePref = 'system' | 'light' | 'dark';
export type UpDownPref = 'kr' | 'us';
export type Lang = 'ko' | 'en';

export interface Settings {
  lang: Lang;
  theme: ThemePref;
  updown: UpDownPref;
  /*
   * [제거 2026-08-20] notifyLiquidation · notifyRank · sound.
   * ★세 값 모두 «저장만 되고 아무도 읽지 않았다»(참조처 = 자기 스위치뿐).
   *   이 앱에는 알림·오디오·진동 API 배선이 0건이다.
   * ★기존 기기에 저장된 옛 키가 남아 있어도 무해하다 — load() 가 기본값 위에 스프레드하므로
   *   객체에 남을 뿐이고 읽는 곳이 없다. 마이그레이션도 필요 없다.
   */
}

/**
 * 주문 「되돌리기」 핸들.
 *
 * ★ 왜 주문 API 가 이걸 «돌려주는가»: 되돌릴 대상(포지션 id·보유 스냅샷)을
 *   아는 건 주문을 «낸 그 순간»뿐이다. 화면이 나중에 뒤져서 찾게 하면
 *   같은 종목·같은 수량 주문이 두 번 있을 때 엉뚱한 걸 되돌린다.
 * ★ undo() 의 반환값이 false 면 «되돌리지 못했다»는 뜻이다(그사이 강제청산/
 *   만기소멸/다른 매도로 상태가 변함). 조용히 넘기지 말고 화면에 알려야 한다.
 */
export interface UndoHandle {
  undo: () => boolean;
}

/**
 * 주문 「되돌리기」 핸들.
 *
 * ★ 왜 주문 API 가 이걸 «돌려주는가»: 되돌릴 대상(포지션 id·보유 스냅샷)을
 *   아는 건 주문을 «낸 그 순간»뿐이다. 화면이 나중에 뒤져서 찾게 하면
 *   같은 종목·같은 수량 주문이 두 번 있을 때 엉뚱한 걸 되돌린다.
 * ★ undo() 의 반환값이 false 면 «되돌리지 못했다»는 뜻이다(그사이 강제청산/
 *   만기소멸/다른 매도로 상태가 변함). 조용히 넘기지 말고 화면에 알려야 한다.
 */
export interface UndoHandle {
  undo: () => boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'default' | 'error';
  /**
   * 「되돌리기」 액션. 스와이프 확인(마찰)을 없앤 대신 오조작을 «사후»에 복구한다.
   * 확인창 제거 = 안전장치 제거가 되면 안 된다 — 자리를 바꿨을 뿐이다.
   */
  action?: { label: string; run: () => void };
}

export interface LiquidationEvent {
  ticker: string;
  leverage: number;
  side: LevSide;
  loss: number;
  returned: number;
  equityAfter: number;
}

const LS = {
  session: 'ml.session',
  settings: 'ml.settings',
  watchlist: 'ml.watchlist',
  /**
   * 「관심 참가자」 accountId 목록.
   * ★세이브 블롭(ml.game)과 «다른 키»다. 계좌 데이터가 아니라 보기 설정이라
   *   SavedGame 스키마를 건드리지 않는다(저장본 호환 증명 대상에서 빠진다).
   */
  traderWatch: 'ml.traderwatch',
  onboarded: 'ml.onboarded',
  /**
   * ★호가 «주문 세션» 표 — 차익거래 방지 ③ 「재추첨 금지」의 영속화.
   * ★세이브 블롭(ml.game)과 «다른 키»다 — traderWatch 와 같은 이유로
   *   SAVE_VERSION 을 건드리지 않는다(President 하드게이트).
   */
  quoteSession: 'ml.quotesession',
};

/**
 * 호가 세션 보관 상한. ★무한히 쌓이면 localStorage 를 먹는다.
 * 종목 100 × 방향 2 × 상품 2 = 최대 400 조합이지만, 실제로 «열어 본» 것만 쌓인다.
 * 넘치면 가장 오래된 것부터 버린다 — 버려진 조합은 다음에 새로 뽑히지만,
 * 그건 «유저가 40개 조합을 헤집은 뒤»라 재추첨 경로로 쓸 수 없다(비용이 훨씬 크다).
 */
const QUOTE_SESSION_MAX = 60;

/**
 * 첫 방문 언어 자동 감지.
 * 하드코딩 'ko' 였던 탓에 영어권 첫 방문자도 무조건 한국어로 시작했다(P3 지적).
 * load() 가 저장값을 기본값 **위에** 스프레드하므로 기존 사용자의 선택은 그대로 보존된다.
 * (지원 언어는 ko/en 2종 — 그 외 로케일은 en 으로 떨어진다.)
 */
function detectLang(): Lang {
  const n = navigator.languages?.[0] ?? navigator.language ?? 'ko';
  return n.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

const DEFAULT_SETTINGS: Settings = {
  lang: detectLang(),
  theme: 'system',
  updown: 'kr',
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...(fallback as object), ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 랭킹 재계산 주기(틱). 서버 LEADERBOARD_EVERY_TICKS 와 동일하게 2틱(=4초). */
/**
 * 지금 보고 있는 «해시 라우트 경로». 전면 광고를 준비하는 동안 화면을 떠났는지 판정하는 데만 쓴다.
 * ★종목 코드 같은 파라미터는 `*` 로 뭉갠다 — 같은 종목 상세 안에서 탭만 바꾼 것을 「이탈」로 보지 않기 위해서다.
 * ⛔저장하지 않는다(계측 원장에서도 화면 경로는 뺐다 — adStats.ts 머리말).
 */
function routePath(): string {
  try {
    const h = typeof window === 'undefined' ? '' : window.location.hash || '';
    const raw = h.startsWith('#') ? h.slice(1) : h;
    const path = raw.split('?')[0] || '/';
    return path.replace(/\/(stock|leverage|option|trader|contract)\/[^/]+.*$/, '/$1/*');
  } catch {
    return '?';
  }
}

const RANK_EVERY_TICKS = 2;

/** 포트폴리오 복사 — 한 줄의 실행 결과 */
export interface CopyStep {
  phase: 'close' | 'buy';
  kind: 'spot' | 'lev' | 'option' | 'forward' | 'swap';
  ticker: string;
  side?: 'long' | 'short';
  leverage?: number;
  margin?: number;
  qty?: number;
  ok?: boolean;
  /** 실패 코드(GameError.code) — 화면은 common:err.<code> 로 말한다 */
  code?: string;
}

export interface CopyResult {
  via: string;
  mode: CopyMode;
  steps: CopyStep[];
  /** 중간에 실패해 멈췄다 — 남은 줄은 실행되지 않았다 */
  stopped: boolean;
  done: number;
  /** 실제 현금으로 «다시» 세운 매수 계획(청산 단계에서 멈췄으면 null) */
  plan: CopyPlan | null;
}

export class GameStore {
  // ── 공개 상태 ────────────────────────────────────────────────────────
  session: Session | null = null;
  settings: Settings = DEFAULT_SETTINGS;
  watchlist: string[] = [];
  /**
   * 「관심 참가자」 accountId — 랭킹 탭 «관심» 세그먼트가 읽는 유일한 소스.
   * ★순서 = «추가한 순»이 아니라 «최근 추가가 앞»이다(unshift). 목록 상단이
   *   방금 관심 준 사람이어야 「방금 뭘 했는지」가 바로 보인다.
   */
  watchedTraders: string[] = [];
  onboarded = false;

  tick = 0;
  gameDay = 0;

  portfolio: Portfolio | null = null;
  /*
   * ★[-23 2026-08-31] 자산 흐름·중앙은행 체결은 «세션을 넘어» 이어진다(store/history.ts).
   *   `equityHistory`/`equityMarks` 는 화면 호환용 getter — 배열 참조는 push 마다 같은 객체다(차트 memo 는 길이·값으로 판단).
   */
  readonly equity = new EquityHistory();
  readonly cbLedger = new CbLedger();
  get equityHistory(): number[] {
    return this.equity.pts;
  }
  get equityMarks(): number[] {
    return this.equity.marks;
  }
  ranks: RankEntry[] = [];
  /*
   * [제거 2026-08-20] humanRanks.
   *
   * ★실측: 선언 1 · 대입 2 · «참조 0». 화면 어디에서도 안 읽는다
   *   (양성대조: 같은 방식으로 센 `.ranks` 는 18곳에서 참조된다).
   *   「사람만」 탭이 사라질 때(2026-08-05) 계산만 남고 소비처가 없어진 잔재다.
   * ★왜 지금 문제가 되나: computeLeaderboard 는 «명부 전체»를 돌며 객체를 만들고 정렬한다.
   *   210명일 때는 공짜였지만 1,000명(30일차 3,310명)이면 4초마다 그 일을 «두 번» 한다 —
   *   절반이 아무도 안 보는 배열이다. 폰에서 GC 압력의 직접 원인이 된다.
   * ★되살리지 마라. 사람은 이 빌드에 «나 하나»뿐이라 humansOnly 결과는 항상 1행이다.
   */
  feed: FeedItem[] = [];
  topup: TopupStatus | null = null;
  /** 트레이더 열람권 현황. ★화면은 프로필을 «열기 전»에 이 값을 보여줘야 한다 */
  daily: DailyStatus | null = null;
  /** topup 상태를 갱신한 시각 — 쿨다운 로컬 카운트다운 기준점 */
  topupFetchedAt = Date.now();
  toasts: Toast[] = [];
  liquidation: LiquidationEvent | null = null;

  /**
   * ★시즌 (2026-08-29 President 지시 — 마감 시 «자동 초기화 ⛔», 연장/새 시즌을 «선택»).
   *   규칙은 `lib/season.ts` 한 벌. 저장은 새 키 `ml.season`(세이브 블롭과 다른 키 · SAVE_VERSION 무변경).
   * ★`seasonLocked` 가 true 인 동안: 시장이 «멈추고»(pump 가 틱을 돌리지 않는다) 주문은 전부
   *   SEASON_ENDED 로 거절된다. 화면은 AppFrame 의 SeasonGate 가 덮는다. 선택하면 풀린다.
   */
  season: SeasonState = freshSeason();
  seasonLocked = false;

  /** 게임 본체 (봇 210 + 종목 100 + 내 계좌). 서버 대체물이 아니라 이게 게임이다. */
  readonly world: GameWorld;

  /**
   * ★거래 일지 — 「거래 내역 N건」을 «열 수 있게» 만드는 원장(2026-08-21 신설).
   *
   * ★엔진은 개별 체결을 저장하지 않는다 [실측: Account 에 누적치 3개뿐].
   *   그래서 «화면 레인»이 주문이 지나가는 자리마다 한 줄씩 남긴다.
   * ★세이브 블롭(ml.game)과 «다른 키»(ml.journal)라 SAVE_VERSION 을 건드리지 않는다.
   */
  readonly journal = new Journal(() => this.bump());

  /**
   * ★출석 원장 — 세이브 블롭 «밖»의 독립 키(`ml.attendance`).
   *   ⛔`ml.game` 에 넣지 않는다: 「손상돼도 게임이 죽으면 안 되는 데이터」라
   *     블롭 안이면 «블롭 전체»가 위험해진다(CTO 판정 2026-08-22).
   *   ⇒ `ml.firstSeen`·`ml.traderwatch`·`ml.quotesession`·`ml.journal` 과 같은 패턴이다.
   */
  readonly attendance = new AttendanceLedger(() => this.bump());

  /*
   * [P1 제거] `store.mock` 별칭은 두지 않는다.
   * 화면은 `s.series(ticker, n)` / `s.world` 를 쓴다(2026-08-05 실측: 잔여 참조 0건).
   * "mock/연습 데이터" 개념 자체가 이 빌드에 없으므로 이름도 남기지 않는다.
   */

  // ── 내부 ─────────────────────────────────────────────────────────────
  private quotes = new Map<string, Quote>();
  private priceVer = new Map<string, number>();
  private priceSubs = new Map<string, Set<() => void>>();
  private subs = new Set<() => void>();
  private tickSubs = new Set<() => void>();
  version = 0;
  tickVersion = 0;
  private loopTimer: number | null = null;
  /** ★[2026-09-01 · play1h] 플레이 «실시간» 누적 비트 타이머. 게임 틱과 별개 */
  private playTimer: number | null = null;
  /** 마지막으로 "게임 시간을 정산한" 실제 시각 (백그라운드 보정 기준점) */
  private lastTickAt = Date.now();
  private pumping = false;
  private pendingRanks: { all: RankEntry[] } | null = null;
  private lastResort = 0;
  private resortTimer: number | null = null;
  private prevRankById = new Map<string, number>();
  /** 랭킹에서 관측한 참가자별 자산 추이(세션 한정) */
  readonly equityByAccount = new Map<string, number[]>();
  /** 지금 프로필을 열어 본 계정 — 이 계정의 자산 곡선만 추가로 추적한다 */
  private watchedAccountId: string | null = null;
  private toastId = 0;
  private booted = false;
  /*
   * ── ★[2026-09-10 · -33] 세션 거래 카운터 ──────────────────────────────────
   *   «체결»(placed)과 «완료»(done)를 가른다(Codex 관찰: 완료 횟수와 되돌리기 대기 횟수 분리).
   *     placed = commitOrder 가 exec 를 «성공»시킨 수 → 출석 「추가 지급(광고)」 버튼 해제 판정
   *     done   = 되돌리기 창(UNDO_WINDOW_MS)이 «되돌림 없이» 닫힌 수 → 전면 광고(N번째) 판정
   *   ★메모리 전용 — 「이 세션」의 정의가 곧 «이번 실행»이다(ads.ts SESSION_STARTED_AT 과 같은 이유). ⛔저장하지 않는다.
   */
  private sessionTradesPlaced = 0;
  private sessionTradesDone = 0;
  /** 이 세션에서 포트폴리오 화면(거래 일지·내 종목 필터·파생 포지션)을 «열었다» */
  private portfolioViewed = false;
  /** 전면(거래 N번째)은 세션당 «한 번»만 시도한다 — 가드에 걸려도 재시도 없음 */
  private tradeInterstitialFired = false;
  /**
   * ★[2026-09-12 · -34] N번째 완료 거래에 도달했지만 «아직 못 띄운» 상태.
   *   [Codex 리뷰 1번 · 확인] 세 번째 거래 뒤 4초에 네 번째 주문을 넣으면, 1초 뒤 N번째 창이 닫히면서
   *   전면이 나갔다 — 그때 «네 번째 되돌리기»가 4초나 남아 있었다. 확인창을 없앤 대가인 5초 안전장치를
   *   광고가 덮는 것이라 ⛔절대 안 된다.
   *   ⇒ 도달은 «표시»만 해 두고, 열린 되돌리기 창이 «하나도» 없을 때 비로소 띄운다.
   *   ⛔`tradeInterstitialDue(done)` 로 다시 판정하지 마라 — 미룬 사이에 done 이 N 을 넘어가 영영 안 뜬다.
   */
  private tradeInterstitialPending = false;
  /** 「추가 지급을 받을 수 있어요」 안내 토스트는 세션당 1회 */
  private attendBonusHinted = false;
  /**
   * ★피드 표본추출 전용 난수. ⛔`Math.random()` 을 쓰지 않는다 —
   *   이 앱은 «같은 시드면 같은 게임»이 규율이고, 검증도 그 위에서 돈다.
   */
  private readonly settledRng = new Rng(0x5eed1e);

  constructor() {
    this.settings = load(LS.settings, DEFAULT_SETTINGS);
    this.onboarded = localStorage.getItem(LS.onboarded) === '1';
    try {
      const s = localStorage.getItem(LS.session);
      if (s) this.session = JSON.parse(s) as Session;
      const w = localStorage.getItem(LS.watchlist);
      if (w) this.watchlist = JSON.parse(w) as string[];
      /*
       * 관심 참가자 — ★손상값 방어를 여기서 «반드시» 한다.
       *   이 키는 유저 기기에 그냥 남아 있는 값이라 배열이 아닐 수도, 원소가
       *   문자열이 아닐 수도 있다. 그대로 두면 랭킹 탭이 렌더 중에 터진다.
       *   (persistence.ts 의 Array.isArray fallback 과 같은 패턴)
       */
      /*
       * ★호가 세션 복원. ⛔손상값 방어를 «반드시» 한다 — 유저 기기에 그냥 남아 있는 값이라
       *   객체가 아닐 수도, 값이 문자열이 아닐 수도 있다(traderWatch 와 같은 패턴).
       */
      const qs = localStorage.getItem(LS.quoteSession);
      if (qs) {
        const parsed: unknown = JSON.parse(qs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof k === 'string' && typeof v === 'string' && v.length > 0) this.quoteSessions.set(k, v);
          }
        }
      }
      const tw = localStorage.getItem(LS.traderWatch);
      if (tw) {
        const parsed: unknown = JSON.parse(tw);
        this.watchedTraders = (Array.isArray(parsed) ? parsed : [])
          .filter((x): x is string => typeof x === 'string' && x.length > 0)
          .slice(0, WATCHED_TRADERS_MAX);
      }
    } catch {
      /* ignore */
    }
    /*
     * ★시즌 복원 — 키가 «없으면» 옛 화면이 세던 «다음 7일 경계»가 마감이다(카운트다운이 그대로 이어진다).
     *   손상값은 saneSeason 이 기본 마감으로 떨어뜨린다. ⛔여기서 throw 하면 앱이 안 뜬다.
     */
    try {
      const raw = localStorage.getItem(SEASON_KEY);
      this.season = saneSeason(raw ? JSON.parse(raw) : null);
      if (!raw) this.persistSeason();
    } catch {
      this.season = freshSeason();
    }
    this.applyDom();

    // GameWorld 생성 자체는 가볍다(워밍업 3000틱은 boot() 에서 첫 페인트 뒤에 돈다).
    this.world = new GameWorld({ nickname: this.session?.nickname ?? '' });
    this.world.onLiquidation = (ticker, leverage, side, loss, returned) => {
      this.liquidation = { ticker, leverage, side, loss, returned, equityAfter: this.world.equity() };
      this.bump();
    };
    this.world.onOptionSettled = (_ticker, payoff) => {
      // 토스트 계약 = "번역된 문자열". 스토어에는 useTranslation 이 없으므로
      // i18next 싱글턴(=i18n/index.ts 가 init 한 그 인스턴스)으로 직접 번역한다.
      // i18next 를 직접 import 하는 이유: '../i18n' 은 store 를 import 하므로 순환이 된다.
      this.pushToast(String(i18next.t(payoff > 0 ? 'common:toast.optionSettledWin' : 'common:toast.optionSettledZero')));
    };
    /*
     * ★거시 이벤트 구독 — ★World 를 «직접» 듣는다.
     *   ⛔gameWorld.ts 의 피드 빌더를 고치지 «않는» 이유: 그 파일은 파생 레인 소유다.
     *     같은 파일을 두 레인이 만지면 충돌한다. World.on() 은 공개 API 라 여기서 붙여도 된다.
     *   ★워밍업 3,000틱 동안은 `world.muted = true` 라 emit 이 «오지 않는다» —
     *     부팅하자마자 지난 소식 3~4건이 쏟아지는 일이 없다(코드 실측: World.emit 첫 줄).
     */
    this.world.world.on((e) => {
      if (e.type === 'macro') return this.pushMacroLog(e.event);
      if (e.type === 'settled') return this.onSettled(e);
      /*
       * ★내 레버리지 «강제청산»은 `settled` 로 오지 «않는다» — 별도 `liquidation` 채널이다
       *   [코드 실측: world.closeLeverage(forced) → emit 'liquidation'].
       *   여기서 안 받으면 일지에 «가장 아픈 한 줄»이 빠진다.
       */
      if (e.type === 'liquidation' && e.accountId === LOCAL_ACCOUNT_ID) return this.onMyLiquidation(e);
      /*
       * ★배당 — President 지시 기능인데 «듣는 데가 없어서» 화면에 아무것도 안 떴다.
       *   [실측 2026-08-23 · scripts/verify_dividend_ui.py] 고배당 10종 보유 + 배당주기 2회 진행 후
       *   토스트 0건 · 일지 0회 · 홈 0회 (양성대조 PASS 상태에서의 0건 = «진짜 부재»).
       *   엔진은 `world.ts` 에서 `stepDividends(view)` 결과를 emit 하고 «있었다» — 여기서 받는다.
       * ⛔`gameWorld.onWorldEvent` 에 넣지 «않는» 이유는 위 macro 주석과 같다(파생 레인 소유 파일).
       */
      if (e.type === 'dividend' && e.accountId === LOCAL_ACCOUNT_ID) return this.onMyDividend(e);
    });

    // 첫 프레임이 빈 화면이 되지 않게 초기 시세를 채운다(워밍업 전이라 초기가 기준)
    this.syncFromWorld(true);
  }

  // ── 구독 ─────────────────────────────────────────────────────────────
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getVersion = (): number => this.version;

  subscribeTick = (fn: () => void): (() => void) => {
    this.tickSubs.add(fn);
    return () => this.tickSubs.delete(fn);
  };
  getTickVersion = (): number => this.tickVersion;

  subscribePrice = (ticker: string) => (fn: () => void) => {
    let set = this.priceSubs.get(ticker);
    if (!set) {
      set = new Set();
      this.priceSubs.set(ticker, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  };
  priceVersionOf = (ticker: string) => (): number => this.priceVer.get(ticker) ?? 0;

  getQuote(ticker: string): Quote | undefined {
    return this.quotes.get(ticker);
  }
  priceOf(ticker: string): number {
    return this.quotes.get(ticker)?.price ?? 0;
  }

  private bump(): void {
    this.version++;
    for (const fn of this.subs) fn();
  }
  private bumpTick(): void {
    this.tickVersion++;
    for (const fn of this.tickSubs) fn();
  }
  private bumpPrice(ticker: string): void {
    this.priceVer.set(ticker, (this.priceVer.get(ticker) ?? 0) + 1);
    const set = this.priceSubs.get(ticker);
    if (set) for (const fn of set) fn();
  }

  // ── 부팅 ─────────────────────────────────────────────────────────────
  /**
   * main.tsx 가 render 직전에 호출한다.
   * 첫 await 에서 즉시 반환하므로 **워밍업 3000틱은 첫 페인트 뒤**에 돈다
   * (구 구현처럼 생성자에서 돌리면 그 시간만큼 흰 화면이 된다).
   */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await new Promise<void>((r) => window.setTimeout(r, 0));
    await this.warmupChunked();
    this.booting = false;
    this.emitBoot();
    /* ★[-23] 저장된 자산 흐름이 있으면 «여기부터 새 세션» — 첫 syncFromWorld 의 push 가 새 세션의 첫 점이 된다 */
    this.equity.startSession();
    this.syncFromWorld(true);
    this.startLoop();
    /*
     * ★현금 훅(cash100k) 부팅 1회 — 복원된 잔고가 «이미» 문턱 이상이면 여기서 잡는다.
     *   afterOrder 는 주문 «뒤»에만 돌아서, 주문 없이 열기만 하는 계정은 이 한 줄이 유일한 판정 지점이다.
     *   절대 throw 하지 않고 await 하지 않는다. 세션 락이 있어 아래 claimAttendance→afterOrder 와 겹쳐도 1회다.
     */
    this.checkCashPromo();
    /*
     * ★총자산 훅(equity1m) 부팅 1회 — 복원된 총자산이 이 기기의 «기준선»이다.
     *   ★여기만 await 한다: 바로 아래 claimAttendance 가 최대 $100,000 를 «현금에 얹기» 때문에,
     *     기준선을 먼저 확정하지 않으면 출석 보상이 기준선을 밀어 올린다(판정이 달라진다).
     *   복원된 총자산이 «이미» 문턱 이상이면 여기서 had=true 로 박혀 «영구 미지급»이 된다.
     */
    await this.settleEquityBaseline();
    /*
     * ★★출석은 ★«복원이 끝난 뒤»에 지급한다.
     *   ⛔화면 마운트에서 부르면 안 된다 — 마운트가 부팅보다 «먼저»라
     *     지급 직후 `restore()` 의 `deserialize` 가 `acc.cash` 를 저장값으로 덮어써
     *     ★지급분이 조용히 사라진다(일지에는 남고 잔고만 안 는다. 에러 없음).
     *     [2026-08-22 verify_attendance 로 실측해 잡았다]
     *   ★여기는 `warmed=true` 이후라 `world.save()` 도 «실제로» 쓴다.
     */
    this.claimAttendance();
    /*
     * ★연속 접속(프로모션 streak3)도 «여기» — 출석과 같은 지점. 오늘 날짜를 기록하고
     *   3일째면 지급을 요청한다. 절대 throw 하지 않고 await 하지 않는다(게임 흐름 무관).
     */
    void touchStreak();
    /* ★시즌 마감 판정 — 복원·출석 «뒤». 앱을 안 열었던 유저는 여기서 마감 화면을 만난다 */
    this.checkSeason();
  }

  /* ── 시즌 ─────────────────────────────────────────────────────────────── */

  private persistSeason(): void {
    lsSet(SEASON_KEY, JSON.stringify(this.season));
  }

  /**
   * 마감 도달 판정. 부팅 뒤·매 펌프·복귀 시 부른다. ⛔부팅 «중»에는 판정하지 않는다 —
   * 복원 전 화면에 마감이 뜨면 「$10,000 이 마지막 자산」으로 보인다.
   */
  private checkSeason(): void {
    if (this.booting || this.seasonLocked) return;
    if (!seasonEnded(this.season)) return;
    this.seasonLocked = true;
    /* ★잠그는 순간의 상태를 «저장»한다 — 마감 화면에서 앱을 꺼도 같은 자산으로 돌아온다 */
    this.world.save();
    this.journal.flush();
    this.bump();
  }

  /** 마감까지 남은 ms(0 이상). 랭킹 시즌 카드가 읽는다 */
  get seasonRemainMs(): number {
    return seasonRemainMs(this.season);
  }

  /**
   * ★연장 — «리워드 광고를 끝까지 본 뒤»에만 부른다(SeasonGate). 자산·포지션·순위 «그대로», 마감 +7일.
   * ⛔현금을 주지 않는다. 충전 경제(topup/grantAdReward)와 무관하다.
   */
  extendSeason(): void {
    this.season = extendSeasonState(this.season);
    this.persistSeason();
    this.unlockSeason();
  }

  /** ★새 시즌 — 내 계좌 $10,000 초기화. 시장·봇·닉네임·하루 카운터는 그대로(gameWorld.resetSeason) */
  startNewSeason(): void {
    this.world.resetSeason();
    /* 일지는 «이번 시즌»의 기록이다 — 요약(엔진 원장)이 0 으로 돌아가는데 옛 줄이 남으면 요약과 행이 어긋난다 */
    this.journal.clear();
    this.equity.reset();
    this.cbLedger.reset();
    this.season = newSeasonState(this.season);
    this.persistSeason();
    this.unlockSeason();
    this.syncFromWorld(true);
  }

  private unlockSeason(): void {
    this.seasonLocked = false;
    /* ★멈춰 있던 동안의 실시간을 «따라잡지 않는다» — 마감 상태는 시장이 «정지»한 시간이다 */
    this.lastTickAt = Date.now();
    this.bump();
  }

  /** 주문 경로 «전부»가 첫 줄에서 부른다. 마감 상태의 주문은 거절이다 */
  private assertSeasonOpen(): void {
    if (this.seasonLocked) throw new GameError('SEASON_ENDED', 'season ended — choose extend or restart');
  }

  /**
   * ★중앙은행 보기(순위표 시트). 괴리·포지션은 엔진 값 그대로, ★체결·개입 횟수는 «세션을 넘는 원장»(store/history.ts) 이다 —
   *   엔진 링버퍼는 세션마다 비지만 원장은 최근 100건과 누적 횟수를 들고 있다(President 08-30 「중앙은행 거래 기록 초기화」 대응).
   */
  centralBankView(): CentralBankView {
    const v = this.world.centralBankView();
    return { ...v, fills: this.cbLedger.fills.slice(0, 20), interventions: this.cbLedger.total };
  }

  /* ── 부팅(워밍업) 진행 상태 ──────────────────────────────────────────
   * ★왜 «별도» 구독인가: 진행률을 bump() 로 흘리면 워밍업 내내 앱 «전체»가
   *   리렌더된다(홈 100행·차트 포함). 그러면 나눠 돌린 이득이 그대로 사라진다.
   *   여기 구독하는 건 부팅 화면 «하나»뿐이다.
   */
  booting = true;
  bootProgress = 0;
  private bootSubs = new Set<() => void>();
  subscribeBoot = (fn: () => void): (() => void) => {
    this.bootSubs.add(fn);
    return () => this.bootSubs.delete(fn);
  };
  private emitBoot(): void {
    for (const fn of this.bootSubs) fn();
  }

  /**
   * 워밍업을 «프레임 사이»로 나눠 돌린다.
   *
   * ★한 청크의 크기를 «시간»으로 자른다 — 틱 수로 자르면 명부가 3,310명이 됐을 때
   *   한 청크가 프레임을 통째로 먹는다(틱 비용이 명부 크기에 비례한다).
   * ★rAF 를 쓰되 «탭이 숨겨져 있으면» setTimeout 으로 떨어진다 — 숨은 탭에서는
   *   rAF 가 아예 안 불려서 부팅이 영영 안 끝난다(그 상태로 복귀하면 흰 화면이다).
   */
  private warmupChunked(): Promise<void> {
    return new Promise<void>((resolve) => {
      const schedule = (fn: () => void) => {
        if (typeof document !== 'undefined' && document.hidden) window.setTimeout(fn, 16);
        else if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => fn());
        else window.setTimeout(fn, 16);
      };
      const run = () => {
        const t0 = performance.now();
        let done = false;
        do {
          done = this.world.warmupChunk(WARMUP_CHUNK_MIN_TICKS);
        } while (!done && performance.now() - t0 < WARMUP_CHUNK_BUDGET_MS);
        this.bootProgress = this.world.warmupProgress;
        this.emitBoot();
        if (done) resolve();
        else schedule(run);
      };
      schedule(run);
    });
  }

  // ── 게임 루프 + 백그라운드 시간 보정 ─────────────────────────────────
  /**
   * 브라우저는 숨겨진 탭의 setInterval 을 1분에 1회 수준까지 throttle 한다.
   * 단순 setInterval 로 1틱씩 굴리면 탭을 내려둔 만큼 게임 내 시간이 사라져
   * "1 게임일 = 실제 5분" 압축 전제가 깨진다(구 store.ts:304-328 에 보정 없음).
   * 그래서 **실제 경과시간**을 재서 밀린 틱을 몰아서 돌린다.
   * 복귀 즉시 프리즈되지 않도록 한 번에 MAX_CATCHUP_TICKS 까지만 따라잡고
   * 그보다 오래 비운 시간은 "지나간 장"으로 버린다.
   */
  private startLoop(): void {
    if (this.loopTimer) return;
    this.lastTickAt = Date.now();
    this.loopTimer = window.setInterval(() => this.pump(), TICK_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    /*
     * ★[2026-09-01 · play1h] 플레이 «실시간» 누적 비트. 게임 틱(TICK_MS)과 «별개»의 타이머다 —
     *   조건이 게임 내 가속 시간이 아니라 «벽시계 포그라운드 시간»이기 때문(promoRules ⑤).
     *   지금 화면이 보이는 상태면 바로 시계를 건다. 아니면 onVisibility 가 건다.
     */
    if (document.visibilityState === 'visible') playtimeResume();
    if (!this.playTimer) this.playTimer = window.setInterval(() => void playtimeBeat(), PROMO_PLAY_BEAT_MS);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      /* ★[play1h] 포그라운드 복귀 — 여기서부터 «다시» 센다. 백그라운드 시간은 누적되지 않았다 */
      playtimeResume();
      this.pump();
      this.checkSeason();
      /*
       * ★앱을 켜 둔 채 자정을 넘겨 돌아오는 경로. 부팅은 이미 끝났으니 여기서 한 번 더 본다.
       * ★멱등 키가 «날짜»라 같은 날 몇 번을 돌아와도 한 번만 지급된다.
       * ⛔부팅 «중»에는 부르지 않는다 — 위 boot() 주석의 그 사고를 다시 만든다.
       */
      if (!this.booting) {
        this.claimAttendance();
        /* ★앱을 켜 둔 채 자정을 넘긴 경우 연속 접속도 «오늘»로 센다(출석과 같은 이유) */
        void touchStreak();
      }
    } else {
      this.world.save();
      /* ★모아 쓰기(setTimeout 0)가 밀린 채로 탭을 내리면 그대로 유실이다 */
      this.journal.flush();
      this.equity.flush(this.tick);
      /* ★[play1h] 백그라운드 전환 — 시계를 «끊고» 누적분을 반드시 저장한다(여기부터는 안 센다) */
      void playtimePause();
    }
  };

  private onPageHide = (): void => {
    this.world.save();
    this.journal.flush();
    this.equity.flush(this.tick);
    /* ★[play1h] 앱 종료 경로에서도 시계를 끊고 저장한다 */
    void playtimePause();
  };

  private pump(): void {
    if (this.pumping) return;
    this.checkSeason();
    if (this.seasonLocked) {
      /* ★마감 상태 = 시장 «정지». 밀린 틱을 쌓아 두지 않는다(선택 뒤 몰아 도는 일이 없게) */
      this.lastTickAt = Date.now();
      return;
    }
    const now = Date.now();
    const due = Math.floor((now - this.lastTickAt) / TICK_MS);
    if (due <= 0) return;
    this.pumping = true;
    try {
      const run = Math.min(due, MAX_CATCHUP_TICKS);
      // 소비하지 못한 잔여 시간(<TICK_MS)은 다음 pump 로 이월된다.
      this.lastTickAt += due * TICK_MS;
      this.world.advance(run);
      this.syncFromWorld();
    } catch (e) {
      // 한 틱이 터져도 루프는 계속 돈다 (서버 gameService.ts:149 와 같은 방어)
      console.error('[tick] error', e);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * 월드 -> 화면 상태 동기화.
   * @param forceRanks true 면 랭킹을 즉시 계산해 그대로 꽂는다(부팅·초기화 직후).
   *                   false(기본) 면 2틱마다 계산 + 3초 스로틀 재정렬 경로를 탄다.
   *                   랭킹 계산은 211계정 평가라 매 틱 돌리면 비싸다.
   */
  private syncFromWorld(forceRanks = false): void {
    this.tick = this.world.tick;
    this.gameDay = this.world.gameDay;
    for (const t of TICKERS) {
      const q = this.world.quote(t.ticker);
      if (!q) continue;
      const prev = this.quotes.get(t.ticker);
      if (prev && Math.abs(prev.price - q.price) < 1e-9) continue;
      this.quotes.set(t.ticker, q);
      this.bumpPrice(t.ticker);
    }
    this.portfolio = this.world.portfolio();
    this.pushEquity(this.portfolio.equity);
    /*
     * ★[2026-09-01 · equity1m] 총자산 문턱 판정은 «여기»도 필요하다 — 주문을 한 번도 안 해도
     *   보유 종목 «가격»만으로 100만 달러를 넘길 수 있다. 세션 락이 닫히면(promoSettled) 판정조차 안 한다.
     * ⛔부팅 중에는 보지 않는다 — 생성자의 syncFromWorld(true) 는 워밍업·복원 «전» 시드 월드다(pushEquity 와 같은 이유).
     */
    if (!this.booting) this.checkEquityPromo();
    /* ★[-23] 세이브 블롭과 같은 박자(15틱)로 자산 흐름을 쓴다 · 중앙은행 세션 링버퍼에서 새 체결을 흡수한다(엔진 무접촉) */
    if (this.tick % SNAPSHOT_EVERY_TICKS === 0) this.equity.flush(this.tick);
    this.cbLedger.absorb(this.world.world.centralBank.fills);
    this.topup = this.world.topupStatus();
    this.daily = this.world.dailyStatus();
    this.topupFetchedAt = Date.now();
    this.feed = this.world.feed.slice(0, 12);
    /*
     * ★★워밍업 중에 «시작된» 이벤트를 로그에 메운다.
     *
     * ★실렌더로 잡은 버그다: World.emit 은 워밍업 3,000틱 동안 muted 라 발생 이벤트를
     *   «한 건도 흘리지 않는다». 그래서 부팅 직후에는 홈 카드에는 이벤트가 «보이는데»
     *   피드에는 그 소식이 «없었다». 게임 2~5일에 한 번 나는 사건이라, 짧게 하는
     *   세션에서는 피드 연동이 사실상 «항상 비어 있는» 상태였다.
     * ★이건 지어내는 게 아니다 — 그 이벤트는 «지금 실제로 진행 중»이다.
     */
    const act = this.world.world.macro.active;
    if (act && !this.macroLog.some((m) => m.id === act.id)) this.pushMacroLog(act);
    if (forceRanks) {
      this.ranks = this.world.leaderboard(false);
    } else if (this.tick % RANK_EVERY_TICKS === 0) {
      this.queueRanks(this.world.leaderboard(false));
    }
    this.bumpTick();
    this.bump();
  }

  private pushEquity(v: number): void {
    /*
     * ★[-23] 부팅 «전» 값은 그리지 않는다 — 생성자의 syncFromWorld(true) 는 워밍업·복원 «전» 월드(시드 잔고)를 읽는다.
     *   메모리 전용일 땐 세션마다 사라져 무해했지만, 이제 영속되면 재진입마다 «시드 금액 한 점»이 경계 뒤에 박힌다(거짓 급락).
     */
    if (this.booting) return;
    this.equity.push(v);
  }

  // ── 랭킹 3초 스로틀 재정렬 (ui_spec 3.5) ─────────────────────────────
  private queueRanks(all: RankEntry[]): void {
    this.pendingRanks = { all };
    const now = Date.now();
    const wait = Math.max(0, RANK_RESORT_THROTTLE_MS - (now - this.lastResort));
    if (wait === 0) return this.flushRanks();
    if (this.resortTimer) return;
    this.resortTimer = window.setTimeout(() => {
      this.resortTimer = null;
      this.flushRanks();
    }, wait);
  }

  private flushRanks(): void {
    if (!this.pendingRanks) return;
    this.lastResort = Date.now();
    const { all } = this.pendingRanks;
    this.pendingRanks = null;
    /*
     * ★[성능 2026-08-30 · iOS 프레임 저하 대응] 10,000행을 spread 로 «복사»하던 것을 in-place 로 바꿨다.
     *   `all` 은 엔진이 «이 호출을 위해 새로 만든» 배열·객체다(world.computeLeaderboard 가 매번 rows 를 새로 push)
     *   → 여기서 delta 를 써 넣어도 다른 참조가 없다. 4초마다 10k 객체 할당 + GC 압박이 사라진다.
     *   ⛔prevRankById 갱신은 «아래» 루프다 — delta 는 갱신 «전» 값으로 계산해야 한다(순서 유지).
     */
    for (const r of all) {
      const prev = this.prevRankById.get(r.accountId);
      r.delta = prev === undefined ? 0 : prev - r.rank;
    }
    this.ranks = all;

    /*
     * 자산 곡선(equityByAccount) — ★«보이는 계정»만 쌓는다.
     *
     * ★예전에는 명부 «전원»에 대해 60칸 배열을 유지했다.
     *   210명일 때 12,600개 숫자였고, 1,000명이면 60,000개, 30일차 3,310명이면
     *   198,600개 숫자 + 3,310개 배열을 «3초마다» push/shift 한다.
     *   그런데 이 데이터를 실제로 읽는 곳은 «지금 열어 본 프로필 한 명»뿐이다.
     *   3,310개를 유지해서 1개를 그리고 있었다.
     * ★그래서 대상을 (탑 LEADERBOARD_SIZE + 나 + 지금 보고 있는 계정)으로 묶는다.
     *   ⇒ 유지 비용이 «명부 크기와 무관»해진다(항상 ~102개).
     * ★그 밖의 계정을 열면 곡선이 비는데, 화면은 이미 그 상태를 처리한다
     *   (TraderProfile: curve.length <= 1 이면 「불러오는 중」). 그리고 watchAccount() 가
     *   그 계정을 추적 대상에 넣으므로 다음 갱신부터 실제로 채워진다.
     */
    const keep = new Set<string>([LOCAL_ACCOUNT_ID]);
    if (this.watchedAccountId) keep.add(this.watchedAccountId);
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      this.prevRankById.set(r.accountId, r.rank);
      if (i < LEADERBOARD_SIZE) keep.add(r.accountId);
    }
    for (const r of all) {
      if (!keep.has(r.accountId)) continue;
      const h = this.equityByAccount.get(r.accountId) ?? [];
      h.push(r.equity);
      if (h.length > 60) h.shift();
      this.equityByAccount.set(r.accountId, h);
    }
    // 추적 대상에서 빠진 계정의 곡선은 버린다(안 그러면 결국 전원을 들고 있게 된다)
    if (this.equityByAccount.size > keep.size) {
      for (const id of [...this.equityByAccount.keys()]) {
        if (!keep.has(id)) this.equityByAccount.delete(id);
      }
    }
    this.bump();
  }

  /**
   * 프로필을 연 계정을 «추적 대상»에 넣는다. 탑100 밖 참가자도 곡선이 그려지게 하되,
   * 한 번에 «한 명»만 추가한다 — 열어 본 계정을 계속 쌓으면 결국 전원을 들고 있게 된다.
   */
  watchAccount(accountId: string | null): void {
    if (this.watchedAccountId === accountId) return;
    this.watchedAccountId = accountId;
  }

  /** 내 계정 ID (로컬 단독 계정) */
  get myAccountId(): string {
    return LOCAL_ACCOUNT_ID;
  }

  /** 내 순위 (전체 기준) */
  get myRank(): RankEntry | null {
    return this.ranks.find((r) => r.accountId === this.myAccountId) ?? null;
  }

  // ── 거시 이벤트(시황) ─────────────────────────────────────────────────
  /**
   * ★★엔진이 «선언한 것»이 아니라 ★«실제로 적용한 것»을 보여준다.
   *
   * ★왜 `MacroEvent.sectors` 를 그대로 안 쓰나 [코드 실측]:
   *   macro.ts spawn() 은 `recession_fear` 일 때만 sectors 를 채우고
   *   `rate_cut` · `earnings_season` 은 ★«빈 배열»을 준다. 그대로 그리면 3종 중 2종이
   *   「시장 전체」로만 떠서 ★「어느 종목을 살까」로 이어지는 고리가 끊긴다.
   *   그런데 실제 차별화는 존재한다 — rate_cut 은 tier 별(빅테크·성장주 1.5배),
   *   earnings_season 은 ★종목별로 «부호»가 갈린다.
   * ⇒ ★그래서 `priceEngine.driftBonus`(엔진이 «진짜로 꽂아 둔» 종목별 보정)를 읽어 유도한다.
   *   지어낸 숫자가 아니라 «가격을 실제로 움직이는 그 값»이다.
   *
   * ★그리고 ⛔「지금 사세요」를 «만들지 않는다» — 업종과 방향이라는 «사실»만 준다.
   *   판단은 유저 몫이다(카피 금칙어표).
   */
  private macroMemo: { id: string; sectors: MacroSector[]; splitsByStock: boolean } | null = null;

  get macro(): MacroView | null {
    const ev = this.world.world.macro.active;
    if (!ev) return null;
    const endTick = ev.startTick + ev.durationTicks;
    const left = endTick - this.tick;
    /*
     * ★음수 방어가 «필요하다». gameWorld.restore() 는 워밍업 뒤 `world.tick = s.tick` 으로
     *   틱을 «점프»시킨다 — 워밍업 중에 시작된 이벤트는 그 순간 이미 만료 상태다.
     *   (엔진이 다음 step() 에서 정리하지만 그 «한 틱 사이»에 화면이 그려질 수 있다)
     */
    if (left <= 0 || ev.durationTicks <= 0) return null;

    if (this.macroMemo?.id !== ev.id) this.macroMemo = { id: ev.id, ...this.deriveMacroSectors() };
    return {
      id: ev.id,
      type: ev.type,
      titleKey: ev.titleKey,
      bodyKey: ev.bodyKey,
      progress: Math.min(1, Math.max(0, 1 - left / ev.durationTicks)),
      remainGameDays: left / TICKS_PER_GAME_DAY,
      remainSeconds: (left * TICK_MS) / 1000,
      sectors: this.macroMemo.sectors,
      splitsByStock: this.macroMemo.splitsByStock,
    };
  }

  /**
   * driftBonus 를 업종별로 접는다.
   *
   * ★업종 칩을 «아무 때나» 띄우지 않는 이유: 실적 시즌은 같은 업종 안에서도 부호가 갈린다.
   *   그때 업종 하나를 「오르는 쪽」으로 찍어 주면 ★그건 사실이 아니다.
   *   ⇒ 부호 «일치율»(consistency)이 낮으면 업종 칩을 «내리고» 「종목별로 갈린다」고만 말한다.
   *   ⇒ 이벤트 종류를 하드코딩하지 «않는다» — 데이터에서 판정하므로 엔진이 바뀌면 화면이 따라온다.
   */
  private deriveMacroSectors(): { sectors: MacroSector[]; splitsByStock: boolean } {
    const drift = this.world.world.engine.driftBonus;
    const agg = new Map<string, { sum: number; pos: number; n: number; en: string }>();
    let total = 0;
    let totalPos = 0;
    for (const t of TICKERS) {
      const b = drift.get(t.ticker);
      if (b === undefined || !Number.isFinite(b) || b === 0) continue;
      let a = agg.get(t.sectorKo);
      if (!a) {
        a = { sum: 0, pos: 0, n: 0, en: t.sectorEn };
        agg.set(t.sectorKo, a);
      }
      a.sum += b;
      a.n++;
      if (b > 0) a.pos++;
      total++;
      if (b > 0) totalPos++;
    }
    if (total === 0) return { sectors: [], splitsByStock: false };

    const overall = Math.max(totalPos, total - totalPos) / total;
    // 전체 부호 일치율이 낮다 = 「업종」이 아니라 「종목」 단위 이벤트다
    const splitsByStock = overall < MACRO_SECTOR_CONSISTENCY;
    if (splitsByStock) return { sectors: [], splitsByStock: true };

    const rows: MacroSector[] = [];
    for (const [nameKo, a] of agg) {
      if (a.n < 2) continue; // 1종목짜리 업종은 「업종이 움직인다」의 근거가 못 된다
      if (Math.max(a.pos, a.n - a.pos) / a.n < MACRO_SECTOR_CONSISTENCY) continue;
      rows.push({ nameKo, nameEn: a.en, dir: a.sum >= 0 ? 1 : -1, weight: Math.abs(a.sum / a.n) });
    }
    rows.sort((x, y) => y.weight - x.weight);
    return { sectors: rows.slice(0, MACRO_SECTOR_SHOWN), splitsByStock: false };
  }

  /**
   * 지금 «이 종목»이 진행 중인 이벤트의 영향을 받고 있나 (종목 화면용).
   * ★방향은 주지 않는다 — 종목 단위로 「오른다/내린다」를 찍어 주면 그게 떠먹이는 것이다.
   *   「지금 이런 일이 있다」까지만 알리고 판단은 맡긴다.
   */
  macroTouches(ticker: string): boolean {
    if (!this.world.world.macro.active) return false;
    const b = this.world.world.engine.driftBonus.get(ticker);
    return b !== undefined && Number.isFinite(b) && b !== 0;
  }

  // ── 파생 «정산» ───────────────────────────────────────────────────────
  /**
   * ★★만기 정산은 «손익이 확정되는 순간»이다 — 돈이 바뀌는데 유저가 아무것도 못 보면 안 된다.
   *   예전에는 엔진이 포지션을 «삭제»하고 끝이라 ★카드가 그냥 «사라졌다».
   *   유저는 「내 계약이 어디 갔지?」를 겪는다(사양서 §4 「정산됨으로 바뀌고 결과 표시」).
   *
   * ★두 갈래로 나눈다 — ⛔같은 것을 두 번 알리지 않는다:
   *   · ★내 정산  → «토스트». 지금 내 돈이 바뀐 일이라 놓치면 안 된다.
   *   · ★남의 정산 → «홈 피드». 시장이 살아 있다는 신호다(표본추출한다 — 전부 올리면 흘러간다).
   */
  settledLog: SettledLogItem[] = [];

  private settledId = 0;

  /**
   * ★같은 포지션의 «개시 줄»을 찾아 상품 정보를 잇는다.
   *   정산 이벤트에는 만기·행사가·매수매도 같은 «계약 조건»이 없다(포지션이 이미 지워졌다).
   *   ⇒ 지어내지 «않고», 내가 기록해 둔 개시 줄에서 가져온다. 없으면 그 필드는 «비운다».
   */
  private openEntryOf(positionId: string): JournalEntry | undefined {
    return this.journal.entries.find((x) => x.posId === positionId && x.action === 'open');
  }

  /** 내 레버리지·선물 강제청산 — `settled` 가 아닌 별도 채널로 온다 */
  private onMyLiquidation(e: { ticker: string; positionId: string; leverage: number; side: LevSide; loss: number; returned: number; price: number }): void {
    const open = this.openEntryOf(e.positionId);
    this.journal.push({
      ...this.jbase(),
      /* 개시 줄이 있으면 선물/레버리지를 구분한다. 없으면(옛 포지션) 레버리지로 둔다 */
      product: open?.product === 'futures' ? 'futures' : 'leverage',
      action: 'liquidated',
      ticker: e.ticker,
      side: e.side,
      price: e.price,
      notional: open?.notional,
      margin: open?.margin,
      leverage: e.leverage,
      /* 청산 수수료는 엔진이 realizedPnl 안에서 이미 차감했다 — 여기서 또 세지 않는다 */
      fee: 0,
      /* ★`loss = margin − returned` 이므로 원장 증분(`returned − margin`)은 정확히 −loss 다 */
      realized: -e.loss,
      posId: e.positionId,
    });
  }

  private onSettled(e: {
    kind: 'forward' | 'swap' | 'futures' | 'option';
    accountId: string;
    nickname: string;
    isBot: boolean;
    positionId: string;
    ticker: string;
    tickerB?: string;
    pnl: number;
    returned: number;
    forced: boolean;
  }): void {
    if (e.accountId === LOCAL_ACCOUNT_ID) {
      /*
       * ★문구를 «네 갈래»로 가른다. 같은 문장을 쓰면 뜻이 뒤집힌다:
       *   ① 강제 정리 : 「만기」가 아니다 — 증거금이 버티지 못한 것이다
       *   ② 돌려받은 게 «0»  : 옵션 매수가 외가격으로 만기된 경우다.
       *      ★유저에게 «가장 헷갈리는» 순간이다(「돈이 그냥 없어졌다」로 읽힌다).
       *      ⇒ ★사실대로 쓴다: 권리를 안 쓰고 끝났고 프리미엄만큼 손해다.
       *      ⛔변명조·위로조를 붙이지 않는다.
       *   ③ 이익 · ④ 손실
       */
      const key = e.forced
        ? 'derivatives:toast.settledForced'
        : e.returned <= 0
          ? 'derivatives:toast.settledExpired'
          : 'derivatives:toast.settled';
      this.pushToast(
        String(
          i18next.t(key, {
            ticker: e.ticker,
            v: fmtSignedMoney(e.pnl),
            r: fmtMoney(Math.max(0, e.returned)),
          })
        ),
        e.pnl < 0 ? 'error' : 'default'
      );
      /*
       * ★일지에도 남긴다 — 토스트는 2.6초 뒤 사라진다. 「내 계약이 어디 갔지」의
       *   답이 «영구히» 있어야 하는 곳이 일지다.
       * ★`e.pnl` 은 ★엔진이 그 순간 `acc.realizedPnl` 에 «더한 바로 그 값»이다
       *   [코드 실측: settleExpired 4종·checkLiquidations 의 emit 인자 = 원장 증분].
       *   ⇒ 화면이 다시 계산하지 않는다.
       */
      const open = this.openEntryOf(e.positionId);
      this.journal.push({
        ...this.jbase(),
        product: e.kind,
        action: e.forced ? 'liquidated' : 'settle',
        ticker: e.ticker,
        tickerB: e.tickerB ?? open?.tickerB,
        side: open?.side,
        qty: open?.qty,
        notional: open?.notional,
        margin: open?.margin,
        leverage: open?.leverage,
        optKind: open?.optKind,
        optSide: open?.optSide,
        strike: open?.strike,
        /* 정산 자체에는 수수료가 붙지 않는다(엔진이 걷는 자리가 아니다) */
        fee: 0,
        realized: e.pnl,
        posId: e.positionId,
      });
      return;
    }
    /*
     * ★남의 정산 — 표본추출한다. 봇이 파생을 굴리므로 전부 올리면 피드가 1초 만에 흘러간다
     *   (gameWorld 가 체결 피드에 쓰는 것과 같은 이유·같은 비율대).
     * ★그리고 «작은» 정산은 올리지 않는다 — 「+$0.10 정산」은 소식이 아니다.
     */
    if (Math.abs(e.pnl) < SETTLED_FEED_MIN_PNL || !this.settledRng.bool(SETTLED_FEED_SAMPLE)) return;
    this.settledLog.unshift({
      id: `st_${++this.settledId}`,
      at: Date.now(),
      gameDay: this.world.gameDay,
      kind: e.kind,
      nickname: e.nickname,
      ticker: e.ticker,
      tickerB: e.tickerB,
      pnl: e.pnl,
      forced: e.forced,
    });
    if (this.settledLog.length > SETTLED_LOG_MAX) this.settledLog.pop();
    this.bump();
  }

  /** 지나간 이벤트까지 포함한 최근 소식 (홈 피드에 섞는다) */
  macroLog: MacroLogItem[] = [];

  private pushMacroLog(ev: { id: string; type: MacroType; titleKey: string; bodyKey: string }): void {
    this.macroLog.unshift({
      id: ev.id,
      at: Date.now(),
      gameDay: this.world.gameDay,
      type: ev.type,
      titleKey: ev.titleKey,
      bodyKey: ev.bodyKey,
    });
    if (this.macroLog.length > MACRO_LOG_MAX) this.macroLog.pop();
    this.macroMemo = null; // 새 이벤트 = 업종 유도 다시
    this.bump();
  }

  /**
   * 유지증거금 산정 기준 — ARCHITECTURE 2장 Chief GATE 확정분('initial_margin').
   * 서버가 없으므로 constants.ts 값이 곧 게임 규칙이다.
   */
  get maintenanceBasis(): MaintenanceBasis {
    return MAINTENANCE_BASIS;
  }

  // ── 계정 ─────────────────────────────────────────────────────────────
  /**
   * 닉네임 등록 = 로컬 계정 생성.
   *
   * 구 구현은 서버 register 를 때리고 실패 시에만 게스트로 떨어지는 구조였다
   * (store.ts:565-585). 서버가 없어졌으므로 그 **게스트 경로가 정상 경로**다.
   * 화면은 `await s.register(...)` 를 그대로 쓰므로 async 시그니처를 유지한다.
   */
  async register(nickname: string): Promise<void> {
    this.session = { userId: LOCAL_ACCOUNT_ID, token: '', nickname };
    lsSet(LS.session, JSON.stringify(this.session));
    this.world.setNickname(nickname);
    this.bump();
  }

  finishOnboarding(): void {
    this.onboarded = true;
    lsSet(LS.onboarded, '1');
    this.bump();
  }

  /**
   * 계정 초기화. 서버가 없으므로 "로그아웃 = 처음부터 다시"다.
   * 저장된 계좌를 지우지 않으면 새 닉네임이 남의 포트폴리오를 물려받는다.
   */
  signOut(): void {
    this.session = null;
    this.onboarded = false;
    lsRemove(LS.session);
    lsRemove(LS.onboarded);
    /* 관심 참가자도 「처음부터 다시」에 포함된다 — 남겨두면 새 계정이 남의 목록을 물려받는다 */
    this.watchedTraders = [];
    lsRemove(LS.traderWatch);
    /* ★일지도 「처음부터 다시」에 포함된다 — 남겨두면 새 계정이 남의 기록을 물려받는다 */
    this.journal.clear();
    this.attendance.clear();
    this.world.resetPlayer();
    this.equity.reset();
    this.cbLedger.reset();
    this.syncFromWorld(true);
  }

  setWatchlist(list: string[]): void {
    this.watchlist = list;
    lsSet(LS.watchlist, JSON.stringify(list));
    this.bump();
  }

  toggleWatch(ticker: string): void {
    const next = this.watchlist.includes(ticker)
      ? this.watchlist.filter((t) => t !== ticker)
      : [...this.watchlist, ticker];
    this.setWatchlist(next);
  }

  /* ── 관심 참가자 ─────────────────────────────────────────────────── */

  isWatchedTrader(accountId: string): boolean {
    return this.watchedTraders.includes(accountId);
  }

  /**
   * 관심 참가자 토글.
   *
   * ★반환값이 «결과»인 이유: 상한(WATCHED_TRADERS_MAX)에 걸리면 «아무 일도 안 일어난다».
   *   그때 화면이 조용히 넘어가면 유저는 버튼이 고장 난 줄 안다 — 오늘 이 앱에서
   *   가짜 버튼이 3건 나온 게 정확히 그 실패 유형이다. 호출부는 'full' 을 받으면
   *   반드시 토스트를 띄운다.
   * ★관심 «목록 보기»는 무료다. 열람권은 프로필을 «열 때»만 소모한다(TraderProfile).
   */
  toggleWatchedTrader(accountId: string): 'added' | 'removed' | 'full' {
    if (!accountId || accountId === LOCAL_ACCOUNT_ID) return 'full';
    if (this.watchedTraders.includes(accountId)) {
      this.watchedTraders = this.watchedTraders.filter((x) => x !== accountId);
      this.persistWatchedTraders();
      return 'removed';
    }
    if (this.watchedTraders.length >= WATCHED_TRADERS_MAX) return 'full';
    this.watchedTraders = [accountId, ...this.watchedTraders];
    this.persistWatchedTraders();
    return 'added';
  }

  private persistWatchedTraders(): void {
    lsSet(LS.traderWatch, JSON.stringify(this.watchedTraders));
    this.bump();
  }

  // ── 설정 ─────────────────────────────────────────────────────────────
  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    lsSet(LS.settings, JSON.stringify(this.settings));
    this.applyDom();
    this.bump();
  }

  applyDom(): void {
    const el = document.documentElement;
    const dark =
      this.settings.theme === 'dark' ||
      (this.settings.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    el.setAttribute('data-theme', dark ? 'dark' : 'light');
    el.setAttribute('data-updown', this.settings.updown === 'us' ? 'us' : 'kr');
    el.lang = this.settings.lang;
  }

  // ── 토스트 ───────────────────────────────────────────────────────────
  /**
   * 토스트를 띄운다. **text 는 이미 번역된 문자열이다** (i18n 키가 아니다).
   *
   * [P3 실측 2026-08-05] 예전 주석은 "i18n 키"라고 했지만 호출부 8곳은 전부
   * `t(...)` 로 번역한 문자열을 넘기고 있었고, AppFrame 이
   * `text.includes('.') ? t(text) : text` 휴리스틱으로 둘 다 받아냈다.
   * 마침표가 들어간 카피가 들어오는 순간 키로 오인해 깨지는 구조라 계약을
   * "번역된 문자열" 하나로 확정했다. 스토어 내부에서 띄우는 토스트는
   * i18next 싱글턴으로 직접 번역해서 넘긴다(아래 onOptionSettled).
   */
  pushToast(text: string, tone: Toast['tone'] = 'default'): void {
    this.showToast({ text, tone });
  }

  /**
   * 토스트 표시. `action` 이 있으면 「되돌리기」 버튼이 붙고 노출 시간이 길어진다.
   * ★ 되돌리기에 5초를 주는 이유: 3초는 「어? 잘못 눌렀다」를 인지하기 전에
   *   사라진다. 반대로 너무 길면 다음 화면까지 따라다녀 방해가 된다.
   */
  showToast({
    text,
    tone = 'default',
    action,
    onExpire,
  }: {
    text: string;
    tone?: Toast['tone'];
    action?: Toast['action'];
    /**
     * ★[-33] 토스트가 «타이머로» 닫힐 때(= 액션을 누르지 «않고» 창이 지났을 때)만 불린다.
     *   액션(되돌리기)이 먼저 닫았으면 안 불린다 — commitOrder 가 「완료된 거래」를 이걸로 가른다.
     */
    onExpire?: () => void;
  }): number {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, text, tone, action }];
    this.bump();
    window.setTimeout(
      () => {
        /* ★아직 떠 있었다 = 액션 없이 창이 닫힌 것. 액션이 닫았으면 이미 목록에 없다 */
        const alive = this.toasts.some((x) => x.id === id);
        this.dismissToast(id);
        if (alive) onExpire?.();
      },
      action ? UNDO_WINDOW_MS : 2600
    );
    return id;
  }

  dismissToast(id: number): void {
    if (!this.toasts.some((x) => x.id === id)) return;
    this.toasts = this.toasts.filter((x) => x.id !== id);
    this.bump();
    /* ★되돌리기를 «눌러서» 창이 닫힌 경우 — 미뤄 둔 전면이 여기서 풀린다(onExpire 는 안 온다) */
    this.maybeFlushTradeInterstitial();
  }

  /**
   * 파생 주문 되돌리기. 포지션이 이미 사라졌으면(강제청산·만기소멸) false.
   * 되돌리기 실패를 «조용히» 넘기지 않는다 — 유저는 돈이 돌아온 줄 안다.
   */
  undoDerivativeOrder(kind: 'option' | 'leverage', positionId: string): boolean {
    const ok = kind === 'option' ? this.world.cancelOption(positionId) : this.world.cancelLeverage(positionId);
    this.portfolio = this.world.portfolio();
    this.topup = this.world.topupStatus();
    this.daily = this.world.dailyStatus();
    this.topupFetchedAt = Date.now();
    this.bump();
    return ok;
  }

  dismissLiquidation(): void {
    this.liquidation = null;
    this.bump();
  }

  // ── 거래 일지 기록 ───────────────────────────────────────────────────
  /**
   * ★★엔진 «원장» 스냅샷. 일지의 `fee` · `realized` 는 이 값의 «증분»이다.
   *
   * ⛔화면이 손익·수수료를 «다시 계산하지 않는» 이유(아래 closeOptionPosition 주석의
   *   함정과 같은 뿌리): 옵션 매도는 계산식이 매수와 «다르다». 매수식을 쓰면
   *   수수료가 이중으로 붙고 realizedPnl 이 매수 기준으로 기록된다 —
   *   ★에러가 안 나고 «숫자만» 틀린다. 그래서 일지는 «엔진이 실제로 장부에 적은 값»의
   *   차이만 읽는다. 엔진이 규칙을 바꾸면 일지가 자동으로 따라온다.
   */
  private ledger(): { realized: number; fees: number } {
    const a = this.world.world.getAccount(this.world.playerId);
    return { realized: a.realizedPnl, fees: a.feesPaid };
  }

  /**
   * ★포트폴리오 복사가 «진행 중»일 때 그 대상 닉네임. 이 동안 밀리는 일지 줄에 `via` 가 붙는다.
   *   ⛔복사 실행(copyPortfolio) 밖에서 세우지 마라. 끝나면 finally 에서 반드시 비운다.
   */
  private copyVia: string | null = null;

  /** 모든 일지 항목의 공통 머리 — 시각·틱·게임일 (+ 복사 중이면 «누구를 따라» 표지) */
  private jbase(): Pick<JournalEntry, 'at' | 'tick' | 'gameDay' | 'via'> {
    return {
      at: Date.now(),
      tick: this.world.tick,
      gameDay: this.world.gameDay,
      ...(this.copyVia ? { via: this.copyVia } : {}),
    };
  }

  // ── 주문 규모·임팩트 (★화면이 «계산하지 않게» 하려고 낸 통로) ─────────
  /*
   * ⛔[2026-09-05 President 결정] 「괜찮아. 캡 풀어.」
   *   여기 있던 `maxOrderNotional(ticker)` · `maxOrderNotionalAll(tickers)` 래퍼를 «제거»했다.
   *   현물·파생 전 경로에서 유동성 상한이 사라졌으므로 ★화면이 그 값을 알 이유가 없다.
   *   ⛔다시 만들지 마라 — 화면이 상한을 «알면» 언젠가 다시 상한을 «건다».
   * ★엔진의 `world.maxOrderNotional()` 자체는 «남아 있다» — 봇·중앙은행·concepts 가
   *   주문 사이징에 쓴다. 그건 «거절 기준»이 아니라 «사이징 힌트»다.
   * ★화면에 남은 통로는 아래 `priceImpactFrac` 하나다 — 이제 그것이 유일한 브레이크이고,
   *   유저가 「얼마나 불리해지는지」를 보는 유일한 창이다. ⛔지우지 마라.
   */

  /**
   * 최근 n틱 «거래대금». 종목 화면 「거래량순」 정렬용.
   * ⛔화면이 거래량을 «직접 세지» 않게 하려고 낸 통로다 — 엔진 volumeOver 를 그대로 흘린다.
   */
  volumeOf(ticker: string, ticks: number): number {
    try {
      return this.world.world.engine.volumeOver(ticker, ticks);
    } catch {
      return 0;
    }
  }

  /** 이 주문이 체결가를 미는 «비율»(매수 +, 매도 −). 곱하기 100 하면 % 다 */
  priceImpactFrac(ticker: string, signedNotional: number): number {
    try {
      return this.world.world.priceImpactFrac(ticker, signedNotional);
    } catch {
      return 0;
    }
  }

  // ── 배당 수령 ────────────────────────────────────────────────────────
  /**
   * ★«묶어서» 처리한다. 낱개로 두면 토스트가 쌓이고 일지가 도배된다.
   *
   * [코드 실측] `stepDividends` 는 «종목마다» 이벤트를 따로 쏜다. 그리고 따라잡기
   * (`MAX_CATCHUP_TICKS` 300틱)가 돌면 «여러 틱»이 한 번의 `pump()` 안에서 연달아 온다.
   * ⇒ `setTimeout 0` 으로 미루면 배치 경계가 «pump 와 같아진다» — 한 번에 한 줄, 한 토스트.
   * ★배당 주기가 750틱이라 catchup(≤300틱) 한 번에 같은 종목이 두 번 지급될 수는 «없다».
   *   그래서 종목 수 = 이벤트 수인 것이 정상이지만, ⛔그렇게 «가정하지 않고» Set 으로 센다.
   */
  private divBuf: DividendEvent[] = [];
  private divTimer: number | null = null;

  private onMyDividend(e: DividendEvent): void {
    this.divBuf.push(e);
    if (this.divTimer !== null) return;
    this.divTimer = window.setTimeout(() => {
      this.divTimer = null;
      this.flushDividends();
    }, 0);
  }

  private flushDividends(): void {
    const buf = this.divBuf;
    if (buf.length === 0) return;
    this.divBuf = [];

    let total = 0;
    const tickers = new Set<string>();
    for (const d of buf) {
      total += d.amount;
      tickers.add(d.ticker);
    }
    if (!(total > 0)) return;
    const n = tickers.size;
    /* 종목이 «하나»일 때만 종목명을 쓴다 */
    const only = n === 1 ? buf[0].ticker : '';
    /* ★주당 배당금·보유 수량은 이벤트가 «정확히 한 건»일 때만 뜻이 있다.
       ⛔여러 건을 buf[0] 으로 대표시키지 마라 — 금액은 합인데 단가는 한 건 것이 되어 어긋난다. */
    const one = buf.length === 1 ? buf[0] : null;

    this.journal.push({
      ...this.jbase(),
      product: 'dividend',
      action: 'grant',
      ticker: only,
      count: n > 1 ? n : undefined,
      qty: one && one.perShare > 0 ? one.amount / one.perShare : undefined,
      price: one ? one.perShare : undefined,
      /* ★`reward` 와 «같은 자리»에 금액을 둔다 — 일지 행이 상품마다 다른 필드를 보지 않게 */
      notional: total,
      fee: 0,
    });

    /*
     * ★토스트는 «한 번만». 그리고 ★배당락을 «같이» 말한다 —
     *   배당을 준 틱에 주가가 그만큼 내려가는데(dividends.ts 설계 ③) 설명이 없으면
     *   유저는 「배당 받았는데 왜 물렸지」로 읽는다. 이 기능의 가장 큰 오해 지점이다.
     * ⛔경고문이 아니라 «기능 설명»이다. 토스트는 nowrap 이 아니라 길어지면 줄바꿈된다(app.css).
     */
    this.pushToast(
      String(
        i18next.t(only ? 'common:toast.dividend' : 'common:toast.dividendMulti', {
          tk: only,
          n,
          v: fmtSignedMoney(total, 2),
        })
      )
    );
    this.bump();
  }

  /**
   * 되돌리기 후 화면 동기화 + ★일지에서 그 줄을 «지운다».
   * ★되돌린 주문이 일지에 남으면 유저는 자기 기록을 못 믿는다 — 없던 일이어야 한다.
   */
  private finishUndoJ(ok: boolean, jid: string): boolean {
    if (ok) this.journal.remove(jid);
    return this.finishUndo(ok);
  }

  // ── 주문 ─────────────────────────────────────────────────────────────
  /*
   * 주문은 전부 동기 체결이다(같은 프로세스 안의 World). 화면이 `await` 하고
   * 있으므로 시그니처만 Promise 로 유지한다. 거절은 GameError(code) 로 던진다 —
   * 화면은 e.code 로 메시지를 고른다(OrderSheet.tsx:68 등).
   */
  /**
   * 현물 주문. ★스와이프 확인을 없앤 대신 «되돌리기 핸들»을 돌려준다.
   * 화면은 이 핸들을 토스트의 action 에 그대로 물린다.
   */
  async orderSpot(ticker: string, side: Side, qty: number): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const prev = this.world.holdingSnapshot(ticker);
    const before = this.ledger();
    const r = this.world.spot(ticker, side, qty);
    this.afterOrder();
    const after = this.ledger();
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'spot',
      /* 매수 = 자리를 «연다» · 매도 = 자리를 «닫는다». 실현손익은 매도에만 생긴다 */
      action: side === 'buy' ? 'open' : 'close',
      ticker,
      side,
      qty: r.qty,
      price: r.price,
      notional: r.gross,
      fee: after.fees - before.fees,
      ...(side === 'sell' ? { realized: after.realized - before.realized } : {}),
    });
    const snap = {
      ticker,
      side,
      qty: r.qty,
      gross: r.gross,
      fee: r.fee,
      prevQty: prev.qty,
      prevAvgCost: prev.avgCost,
    };
    /*
     * [제거 2026-08-29] 여기 있던 「거래 성공 → 100원」 프로모션 호출.
     *   콘솔에서 그 프로모션이 «종료»돼 코드가 죽었다 — 죽은 코드 호출은 실패만 남긴다.
     *   후속 훅 3종(연속접속·10종목·100위)은 afterOrder/랭킹 갱신/boot 에 붙어 있다.
     */
    return { undo: () => this.finishUndoJ(this.world.cancelSpot(snap), jid) };
  }

  async openLeverage(ticker: string, side: LevSide, leverage: number, margin: number): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.openLev(ticker, side, leverage, margin);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'leverage',
      action: 'open',
      ticker,
      side,
      price: p.entryPrice,
      notional: p.notional,
      margin: p.margin,
      leverage: p.leverage,
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelLeverage(id), jid) };
  }

  async closeLeverage(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    /* ★청산 «전»에 원장을 읽는다 — 닫고 나면 포지션이 지워져 상품 구분이 사라진다 */
    const acc = this.world.world.getAccount(this.world.playerId);
    const pos = acc.levPositions.get(positionId);
    const before = this.ledger();
    this.world.closeLev(positionId);
    this.afterOrder();
    const after = this.ledger();
    if (pos) {
      this.journal.push({
        ...this.jbase(),
        /* ★만기가 붙어 있으면 «선물», 없으면 무기한 레버리지다(같은 원장·다른 상품) */
        product: pos.expiryTick === undefined ? 'leverage' : 'futures',
        action: 'close',
        ticker: pos.ticker,
        side: pos.side,
        notional: pos.notional,
        margin: pos.margin,
        leverage: pos.leverage,
        fee: after.fees - before.fees,
        realized: after.realized - before.realized,
        posId: positionId,
      });
    }
  }

  /**
   * ★옵션 주문 «견적» — 화면이 「얼마 필요한가」를 «엔진에게 묻는» 통로.
   *
   * ⛔주문이 아니다. 상태를 바꾸지 않으므로 렌더 중에 불러도 안전하다.
   * ★★왜 이게 있어야 하나 [2026-08-21 실렌더로 잡은 결함]:
   *   화면이 필요현금을 «현재가»로 직접 계산했더니, 델타헤지 임팩트를 반영하는
   *   엔진과 값이 갈려 「최대」 계약수로 확정할 때 ★INSUFFICIENT_CASH 가 났다.
   *   임팩트는 계약 수에 «비선형»이라 1계약 비용에 곱해서 맞힐 수 없다.
   *   ⇒ U-7 규율(⛔엔진 계산식을 화면에 복제하지 마라) 그대로, «엔진이 답한다».
   *   ⇒ `world.optionQuote` 는 `buyOption`·`writeOption` 이 실제로 쓰는 «바로 그 함수»다.
   */
  optionQuote(
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number,
    side: 'buy' | 'sell'
  ) {
    return this.world.world.optionQuote(ticker, kind, strike, expiryGameDays, contracts, side);
  }

  /** contracts 는 "계약 수". ★1계약 = sharesPerContractOf(ticker) 주 — 종목마다 다르다 */
  async buyOption(
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number
  ): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.buyOption(ticker, kind, strike, expiryGameDays, contracts);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'option',
      action: 'open',
      ticker,
      qty: p.contracts,
      /* 계약 1장당 프리미엄 — 화면이 「$xx × N계약」으로 읽는다 */
      price: p.contracts > 0 ? p.premiumPaid / p.contracts : 0,
      notional: p.premiumPaid,
      optKind: p.kind,
      optSide: 'buy',
      strike: p.strike,
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelOption(id), jid) };
  }

  /**
   * @deprecated ★화면은 `closeOptionPosition` 을 써라 — 매도 포지션에 이걸 부르면
   *   수수료가 이중 부과된다(엔진이 IS_SHORT 로 막지만, 「막혔다」가 「맞다」는 아니다).
   *   남겨 두는 이유는 되돌리기 경로 검사(undoWiringStatus)와 옛 호출부 호환뿐이다.
   */
  async sellOption(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    this.closeOptionRecorded(positionId, () => this.world.sellOption(positionId));
  }

  /**
   * ★★옵션 포지션 «정리» — 매수/매도에 따라 «다른 엔진 메서드»를 부른다.
   *
   * ★왜 화면이 고르게 두지 않는가: 매도에 `sellOption` 을 부르면
   *   ★수수료가 «이중 부과»되고 realizedPnl 이 «매수 기준»으로 기록된다.
   *   엔진이 차단하도록 고쳐졌지만, ★차단은 「에러를 본다」는 뜻이지 「맞게 동작한다」가 아니다.
   * ★화면이 3곳(홈·파생 허브·앞으로 늘어날 곳)이라 «한 곳만» 빠뜨려도 티가 안 난다.
   *   ⇒ 그래서 판정을 «원장»에서 하고, 화면은 이 메서드 하나만 부른다.
   */
  async closeOptionPosition(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    this.closeOptionRecorded(positionId, () => {
      const acc = this.world.world.getAccount(this.world.playerId);
      const pos = acc.optPositions.get(positionId);
      if (!pos) return;
      if (pos.side === 'sell') this.world.buybackOption(positionId);
      else this.world.sellOption(positionId);
    });
  }

  /**
   * ★옵션 정리를 «한 통로»로 모은다 — 일지 기록 + 화면 동기화.
   *
   * ★`optSide` 를 반드시 남긴다: 매도 청산은 손익식이 매수와 «다르다»
   *   (매도 손익 = premiumPaid − feePaid − optionMarkValue). 화면이 그걸 «구분해서»
   *   보여주지 않으면 같은 「옵션 청산」 줄이 두 가지 뜻을 갖는다.
   * ★값 자체는 엔진 원장의 증분이다 — 화면이 어느 식도 복제하지 않는다.
   */
  private closeOptionRecorded(positionId: string, run: () => void): void {
    const acc = this.world.world.getAccount(this.world.playerId);
    const pos = acc.optPositions.get(positionId);
    if (!pos) return; // 이미 만기소멸/정리됨 — 조용히 넘긴다(화면은 다음 틱에 사라진다)
    const snap = { ticker: pos.ticker, kind: pos.kind, strike: pos.strike, contracts: pos.contracts, side: pos.side };
    const before = this.ledger();
    run();
    this.afterOrder();
    const after = this.ledger();
    this.journal.push({
      ...this.jbase(),
      product: 'option',
      action: 'close',
      ticker: snap.ticker,
      qty: snap.contracts,
      optKind: snap.kind,
      optSide: snap.side === 'sell' ? 'sell' : 'buy',
      strike: snap.strike,
      fee: after.fees - before.fees,
      realized: after.realized - before.realized,
      posId: positionId,
    });
  }

  /**
   * ★선물 «남은 만기»(게임일). null = 무기한(기존 레버리지).
   * ★portfolio() 의 LeverageView 에는 이 값이 «없어서» 원장에서 직접 읽는다 —
   *   읽기 전용이고, 계산은 틱 나눗셈뿐이라 엔진 식을 복제하지 않는다.
   */
  levRemainGameDays(positionId: string): number | null {
    const acc = this.world.world.getAccount(this.world.playerId);
    const p = acc.levPositions.get(positionId);
    if (!p || p.expiryTick === undefined) return null;
    return Math.max(0, (p.expiryTick - this.world.tick) / TICKS_PER_GAME_DAY);
  }

  // ── 파생 4종 (선물 · 옵션매도 · 선도 · 스왑) — 2026-08-20 ────────────
  /**
   * ★★호가 «주문 세션 ID» — 차익거래 방지 장치 ③ 「재추첨 금지」의 구현부다.
   *
   * ★사양서 §3-③: 「★새로고침 버튼 없음. 주문 세션당 1회 고정.
   *   ★화면을 벗어났다 돌아와도 «같은 3장»이 나와야 한다 —
   *   호가 생성 시드를 «주문 세션 ID»에 묶어라(★시각·난수 금지)」
   *   근거: 3회만 다시 뽑아도 플레이어 기대손익 −6.45bp → −0.31bp = ★사실상 공짜.
   *
   * ★구현 원칙 3가지 — 셋 다 지켜야 «재추첨»이 막힌다:
   *   ① ⛔`Date.now()`·`Math.random()` 을 쓰지 «않는다». 쓰면 렌더마다 새 시드가 되고
   *      그게 곧 무한 재추첨이다.
   *   ② 키는 (상품, 종목, 방향) 이다. ★뒤로 갔다 다시 들어와도 같은 키 → 같은 3장.
   *   ③ ★한 번 만든 세션을 ★«지우지 않는다». 주문을 낸 뒤에도 유지한다 —
   *      「작은 주문 하나 넣고 다시 들어와 새로 뽑기」 경로를 막는다.
   *
   * ★그리고 «처음 만들 때»의 재료도 결정론적이다: `this.tick`(게임 상태)만 쓴다.
   *   ⇒ 시각도 난수도 아니지만 «언제 열었는지»에 따라 달라지므로,
   *     (종목, 방향) → 호가 대응표가 «영구 고정»되어 학습·수확되는 것도 막는다.
   *     (영구 고정이면 유리한 조합 18.7% 만 골라 반복하는 경로가 열린다)
   */
  private quoteSessions = new Map<string, string>();

  quoteSessionId(product: 'forward' | 'swap', a: string, b: string, side: string): string {
    const key = `${product}|${a}|${b}|${side}`;
    let id = this.quoteSessions.get(key);
    if (!id) {
      id = `${key}|${this.tick}`;
      this.quoteSessions.set(key, id);
      /*
       * ★★«저장»한다. 안 하면 ★새로고침이 곧 재추첨이 된다.
       *   ⇒ 실제로 실렌더 검증에서 잡혔다: 화면을 나갔다 «전체 리로드»로 돌아오니
       *     상대 3명이 통째로 바뀌었다(단하나갑니다·숏치는겁니다·DipDoctor →
       *     든든한투자자·무너질때사냥꾼·역발상겁니다).
       *   ⇒ 메모리 캐시만으로는 SPA 이동만 막을 뿐, ★새로고침 버튼이 재추첨 버튼이 된다.
       * ★상한을 넘으면 «가장 오래된» 것부터 버린다(Map 은 삽입 순서를 유지한다).
       */
      while (this.quoteSessions.size > QUOTE_SESSION_MAX) {
        const oldest = this.quoteSessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.quoteSessions.delete(oldest);
      }
      lsSet(LS.quoteSession, JSON.stringify(Object.fromEntries(this.quoteSessions)));
    }
    return id;
  }

  /** 세션 ID → 시드 (엔진의 결정론적 해시) */
  quoteSeed(sessionId: string): number {
    return this.world.quoteSeed(sessionId);
  }

  forwardQuotes(ticker: string, side: LevSide, seed: number): CounterQuote[] {
    return this.world.forwardQuotes(ticker, side, seed);
  }

  swapQuotes(a: string, b: string, side: 'a' | 'b', seed: number): CounterQuote[] {
    return this.world.swapQuotes(a, b, side, seed);
  }

  /** 만기까지 기대 수익률(표시용) */
  carryOf(ticker: string, gameDays?: number): number {
    return this.world.carryOf(ticker, gameDays);
  }

  /** 내 선도 포지션 */
  get forwards(): ForwardView[] {
    return this.world.forwardViews();
  }

  /** 내 스왑 포지션 */
  get swaps(): SwapView[] {
    return this.world.swapViews();
  }

  /**
   * ★선물 = 레버리지 + 만기. 되돌리기는 «레버리지와 같은» cancelLeverage 다
   *   (선물 포지션은 levPositions 에 expiryTick 만 얹은 것이다).
   */
  async openFutures(
    ticker: string,
    side: LevSide,
    leverage: number,
    margin: number,
    expiryGameDays: number
  ): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.openFutures(ticker, side, leverage, margin, expiryGameDays);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'futures',
      action: 'open',
      ticker,
      side,
      price: p.entryPrice,
      notional: p.notional,
      margin: p.margin,
      leverage: p.leverage,
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelLeverage(id), jid) };
  }

  /** ★옵션 «매도» 개시 */
  async writeOption(
    ticker: string,
    kind: OptionKind,
    strike: number,
    expiryGameDays: number,
    contracts: number
  ): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.writeOption(ticker, kind, strike, expiryGameDays, contracts);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'option',
      action: 'open',
      ticker,
      qty: p.contracts,
      /* ★매도는 프리미엄을 «받는다» — 같은 필드지만 뜻이 반대라 optSide 로 구분한다 */
      price: p.contracts > 0 ? p.premiumPaid / p.contracts : 0,
      notional: p.premiumPaid,
      margin: p.margin,
      optKind: p.kind,
      optSide: 'sell',
      strike: p.strike,
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelOption(id), jid) };
  }

  async openForward(ticker: string, side: LevSide, notional: number, seed: number, quoteIndex: number): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.openForward(ticker, side, notional, seed, quoteIndex);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'forward',
      action: 'open',
      ticker,
      side,
      qty: p.qty,
      /* ★선도는 «계약가»가 체결가다(현재가가 아니다 — 캐리가 가격 안에 심겨 있다) */
      price: p.contractPrice,
      notional: p.notional,
      margin: p.margin,
      /* ⛔선도는 수수료를 따로 걷지 않는다 — 마찰은 스프레드로 한 번만 문다 */
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelForward(id), jid) };
  }

  async openSwap(
    a: string,
    b: string,
    side: 'a' | 'b',
    notional: number,
    seed: number,
    quoteIndex: number
  ): Promise<UndoHandle> {
    this.assertSeasonOpen();
    const before = this.ledger();
    const r = this.world.openSwap(a, b, side, notional, seed, quoteIndex);
    this.afterOrder();
    const p = r.position;
    const jid = this.journal.push({
      ...this.jbase(),
      product: 'swap',
      action: 'open',
      ticker: a,
      tickerB: b,
      side,
      notional: p.notional,
      margin: p.margin,
      fee: this.ledger().fees - before.fees,
      posId: p.id,
    });
    const id = p.id;
    return { undo: () => this.finishUndoJ(this.world.cancelSwap(id), jid) };
  }

  async closeForward(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    const acc = this.world.world.getAccount(this.world.playerId);
    const pos = acc.fwdPositions.get(positionId);
    const before = this.ledger();
    this.world.closeForward(positionId);
    this.afterOrder();
    const after = this.ledger();
    if (pos) {
      this.journal.push({
        ...this.jbase(),
        product: 'forward',
        action: 'close',
        ticker: pos.ticker,
        side: pos.side,
        qty: pos.qty,
        price: pos.contractPrice,
        notional: pos.notional,
        margin: pos.margin,
        fee: after.fees - before.fees,
        realized: after.realized - before.realized,
        posId: positionId,
      });
    }
  }

  async closeSwap(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    const acc = this.world.world.getAccount(this.world.playerId);
    const pos = acc.swapPositions.get(positionId);
    const before = this.ledger();
    this.world.closeSwap(positionId);
    this.afterOrder();
    const after = this.ledger();
    if (pos) {
      this.journal.push({
        ...this.jbase(),
        product: 'swap',
        action: 'close',
        ticker: pos.tickerA,
        tickerB: pos.tickerB,
        side: pos.side,
        notional: pos.notional,
        margin: pos.margin,
        fee: after.fees - before.fees,
        realized: after.realized - before.realized,
        posId: positionId,
      });
    }
  }

  /** ★옵션 매도 포지션 되사기(중도 청산). ⛔되돌리기가 «아니다» — 손익이 실현된다 */
  async buybackOption(positionId: string): Promise<void> {
    this.assertSeasonOpen();
    this.closeOptionRecorded(positionId, () => this.world.buybackOption(positionId));
  }

  /**
   * ★★출시 게이트 — 「되돌리기가 «없는» 주문 경로」가 0 임을 ★구조로 확인한다.
   *
   * ★왜 이게 필요한가: 이 앱은 President 지시로 ★주문 확인창을 «전부 없앴다».
   *   그 결정의 «전제»가 「대신 되돌리기가 있다」였다. 즉 되돌리기가 빠진 경로가
   *   하나라도 있으면 ★그 상품만 «오조작 복구 수단이 0» 이 된다.
   * ★그래서 7경로를 «이름으로 세지 않고» 엔진 메서드 존재로 센다 —
   *   화면을 늘리다가 «조용히» 빠뜨리는 걸 막는다(실제로 파생 4종 중 3종이 없었다).
   */
  undoWiringStatus(): Record<string, boolean> {
    const w = this.world as unknown as Record<string, unknown>;
    return {
      spot: typeof w.cancelSpot === 'function',
      leverage: typeof w.cancelLeverage === 'function',
      futures: typeof w.cancelLeverage === 'function', // 선물 = 레버리지 + 만기 (같은 원장)
      optionBuy: typeof w.cancelOption === 'function',
      optionSell: typeof w.cancelOption === 'function', // 엔진에 sell 분기가 들어갔다
      forward: typeof w.cancelForward === 'function',
      swap: typeof w.cancelSwap === 'function',
    };
  }

  /**
   * 주문 커밋 + 「되돌리기」 토스트 — ★세 주문 화면의 «유일한» 통로.
   *
   * 현물·옵션·레버리지가 각자 토스트를 띄우게 두면 한 곳만 되돌리기를 빠뜨려도
   * 티가 안 난다. 마찰(스와이프)을 없앤 대가로 «반드시» 따라와야 하는 게
   * 되돌리기라, 아예 같은 함수를 지나가게 만든다.
   * 예외(잔고부족 등)는 그대로 던진다 — 화면이 자기 방식으로 보여줘야 한다.
   */
  async commitOrder(text: string, exec: () => Promise<UndoHandle>): Promise<void> {
    const handle = await exec();
    /* ★[-33] «체결» 카운트. 첫 체결이면 홈 출석 시트의 「추가 지급(광고)」 버튼이 열리므로 화면에 알린다 */
    this.sessionTradesPlaced += 1;
    if (this.sessionTradesPlaced === 1) this.bump();
    this.showToast({
      text,
      action: {
        label: String(i18next.t('common:undo')),
        run: () => {
          const ok = handle.undo();
          this.pushToast(String(i18next.t(ok ? 'common:undoDone' : 'common:undoFail')), ok ? 'default' : 'error');
        },
      },
      /*
       * ★[-33] 되돌리기 창이 «되돌림 없이» 닫히면 그 주문은 «완료»다 — 전면 광고(N번째)는 여기서만 센다.
       * ⛔시트가 닫히는 순간(=토스트가 뜨는 순간)에 전면을 띄우면 5초 되돌리기(확인창을 없앤 대가로 «반드시»
       *   있어야 하는 안전장치)를 광고가 가린다. 그래서 «결과 화면»의 정의를 「되돌리기 창이 지난 뒤」로 둔다.
       */
      onExpire: () => this.onTradeCompleted(),
    });
  }

  /* ── ★[2026-09-10 · -33] 세션 거래 카운터 → 전면 광고 · 출석 추가지급 해제 ───────────────────── */

  /** 출석 「추가 지급(광고)」 버튼이 열리는 조건 — 이 세션에서 첫 체결 «또는» 포트폴리오 화면 1회 확인 */
  get attendBonusUnlocked(): boolean {
    return this.sessionTradesPlaced >= 1 || this.portfolioViewed;
  }

  /** 하네스·디버그용 읽기 전용 */
  get sessionTrades(): { placed: number; done: number } {
    return { placed: this.sessionTradesPlaced, done: this.sessionTradesDone };
  }

  /**
   * 포트폴리오 화면(거래 일지 · 종목 탭 «보유» 필터 · 파생 포지션)을 «열었다». 화면 마운트가 부른다.
   * ⛔홈은 세지 않는다 — 홈은 항상 「내 종목」을 보여주므로 홈 진입을 세면 「홈 진입 즉시」와 같아진다.
   */
  notePortfolioView(): void {
    if (this.portfolioViewed) return;
    this.portfolioViewed = true;
    this.bump();
  }

  /** 지금 «열려 있는» 되돌리기 창의 수. 되돌리기 버튼이 달린 토스트가 곧 열린 창이다 */
  get openUndoCount(): number {
    return this.toasts.reduce((n, t) => n + (t.action ? 1 : 0), 0);
  }

  /**
   * 지금 전면을 띄워도 되는가 — 안 되면 «사유 문자열»을 돌려준다(계측에 그대로 실린다).
   * ★`runInterstitialAd` 가 요청 «직전»과 노출 «직전» 두 번 부른다. 로드 6초 사이에 다 바뀔 수 있다.
   */
  private tradeInterstitialVeto(screenAtRequest: string, placedAtRequest: number): string | null {
    if (this.openUndoCount > 0) return 'undo-open';
    if (this.sessionTradesPlaced !== placedAtRequest) return 'new-order';
    if (this.seasonLocked) return 'season-gate';
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return 'hidden';
    if (routePath() !== screenAtRequest) return 'screen-left';
    return null;
  }

  private onTradeCompleted(): void {
    this.sessionTradesDone += 1;
    if (this.sessionTradesDone === 1) this.maybeHintAttendBonus();
    if (!this.tradeInterstitialFired && !this.tradeInterstitialPending && tradeInterstitialDue(this.sessionTradesDone)) {
      this.tradeInterstitialPending = true;
      /* ★「미뤘다」를 계측에 남긴다 — 안 남기면 「왜 안 떴는지」를 나중에 못 답한다(요청은 하지 않았으므로 guard 다) */
      if (this.openUndoCount > 0) noteAd('interstitial', 'interstitialMain', 'guard', { reason: 'undo-open' });
    }
    /* ★열린 되돌리기 창이 «하나도» 없을 때만 나간다. 남아 있으면 그 창이 닫힐 때 이 자리로 다시 온다 */
    this.maybeFlushTradeInterstitial();
  }

  /**
   * 미뤄 둔 전면을 «지금» 띄울 수 있으면 띄운다.
   * ⛔두 곳에서 부른다 — 되돌리기 창이 «지나서» 닫힐 때(onTradeCompleted)와 «눌러서» 닫힐 때(dismissToast).
   *   되돌리기를 «누른» 경우에는 onExpire 가 안 오므로, 여기가 없으면 미뤄 둔 전면이 영영 안 뜬다.
   */
  private maybeFlushTradeInterstitial(): void {
    if (!this.tradeInterstitialPending || this.openUndoCount > 0) return;
    this.tradeInterstitialPending = false;
    this.tradeInterstitialFired = true;
    void this.fireTradeInterstitial();
  }

  /**
   * 첫 «완료» 거래 뒤, 오늘 출석 추가지급을 아직 받을 수 있으면 «한 번» 알린다(세션당 1회).
   * ★광고를 «틀지» 않는다. 홈 출석표에서 «선택»하라는 안내일 뿐이다(자동 재생 ⛔).
   * ⛔되돌리기 토스트가 떠 있는 동안이 아니라 «지난 뒤»에 나온다 — 두 토스트가 겹치지 않는다.
   */
  private maybeHintAttendBonus(): void {
    if (this.attendBonusHinted) return;
    if (!rewardedSupported() || !hasPlacement('rewardAttendance')) return;
    const a = this.attendance.state;
    if (a.lastClaimedDate !== kstDateKey() || this.attendance.doubledToday(kstDateKey())) return;
    this.attendBonusHinted = true;
    this.pushToast(String(i18next.t('common:toast.attendBonusReady')));
  }

  /**
   * ★세션 N번째 «완료» 거래의 결과 화면 — 전면 광고 1회. 가드는 `runInterstitialAd` 안의 기존 것 «그대로».
   * ★조건 확정 «뒤» 로드한다(프리로드 0 = 요청≈노출). 문서가 숨겨져 있거나 시즌 게이트가 덮고 있으면 부르지 않는다.
   * ⛔절대 throw 하지 않고 흐름을 막지 않는다(fire-and-forget).
   */
  private async fireTradeInterstitial(): Promise<void> {
    const screenAtRequest = routePath();
    const placedAtRequest = this.sessionTradesPlaced;
    const veto = this.tradeInterstitialVeto(screenAtRequest, placedAtRequest);
    if (veto) {
      noteAd('interstitial', 'interstitialMain', 'guard', { reason: veto });
      return;
    }
    try {
      await runInterstitialAd('interstitialMain', {
        canShow: () => this.tradeInterstitialVeto(screenAtRequest, placedAtRequest),
      });
    } catch {
      /* runInterstitialAd 는 throw 하지 않는다 — 방어선일 뿐 */
    }
  }

  /* ── 트레이더 열람권 ─────────────────────────────────────────────── */

  /** 오늘 이미 본 사람인가 (재열람은 무료) */
  hasViewedTrader(accountId: string): boolean {
    return this.world.hasViewedTrader(accountId);
  }

  /**
   * 프로필 열람 1회 소비. false 면 오늘 몫을 다 썼다는 뜻이다.
   * ★ 화면이 «열기 전»에 부르고, false 면 프로필 대신 소진 화면을 그려야 한다.
   */
  openTraderView(accountId: string): boolean {
    const ok = this.world.consumeTraderView(accountId);
    this.daily = this.world.dailyStatus();
    this.bump();
    return ok;
  }

  /** 다른 참가자의 «10분 이상 지연된» 공개 포트폴리오 */
  publicPortfolioOf(accountId: string): PublicPortfolio | null {
    return this.world.publicPortfolio(accountId);
  }

  /* ── 포트폴리오 복사 (President 지시 2026-08-30) ──────────────────────── */
  /**
   * ★남의 포트폴리오를 «내 현금 규모로» 따라 산다 — ⛔새 주문 경로가 아니다.
   *   주식 = `orderSpot` · 레버리지 = `openLeverage` · (A)청산 = `orderSpot(sell)`·`closeLeverage`·
   *   `closeOptionPosition`·`closeForward`·`closeSwap`. 시장가·임팩트·수수료·SEASON_ENDED 거절·
   *   프로모션 훅(afterOrder) 전부 «그 경로가 하던 대로»다. 여기서는 «순서»와 «기록»만 잡는다.
   *
   * ★순서: (A)면 청산(주식 → 파생) → 주식 매수 → 레버리지 진입. 한 줄이 실패하면 «거기서 멈춘다»
   *   (남은 줄은 실행되지 않는다). 이미 낸 주문은 되돌리지 않는다 — 각 줄이 일지에 남고 결과 화면이 보여준다.
   * ★(A)의 매수 계획은 청산 «뒤» 실제 현금으로 «다시» 세운다. 미리보기의 청산액은 «예상»이라서다.
   * ★일지: 진행 중 밀리는 모든 줄에 `via`(대상 닉네임)가 붙는다 — jbase 가 copyVia 를 읽는다.
   */
  async copyPortfolio(input: { via: string; mode: CopyMode; pub: PublicPortfolio }): Promise<CopyResult> {
    this.assertSeasonOpen();
    const steps: CopyStep[] = [];
    const q = {
      priceOf: (t: string) => this.priceOf(t),
      priceImpactFrac: (t: string, n: number) => this.priceImpactFrac(t, n),
    };
    const run = async (step: CopyStep, exec: () => Promise<unknown>): Promise<boolean> => {
      try {
        await exec();
        step.ok = true;
      } catch (e) {
        step.ok = false;
        step.code = (e as { code?: string }).code ?? 'GENERIC';
      }
      steps.push(step);
      return step.ok === true;
    };
    this.copyVia = input.via;
    let plan: CopyPlan | null = null;
    let stopped = false;
    try {
      if (input.mode === 'all') {
        /* ★청산 — 주식 먼저, 파생은 «기존 정리 경로» 그대로. 실패하면 매수로 넘어가지 않는다 */
        const p = this.portfolio;
        for (const h of p?.holdings ?? []) {
          if (!(await run({ phase: 'close', kind: 'spot', ticker: h.ticker, qty: h.qty }, () => this.orderSpot(h.ticker, 'sell', h.qty)))) {
            stopped = true;
            break;
          }
        }
        if (!stopped) {
          for (const lv of p?.leverage ?? []) {
            if (!(await run({ phase: 'close', kind: 'lev', ticker: lv.ticker, side: lv.side, leverage: lv.leverage }, () => this.closeLeverage(lv.id)))) {
              stopped = true;
              break;
            }
          }
        }
        if (!stopped) {
          for (const o of p?.options ?? []) {
            if (!(await run({ phase: 'close', kind: 'option', ticker: o.ticker }, () => this.closeOptionPosition(o.id)))) {
              stopped = true;
              break;
            }
          }
        }
        if (!stopped) {
          for (const f of this.forwards) {
            if (!(await run({ phase: 'close', kind: 'forward', ticker: f.ticker }, () => this.closeForward(f.id)))) {
              stopped = true;
              break;
            }
          }
        }
        if (!stopped) {
          for (const w of this.swaps) {
            if (!(await run({ phase: 'close', kind: 'swap', ticker: w.tickerA }, () => this.closeSwap(w.id)))) {
              stopped = true;
              break;
            }
          }
        }
      }
      if (!stopped) {
        /* ★실제 현금으로 계획을 «다시» 세운다 — (B)면 미리보기와 같은 값이 나온다 */
        plan = planCopy(input.pub, this.portfolio?.cash ?? 0, q);
        for (const l of plan.spot) {
          if (l.skip || l.qty < 1) continue;
          if (!(await run({ phase: 'buy', kind: 'spot', ticker: l.ticker, qty: l.qty }, () => this.orderSpot(l.ticker, 'buy', l.qty)))) {
            stopped = true;
            break;
          }
        }
        if (!stopped) {
          for (const l of plan.lev) {
            if (l.skip || l.margin < 1) continue;
            if (
              !(await run(
                { phase: 'buy', kind: 'lev', ticker: l.ticker, side: l.side, leverage: l.leverage, margin: l.margin },
                () => this.openLeverage(l.ticker, l.side, l.leverage, l.margin)
              ))
            ) {
              stopped = true;
              break;
            }
          }
        }
      }
    } finally {
      this.copyVia = null;
    }
    const done = steps.filter((x) => x.ok).length;
    return { via: input.via, mode: input.mode, steps, stopped, done, plan };
  }

  /**
   * 리워드 광고 보상 반영. 지면이 준 수량을 그대로 넘기고, 상한 클램프는
   * 엔진이 한다(gameWorld.grantAdReward). 실제 지급된 수량을 돌려준다.
   */
  grantAdReward(kind: 'topup' | 'view', amount: number): number {
    const given = this.world.grantAdReward(kind, amount);
    this.topup = this.world.topupStatus();
    this.daily = this.world.dailyStatus();
    this.topupFetchedAt = Date.now();
    this.bump();
    return given;
  }

  /**
   * ★공유 리워드 반영 — `contactsViral` 의 `sendViral` 이벤트 1건.
   *
   * ★지급·상한·중복방지는 ★전부 엔진(`gameWorld.grantShareReward`)이 한다.
   *   ⛔화면이 `cash` 를 만지지 않는다. 현금과 수익률 분모를 «같이» 올려야
   *     랭킹이 안 깨지고, 그 식은 엔진에 «한 벌»만 있다(world.investedBase).
   * ★일지에도 남긴다 — 잔고가 갑자기 크게 늘면 «근거를 찾을 곳»이 있어야 한다.
   *   ⛔`realized` 에 넣지 «마라». 일지 요약(실현 손익·수수료·거래 횟수)은
   *     ★엔진 원장에서 오는데 원장에는 이 건이 «없다» — 넣으면 요약과 행이 어긋난다.
   *     그래서 `product:'reward'` 로 «따로» 두고 금액은 `notional` 에 담는다.
   *
   * @returns 실제로 지급된 금액(USD). 0 = 오늘 몫 소진(중복 이벤트 포함).
   */
  /* ── 출석 ─────────────────────────────────────────────────────────── */

  /**
   * 오늘 출석을 «판정»만 한다(지급하지 않는다). 화면이 카드를 그릴 때 쓴다.
   * ⛔규칙은 `lib/attendance.ts` 한 벌뿐이다 — 화면이 다시 계산하지 마라.
   */
  attendanceToday(): AttendanceDecision {
    const a = this.attendance.state;
    return decideAttendance(a.streak, a.lastClaimedDate, kstDateKey());
  }

  /** 「내일 오면 얼마」 — 화면 표시용. 규칙 모듈에서 «유도»한다 */
  attendanceNextReward(): number {
    return nextReward(this.attendance.state.streak);
  }

  /** 오늘 광고 2배를 이미 받았는가 */
  attendanceDoubledToday(): boolean {
    return this.attendance.doubledToday(kstDateKey());
  }

  /**
   * ★★출석 «자동» 지급. 화면 진입에서 한 번 부른다.
   *
   * ⛔「받기」 버튼을 만들지 마라 — 그건 곧 확인창이고, President 가 전량 제거한 그것이다.
   *   유저는 «이미 받은 상태»로 화면을 만나야 한다.
   *
   * ── ⛔순서가 규율이다: 지급 → 저장 → 기록 ────────────────────────────
   *   출석 원장(`ml.attendance`)과 세이브 블롭(`ml.game`)은 ★«다른 키»라
   *   둘을 한 번에 원자적으로 쓸 수 없다. 그래서 «어느 쪽이 먼저인가»를 정해야 한다.
   *     기록 먼저 → 사이에 죽으면 ★「받은 걸로 표시됐는데 돈은 없다」 = 유저 손해
   *     지급 먼저 → 사이에 죽으면 ★「돈은 받았는데 기록이 없다」 = 내일 한 번 더 받는다
   *   ⇒ ★**유저가 돈을 잃지 않는 쪽**을 고른다. 경제 손실은 하루치 한 번으로 «상한»이 있다.
   *   ⇒ 두 쓰기는 «동기»라 그 사이 창은 사실상 0 이다. ★그래도 0 이라고 «말하지는» 않는다.
   *
   * @returns 실제로 지급된 금액. 0 = 오늘 몫을 이미 받았거나 지급이 거절됐다
   */
  claimAttendance(): number {
    const today = kstDateKey();
    const d = this.attendanceToday();
    if (!d.claimable) return 0;

    /* ★지급은 엔진의 «단일 통로»를 지난다 — 현금과 수익률 분모를 같이 올리는 그 함수다 */
    const give = this.world.grantBonusCash(d.amount, 'attendance');
    if (give <= 0) return 0;
    /* ★`grantBonusCash` 는 저장하지 «않는다»(호출자 책임). 여기서 즉시 쓴다 */
    this.world.save();
    this.attendance.recordClaim(d.streak, today, give);

    this.journal.push({
      ...this.jbase(),
      product: 'reward',
      /* ★공유 리워드와 «같은 상품»이지만 side 로 가른다 — 일지가 둘을 구분해 그린다 */
      action: 'grant',
      side: 'attendance',
      ticker: '',
      notional: give,
      fee: 0,
    });
    this.afterOrder();
    this.pushToast(String(i18next.t('common:toast.attendance', { n: d.streak, v: fmtMoney(give, 0) })));
    return give;
  }

  /**
   * 출석 보상 «2배» — 리워드 광고를 «끝까지 본 뒤»에만 부른다.
   *
   * ⛔광고를 봐야 «기본» 보상이 나오는 구조가 아니다. 기본은 이미 지급돼 있고
   *   이건 그 위에 한 번 더 얹는 것이다(토스 정책 「과도한 시청 유도 금지」와도 맞는다).
   * ★하루 1회. 기준은 저장본의 `lastDoubledDate` 라 앱을 껐다 켜도 유지된다.
   */
  grantAttendanceDouble(): number {
    const today = kstDateKey();
    const a = this.attendance.state;
    /* ⛔오늘 «기본 보상을 받은 뒤»에만 2배가 성립한다 — 없는 것의 2배는 없다 */
    if (a.lastClaimedDate !== today) return 0;
    if (this.attendance.doubledToday(today)) return 0;

    const extra = rewardForStreak(a.streak) * ATTENDANCE_AD_MULTIPLIER;
    const give = this.world.grantBonusCash(extra, 'attendance');
    if (give <= 0) return 0;
    this.world.save();
    this.attendance.recordDouble(today, give);

    this.journal.push({
      ...this.jbase(),
      product: 'reward',
      action: 'grant',
      side: 'attendance',
      ticker: '',
      notional: give,
      fee: 0,
    });
    this.afterOrder();
    this.pushToast(String(i18next.t('common:toast.attendanceDoubled', { v: fmtMoney(give, 0) })));
    return give;
  }

  grantShareReward(amount: number): number {
    const given = this.world.grantShareReward(amount);
    if (given <= 0) {
      /* ★조용히 넘기지 않는다. 「받은 줄 알았는데 안 늘었다」가 가장 나쁘다 */
      this.pushToast(String(i18next.t('common:toast.shareRewardUsed')), 'error');
      return 0;
    }
    this.journal.push({
      ...this.jbase(),
      product: 'reward',
      action: 'grant',
      /*
       * ★★`side` 로 «공유»와 «출석»을 가른다. 둘 다 product='reward' 라 이게 유일한 축이다.
       *   ⛔[2026-08-22 실측으로 잡음] 여기 `side` 가 «빠져 있었다» — 설계 문서에는
       *     「side: 'attendance' | 'share'」로 적어 놓고 코드에는 안 넣었다.
       *     출석이 붙는 순간 두 종류가 «구분되지 않아» 공유 검사가 통째로 어긋났다.
       *   ★기존 유저의 옛 줄에는 `side` 가 없다 — 화면은 그때 「공유」로 그린다(하위호환).
       */
      side: 'share',
      /* ★종목이 없는 항목이다. journal.sane() 이 'reward' 만 이 예외를 허용한다 */
      ticker: '',
      notional: given,
      fee: 0,
    });
    this.afterOrder();
    this.pushToast(String(i18next.t('common:toast.shareReward', { v: fmtMoney(given, 0) })));
    return given;
  }

  /** 되돌리기 후 화면 동기화. 실패(포지션이 이미 사라짐)를 그대로 돌려준다 */
  private finishUndo(ok: boolean): boolean {
    this.afterOrder();
    return ok;
  }

  private afterOrder(): void {
    this.portfolio = this.world.portfolio();
    this.topup = this.world.topupStatus();
    this.daily = this.world.dailyStatus();
    this.topupFetchedAt = Date.now();
    this.checkHoldPromo();
    this.checkCashPromo();
    this.checkEquityPromo();
    this.bump();
  }

  /* ── 프로모션 훅 판정 (★2026-08-29) ─────────────────────────────────────
   * ★«상태» 기준이다 — 어떤 경로로 도달했든(매수·되돌리기·리워드) 지금 보유 종목이
   *   문턱 이상이면 달성이다. 그래서 afterOrder(모든 주문 뒤 «단일» 갱신 지점)에 건다.
   * ★보유 목록 정의 = 엔진의 `Portfolio.holdings`(현물). 레버리지·옵션은 «세지 않는다»
   *   (promoRules.ts 주석에 근거). 조건 자체는 promoRules 한 곳이다.
   * ★promoSettled 로 세션에 한 번 처리된 뒤에는 판정조차 안 한다(매 주문마다 값싸게 끝).
   */
  private checkHoldPromo(): void {
    if (promoSettled('hold10')) return;
    const n = distinctHoldings(this.portfolio?.holdings);
    void maybeClaimPromo('hold10', holdReached(n));
  }

  /*
   * ★현금(cash100k)도 «상태» 기준 — `this.portfolio.cash` = 엔진 `Account.cash`(미투자 달러 잔고,
   *   정의는 promoRules.ts ③ 주석). 판정 지점은 «두 곳»뿐: afterOrder(주문·청산·되돌리기·보너스 뒤
   *   단일 갱신 지점) + boot() 1회. 순위 훅이 쓰던 랭킹 갱신 지점(3초 스로틀 flushRanks)은 현금 조건에
   *   «불필요»해 호출을 뗐다(flushRanks 자체는 UI 랭킹용으로 그대로).
   * ★「100위 안에 들기」(top100)는 콘솔 반려로 08-29 «제거». 옛 지급 기록 키는 안 읽고 그대로 둔다.
   */
  private checkCashPromo(): void {
    if (promoSettled('cash100k')) return;
    /* ★[2026-09-05] 순자산을 «같이» 넘긴다 — 대출로 현금만 채운 상태를 막는다(promoRules ③ 주석).
       ⛔인자를 하나로 되돌리지 마라: 그 순간 「$1M 대출 → 즉시 지급」이 부활한다. */
    void maybeClaimPromo('cash100k', cashReached(this.portfolio?.cash, this.portfolio?.netWorth));
  }

  /*
   * ★총자산(equity1m, 2026-09-01) — 「100만 달러 모으기」. `this.portfolio.equity` = 엔진 `World.equity`
   *   (현금 + 현물 평가액 + 파생 포지션 평가액). 화면 「총 자산」과 «같은 값»이다(promoRules ④ 주석).
   * ★현금 훅과 «판정 지점이 다르다»: 총자산은 주문 없이 가격 틱만으로 문턱을 넘으므로
   *   afterOrder·boot 뿐 아니라 매 틱(syncFromWorld)에서도 본다.
   * ★매 틱 경로라 «미달일 때 할당 0»으로 끊는다 — 판정 자체는 promoRules 한 곳(equityReached).
   */
  private checkEquityPromo(): void {
    const eq = this.equityPromoValue();
    if (eq === null) return;
    void claimPromoOnTransition('equity1m', equityReached(eq));
  }

  /**
   * 지금 총자산 판정을 «태울 필요»가 있으면 그 값, 아니면 null. ★동기 · 할당 0(매 틱 경로다).
   *
   * ⛔판정 «불가»(portfolio 없음·NaN)면 태우지 «않는다» — false 를 넘기면 기준선이 「미달성」으로
   *   박혀 이미 100만 달러였던 기기에 지급이 나갈 수 있다(이 훅의 가장 위험한 오류다).
   * ★기준선이 아직 없으면 «미달성일 때도» 한 번은 태운다 — 기준선을 박기 위해서다.
   */
  private equityPromoValue(): number | null {
    if (promoSettled('equity1m')) return null;
    /* ★[2026-09-01] 기준선에서 이미 100만 달러였던 기기 — «영구 미지급». 저장도 안 읽고 끝낸다 */
    if (promoIneligible('equity1m')) return null;
    /* ★[2026-09-05] 총자산이 아니라 «순자산»이다(President 지시). 대출이 없으면 두 값이 같다 —
       즉 기존 유저의 판정은 «변하지 않는다»(check_loans.mjs 가 수치로 지킨다). */
    const eq = this.portfolio?.netWorth;
    if (typeof eq !== 'number' || !Number.isFinite(eq)) return null;
    if (!equityReached(eq) && promoBaselined('equity1m')) return null;
    return eq;
  }

  /**
   * ★부팅 전용 — 기준선을 «확정»할 때까지 기다린다.
   *
   * ⛔출석 보상(최대 $100,000)이 «기준선보다 먼저» 들어가면 그만큼 기준선이 밀려 올라가
   *   판정이 달라진다. boot() 는 여기만 유일하게 await 해서 그 순서를 «구조적으로» 막는다.
   *   (afterOrder·매 틱 경로는 그대로 fire-and-forget 이다.)
   * 절대 throw 하지 않는다 — claimPromoOnTransition 이 전부 흡수한다.
   */
  private async settleEquityBaseline(): Promise<void> {
    const eq = this.equityPromoValue();
    if (eq === null) return;
    await claimPromoOnTransition('equity1m', equityReached(eq));
  }

  /**
   * 충전 1회. kind 미지정이면 엔진이 «무료 먼저» 고른다(광고를 안 봐도 되는 길이 우선).
   * ★'ad' 는 «이미 광고를 본» 적립분을 받아가는 것이다. 광고를 여기서 틀지 않는다.
   */
  async doTopup(kind?: 'free' | 'ad'): Promise<number> {
    const r = this.world.topup(kind);
    this.topup = r;
    this.daily = this.world.dailyStatus();
    this.topupFetchedAt = Date.now();
    this.portfolio = this.world.portfolio();
    this.bump();
    return r.amount;
  }

  /** 종목 가격 시계열 (차트용, 오래된 -> 최신) */
  series(ticker: string, points = 120): number[] {
    return this.world.series(ticker, points);
  }

  /**
   * 종목 «거래대금 / 순주문흐름» 시계열 (차트 하단 막대용, 오래된 -> 최신).
   * gross = 막대 높이(얼마나 오갔나) · net = 막대 색(매수/매도 어느 쪽이 이겼나).
   */
  flowSeries(ticker: string, points = 120): { gross: number[]; net: number[] } {
    return this.world.flowSeries(ticker, points);
  }

  /** @deprecated series() 를 써라. StockDetail 의 기존 await 경로 호환용. */
  async seriesOf(ticker: string, points = 120): Promise<number[]> {
    return this.series(ticker, points);
  }

  /* ── 대출 (2026-09-05 President 지시) ──────────────────────────────────
   * ★엔진 통로를 그대로 흘린다. ⛔화면이 한도·금리·신용등급을 «다시» 계산하지 마라 —
   *   유동성 깊이를 화면이 다시 세다가 16배 갈렸던 사고와 «같은 형태»가 된다(U-7).
   */

  /** 지금 기준(정책)금리. 중앙은행 정례 회합이 정한다 */
  get policyRate(): number {
    try {
      return this.world.policyRate;
    } catch {
      return 0;
    }
  }

  /** 대출 조건 견적 — 신용등급·한도·금리·예상 이자를 «한 번에» 준다 */
  loanTerms(kind: LoanKind) {
    return this.world.loanTerms(kind);
  }

  /** 대출 실행. ★현금이 늘고 부채가 같은 만큼 늘어 «순자산은 변하지 않는다» */
  async openLoan(kind: LoanKind, amount: number, termGameDays?: number) {
    this.assertSeasonOpen();
    const r = this.world.openLoan(kind, amount, termGameDays);
    this.afterOrder();
    return r;
  }

  /** 상환(전액/부분). ★중도상환 수수료 0 (President 명시) */
  async repayLoan(loanId: string, amount: number) {
    this.assertSeasonOpen();
    const r = this.world.repayLoan(loanId, amount);
    this.afterOrder();
    return r;
  }

  /** @deprecated 종목을 아는 자리에서는 `sharesPerContractOf(ticker)` 를 써라 */
  sharesPerContract = SHARES_PER_CONTRACT;

  /**
   * ★옵션 1계약이 담는 주(단위) 수 — «종목마다 다르다»(2026-09-05).
   * ⛔화면이 상수를 직접 곱하지 «마라». 엔진이 답한다(U-7 · 깊이 16배 사고와 같은 형태).
   * ★월드가 아직 없으면 기본값을 준다 — 부팅 중 첫 렌더에서 죽지 않게.
   */
  sharesPerContractOf(ticker: string): number {
    try {
      return this.world.sharesPerContractOf(ticker);
    } catch {
      return SHARES_PER_CONTRACT;
    }
  }
}

export const store = new GameStore();
