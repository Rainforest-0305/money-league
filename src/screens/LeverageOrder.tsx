/*
 * ⛔★유동성 «깊이» 상수를 여기서 들여오지 «마라» (2026-08-23 실사고).
 *   화면이 `LIQUIDITY_DEPTH_BASE_USD * depthFactorForRank(rank)` 로 깊이를 «직접» 셌는데,
 *   엔진은 지수에 `INDEX_DEPTH_MULT(4)` 를 쓴다(data.ts:61). 화면은 assetClass 를 «모른다».
 *   ⇒ SPX·NDX 에서 ★16배 갈렸다. 상한이 1/16 이라 «에러 없이» 주문이 막혔다.
 *   ⇒ 깊이는 «엔진만» 안다. 화면은 store.maxOrderNotional(ticker) 로 «결과»만 받는다.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Segment, Slider, TickerTile } from '../components/Primitives';
import { metaOf, useQuote, useStore, useTick } from '../store/hooks';
import { gameDaysToRealMinutes, money, pct, signedMoney, signedPct } from '../lib/format';
import {
  ALLOWED_LEVERAGE,
  BP,
  FEE_LEVERAGE_BP,
  FUNDING_BP_PER_GAME_DAY,
  MAINTENANCE_MARGIN_RATIO,
  OPTION_EXPIRY_CHOICES,
} from '../lib/constants';

/*
 * [제거 2026-08-19] 고배율 확인 게이트(HIGH_LEVERAGE_MIN · lowerTier · confirmLev 시트 ·
 * ackedLev · warnHighLev 인라인 경고).
 *
 * President 지시 원문: 「파생상품 구매에서 막 뭐 손실 위험 알려준다, 이런 거 다 없애줘」.
 * 「티어당 1회뿐이라 괜찮다」는 더 이상 근거가 아니다 — 구매를 망설이게 하는
 * 인게임 넛지를 «전부» 걷어내는 것이 지시다. 되살리지 마라.
 *
 * ★단 「이 게임은 가상이다 / 실제 돈이 아니다」류 «성격 고지»는 성격이 다르다.
 *   그건 검수·법적 근거라 settings.disclaimer·온보딩에 그대로 남아 있다.
 *   청산가 블록·손익 시뮬레이터도 «경고»가 아니라 «게임 정보»라 남긴다.
 */

/**
 * 레버리지 주문 — 목업 04-B.
 * 청산가를 독립 블록으로 승격하고 절대가격 + 거리 % 를 항상 병기한다(ui_spec 0.3).
 */
