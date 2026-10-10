/**
 * 프로모션(토스 포인트) 지급 «규칙» — ★2026-08-29 훅 3종 신설 (President 지시)
 *
 *   ① 3일 연속 접속하기   → 10원   (streak3)
 *   ② 10종목 담아보기     → 10원   (hold10)
 *   ③ 현금 10만달러 모으기 → 100원  (cash100k)  ★08-29 「100위 안에 들기」(콘솔 반려) 교체
 *
 * ── ⛔ 이 파일의 규율 ─────────────────────────────────────────────────────
 *   1. ★순수 함수만. import 는 `daykey`(그 자체가 import 0개) 하나뿐이다.
 *      ⇒ Node 타입 스트리핑으로 «그대로» 불러 검사한다(`scripts/check_promo_hooks.mjs`).
 *      ⇒ 여기에 SDK·React·store 를 끌어오면 검사기가 죽는다.
 *   2. ★문턱은 «여기 한 곳»뿐이다. store·promotion.ts 가 숫자를 다시 쓰지 않는다.
 *      TESTONLY 빌드는 `scripts/promo_testonly_patch.mjs` 가 이 파일의 숫자와
 *      `PROMO_RULE_TAG` 를 «같이» 바꾼다. ⛔정본 빌드에는 완화값이 «한 글자도» 남으면 안 된다.
 *   3. ★`PROMO_RULE_TAG` 는 «번들 검사용 표식»이다. 미니파이 뒤에는 상수 «이름»이 사라져
 *      숫자 3/10/100 을 번들에서 «찾을 수 없다». 그래서 문자열 리터럴로 같은 값을 박아 두고,
 *      (a) 단위검사가 「태그 == 상수」를 강제하고 (b) .ait 검사기가 태그 리터럴을 찾는다.
 *      ⛔태그만 바꾸거나 숫자만 바꾸면 단위검사가 떨어진다 — 그게 의도다.
 *   4. ⛔엔진 상수·거래 규칙과 무관하다. 여기서 세는 것은 «지급 조건»뿐이다.
 */
import { dayDiff } from './daykey';

/** ① 연속 접속 «일수» 문턱. 3일째 접속한 «순간» 1회 지급 */
export const PROMO_STREAK_DAYS = 3;
/** ② 포트폴리오에 담긴 «서로 다른 종목» 수 문턱 */
export const PROMO_HOLD_TICKERS = 10;
/** ③ 현금 잔고 문턱(USD, 이 값 «이상»이면 달성). 시작 자본 SEED_CASH(10,000)의 10배 */
export const PROMO_CASH_USD = 100000;
/** ④ 총자산 문턱(USD, 이 값 «이상»이면 달성). 시작 자본 SEED_CASH(10,000)의 100배 */
export const PROMO_EQUITY_USD = 1000000;
/** ⑤ 누적 플레이 «실시간» 문턱(ms). 1시간 */
export const PROMO_PLAY_MS = 3600000;
/** 번들 검사 표식 — ★위 «다섯» 숫자와 «반드시» 같아야 한다(단위검사가 강제) */
export const PROMO_RULE_TAG = 'ml-promo-rules:streak=3;hold=10;cash=100000;equity=1000000;play=3600000';

/* ══════════════════════════════════════════════════════════════════════════
   ① 연속 접속
   ══════════════════════════════════════════════════════════════════════════ */

export interface StreakState {
  /** 마지막으로 «접속을 센» 날짜키('YYYY-MM-DD'). 없으면 null */
  lastDate: string | null;
  /** 연속 접속 일수(1 이상). 한 번도 안 셌으면 0 */
  streak: number;
}

/** 연속 일수 상한(손상값 방어). 출석 원장과 같은 취지 — 미친 큰 수를 자른다 */
export const PROMO_STREAK_SANE_MAX = 3650;

export function emptyStreak(): StreakState {
  return { lastDate: null, streak: 0 };
}

/**
 * 저장본을 «믿지 않고» 검증한다(store/attendance.ts `sane` 과 같은 패턴).
 * 깨진 값은 «0일»로 떨어질 뿐, 게임은 계속 돈다.
 */
