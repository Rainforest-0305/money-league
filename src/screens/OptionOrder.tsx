import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, QuantityStepper, Segment, TickerTile } from '../components/Primitives';
import { PayoffChart } from '../components/Charts';
import { metaOf, useQuote, useStore, useTick } from '../store/hooks';
import { money, pct, gameDaysToRealMinutes, strikeLabel } from '../lib/format';
import { FEE_OPTION_BP, OPTION_EXPIRY_CHOICES } from '../lib/constants';
import { breakEven, strikeChoices } from '../lib/options';

/**
 * 옵션 주문 — 목업 04-C.
 * 옵션체인 표를 만들지 않는다. 행사가 칩 4개 + 만기 손익 그래프로 끝낸다.
 *
 * ★1계약이 담는 주(단위) 수는 «종목마다 다르다»(2026-09-05). 주식 994종은 10주 그대로이고,
 *   고가 자산만 미니계약이 된다(BTC 0.05 · NDX 0.2 · SPX 0.5 · GOLD 1 · ETH 2).
 *   ⛔화면이 그 수를 «세지 않는다» — `store.sharesPerContractOf(ticker)` 로 받는다.
 *   근거·사다리는 `lib/constants.ts` 의 `sharesPerContractFor` 머리주석.
 */
export function OptionOrder() {
  const { ticker = 'AMD' } = useParams();
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('derivatives');
  const ko = i18n.language !== 'en';
  const m = metaOf(ticker);
  const q = useQuote(ticker);

  const [kind, setKind] = useState<'call' | 'put'>('call');
  /*
   * ★★사기 / 팔기 (2026-08-20 파생 4종 — 옵션 «매도» 신설).
   *   ★기본값은 «사기»다 = 기존 동작. 매도는 «토글 1회»를 더 쓰는 경로다
   *     (사양서 §2-1: 옵션 매수 3탭 · 매도 4탭 — 의도된 차이다).
   *   ★왜 별도 화면을 안 만드나: 고르는 것(콜/풋·행사가·만기·계약수)이 «전부 같다».
   *     달라지는 건 돈의 «방향»과 증거금뿐이다.
   */
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [expiry, setExpiry] = useState<number>(5);
  const [contracts, setContracts] = useState(1);
  /**
   * 행사가 선택. null = «아직 안 골랐다» → 현재가에 가장 가까운 칸(ATM)이 기본값이다.
   *
   * ★ 예전 기본값은 `2` 고정이었다. strikeChoices 의 정렬 결과상 콜에서는
   *   «두 칸 위(약 +18%)»가 걸려서, 화면을 열자마자 프리미엄 $0.01짜리
   *   복권이 기본 선택돼 있었다(실측: AMD $168.66 → 기본 $200, 프리미엄 $0.01).
   *   기본값만 고쳐도 「고를 게 없으면 그냥 사면 되는」 화면이 된다.
   */
  const [strikeIdx, setStrikeIdx] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const spot = q?.price ?? m.initialPrice;
  const cash = s.portfolio?.cash ?? 0;
  /*
   * ★1계약이 담는 주(단위) 수 — «종목마다 다르다»(2026-09-05).
   *   ⛔`SHARES_PER_CONTRACT` 를 화면에서 직접 쓰지 마라. BTC 는 0.05, NDX 는 0.2 이고
   *     주식 994종은 그대로 10 이다. 엔진이 답하고 화면은 «받아 적는다»(U-7).
   *   ⇒ 이 값이 손익 그래프의 주수와 비용 카드 문구를 «동시에» 정한다 —
   *     두 곳이 다른 수를 쓰면 그래프와 금액이 어긋난다.
   */
  const shares = s.sharesPerContractOf(ticker);

  const strikes = useMemo(() => strikeChoices(kind, spot), [kind, spot]);
  /** 현재가에 가장 가까운 칸 = 기본 선택 */
  const atmIdx = useMemo(() => {
    let best = 0;
    let bestDist = Infinity;
    strikes.forEach((k, i) => {
      const d = Math.abs(k - spot);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }, [strikes, spot]);
  const sIdx = Math.min(strikeIdx ?? atmIdx, strikes.length - 1);
  const strike = strikes[sIdx] ?? spot;

  /**
   * ★★필요현금·프리미엄은 «엔진에게 묻는다» (`store.optionQuote` → `world.optionQuote`).
   *
   * ⚠️[2026-08-21 실렌더로 잡은 결함] 예전에는 화면이 `optionPremium(kind, spot, ...)` 으로
   *   «현재가» 기준 필요현금을 «직접» 계산했다. 엔진은 델타헤지 물량이 기초자산을 미는
   *   `fillPrice()` 를 쓰기 때문에 계약 수가 커질수록 두 값이 벌어진다. 실측:
   *     NVDA · 시드 $10,000 · 화면의 「최대」 계약수 그대로 확정 → ★「현금이 모자라요」.
   *     현금 $3,000 도 같았고, $800·$300 은 계약 수가 작아 «우연히» 통과했다.
   *   ⇒ 임팩트가 계약 수에 «비선형»이라 「1계약 비용 × N」으로는 못 맞힌다.
   *   ⇒ U-7 규율대로 화면이 엔진 식을 복제하지 않고 «견적을 받는다».
   *     `world.optionQuote` 는 `buyOption`·`writeOption` 이 실제로 쓰는 바로 그 함수다.
   * ★`s.tick` 을 의존성에 넣어 시세가 움직이면 견적도 따라간다(useTick 이 리렌더를 준다).
   */
  const quote = useCallback(
    (k: number, n: number) => s.optionQuote(ticker, kind, k, expiry, Math.max(1, n), action),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, ticker, kind, expiry, action, s.tick]
  );

  /** 1계약 기준 견적 — 칩 미리보기·«더 싼 행사가» 찾기에 쓴다 */
  const quote1At = useMemo(() => strikes.map((k) => quote(k, 1)), [strikes, quote]);

  /**
   * ★「최대」가 가리키는 계약 수 — 잔고를 «절대» 넘지 않아야 한다.
   *   필요현금이 계약 수에 비선형이라 나눗셈으로 못 구한다 ⇒ «배증 탐색 → 이분 탐색» 한다.
   *   ★탐색 뒤 한 번 더 확인하고, 넘치면 줄인다(단조성을 «가정만» 하지 않는다).
   *
   * ★★[2026-09-05 President 지시] 「파생 100계약 상한이랑 유동 상한 둘다 없애.」
   *   예전에는 `hi = MAX_OPTION_CONTRACTS(99)` 로 «상한이 곧 탐색 천장»이었다.
   *   상수를 없앴으니 천장을 «현금이 정한다» — 그래서 위쪽 끝을 먼저 «찾아야» 한다.
   *   ⛔`hi = ceil(cash / need(1))` 로 «계산»하지 마라: 그건 need 가 계약 수에 «비례»한다는
   *     가정인데, 매도(sell)는 델타헤지가 기초자산을 «유리한 쪽»으로 밀어 need 가
   *     계약당으로 «싸진다»(need(n) < n·need(1)) — 그 식은 최대치를 과소평가한다.
   *   ⇒ 가정 없이 «2배씩 늘려» 현금을 넘는 지점을 찾고, 그 구간만 이분 탐색한다.
   * ★`SEARCH_CEIL` 은 상한이 아니라 «무한 루프 방지 난간»이다. 여기에 걸리는 경우는
   *   need 가 계약 수에 사실상 반응하지 않는 병리적 상태뿐이고, 그때도 화면은 죽지 않는다.
   */
  const affordable = useMemo(() => {
    const SEARCH_CEIL = 1_000_000;
    const need = (n: number) => quote(strike, n).need;
    if (need(1) > cash) return 0;
    let lo = 1;
    let hi = 2;
    while (hi < SEARCH_CEIL && need(hi) <= cash) {
      lo = hi;
      hi *= 2;
    }
    hi = Math.min(hi, SEARCH_CEIL);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (need(mid) <= cash) lo = mid;
      else hi = mid - 1;
    }
    for (let i = 0; i < 4 && lo > 1 && need(lo) > cash; i++) lo -= 1;
    return lo;
  }, [quote, strike, cash]);

  const maxContracts = Math.max(1, affordable);
  // 잔고가 줄어 최대치가 내려가면 선택값도 따라 내려간다(초과 상태로 남지 않게)
  const contractsSafe = Math.min(contracts, maxContracts);

  /** ★실제로 낼 견적 — 버튼·비용카드·손익그래프가 «전부 이 하나»를 쓴다 */
  const qSel = quote(strike, contractsSafe);
  const premium = qSel.premium;
  const total = qSel.total;
  const fee = qSel.fee;
  const shortMargin = qSel.margin;
  /** ★버튼에 적는 금액 — 매수는 «내는 돈», 매도는 «잠기는 돈». 뜻이 다르므로 라벨도 다르다 */
  const payNow = Math.max(0, qSel.need);
  const be = breakEven(kind, strike, premium);

  /**
   * 1계약도 못 살 때 «갈 곳». 지금 잔고로 1계약이 되는 칩 중 가장 싼 것.
   * ★매도(sell)는 필요현금이 명목가 기준이라 행사가를 바꿔도 거의 안 변한다 —
   *   그래서 이 계산이 자연히 -1 을 돌려주고 제안이 뜨지 않는다. 따로 분기하지 않는다.
   */
  const cheaperIdx = useMemo(() => {
    if (affordable > 0) return -1;
    let best = -1;
    quote1At.forEach((q1, i) => {
      if (i === sIdx || q1.need > cash || q1.need <= 0) return;
      if (best < 0 || q1.need < quote1At[best].need) best = i;
    });
    return best;
  }, [affordable, quote1At, cash, sIdx]);

  const submit = async () => {
    setErr(null);
    try {
      await s.commitOrder(t(action === 'sell' ? 'toast.contracted' : 'optionBought') as string, () =>
        action === 'sell'
          ? s.writeOption(ticker, kind, strike, expiry, contractsSafe)
          : s.buyOption(ticker, kind, strike, expiry, contractsSafe)
      );
      nav('/derivatives');
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(t([`common:err.${code}`, 'common:err.GENERIC']) as string);
    }
  };

  return (
    <div className="screen" style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:close')}>
          {Icon.close}
        </button>
        <TickerTile meta={m} size="xs" />
        <span style={{ fontSize: 17, fontWeight: 800 }}>{t('optTitle', { name: ko ? m.nameKo : m.nameEn })}</span>
        <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {money(spot)}
        </span>
      </div>

      <div className="scroll" style={{ padding: '4px 20px 0' }}>
        <Segment
          size="lg"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setStrikeIdx(null); // 콜/풋을 바꾸면 다시 ATM 기본값으로
          }}
          toneOf={(v) => (v === 'call' ? 'long' : 'short')}
          options={[
            { value: 'call' as const, label: t('callSeg') },
            { value: 'put' as const, label: t('putSeg') },
          ]}
        />

        {/*
          ★사기 / 팔기 — 콜·풋 «다음»에 둔다.
            먼저 「무엇에 걸까(콜/풋)」를 정하고, 그 다음에 「사는 쪽인가 파는 쪽인가」다.
            순서를 바꾸면 매수 사용자(대다수)가 «자기와 무관한 선택»을 먼저 만난다.
          ⛔경고문을 달지 않는다(President 지시). 아래 비용 카드의 숫자가 차이를 말한다.
        */}
        <div style={{ marginTop: 18 }}>
          <Segment
            value={action}
            onChange={(v) => setAction(v)}
            options={[
              { value: 'buy' as const, label: t('form.buyOption') },
              { value: 'sell' as const, label: t('form.sellOption') },
            ]}
          />
        </div>

        {/* 행사가 칩 */}
        <div style={{ marginTop: 22 }}>
          {/* LeverageOrder 와 같은 구조 — 같은 이유로 최소 간격을 명시한다. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', flex: '0 0 auto' }}>
              {kind === 'call' ? t('strikeQCall') : t('strikeQPut')}
            </span>
            <span style={{ fontSize: 12, color: 'var(--t3)', minWidth: 0, textAlign: 'right' }}>{t('strikeHint')}</span>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            {strikes.map((k, i) => {
              const on = i === sIdx;
              /* ★칩 가격도 «엔진 견적»에서 읽는다 — 카드·버튼과 다른 식을 쓰지 않는다.
                 1계약 기준이라 수량을 바꿔도 칩 값이 흔들리지 않는다.

                 ★★[2026-09-05] «주당 프리미엄»이 아니라 «1계약 비용»(total)을 적는다.
                   ⛔왜 바꿨나 [실렌더에서 본 것]: 계약 크기가 종목마다 달라지면서
                     BTC 칩이 「$1,229.93」인데 확정 버튼은 「$61.53」이 됐다(1계약 = 0.05주).
                     ★칩과 버튼이 20배 어긋난 화면은 「표기 정합성」이 깨진 것이다.
                   ⇒ 이 게임에서 사는 단위는 «주»가 아니라 «계약»이다. 칩도 계약으로 적는다.
                     `total` = premium × 1계약 × 그 종목의 계약 크기 — 버튼·비용카드와 같은 값이다. */
              const prem = quote1At[i]?.total ?? 0;
              return (
                <button
                  key={k}
                  onClick={() => setStrikeIdx(i)}
                  aria-pressed={on}
                  style={{
                    flex: 1,
                    border: `1.5px solid ${on ? 'var(--up)' : 'var(--line)'}`,
                    background: on ? 'var(--up-weak)' : 'transparent',
                    borderRadius: 14,
                    padding: '11px 4px',
                    textAlign: 'center',
                  }}
                >
                  <div className="num" style={{ fontSize: 15, fontWeight: 800, color: on ? 'var(--up)' : 'var(--t1)' }}>
                    {strikeLabel(k)}
                  </div>
                  <div className="num" style={{ fontSize: 11, marginTop: 2, color: on ? 'var(--up)' : 'var(--t3)' }}>
                    {money(prem)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 만기 */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>{t('whenQ')}</div>
          <div style={{ display: 'flex', gap: 7 }}>
            {OPTION_EXPIRY_CHOICES.map((d) => (
              <button
                key={d}
                className={`pill ${expiry === d ? 'pill--on' : ''}`}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setExpiry(d)}
                aria-pressed={expiry === d}
              >
                {t('dayN', { n: d })}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
            {t('realMinutes', { d: expiry, m: gameDaysToRealMinutes(expiry) })}
          </div>
        </div>

        {/* 만기 손익 그래프 */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('payoffTitle')}</span>
            <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>
              {t('breakEven', { v: money(be) })}
            </span>
          </div>
          <div className="card card--sub" style={{ marginTop: 10, padding: '12px 8px 6px' }}>
            {/*
              ★매도는 손익이 «정확히 뒤집힌다»(내가 판 권리를 상대가 행사한다).
                shares 를 음수로 넘겨 같은 차트를 그대로 뒤집는다 —
                ⛔차트를 하나 더 만들지 않는다.
            */}
            <PayoffChart
              kind={kind}
              strike={strike}
              premiumPerShare={premium}
              spot={spot}
              shares={contractsSafe * shares}
              side={action}
            />
          </div>
        </div>

        {/* 계약 수 — 프리셋 1탭 · 직접 입력 · 롱프레스 가속 (Primitives.QuantityStepper) */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>
            {t('howManyContracts')}
          </div>
          <QuantityStepper
            value={contractsSafe}
            min={1}
            max={maxContracts}
            onChange={setContracts}
            presets={[1, 5, 10]}
            maxLabel={t('stock:pctMax')}
            unit={t('unitContracts')}
            label={t('howManyContracts')}
          />
        </div>

        {/* 비용 */}
        <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 16 }}>
          <div className="kv">
            {/* ★「1계약 = N주」의 N 은 종목마다 다르다. ⛔상수를 적으면 BTC 에서 실제 체결과 갈린다.
                0.05 처럼 소수가 나오므로 부동소수 꼬리를 잘라서 적는다(최대 소수 3자리). */}
            <span className="kv__k">{t('contractsLabel', { n: +shares.toFixed(3) })}</span>
            <span className="kv__v num">{t('common:contracts', { count: contractsSafe })}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('premiumRow', { v: money(premium) })}</span>
            <span className="kv__v num">{money(total)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">
              {/* ★상수에서 유도 — FEE_OPTION_BP 가 바뀌면 표기도 따라온다 */}
              {t('common:fee')} <span style={{ fontSize: 11, opacity: 0.8 }}>({pct(FEE_OPTION_BP / 100, 2)})</span>
            </span>
            <span className="kv__v num">{money(fee)}</span>
          </div>
          <div className="divider" />
          <div className="kv kv--strong">
            {/* ★매도는 「총 내는 돈」이 아니다 — 프리미엄을 «받고» 증거금이 «잠긴다» */}
            <span className="kv__k">{t(action === 'sell' ? 'lockedMargin' : 'totalPay')}</span>
            <span className="kv__v num">{money(action === 'sell' ? shortMargin : total + fee)}</span>
          </div>
        </div>

        {err && (
          <div className="note" style={{ marginTop: 12, background: 'var(--down-weak)', color: 'var(--down)', fontWeight: 700 }}>
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.warn}</span>
            <span>{err}</span>
          </div>
        )}
        <div className="scroll-pad" />
      </div>

      <div style={{ padding: '12px 20px calc(28px + var(--sa-bottom, env(safe-area-inset-bottom)))', background: 'var(--surface)' }}>
        {/*
          ★★버튼이 죽은 «이유»를 화면이 말한다 (2026-08-21 President 지적).
            예전에는 `disabled={cash < payNow}` 뿐이라 ★회색 버튼만 남고 아무 말도 안 했다.

          ★왜 «푸터»인가 [실렌더로 정한 자리]: 확정 버튼은 «고정»이고 비용 카드는
            스크롤 아래에 있다. 처음 화면에서 이유를 카드 옆에 적으면 ★버튼은 보이는데
            이유는 «화면 밖»이다(실측: 390x844 첫 화면에 비용 카드가 안 들어온다).
            «막힌 것을 보는 자리»와 «이유를 읽는 자리»가 같아야 한다.
          ★높이를 항상 잡는다 — 행사가를 바꿀 때마다 버튼이 위아래로 튀지 않게.
          ⛔경고문이 아니다(President 「주의사항 전량 제거」). 숫자와 «다음 행동»만 적는다.
            · 1계약도 안 되면 → 1계약 값과 지금 현금을 나란히 적고, 살 수 있는 행사가로 «보낸다»
            · 살 수는 있는데 잔고가 상한이면 → 「최대 N계약」
        */}
        <div
          style={{
            minHeight: 20,
            marginBottom: 6,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            gap: '2px 10px',
          }}
        >
          {affordable === 0 ? (
            <>
              <span className="num" style={{ fontSize: 12.5, color: 'var(--t2)', fontWeight: 700 }}>
                {t('needPerContract', { v: money(quote(strike, 1).need), c: money(cash) })}
              </span>
              {cheaperIdx >= 0 && (
                <button
                  type="button"
                  onClick={() => setStrikeIdx(cheaperIdx)}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: 'var(--brand-ink)',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                    padding: '2px 0',
                    minHeight: 24,
                  }}
                >
                  {t('pickCheaperStrike', { v: strikeLabel(strikes[cheaperIdx]) })}
                </button>
              )}
            </>
          ) : (
            /* ★[2026-09-05] 계약 상한이 없어졌으니 「최대 N계약」은 «항상 현금이 정한 값»이다.
               예전의 `affordable < MAX_OPTION_CONTRACTS` 분기는 상한과 현금을 구분하려던 것인데,
               상한이 사라진 지금은 언제나 참이라 조건 자체가 죽은 코드다. ⇒ 지웠다. */
            <span className="hint num">{t('maxByCash', { n: maxContracts })}</span>
          )}
        </div>
        {/*
          ★스와이프 확정 제거(President 2026-08-19). 탭 1회로 체결하고,
            오조작은 주문 «직후» 5초 되돌리기로 복구한다.
          ★버튼 안에 총액을 같이 적는다 — 「얼마 나가는지」를 누르기 전에
            확인시키는 건 «마찰»이 아니라 정보다. 확인창과는 성격이 다르다.
        */}
        <button
          type="button"
          className={`btn btn--lg ${kind === 'call' ? 'btn--up' : 'btn--down'}`}
          disabled={cash < payNow}
          onClick={() => void submit()}
        >
          {action === 'sell' ? t('form.confirm') : kind === 'call' ? t('buyCall') : t('buyPut')}
          <span className="btn__sub num">{money(payNow)}</span>
        </button>
      </div>
    </div>
  );
}