export function LeverageOrder() {
  const { ticker = 'NVDA' } = useParams();
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('derivatives');
  const ko = i18n.language !== 'en';
  const m = metaOf(ticker);
  const q = useQuote(ticker);

  const [side, setSide] = useState<'long' | 'short'>('long');
  /** 기본 선택 5배 — 목업 :255 의 `class="on"` 칩. 구 기본값 3배는 티어에서 빠졌다. */
  const [lev, setLev] = useState<number>(5);
  const [margin, setMargin] = useState(1000);
  /*
   * ★★만기 (2026-08-20 파생 4종). null = «무기한» = ★기본값이자 «기존 동작».
   *
   * ★왜 기본이 무기한인가 (President 승인 2026-08-21):
   *   이 화면은 원래 «무기한 레버리지» 주문 화면이었고, ★라이브 유저가 그 포지션을 갖고 있다.
   *   사양서의 칩 4개에는 「무기한」 자리가 없지만, ★기능을 «없애면» 기존 포지션이 갈 곳이 없다.
   *   ⇒ 「선물」 칩이 두 경우를 겸한다. 기본값을 무기한으로 두어 ★현행 동작이 그대로 보존된다.
   *   ⇒ 「무기한 선물」은 실제로 통용되는 상품명이라 이름도 거짓이 아니다.
   */
  const [expiry, setExpiry] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const price = q?.price ?? m.initialPrice;
  const cash = s.portfolio?.cash ?? 0;
  /*
   * ★증거금 상한 — «현금 하나»다. 개시에 나가는 돈은 증거금 + 수수료(명목 × FEE_LEVERAGE_BP)
   *   이므로  증거금 × (1 + 수수료율 × 배율) ≤ 현금  을 풀어 쓴다.
   *
   * ⛔★[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
   *   여기 있던 `notionalCap / lev`(= `s.maxOrderNotional(ticker) / lev`) 항을 «제거»했다.
   *   엔진 쪽 짝(`world.openLeverage` 의 `assertOrderSize`)도 같이 없앴다 —
   *   ⛔한쪽만 풀면 화면과 엔진이 조용히 갈린다(2026-08-23 깊이 16배 사고와 같은 형태).
   * ★상한이 없어도 «공짜»는 아니다: 진입가가 `fillPrice` 를 거치므로 명목이 깊이에 가까워질수록
   *   자기 임팩트를 «체결가에 먼저» 문다(롱은 비싸게·숏은 싸게). 그게 이제 유일한 제동이다.
   */
  const maxMargin = Math.max(100, Math.floor(cash / (1 + FEE_LEVERAGE_BP * BP * lev)));
  const mg = Math.max(100, Math.min(maxMargin, margin));

  const notional = mg * lev;
  const qty = notional / price;
  const dir = side === 'long' ? 1 : -1;
  const mm =
    s.maintenanceBasis === 'entry_notional'
      ? MAINTENANCE_MARGIN_RATIO * notional
      : MAINTENANCE_MARGIN_RATIO * mg;
  const allowedLoss = Math.max(0, mg - mm);
  const liqPrice = Math.max(0, price - (allowedLoss / qty) * dir);
  const liqDistPct = (liqPrice / price - 1) * 100;
  const openFee = notional * FEE_LEVERAGE_BP * BP;
  const fundingPerDay = notional * FUNDING_BP_PER_GAME_DAY * BP;

  /**
   * 배율별 청산 이동폭(%) — 증거금 액수와 무관하다.
   * initial_margin 기준: (1 - 0.2) / x → 2배 40% · 5배 16% · 10배 8% · 20배 4%
   * (ARCHITECTURE 2-A · 목업 :498). 위 liqDistPct 와 같은 식이라 화면 숫자와 항상 일치한다.
   */
  const liqMovePct = (x: number): number =>
    s.maintenanceBasis === 'entry_notional'
      ? Math.max(0, ((1 - MAINTENANCE_MARGIN_RATIO * x) / x) * 100)
      : ((1 - MAINTENANCE_MARGIN_RATIO) / x) * 100;

  const safestTier = ALLOWED_LEVERAGE[0];
  const riskiestTier = ALLOWED_LEVERAGE[ALLOWED_LEVERAGE.length - 1];

  const sim = useMemo(() => {
    const moves = [0.1, 0.03, -0.03];
    return moves.map((mv) => {
      const pnl = notional * mv * dir;
      return { mv, pnl, ownPct: (pnl / mg) * 100 };
    });
  }, [notional, mg, dir]);

  const submit = async () => {
    setErr(null);
    try {
      await s.commitOrder(t('opened') as string, () =>
        /*
         * ★만기가 «있으면» 선물(openFutures), «없으면» 기존 무기한 레버리지.
         *   ⛔openFutures 로 통일하지 «않는다» — 그러면 expiryTick 이 항상 붙어
         *   무기한이 사라진다. 두 경로가 «다른 상품»이다.
         * ★되돌리기는 둘 다 cancelLeverage 다(같은 원장). 그래서 문법이 같다.
         */
        expiry === null
          ? s.openLeverage(ticker, side, lev, mg)
          : s.openFutures(ticker, side, lev, mg, expiry)
      );
      nav('/derivatives');
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(t([`common:err.${code}`, 'common:err.GENERIC']) as string);
    }
  };

  const tone = side === 'long' ? 'up' : 'down';
  const liqBg = side === 'long' ? 'var(--down-weak)' : 'var(--up-weak)';
  const liqFg = side === 'long' ? 'var(--down)' : 'var(--up)';

  return (
    <div className="screen" style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:close')}>
          {Icon.close}
        </button>
        <TickerTile meta={m} size="xs" />
        <span style={{ fontSize: 17, fontWeight: 800 }}>{t('levTitle', { name: ko ? m.nameKo : m.nameEn })}</span>
      </div>

      <div className="scroll" style={{ padding: '4px 20px 0' }}>
        <Segment
          size="lg"
          value={side}
          onChange={setSide}
          toneOf={(v) => (v === 'long' ? 'long' : 'short')}
          options={[
            { value: 'long' as const, label: t('longSeg') },
            { value: 'short' as const, label: t('shortSeg') },
          ]}
        />

        {/* 배율 */}
        <div style={{ marginTop: 22 }}>
          {/* 폭이 꽉 차면 space-between 만으로는 두 문구가 «닿는다»(실제로 스크린샷에 찍혔다).
              최소 간격을 명시하고, 넘칠 때는 힌트가 줄바꿈되게 한다. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {/* ★xHint(「배율이 클수록 빨리 청산돼요」) 제거 — 아래 칩 밑 수치가
                같은 말을 «정확하게» 하고 있어 중복이고, 톤이 잔소리다.
                숫자(xEndSafe/xEndRisky)는 배율을 «고르는 근거»라 그대로 남긴다. */}
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', flex: '0 0 auto' }}>{t('howMuchX')}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ALLOWED_LEVERAGE.map((x) => (
              <button
                key={x}
                onClick={() => setLev(x)}
                aria-pressed={lev === x}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  border: `1.6px solid ${lev === x ? (side === 'long' ? 'var(--up)' : 'var(--down)') : 'var(--line)'}`,
                  background: lev === x ? (side === 'long' ? 'var(--up-weak)' : 'var(--down-weak)') : 'transparent',
                  color: lev === x ? (side === 'long' ? 'var(--up)' : 'var(--down)') : 'var(--t3)',
                  borderRadius: 14,
                  padding: '13px 0',
                  fontSize: 16,
                  fontWeight: 800,
                }}
              >
                {t('xN', { x })}
              </button>
            ))}
          </div>
          {/* 칩 아래 양 끝 청산폭 — 티어 선택이 곧 위험 선택임을 드러낸다(목업 :257) */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, color: 'var(--t3)' }}>
            <span>
              {t(side === 'long' ? 'xEndSafeLong' : 'xEndSafeShort', { p: pct(liqMovePct(safestTier), 0) })}
            </span>
            <span>
              {t(side === 'long' ? 'xEndRiskyLong' : 'xEndRiskyShort', { p: pct(liqMovePct(riskiestTier), 0) })}
            </span>
          </div>
        </div>

        {/*
          ★만기 — [무기한 · 3 · 5 · 7 게임일].
          ★첫 칩이 «무기한»이고 기본 선택이다 ⇒ 아무것도 안 만지면 예전과 «똑같이» 동작한다.
          ★게임일↔실제 시간 환산을 «만기를 고르는 자리»에서 한 번 보여준다(Partner 지시 2026-08-21) —
            유저가 한 번은 환산을 봐야 「3일」을 실제 3일로 오해하지 않는다.
          ⛔칩 아래에 「만기가 되면 자동 정산돼요」 같은 «경고문»을 두지 않는다.
            사실 한 줄이면 되고, 그건 아래 요약의 만기 행이 이미 말한다.
        */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('form.expiry')}</span>
            {expiry !== null && (
              <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>
                {t('realMinutes', { d: expiry, m: gameDaysToRealMinutes(expiry) })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {([null, ...OPTION_EXPIRY_CHOICES] as (number | null)[]).map((d) => (
              <button
                key={d ?? 'perp'}
                onClick={() => setExpiry(d)}
                aria-pressed={expiry === d}
                className={`pill pill--ink ${expiry === d ? 'pill--on' : ''}`}
                style={{ flex: 1, textAlign: 'center', justifyContent: 'center' }}
              >
                {d === null ? t('chip.perpetual') : t('dayN', { n: d })}
              </button>
            ))}
          </div>
        </div>

        {/* 증거금 */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('howMuch')}</span>
            <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>
              {t('available', { v: money(cash) })}
            </span>
          </div>
          <div className="num" style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.04em', marginTop: 6 }}>
            {money(mg, 0)}
          </div>
          <div style={{ marginTop: 6 }}>
            <Slider value={mg} min={100} max={maxMargin} step={50} onChange={setMargin} tone={tone} label={t('howMuch')} />
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
            {[500, 1000, 2000].map((v) => (
              <button
                key={v}
                className={`pill ${mg === v ? 'pill--on' : ''}`}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setMargin(Math.min(v, maxMargin))}
              >
                {money(v, 0)}
              </button>
            ))}
            <button
              className={`pill ${mg === maxMargin ? 'pill--on' : ''}`}
              style={{ flex: 1, textAlign: 'center' }}
              onClick={() => setMargin(maxMargin)}
            >
              {t('stock:pctMax')}
            </button>
          </div>
        </div>

        {/* 청산가 독립 블록 */}
        <div style={{ marginTop: 24, background: liqBg, borderRadius: 18, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: liqFg }}>
            {side === 'long' ? t('liqBlockLong') : t('liqBlockShort')}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
            <span className="num" style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', color: liqFg }}>
              {money(liqPrice)}
            </span>
            <span className="num" style={{ fontSize: 15, fontWeight: 700, color: liqFg, opacity: 0.85 }}>
              {signedPct(liqDistPct, 1)}
            </span>
          </div>
          <div style={{ marginTop: 12, height: 8, borderRadius: 4, background: 'var(--surface-2)', position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${Math.min(80, Math.abs(liqDistPct) * 2)}%`,
                background: liqFg,
                borderRadius: 4,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${Math.min(80, Math.abs(liqDistPct) * 2)}%`,
                top: -5,
                width: 3,
                height: 18,
                background: 'var(--t1)',
                borderRadius: 2,
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', marginTop: 7 }}>
            <span className="num">{money(liqPrice)}</span>
            <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{t('nowPrice', { v: money(price) })}</span>
          </div>
        </div>

        {/* 손익 시뮬레이터 */}
        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>{t('simTitle')}</div>
          <div className="card card--sub" style={{ padding: '6px 16px' }}>
            {sim.map((r, i) => (
              <div key={r.mv}>
                {i > 0 && <div className="divider" />}
                <div className="kv">
                  <span className="kv__k">
                    {t('simRow', { p: '' })}{' '}
                    <b className={r.mv > 0 ? 'up' : 'down'}>{signedPct(r.mv * 100, 0)}</b>
                  </span>
                  <span className={`kv__v num ${r.pnl >= 0 ? 'up' : 'down'}`}>
                    {t('simValue', { v: signedMoney(r.pnl, 0), p: signedPct(r.ownPct, 0) })}
                  </span>
                </div>
              </div>
            ))}
            <div className="divider" />
            <div className="kv">
              <span className="kv__k">
                {t('simRow', { p: '' })} <b className="down">{signedPct(liqDistPct, 1)}</b>
              </span>
              <span className="kv__v num down">{t('simLiq', { v: signedMoney(-mg, 0) })}</span>
            </div>
          </div>
        </div>

        {/* 비용 */}
        <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 14 }}>
          <div className="kv">
            <span className="kv__k">{t('posSize', { x: lev })}</span>
            <span className="kv__v num">{money(notional, 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">
              {/* ★상수에서 유도. FEE_LEVERAGE_BP 가 내려가면 이 표기도 «같이» 내려간다 */}
              {t('openFee')} <span style={{ fontSize: 11, opacity: 0.8 }}>({pct(FEE_LEVERAGE_BP / 100, 2)})</span>
            </span>
            <span className="kv__v num">{money(openFee)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">
              {t('holdCost')}{' '}
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                ({t('holdCostUnit', { p: pct(FUNDING_BP_PER_GAME_DAY / 100, 2) })})
              </span>
            </span>
            <span className="kv__v num">{t('perDay', { v: money(fundingPerDay) })}</span>
          </div>
        </div>

        {err && (
          <div className="note" style={{ marginTop: 12, background: 'var(--down-weak)', color: 'var(--down)', fontWeight: 700 }}>
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.warn}</span>
            <span>{err}</span>
          </div>
        )}

        <p className="hint" style={{ marginTop: 12 }}>
          {t('feeNote')}
        </p>
        <div className="scroll-pad" />
      </div>

      <div style={{ padding: '12px 20px calc(28px + var(--sa-bottom, env(safe-area-inset-bottom)))', background: 'var(--surface)' }}>
        {/* 스와이프 확정 제거 — 탭 1회 체결 + 5초 되돌리기(OptionOrder 와 같은 규칙) */}
        <button
          type="button"
          className={`btn btn--lg ${side === 'long' ? 'btn--up' : 'btn--down'}`}
          disabled={cash < mg + openFee}
          onClick={() => void submit()}
        >
          {side === 'long' ? t('openLong', { x: lev }) : t('openShort', { x: lev })}
          <span className="btn__sub num">{money(mg + openFee, 0)}</span>
        </button>
      </div>

    </div>
  );
}

/** 청산가 계산식 — 화면 밖(테스트)에서도 검증할 수 있게 export */
export function previewLiquidationPrice(
  entry: number,
  margin: number,
  leverage: number,
  side: 'long' | 'short',
  basis: 'initial_margin' | 'entry_notional'
): number {
  const notional = margin * leverage;
  const qty = notional / entry;
  const mm = basis === 'entry_notional' ? MAINTENANCE_MARGIN_RATIO * notional : MAINTENANCE_MARGIN_RATIO * margin;
  const allowed = Math.max(0, margin - mm);
  return Math.max(0, entry - (allowed / qty) * (side === 'long' ? 1 : -1));
}

export const _fmt = { pct };
