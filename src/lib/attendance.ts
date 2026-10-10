/**
 * 출석 이벤트 — ★규칙만 있는 «순수» 모듈.
 *
 * ⛔React·엔진·저장소 무의존. 여기 있는 것은 전부 «같은 입력이면 같은 출력»인 함수다.
 *   ⇒ 그래서 화면 없이 «숫자로» 검증할 수 있다. 규칙이 화면 안에 있으면
 *     브라우저를 띄워야만 확인할 수 있고, 그러면 아무도 확인하지 않는다.
 *
 * ── 왜 하는가 [실측] ────────────────────────────────────────────────────
 *   같은 코호트 129명 기준 D1 잔존이 ★4.65% 다(캐주얼 게임 평균 25~35%의 1/5).
 *   ★「앱이 못 쓸 수준」이 아니라 ★「돌아올 이유가 없다」가 문제다.
 *
 * ── 금액을 이렇게 정한 근거 (President/Chief 승인 2026-08-22) ────────────
 *   ★「마찰당 보상」으로 정렬했다. 출석은 마찰이 ★0 이다(그냥 열면 된다).
 *     무료 충전  $10,000 × 3회/일  = $30,000/일   (파산 구제 전용 + 10분 쿨다운)
 *     광고 충전  $10,000 × 10회/일 = $100,000/일  (30초 시청)
 *     공유 리워드 $100,000 × 10회/일 = $1,000,000/일 (친구에게 보내는 사회적 비용)
 *   ⇒ 1일차는 광고 1회의 «절반». 7일차만 공유 1회분으로 올린다.
 *   ⇒ 7일 누적 $220,000 = ★공유 «하루» 최대치의 0.22일치 ⇒ 공유가 4.5배 우위로 유지된다.
 *     일평균 $31,428 = 광고 하루 최대치의 0.31 ⇒ 광고가 3.2배 우위로 유지된다.
 *     ⛔출석이 기존 리워드를 «죽이지 않는다»는 것이 이 표의 존재 이유다.
 *
 * ⛔이 상수를 바꾸면 위 세 줄의 산술이 깨진다. 바꾸려면 그 비율을 다시 계산해 근거를 대라.
 */
import { dayDiff, isDateKey } from './daykey';

/**
 * 연속 출석 보상(USD). ★1일차부터 7일차까지, 그 뒤로는 «7일 주기»로 반복한다.
 *
 * ★★D6 → D7 의 2.5배 점프가 이 설계의 «핵심»이다.
 *   곡선이 선형이면 6일차에 그만둬도 «손실감»이 없다 — 그러면 돌아올 이유가 안 된다.
 *   [설계] 마지막 칸이 크게 튀어야 「여기까지 왔는데」가 만들어진다.
 * ⛔중간을 평평하게 만들지 마라. 그러면 7일차 점프가 «절벽»으로 읽힌다.
 */
export const ATTENDANCE_REWARDS = [5_000, 10_000, 15_000, 20_000, 30_000, 40_000, 100_000] as const;

/** 한 주기 길이(일). 배열 길이에서 «유도»한다 — 숫자를 두 벌 두지 않는다 */
export const ATTENDANCE_CYCLE_DAYS = ATTENDANCE_REWARDS.length;

/** 한 주기 누적(USD). ⛔화면·문서에 이 값을 손으로 적지 마라 — 여기서 가져가라 */
export const ATTENDANCE_CYCLE_TOTAL = ATTENDANCE_REWARDS.reduce((a, b) => a + b, 0);

/**
 * 하루 지급 «횟수» 상한. ★출석은 정의상 하루 1회다.
 * ⛔공유 리워드(10회)와 다르다 — 공유는 «친구 수»만큼 오는 외부 이벤트이고,
 *   출석은 우리가 «날짜»를 보고 스스로 판정한다.
 */
export const ATTENDANCE_DAILY_MAX = 1;

/**
 * 1회 지급 상한(USD). ★곡선의 최대값에서 «유도»한다.
 * ⛔여기서 클램프하는 이유는 `gameWorld.grantShareReward` 와 같다 —
 *   상수가 바뀌거나 값이 조작돼도 게임 경제가 안 깨지게. 상한은 «엔진»이 다시 한 번 씌운다.
 */
export const ATTENDANCE_MAX_USD = Math.max(...ATTENDANCE_REWARDS);

/**
 * 광고로 «추가» 지급되는 배수. 1 = 기본 보상만큼 «한 번 더».
 * ⛔광고를 «봐야만» 기본 보상을 주지 않는다 — 기본은 화면에 들어오는 즉시 이미 지급된다.
 *   광고는 그 위에 얹는 것이다(토스 정책 「과도한 공유·시청 유도 금지」와도 맞는다).
 */
export const ATTENDANCE_AD_MULTIPLIER = 1;

/** 저장본에서 읽은 streak 이 미친 값일 때의 상한 — 표시가 깨지지 않게만 막는다 */
export const ATTENDANCE_STREAK_SANE_MAX = 100_000;

/**
 * streak(1부터) → 그날의 보상(USD).
 *
 * ★7일이 넘으면 «주기»로 반복한다. 8일차 = 1일차 금액이 아니라 ★8일차 = 주기의 1번째다.
 * ⛔`streak - 1` 을 그냥 인덱스로 쓰면 8일차에 `undefined` 가 나오고 NaN 이 잔고로 간다.
 */
export function rewardForStreak(streak: number): number {
  if (!Number.isFinite(streak) || streak < 1) return ATTENDANCE_REWARDS[0];
  const idx = (Math.floor(streak) - 1) % ATTENDANCE_CYCLE_DAYS;
  return ATTENDANCE_REWARDS[idx];
}

