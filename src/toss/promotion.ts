/**
 * 프로모션 리워드(토스 포인트) 지급 «배선» — ★2026-08-29 훅 3종으로 개편 (President 지시)
 *
 *   훅 id     콘솔 미션            금액     조건(규칙은 lib/promoRules.ts 한 곳)
 *   streak3   3일 연속 접속하기    10원     연속 접속 3일째 «순간» 1회
 *   hold10    10종목 담아보기      10원     현물 «서로 다른 종목» 10 이상 «순간» 1회
 *   cash100k  현금 10만달러 모으기  100원    현금 잔고(엔진 Account.cash) 100,000 USD 이상 «순간» 1회
 *             ★08-29 「100위 안에 들기」(top100)가 콘솔에서 «반려·종료»돼 이걸로 교체. 훅·코드 «제거».
 *               옛 지급 기록 키 `ml.promo.top100` 은 이름 변경·삭제 없이 그냥 «안 읽는다»(SAVE_VERSION 무접촉).
 *
 *   ⛔옛 훅 「종목 거래해보기」는 콘솔에서 «종료»됐다. 호출·코드 «전부 제거».
 *     (죽은 코드로 호출하면 실패만 남긴다.) 옛 저장 키 `ml.promo` 는 «건드리지 않는다» —
 *     이름 변경·삭제 없이 그냥 «안 읽는다». 새 훅은 각자 «새 키»를 쓴다.
 *
 * ── ⛔ 이 파일이 안고 가는 «한계». 숨기지 마라 (President 결정 2026-08-26) ──
 *   서버를 두지 않는다. 중복 지급 방지가 **로컬 저장 + 세션 락**뿐이다.
 *   1) ★저장을 지우거나 앱을 재설치하면 «같은 사람이 다시 받을 수 있다». 우리는 이걸
 *      못 막는다. 토스도 안 막아준다(「프로모션 지급 내역 API 를 제공하고 있지 않습니다」).
 *      ⇒ ★**최종 방어선은 「콘솔에 설정한 프로모션 예산」 하나뿐이다.**
 *   2) 조건 판정도 클라이언트가 한다. 저장을 조작해 미달성 상태로 요청할 수 있다.
 *   ⇒ 그러니 ★「막을 수 있는 것」은 확실히 막는다: 성공 즉시 기록 · 1인 1회 ·
 *     동시호출 차단 · ★세션당 1회 · 실패를 조용히 삼키지 않기. 구현은 promoCore.ts.
 *
 * ── ⛔ 저장 규율 ────────────────────────────────────────────────────────────
 *   ★세이브 블롭(`ml.game`)을 **건드리지 않는다**. 새 키를 «추가»만 한다.
 *   ⇒ `SAVE_VERSION` 과 «무관» ⇒ 마이그레이션 «0회». 라이브 유저의 잔고·보유·포지션 그대로.
 *   ⇒ 선례: `ml.attendance` · `ml.journal` · `ml.firstSeen` · `ml.traderwatch` · `ml.quotesession` · `ml.promo`.
 *
 * ── 코드·금액을 DOM 에서 읽는 이유 (2026-08-11 광고 실사고와 같은 함정) ─────────
 *   `const CODE = ''` 처럼 두면 번들러가 `if (!CODE) return;` 을 상수 접기로 판정해
 *   지급 호출 블록을 통째로 삭제한다. index.html 의 body data 속성에 두고 «읽기만» 한다.
 *   ⛔금액은 콘솔 카드 금액과 «정확히 같아야» 한다(게임 앱은 고정 금액만 — 08-29 실측).
 */
import { storage } from './storage';
import { safeBridge, isInToss } from './env';
import { grantPromotionReward, grantPromotionRewardForGame, type GrantPromotionResult } from './bridge';
import { createPromoClaimer, type PromoId, type PromoOutcome, type PromoRecord } from './promoCore';
import { kstDateKey } from '../lib/daykey';
import {
  advanceStreak,
  saneStreak,
  streakReached,
  addPlayMs,
  emptyPlay,
  sanePlay,
  playReached,
  PROMO_RULE_TAG,
  type PlayState,
  type StreakState,
} from '../lib/promoRules';

