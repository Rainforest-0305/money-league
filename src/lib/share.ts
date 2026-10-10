/**
 * 앱인토스 «공유 리워드»(contactsViral) — ★리워드 ID 와 SDK 호출을 «여기 한 곳»에 모은다.
 *
 * ── 무엇인가 ────────────────────────────────────────────────────────────
 * 토스 연락처 모듈을 띄워 친구에게 공유하면, 공유가 «완료»될 때마다 앱브릿지가
 * `sendViral` 이벤트로 «지급할 리워드 수량·단위»를 내려준다. 우리는 그 값을 받아
 * 잔고에 충전한다. ⛔중간 재화(충전권·티켓)를 만들지 않는다 — 현금 즉시 가산이다.
 *
 * ── 실제 시그니처 (★인용 아님. 이 프로젝트 node_modules 에서 실측) ─────
 *   node_modules/@apps-in-toss/web-bridge/dist/contactsViral.d.ts
 *     export declare function contactsViral(params: ContactsViralParams): () => void;
 *     ContactsViralParams = { options: { moduleId: string };
 *                             onEvent: (e: ContactsViralEvent) => void;
 *                             onError: (e: unknown) => void }
 *     ContactsViralEvent =
 *       | { type: 'sendViral'; data: { rewardAmount: number; rewardUnit: string } }
 *       | { type: 'close';     data: { closeReason: 'clickBackButton' | 'noReward';
 *                                      sentRewardAmount?: number;
 *                                      sendableRewardsCount?: number;
 *                                      sentRewardsCount: number;
 *                                      rewardUnit?: string } }
 *   웹 경로 런타임: `web-bridge/dist/bridge.js` 의 `createEventBridge('contactsViral')`.
 *   ⇒ RN 경로(native-modules)에는 `isMinVersionSupported({android:'5.223.0', ios:'5.223.0'})`
 *     가드가 있지만 ★웹 경로에는 «없다» — 미지원 버전에서 조용히 아무 일도 안 일어난다.
 *     그래서 아래 `runShareReward` 가 «시작됐는지»를 세지 않고 «이벤트가 왔는지»만 본다.
 *
 * ── 안전 규칙 (lib/ads.ts 와 «같은» 규율) ───────────────────────────────
 * · 이 파일의 함수는 «절대 throw 하지 않는다». 토스 밖(itch.io · GitHub Pages ·
 *   MS Store 래핑 · 로컬 브라우저)이 이 앱의 «정상 경로»다.
 *   ⛔bridge-core 의 NativeWindow 는 브릿지가 없으면 그냥 throw 한다 → 흰 화면.
 * · 보상은 오직 `sendViral` 이벤트에서만 지급한다. 모듈을 «연 것»으로는 안 준다.
 * · 지급 «금액»을 여기에 박지 않는다 — 콘솔 설정값이 이벤트로 내려온다.
 */
import { contactsViral } from '@apps-in-toss/web-framework';
import { isInToss } from '../toss/env';

/**
 * ★공유 리워드 ID (`moduleId`) — 앱인토스 콘솔 «미니앱 > 공유 리워드» 의 UUID.
 *
 * ★★[2026-08-22 반영] President 가 콘솔 화면에서 «읽어 준» 값이다.
 *   ⚠️★그 값을 API 로 «재확인하지 못했다»: `share_reward_get`·`share_reward_list` 가
 *     이 워크스페이스에서 둘 다 「존재하지 않는 정보 입니다」로 실패하고,
 *     공유 리워드가 «없는» 앱을 조회해도 같은 오류라 「없음」과 「조회 불가」가 구분되지 않는다.
 *   ⇒ 즉 이 값의 지위는 [실측]이 아니라 ★[전사]다. 틀릴 수 있다는 전제로 코드가 서 있어야 한다.
 *
 * ★★틀린 ID / 미등록 ID 일 때 무슨 일이 일어나는가 (그리고 왜 앱이 안 죽는가)
 *   공식 문서: 미승인 상태에서 호출하면 「Internal Server Error」가 난다.
 *   ⇒ 그건 이벤트 브릿지의 `onError` 로 온다 → `runShareReward` 가 잡아서
 *     ★no-op 으로 끝내고 세션을 푼다. 화면은 그대로 있고, 잔고는 «건드려지지 않는다».
 *   ⇒ 지급은 오직 `sendViral` 이벤트에서만 일어나므로 «틀린 ID = 지급 0» 이다.
 *     조용히 이상한 금액이 들어가는 경로가 «구조적으로» 없다.
 *
 * ★빈 문자열로 되돌리면 진입점이 «아예 그려지지 않는다»(자리도 안 잡는다 — 유령 여백 0).
 *   기능을 끄고 싶으면 이 한 줄을 `''` 로 두면 된다. 다른 파일은 손댈 필요가 없다.
 * ⛔가짜 UUID 를 지어내 박지 마라 — `bannerJournal` 때 겪은 형태다(인계문서 V-2 ⛔5).
 */