/** 주기 안에서 «몇 번째 칸»인가 (1..7). 화면의 점 표시가 쓴다 */
export function cyclePosition(streak: number): number {
  if (!Number.isFinite(streak) || streak < 1) return 1;
  return ((Math.floor(streak) - 1) % ATTENDANCE_CYCLE_DAYS) + 1;
}

/** 「내일 오면 얼마」 — 다음 칸의 금액 */
export function nextReward(streak: number): number {
  return rewardForStreak((Number.isFinite(streak) && streak >= 1 ? Math.floor(streak) : 0) + 1);
}

export type AttendanceReason =
  /** 오늘 이미 받았다 */
  | 'already'
  /** 처음이다(또는 기록이 없다/깨졌다) */
  | 'first'
  /** 어제도 왔다 — 이어진다 */
  | 'continued'
  /** 하루 걸렀다 — ★유예. 끊기지 않고 «유지»된다 */
  | 'grace'
  /** 이틀 이상 걸렀다 — ★절반으로 줄지만 «0 이 되지는 않는다» */
  | 'halved'
  /** ★저장된 날짜가 «미래»다(기기 시계 되돌림). 지급하지 않는다 */
  | 'future';

export interface AttendanceDecision {
  /** 오늘 지급할 수 있는가 */
  claimable: boolean;
  /** 지급 «후»의 streak. claimable=false 면 «현재» streak 그대로다 */
  streak: number;
  /** 지급액(USD). claimable=false 면 0 */
  amount: number;
  reason: AttendanceReason;
}

/**
 * ★★출석 판정 — 이 함수 «하나»가 규칙의 전부다.
 *
 * ── ⛔「끊기면 1일차로 리셋」을 하지 않는 이유 ────────────────────────────
 *   완전 리셋은 ★「영영 안 오게」 만든다. 7일 하던 사람이 하루 놓쳤다고 1일차가 되면
 *   되돌아올 이유가 사라진다. 이 앱 코호트는 ★10대가 64% 라 그 효과가 특히 크다.
 *   ⇒ 하루 유예 → «유지» · 이틀 이상 → «절반»(0 이 아니다).
 *     7일 하던 사람이 사흘 쉬면 4일차부터 재개하고, 사흘만 더 오면 다시 7일차 보상이다.
 *   ★이건 「보상을 두 번 준다」가 아니라 ★«streak 계산 규칙»이다. 지급은 여전히 하루 1회다.
 *
 * ── ⛔멱등 ──────────────────────────────────────────────────────────────
 *   멱등 키는 ★`dateKey` «그 자체»다. 같은 날 몇 번을 불러도 `already` 가 나온다.
 *   ⇒ 공유 리워드와 달리 «완전» 멱등이다 — 출석은 외부 이벤트가 아니라
 *     우리가 «날짜»를 보고 스스로 판정하기 때문이다(토스가 주는 이벤트 id 가 필요 없다).
 *
 * ── ⚠️기기 시계 ────────────────────────────────────────────────────────
 *   시계를 «앞으로» 돌리는 것은 서버가 없어 막을 수 없다(허용 판단).
 *   ⛔그러나 «뒤로» 돌린 상태는 막는다 — 저장된 날짜가 오늘보다 미래면 `future` 로 거절한다.
 *     안 막으면 「미래 날짜 저장 → 시계 되돌리기」로 streak 을 조작할 여지가 생긴다.
 *
 * @param prevStreak 저장된 streak(없으면 0)
 * @param lastKey    마지막 지급일 키(없으면 null)
 * @param todayKey   오늘 키 — ★반드시 `daykey.kstDateKey()` 로 만든 값
 */
export function decideAttendance(
  prevStreak: number,
  lastKey: string | null | undefined,
  todayKey: string
): AttendanceDecision {
  const prev = Number.isFinite(prevStreak)
    ? Math.min(ATTENDANCE_STREAK_SANE_MAX, Math.max(0, Math.floor(prevStreak)))
    : 0;

  /* 기록이 없거나 «못 읽는» 값이면 처음으로 친다 — ⛔게임이 멈추는 것보다 낫다 */
  if (!lastKey || !isDateKey(lastKey)) {
    return { claimable: true, streak: 1, amount: rewardForStreak(1), reason: 'first' };
  }
  const diff = dayDiff(lastKey, todayKey);
  if (!Number.isFinite(diff)) {
    return { claimable: true, streak: 1, amount: rewardForStreak(1), reason: 'first' };
  }
  if (diff === 0) {
    return { claimable: false, streak: prev, amount: 0, reason: 'already' };
  }
  if (diff < 0) {
    /* 저장된 날짜가 «미래» — 시계를 되돌린 상태다. 지급하지 않는다 */
    return { claimable: false, streak: prev, amount: 0, reason: 'future' };
  }

  let streak: number;
  let reason: AttendanceReason;
  if (diff === 1) {
    streak = prev + 1;
    reason = 'continued';
  } else if (diff === 2) {
    /* ★하루 유예 — 끊기지 않고 «유지»한다(증가는 없다) */
    streak = Math.max(1, prev);
    reason = 'grace';
  } else {
    /* ★이틀 이상 — 절반으로 줄지만 «1 밑으로는» 안 간다 */
    streak = Math.max(1, Math.floor(prev / 2));
    reason = 'halved';
  }
  streak = Math.min(ATTENDANCE_STREAK_SANE_MAX, streak);
  return { claimable: true, streak, amount: rewardForStreak(streak), reason };
}