export function saneStreak(x: unknown): StreakState {
  if (!x || typeof x !== 'object') return emptyStreak();
  const o = x as Record<string, unknown>;
  const n = typeof o.streak === 'number' && Number.isFinite(o.streak) ? Math.floor(o.streak) : 0;
  const d = typeof o.lastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.lastDate) ? o.lastDate : null;
  return {
    lastDate: d,
    streak: Math.min(PROMO_STREAK_SANE_MAX, Math.max(0, n)),
  };
}

/**
 * 오늘 접속을 반영한 «다음 상태».
 *
 *   처음            → streak 1
 *   같은 날(diff 0)  → «그대로» (하루에 여러 번 열어도 1일)
 *   다음 날(diff 1)  → streak + 1
 *   하루 이상 건너뜀 → streak 1 로 «리셋»
 *   시계 되돌림(diff < 0)·형식 깨짐(NaN) → «그대로» (늘리지도 리셋하지도 않는다)
 *
 * ★순수 함수. 저장·지급은 호출부(toss/promotion.ts) 몫이다.
 */
export function advanceStreak(prev: StreakState, today: string): StreakState {
  if (!prev.lastDate || prev.streak <= 0) return { lastDate: today, streak: 1 };
  const diff = dayDiff(prev.lastDate, today);
  if (!Number.isFinite(diff) || diff < 0) return prev;
  if (diff === 0) return prev;
  if (diff === 1) return { lastDate: today, streak: Math.min(PROMO_STREAK_SANE_MAX, prev.streak + 1) };
  return { lastDate: today, streak: 1 };
}

/** ① 달성 판정 */
export function streakReached(streak: number): boolean {
  return Number.isFinite(streak) && streak >= PROMO_STREAK_DAYS;
}

/* ══════════════════════════════════════════════════════════════════════════
   ② 10종목 담기
   ══════════════════════════════════════════════════════════════════════════
   ★«보유 목록»의 정의는 엔진을 따른다 — `Portfolio.holdings`(현물 `acc.holdings` Map).
     · 매도로 0주가 되면 엔진이 Map 에서 «지운다»(world.ts:509/562) ⇒ 0주 항목은 «없다».
     · 레버리지(`leverage[]`)·옵션(`options[]`)은 «별도 배열»이라 여기 «안 센다».
     ⇒ 「종목 담기」 = 현물 보유 종목 수. 파생은 «담는» 게 아니라 «포지션»이다.
     그래도 방어적으로 qty>0 과 ticker 중복을 한 번 더 거른다(보유 목록 정의를 바꾸지 않는다).
   ══════════════════════════════════════════════════════════════════════════ */

export function distinctHoldings(holdings: readonly { ticker: string; qty: number }[] | null | undefined): number {
  if (!holdings) return 0;
  const set = new Set<string>();
  for (const h of holdings) {
    if (h && typeof h.ticker === 'string' && h.ticker && Number.isFinite(h.qty) && h.qty > 0) set.add(h.ticker);
  }
  return set.size;
}