export type { PromoId, PromoOutcome } from './promoCore';

/** 훅별 지급 기록 키 — 세이브 블롭 «밖». 훅마다 «독립»이다 */
const RECORD_KEY: Record<PromoId, string> = {
  streak3: 'ml.promo.streak3',
  hold10: 'ml.promo.hold10',
  cash100k: 'ml.promo.cash100k',
  /* ★2026-09-01 신설 2종. 훅마다 «새 키». 옛 키(ml.promo · ml.promo.top100)는 이름 변경·삭제 없이 그냥 «안 읽는다» */
  equity1m: 'ml.promo.equity1m',
  play1h: 'ml.promo.play1h',
};
/** ① 연속 접속 «날짜» 기록 키(지급 기록과 별개 — 지급 후에도 계속 센다) */
const STREAK_KEY = 'ml.promo.streak';

function readConfig(id: PromoId): { code: string; amount: number } {
  try {
    const b = document.body;
    const code = (b?.getAttribute(`data-promo-${id}-code`) || '').trim();
    const amount = Number.parseInt(b?.getAttribute(`data-promo-${id}-amount`) || '', 10);
    return { code, amount: Number.isFinite(amount) && amount > 0 ? amount : 0 };
  } catch {
    return { code: '', amount: 0 };
  }
}

