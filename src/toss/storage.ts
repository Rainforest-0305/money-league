/**
 * 필수 SDK ③ — 네이티브 Storage
 *
 * ── 왜 localStorage 로만 두면 안 되는가 ─────────────────────────────────────
 * 미니앱 WebView 의 localStorage 는 영속을 보장하지 않는다. iOS ITP 는
 * **7일간 미접속이면 localStorage/IndexedDB 를 삭제**할 수 있고, 토스 앱이
 * WebView 데이터를 비우거나 origin 이 바뀌어도 통째로 날아간다.
 * 네이티브 Storage 는 앱 데이터 영역에 저장되어 살아남는다.
 * ★ AsyncStorage 를 쓰면 안 된다 — 웹 경로에서 no-op 스텁이라 «조용히» 아무
 *   것도 저장되지 않는다.
 *
 * ── ★ 4종 래핑과 «구조가 다르다» ───────────────────────────────────────────
 * 4종은 원본 게임 코드를 1바이트도 못 고치는 제약이 있어서
 * `window.__nativeStorageMirror` 라는 «전역 훅»을 심고 게임의 persist() 가
 * 그걸 부르게 했다. 머니리그는 store.ts·persistence.ts 가 «우리 코드»다.
 * → 전역 훅이 «불필요»하다. 저장 지점에서 아래 lsSet/lsRemove 를 «직접» 부른다.
 * → 그래서 이 프로젝트의 번들에는 window.__* 훅이 «0건»인 것이 정상이다.
 *
 * ── 동기/비동기 임피던스 — 이 파일의 핵심 설계 ──────────────────────────────
 * 문제: 네이티브 Storage 는 «비동기»(Promise)인데, 이 앱의 읽기 경로는 «동기»다.
 *   store.ts 생성자(152~158행)가 모듈 로드 시점에 localStorage 를 동기로 읽고,
 *   persistence.loadGame() 도 동기다. 여기를 async 로 바꾸면 부팅 순서가 통째로
 *   흔들린다(첫 페인트·워밍업 3000틱·Gate 라우팅이 전부 이 값에 걸려 있다).
 *
 * 해결: 읽기 경로는 «건드리지 않는다». 대신 부팅 «전»에 한 번,
 *   primeAppStorage() 가 네이티브 미러를 읽어 localStorage 에 «역주입»한다.
 *   그 뒤로는 앱이 늘 하던 대로 localStorage 를 동기로 읽으면 된다.
 *     [부팅]  네이티브 → (없는 키만) localStorage → 앱이 동기로 읽음
 *     [저장]  localStorage(즉시) + 네이티브(fire-and-forget)
 *   main.tsx 가 primeAppStorage() 를 await 한 «뒤에» 앱 모듈을 동적 import
 *   하는 이유가 이것이다. 정적 import 로 두면 store.ts 생성자가 프라이밍보다
 *   «먼저» 돌아서 역주입이 늦는다.
 */
import { Storage } from '@apps-in-toss/web-framework';
import { isInToss, safeBridge } from './env';

/** 이 SDK 레이어 자체가 쓰는 키의 접두사(앱 데이터 키와 섞이지 않게). */
const NS = 'ml:';

/**
 * 앱이 실제로 쓰는 localStorage 키 «전량». grep 실측 근거:
 *   src/store/store.ts:61-66        LS = { session, settings, watchlist, onboarded }
 *   src/lib/engine/persistence.ts:22 SAVE_KEY = 'ml.game'
 *
 * ※ 'ml.seed' 는 «의도적으로 제외»한다. QA 재현용 디버그 시드(gameWorld.ts:61)이며
 *   기기를 넘어 영속되면 오히려 매번 같은 장세가 재현되는 부작용이 난다.
 *   정상 플레이 경로에서는 아무도 쓰지 않는다(기본값은 랜덤 시드).
 */
export const APP_STORAGE_KEYS = [
  'ml.session',
  'ml.settings',
  'ml.watchlist',
  'ml.onboarded',
  'ml.game',
  /*
   * ★[2026-08-31 · -23] 미러는 쓰면서 «되살리지는 않던» 키들 — iOS ITP 7일/웹뷰 데이터 초기화 뒤 현금은 돌아오는데
   *   일지·출석·시즌·관심·호가세션은 «빈 상태»로 시작하던 갭(L6 진단). 전부 lsSet 으로 미러에 쓰이던 키다.
   *   원칙은 그대로 «없는 키만» 역주입 — 정상 재진입(localStorage 살아 있음)에는 아무 영향이 없다.
   * ※ 'ml.firstSeen'(엔진 roster.ts 가 raw localStorage 로 씀 · 미러 없음)과 'ml.promo.*'(프로모션 훅 · 무접촉)는 제외.
   */
  'ml.journal',
  'ml.attendance',
  'ml.season',
  'ml.traderwatch',
  'ml.quotesession',
  'ml.equity',
  'ml.cbfills',
] as const;

