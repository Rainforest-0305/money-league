/**
 * 토스 푸시 알림 동의 «배선» — ★2026-09-10 신설 (President 지시 「2번 푸시 개통해」)
 *
 * ── 구조 (SDK 실측 · 이 프로젝트의 node_modules 기준) ──────────────────────────
 *   @apps-in-toss/web-bridge@2.10.8 dist/index.d.ts:1109-1135
 *     requestNotificationAgreement({ options:{ templateCode }, onEvent, onError }): () => void
 *     onEvent.type = 'newAgreement' | 'alreadyAgreed' | 'agreementRejected'
 *     반환값 = 앱브릿지 콜백 «해제» 함수. 결과가 오면 반드시 호출한다(SDK 예제와 동일).
 *   ⛔이 함수 «하나»뿐이다. 동의 상태만 조회하는 API · 철회 API · 토큰 API 는 없다.
 *     ⇒ 「동의했는지」는 이 기기 Storage 에 적어 두고, 잃으면 다시 눌러 'alreadyAgreed' 로 복구한다.
 *
 * ── templateCode 가 무엇인가 [확인 · 개발자센터 스마트 발송 가이드] ─────────────────
 *   「미니앱에서 알림 동의문을 호출할 때 쓰는 templateCode 는, 그 알림 동의문이 연결된
 *    «기능성 메시지의 발송 코드»예요. 콘솔 → 스마트 발송 → 기능성 탭」.
 *   발송 코드는 반드시 `{appName}-` 로 시작한다(콘솔이 접두를 자동으로 붙인다).
 *   ⇒ 콘솔에 만드는 기능성 정기 발송(매일 20:00 「리그 순위」)의 코드가 아래 상수다.
 *   ⛔콘솔 코드와 «글자 하나» 다르면 동의창이 안 뜨거나 엉뚱한 동의문이 뜬다 — 바꿀 땐 둘을 같이.
 *
 * ── 발송 주체 ──────────────────────────────────────────────────────────────────
 *   우리 서버는 없다. 콘솔의 «정기 발송»(type=REGULAR)이 동의한 사용자에게 매일 보낸다.
 *   이 파일은 «동의창을 띄우는 것»까지만 한다. 무엇을 언제 보내는지는 콘솔 템플릿이 정본.
 *
 * ── 저장 규율 ──────────────────────────────────────────────────────────────────
 *   새 키 `ml.push` 하나만 «추가». 세이브 블롭(ml.game)·SAVE_VERSION 무접촉(선례: ml.promo.*).
 *   privacy.html §2 표에 같은 키를 적어야 check_privacy_keys 가 통과한다(「전부입니다」 유지).
 *
 * ── 토스 밖 ────────────────────────────────────────────────────────────────────
 *   itch.io·GitHub Pages·MS Store 경로에서는 브릿지가 없다 ⇒ availability='unavailable' 이고
 *   설정 행·홈 안내가 «통째로» 그려지지 않는다(공유 리워드 행과 같은 규칙: 빈 자리 0).
 */
import { useSyncExternalStore } from 'react';
import { requestNotificationAgreement } from '@apps-in-toss/web-framework';
import { storage } from './storage';
import { isInToss } from './env';

/** 콘솔 기능성 정기 발송의 «발송 코드». 콘솔 값과 반드시 같아야 한다(위 주석). */
export const PUSH_TEMPLATE_CODE = '__PUSH_TEMPLATE_CODE__';

/** 이 기기의 동의 기록 + 홈 안내 닫음 기록. 세이브 블롭 «밖». */
const PUSH_KEY = 'ml.push';

interface PushRecord {
  /** 동의 완료('newAgreement' | 'alreadyAgreed')를 이 기기에서 확인한 시각(ms) */
  agreedAt?: number;
  /** 홈 안내 카드를 닫은 시각(ms). 닫으면 다시 띄우지 않는다(설정에서 언제든 켤 수 있다) */
  dismissedAt?: number;
  /** 사용자가 동의창에서 거부한 시각(ms). 홈 안내는 접고, 설정 행은 「다시 켤 수 있어요」 */
  rejectedAt?: number;
}

export type PushAvailability =
  /** 토스 밖 — 행 자체를 그리지 않는다 */
  | 'unavailable'
  /** 동의 가능(아직 안 함 또는 상태 모름) */
  | 'ready'
  /** 이 기기에서 동의 완료로 기록됨 */
  | 'agreed'
  /** 동의창에서 거부. 다시 시도 가능 */
  | 'rejected';

export interface PushState {
  availability: PushAvailability;
  /** 설정 행·홈 안내를 그릴지. 토스 안에서만 true */
  available: boolean;
  enabled: boolean;
  /** 동의창 호출 진행 중(중복 호출 방지) */
  busy: boolean;
  /** 홈 안내 카드를 보일지: 토스 안 + 미동의 + 미거부 + 안 닫음 */
  nudge: boolean;
  /** 마지막 오류(있으면). 조용히 삼키지 않는다 */
  error: string;
}

let record: PushRecord = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

function derive(patch: { busy?: boolean; error?: string } = {}): PushState {
  const available = isInToss();
  const availability: PushAvailability = !available
    ? 'unavailable'
    : record.agreedAt
      ? 'agreed'
      : record.rejectedAt
        ? 'rejected'
        : 'ready';
  return {
    availability,
    available,
    enabled: availability === 'agreed',
    busy: patch.busy ?? state.busy,
    nudge: available && availability === 'ready' && !record.dismissedAt,
    error: patch.error ?? state.error,
  };
}

