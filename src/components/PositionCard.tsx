/**
 * 파생 포지션 카드 — 4상품 «한 종류»의 카드 (사양서 §5).
 *
 * ★상품 구분은 ★«좌상단 배지 하나»로 한다. 카드 모양을 상품마다 바꾸지 않는다 —
 *   화면마다 다른 문법이 제품 UI 에서 가장 흔한 실패다(impeccable product 레지스터).
 * ★필드: [상품 배지] 종목 · 방향 · 규모 · 평가손익(색) · 남은 만기(게임일) · 청산가(해당 상품만)
 * ★스왑은 종목이 둘이라 「A vs B」로 한 줄에 쓴다.
 *
 * ⛔blur · backdrop-filter · 큰 그림자 0건.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TickerTile } from './Primitives';
import { metaOf } from '../store/hooks';
import { signedMoney, signedPct } from '../lib/format';

export type ProductKind = 'futures' | 'option' | 'forward' | 'swap';

const BADGE: Record<ProductKind, { cls: string; key: string }> = {
  futures: { cls: 'pbadge--fut', key: 'pos.badgeFutures' },
  option: { cls: 'pbadge--opt', key: 'pos.badgeOption' },
  forward: { cls: 'pbadge--fwd', key: 'pos.badgeForward' },
  swap: { cls: 'pbadge--swp', key: 'pos.badgeSwap' },
};

export function PositionCard({
  product,
  ticker,
  tickerB,
  title,
  sub,
  pnl,
  pnlPct,
  remainGameDays,
  rows,
  children,
  actions,
  danger,
}: {
  product: ProductKind;
  ticker: string;
  /** 스왑 전용 — 두 번째 종목 */
  tickerB?: string;
  title: string;
  sub?: ReactNode;
  pnl: number;
  pnlPct?: number;
  /**
   * 남은 만기(게임일). ★null = «무기한».
   * ⛔undefined 를 빈칸으로 두지 않는다 — 「만기가 언제인지 모르겠는 포지션」이 되어버린다.
   */
  remainGameDays: number | null;
  /** 하단 라벨-값 쌍 */
  rows?: { k: string; v: ReactNode }[];
  children?: ReactNode;
  actions?: ReactNode;
  danger?: ReactNode;
}) {
  const { t } = useTranslation('derivatives');
  const b = BADGE[product];
  const m = metaOf(ticker);

  return (
    <div className="card" style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
      {danger}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <TickerTile meta={m} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span className={`pbadge ${b.cls}`}>{t(b.key)}</span>
              {/* ★남은 만기는 «항상» 한 조각을 그린다 — 없으면 「무기한」 */}
              <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>
                {remainGameDays === null
                  ? t('pos.perpetual')
                  : t('pos.remain', { n: remainGameDays.toFixed(1) })}
              </span>
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 800,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {tickerB ? t('pos.swapPair', { a: title, b: metaOf(tickerB).ticker }) : title}
            </div>
            {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', flex: '0 0 auto' }}>
            <div className={`num ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 16, fontWeight: 800 }}>
              {signedMoney(pnl)}
            </div>
            {pnlPct !== undefined && Number.isFinite(pnlPct) && (
              <div className={`num ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 12, fontWeight: 700 }}>
                {signedPct(pnlPct, 1)}
              </div>
            )}
          </div>
        </div>

        {children}

        {rows && rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12, color: 'var(--t3)', gap: 8 }}>
            {rows.map((r) => (
              <span key={r.k} style={{ minWidth: 0 }}>
                {r.k} <b className="num" style={{ color: 'var(--t1)' }}>{r.v}</b>
              </span>
            ))}
          </div>
        )}

        {actions}
      </div>
    </div>
  );
}
