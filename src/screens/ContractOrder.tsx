/**
 * 선도 · 스왑 «공유» 주문폼 — 사양서 §2.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 한 컴포넌트인가 (사양서 §2 「상품마다 화면을 만들지 마라」)
 *   선도와 스왑은 «구조가 같다»: 기초자산 고르기 → 방향 → 규모 → 상대 제안 3장 → 확정.
 *   다른 건 ①기초자산이 1개냐 2개냐 ②방향 라벨 ③제안 «가격»의 뜻(계약가 vs 캐리스프레드)뿐이다.
 *   ⇒ 필드 «표시 여부»만 갈라지는 단일 폼. 상품이 늘어도 화면은 늘지 않는다.
 *
 * ★선물·옵션은 «이미 있는» LeverageOrder / OptionOrder 를 확장했다 —
 *   그쪽에는 청산가 시뮬레이터·만기 손익 그래프처럼 이 폼에 없는 «상품 고유 정보»가 있고,
 *   출시 직전에 그걸 통합하려고 다시 쓰면 잃는 게 더 크다. (인계문서에 사유를 남긴다)
 *
 * ★★탭 수 (사양서 §2-1 원칙 ①: 3탭 이내)
 *   선도: 종목(허브에서 이미 고름) → 방향 → 확정            = ★3탭
 *   스왑: 종목A(허브) → 종목B → 방향 → 확정                 = 4탭
 *   ⇒ ★규모는 «기본값이 미리 채워져» 탭을 소비하지 않는다. 바꾸고 싶은 사람만 만진다.
 *   ⇒ ★제안 3장은 «최량이 미리 선택»돼 있다. 그대로 확정하면 탭이 안 는다.
 *
 * ⛔경고·동의·재확인 «없음»(President 지시). 규칙 설명은 조작을 막지 않는 한 줄 안내로만.
 */
/*
 * ⛔★유동성 «깊이» 상수를 여기서 들여오지 «마라» (2026-08-23 실사고).
 *   화면이 `LIQUIDITY_DEPTH_BASE_USD * depthFactorForRank(rank)` 로 깊이를 «직접» 셌는데,
 *   엔진은 지수에 `INDEX_DEPTH_MULT(4)` 를 쓴다(data.ts:61). 화면은 assetClass 를 «모른다».
 *   ⇒ SPX·NDX 에서 ★16배 갈렸다. 상한이 1/16 이라 «에러 없이» 주문이 막혔다.
 *   ⇒ 깊이는 «엔진만» 안다.
 * ★[2026-09-05] 그 뒤 President 지시로 «파생의 깊이 상한 자체»가 사라졌다(아래 maxNotional 주석).
 *   이 금지는 그대로 유효하다 — 깊이를 화면에서 다시 세지 마라. 셀 이유도 이제 없다.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, QuantityStepper, Segment, TickerTile } from '../components/Primitives';
import { QuoteCards } from '../components/QuoteCards';
import { TickerPicker } from '../components/TickerPicker';
import { metaOf, useStore, useTick } from '../store/hooks';
import { money, gameDaysToRealMinutes, signedPct } from '../lib/format';
import {
  FORWARD_EXPIRY_GAME_DAYS,
  FORWARD_MARGIN_RATIO,
} from '../lib/constants';
import type { LevSide } from '../lib/types';

type Product = 'forward' | 'swap';
type SwapSide = 'a' | 'b';

/**
 * 규모 프리셋 — «금액»이 아니라 «가용 증거금 대비 비율»이다.
 * ★금액을 박으면($1,000 등) 잔고가 $200 인 사람에게는 전부 눌리지 않는 버튼이 된다.
 *   비율이면 항상 의미가 있다.
 */
const SIZE_FRACTIONS = [0.1, 0.25, 0.5];

