import type { RankEntry } from './types';

/**
 * «내 순위» 두 축 파생 — Partner 판정(2026-08-05).
 *
 * 배경: 플레이어 시드는 $10,000 인데 봇 시드는 노이즈 2만 / 모멘텀·역추세 8만 /
 * 파생 15만 / 웨일 200만이다(engine/bots.ts BOT_PROFILES — 경제 파라미터라 불가침).
 * 그래서 **자산평가액 기준 시작 순위는 211/211 로 고정**된다. 이건 사실이므로 숨기지 않는다.
 * 다만 의미 있는 축은 수익률이다 — 웨일이 200만으로 1.07배 만든 것보다
 * 1만으로 1.3배 만든 쪽이 잘한 것이다. 그래서 자기 순위만 두 축으로 표시한다.
 *
 * 리더보드 목록 자체는 «탑 100 자산평가액 대시보드»(요건 #15) 그대로
 * 자산 내림차순을 유지한다. 이 함수는 목록 정렬에 관여하지 않는다.
 *
 * 계산:
 *  - 자산 순위 : World.computeLeaderboard 가 자산 내림차순으로 매긴 rank 를 그대로 쓴다.
 *  - 수익률 순위: 나보다 수익률이 높은 계정 수 + 1 (동률은 같은 순위 = standard competition ranking).
 *    RankEntry.pnlPct 의 분모는 **계정별 시드**(acc.seedCash * (1+topupCount)) 다.
 *    전 계정 SEED_CASH(1만) 고정이던 것을 고친 값이며(world.ts:549), 되돌리면
 *    시드 200만 웨일이 손실 중에도 "+19,900%" 로 찍힌다.
 *
 * `ranks` 는 상위 N 컷이 아니라 **전량(211행)** 이어야 정확하다.
 * store.ranks = world.leaderboard(false) = computeLeaderboard(Infinity) 라 전량이다.
 */
export interface MyRankAxes {
  entry: RankEntry;
  /** 자산평가액 내림차순 순위 */
  equityRank: number;
  /** 시드 대비 수익률 내림차순 순위 */
  returnRank: number;
  /** 모집단 크기(봇 210 + 나 1) */
  total: number;
}

export function myRankAxes(ranks: RankEntry[], accountId: string | null): MyRankAxes | null {
  if (!accountId) return null;
  const entry = ranks.find((r) => r.accountId === accountId);
  if (!entry) return null;
  let better = 0;
  for (const r of ranks) if (r.pnlPct > entry.pnlPct) better++;
  return { entry, equityRank: entry.rank, returnRank: better + 1, total: ranks.length };
}

/**
 * 표시용 시드 역산 — RankEntry 만 가지고 «시드 대비 손익금액»을 복원한다.
 * `equity - SEED_CASH` 로 계산하면 시드 200만 웨일이 "+$2,149,276 (+8.0%)" 처럼
 * 금액과 퍼센트가 서로 모순되는 값이 나온다(실측 확인).
 * pnlPct 의 분모가 계정별 시드이므로 equity / (1 + pnlPct/100) 로 정확히 되돌아온다
 * (웨일 실측: 2,159,276 / 1.0796 = 2,000,000.0 = seedCash).
 */
export function pnlFromEntry(entry: RankEntry): number {
  const ratio = 1 + entry.pnlPct / 100;
  if (!(ratio > 1e-9) || !Number.isFinite(ratio)) return 0; // -100%(전액 소실) 등 퇴화 케이스
  return entry.equity - entry.equity / ratio;
}