let state: PushState = {
  availability: 'unavailable',
  available: false,
  enabled: false,
  busy: false,
  nudge: false,
  error: '',
};
state = derive();

const listeners = new Set<() => void>();
function emit(): void {
  listeners.forEach((l) => l());
}
/**
 * ★[2026-09-12 · -34] «복원 경합» 방어 (Codex 리뷰 7번).
 *   [확인·SDK 모사] 저장소 읽기가 느린 상태에서 동의를 마친 뒤 과거 기록 `{}` 가 도착하면
 *   `record = o` 가 방금 받은 동의를 덮어 **agreed → ready** 로 돌아갔다(유저는 동의창을 다시 본다).
 *   ⇒ 「복원 시작 뒤에 일어난 변경이 이긴다」. 이 숫자가 늘었으면 늦게 온 저장본은 «버린다».
 *   ⛔병합(`{...o, ...record}`)으로 처리하지 마라 — 어느 필드가 이겼는지 경로마다 달라진다.
 */
let localWrites = 0;

function setRecord(patch: PushRecord): void {
  record = { ...record, ...patch };
  localWrites += 1;
  void storage.setItem(PUSH_KEY, JSON.stringify(record)).catch(() => undefined);
  state = derive();
  emit();
}
function setFlags(patch: { busy?: boolean; error?: string }): void {
  state = derive(patch);
  emit();
}

/** 부팅 후 1회. 저장된 기록을 읽는다(실패해도 무해 — 다시 누르면 'alreadyAgreed' 로 복구). */
export function hydratePushState(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  const writesAtStart = localWrites;
  hydrating = (async () => {
    try {
      const raw = await storage.getItem(PUSH_KEY);
      /* ★읽는 동안 유저가 동의·거부를 마쳤다면 그쪽이 «최신»이다 — 늦게 온 저장본을 버린다 */
      if (raw && localWrites === writesAtStart) {
        const o = JSON.parse(raw) as PushRecord;
        if (o && typeof o === 'object') record = o;
      }
    } catch {
      /* 읽기 실패 = 미동의로 보인다. 켜면 복구된다 */
    } finally {
      hydrated = true;
      state = derive();
      emit();
    }
  })();
  return hydrating;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void hydratePushState();
  return () => {
    listeners.delete(listener);
  };
}
export function getPushState(): PushState {
  return state;
}
/** 화면에서 쓰는 훅. 첫 구독 때 저장 기록을 자동으로 읽어 온다. */
export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, getPushState, getPushState);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 120);
  if (typeof error === 'string') return error.slice(0, 120);
  try {
    return JSON.stringify(error).slice(0, 120);
  } catch {
    return String(error).slice(0, 120);
  }
}

/**
 * 알림 켜기 = 토스 알림 동의창 호출.
 * 절대 throw 하지 않는다. 결과가 어느 쪽이든 브릿지 콜백을 해제한다.
 * ⛔타임아웃을 두지 않는다 — 동의창은 «사용자가 읽고 누르는» UI 라 몇 분이 걸려도 정상이다.
 *   대신 busy 로 중복 호출만 막는다.
 */
export function enablePush(): Promise<PushState> {
  if (!isInToss()) {
    setFlags({ error: 'not in toss' });
    return Promise.resolve(state);
  }
  if (state.busy) return Promise.resolve(state);
  setFlags({ busy: true, error: '' });

  return new Promise<PushState>((resolve) => {
    let settled = false;
    let cleanup: (() => void) | undefined;
    const finish = (rec: PushRecord | null, error = ''): void => {
      if (settled) return;
      settled = true;
      try {
        cleanup?.();
      } catch {
        /* 해제 실패는 결과와 무관 */
      }
      if (rec) {
        record = { ...record, ...rec };
        /* ★복원보다 «이쪽»이 최신임을 표시한다(위 localWrites 주석) */
        localWrites += 1;
        void storage.setItem(PUSH_KEY, JSON.stringify(record)).catch(() => undefined);
      }
      state = derive({ busy: false, error });
      emit();
      resolve(state);
    };
    try {
      cleanup = requestNotificationAgreement({
        options: { templateCode: PUSH_TEMPLATE_CODE },
        onEvent: (result) => {
          if (result.type === 'agreementRejected') {
            finish({ rejectedAt: Date.now(), agreedAt: undefined });
            return;
          }
          /* 'newAgreement' | 'alreadyAgreed' — 둘 다 켜짐 */
          finish({ agreedAt: Date.now(), rejectedAt: undefined });
        },
        onError: (error) => {
          console.warn('[push] requestNotificationAgreement failed:', error);
          finish(null, describeError(error));
        },
      });
    } catch (error) {
      console.warn('[push] requestNotificationAgreement threw:', error);
      finish(null, describeError(error));
    }
  });
}

/** 홈 안내 카드 닫기. 설정 행은 그대로 남는다. */
export function dismissPushNudge(): void {
  setRecord({ dismissedAt: Date.now() });
}

/*
 * ★끄기 버튼은 «없다». 토스 SDK 에 동의 철회 API 가 없다(export 목록 실측 · 켜기 하나뿐).
 *   앱 안에 「끄기」를 두면 로컬 표시만 바뀌고 알림은 계속 온다 = 약속을 안 지키는 스위치다.
 *   ⇒ 끄는 길은 토스 앱 알림 설정이고, 그 사실을 문구(settings:notifyHint)로 그대로 말한다.
 */
