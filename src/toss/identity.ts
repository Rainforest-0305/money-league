/**
 * 필수 SDK ① — 사용자 식별키
 *
 * 미적용 시 앱인토스 심사 반려 사유다(게임 체크리스트:
 * 「사용자 식별자 값을 확인하여 저장하고, 게임이 정상적으로 시작돼요」).
 * 다른 식별자(디바이스 ID, 자체 생성 UUID)를 토스 사용자 키 «대신» 쓰지 않는다
 * — 다만 토스 밖에서는 브릿지 자체가 없으므로 로컬 익명 ID 로 폴백한다
 * (source 필드로 구분하며, 절대 토스 키와 섞지 않는다).
 *
 * ── 두 채널을 모두 시도하는 이유 ────────────────────────────────────────────
 * 웹 경로에서 getAnonymousKey / getUserKeyForGame 은 «서로 다른» 네이티브
 * 메서드다(bridge.ts 실측). 신규 이름을 3초 타임아웃으로 먼저 시도하고,
 * 실패하면 레거시 이름으로 폴백한다 — 어느 쪽이 살아 있든 뚫린다.
 *
 * ── ★ 머니리그에서의 위치 ──────────────────────────────────────────────────
 * 이 앱의 «게임 진행»은 전적으로 로컬(서버 없음)이라 식별키가 세이브 소유권을
 * 가르지 않는다. 그래도 필수 SDK 요건이므로 부팅 시 확보하고 self-test 에
 * 결과를 남긴다. 확보한 키를 게임 데이터의 «키»로 쓰지는 않는다 —
 * 그렇게 하면 브릿지 실패 시 세이브를 통째로 잃는다.
 *
 * 출처: 트랙 K 네온스레드 src/toss/identity.ts. 네임스페이스만 'neon:' → 'ml:'.
 */
import { getUserKeyForGame, getAnonymousKey } from './bridge';
import { safeBridge, isInToss } from './env';
import { storage, KEYS } from './storage';

export type IdentitySource = 'toss' | 'local';

export interface Identity {
  userKey: string;
  source: IdentitySource;
  /** 토스 브릿지가 카테고리 미설정을 반환했는가 (콘솔 설정 필요 신호) */
  invalidCategory: boolean;
}

let cached: Identity | null = null;

function makeLocalId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `local-${c.randomUUID()}`;
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function resolveLocalIdentity(): Promise<Identity> {
  const existing = await storage.getItem(KEYS.localAnonId);
  if (existing) {
    return { userKey: existing, source: 'local', invalidCategory: false };
  }
  const fresh = makeLocalId();
  await storage.setItem(KEYS.localAnonId, fresh);
  return { userKey: fresh, source: 'local', invalidCategory: false };
}

/**
 * 사용자 식별키를 확보한다. 부팅 시 1회 호출하고 결과를 캐시한다.
 * 절대 throw 하지 않는다 — 실패해도 앱은 떠야 한다.
 */
export async function resolveIdentity(): Promise<Identity> {
  if (cached) return cached;

  if (!isInToss()) {
    cached = await resolveLocalIdentity();
    console.log('[toss-sdk][identity] not in Toss, local id:', cached.userKey);
    return cached;
  }

  const modern = await safeBridge('getAnonymousKey', () => getAnonymousKey(), undefined);
  if (modern && modern !== 'ERROR' && modern.type === 'HASH') {
    cached = { userKey: modern.hash, source: 'toss', invalidCategory: false };
    console.log('[toss-sdk][identity] getAnonymousKey ok');
    return cached;
  }

  const legacy = await safeBridge('getUserKeyForGame', () => getUserKeyForGame(), undefined);
  if (legacy && legacy !== 'ERROR' && legacy !== 'INVALID_CATEGORY' && legacy.type === 'HASH') {
    cached = { userKey: legacy.hash, source: 'toss', invalidCategory: false };
    console.log('[toss-sdk][identity] getUserKeyForGame ok');
    return cached;
  }

  if (legacy === 'INVALID_CATEGORY') {
    console.error(
      '[toss-sdk][identity] INVALID_CATEGORY — 토스 콘솔의 앱 카테고리가 «게임»이 아닙니다. ' +
        '코드가 아니라 콘솔 설정을 고쳐야 사용자 식별키를 받을 수 있습니다.'
    );
    const local = await resolveLocalIdentity();
    cached = { ...local, invalidCategory: true };
    return cached;
  }

  console.warn('[toss-sdk][identity] Toss user key unavailable, falling back to local id');
  cached = await resolveLocalIdentity();
  return cached;
}

/** 이미 확보된 식별자(부팅 이후에만 유효). 부팅 전이면 null. */
export function currentIdentity(): Identity | null {
  return cached;
}