export const SHARE_REWARD_ID = 'd1d3489e-94fa-4a2b-aac5-e40d38d3017f';

/** 리워드 ID 가 «실제로 있는가». 빈 값(미발급)이면 기능이 없는 것으로 다룬다 */
export function hasShareRewardId(): boolean {
  return SHARE_REWARD_ID.length > 0;
}

/**
 * SDK 를 부를 수 있는 환경인가 (토스 앱 안 + 브릿지 함수 존재).
 * ⛔`contactsViral` 에는 `isSupported()` 가 «없다»(이벤트 브릿지라 그렇다) —
 *   `TossAds.attachBanner.isSupported()` 패턴을 여기에 복사하면 항상 false 가 된다.
 */
export function shareRewardSupported(): boolean {
  try {
    return isInToss() && typeof contactsViral === 'function';
  } catch {
    return false;
  }
}

/**
 * ★지금 이 환경에서 공유 리워드 «진입점을 그려도 되는가».
 *   화면은 이 값이 false 면 «아무것도 렌더하지 않는다» — 여백도, 자리도 잡지 않는다.
 *   (인계문서 X-2 ⛔7: 「AdBanner 를 여백 가진 래퍼로 감싸지 마라 — 래퍼는 남는다」)
 */
export function shareRewardAvailable(): boolean {
  return shareRewardSupported() && hasShareRewardId();
}

/** `sendViral` 한 건 — 콘솔이 설정한 수량과 단위가 그대로 내려온다 */
export interface ShareRewardEvent {
  /** 지급할 리워드 수량. ★콘솔 설정값이다 — 코드에 박지 않는다 */
  amount: number;
  /** 리워드 단위 이름(콘솔 등록값). 예: '게임 머니' */
  unit: string;
}

/**
 * ★★「현금 1달러」로 «셀 수 있는» 리워드 단위 명단.
 *
 * ── 왜 명단인가 (⛔모양 규칙 금지) ──────────────────────────────────────
 * 콘솔은 단위를 «자유 문자열»로 받는다. 「하트」·「보석」·「충전권」도 등록될 수 있고,
 * 그때 수량을 그대로 달러로 더하면 ★조용히 틀린 금액이 잔고에 들어간다.
 *   예) 「충전권 10」 → $10 (너무 작다) / 「보석 5,000,000」 → 상한까지 꽉 (너무 크다)
 * ⇒ 그래서 «아는 단위만» 환산하고, 모르는 단위는 ★지급하지 않는다.
 *   Partner 지시 원문: 「조용히 이상한 금액을 넣는 것이 최악이다」.
 *
 * ── 확정값 (2026-08-22 President) ──────────────────────────────────────
 *   단위 「게임 머니」 · 수량 100000  ⇒  현금 +$100,000   (1 단위 = $1)
 * ★수량은 ⛔코드에 박지 않는다 — 콘솔에서 바꾸면 그대로 따라간다.
 *   여기서 정하는 것은 «금액»이 아니라 «단위의 뜻»뿐이다.
 *
 * ── 명단을 넓게 잡은 이유 ───────────────────────────────────────────────
 * 콘솔에서 「게임 머니」를 「게임머니」로 고치는 것만으로 지급이 죽으면 그건 함정이다.
 * ⇒ 공백을 지우고 소문자로 접어서 비교하고, 같은 뜻의 표기를 미리 넣어 둔다.
 * ⛔다른 «재화»(하트·보석·코인·충전권)를 여기 넣지 마라 — 그건 환산이 아니라 발명이다.
 */
