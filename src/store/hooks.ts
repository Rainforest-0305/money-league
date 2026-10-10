import { useSyncExternalStore } from 'react';
import { store } from './store';
import { TICKERS } from '../data/tickers.generated';
import type { TickerMeta } from '../data/types';
import type { Quote } from '../lib/types';

/** 스토어 전역 버전 구독 — 포트폴리오/랭킹/연결상태 변화에 반응 */
export function useStore(): typeof store {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}

/** 매 틱 리렌더가 필요한 화면 전용 */
export function useTick(): number {
  return useSyncExternalStore(store.subscribeTick, store.getTickVersion, store.getTickVersion);
}

/** 종목 1개의 시세만 구독 — 100행 리스트에서 행 단위로만 리렌더된다 */
export function useQuote(ticker: string): Quote | undefined {
  useSyncExternalStore(store.subscribePrice(ticker), store.priceVersionOf(ticker), store.priceVersionOf(ticker));
  return store.getQuote(ticker);
}

const BY_TICKER = new Map(TICKERS.map((t) => [t.ticker, t]));

export function metaOf(ticker: string): TickerMeta {
  return (
    BY_TICKER.get(ticker) ?? {
      rank: 999,
      ticker,
      legalName: ticker,
      nameKo: ticker,
      nameEn: ticker,
      sectorKo: '-',
      sectorEn: '-',
      tierKo: '-',
      tierEn: '-',
      initials: ticker.slice(0, 2),
      color: '#4E5968',
      initialPrice: 0,
      mu: 0.1,
      sigma: 0.3,
    }
  );
}

/** 현재 언어에 맞는 종목명 / 섹터 / 티어 */
export function useNames(lang: string) {
  const ko = lang !== 'en';
  return {
    name: (m: TickerMeta) => (ko ? m.nameKo : m.nameEn),
    sector: (m: TickerMeta) => (ko ? m.sectorKo : m.sectorEn),
    tier: (m: TickerMeta) => (ko ? m.tierKo : m.tierEn),
  };
}
