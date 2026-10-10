import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Icon, Segment } from './Primitives';
import { useRewardAd } from './RewardAd';
import { metaOf, useQuote, useStore } from '../store/hooks';
import { money, shares as fmtShares, pct, signedPct } from '../lib/format';
/*
 * ⛔★유동성 «깊이» 관련 상수를 여기서 import 하지 «마라».
 *   예전엔 LIQUIDITY_DEPTH_BASE_USD · MAX_SINGLE_ORDER_DEPTH_FRAC · ORDER_FLOW_WEIGHT ·
 *   depthFactorForRank 를 들여와 «화면이 직접» 깊이와 임팩트를 계산했다.
 *   ⇒ 엔진이 지수에 다른 깊이(INDEX_DEPTH_MULT)를 쓰기 시작한 날 ★16배 갈렸고,
 *     유저는 현금을 들고도 SPX·NDX 주문이 «에러 없이» 막혔다.
 *   ⇒ 이제 깊이는 «엔진만» 안다. 화면은 store 로 «결과»만 받는다.
 */
import { BP, FEE_SPOT_BP, TOPUP_AMOUNT } from '../lib/constants';

/**
 * 주문 시트 — 목업 03-B.
 * 대형 숫자(탭하면 직접 입력) + 슬라이더 + 비율 칩 + 요약 4행 + 탭 1회 체결.
 *
 * ★ 「확정은 반드시 스와이프(탭 1회 체결 금지)」였던 ui_spec 5장 규칙은
 *   President 지시(2026-08-19)로 폐기됐다. 매 주문마다 걸리는 마찰을 없애고,
 *   오조작은 주문 «직후» 5초 되돌리기(store.commitOrder)로 복구한다.
 */
