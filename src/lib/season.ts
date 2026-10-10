/**
 * 시즌 — «마감 시각»과 «연장/새 시즌» 규칙. 순수 함수 + 저장 키 하나.
 *
 * ★★[2026-08-29 President 지시] 「시즌 마감 때에는 자동으로 새 시즌 시작하지 말고 시즌을 연장할지
 *   선택하도록 해. 시즌 연장하려면 리워드형 광고 나오게 만들어.」
 *
 * ★[실측 · 수정 전] 「이번 주가 끝나면 모두 $10,000으로 초기화돼요」라고 «적혀만» 있었고
 *   실제로 초기화하는 코드는 «어디에도 없었다»(Leaderboard.season() 은 표시 전용 카운트다운).
 *   ⇒ 이번에 마감이 «실제로» 생긴다. 마감 시각에 도달하면 거래가 잠기고 화면이 «선택»을 묻는다:
 *     (a) 광고 보고 1주 연장 — 자산·포지션·순위 «그대로», 마감 +7일
 *     (b) 새 시즌 시작       — 내 계좌를 $10,000 으로 초기화(시장·봇은 그대로)
 *   자동으로 아무것도 하지 않는다. 앱을 안 열었던 유저는 다음 접속 때 이 화면을 본다.
 *
 * ── 저장 ────────────────────────────────────────────────────────────────
 *   ★새 키 `ml.season` — 세이브 블롭(ml.game)과 «다른 키»다. SAVE_VERSION·저장키 이름 무변경.
 *   키가 «없으면» 지금까지 화면이 세던 «다음 주 경계»(KST 기준 7일 주기)를 마감으로 삼는다 —
 *   라이브 유저가 보던 카운트다운이 «그대로» 이어진다(숫자가 튀지 않는다).
 *
 * ── 경계 ────────────────────────────────────────────────────────────────
 *   옛 Leaderboard.season() 과 «같은 식»이다: KST 일수를 7로 나눈 다음 경계.
 *   ⛔요일을 바꾸지 마라 — 바꾸면 라이브 유저의 남은 시간이 갑자기 늘거나 준다.
 */
import { nowMs } from './daykey';

export const SEASON_KEY = 'ml.season';
/** 연장 1회 = 7일 */
export const SEASON_EXTEND_MS = 7 * 24 * 60 * 60 * 1000;

const KST = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export interface SeasonState {
  /** 마감 시각(ms, epoch) */
  endAt: number;
  /** 몇 번째 시즌인가(1부터). 표시용이 아니라 «기록»이다 — 화면에 번호를 박지 않는다 */
  n: number;
  /** 이번 시즌에 연장한 횟수(제한 없음 — President 미지정) */
  extended: number;
}

/** 옛 화면이 세던 «다음 7일 경계»(KST). 키가 없을 때의 기본 마감 */
export function nextWeekBoundary(now: number = nowMs()): number {
  const days = Math.floor((now + KST) / DAY);
  return (Math.floor(days / 7) + 1) * 7 * DAY - KST;
}

export function freshSeason(now: number = nowMs()): SeasonState {
  return { endAt: nextWeekBoundary(now), n: 1, extended: 0 };
}

/** 마감 도달? */
export function seasonEnded(s: SeasonState, now: number = nowMs()): boolean {
  return now >= s.endAt;
}

/** 남은 시간(ms, 0 이상) */
export function seasonRemainMs(s: SeasonState, now: number = nowMs()): number {
  return Math.max(0, s.endAt - now);
}

/** 연장 — «지금»을 기준으로 +7일. 마감이 한참 지난 채 돌아온 유저도 온전한 7일을 받는다 */
export function extendSeason(s: SeasonState, now: number = nowMs()): SeasonState {
  return { endAt: Math.max(now, s.endAt) + SEASON_EXTEND_MS, n: s.n, extended: s.extended + 1 };
}

/** 새 시즌 — 다음 7일 경계까지. 번호 +1, 연장 횟수 0 */
export function newSeason(s: SeasonState, now: number = nowMs()): SeasonState {
  return { endAt: nextWeekBoundary(now), n: s.n + 1, extended: 0 };
}

/**
 * 저장값 복원 — ⛔손상값 방어. 유저 기기에 그냥 남아 있는 값이라 무엇이든 들어올 수 있다.
 * 못 읽으면 «기본 마감»으로 떨어진다(게임이 멈추는 것보다 낫다).
 */
export function saneSeason(v: unknown, now: number = nowMs()): SeasonState {
  const d = freshSeason(now);
  if (!v || typeof v !== 'object') return d;
  const o = v as Partial<SeasonState>;
  const endAt = typeof o.endAt === 'number' && Number.isFinite(o.endAt) && o.endAt > 0 ? o.endAt : d.endAt;
  const n = typeof o.n === 'number' && Number.isFinite(o.n) && o.n >= 1 ? Math.floor(o.n) : 1;
  const extended = typeof o.extended === 'number' && Number.isFinite(o.extended) && o.extended >= 0 ? Math.floor(o.extended) : 0;
  return { endAt, n, extended };
}