export function ContractOrder() {
  const { product = 'forward', ticker = 'NVDA' } = useParams<{ product: Product; ticker: string }>();
  const isSwap = product === 'swap';
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('derivatives');
  const ko = i18n.language !== 'en';

  const [tickerB, setTickerB] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /*
   * ★상품마다 «방향의 값 집합»이 다르다: 선도 long/short · 스왑 a/b.
   *   ⇒ 상태가 상품 사이를 «넘어오면» 세그먼트가 아무것도 안 골라진 것처럼 보이고
   *     엔진은 조용히 반대편 가격을 준다(App.tsx Keyed 주석의 실사고).
   *   ⇒ 라우트 key 로 «새 인스턴스»가 보장되지만, 여기서도 ★값이 상품과 맞는지 좁힌다 —
   *     방어는 «두 겹»이어야 한 겹이 뚫려도 조용히 틀리지 않는다.
   */
  const [sideRaw, setSide] = useState<LevSide | SwapSide>(isSwap ? 'a' : 'long');
  const side: LevSide | SwapSide = isSwap
    ? sideRaw === 'a' || sideRaw === 'b'
      ? sideRaw
      : 'a'
    : sideRaw === 'long' || sideRaw === 'short'
      ? sideRaw
      : 'long';
  const [notional, setNotional] = useState<number | null>(null);
  const [quoteIdx, setQuoteIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mA = metaOf(ticker);
  const mB = tickerB ? metaOf(tickerB) : null;
  const cash = s.portfolio?.cash ?? 0;

  /*
   * ★규모 상한 — «현금 하나»다.
   *   증거금 = 명목 × FORWARD_MARGIN_RATIO 이므로  명목 ≤ 현금 / 비율.
   * ★상한을 «화면에서» 걸어야 확정 버튼을 눌렀다가 거절당하는 일이 없다
   *   (사양서 §4: 부족하면 «버튼 비활성 + 한 줄 안내». ⛔모달 금지).
   *
   * ⛔★[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
   *   여기 있던 `depthCap`(= `s.maxOrderNotionalAll(...)`) 항을 «제거»했다. 되살리지 마라.
   *   엔진 쪽 짝(`world.openForward`·`openSwap` 의 `assertOrderSize`)도 같이 없앴으므로
   *   화면과 엔진이 «여전히 같은 규칙»이다 — 한쪽만 풀면 조용히 갈린다(2026-08-23 사고와 같은 형태).
   * ★그럼 큰 주문이 공짜가 되나: 아니다. 계약가는 상대 호가(`quotesFor`)에서 나오고
   *   그 기준가는 21틱 «중앙값»(`refPrice`)이라 한 틱 펌프에 면역이다. 게다가 선도·스왑은
   *   `addOrderFlow` 를 넣지 않아 시세를 밀지도 못한다. 커지는 것은 «손익의 크기»뿐이다.
   */
  const maxNotional = Math.max(0, Math.floor(cash / FORWARD_MARGIN_RATIO));
  /** 기본값 = 가용의 25%. ★미리 채워 두면 규모가 «탭을 소비하지 않는다» */
  const defaultNotional = Math.max(0, Math.floor(maxNotional * 0.25));
  const size = Math.min(notional ?? defaultNotional, maxNotional);
  const margin = size * FORWARD_MARGIN_RATIO;

  const ready = isSwap ? Boolean(tickerB) : true;

  /*
   * ★★호가 시드 — 차익거래 방지 ③.
   *   ⛔Date.now()·Math.random() 을 «쓰지 않는다». store 가 (상품·종목·방향) 키로
   *     세션 ID 를 «한 번» 만들고 이후 계속 같은 값을 준다.
   *   ⇒ ★뒤로 갔다 다시 들어와도 «같은 3장». 「다시 뽑기」 버튼은 «없다».
   */
  const seed = useMemo(() => {
    if (!ready) return 0;
    return s.quoteSeed(s.quoteSessionId(product as Product, ticker, tickerB ?? '', side));
  }, [s, product, ticker, tickerB, side, ready]);

  /*
   * ★제안은 매 틱 다시 «읽는다». 상대 3명과 그들의 견해 편향은 시드로 «고정»이고,
   *   ★가격만 시세를 따라간다 — 그래야 «화면에 보인 값 = 체결되는 값»이다
   *   (엔진 openForward 도 체결 순간 같은 시드로 다시 계산한다).
   */
  const quotes = useMemo(() => {
    if (!ready) return [];
    try {
      return isSwap
        ? s.swapQuotes(ticker, tickerB!, side as SwapSide, seed)
        : s.forwardQuotes(ticker, side as LevSide, seed);
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, isSwap, ticker, tickerB, side, seed, s.tickVersion, ready]);

  // 방향을 바꾸면 제안 묶음이 달라진다 — 선택 인덱스를 최량으로 되돌린다
  useEffect(() => setQuoteIdx(0), [side, tickerB]);

  const chosen = quotes[Math.min(quoteIdx, Math.max(0, quotes.length - 1))];
  const enough = cash >= margin && size > 0;
  const canSubmit = ready && enough && Boolean(chosen) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setErr(null);
    setBusy(true); // ★중복 클릭 방지 — 두 번 눌러 계약이 두 개 열리는 걸 막는다
    try {
      await s.commitOrder(t('toast.contracted') as string, () =>
        isSwap
          ? s.openSwap(ticker, tickerB!, side as SwapSide, size, seed, quoteIdx)
          : s.openForward(ticker, side as LevSide, size, seed, quoteIdx)
      );
      nav('/derivatives');
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(t([`common:err.${code}`, 'common:err.GENERIC']) as string);
      setBusy(false);
    }
  };

  const nameB = mB ? (ko ? mB.nameKo : mB.nameEn) : '';

  return (
    <div className="screen" style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:close')}>
          {Icon.close}
        </button>
        <TickerTile meta={mA} size="xs" />
        <span style={{ fontSize: 17, fontWeight: 800 }}>
          {t(isSwap ? 'chip.swap' : 'chip.forward')}
        </span>
        <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {money(s.priceOf(ticker))}
        </span>
      </div>

      <div className="scroll" style={{ padding: '4px 20px 0' }}>
        <p className="hint" style={{ marginBottom: 14 }}>
          {t(isSwap ? 'desc.swap' : 'desc.forward', { n: FORWARD_EXPIRY_GAME_DAYS })}
        </p>

        {/* ① 종목 — 스왑만 «두 번째»를 고른다 */}
        {isSwap && (
          <>
            <div className="sec__h">{t('form.pickStockB')}</div>
            <button className="card li" style={{ width: '100%' }} onClick={() => setPicking(true)}>
              {mB ? (
                <>
                  <TickerTile meta={mB} size="sm" />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{nameB}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                      {mB.ticker} · {money(s.priceOf(mB.ticker))}
                    </span>
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t3)' }}>{t('form.pickStock')}</span>
              )}
              <span className="li__val">{Icon.chevron}</span>
            </button>
          </>
        )}

        {/* ② 방향 */}
        <div className="sec__h" style={{ marginTop: 18 }}>
          {t('form.side')}
        </div>
        {isSwap ? (
          <Segment
            size="lg"
            value={side as SwapSide}
            onChange={(v) => setSide(v)}
            options={[
              /*
               * ★세그먼트에는 «티커»를 넣는다 — 회사 이름은 세그먼트 반쪽에서 «두 줄로 접힌다»
               *   (실렌더: 「팔로알토네트웍스가 더 오른다」가 2줄). 전체 이름은 바로 위
               *   종목 카드에 «이미» 있으므로 정보가 사라지지 않는다.
               * ★그리고 한국어 조사(가/이)는 받침에 따라 갈린다 — 종목 100개에 맞출 방법이 없어
               *   문구를 «조사가 필요 없는» 형태로 바꿨다(「{{a}} 쪽」).
               */
              { value: 'a' as const, label: t('form.swapSideA', { a: mA.ticker }) },
              { value: 'b' as const, label: t('form.swapSideB', { b: mB?.ticker || '—' }) },
            ]}
          />
        ) : (
          <Segment
            size="lg"
            value={side as LevSide}
            onChange={(v) => setSide(v)}
            toneOf={(v) => (v === 'long' ? 'long' : 'short')}
            options={[
              { value: 'long' as const, label: t('form.long') },
              { value: 'short' as const, label: t('form.short') },
            ]}
          />
        )}

        {/* ③ 규모 — 기존 수량 스테퍼 재사용 */}
        <div className="sec__h" style={{ marginTop: 18 }}>
          {t('form.size')}
        </div>
        <QuantityStepper
          value={size}
          min={0}
          max={maxNotional}
          onChange={setNotional}
          presets={SIZE_FRACTIONS.map((f) => Math.max(1, Math.floor(maxNotional * f)))}
          maxLabel={t('stock:pctMax')}
          label={t('form.size')}
          /* ★금액이다 — 「12500」이 아니라 「$12,500」으로 그린다(앱의 다른 금액과 같은 문법) */
          format={(v) => money(v, 0)}
        />
        <div className="kv" style={{ paddingBottom: 0 }}>
          <span className="kv__k">{t('common:cash')}</span>
          <span className="kv__v num">{money(cash)}</span>
        </div>

        {/* ④ 만기 — 고정. 선택 UI 없이 «사실»만 */}
        <div className="kv">
          <span className="kv__k">{t('form.expiry')}</span>
          <span className="kv__v num">
            {t('form.expiryFixed', {
              n: FORWARD_EXPIRY_GAME_DAYS,
              m: gameDaysToRealMinutes(FORWARD_EXPIRY_GAME_DAYS),
            })}
          </span>
        </div>

        {/* ⑤ 상대 제안 3장 */}
        {ready ? (
          <QuoteCards
            quotes={quotes}
            selected={quoteIdx}
            onSelect={setQuoteIdx}
            renderPrice={(q) => (isSwap ? signedPct(q.price * 100, 2) : money(q.price))}
          />
        ) : (
          <p className="hint" style={{ marginTop: 18 }}>
            {t('err.pickTwo')}
          </p>
        )}

        {/* ⑥ 요약 */}
        <div className="card card--sub" style={{ marginTop: 18, padding: '4px 16px' }}>
          <div className="kv">
            <span className="kv__k">{t('form.size')}</span>
            <span className="kv__v num">{money(size, 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            {/* ★기존 키 재사용 — 「증거금 {{v}}」 한 줄로 라벨+값을 함께 낸다 */}
            <span className="kv__k">{t('marginLabel', { v: '' })}</span>
            <span className="kv__v num">{money(margin)}</span>
          </div>
          {chosen && (
            <>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">{chosen.nickname}</span>
                <span className="kv__v num">{isSwap ? signedPct(chosen.price * 100, 2) : money(chosen.price)}</span>
              </div>
            </>
          )}
        </div>

        <p className="hint" style={{ marginTop: 12 }}>
          {t('info.marginRule')}
        </p>

        {/* ★부족 상태 — ⛔모달·경고창 없이 «버튼 아래 한 줄»로만 알린다(사양서 §4) */}
        {err && (
          <div className="note" style={{ marginTop: 12, background: 'var(--down-weak)', color: 'var(--down-ink)', fontWeight: 700 }}>
            <span aria-hidden>{Icon.warn}</span>
            <span>{err}</span>
          </div>
        )}
        <div className="scroll-pad" />
      </div>

      <div style={{ padding: '12px 20px calc(28px + var(--sa-bottom, env(safe-area-inset-bottom)))', background: 'var(--surface)' }}>
        <button
          type="button"
          className={`btn btn--lg ${side === 'short' ? 'btn--down' : 'btn--up'}`}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {t('form.confirm')}
          <span className="btn__sub num">{money(margin, 0)}</span>
        </button>
        {!enough && ready && (
          <p className="hint" style={{ marginTop: 8, textAlign: 'center' }}>
            {t('err.notEnoughMargin')}
          </p>
        )}
      </div>

      {picking && (
        <TickerPicker
          title={t('form.pickStockB')}
          exclude={ticker}
          onPick={(tk) => {
            setTickerB(tk);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
