/**
 * 포트폴리오 «복사» 시트 — 방식 선택 → 미리보기 → 실행 → 결과. (President 지시 2026-08-30)
 *
 * ★계산은 `lib/copyPortfolio.ts`(순수) · 실행은 `store.copyPortfolio()`(기존 주문 경로 묶음).
 *   이 파일은 «보여주고 묻는» 일만 한다. ⛔여기서 수량·비중을 다시 계산하지 마라.
 * ★미리보기의 (A) 청산액은 «예상»이다 — 실행은 청산 «뒤» 실잔고로 계획을 다시 세운다. 그래서 문구가 「예상」이다.
 * ★토스 문법: 바텀시트 + 라디오 옵션(.opt) + 주행동 1개(.btn--primary). 표는 «행»(.cprow)으로 — 표 격자를 그리지 않는다.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Sheet, TickerTile } from './Primitives';
import { metaOf, useStore } from '../store/hooks';
import type { CopyResult, CopyStep } from '../store/store';
import { money, pct } from '../lib/format';
import { estimateLiquidation, LEV_MIN_MARGIN, planCopy, type CopyLevLine, type CopyMode, type CopySpotLine } from '../lib/copyPortfolio';
import { previewLiquidationPrice } from '../screens/LeverageOrder';
import type { PublicPortfolio } from '../lib/types';

type Phase = 'choose' | 'preview' | 'running' | 'result';

export function CopyPortfolioSheet({ via, pub, onClose }: { via: string; pub: PublicPortfolio; onClose: () => void }) {
  const s = useStore();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('rank');
  const ko = i18n.language !== 'en';
  const [mode, setMode] = useState<CopyMode>('cash');
  const [phase, setPhase] = useState<Phase>('choose');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [progress, setProgress] = useState(0);

  const p = s.portfolio;
  const cash = p?.cash ?? 0;
  const q = useMemo(
    () => ({
      priceOf: (x: string) => s.priceOf(x),
      priceImpactFrac: (x: string, n: number) => s.priceImpactFrac(x, n),
    }),
    [s]
  );
  const liq = useMemo(
    () =>
      estimateLiquidation(
        {
          holdings: p?.holdings ?? [],
          leverage: p?.leverage ?? [],
          options: p?.options ?? [],
          forwards: s.forwards,
          swaps: s.swaps,
        },
        q
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p, s.tickVersion]
  );
  const budget = mode === 'all' ? cash + liq.spot + liq.deriv : cash;
  const plan = useMemo(() => planCopy(pub, budget, q), [pub, budget, q]);
  const hasLev = pub.leverage.length > 0;

  /* 실행 중엔 «스크림 탭·ESC 로 닫히지 않게» — 주문이 절반만 나간 채 화면이 사라지면 안 된다 */
  const close = phase === 'running' ? () => {} : onClose;

  useEffect(() => {
    if (phase !== 'running') return;
    let alive = true;
    (async () => {
      try {
        const r = await s.copyPortfolio({ via, mode, pub });
        if (!alive) return;
        setResult(r);
        setPhase('result');
      } catch (e) {
        if (!alive) return;
        const code = (e as { code?: string }).code ?? 'GENERIC';
        setErr(t([`common:err.${code}`, 'common:err.GENERIC']) as string);
        setPhase('preview');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* 실행 중 진행 표시 — 일지 길이가 늘어나는 만큼 센다(주문 1건 = 일지 1줄) */
  const journalLen = s.journal.entries.length;
  const [startLen, setStartLen] = useState(0);
  useEffect(() => {
    if (phase === 'running') setStartLen(journalLen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  useEffect(() => {
    if (phase === 'running') setProgress(Math.max(0, journalLen - startLen));
  }, [journalLen, phase, startLen]);

  const planned = plan.spot.filter((l) => !l.skip).length + plan.lev.filter((l) => !l.skip).length;
  const totalSteps = planned + (mode === 'all' ? liq.count : 0);
  const nameOf = (ticker: string) => {
    const m = metaOf(ticker);
    return ko ? m.nameKo : m.nameEn;
  };

  /* ── ① 방식 ───────────────────────────────────────────────────────── */
  if (phase === 'choose') {
    return (
      <Sheet onClose={close} labelledBy="copy-title">
        <h3 id="copy-title" className="cpsheet__h">
          {t('copyTitle')}
        </h3>
        <p className="hint" style={{ marginTop: 4 }}>
          {t('copySub', { name: via })}
        </p>
        <div style={{ marginTop: 16 }}>
          <button type="button" className={`opt${mode === 'all' ? ' is-on' : ''}`} onClick={() => setMode('all')} aria-pressed={mode === 'all'}>
            <span style={{ minWidth: 0 }}>
              <span className="opt__t">{t('copyModeAll')}</span>
              <span className="opt__s num">{t('copyModeAllSub', { c: money(cash, 0), l: money(liq.spot + liq.deriv, 0) })}</span>
            </span>
            <span className={`radio${mode === 'all' ? ' is-on' : ''}`} aria-hidden />
          </button>
          <button type="button" className={`opt${mode === 'cash' ? ' is-on' : ''}`} onClick={() => setMode('cash')} aria-pressed={mode === 'cash'}>
            <span style={{ minWidth: 0 }}>
              <span className="opt__t">{t('copyModeCash')}</span>
              <span className="opt__s num">{t('copyModeCashSub', { c: money(cash, 0) })}</span>
            </span>
            <span className={`radio${mode === 'cash' ? ' is-on' : ''}`} aria-hidden />
          </button>
        </div>
        {hasLev && <p className="hint cpsheet__risk">{t('copyLevRisk')}</p>}
        <p className="hint" style={{ marginTop: 6 }}>
          {t('delayNote')}
        </p>
        <button type="button" className="btn btn--primary" style={{ marginTop: 16 }} disabled={budget < 1} onClick={() => setPhase('preview')}>
          {t('copyPreviewCta')}
        </button>
      </Sheet>
    );
  }

  /* ── ③ 실행 중 ────────────────────────────────────────────────────── */
  if (phase === 'running') {
    return (
      <Sheet onClose={close} labelledBy="copy-title">
        <h3 id="copy-title" className="cpsheet__h">
          {t('copyRunning', { done: Math.min(progress, totalSteps), total: totalSteps })}
        </h3>
        <div className="cpsheet__bar" aria-hidden>
          <div style={{ transform: `scaleX(${totalSteps > 0 ? Math.min(1, progress / totalSteps) : 0})` }} />
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          {t('copyRunningSub')}
        </p>
      </Sheet>
    );
  }

  /* ── ④ 결과 ───────────────────────────────────────────────────────── */
  if (phase === 'result' && result) {
    const failedAt = result.steps.find((x) => x.ok === false);
    const failCode = failedAt?.code ?? 'GENERIC';
    return (
      <Sheet onClose={close} labelledBy="copy-title">
        <h3 id="copy-title" className="cpsheet__h">
          {result.stopped ? t('copyStoppedTitle') : t('copyDoneTitle')}
        </h3>
        <p className="hint" style={{ marginTop: 4 }}>
          {result.stopped
            ? t('copyStoppedSub', { n: result.done, why: t([`common:err.${failCode}`, 'common:err.GENERIC']) })
            : t('copyDoneSub', { n: result.done, name: via })}
        </p>
        <div className="card card--list cplist" style={{ marginTop: 14 }}>
          {result.steps.map((st, i) => (
            <StepRow key={i} st={st} name={nameOf(st.ticker)} t={t} />
          ))}
        </div>
        <button type="button" className="btn btn--primary" style={{ marginTop: 16 }} onClick={() => nav('/home')}>
          {t('copyGoHome')}
        </button>
        <button type="button" className="btn btn--ghost" style={{ marginTop: 4 }} onClick={onClose}>
          {t('common:close')}
        </button>
      </Sheet>
    );
  }

  /* ── ② 미리보기 ───────────────────────────────────────────────────── */
  const closing = mode === 'all' ? liq : null;
  return (
    <Sheet onClose={close} labelledBy="copy-title">
      <h3 id="copy-title" className="cpsheet__h">
        {t('copyPreviewTitle')}
      </h3>
      <p className="hint" style={{ marginTop: 4 }}>
        {t('copyPreviewSub', { name: via, c: money(plan.cash, 0) })}
      </p>

      {closing && closing.count > 0 && (
        <div className="cpsec">
          <div className="cpsec__h">{t('copySecClose')}</div>
          <div className="card card--list cplist">
            {(p?.holdings ?? []).map((h) => (
              <div key={`h-${h.ticker}`} className="cprow">
                <TickerTile meta={metaOf(h.ticker)} size="sm" />
                <span className="cprow__m">
                  <span className="cprow__nm">{nameOf(h.ticker)}</span>
                  <span className="cprow__sub">{t('common:shares', { count: Math.round(h.qty) })}</span>
                </span>
                <span className="cprow__r num">{money(h.value, 0)}</span>
              </div>
            ))}
            {(p?.leverage ?? []).map((lv) => (
              <div key={`l-${lv.id}`} className="cprow">
                <TickerTile meta={metaOf(lv.ticker)} size="sm" />
                <span className="cprow__m">
                  <span className="cprow__nm">{nameOf(lv.ticker)}</span>
                  <span className="cprow__sub">
                    <span className={`badge ${lv.side === 'long' ? 'badge--up' : 'badge--down'}`}>
                      {t(lv.side === 'long' ? 'derivatives:longX' : 'derivatives:shortX', { x: lv.leverage })}
                    </span>
                  </span>
                </span>
                <span className="cprow__r num">{money(Math.max(0, lv.equity), 0)}</span>
              </div>
            ))}
            {(p?.options.length ?? 0) + s.forwards.length + s.swaps.length > 0 && (
              <div className="cprow">
                <span className="cprow__m">
                  <span className="cprow__nm">{t('copyOtherDeriv', { n: (p?.options.length ?? 0) + s.forwards.length + s.swaps.length })}</span>
                </span>
              </div>
            )}
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            {t('copyCloseN', { n: closing.count, v: money(closing.spot + closing.deriv, 0) })}
          </p>
        </div>
      )}

      {plan.empty ? (
        <div className="card card--pad" style={{ marginTop: 14, fontSize: 13, color: 'var(--t3)' }}>
          {t('copyEmpty')}
        </div>
      ) : (
        <>
          {plan.spot.length > 0 && (
            <div className="cpsec">
              <div className="cpsec__h">{t('copySecSpot')}</div>
              <div className="card card--list cplist">
                {plan.spot.map((l) => (
                  <SpotRow key={l.ticker} l={l} name={nameOf(l.ticker)} t={t} />
                ))}
              </div>
            </div>
          )}
          {plan.lev.length > 0 && (
            <div className="cpsec">
              <div className="cpsec__h">{t('copySecLev')}</div>
              <div className="card card--list cplist">
                {plan.lev.map((l, i) => (
                  <LevRow key={`${l.ticker}-${i}`} l={l} name={nameOf(l.ticker)} basis={s.maintenanceBasis} t={t} />
                ))}
              </div>
              <p className="hint cpsheet__risk">{t('copyLevRisk')}</p>
            </div>
          )}
          <div className="cptotal" data-cash={Math.round(plan.cash)} data-spend={Math.round(plan.spend)} data-left={Math.round(plan.leftover)}>
            <div className="kv">
              <span className="kv__k">{t('copyTotal')}</span>
              <span className="kv__v num">{money(plan.spend, 0)}</span>
            </div>
            <div className="kv" style={{ paddingTop: 0 }}>
              <span className="kv__k">{t('copyLeft')}</span>
              <span className="kv__v num">{money(plan.leftover, 0)}</span>
            </div>
          </div>
        </>
      )}

      {err && (
        <p className="hint" style={{ marginTop: 10, color: 'var(--down-ink)', fontWeight: 700 }} role="alert">
          {err}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary"
        style={{ marginTop: 14 }}
        disabled={plan.empty || planned === 0}
        onClick={() => {
          setErr(null);
          setPhase('running');
        }}
      >
        {t('copyConfirm')}
      </button>
      <button type="button" className="btn btn--ghost" style={{ marginTop: 4 }} onClick={() => setPhase('choose')}>
        {t('common:back')}
      </button>
    </Sheet>
  );
}

type TFn = (k: string | string[], o?: Record<string, unknown>) => string;

function skipText(t: TFn, skip: CopySpotLine['skip'], lev: boolean): string {
  if (skip === 'noPrice') return t('copySkipPrice');
  if (skip === 'badLeverage') return t('copySkipLev');
  return lev ? t('copySkipSmallLev', { v: money(LEV_MIN_MARGIN, 0) }) : t('copySkipSmall');
}

function SpotRow({ l, name, t }: { l: CopySpotLine; name: string; t: TFn }) {
  return (
    <div className={`cprow${l.skip ? ' is-skip' : ''}`} data-kind="spot" data-ticker={l.ticker} data-qty={l.qty} data-cost={Math.round(l.cost)} data-weight={l.weight.toFixed(6)} data-skip={l.skip ?? ''}>
      <TickerTile meta={metaOf(l.ticker)} size="sm" />
      <span className="cprow__m">
        <span className="cprow__nm">{name}</span>
        <span className="cprow__sub num">
          {t('copyWeight', { p: pct(l.weight * 100, 1) })}
        </span>
      </span>
      <span className="cprow__r">
        {l.skip ? (
          <span className="cprow__skip">{skipText(t, l.skip, false)}</span>
        ) : (
          <>
            <span className="cprow__v num">{money(l.cost, 0)}</span>
            <span className="cprow__q num">{t('common:shares', { count: l.qty })}</span>
          </>
        )}
      </span>
    </div>
  );
}

function LevRow({ l, name, basis, t }: { l: CopyLevLine; name: string; basis: 'initial_margin' | 'entry_notional'; t: TFn }) {
  const liqPx = l.skip ? 0 : previewLiquidationPrice(l.price, l.margin, l.leverage, l.side, basis);
  return (
    <div className={`cprow${l.skip ? ' is-skip' : ''}`} data-kind="lev" data-ticker={l.ticker} data-side={l.side} data-lev={l.leverage} data-margin={l.margin} data-cost={Math.round(l.cost)} data-weight={l.weight.toFixed(6)} data-skip={l.skip ?? ''}>
      <TickerTile meta={metaOf(l.ticker)} size="sm" />
      <span className="cprow__m">
        <span className="cprow__nm">{name}</span>
        <span className="cprow__sub">
          <span className={`badge ${l.side === 'long' ? 'badge--up' : 'badge--down'}`}>
            {t(l.side === 'long' ? 'derivatives:longX' : 'derivatives:shortX', { x: l.leverage })}
          </span>
          <span className="num">{t('copyWeight', { p: pct(l.weight * 100, 1) })}</span>
        </span>
      </span>
      <span className="cprow__r">
        {l.skip ? (
          <span className="cprow__skip">{skipText(t, l.skip, true)}</span>
        ) : (
          <>
            <span className="cprow__v num">{t('derivatives:marginLabel', { v: money(l.margin, 0) })}</span>
            <span className="cprow__q num">{t('derivatives:liqLabel', { v: money(liqPx) })}</span>
          </>
        )}
      </span>
    </div>
  );
}

function StepRow({ st, name, t }: { st: CopyStep; name: string; t: TFn }) {
  const code = st.code ?? 'GENERIC';
  const label =
    st.phase === 'close' ? t('copyStepClose') : st.kind === 'lev' ? t('copyStepOpen') : t('copyStepBuy');
  const detail =
    st.kind === 'lev'
      ? `${t(st.side === 'long' ? 'derivatives:longX' : 'derivatives:shortX', { x: st.leverage ?? 0 })}${st.margin ? ` · ${money(st.margin, 0)}` : ''}`
      : st.qty
        ? t('common:shares', { count: Math.round(st.qty) })
        : '';
  return (
    <div className={`cprow${st.ok ? '' : ' is-fail'}`} data-step={st.phase} data-kind={st.kind} data-ticker={st.ticker} data-ok={st.ok ? '1' : '0'} data-code={st.code ?? ''}>
      <span className={`cprow__ic${st.ok ? ' is-ok' : ''}`} aria-hidden>
        {st.ok ? Icon.checkSm(12) : Icon.close}
      </span>
      <span className="cprow__m">
        <span className="cprow__nm">{name}</span>
        <span className="cprow__sub num">{`${label}${detail ? ` · ${detail}` : ''}`}</span>
      </span>
      <span className="cprow__r">
        {st.ok ? null : <span className="cprow__skip">{t([`common:err.${code}`, 'common:err.GENERIC'])}</span>}
      </span>
    </div>
  );
}
