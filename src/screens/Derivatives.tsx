/**
 * 파생 허브 — 사양서 §1.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★구조 (2026-08-20 파생 4종 개편)
 *   상단 칩 4개 [선물 · 옵션 · 선도 · 스왑] → 선택된 상품의 «내 포지션» → 하단 고정 CTA.
 *   ⛔새 탭을 만들지 않는다. 하단 탭 5개는 그대로고, 4종은 이 탭 «안»에서 칩으로 나뉜다.
 *
 * ★★왜 「레버리지·옵션 2장 카드」에서 바뀌었나
 *   예전 화면은 진입 카드 2장이 «주인공»이었다. 상품이 4개가 되면 그 방식은
 *   카드 4장이 되어 화면의 절반을 진입 버튼이 먹는다 — 진입은 «내비게이션»이지
 *   주인공이 아니다. 칩 한 줄로 접고 포지션에 자리를 돌려준다.
 *
 * ★★「무기한 레버리지」의 자리 (President 승인 2026-08-21)
 *   사양서의 칩 4개에는 «무기한 레버리지»가 없는데, ★기존 유저가 그 포지션을 갖고 있고
 *   지금 주문 경로도 무기한이다. ⇒ ★「선물」 칩이 그 자리를 겸한다.
 *   만기 선택에 [무기한 · 3 · 5 · 7 게임일]을 두고 ★기본값이 «무기한»이라 현행 동작이 보존된다.
 *   「무기한 선물」은 실제로 통용되는 상품명이라 이름도 거짓이 아니다.
 *
 * ★성능: ⛔backdrop-filter · blur 0건. 포지션 수가 적어 가상 스크롤은 쓰지 않는다
 *   (VirtualList 는 100행 랭킹·종목용이다. 몇 장짜리 목록에 씌우면 오히려 비용이다).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Primitives';
import { TickerPicker } from '../components/TickerPicker';
import { PositionCard } from '../components/PositionCard';
import { LiquidationGauge } from '../components/Charts';
import { metaOf, useStore, useTick } from '../store/hooks';
import { money, pct, signedMoney } from '../lib/format';
import { DANGER_BUFFER_PCT, FORWARD_EXPIRY_GAME_DAYS } from '../lib/constants';

/** 칩 순서 = 사양서 §1. 기본 선택 = 선물 */
const PRODUCTS = ['futures', 'option', 'forward', 'swap'] as const;
type Product = (typeof PRODUCTS)[number];

const CHIP_KEY: Record<Product, string> = {
  futures: 'chip.futures',
  option: 'chip.options',
  forward: 'chip.forward',
  swap: 'chip.swap',
};
const DESC_KEY: Record<Product, string> = {
  futures: 'desc.futures',
  option: 'desc.options',
  forward: 'desc.forward',
  swap: 'desc.swap',
};
/** 「새 계약」이 가는 곳 — 종목을 고른 «뒤» 이 경로로 간다 */
const ROUTE: Record<Product, (tk: string) => string> = {
  futures: (tk) => `/leverage/${tk}`,
  option: (tk) => `/option/${tk}`,
  forward: (tk) => `/contract/forward/${tk}`,
  swap: (tk) => `/contract/swap/${tk}`,
};