const CASH_UNITS = new Set([
  '게임머니', '게임돈', '머니', '게임달러', '달러', '게임캐시', '캐시', '$',
  'gamemoney', 'money', 'gamecash', 'cash', 'dollar', 'dollars', 'usd',
]);

/**
 * 이벤트가 준 «수량 + 단위» → 잔고에 더할 «달러». 모르는 단위면 ★null.
 *
 * ★null 은 「0 을 넣어라」가 아니라 ★「지급하지 마라」다. 호출부가 구분해서 다뤄야 한다
 *   (0 으로 접으면 「상한 소진」과 「단위 모름」이 같은 결과가 되어 원인을 못 찾는다).
 */
export function shareRewardUsd(e: ShareRewardEvent): number | null {
  const key = (e.unit ?? '').replace(/\s+/g, '').toLowerCase();
  if (!CASH_UNITS.has(key)) {
    console.warn('[share] 모르는 리워드 단위 — 지급하지 않는다', e.unit, e.amount);
    return null;
  }
  return Number.isFinite(e.amount) ? e.amount : null;
}

export interface ShareRewardHandlers {
  /** 공유 1건이 «완료»됐을 때. ★여러 번 올 수 있다(친구 수만큼) */
  onReward: (e: ShareRewardEvent) => void;
  /** 모듈이 닫혔을 때. `granted` = 이번 세션에서 우리가 실제로 지급한 횟수는 호출부가 센다 */
  onClose?: (reason: 'clickBackButton' | 'noReward', sentCount: number) => void;
  onError?: (e: unknown) => void;
}

/**
 * 공유 모듈 1회 실행. ★실패해도 절대 throw 하지 않고 no-op cleanup 을 돌려준다.
 *
 * ★★동시 실행을 «구조적으로» 막는다(`live`). 버튼 disabled 만으로는 부족하다 —
 *   라우팅으로 두 화면이 동시에 살아 있을 수 있고, 그러면 모듈 세션이 둘이 되어
 *   같은 공유가 «양쪽»에서 지급될 수 있다. ⛔React `useEffect` 안에서 부르지 마라
 *   (StrictMode 가 두 번 실행한다). 반드시 «사용자 탭»에서만 부른다.
 *
 * @returns cleanup. ★공식 문서 명시 요건: 「반드시 이 함수를 호출해서 리소스를 해제해야 해요」
 */
let live: (() => void) | null = null;

export function shareRewardBusy(): boolean {
  return live !== null;
}

export function runShareReward(h: ShareRewardHandlers): () => void {
  if (!shareRewardAvailable()) return () => {};
  if (live) return () => {};

  let sentCount = 0;
  let released = false;
  let unregister: (() => void) | null = null;

  const release = () => {
    if (released) return;
    released = true;
    live = null;
    try {
      unregister?.();
    } catch {
      /* ignore */
    }
  };

  live = release;
  try {
    unregister = contactsViral({
      options: { moduleId: SHARE_REWARD_ID },
      onEvent: (e) => {
        if (e.type === 'sendViral') {
          sentCount++;
          /* ★콘솔이 준 수량·단위를 «그대로» 넘긴다. 여기서 금액을 만들지 않는다. */
          h.onReward({ amount: e.data.rewardAmount, unit: e.data.rewardUnit });
          return;
        }
        /* type === 'close' — 모듈 종료. 여기서 리소스를 푼다(문서 명시 요건) */
        h.onClose?.(e.data.closeReason, e.data.sentRewardsCount ?? sentCount);
        release();
      },
      onError: (err) => {
        console.warn('[share] contactsViral failed', err);
        h.onError?.(err);
        release();
      },
    });
  } catch (err) {
    console.warn('[share] contactsViral threw', err);
    release();
    h.onError?.(err);
    return () => {};
  }

  return release;
}
