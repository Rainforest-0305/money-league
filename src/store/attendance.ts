/**
 * 출석 원장 — ★세이브 블롭(`ml.game`) «밖»의 독립 키다.
 *
 * ── ⛔왜 세이브 블롭에 넣지 않는가 (CTO 판정 2026-08-22) ─────────────────
 *   ★**「출석은 손상돼도 게임이 죽으면 안 되는 데이터다.」**
 *   별도 키면 파싱이 깨져도 ★«출석 0일»로 떨어질 뿐이지만,
 *   세이브 블롭 안이면 ★«블롭 전체»가 위험해진다 — 잔고·보유·포지션이 같이 날아간다.
 *   ⇒ 선례가 넷이다: `ml.firstSeen` · `ml.traderwatch` · `ml.quotesession` · `ml.journal`.
 *     전부 같은 이유로 «밖»에 있다.
 *   ⇒ 그리고 별도 키는 `SAVE_VERSION` 과 무관하다 ⇒ ★마이그레이션이 «0회»다.
 *
 * ── ⛔여기서 «규칙»을 계산하지 마라 ─────────────────────────────────────
 *   streak 판정·금액은 전부 `lib/attendance.ts` 의 «순수 함수»가 한다.
 *   이 파일은 ★읽고 쓰기만 한다. 규칙이 두 군데 있으면 언젠가 갈린다.
 *
 * ── ⛔지급도 여기서 하지 마라 ───────────────────────────────────────────
 *   현금은 ★엔진의 «단일 통로»를 지나야 한다(현금과 수익률 분모 `bonusSeed` 를 같이 올린다).
 *   ⇒ `store.grantAttendance()` 가 엔진을 부르고, 이 원장은 «그 결과»만 기록한다.
 */
import { ATTENDANCE_STREAK_SANE_MAX } from '../lib/attendance';
import { isDateKey } from '../lib/daykey';
import { lsRemove, lsSet } from '../toss/storage';

const LS_ATTENDANCE = 'ml.attendance';

export interface AttendanceState {
  /** 연속 출석 일수(1 이상). 한 번도 안 받았으면 0 */
  streak: number;
  /** 마지막으로 «지급받은» 날의 KST 날짜키. 없으면 null */
  lastClaimedDate: string | null;
  /** 광고 2배를 «받은» 날의 KST 날짜키. 하루 1회 제한의 근거 */
  lastDoubledDate: string | null;
  /** 지금까지 출석으로 받은 누적 금액(USD). 화면·일지 대조용 */
  totalUsd: number;
}

function empty(): AttendanceState {
  return { streak: 0, lastClaimedDate: null, lastDoubledDate: null, totalUsd: 0 };
}

/**
 * 저장본 한 건을 «믿지 않고» 검증한다 (`journal.sane` · `persistence.num` 과 같은 패턴).
 * ⛔한 필드가 깨졌다고 «전부» 버리지 않는다 — 살릴 수 있는 것은 살린다.
 *   그래야 「스트릭만 깨졌는데 누적까지 0 이 되는」 손실이 안 생긴다.
 */
function sane(x: unknown): AttendanceState {
  if (!x || typeof x !== 'object') return empty();
  const o = x as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const key = (v: unknown): string | null => (typeof v === 'string' && isDateKey(v) ? v : null);
  return {
    /* ★음수·NaN·Infinity 가 «구조적으로» 못 들어온다. 미친 큰 수도 자른다 */
    streak: Math.min(ATTENDANCE_STREAK_SANE_MAX, Math.max(0, Math.floor(num(o.streak)))),
    lastClaimedDate: key(o.lastClaimedDate),
    lastDoubledDate: key(o.lastDoubledDate),
    totalUsd: Math.max(0, num(o.totalUsd)),
  };
}

export class AttendanceLedger {
  state: AttendanceState = empty();

  constructor(private readonly onChange: () => void) {
    try {
      const raw = localStorage.getItem(LS_ATTENDANCE);
      if (raw) this.state = sane(JSON.parse(raw));
    } catch {
      /*
       * ★손상값이면 «출석 0일»로 시작한다. ⛔게임이 죽는 것보다 낫다 —
       *   그게 이 데이터를 세이브 블롭 밖에 둔 이유 그 자체다.
       */
      this.state = empty();
    }
  }

  /**
   * 지급 성사분을 기록한다. ⛔여기서 «지급 여부»를 판단하지 않는다 —
   * 호출부가 `decideAttendance` 로 판단하고, 엔진이 실제로 준 금액만 넘긴다.
   *
   * @param streak 지급 «후»의 streak
   * @param dateKey 오늘 KST 날짜키
   * @param amount  ★엔진이 «실제로» 지급한 금액(요청액이 아니다)
   */
  recordClaim(streak: number, dateKey: string, amount: number): void {
    this.state = {
      ...this.state,
      streak: Math.min(ATTENDANCE_STREAK_SANE_MAX, Math.max(1, Math.floor(streak))),
      lastClaimedDate: dateKey,
      totalUsd: this.state.totalUsd + Math.max(0, amount),
    };
    this.flush();
  }

  /** 광고 2배를 받은 날을 기록한다(하루 1회 제한의 근거) */
  recordDouble(dateKey: string, amount: number): void {
    this.state = {
      ...this.state,
      lastDoubledDate: dateKey,
      totalUsd: this.state.totalUsd + Math.max(0, amount),
    };
    this.flush();
  }

  /** 오늘 광고 2배를 이미 받았는가 */
  doubledToday(dateKey: string): boolean {
    return this.state.lastDoubledDate === dateKey;
  }

  /** 계정 초기화(로그아웃) — 일지와 같은 취급이다 */
  clear(): void {
    this.state = empty();
    lsRemove(LS_ATTENDANCE);
    this.onChange();
  }

  /**
   * ★즉시 쓴다. ⛔일지처럼 «모아 쓰지» 않는다 —
   *   출석은 하루 «한 번»이라 모을 이유가 없고, 지급 직후 앱이 죽으면
   *   「돈은 들어갔는데 오늘 받은 기록이 없는」 상태가 된다(= 내일 또 받는다).
   */
  private flush(): void {
    try {
      lsSet(LS_ATTENDANCE, JSON.stringify(this.state));
    } catch {
      /* 용량 초과 등 — 출석 때문에 게임이 멈추면 안 된다 */
    }
    this.onChange();
  }
}