export function Derivatives() {
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('derivatives');
  const ko = i18n.language !== 'en';
  const [product, setProduct] = useState<Product>('futures');
  const [picking, setPicking] = useState(false);

  /* ★[-33] 「내 포지션」을 열어 본 것 = 포트폴리오 확인 → 홈 출석 시트의 「추가 지급(광고)」 버튼이 열린다 */
  useEffect(() => {
    s.notePortfolioView();
  }, [s]);

  const p = s.portfolio;
  const forwards = s.forwards;
  const swaps = s.swaps;

  /* 선물(=레버리지) — 위험 포지션이 위로 (ui_spec 3.4) */
  const levs = useMemo(() => {
    const rows = (p?.leverage ?? []).map((lv) => ({
      lv,
      buffer: (Math.abs(lv.price - lv.liquidationPrice) / lv.price) * 100,
    }));
    rows.sort((a, b) => a.buffer - b.buffer);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, s.tickVersion]);

  const counts: Record<Product, number> = {
    futures: p?.leverage.length ?? 0,
    option: p?.options.length ?? 0,
    forward: forwards.length,
    swap: swaps.length,
  };
  const total = counts.futures + counts.option + counts.forward + counts.swap;

  const lockedMargin =
    (p?.leverage ?? []).reduce((a, b) => a + b.margin, 0) +
    (p?.options ?? []).reduce((a, b) => a + (b.margin ?? 0), 0) +
    forwards.reduce((a, b) => a + b.margin, 0) +
    swaps.reduce((a, b) => a + b.margin, 0);
  const funding = (p?.leverage ?? []).reduce((a, b) => a + b.funding, 0);
  const openPnl =
    (p?.leverage ?? []).reduce((a, b) => a + b.pnl, 0) +
    (p?.options ?? []).reduce((a, b) => a + b.pnl, 0) +
    forwards.reduce((a, b) => a + b.pnl, 0) +
    swaps.reduce((a, b) => a + b.pnl, 0);

  return (
    <div className="screen">
      <div className="appbar">
        <span className="appbar__big">{t('title')}</span>
        {/*
          ★[제거 2026-08-22, 어포던스 감사] 「정보」 아이콘 버튼.
            ★실측: 44x44 짜리 «눌려 보이는» 버튼인데 ★onClick 이 없었다.
              President 지적(「누르면 자세히 보일 거 같은데 아무 기능 없는 것들」)의 정확한 사례다.
            ⇒ 동작을 붙이지 «않고» 어포던스를 뺀 이유: 이 화면은 칩을 고르면
              그 상품 설명(`DESC_KEY[product]`)이 «바로 아래»에 이미 나온다.
              그리고 수수료·규칙 전문은 설정의 「게임 규칙과 수수료」 시트에 있다.
              열 만한 «새로운» 내용이 없는데 시트를 하나 더 만드는 것은 화면만 늘린다.
        */}
      </div>

      {/* ★칩 4개 — 기존 pillrow 스타일 재사용. 한 줄에 들어간다(가로 스크롤 불필요) */}
      <div className="pillrow pillrow--even" style={{ paddingBottom: 'var(--space-sm)' }}>
        {PRODUCTS.map((k) => (
          <button
            key={k}
            className={`pill pill--ink ${product === k ? 'pill--on' : ''}`}
            onClick={() => setProduct(k)}
            aria-pressed={product === k}
          >
            {t(CHIP_KEY[k])}
            {counts[k] > 0 && <span className="pill__n num">{counts[k]}</span>}
          </button>
        ))}
      </div>

      <div className="scroll">
        {/* ★상품 한 줄 설명 — 「이게 뭔데?」에 대한 답. ⛔모달로 막지 않는다 */}
        <p className="hint" style={{ padding: '0 20px 4px' }}>
          {t(DESC_KEY[product], { n: FORWARD_EXPIRY_GAME_DAYS })}
        </p>

        <div className="sec">
          {counts[product] === 0 ? (
            /*
             * ★[수정 2026-08-21, 실렌더로 발견] 빈 상태 카드 «안»의 버튼을 지웠다.
             *   ★「새 계약」 버튼이 ★두 개였다 — 카드 안에 하나, 하단 고정 CTA 에 하나.
             *     ★같은 글자·같은 동작이 위아래로 겹쳐 있으면 유저는 «다른 것»인 줄 안다.
             *   ★하단 CTA 는 «포지션이 있든 없든» 항상 있으므로(사양서 §1), 유도는 그쪽이 맡는다.
             *     빈 상태 카드는 «상태를 알리는» 역할만 남긴다.
             */
            /*
             * ★[2026-08-21] 빈 상태가 «한 줄뿐»이었다 — 큰 상자에 「아직 계약이 없어요」 하나.
             *   impeccable product 레지스터: 「빈 상태는 «인터페이스를 가르쳐야» 한다.
             *   'nothing here' 는 빈 상태가 아니다」.
             * ⛔여기에 버튼을 «다시» 넣지 않는다 — 하단 고정 CTA 와 같은 글자·같은 동작이
             *   위아래로 겹치는 사고가 이미 한 번 있었다(U-2 ⛔7). 대신 ★그 버튼을 «가리킨다».
             */
            <div className="card card--pad" style={{ textAlign: 'center', padding: '26px 22px' }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{t('empty.title')}</div>
              <p style={{ marginTop: 7, fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 }}>
                {t('empty.sub', { cta: t('empty.cta'), name: t(CHIP_KEY[product]) })}
              </p>
            </div>
          ) : null}

          {/* ── 선물 (= 레버리지 + 만기) ─────────────────────────────── */}
          {product === 'futures' &&
            levs.map(({ lv, buffer }) => {
              const danger = buffer <= DANGER_BUFFER_PCT;
              const m = metaOf(lv.ticker);
              return (
                <PositionCard
                  key={lv.id}
                  product="futures"
                  ticker={lv.ticker}
                  title={ko ? m.nameKo : m.nameEn}
                  remainGameDays={s.levRemainGameDays(lv.id)}
                  pnl={lv.pnl}
                  pnlPct={(lv.pnl / lv.margin) * 100}
                  sub={
                    <>
                      <span style={{ color: lv.side === 'long' ? 'var(--up-ink)' : 'var(--down-ink)', fontWeight: 800 }}>
                        {lv.side === 'long' ? t('longX', { x: lv.leverage }) : t('shortX', { x: lv.leverage })}
                      </span>{' '}
                      · {t('marginLabel', { v: money(lv.margin, 0) })}
                    </>
                  }
                  danger={
                    danger ? (
                      <div style={{ background: 'var(--warn-weak)', padding: '9px 16px', display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ display: 'grid', placeItems: 'center', color: 'var(--warn-ink)' }} aria-hidden>
                          {Icon.warn}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--warn-ink)' }}>
                          {t('dangerBanner', { p: pct(buffer, 1) })}
                        </span>
                      </div>
                    ) : undefined
                  }
                  actions={
                    <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
                      <button className="btn btn--sub" style={{ flex: 1, padding: 12, fontSize: 15 }} onClick={() => nav(`/leverage/${lv.ticker}`)}>
                        {t('addMargin')}
                      </button>
                      <button
                        className="btn btn--ink"
                        style={{ flex: 1, padding: 12, fontSize: 15 }}
                        onClick={async () => {
                          await s.closeLeverage(lv.id);
                          s.pushToast(t('closed') as string);
                        }}
                      >
                        {t('closeNow')}
                      </button>
                    </div>
                  }
                >
                  <div style={{ marginTop: 14 }}>
                    <LiquidationGauge bufferPct={buffer} side={lv.side} />
                    <div className="gauge__legend">
                      <span>
                        {t('forcedLiq', { v: '' })}
                        <b className="num" style={{ color: lv.side === 'long' ? 'var(--down-ink)' : 'var(--up-ink)' }}>
                          {money(lv.liquidationPrice)}
                        </b>
                      </span>
                      <span style={{ color: 'var(--t1)', fontWeight: 700 }}>
                        {lv.side === 'long' ? t('dropToLiq', { p: pct(buffer, 1) }) : t('riseToLiq', { p: pct(buffer, 1) })}
                      </span>
                    </div>
                  </div>
                </PositionCard>
              );
            })}

          {/* ── 옵션 (매수 · ★매도) ─────────────────────────────────── */}
          {product === 'option' &&
            (p?.options ?? []).map((op) => {
              const m = metaOf(op.ticker);
              const isSell = op.side === 'sell';
              return (
                <PositionCard
                  key={op.id}
                  product="option"
                  ticker={op.ticker}
                  title={t('strikeAt', { name: ko ? m.nameKo : m.nameEn, v: money(op.strike, 0) })}
                  remainGameDays={op.remainGameDays}
                  pnl={op.pnl}
                  sub={
                    <>
                      <span className="badge badge--purple">{t(op.kind === 'call' ? 'call' : 'put')}</span>{' '}
                      {isSell && <span className="badge badge--weak">{t('pos.sideSell')}</span>}{' '}
                      {t('optMeta', { n: op.contracts, d: op.remainGameDays.toFixed(1) })}
                    </>
                  }
                  actions={
                    <button
                      className="btn btn--sub"
                      style={{ marginTop: 12, padding: 12, fontSize: 15 }}
                      onClick={async () => {
                        await s.closeOptionPosition(op.id);
                        s.pushToast(t('optionSold') as string);
                      }}
                    >
                      {/*
                        ★★매도에서는 「지금 팔면 {{v}}」가 «뜻이 반대»다 — 파는 게 아니라 «되사는» 것이다.
                          그리고 값도 다르다: 매수는 받는 돈(mark), 매도는 «내는 돈»(mark).
                        ⇒ 문구를 갈라 쓴다. ⛔같은 문장을 재사용하면 조용히 거짓말이 된다.
                      */}
                      {isSell ? t('pos.buyback', { v: money(op.mark) }) : t('sellNow', { v: money(op.mark) })}
                    </button>
                  }
                />
              );
            })}

          {/* ── 선도 ────────────────────────────────────────────────── */}
          {product === 'forward' &&
            forwards.map((f) => {
              const m = metaOf(f.ticker);
              return (
                <PositionCard
                  key={f.id}
                  product="forward"
                  ticker={f.ticker}
                  title={ko ? m.nameKo : m.nameEn}
                  remainGameDays={f.remainGameDays}
                  pnl={f.pnl}
                  pnlPct={f.margin > 0 ? (f.pnl / f.margin) * 100 : undefined}
                  sub={
                    <>
                      <span style={{ color: f.side === 'long' ? 'var(--up-ink)' : 'var(--down-ink)', fontWeight: 800 }}>
                        {t(f.side === 'long' ? 'form.long' : 'form.short')}
                      </span>{' '}
                      · {f.counterpartyName}
                    </>
                  }
                  rows={[
                    { k: t('form.size'), v: money(f.notional, 0) },
                    { k: t('marginLabel', { v: '' }), v: money(f.margin, 0) },
                    { k: t('entryLabel', { v: '' }), v: money(f.contractPrice) },
                  ]}
                  actions={
                    <button
                      className="btn btn--sub"
                      style={{ marginTop: 12, padding: 12, fontSize: 15 }}
                      onClick={async () => {
                        await s.closeForward(f.id);
                        s.pushToast(t('closed') as string);
                      }}
                    >
                      {t('pos.close')}
                    </button>
                  }
                />
              );
            })}

          {/* ── 스왑 ────────────────────────────────────────────────── */}
          {product === 'swap' &&
            swaps.map((w) => {
              const a = metaOf(w.tickerA);
              return (
                <PositionCard
                  key={w.id}
                  product="swap"
                  ticker={w.tickerA}
                  tickerB={w.tickerB}
                  title={a.ticker}
                  remainGameDays={w.remainGameDays}
                  pnl={w.pnl}
                  pnlPct={w.margin > 0 ? (w.pnl / w.margin) * 100 : undefined}
                  sub={
                    <>
                      <span style={{ fontWeight: 800 }}>
                        {t(w.side === 'a' ? 'form.swapSideA' : 'form.swapSideB', {
                          a: a.ticker,
                          b: metaOf(w.tickerB).ticker,
                        })}
                      </span>{' '}
                      · {w.counterpartyName}
                    </>
                  }
                  rows={[
                    { k: t('form.size'), v: money(w.notional, 0) },
                    { k: t('marginLabel', { v: '' }), v: money(w.margin, 0) },
                  ]}
                  actions={
                    <button
                      className="btn btn--sub"
                      style={{ marginTop: 12, padding: 12, fontSize: 15 }}
                      onClick={async () => {
                        await s.closeSwap(w.id);
                        s.pushToast(t('closed') as string);
                      }}
                    >
                      {t('pos.close')}
                    </button>
                  }
                />
              );
            })}

          {/* 전체 요약 — 상품을 가리지 않고 «내 파생 전체»다 */}
          {total > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '14px 16px',
                marginTop: 12,
              }}
            >
              <Summary label={t('lockedMargin')} value={money(lockedMargin)} />
              <Summary label={t('fundingToday')} value={money(funding)} />
              <Summary label={t('unrealized')} value={signedMoney(openPnl)} tone={openPnl >= 0 ? 'up' : 'down'} />
            </div>
          )}
        </div>

        {/*
          ★[2026-09-10 · -33 제거] 파생 탭 배너(B2 · NATIVE_IMAGE · 08-20 발급 · 08-21 게이트 해제).
            콘솔 실측 09-02~08: 노출 797회 → 241원(하루 34.4원) · 09-08 eCPM 213원. 「내 포지션」 아래 «첫 화면 안»(top≈315)에
            들어와 노출만 많고 값이 없던 지면이라 President 승인 전략(2-2)에 따라 «호출을 뺐다».
            ⛔콘솔 지면 삭제는 Partner 게이트. ⛔되살릴 때는 lib/ads.ts AD_IDS·AD_RESERVED_H 도 같이(둘 다 지웠다).
            ★래퍼 없이 배너만 있었으므로 유령 여백도 함께 사라진다(verify_journal ⑩ 이 「.adslot 0 · 여백 0」을 센다).
        */}
        <div className="scroll-pad" />
      </div>

      {/* ★하단 고정 CTA — 선택된 «칩의 상품»을 그대로 들고 간다 */}
      <div className="derivcta">
        <button className="btn btn--primary" onClick={() => setPicking(true)}>
          {t('empty.cta')}
        </button>
      </div>

      {picking && (
        <TickerPicker
          title={t(CHIP_KEY[product])}
          onPick={(tk) => {
            setPicking(false);
            nav(ROUTE[product](tk));
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{label}</div>
      <div className={`num ${tone ?? ''}`} style={{ fontSize: 15, fontWeight: 800 }}>
        {value}
      </div>
    </div>
  );
}