/** 이 SDK 레이어 전용 키. */
export const KEYS = {
  /** SDK 연동 self-test 용(심사/디버그 확인 목적) */
  sdkSelfTest: `${NS}sdkSelfTest`,
  /** 로컬 익명 ID(토스 밖 폴백) */
  localAnonId: `${NS}localAnonId`,
  /** 앱 키를 네이티브에 미러링할 때 쓰는 접두사 */
  mirrorPrefix: `${NS}mirror.`,
} as const;

function nativeKeyFor(appKey: string): string {
  return `${KEYS.mirrorPrefix}${appKey}`;
}

function localGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / private mode — 무시 */
  }
}
function localRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/** 비동기 네이티브 Storage 래퍼. 토스 밖에서는 localStorage 로 자동 분기한다. */
export const storage = {
  async getItem(key: string): Promise<string | null> {
    if (!isInToss()) return localGet(key);
    return safeBridge(`Storage.getItem(${key})`, () => Storage.getItem(key), localGet(key));
  },

  async setItem(key: string, value: string): Promise<void> {
    localSet(key, value);
    if (!isInToss()) return;
    await safeBridge(`Storage.setItem(${key})`, () => Storage.setItem(key, value), undefined);
  },

  async removeItem(key: string): Promise<void> {
    localRemove(key);
    if (!isInToss()) return;
    await safeBridge(`Storage.removeItem(${key})`, () => Storage.removeItem(key), undefined);
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   앱 저장 지점이 «직접» 부르는 동기 API
   ── localStorage.setItem 을 그대로 대체한다. 호출부는 await 하지 않는다
      (저장 때문에 UI 가 멈추면 안 된다). 네이티브 쓰기는 fire-and-forget.
   ══════════════════════════════════════════════════════════════════════════ */

/** localStorage 에 즉시 쓰고, 네이티브에도 미러링한다. */
export function lsSet(key: string, value: string): void {
  localSet(key, value);
  if (isInToss()) {
    void storage.setItem(nativeKeyFor(key), value);
  }
}

/** localStorage 에서 즉시 지우고, 네이티브 미러도 지운다. */
export function lsRemove(key: string): void {
  localRemove(key);
  if (isInToss()) {
    void storage.removeItem(nativeKeyFor(key));
  }
}

/**
 * 네이티브 미러«만» 쓴다. localStorage 는 건드리지 않는다.
 * 호출부가 이미 자기 방식으로 localStorage 를 쓴 뒤에 부르는 용도다
 * (lib/engine/persistence.ts 는 disabled 플래그·용량초과 처리를 자체적으로
 *  갖고 있어서 localStorage 쓰기를 이중으로 하면 안 된다).
 */
export function mirrorSave(key: string, value: string): void {
  if (!isInToss()) return;
  void storage.setItem(nativeKeyFor(key), value);
}

/**
 * 네이티브 미러«만» 지운다.
 * ★ 이걸 빠뜨리면 세이브를 지워도 다음 부팅에서 primeAppStorage() 가
 *   네이티브에 남은 옛 값을 그대로 되살린다(= 지워지지 않는 세이브 버그).
 */
export function mirrorDrop(key: string): void {
  if (!isInToss()) return;
  void storage.removeItem(nativeKeyFor(key));
}

/**
 * 부팅 시 «1회», 앱 모듈이 로드되기 «전»에 호출한다.
 *
 * 네이티브에 미러링된 값이 있고 localStorage 에는 해당 키가 «아직 없을 때만»
 * 역주입한다(ITP 삭제·재설치·WebView 데이터 초기화 복구). localStorage 에
 * 값이 이미 있으면 그쪽이 정본이므로 덮어쓰지 않는다 — 최신 세션의 진행 상황을
 * 오래된 미러로 되돌리는 사고를 막는다.
 *
 * 절대 throw 하지 않는다. 실패해도 앱은 떠야 한다(그 경우 신규 시작이 된다).
 */
export async function primeAppStorage(
  keys: readonly string[] = APP_STORAGE_KEYS
): Promise<{ restored: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const skipped: string[] = [];

  if (!isInToss()) {
    // 토스 밖에서는 네이티브 미러가 존재할 수 없다. localStorage 가 유일한 정본.
    return { restored, skipped: [...keys] };
  }

  await Promise.all(
    keys.map(async (key) => {
      try {
        if (localGet(key) !== null) {
          skipped.push(key);
          return;
        }
        const mirrored = await storage.getItem(nativeKeyFor(key));
        if (mirrored !== null) {
          localSet(key, mirrored);
          restored.push(key);
        } else {
          skipped.push(key);
        }
      } catch (err) {
        console.warn(`[toss-sdk][storage] prime failed for ${key}:`, err);
        skipped.push(key);
      }
    })
  );

  console.log(
    `[toss-sdk][storage] prime done — restored=${restored.length ? restored.join(',') : 'none'} ` +
      `skipped=${skipped.length}`
  );
  return { restored, skipped };
}
