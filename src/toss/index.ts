/**
 * 앱인토스 SDK 통합 부트스트랩 — 필수 SDK 4종.
 *   ① 사용자 식별키  : identity.ts       (getAnonymousKey → getUserKeyForGame 폴백)
 *   ② Safe Area      : safeArea.ts       (SafeAreaInsets.get / .subscribe)
 *   ③ 네이티브 Storage: storage.ts        (Storage.getItem/setItem/removeItem)
 *   ④ 내비게이션 바  : navigationBar.ts  (graniteEvent back/home + config 선언)
 *
 * ★ 이 함수는 절대 throw 하지 않는다. SDK 하나가 실패해도 앱은 떠야 한다.
 *   머니리그는 토스 «밖»(itch.io·GitHub Pages·MS Store 래핑)에도 나가는 앱이라
 *   전부 폴백으로 도는 상태가 «정상 경로»다.
 *
 * ★ 머니리그 고유 정책(라우터 뒤로가기·종료 확인)은 여기 넣지 않는다.
 *   이 파일은 범용 패턴 그대로이고, 고유 로직은 src/tossBoot.ts 에 둔다.
 */
import { resolveIdentity, type Identity } from './identity';
import { initSafeArea } from './safeArea';
import { initNavigationBar } from './navigationBar';
import { storage, KEYS } from './storage';
import { isInToss } from './env';

export interface TossRuntime {
  identity: Identity;
  inToss: boolean;
  selfTest: SdkSelfTest;
  dispose: () => void;
}

export interface SdkSelfTest {
  userKey: 'ok' | 'fallback' | 'invalid-category';
  safeArea: 'ok' | 'fallback';
  storage: 'ok' | 'fallback';
  navigationBar: 'ok' | 'fallback';
}

export async function initTossSdk(): Promise<TossRuntime> {
  const inToss = isInToss();
  console.log(`[toss-sdk] boot (inToss=${inToss})`);

  // ② Safe Area — 가장 먼저. 레이아웃이 이 값에 의존한다.
  const disposeSafeArea = initSafeArea();

  // ④ 내비게이션 바 — 뒤로가기 기본 동작을 즉시 살린다.
  const disposeNav = initNavigationBar();

  // ① 사용자 식별키
  const identity = await resolveIdentity();

  // ③ 네이티브 Storage 실동작 확인 (write → read → 비교)
  const stamp = `${Date.now()}`;
  await storage.setItem(KEYS.sdkSelfTest, stamp);
  const readBack = await storage.getItem(KEYS.sdkSelfTest);
  const storageOk = readBack === stamp;
  console.log(
    `[toss-sdk][storage] round-trip ${storageOk ? 'OK' : 'FAILED'} (wrote=${stamp}, read=${readBack})`
  );

  const selfTest: SdkSelfTest = {
    userKey: identity.invalidCategory ? 'invalid-category' : identity.source === 'toss' ? 'ok' : 'fallback',
    safeArea: inToss ? 'ok' : 'fallback',
    storage: storageOk ? 'ok' : 'fallback',
    navigationBar: inToss ? 'ok' : 'fallback',
  };
  console.log('[toss-sdk] self-test =', selfTest);

  return {
    identity,
    inToss,
    selfTest,
    dispose: () => {
      disposeSafeArea();
      disposeNav();
    },
  };
}

export { storage, KEYS, lsSet, lsRemove, primeAppStorage, APP_STORAGE_KEYS } from './storage';
export { pushBackHandler, exitMiniApp } from './navigationBar';
export { currentIdentity } from './identity';
export { isInToss } from './env';
export type { Identity } from './identity';

/**
 * 프로모션 리워드 훅 3종(★2026-08-29 개편): streak3(3일 연속 접속) · hold10(10종목) · cash100k(현금 10만달러). top100 은 08-29 콘솔 반려로 제거.
 * ⛔한계(재설치 시 재수령 가능·예산이 유일한 방어선)는 promotion.ts 주석에 있다.
 */
export {
  claimPromo,
  maybeClaimPromo,
  promoSettled,
  alreadyRewarded,
  touchStreak,
  playtimeResume,
  playtimeBeat,
  playtimePause,
  playtimeMs,
  playtimeActive,
  claimPromoOnTransition,
  claimPromoOnDelta,
  promoBaselined,
  promoIneligible,
  promoBaseline,
} from './promotion';
export type { PromoId, PromoOutcome } from './promotion';