/** ② 달성 판정 */
export function holdReached(distinctCount: number): boolean {
  return Number.isFinite(distinctCount) && distinctCount >= PROMO_HOLD_TICKERS;
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 현금 10만달러 모으기  (★2026-08-29 「100위 안에 들기」 콘솔 반려 → 교체. President 지시)
   ══════════════════════════════════════════════════════════════════════════
   ★«현금»의 정의는 엔진을 따른다 — 우리가 «새로 정하지 않았다».
     `Account.cash`(engine/types.ts:219) = 화면 `Portfolio.cash`(gameWorld.portfolio()) = store.portfolio.cash.
     «미투자 달러 잔고»다. 포지션 평가액·미실현손익은 «안 들어간다»(그건 `World.equity`).
     · 현물   매수 cash -= 대금+수수료 · 매도 cash += 대금-수수료 (world.ts:496/506)
     · 파생   «증거금»은 개시 때 현금에서 «빠지고»(레버리지 597 · 선도/스왑 동일) 청산 때
              손익·펀딩비·수수료를 반영해 «돌아온다»(635). 청산 «전» 미실현손익은 현금에 «없다».
     · 옵션   매수 cash -= 프리미엄+수수료(766) · 매도 cash += 프리미엄-수수료-증거금(849, 수취분 즉시 현금)
     · 보너스 출석·충전(`grantBonusCash`·topup)도 현금에 더해진다. 펀딩비가 넘치면 음수도 된다(persistence.ts:359).
   ⇒ 「현금 10만달러」 = 이 잔고가 문턱 «이상»인 «순간». 순위·자산평가액과 무관하다.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ③ 달성 판정. 잔고가 «없거나»(null/undefined) 깨진 값(NaN)이면 미달. 음수(펀딩비 초과)도 미달.
 *
 * ★★[2026-09-05 President 지시] 「프로모션 10만 달러, 100만 달러 요건들은 «순자산» 기준으로
 *   해서 대출로 바로 프로모션을 달성하는 일을 방지해.」
 *   ⇒ 「현금 10만」의 «뜻»(미투자 잔고)은 유지하고, ★순자산 조건을 «AND» 로 더한다.
 *
 * ★★왜 AND 인가 — 기존 유저에게 영향이 «0» 임을 증명할 수 있기 때문이다:
 *   대출이 없으면  netWorth = equity = cash + 보유평가액 + 파생평가액(각 0 이상) ≥ cash.
 *   즉 `cash ≥ 10만` 이면 `netWorth ≥ 10만` 이 ★자동으로 참이다.
 *   ⇒ 대출을 쓰지 않는 모든 계정에서 판정이 «완전히 동일»하고,
 *     빌린 돈으로 현금만 채운 경우에만 새로 막힌다. 그게 지시의 정확한 표적이다.
 * ⛔`cash` 조건을 지우고 순자산만 보게 «바꾸지 마라» — 그러면 「현금 10만 모으기」가
 *   「자산 10만 만들기」로 뜻이 바뀌어, 주식만 들고 있어도 달성된다(다른 미션이 된다).
 */
export function cashReached(
  cash: number | null | undefined,
  netWorth?: number | null | undefined
): boolean {
  if (!(typeof cash === 'number' && Number.isFinite(cash) && cash >= PROMO_CASH_USD)) return false;
  /* ★순자산을 «모르면» 옛 동작 그대로다 — 호출부가 아직 안 넘기는 경우(부팅 초기)를 막지 않는다.
     ⛔대신 넘어온 값이 «깨졌으면» 미달로 본다: 판정 불가를 「달성」으로 읽으면 오지급이다. */
  if (netWorth === undefined || netWorth === null) return true;
  return Number.isFinite(netWorth) && netWorth >= PROMO_CASH_USD;
}

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

/**
 * ④ 달성 판정. 없거나(null/undefined) 깨진 값(NaN/Infinity)이면 미달. 파산(음수)도 미달.
 *
 * ★★[2026-09-05 President 지시] 인자가 «순자산»으로 바뀌었다 — 총자산이 아니다.
 *   호출부(store.equityPromoValue)가 `portfolio.netWorth` 를 넘긴다.
 *   ★대출이 없으면 netWorth === equity 라 ★기존 유저 판정이 «비트 단위로» 동일하다.
 *   ★대출이 있으면 빌린 만큼 부채가 같이 늘어 순자산이 안 오른다 ⇒ 「빌려서 100만」이 막힌다.
 * ⛔이름을 바꾸지 않은 이유: 프로모션 코드 키(`equity1m`)·지급 기록·콘솔 설정이 전부
 *   이 이름에 묶여 있다. 바꾸면 «지급 이력»과의 연결이 끊긴다. 뜻은 이 주석이 못 박는다.
 */
export function equityReached(netWorth: number | null | undefined): boolean {
  return typeof netWorth === 'number' && Number.isFinite(netWorth) && netWorth >= PROMO_EQUITY_USD;
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
