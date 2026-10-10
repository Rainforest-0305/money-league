/**
 * 종목 선택 시트 — 파생 허브 · 선도/스왑 주문폼 «공용».
 *
 * ★Derivatives.tsx 안에 있던 것을 «그대로» 꺼냈다.
 *   ⛔복사해서 두 벌로 만들지 않는다 — 화면마다 다른 종목 선택기가 되면
 *   그게 제품 UI 에서 가장 흔한 실패다(같은 일에 다른 문법).
 * ★스왑은 종목을 «둘» 고르므로 `exclude` 로 이미 고른 쪽을 빼 준다 —
 *   같은 종목 두 개는 엔진이 SAME_TICKER 로 거절한다. 고를 수 «없게» 만드는 게 먼저다.
 *
 * ── ★[2026-08-21] 8종목 → «전 종목(100)» 개방 ─────────────────────────
 * President: 「파생상품 지원되는 종목이 좀 적어 보이는데 전 종목으로 늘려줘」.
 * ★원인은 엔진이 아니라 ★이 파일의 `.slice(0, 8)` 한 줄이었다 [실측]:
 *   · `world.openLeverage` · `openForward` · `openSwap` · `writeOption` 어디에도
 *     종목 화이트리스트가 «없다». 100종목 전부가 원래 가능했다.
 *   · 즉 「지원 종목이 적다」는 ★화면이 만든 사실이었다.
 *
 * ★열면서 같이 챙긴 3가지 — 안 챙기면 «여는 것»이 곧 회귀다:
 *   ① ⛔100행을 한 번에 DOM 에 올리지 않는다 → VirtualList(종목 탭과 «같은 부품»).
 *   ② ⛔100개를 스크롤로만 찾게 두지 않는다 → 검색. ★Stocks 탭과 «같은 문법»
 *      (같은 자리·같은 아이콘·같은 지우기 버튼)이라 새로 배울 게 없다.
 *   ③ ★정렬은 여전히 «등락률 내림차순»이고 관심종목이 맨 위다.
 *      근거: 8개일 때는 「오늘 많이 움직인 것」이 곧 목록 전부였지만, 100개에서는
 *      «상단이 곧 추천»이 된다. 파생은 «움직임»에 거는 상품이라 등락률이
 *      가나다순·시총순보다 이 화면의 목적에 맞다. 못 찾는 문제는 ②가 푼다.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, Sheet, TickerTile } from './Primitives';
import { VirtualList } from './VirtualList';
import { metaOf, useStore } from '../store/hooks';
import { money } from '../lib/format';
import { TICKERS } from '../data/tickers.generated';
import { normalizeNeedle, sortTickers } from '../lib/tickerSort';

/** 시트 안 목록의 높이 — ★시트가 화면을 다 먹지 않게 «고정»한다(max-height 92%) */
const LIST_H = 340;
/** 행 높이(px). ★VirtualList 좌표 계산과 같은 값이어야 한다 */
const ROW_H = 64;

export function TickerPicker({
  onPick,
  onClose,
  title,
  exclude,
}: {
  onPick: (t: string) => void;
  onClose: () => void;
  title: string;
  /** 이 종목은 목록에서 뺀다(스왑의 반대편) */
  exclude?: string;
}) {
  const s = useStore();
  const { t, i18n } = useTranslation('derivatives');
  const ko = i18n.language !== 'en';
  const [q, setQ] = useState('');

  /*
   * ★★[2026-08-29 President 지시] 「주요 자산(금, S&P500)이 개별 종목에 밀리는 거 해결해.
   *   기초자산 구매랑 정렬 순서를 맞춰줘」
   * ★[실측 · 수정 전] 등락률 내림차순 «단독»이라 SPX 가 ~548번째였다(같은 시드 피커 상위:
   *   ALLE·SLB·RBA·LEN·GFS…). 위 ③ 주석의 「등락률이 이 화면 목적에 맞다」는 판단은
   *   President 지시로 «기각»됐다 — 종목 탭과 «같은 규칙»(주요 자산 → 순위)을 쓴다.
   * ★규칙은 `lib/tickerSort.ts` 한 벌이다. ⛔여기서 다시 정렬식을 쓰지 마라(두 벌 = 갈린다).
   * ★관심종목을 «맨 위에 두던» 것도 뺐다 — 「순서를 맞춰라」가 지시다. 관심종목은 검색으로 닿는다.
   * ★exclude(스왑의 반대편)는 «검색보다 먼저» 건다 — 검색으로도 반대편 종목이 나오면 안 된다.
   * ★시세(getQuote)에 의존하지 않으므로 틱마다 다시 정렬되지 않는다 — 손가락 밑에서 행이 안 바뀐다.
   */
  const list = useMemo(() => {
    const pool = exclude ? TICKERS.filter((m) => m.ticker !== exclude) : TICKERS;
    return sortTickers(pool, normalizeNeedle(q)).map((m) => m.ticker);
  }, [exclude, q]);

  return (
    <Sheet onClose={onClose} labelledBy="picker-title">
      <h2 id="picker-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 12 }}>
        {title}
      </h2>

      {/* 검색 — ★Stocks 탭과 «같은» 생김새·같은 동작 */}
      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 13px',
          color: 'var(--t3)',
          marginBottom: 10,
        }}
      >
        <span style={{ display: 'grid', placeItems: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('common:search')}
          aria-label={t('common:search')}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--t1)' }}
        />
        {q && (
          <button className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => setQ('')} aria-label={t('common:close')}>
            {Icon.close}
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div style={{ height: LIST_H, display: 'grid', placeItems: 'center', color: 'var(--t3)', fontSize: 14 }}>
          {t('common:empty')}
        </div>
      ) : (
        <VirtualList
          className="card card--list"
          style={{ height: LIST_H, overflowY: 'auto' }}
          items={list}
          itemHeight={ROW_H}
          height={LIST_H}
          renderItem={(tk, i) => {
            const m = metaOf(tk);
            return (
              <div key={tk}>
                {i > 0 && <div className="divider divider--inset" />}
                <button className="row" style={{ height: ROW_H }} onClick={() => onPick(tk)}>
                  <TickerTile meta={m} size="lg" />
                  <span style={{ minWidth: 0 }}>
                    <span className="row__nm" style={{ display: 'block' }}>
                      {ko ? m.nameKo : m.nameEn}
                    </span>
                    <span className="row__sub" style={{ display: 'block' }}>
                      {m.ticker} · {ko ? m.sectorKo : m.sectorEn}
                    </span>
                  </span>
                  <span className="row__rt num row__p">{money(s.priceOf(tk))}</span>
                </button>
              </div>
            );
          }}
        />
      )}
    </Sheet>
  );
}
