# -*- coding: utf-8 -*-
"""
프로모션 훅 «2종 추가» 1회성 패치 (2026-09-01, President 지시)

    ④ equity1m  100만 달러 모으기   200원  code __PROMOTION_CODE__
    ⑤ play1h    1시간 플레이하기    200원  code __PROMOTION_CODE__

  python scripts/promo2_patch_20260901.py apply    치환 적용(각 1건 강제) + 백업
  python scripts/promo2_patch_20260901.py revert   백업 복원(md5 대조)

⛔기존 훅 3종(streak3/hold10/cash100k)의 «코드·금액·문턱·판정»은 한 글자도 건드리지 않는다.
   실제 지급이 나가는 라이브 프로모션이라 회귀시키면 실사고다.
★줄바꿈: 파일마다 우세한 EOL(CRLF/LF)을 detect 해 삽입 블록을 «맞춘다» — 혼합 EOL 금지.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAK = os.path.join(ROOT, '_baseline')
SUF = '.pre_promo2_20260901'

RULES = 'src/lib/promoRules.ts'
CORE = 'src/toss/promoCore.ts'
PROM = 'src/toss/promotion.ts'
IDX = 'src/toss/index.ts'
STORE = 'src/store/store.ts'
HTML = 'index.html'

# ══════════════════════════════════════════════════════════════════════════
# ① promoRules.ts — 규칙(순수 함수). ⛔import 는 daykey 하나뿐이라는 규율 유지
# ══════════════════════════════════════════════════════════════════════════
RULES_TAG_OLD = "export const PROMO_RULE_TAG = 'ml-promo-rules:streak=3;hold=10;cash=100000';"
RULES_TAG_NEW = (
    "export const PROMO_RULE_TAG = 'ml-promo-rules:streak=3;hold=10;cash=100000;equity=1000000;play=3600000';"
)

RULES_TAG_DOC_OLD = "/** 번들 검사 표식 — ★위 세 숫자와 «반드시» 같아야 한다(단위검사가 강제) */"
RULES_TAG_DOC_NEW = (
    "/** ④ 총자산 문턱(USD, 이 값 «이상»이면 달성). 시작 자본 SEED_CASH(10,000)의 100배 */\n"
    "export const PROMO_EQUITY_USD = 1000000;\n"
    "/** ⑤ 누적 플레이 «실시간» 문턱(ms). 1시간 */\n"
    "export const PROMO_PLAY_MS = 3600000;\n"
    "/** 번들 검사 표식 — ★위 «다섯» 숫자와 «반드시» 같아야 한다(단위검사가 강제) */"
)

RULES_APPEND = r'''
/* ══════════════════════════════════════════════════════════════════════════
   ④ 100만 달러 모으기 = «총자산» 100만 USD  (★2026-09-01 신설. 200원)
   ══════════════════════════════════════════════════════════════════════════
   ★«총자산»의 정의는 엔진을 따른다 — 우리가 «새로 정하지 않았다».
     `World.equity(acc)`(engine/world.ts:558) = 화면 `Portfolio.equity`(gameWorld.portfolio():665)
     = 현금 + 현물 보유 평가액 + (레버리지·옵션·선도·스왑 포지션 평가액, 각 0 미만은 0).
     UI 가 「총 자산」으로 그리는 «바로 그 값»이고(ko.json totalValue·greeting·nowTotal),
     랭킹 「자산순」·파산 판정도 같은 값이다 ⇒ 화면과 지급 조건이 «어긋날 수 없다».
   ⇒ ③ 현금(cash100k)과 «다르다» — 현금은 미투자 잔고뿐, 총자산은 평가액을 포함한다.
     ⇒ 지시문의 「현금 + 보유 종목 평가액」에 파생 포지션 평가액이 «더해진» 값이다.
       파생을 빼면 화면 총자산과 다른 «두 번째 총자산»이 생겨 더 나쁘다(보고에 명시함).
   ★판정 «지점»이 ③과 다르다: 총자산은 주문 없이 «가격 틱만으로» 문턱을 넘는다.
     ⇒ afterOrder·boot 뿐 아니라 매 틱(syncFromWorld)에서도 본다. 세션 락이 닫히면 판정조차 안 한다.
   ══════════════════════════════════════════════════════════════════════════ */

/** ④ 달성 판정. 없거나(null/undefined) 깨진 값(NaN/Infinity)이면 미달. 파산(음수)도 미달 */
export function equityReached(equity: number | null | undefined): boolean {
  return typeof equity === 'number' && Number.isFinite(equity) && equity >= PROMO_EQUITY_USD;
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 1시간 플레이하기 = 포그라운드 «실시간» 누적  (★2026-09-01 신설. 200원)
   ══════════════════════════════════════════════════════════════════════════
   ★«실시간»이다(President 명시). 게임 내 가속 시간(1 게임일 = 실제 5분)도, 접속 «일수»도 아니다.
     「앱이 포그라운드에서 실제로 돌아간 벽시계 시간」의 누적이다.
   ★백그라운드·일시정지는 «세지 않는다». 배선(toss/promotion.ts + store.ts)이
     visibilitychange/pagehide 에서 시계를 끊고, 포그라운드 복귀에서 다시 잇는다.
   ★그래도 「끊김 신호가 안 오는」 경우가 있다 — OS 가 WebView 를 통째로 얼리면
     visibilitychange 가 안 오고 타이머도 멈춘다. 깨어난 뒤 «경과 시간»을 그대로 더하면
     잠든 시간을 플레이로 세어버린다.
     ⇒ 한 번에 더할 수 있는 양을 `PROMO_PLAY_DELTA_MAX` 로 «자른다». 비트가
       `PROMO_PLAY_BEAT_MS` 마다 오므로 정상 포그라운드에서는 절대 안 걸리고,
       얼었다 깨어난 경우에만 걸린다 ⇒ 오차는 «과소 계상» 쪽(≤1비트/사이클).
     ⛔반대로 만들지 마라 — 과대 계상은 「안 논 시간에 지급」이라 President 의도와 어긋난다.
   ══════════════════════════════════════════════════════════════════════════ */

/** ⑤ 비트 간격(ms) — 배선이 이 주기로 누적·판정한다. «문턱»이 아니라 해상도다 */
export const PROMO_PLAY_BEAT_MS = 15000;
/** ⑤ 한 번에 더할 수 있는 상한(ms) = 비트 2회분. 얼었다 깨어난 시간을 잘라낸다 */
export const PROMO_PLAY_DELTA_MAX = 2 * PROMO_PLAY_BEAT_MS;
/** ⑤ 누적값 상한(ms, 손상값 방어) — 30일 */
export const PROMO_PLAY_SANE_MAX = 30 * 24 * 60 * 60 * 1000;

export interface PlayState {
  /** 포그라운드 누적 «실시간»(ms) */
  totalMs: number;
}

export function emptyPlay(): PlayState {
  return { totalMs: 0 };
}

/** 저장본을 «믿지 않고» 검증한다(saneStreak 과 같은 패턴). 깨진 값은 0 으로 떨어질 뿐 게임은 계속 돈다 */
export function sanePlay(x: unknown): PlayState {
  if (!x || typeof x !== 'object') return emptyPlay();
  const o = x as Record<string, unknown>;
  const n = typeof o.totalMs === 'number' && Number.isFinite(o.totalMs) ? Math.floor(o.totalMs) : 0;
  return { totalMs: Math.min(PROMO_PLAY_SANE_MAX, Math.max(0, n)) };
}

/**
 * 포그라운드 경과분을 «더한» 다음 상태. ★순수 함수 — 저장·지급은 호출부(toss/promotion.ts) 몫이다.
 *   0·음수·NaN     → «그대로»(시계 되돌림·중복 신호·백그라운드)
 *   정상            → +deltaMs
 *   비정상적으로 큼 → +PROMO_PLAY_DELTA_MAX «까지만»(얼었다 깨어난 구간을 잘라낸다)
 */
export function addPlayMs(prev: PlayState, deltaMs: number): PlayState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return prev;
  const add = Math.min(PROMO_PLAY_DELTA_MAX, Math.floor(deltaMs));
  const total = Math.min(PROMO_PLAY_SANE_MAX, prev.totalMs + add);
  return total === prev.totalMs ? prev : { totalMs: total };
}

/** ⑤ 달성 판정 */
export function playReached(totalMs: number | null | undefined): boolean {
  return typeof totalMs === 'number' && Number.isFinite(totalMs) && totalMs >= PROMO_PLAY_MS;
}
'''

# ══════════════════════════════════════════════════════════════════════════
# ② promoCore.ts — 훅 id 2종 추가(코어 로직은 id 무관이라 «무변경»)
# ══════════════════════════════════════════════════════════════════════════
CORE_OLD = """export type PromoId = 'streak3' | 'hold10' | 'cash100k';
export const PROMO_IDS: readonly PromoId[] = ['streak3', 'hold10', 'cash100k'];"""
CORE_NEW = """export type PromoId = 'streak3' | 'hold10' | 'cash100k' | 'equity1m' | 'play1h';
export const PROMO_IDS: readonly PromoId[] = ['streak3', 'hold10', 'cash100k', 'equity1m', 'play1h'];
/*
 * ★2026-09-01 훅 2종 추가(equity1m 200원 · play1h 200원).
 *   이 파일의 «로직»은 한 줄도 안 바뀌었다 — 코어는 훅 id 를 모른다(락·기록·브릿지만 안다).
 *   ⇒ 코드별 기록(rec.code === code)·세션 락·in-flight 락·4113 방어가 새 훅에도 «그대로» 적용된다.
 */"""

# ══════════════════════════════════════════════════════════════════════════
# ③ promotion.ts — 배선(저장 키 · 플레이 시간 누적기)
# ══════════════════════════════════════════════════════════════════════════
PROM_IMPORT_OLD = (
    "import { advanceStreak, saneStreak, streakReached, PROMO_RULE_TAG, type StreakState } "
    "from '../lib/promoRules';"
)
PROM_IMPORT_NEW = (
    "import {\n"
    "  advanceStreak,\n"
    "  saneStreak,\n"
    "  streakReached,\n"
    "  addPlayMs,\n"
    "  emptyPlay,\n"
    "  sanePlay,\n"
    "  playReached,\n"
    "  PROMO_RULE_TAG,\n"
    "  type PlayState,\n"
    "  type StreakState,\n"
    "} from '../lib/promoRules';"
)

PROM_KEYS_OLD = """const RECORD_KEY: Record<PromoId, string> = {
  streak3: 'ml.promo.streak3',
  hold10: 'ml.promo.hold10',
  cash100k: 'ml.promo.cash100k',
};"""
PROM_KEYS_NEW = """const RECORD_KEY: Record<PromoId, string> = {
  streak3: 'ml.promo.streak3',
  hold10: 'ml.promo.hold10',
  cash100k: 'ml.promo.cash100k',
  /* ★2026-09-01 신설 2종. 훅마다 «새 키». 옛 키(ml.promo · ml.promo.top100)는 이름 변경·삭제 없이 그냥 «안 읽는다» */
  equity1m: 'ml.promo.equity1m',
  play1h: 'ml.promo.play1h',
};"""

PROM_APPEND = r'''
/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 1시간 플레이 — 포그라운드 «실시간» 누적 + 달성 시 지급 (★2026-09-01)
   ══════════════════════════════════════════════════════════════════════════
   ★규칙(문턱·상한·비트)은 lib/promoRules.ts «한 곳». 여기는 배선(저장·시계·판정 호출)뿐이다.
   ★호출부(store.ts)가 부르는 지점 3개 — 게임 틱과 «무관»한 벽시계다.
     playtimeResume()  포그라운드 진입(startLoop · visibilitychange visible). 시계를 «건다»
     playtimeBeat()    PROMO_PLAY_BEAT_MS 마다. 경과분을 접고, 가끔 저장하고, 판정한다
     playtimePause()   백그라운드 전환(visibilitychange hidden · pagehide). 접고 «반드시» 저장하고 시계를 «끊는다»
   ★저장은 매 비트가 아니라 PLAY_PERSIST_STEP_MS 마다 + 이탈 시 반드시 ⇒ 유실 창 ≤1스텝.
   ★누적 키는 지급 기록과 «별개»다(지급 뒤에도 계속 센다 — 스트릭과 같은 구조).
   ⛔세이브 블롭(ml.game)을 건드리지 않는다. 새 키를 «추가»만 한다 ⇒ SAVE_VERSION 무관.
   ══════════════════════════════════════════════════════════════════════════ */

/** ⑤ 누적 플레이 «시간» 기록 키(지급 기록 ml.promo.play1h 와 «별개») */
const PLAY_KEY = 'ml.promo.playtime';
/** 저장 주기(ms). 이만큼 더 쌓였을 때만 쓴다 — 매 비트마다 쓰지 않는다 */
const PLAY_PERSIST_STEP_MS = 60000;

/** 포그라운드 시작 시각(ms). null = 지금 «안 세는» 중(백그라운드) */
let playSince: number | null = null;
/** 저장까지 끝난 누적값(ms). -1 = 아직 안 읽음 */
let playSaved = -1;
/** 메모리상 최신 상태(읽기 전용 조회·오류 복구용) */
let playCur: PlayState = emptyPlay();
/** 직렬화 체인 — 비트와 이탈이 겹쳐도 읽기-쓰기 경합이 없다 */
let playChain: Promise<PlayState> | null = null;

async function loadPlay(): Promise<PlayState> {
  try {
    const raw = await storage.getItem(PLAY_KEY);
    const st = sanePlay(raw ? JSON.parse(raw) : null);
    playSaved = st.totalMs;
    playCur = st;
    return st;
  } catch {
    playSaved = 0;
    playCur = emptyPlay();
    return playCur;
  }
}

/**
 * 경과분을 «한 번» 접어 넣는다. 절대 throw 하지 않는다.
 * @param now  기준 시각(ms)
 * @param stop true 면 시계를 «끊는다»(백그라운드 전환) · false 면 «다시 건다»(비트)
 */
function foldPlay(now: number, stop: boolean): Promise<PlayState> {
  const since = playSince;
  const delta = since === null ? 0 : now - since;
  playSince = stop ? null : since === null ? null : now;
  const prev = playChain ?? loadPlay();
  const p = prev
    .then(async (cur) => {
      const next = addPlayMs(cur, delta);
      playCur = next;
      /* ★이탈(stop)에는 «반드시» 쓴다 — 그 순간 앱이 죽어도 여기까지는 남는다 */
      const due = stop || next.totalMs - playSaved >= PLAY_PERSIST_STEP_MS;
      if (due && next.totalMs !== playSaved) {
        try {
          await storage.setItem(PLAY_KEY, JSON.stringify(next));
          playSaved = next.totalMs;
        } catch (e) {
          console.error('[promo:play1h] 플레이 시간 저장 실패:', e);
        }
      }
      /* ★지급은 세션 락·로컬 기록이 막으므로 1시간을 넘긴 뒤 매 비트 불려도 «한 번»만 나간다 */
      void claimer.maybeClaim('play1h', playReached(next.totalMs));
      return next;
    })
    .catch((e) => {
      console.error('[promo:play1h] 누적 실패 — 게임은 계속:', e);
      return playCur;
    });
  playChain = p;
  return p;
}

/** 포그라운드 진입. ★이미 세는 중이면 «아무것도 안 한다»(중복 신호가 시계를 되감지 않게) */
export function playtimeResume(now: number = Date.now()): void {
  if (playSince !== null) return;
  playSince = now;
  if (!playChain) playChain = loadPlay();
}

/** 비트. 백그라운드면 «아무것도 안 한다» */
export function playtimeBeat(now: number = Date.now()): Promise<PlayState> {
  if (playSince === null) return playChain ?? Promise.resolve(playCur);
  return foldPlay(now, false);
}

/** 백그라운드 전환. 남은 경과분을 접고 «반드시» 저장한 뒤 시계를 끊는다 */
export function playtimePause(now: number = Date.now()): Promise<PlayState> {
  if (playSince === null) return playChain ?? Promise.resolve(playCur);
  return foldPlay(now, true);
}

/** 지금까지 누적된 포그라운드 «실시간»(ms). 검증·디버그용(읽기 전용) */
export function playtimeMs(): number {
  return playCur.totalMs;
}

/** 지금 «세는 중»인가(포그라운드). 검증·디버그용 */
export function playtimeActive(): boolean {
  return playSince !== null;
}
'''

# ══════════════════════════════════════════════════════════════════════════
# ④ toss/index.ts — 재수출 (★재수출 배럴 누락 = 「0건」 사고의 단골. 반드시 같이 연다)
# ══════════════════════════════════════════════════════════════════════════
IDX_OLD = (
    "export { claimPromo, maybeClaimPromo, promoSettled, alreadyRewarded, touchStreak } from './promotion';"
)
IDX_NEW = (
    "export {\n"
    "  claimPromo,\n"
    "  maybeClaimPromo,\n"
    "  promoSettled,\n"
    "  alreadyRewarded,\n"
    "  touchStreak,\n"
    "  playtimeResume,\n"
    "  playtimeBeat,\n"
    "  playtimePause,\n"
    "  playtimeMs,\n"
    "  playtimeActive,\n"
    "} from './promotion';"
)

# ══════════════════════════════════════════════════════════════════════════
# ⑤ store.ts — 배선 (LF 파일)
# ══════════════════════════════════════════════════════════════════════════
STORE_IMP_OLD = """import { maybeClaimPromo, promoSettled, touchStreak } from '../toss/promotion';
import { distinctHoldings, holdReached, cashReached } from '../lib/promoRules';"""
STORE_IMP_NEW = """import {
  maybeClaimPromo,
  promoSettled,
  touchStreak,
  playtimeResume,
  playtimeBeat,
  playtimePause,
} from '../toss/promotion';
import { distinctHoldings, holdReached, cashReached, equityReached, PROMO_PLAY_BEAT_MS } from '../lib/promoRules';"""

STORE_DOC_OLD = (
    " *   streak3 → boot()/onVisibility 의 touchStreak · hold10 → afterOrder "
    "· cash100k → afterOrder + boot() 1회"
)
STORE_DOC_NEW = (
    " *   streak3 → boot()/onVisibility 의 touchStreak · hold10 → afterOrder "
    "· cash100k → afterOrder + boot() 1회\n"
    " * ★ 2026-09-01 훅 2종 추가: equity1m → afterOrder + boot() + «매 틱»"
    "(syncFromWorld, 가격만으로 넘는다) · play1h → startLoop 의 «벽시계 비트»"
)

STORE_AFTERORDER_OLD = """    this.checkHoldPromo();
    this.checkCashPromo();
    this.bump();"""
STORE_AFTERORDER_NEW = """    this.checkHoldPromo();
    this.checkCashPromo();
    this.checkEquityPromo();
    this.bump();"""

STORE_CASHFN_OLD = """  private checkCashPromo(): void {
    if (promoSettled('cash100k')) return;
    void maybeClaimPromo('cash100k', cashReached(this.portfolio?.cash));
  }"""
STORE_CASHFN_NEW = """  private checkCashPromo(): void {
    if (promoSettled('cash100k')) return;
    void maybeClaimPromo('cash100k', cashReached(this.portfolio?.cash));
  }

  /*
   * ★총자산(equity1m, 2026-09-01) — 「100만 달러 모으기」. `this.portfolio.equity` = 엔진 `World.equity`
   *   (현금 + 현물 평가액 + 파생 포지션 평가액). 화면 「총 자산」과 «같은 값»이다(promoRules ④ 주석).
   * ★현금 훅과 «판정 지점이 다르다»: 총자산은 주문 없이 가격 틱만으로 문턱을 넘으므로
   *   afterOrder·boot 뿐 아니라 매 틱(syncFromWorld)에서도 본다.
   * ★매 틱 경로라 «미달일 때 할당 0»으로 끊는다 — 판정 자체는 promoRules 한 곳(equityReached).
   */
  private checkEquityPromo(): void {
    if (promoSettled('equity1m')) return;
    if (!equityReached(this.portfolio?.equity)) return;
    void maybeClaimPromo('equity1m', true);
  }"""

STORE_BOOT_OLD = """    this.checkCashPromo();
    /*
     * ★★출석은 ★«복원이 끝난 뒤»에 지급한다."""
STORE_BOOT_NEW = """    this.checkCashPromo();
    /* ★총자산 훅(equity1m)도 부팅 1회 — 복원된 총자산이 «이미» 문턱 이상이면 여기서 잡는다(현금 훅과 같은 이유) */
    this.checkEquityPromo();
    /*
     * ★★출석은 ★«복원이 끝난 뒤»에 지급한다."""

STORE_SYNC_OLD = """    this.portfolio = this.world.portfolio();
    this.pushEquity(this.portfolio.equity);"""
STORE_SYNC_NEW = """    this.portfolio = this.world.portfolio();
    this.pushEquity(this.portfolio.equity);
    /*
     * ★[2026-09-01 · equity1m] 총자산 문턱 판정은 «여기»도 필요하다 — 주문을 한 번도 안 해도
     *   보유 종목 «가격»만으로 100만 달러를 넘길 수 있다. 세션 락이 닫히면(promoSettled) 판정조차 안 한다.
     * ⛔부팅 중에는 보지 않는다 — 생성자의 syncFromWorld(true) 는 워밍업·복원 «전» 시드 월드다(pushEquity 와 같은 이유).
     */
    if (!this.booting) this.checkEquityPromo();"""

STORE_LOOP_OLD = """    this.loopTimer = window.setInterval(() => this.pump(), TICK_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
  }"""
STORE_LOOP_NEW = """    this.loopTimer = window.setInterval(() => this.pump(), TICK_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    /*
     * ★[2026-09-01 · play1h] 플레이 «실시간» 누적 비트. 게임 틱(TICK_MS)과 «별개»의 타이머다 —
     *   조건이 게임 내 가속 시간이 아니라 «벽시계 포그라운드 시간»이기 때문(promoRules ⑤).
     *   지금 화면이 보이는 상태면 바로 시계를 건다. 아니면 onVisibility 가 건다.
     */
    if (document.visibilityState === 'visible') playtimeResume();
    if (!this.playTimer) this.playTimer = window.setInterval(() => void playtimeBeat(), PROMO_PLAY_BEAT_MS);
  }"""

STORE_VIS_OLD = """  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      this.pump();"""
STORE_VIS_NEW = """  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      /* ★[play1h] 포그라운드 복귀 — 여기서부터 «다시» 센다. 백그라운드 시간은 누적되지 않았다 */
      playtimeResume();
      this.pump();"""

STORE_VIS_HIDDEN_OLD = """    } else {
      this.world.save();
      /* ★모아 쓰기(setTimeout 0)가 밀린 채로 탭을 내리면 그대로 유실이다 */
      this.journal.flush();
      this.equity.flush(this.tick);
    }
  };

  private onPageHide = (): void => {
    this.world.save();
    this.journal.flush();
    this.equity.flush(this.tick);
  };"""
STORE_VIS_HIDDEN_NEW = """    } else {
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
  };"""

STORE_FIELD_OLD = "  private loopTimer: number | null = null;"
STORE_FIELD_NEW = (
    "  private loopTimer: number | null = null;\n"
    "  /** ★[2026-09-01 · play1h] 플레이 «실시간» 누적 비트 타이머. 게임 틱과 별개 */\n"
    "  private playTimer: number | null = null;"
)

# ══════════════════════════════════════════════════════════════════════════
# ⑥ index.html — 코드·금액(번들러가 접지 못하는 DOM 속성)
# ══════════════════════════════════════════════════════════════════════════
HTML_OLD = '    data-promo-cash100k-code="__PROMOTION_CODE__" data-promo-cash100k-amount="100"'
HTML_NEW = (
    '    data-promo-cash100k-code="__PROMOTION_CODE__" data-promo-cash100k-amount="100"\n'
    '    data-promo-equity1m-code="__PROMOTION_CODE__" data-promo-equity1m-amount="200"\n'
    '    data-promo-play1h-code="__PROMOTION_CODE__" data-promo-play1h-amount="200"'
)

HTML_DOC_OLD = "      cash100k 현금 10만달러 모으기 100원   (★08-29 「100위 안에 들기」 콘솔 반려 → 교체. 반려 코드는 «제거»)"
HTML_DOC_NEW = (
    "      cash100k 현금 10만달러 모으기 100원   (★08-29 「100위 안에 들기」 콘솔 반려 → 교체. 반려 코드는 «제거»)\n"
    "      equity1m 100만 달러 모으기    200원   (★09-01 신설. 조건 = «총자산»(현금+평가액) 1,000,000 USD 이상)\n"
    "      play1h   1시간 플레이하기     200원   (★09-01 신설. 조건 = «포그라운드 실시간» 누적 3,600,000 ms)"
)

# ── 치환표: (파일, 옛, 새, 모드) ─────────────────────────────────────────
#    모드 'r' = 치환 · 'a' = 파일 끝에 덧붙이기
PATCH = [
    (RULES, RULES_TAG_DOC_OLD, RULES_TAG_DOC_NEW, 'r'),
    (RULES, RULES_TAG_OLD, RULES_TAG_NEW, 'r'),
    (RULES, None, RULES_APPEND, 'a'),
    (CORE, CORE_OLD, CORE_NEW, 'r'),
    (PROM, PROM_IMPORT_OLD, PROM_IMPORT_NEW, 'r'),
    (PROM, PROM_KEYS_OLD, PROM_KEYS_NEW, 'r'),
    (PROM, None, PROM_APPEND, 'a'),
    (IDX, IDX_OLD, IDX_NEW, 'r'),
    (STORE, STORE_DOC_OLD, STORE_DOC_NEW, 'r'),
    (STORE, STORE_IMP_OLD, STORE_IMP_NEW, 'r'),
    (STORE, STORE_FIELD_OLD, STORE_FIELD_NEW, 'r'),
    (STORE, STORE_AFTERORDER_OLD, STORE_AFTERORDER_NEW, 'r'),
    (STORE, STORE_CASHFN_OLD, STORE_CASHFN_NEW, 'r'),
    (STORE, STORE_BOOT_OLD, STORE_BOOT_NEW, 'r'),
    (STORE, STORE_SYNC_OLD, STORE_SYNC_NEW, 'r'),
    (STORE, STORE_LOOP_OLD, STORE_LOOP_NEW, 'r'),
    (STORE, STORE_VIS_OLD, STORE_VIS_NEW, 'r'),
    (STORE, STORE_VIS_HIDDEN_OLD, STORE_VIS_HIDDEN_NEW, 'r'),
    (HTML, HTML_DOC_OLD, HTML_DOC_NEW, 'r'),
    (HTML, HTML_OLD, HTML_NEW, 'r'),
]

FILES = [RULES, CORE, PROM, IDX, STORE, HTML]


def md5(b):
    return hashlib.md5(b).hexdigest()


def read(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def write(rel, b):
    with open(os.path.join(ROOT, rel), 'wb') as f:
        f.write(b)


def eol_of(text):
    """파일에서 «우세한» 줄바꿈. CRLF 파일에 LF 블록을 심지 않기 위한 것."""
    crlf = text.count('\r\n')
    lf = text.count('\n') - crlf
    return '\r\n' if crlf >= lf else '\n'


def fit(block, eol):
    """블록의 줄바꿈을 파일 EOL 에 맞춘다(먼저 LF 로 정규화한 뒤 변환)."""
    return block.replace('\r\n', '\n').replace('\n', eol) if eol == '\r\n' else block.replace('\r\n', '\n')


def apply():
    for rel in FILES:
        dst = os.path.join(BAK, os.path.basename(rel) + SUF)
        if not os.path.exists(dst):
            raise SystemExit('backup missing: ' + dst)
    for rel, old, new, mode in PATCH:
        raw = read(rel)
        text = raw.decode('utf-8')
        eol = eol_of(text)
        if mode == 'a':
            blk = fit(new, eol)
            if blk in text:
                raise SystemExit('append: already present in %s' % rel)
            text = text + blk
        else:
            o = fit(old, eol)
            n = text.count(o)
            if n != 1:
                raise SystemExit('replace: expected exactly 1 match in %s, got %d for: %r' % (rel, n, old[:60]))
            text = text.replace(o, fit(new, eol))
        write(rel, text.encode('utf-8'))
        print('  patched %-28s (%s)' % (rel, 'append' if mode == 'a' else 'replace'))
    print('[promo2] applied %d edits over %d files' % (len(PATCH), len(FILES)))
    for rel in FILES:
        print('  %s  md5=%s' % (rel, md5(read(rel))))


def revert():
    for rel in FILES:
        src = os.path.join(BAK, os.path.basename(rel) + SUF)
        with open(src, 'rb') as f:
            b = f.read()
        write(rel, b)
        print('  restored %-28s md5=%s' % (rel, md5(b)))


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'apply':
        apply()
    elif cmd == 'revert':
        revert()
    else:
        print(__doc__)
        sys.exit(2)
