/**
 * 실행 환경 판별.
 *
 * 이 프로젝트는 2곳에서 돈다:
 *   1) 토스 미니앱 (.ait 안의 WebView)      → 네이티브 브릿지 전부 사용 가능
 *   2) 로컬 개발/정적 호스팅(브라우저)       → 브릿지 전부 불가
 *
 * 브릿지 호출부는 반드시 이 판별을 거치거나 try/catch 로 감싸야 한다.
 * @apps-in-toss/bridge-core 의 NativeWindow 는 브릿지가 없으면 그냥 throw 한다:
 *   "ReactNativeWebView is not available in browser environment"
 *   "__GRANITE_NATIVE_EMITTER is not available"
 *   "<method> is not a constant handler"
 * 감싸지 않으면 토스 밖에서는 첫 SDK 호출에서 앱이 통째로 죽는다(흰 화면).
 *
 * ★ 머니리그는 itch.io / GitHub Pages / MS Store(PWA 래핑) 로도 나가는 앱이라
 *   "토스 밖" 이 예외가 아니라 «정상 경로»다. 폴백은 임시방편이 아니라 요건이다.
 *
 * 출처: 트랙 K 네온스레드 src/toss/env.ts 를 그대로 가져옴(검증된 패턴 재사용,
 * 재작성 금지). 프로젝트 고유 문자열이 없는 범용 파일이라 로직은 무변경.
 */

interface TossNativeWindow {
  ReactNativeWebView?: { postMessage: (msg: string) => void };
  __GRANITE_NATIVE_EMITTER?: { on: (event: string, cb: (data: unknown) => void) => () => void };
  __CONSTANT_HANDLER_MAP?: Record<string, unknown>;
}

function w(): TossNativeWindow {
  return (typeof window !== 'undefined' ? window : {}) as TossNativeWindow;
}

/** 토스 미니앱 WebView 안에서 돌고 있는가 (= 네이티브 브릿지 사용 가능한가) */
export function isInToss(): boolean {
  const win = w();
  return typeof win.ReactNativeWebView?.postMessage === 'function' && win.__GRANITE_NATIVE_EMITTER != null;
}

/**
 * 상수 브릿지(constant bridge)를 쓸 수 있는가.
 * SafeAreaInsets.get() 계열은 postMessage 가 아니라
 * window.__CONSTANT_HANDLER_MAP 을 직접 읽는다. 별도 판별이 필요하다.
 */
export function hasConstant(method: string): boolean {
  const map = w().__CONSTANT_HANDLER_MAP;
  return map != null && method in map;
}

/**
 * 브릿지 호출을 안전하게 감싸는 헬퍼.
 * 실패(브릿지 없음/네이티브 에러/타임아웃)를 fallback 값으로 흡수한다.
 *
 * timeoutMs 가 필요한 이유: 네이티브가 resolve/reject 어느 쪽도 보내지 않으면
 * createAsyncBridge 의 Promise 는 **영원히 pending** 이다(브릿지 코어에 타임아웃
 * 없음 — 실측). 부팅 경로에서 await 하면 그대로 무한 로딩이 된다.
 */
export async function safeBridge<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs = 3000
): Promise<T> {
  if (!isInToss()) {
    return fallback;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: bridge timeout ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(`[toss-sdk] ${label} failed, using fallback:`, err);
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 동기 호출(상수 브릿지)용 안전 래퍼 */
export function safeSync<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.warn(`[toss-sdk] ${label} failed, using fallback:`, err);
    return fallback;
  }
}