export function OrderSheet({
  ticker,
  side,
  onClose,
}: {
  ticker: string;
  side: 'buy' | 'sell';
  onClose: () => void;
}) {
  const s = useStore();
  const nav = useNavigate();
  const q = useQuote(ticker);
  const m = metaOf(ticker);
  const { t, i18n } = useTranslation('stock');
  const ko = i18n.language !== 'en';
  const name = ko ? m.nameKo : m.nameEn;

  const [mode, setMode] = useState<'shares' | 'amount'>('shares');
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  /** 직접 입력 모드 (큰 숫자 탭) */
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  const price = q?.price ?? m.initialPrice;
  const cash = s.portfolio?.cash ?? 0;
  const holding = s.portfolio?.holdings.find((h) => h.ticker === ticker);
  /*
   * ★수량 상한 — 매수는 «현금», 매도는 «보유수량». 그게 전부다.
   *
   * ⛔[2026-09-05 President 결정] 「괜찮아. 캡 풀어.」
   *   여기 있던 `byCap = floor(s.maxOrderNotional(ticker) / price)` 항을 «제거»했다.
   *   엔진 쪽 짝(`world.placeSpotOrder` 의 `assertOrderSize`)도 같이 없앴으므로
   *   화면과 엔진이 «여전히 같은 규칙»이다 — ⛔한쪽만 풀면 조용히 갈린다(2026-08-23 깊이 16배 사고).
   * ★그래도 화면은 «값이 비싸진다»는 것을 말한다: 아래 `impactPct` 가 엔진의
   *   `priceImpactFrac` 을 그대로 받아 적는다. 이제 그것이 «유일한 브레이크»이므로
   *   ⛔그 표시를 지우지 마라 — 지우면 유저가 이유 없이 나쁜 체결을 받는다.
   */
  const maxQty = useMemo(() => {
    if (side === 'buy') return Math.max(1, Math.floor(cash / (price * (1 + FEE_SPOT_BP * BP))));
    return Math.max(1, Math.floor(holding?.qty ?? 0));
  }, [side, cash, price, holding]);

  const clamped = Math.max(1, Math.min(maxQty, qty));
  const gross = clamped * price;
  const fee = gross * FEE_SPOT_BP * BP;
  const cashAfter = side === 'buy' ? cash - gross - fee : cash + gross - fee;
  /*
   * ★체결가를 «실제로» 미는 비율 — world.fillPrice 가 무는 바로 그 값이다.
   *   ⛔`(gross / depth) * ORDER_FLOW_WEIGHT * 100` 으로 «다시 계산»하지 마라. 그게 16배 사고였다.
   * ★부호도 엔진이 준다(매수 +, 매도 −) — 화면에서 손으로 뒤집던 것을 없앴다.
   */
  const impactPct = s.priceImpactFrac(ticker, side === 'buy' ? gross : -gross) * 100;
  const tone = side === 'buy' ? 'up' : 'down';

  const submit = async () => {
    setErr(null);
    try {
      await s.commitOrder(
        t(side === 'buy' ? 'filledBuy' : 'filledSell', { qty: fmtShares(clamped) }) as string,
        () => s.orderSpot(ticker, side, clamped)
      );
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(t([`common:err.${code}`, 'common:err.GENERIC']) as string);
    }
  };

  const commitDraft = () => {
    const n = Number(draft.replace(/[^0-9]/g, ''));
    setTyping(false);
    if (Number.isFinite(n) && n > 0) setQty(Math.max(1, Math.min(maxQty, Math.round(n))));
  };

  const canOrder = maxQty >= 1 && (side === 'buy' ? cash > price : (holding?.qty ?? 0) >= 1);

  /*
   * ★★「현금이 모자라 살 수 없다」는 이 앱에서 «전환이 가장 높은 자리»다(Partner 판정).
   *   예전에는 버튼이 그냥 회색으로 죽어 있었다 — 왜 못 사는지도, 어떻게 푸는지도 없었다.
   *
   * ★단, 여기서 «거짓말을 하지 않는다». 엔진 규칙상 충전은 «파산(총자산 < $200)»일 때만 열린다
   *   (gameWorld.topup(): !bankrupt 면 NOT_BANKRUPT 를 던진다).
   *   따라서 사다리를 셋으로 나눈다:
   *     (1) 지금 바로 무료 충전이 되는 상태   → 「무료로 $10,000 받기」 (광고 불필요)
   *     (2) 파산인데 무료분을 다 씀 + 광고 여유 → 「광고 보고 $10,000 받기」
   *     (3) 그 외(=현금만 묶여 있는 상태)      → 광고를 «권하지 않는다». 팔거나 더 싼 종목으로 간다
   *   ⛔(3)에 리워드 버튼을 놓으면 눌러도 NOT_BANKRUPT 로 튕긴다 = 오늘 세 번 나온 «가짜 버튼»이다.
   */
  const topupSt = s.topup;
  const adRemaining = topupSt?.adRemaining ?? 0;
  const adPending = topupSt?.adPending ?? 0;
  const rewardAd = useRewardAd('topup', async () => {
    /* ★적립된 몴을 그 자리에서 바로 받아 준다 — 「광고 보고 $10,000 받기」가
       두 단계로 쪼개지면 유저는 받은 줄 모른다.
       ★지급은 반드시 doTopup() 경로다 — topupCount 가 거기서만 오른다. */
    await claim('ad');
  });

  const claim = async (kind: 'free' | 'ad') => {
    try {
      const amount = await s.doTopup(kind);
      s.pushToast(t('recharge:toppedUp', { v: money(amount, 0) }) as string);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      s.pushToast((t([`common:err.${code}`, 'common:err.GENERIC']) as string) ?? '', 'error');
    }
  };

  /*
   * ★사다리 — 위에서부터 «광고를 안 봐도 되는 순»으로 권한다.
   *   (1) 무료 충전 가능(=파산 구제)  → 광고 불필요
   *   (2) 이미 광고를 봐서 적립된 몴  → 광고 다시 볼 필요 없음
   *   (3) 광고 보고 받기 (★파산 여부와 무관 — 2026-08-20 President 지시)
   * ★그리고 «어느 경우에도» 「팔아서 현금 만들기」를 같이 둔다 —
   *   광고를 «유일한 길»로 만들지 않는다(「UX 를 망치지 않는 선에서」).
   */
  const lowCashPrimary: 'free' | 'pending' | 'ad' | null =
    topupSt?.freeEligible ? 'free' : adPending > 0 ? 'pending' : rewardAd.supported && adRemaining > 0 ? 'ad' : null;
  const hasHoldings = (s.portfolio?.holdings.length ?? 0) > 0;

  return (
    <div className="screen" style={{ position: 'absolute', inset: 0, background: 'var(--surface)', zIndex: 80 }}>
      <div className="appbar appbar--surface">
        <button className="iconbtn" onClick={onClose} aria-label={t('common:close')}>
          {Icon.close}
        </button>
        <span className="appbar__title" style={{ marginLeft: 2 }}>
          {t(side === 'buy' ? 'buyTitle' : 'sellTitle', { name })}
        </span>
        <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {side === 'buy'
            ? t('cashLabel', { v: money(cash) })
            : t('haveLabel', { v: t('common:shares', { count: Math.floor(holding?.qty ?? 0) }) })}
        </span>
      </div>

      <div className="scroll" style={{ padding: '6px 20px 0' }}>
        <Segment
          value={mode}
          onChange={setMode}
          options={[
            { value: 'shares' as const, label: t(side === 'buy' ? 'byShares' : 'bySharesSell') },
            { value: 'amount' as const, label: t(side === 'buy' ? 'byAmount' : 'byAmountSell') },
          ]}
        />

        <div style={{ textAlign: 'center', padding: '22px 0 4px' }}>
          {mode === 'shares' ? (
            /*
              ★큰 숫자를 «탭하면 직접 입력». 슬라이더로 37주를 맞추는 건 사실상 불가능하다.
                (파생 주문의 QuantityStepper 와 같은 어포던스 — 화면마다 다른 문법을 만들지 않는다)
            */
            typing ? (
              <input
                className="num ordersheet__input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoFocus
                aria-label={t('unitShares')}
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft();
                  if (e.key === 'Escape') setTyping(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="num ordersheet__big"
                aria-label={t('unitShares')}
                onClick={() => {
                  setDraft(String(clamped));
                  setTyping(true);
                }}
              >
                {clamped}
                <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--t3)', letterSpacing: '-0.02em' }}>
                  {t('unitShares')}
                </span>
              </button>
            )
          ) : (
            <div className="num" style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1 }}>
              {money(gross, 0)}
            </div>
          )}
          <div className="num" style={{ fontSize: 16, fontWeight: 700, color: 'var(--t2)', marginTop: 8 }}>
            {mode === 'shares' ? `≈ ${money(gross)}` : `≈ ${t('common:shares', { count: clamped })}`}
          </div>
        </div>

        <div style={{ marginTop: 22 }}>
          <Slider2 value={clamped} max={maxQty} onChange={setQty} tone={tone} label={t('unitShares')} />
          <div className="slider__scale">
            <span className="num">{t('minShares')}</span>
            <span className="num">{t('maxShares', { n: maxQty })}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 7, marginTop: 18 }}>
          {[0.25, 0.5, 0.75, 1].map((r) => {
            const target = Math.max(1, Math.floor(maxQty * r));
            const on = clamped === target;
            return (
              <button
                key={r}
                className={`pill ${on ? 'pill--on' : ''}`}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setQty(target)}
              >
                {r === 1 ? t('pctMax') : `${r * 100}%`}
              </button>
            );
          })}
        </div>

        <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 24 }}>
          <div className="kv">
            <span className="kv__k">{t('estPrice')}</span>
            <span className="kv__v num">{money(price)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('orderAmount')}</span>
            <span className="kv__v num">{money(gross)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">
              {/* ★요율을 «상수에서 유도»한다. 문자열 (0.05%) 를 박아 두면 FEE_SPOT_BP 를
                  고치는 날 화면만 옛날 값으로 남는다 — 오늘 이 앱에서 라벨 오류가 7건 나온 이유다. */}
              {t('feeWithPct')} <span style={{ fontSize: 11, opacity: 0.8 }}>({pct(FEE_SPOT_BP / 100, 2)})</span>
            </span>
            <span className="kv__v num">{money(fee)}</span>
          </div>
          <div className="divider" />
          <div className="kv kv--strong">
            <span className="kv__k">{t(side === 'buy' ? 'cashAfterBuy' : 'cashAfterSell')}</span>
            <span className="kv__v num">{money(cashAfter)}</span>
          </div>
        </div>

        {Math.abs(impactPct) >= 0.05 && (
          <div className={`note ${side === 'buy' ? 'note--up' : ''}`} style={{ marginTop: 14, background: side === 'buy' ? 'var(--up-weak)' : 'var(--down-weak)' }}>
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.trend(17)}</span>
            <span style={{ color: 'var(--t2)' }}>
              <Trans
                i18nKey={side === 'buy' ? 'stock:impactWarn' : 'stock:impactWarnSell'}
                values={{ p: signedPct(impactPct, 2) }}
                components={{ b: <b className={side === 'buy' ? 'up' : 'down'} /> }}
              />
            </span>
          </div>
        )}

        {err && (
          <div className="note" style={{ marginTop: 12, background: 'var(--down-weak)', color: 'var(--down)', fontWeight: 700 }}>
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.warn}</span>
            <span>{err}</span>
          </div>
        )}

        {side === 'buy' && !canOrder && (
          <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 16, background: 'var(--gold-weak)' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--gold-ink)' }}>{t('lowCashTitle')}</div>
            <p className="num" style={{ fontSize: 12, color: 'var(--t2)', marginTop: 5, lineHeight: 1.5 }}>
              {t('lowCashSub', { cash: money(cash), name, one: money(price) })}
            </p>
            {lowCashPrimary === 'free' && (
              <button
                type="button"
                className="btn btn--gold"
                style={{ marginTop: 12, padding: 14, fontSize: 15 }}
                onClick={() => void claim('free')}
              >
                {t('recharge:getFree', { v: money(TOPUP_AMOUNT, 0) })}
              </button>
            )}
            {lowCashPrimary === 'pending' && (
              <button
                type="button"
                className="btn btn--gold"
                style={{ marginTop: 12, padding: 14, fontSize: 15 }}
                onClick={() => void claim('ad')}
              >
                {t('recharge:claimEarned', { v: money(TOPUP_AMOUNT, 0) })}
                <span className="btn__sub">{t('recharge:claimEarnedSub')}</span>
              </button>
            )}
            {lowCashPrimary === 'ad' && (
              <button
                type="button"
                className="btn btn--gold"
                style={{ marginTop: 12, padding: 14, fontSize: 15 }}
                disabled={rewardAd.busy}
                onClick={() => void rewardAd.run()}
              >
                {t('recharge:adCta', { v: money(TOPUP_AMOUNT, 0) })}
                <span className="btn__sub">
                  {rewardAd.busy ? t('common:loading') : t('recharge:adLeft', { n: adRemaining, v: money(TOPUP_AMOUNT, 0) })}
                </span>
              </button>
            )}
            {/* ★항상 함꿠 둘 다 — 광고를 «유일한 길»로 만들지 않는다 */}
            <button
              type="button"
              className={lowCashPrimary ? 'btn btn--ghost' : 'btn btn--sub'}
              style={{ marginTop: lowCashPrimary ? 4 : 12, padding: 13, fontSize: 15 }}
              onClick={() => nav(hasHoldings ? '/stocks?own=1' : '/stocks')}
            >
              {hasHoldings ? t('lowCashSell') : t('lowCashCheaper')}
            </button>
            {!lowCashPrimary && (
              <p className="hint" style={{ marginTop: 8 }}>
                {t('lowCashNoneLeft')}
              </p>
            )}
          </div>
        )}

        <p className="hint" style={{ marginTop: 14 }}>
          {t('fillNote')}
        </p>
        <div className="scroll-pad" />
      </div>

      <div style={{ padding: '12px 20px calc(28px + var(--sa-bottom, env(safe-area-inset-bottom)))', background: 'var(--surface)' }}>
        <button
          type="button"
          className={`btn btn--lg ${side === 'buy' ? 'btn--up' : 'btn--down'}`}
          disabled={!canOrder}
          onClick={() => void submit()}
        >
          {t(side === 'buy' ? 'buyNow' : 'sellNow', { n: clamped })}
          <span className="btn__sub num">{money(gross + (side === 'buy' ? fee : -fee))}</span>
        </button>
      </div>
    </div>
  );
}

/** 주문 시트 전용 슬라이더(정수 주식 수) */
function Slider2({
  value,
  max,
  onChange,
  tone,
  label,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  tone: 'up' | 'down';
  label: string;
}) {
  const ratio = max > 1 ? (value - 1) / (max - 1) : 0;
  const pctStr = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  return (
    <div className="slider" style={{ ['--dir' as string]: tone === 'up' ? 'var(--up)' : 'var(--down)' }}>
      <div className="slider__track">
        <div className="slider__fill" style={{ width: pctStr }} />
        <div className="slider__thumb" style={{ left: pctStr }} />
      </div>
      <input
        type="range"
        min={1}
        max={Math.max(1, max)}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
