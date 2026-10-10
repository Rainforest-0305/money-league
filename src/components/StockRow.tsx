import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PriceText, TickerTile } from './Primitives';
import { Sparkline } from './Charts';
import { metaOf, useQuote } from '../store/hooks';
import { money, shares, signedMoney, signedPct } from '../lib/format';

/**
 * 종목 리스트 행 — 목업 02/03 의 .row 구조 그대로.
 * useQuote 로 해당 종목만 구독하므로 100행 리스트에서 행 하나만 리렌더된다.
 * ★[성능 2026-08-30] memo — 부모(종목 화면·홈)가 매 틱 리렌더돼도 props 가 같으면 행은 «자기 시세 구독»으로만 다시 그린다.
 *   ⛔props 에 매 렌더 새 객체(inline 화살표·새 배열)를 주면 memo 가 무력화된다 — 홈 보유 행의 sparkline 은 틱마다 새 값이라 그 행만 예외.
 */
export const StockRow = memo(function StockRow({
  ticker,
  rankNo,
  holdingQty,
  holdingAvg,
  sparkline,
  onClick,
  compactTile,
}: {
  ticker: string;
  rankNo?: number;
  holdingQty?: number;
  holdingAvg?: number;
  sparkline?: number[];
  onClick?: () => void;
  compactTile?: boolean;
}) {
  const { t, i18n } = useTranslation('common');
  const nav = useNavigate();
  const q = useQuote(ticker);
  const m = metaOf(ticker);
  const ko = i18n.language !== 'en';
  const price = q?.price ?? m.initialPrice;
  const changePct = q?.totalChangePct ?? 0;
  const up = changePct >= 0;

  const owned = holdingQty !== undefined && holdingQty > 0;
  const value = owned ? holdingQty * price : 0;
  const pnl = owned && holdingAvg ? (price - holdingAvg) * holdingQty : 0;
  const pnlPct = owned && holdingAvg ? (price / holdingAvg - 1) * 100 : 0;

  return (
    <button
      type="button"
      className="row"
      onClick={onClick ?? (() => nav(`/stock/${ticker}`))}
      aria-label={`${ko ? m.nameKo : m.nameEn} ${money(price)}`}
    >
      {rankNo !== undefined && <span className="num row__rank">{rankNo}</span>}
      <TickerTile meta={m} size={compactTile ? 'md' : 'lg'} />
      <span style={{ minWidth: 0 }}>
        <span className="row__nm" style={{ display: 'block' }}>
          {ko ? m.nameKo : m.nameEn}
        </span>
        <span className="row__sub num" style={{ display: 'block' }}>
          {owned
            ? `${t('shares', { count: Math.round(holdingQty!) })} · ${t('avgCost', { v: money(holdingAvg ?? 0) })}`
            : `${m.ticker} · ${ko ? m.sectorKo : m.sectorEn}`}
        </span>
      </span>
      {sparkline && sparkline.length > 1 && (
        <span style={{ marginLeft: 'auto' }}>
          <Sparkline data={sparkline} up={up} />
        </span>
      )}
      <span className="row__rt" style={sparkline ? { marginLeft: 12 } : undefined}>
        <span className="row__p" style={{ display: 'block' }}>
          <PriceText value={owned ? value : price} render={(v) => money(v)} />
        </span>
        <span className={`row__c num ${owned ? (pnl >= 0 ? 'up' : 'down') : up ? 'up' : 'down'}`} style={{ display: 'block' }}>
          {owned ? `${signedMoney(pnl)} (${signedPct(pnlPct)})` : signedPct(changePct)}
        </span>
      </span>
    </button>
  );
});

export function sharesLabel(qty: number): string {
  return shares(qty);
}