async function loadRecord(id: PromoId): Promise<PromoRecord> {
  try {
    const raw = await storage.getItem(RECORD_KEY[id]);
    if (!raw) return {};
    const o = JSON.parse(raw) as PromoRecord;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

async function saveRecord(id: PromoId, rec: PromoRecord): Promise<void> {
  await storage.setItem(RECORD_KEY[id], JSON.stringify(rec));
}

const claimer = createPromoClaimer({
  inToss: isInToss,
  readConfig,
  loadRecord,
  saveRecord,
  callBridge: (method, params) =>
    safeBridge<GrantPromotionResult>(
      method,
      () =>
        method === 'grantPromotionReward'
          ? grantPromotionReward({ params })
          : grantPromotionRewardForGame({ params }),
      undefined
    ),
  now: () => Date.now(),
});

/* ★번들 검사 표식을 «런타임에 참조»해 둔다 — 안 하면 트리셰이킹으로 사라져 검사기가 0건을 본다 */
console.log('[promo] rules', PROMO_RULE_TAG);

/**
 * 조건을 «이미 만족했을 때» 부른다. 절대 throw 하지 않고 게임을 막지 않는다.
 * 호출부는 `void claimPromo(id)` 로 흘려보낸다.
 */
export function claimPromo(id: PromoId): Promise<PromoOutcome> {
  return claimer.claim(id);
}

/** 판정 결과를 같이 넘기는 경로. reached=false 면 «아무것도 안 한다»(저장도 브릿지도) */
export function maybeClaimPromo(id: PromoId, reached: boolean): Promise<PromoOutcome> {
  return claimer.maybeClaim(id, reached);
}

/** 이 세션에서 이미 처리된 훅인가 — 호출부가 매 틱 판정을 «값싸게» 건너뛰는 데 쓴다 */
export function promoSettled(id: PromoId): boolean {
  return claimer.settled(id);
}

/** 이미 받았는지 조회(읽기 전용, 로컬 기록 기준). UI 표시용 */
export function alreadyRewarded(id: PromoId): Promise<boolean> {
  return claimer.alreadyRewarded(id);
}

/* ── ★기준선 경로 (2026-09-01 President 「개설 전 이미 달성한 사람에겐 지급 없음」) ──────
 *   ⛔기존 라이브 3종(streak3/hold10/cash100k)은 이 경로를 «쓰지 않는다» — 무접촉.
 *     신설 2종만: equity1m = 상태 보유형(전이) · play1h = 누적 카운터형(기준선 이후분).
 */

/** ★상태 보유형 — 기준선 미달성 → 이후 달성 «전이»일 때만 지급(equity1m) */
export function claimPromoOnTransition(id: PromoId, reachedNow: boolean): Promise<PromoOutcome> {
  return claimer.claimOnTransition(id, reachedNow);
}

/** ★누적 카운터형 — 기준선 이후분만 센다(play1h) */
export function claimPromoOnDelta(id: PromoId, current: number, reached: (v: number) => boolean): Promise<PromoOutcome> {
  return claimer.claimOnDelta(id, current, reached);
}

/** 기준선이 이 세션 메모리에 잡혔는가 — 매 틱 경로가 값싸게 건너뛰는 데 쓴다 */
export function promoBaselined(id: PromoId): boolean {
  return claimer.baselined(id);
}

/** 기준선 시점에 이미 달성이라 «영구 미지급»인가 — 매 틱 경로의 값싼 문 */
export function promoIneligible(id: PromoId): boolean {
  return claimer.ineligible(id);
}

/** 기준선 스냅샷(읽기 전용). 검증·디버그용 */
export function promoBaseline(id: PromoId) {
  return claimer.baselineOf(id);
}

/* ══════════════════════════════════════════════════════════════════════════
   ① 연속 접속 — 날짜 기록 + 달성 시 지급
   ══════════════════════════════════════════════════════════════════════════
   ★날짜키는 프로젝트의 «유일한» 하루 기준 `kstDateKey`(lib/daykey.ts) 를 쓴다.
     지시문의 「기기 로컬 자정」과 KST 자정은 «기기 시간대가 KST 일 때» 같다.
     두 번째 날짜 규칙을 만들지 않는 것이 daykey.ts 의 명문 규율이라 KST 로 통일했다.
     ⇒ 이 판단은 보고문에 «명시»한다(Partner 결정 사항).
   ★부팅(`store.boot`)과 «가시성 복귀»에서 부른다 — 출석(`claimAttendance`)과 같은 두 지점.
     하루에 몇 번 불려도 같은 날이면 상태가 «그대로»라 멱등이다.
   ══════════════════════════════════════════════════════════════════════════ */

let streakBusy: Promise<StreakState> | null = null;

async function loadStreak(): Promise<StreakState> {
  try {
    const raw = await storage.getItem(STREAK_KEY);
    return saneStreak(raw ? JSON.parse(raw) : null);
  } catch {
    return saneStreak(null);
  }
}

/**
 * 오늘 접속을 센다. 상태가 바뀌었으면 저장하고, 문턱에 «닿았으면» 지급을 요청한다.
 * ★지급 요청은 세션 락·로컬 기록이 막으므로 3일째 이후 매일 불려도 «한 번»만 나간다.
 */
export function touchStreak(today: string = kstDateKey()): Promise<StreakState> {
  if (streakBusy) return streakBusy;
  streakBusy = (async () => {
    const prev = await loadStreak();
    const next = advanceStreak(prev, today);
    if (next !== prev) {
      try {
        await storage.setItem(STREAK_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('[promo:streak3] 접속 기록 저장 실패:', e);
      }
    }
    void claimer.maybeClaim('streak3', streakReached(next.streak));
    return next;
  })().finally(() => {
    streakBusy = null;
  });
  return streakBusy;
}

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
    /*
     * ★[2026-09-01] 기준선을 «누적을 시작하기 전»에 박는다(President 「개설 전 이미 달성한 사람 제외」).
     *   · 새 기기        → from = 0     ⇒ 1시간을 «온전히» 채워야 지급
     *   · 이미 논 기기   → from = 복원값 ⇒ 과거 누적은 «이월되지 않는다»(0부터 새로)
     *   ★여기서 박아야 «결정적»이다 — 첫 비트에서 박으면 그 비트분(15초)이 기준선에 먹힌다.
     *   ★이 await 는 playChain 의 «머리»라 모든 비트보다 먼저 끝난다. 절대 throw 하지 않는다.
     */
    await claimer.claimOnDelta('play1h', st.totalMs, playReached);
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
      /*
       * ★지급은 세션 락·로컬 기록이 막으므로 1시간을 넘긴 뒤 매 비트 불려도 «한 번»만 나간다.
       * ★[2026-09-01] «누적 카운터형» — 기준선 이후분만 센다. 첫 비트에서 기준선(from = 그때의 누적)을
       *   박고, 그 뒤로는 (현재 − from) 이 문턱을 넘어야 지급이다. 과거 누적값은 «이월하지 않는다».
       */
      void claimer.claimOnDelta('play1h', next.totalMs, playReached);
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
