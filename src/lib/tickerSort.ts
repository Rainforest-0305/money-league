/**
 * 종목 «기본 정렬»과 «검색 순위» — ★한 벌. 종목 탭과 파생 종목 피커가 «같은 함수»를 쓴다.
 *
 * ★★[2026-08-29 President 지시] 「파생상품 구매 화면에서 주요 자산(금, S&P500)이 개별 종목에
 *   밀리는 거 해결해. 기초자산 구매랑 정렬 순서를 맞춰줘」
 *
 * ★[실측 · 수정 전] `TickerPicker.tsx` 는 `totalChangePct` 내림차순 «단독» 정렬이라
 *   SPX 가 ~548번째, GOLD·WTI 도 등락률 운에 따라 아무 데나 갔다. 종목 탭(`Stocks.tsx`)은
 *   `MAJOR_FIRST` 로 주요 자산을 «먼저» 두는데 두 화면이 «다른 규칙»이었다.
 *   ⇒ 규칙을 «여기 한 곳»으로 빼고 두 화면이 import 한다. 다시 갈릴 수 없다.
 *
 * ★검색: 「S&P」를 치면 SPGI(S&P 글로벌)가 SPX(S&P 500) 위에 올 수 있었다(등락률 운).
 *   ⇒ «정확 일치 → 주요 자산 → 앞부분 일치 → 포함» 순으로 «매치 품질»을 먼저 보고,
 *     동점은 기본 정렬(주요 자산 → 순위)로 고정한다. 결과가 «시세와 무관하게» 같다.
 * ⛔엔진 상수(LIQUIDITY_DEPTH·depthFactorForRank)와 무관하다 — 표시 순서만 정한다.
 */
import type { TickerMeta } from '../data/types';

/**
 * 기본 정렬에서 «맨 앞»으로 끌어올릴 자산군.
 * ⛔티커를 하드코딩하지 «마라» — 종목이 늘면 명단이 썩는다. 자산군으로 판정한다.
 */
export const MAJOR_FIRST: ReadonlySet<string> = new Set(['index', 'commodity', 'crypto']);

export function isMajor(m: Pick<TickerMeta, 'assetClass'>): boolean {
  return MAJOR_FIRST.has(m.assetClass ?? 'stock');
}

/** 기본 순서 — 주요 자산(지수·원자재·가상자산) 먼저, 그 안에서는 원래 순위(rank) */
export function compareDefault(a: Pick<TickerMeta, 'assetClass' | 'rank'>, b: Pick<TickerMeta, 'assetClass' | 'rank'>): number {
  const am = isMajor(a) ? 0 : 1;
  const bm = isMajor(b) ? 0 : 1;
  return am !== bm ? am - bm : a.rank - b.rank;
}

/**
 * 검색 «매치 품질» (낮을수록 위). 매치가 아니면 Infinity.
 *   0 티커 정확 일치        (「SPX」)
 *   1 이름 정확 일치        (「S&P 500」)
 *   2 티커가 검색어로 시작   (「SP」 → SPX·SPGI)
 *   3 이름이 검색어로 시작   (「S&P」 → S&P 500 · S&P 글로벌)
 *   4 그 밖의 포함
 * ★같은 품질 안에서는 «주요 자산»이 먼저다 — 「S&P」에서 SPX(지수)가 SPGI(개별 종목)보다 위.
 */
export function matchRank(m: Pick<TickerMeta, 'ticker' | 'nameKo' | 'nameEn'>, needle: string): number {
  const tk = m.ticker.toLowerCase();
  const ko = m.nameKo.toLowerCase();
  const en = m.nameEn.toLowerCase();
  if (tk === needle) return 0;
  if (ko === needle || en === needle) return 1;
  if (tk.startsWith(needle)) return 2;
  if (ko.startsWith(needle) || en.startsWith(needle)) return 3;
  if (tk.includes(needle) || ko.includes(needle) || en.includes(needle)) return 4;
  return Number.POSITIVE_INFINITY;
}

/** 정규화된 검색어. 빈 문자열이면 검색이 «없다» */
export function normalizeNeedle(q: string): string {
  return q.trim().toLowerCase();
}

/**
 * 목록을 «기본 순서»로, 검색어가 있으면 «매치 품질 → 기본 순서»로 정렬해 돌려준다.
 * ★입력을 바꾸지 않는다(새 배열).
 */
export function sortTickers<T extends Pick<TickerMeta, 'ticker' | 'nameKo' | 'nameEn' | 'assetClass' | 'rank'>>(
  list: readonly T[],
  needle = ''
): T[] {
  if (!needle) return [...list].sort(compareDefault);
  const scored = list
    .map((m) => ({ m, r: matchRank(m, needle) }))
    .filter((x) => Number.isFinite(x.r));
  scored.sort((x, y) => (x.r !== y.r ? x.r - y.r : compareDefault(x.m, y.m)));
  return scored.map((x) => x.m);
}
