/**
 * 거래 일지 — 「거래 내역 N건」을 «여는» 화면 (2026-08-21 신설).
 *
 * ── 왜 이 화면이 없었나 ────────────────────────────────────────────────
 * 엔진은 개별 체결을 저장하지 않는다 [실측]. 그래서 설정에는 «건수»만 있었고
 * 그 행에는 셰브런조차 없었다(「열 화면이 없으므로 달지 않는다」는 주석이 붙어 있었다).
 * ⇒ 이제 store.journal 이 주문이 지나가는 자리마다 한 줄씩 남긴다. 이 화면이 그걸 읽는다.
 *
 * ── 화면 규율 ─────────────────────────────────────────────────────────
 * ★상품 구분은 «배지 하나»로 한다 — 파생 포지션 카드(PositionCard)와 «같은 문법»이다.
 *   ⛔상품마다 행 모양을 바꾸지 않는다(제품 UI 에서 가장 흔한 실패).
 * ★배지 라벨은 ★`derivatives:pos.badge*` 를 «그대로 쓴다». 표를 두 벌 두면
 *   같은 상품이 화면마다 다른 이름이 된다(U-4 의 콘셉트 배지 사고와 같은 형태).
 * ★손익·수수료는 스토어가 «엔진 원장 증분»으로 기록한 값을 그대로 그린다.
 *   ⛔화면이 다시 계산하지 않는다 — 옵션 매도는 계산식이 매수와 다르다.
 * ★행은 «고정 높이»다. 목록이 길어질 수 있어 VirtualList 를 쓰고, 가상 스크롤은
 *   좌표를 계산으로 구하므로 높이가 흔들리면 스크롤이 통째로 어긋난다.
 * ⛔blur · backdrop-filter · 큰 그림자 0건 (게임 루프와 GPU 를 공유한다).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Segment } from '../components/Primitives';
import { VirtualList } from '../components/VirtualList';
import { AdBanner } from '../components/AdBanner';
import { AD_RESERVED_H, adBlockH, adSlotVisible } from '../lib/ads';
import { useStore } from '../store/hooks';
import { bigMoney, money, num, signedBigMoney, signedMoney } from '../lib/format';
import { JOURNAL_MAX } from '../lib/constants';
import type { JournalEntry, JournalProduct } from '../lib/types';

/** 행 높이(px). ★VirtualList 좌표 계산과 «같은 값»이어야 하므로 상수 하나로 둔다 */
const ROW_H = 82;
/** 광고를 끼울 위치(행 인덱스). 첫 화면에 안 들어오도록 한 화면 아래로 민다 */
const AD_AT = 7;

/**
 * 상품 배지 — ★파생 4종은 `derivatives` 네임스페이스의 «그 표»를 그대로 참조한다.
 *   현물·레버리지 2종만 이 화면이 새로 이름을 갖는다.
 */
const PRODUCT: Record<JournalProduct, { cls: string; key: string }> = {
  spot: { cls: '', key: 'journal:product.spot' },
  leverage: { cls: 'pbadge--lev', key: 'derivatives:levCard' },
  futures: { cls: 'pbadge--fut', key: 'derivatives:pos.badgeFutures' },
  option: { cls: 'pbadge--opt', key: 'derivatives:pos.badgeOption' },
  forward: { cls: 'pbadge--fwd', key: 'derivatives:pos.badgeForward' },
  swap: { cls: 'pbadge--swp', key: 'derivatives:pos.badgeSwap' },
  /* ★매매가 «아닌» 항목 2종. 배지도 채움이 아니라 테두리다(.pbadge--rwd) */
  reward: { cls: 'pbadge--rwd', key: 'journal:product.reward' },
  /* ★배당은 «리워드가 아니다» — 게임이 주는 돈이 아니라 «내 종목»이 주는 돈이다.
     배지를 따로 둬야 유저가 「왜 돈이 들어왔지」를 한 눈에 가른다. */
  dividend: { cls: 'pbadge--div', key: 'journal:product.dividend' },
};

/** ★매매가 «아닌» 상품 — 손익 색·행위 라벨 문법을 타지 않는다 */
const GRANT = new Set<JournalProduct>(['reward', 'dividend']);

/** ★「파생」 필터가 «포함»하는 상품. ⛔`!== 'spot'` 으로 유도하지 마라(리워드가 섞인다) */
const DERIV = new Set<JournalProduct>(['leverage', 'futures', 'option', 'forward', 'swap']);

type Filter = 'all' | 'spot' | 'deriv';

export function Journal() {
  const s = useStore();
  const nav = useNavigate();
  const { t } = useTranslation('journal');
  const [filter, setFilter] = useState<Filter>('all');

  /* ★[-33] 거래 일지를 열어 본 것 = 포트폴리오 확인 → 홈 출석 시트의 「추가 지급(광고)」 버튼이 열린다 */
  useEffect(() => {
    s.notePortfolioView();
  }, [s]);

  const all = s.journal.entries;
  const list = useMemo(
    /*
     * ★「파생」은 ★«현물이 아닌 것»이 아니다 — 공유 리워드는 파생이 아니다.
     *   `!== 'spot'` 으로 두면 리워드 줄이 파생 탭에 섞인다(에러 없이 뜻만 틀린다).
     *   ⇒ 상품을 «명시»한다. 상품이 늘면 여기도 같이 늘어야 한다.
     */
    () =>
      filter === 'all'
        ? all
        : all.filter((e) => (filter === 'spot' ? e.product === 'spot' : DERIV.has(e.product))),
    [all, filter]
  );

  /*
   * ★광고가 «실제로 그려질 때만» 자리를 잡는다.
   *   가상 스크롤은 삽입 높이를 미리 잡으므로, 안 그려지는데 자리만 잡으면
   *   목록 한가운데에 «빈 구멍»이 남는다. 토스 밖은 이 앱의 정상 경로다.
   */
  const adOn = adSlotVisible('bannerJournal');

  const p = s.portfolio;
  /*
   * ★합계는 ★«엔진 원장»에서 온다(일지를 더하지 않는다).
   *   일지는 이번 업데이트부터 쌓이고 상한(JOURNAL_MAX)도 있어서, 일지를 더하면
   *   ★화면에 «틀린 합계»가 뜬다. 원장은 첫날부터의 전 기간 값이다.
   * ⇒ 그래서 둘이 다를 수 있다는 사실을 아래 hint 가 «사실대로» 말한다.
   */
  const realized = p?.realizedPnl ?? 0;
  const fees = p?.feesPaid ?? 0;
  const trades = p?.tradeCount ?? 0;
  /*
   * ★「합계에만 있는 옛 거래 N건」의 N. ★리워드 줄은 «거래가 아니다» —
   *   엔진 원장의 tradeCount 에 안 들어가므로 여기서도 빼야 «요약과 행이 어긋나지 않는다».
   *   안 빼면 리워드를 받을 때마다 N 이 1씩 줄어 「옛 거래가 사라진」 것처럼 보인다.
   */
  const tradeRows = all.reduce((n, e) => n + (GRANT.has(e.product) ? 0 : 1), 0);
  const missing = Math.max(0, trades - tradeRows);

  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar appbar--surface appbar--bordered">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:back')}>
          {Icon.back}
        </button>
        <span className="appbar__title">{t('title')}</span>
      </div>

      <div style={{ flex: '0 0 auto', padding: '10px 20px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <div className="sumrow" style={{ marginTop: 0 }}>
          <div>
            <div className="sumrow__k">{t('sumRealized')}</div>
            <div className={`sumrow__v num ${realized > 0 ? 'up' : realized < 0 ? 'down' : 'flat'}`}>{signedBigMoney(realized)}</div>
          </div>
          <div>
            <div className="sumrow__k">{t('sumFees')}</div>
            <div className="sumrow__v num">{bigMoney(fees)}</div>
          </div>
          <div>
            <div className="sumrow__k">{t('sumTrades')}</div>
            <div className="sumrow__v num">{t('countTimes', { n: num(trades) })}</div>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {missing > 0 ? t('noteMissing', { n: num(missing) }) : t('noteScope', { n: num(JOURNAL_MAX) })}
        </p>
        <div style={{ marginTop: 10 }}>
          <Segment<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('filterAll') },
              { value: 'spot', label: t('filterSpot') },
              { value: 'deriv', label: t('filterDeriv') },
            ]}
          />
        </div>
      </div>

      {list.length === 0 ? (
        <div className="scroll" style={{ padding: '0 20px' }}>
          <div className="card" style={{ marginTop: 18, padding: '30px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{all.length === 0 ? t('emptyTitle') : t('emptyFilterTitle')}</div>
            <p style={{ marginTop: 6, fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 }}>
              {all.length === 0 ? t('emptySub') : t('emptyFilterSub')}
            </p>
            {all.length === 0 && (
              <button className="btn btn--sub" style={{ marginTop: 16 }} onClick={() => nav('/stocks')}>
                {t('emptyCta')}
              </button>
            )}
          </div>
          <div className="scroll-pad" />
        </div>
      ) : (
        <VirtualList
          className="scroll"
          style={{ padding: '14px 20px 0' }}
          items={list}
          itemHeight={ROW_H}
          insert={adOn ? <AdBanner slot="bannerJournal" style={{ margin: '10px 0' }} /> : undefined}
          insertAt={adOn ? AD_AT : undefined}
          /* ★실렌더 점유 높이를 «유도»한다 — 옛 `+40` 은 실제(159)보다 3px 짧았다.
             여백 10 은 바로 위 `style={{ margin: '10px 0' }}` 와 «같은 값»이다. */
          insertHeight={adBlockH(AD_RESERVED_H.bannerJournal, 10)}
          renderItem={(e, i) => (
            <div
              key={e.id}
              style={{
                background: 'var(--surface)',
                borderLeft: '1px solid var(--line)',
                borderRight: '1px solid var(--line)',
                ...(i === 0 ? { borderTop: '1px solid var(--line)', borderRadius: '18px 18px 0 0' } : {}),
                ...(i === list.length - 1 ? { borderBottom: '1px solid var(--line)', borderRadius: '0 0 18px 18px' } : {}),
              }}
            >
              {i > 0 && <div className="divider divider--inset" />}
              <Row e={e} />
            </div>
          )}
        />
      )}
    </div>
  );
}

/* ── 한 줄 ──────────────────────────────────────────────────────────── */
function Row({ e }: { e: JournalEntry }) {
  const { t } = useTranslation('journal');
  const b = PRODUCT[e.product];
  const reward = e.product === 'reward';
  const dividend = e.product === 'dividend';
  /* ★매매가 아닌 줄은 «청산/개시» 축 자체가 없다 */
  const grant = GRANT.has(e.product);
  const closed = !grant && e.action !== 'open';
  const r = e.realized ?? 0;

  return (
    <div className="jrow" style={{ height: ROW_H }}>
      <div className="jrow__m">
        <div className="jrow__h">
          <span className={`pbadge ${b.cls}`}>{t(b.key)}</span>
          {/* ★리워드에는 «종목이 없다». 그 자리에 «무엇으로» 받았는지를 적는다.
              ⛔공유와 출석을 같은 말로 쓰지 마라 — 유저가 「왜 또 들어왔지」를 못 가린다.
                둘 다 product='reward' 라 `side` 로 가른다(저장본 변경 0). */}
          <span className="jrow__tk">
            {reward
              ? e.side === 'attendance'
                ? t('attendReward')
                : t('rewardShare')
              : /* ★배당은 종목이 «있을 수도 없을 수도» 있다 — 한 틱에 여러 종목이 지급되면
                   묶어서 한 줄이라 종목명이 없다. 그때는 「N개 종목」을 적는다.
                   ⛔빈 문자열을 그대로 두면 배지만 있고 «이름이 없는 줄»이 된다. */
                dividend
                ? e.ticker || t('divTickers', { n: num(e.count ?? 0) })
                : e.tickerB
                  ? t('pair', { a: e.ticker, b: e.tickerB })
                  : e.ticker}
          </span>
          {/* ★포트폴리오 «복사»로 낸 주문 — 누구를 따라 샀는지. 잔고·손익식과 무관한 표지다 */}
          {e.via && <span className="pbadge pbadge--copy">{t('copyTag', { name: e.via })}</span>}
        </div>
        <div className="jrow__d">{detail(t, e)}</div>
        <div className="jrow__w num">{when(t, e)}</div>
      </div>
      <div className="jrow__r">
        {/* ★청산·정산 = 실현 손익 · 개시 = 체결 금액. ★두 값을 «같은 자리»에 두되 색으로 가른다 */}
        {grant ? (
          /*
           * ★★손익 «색»(up/down)을 쓰지 않는다. 충전은 «벌어들인 돈»이 아니다 —
           *   초록으로 칠하면 일지 요약의 「실현 손익」과 «다른 뜻»이 같은 색으로 보인다.
           *   ⇒ 부호(+)로 «늘었다»만 말하고 색은 본문 색(--t1)을 쓴다.
           */
          /* ★배당만 소수 2자리다 — 충전은 만 단위지만 배당은 «$12.34» 같은 값이라
               0자리로 자르면 소액이 「+$0」으로 보인다(받았는데 0원이라는 작은 거짓말). */
          <div className="jrow__v num" style={{ color: 'var(--t1)' }}>
            {signedMoney(e.notional ?? 0, dividend ? 2 : 0)}
          </div>
        ) : closed ? (
          /* ★ 0 은 «이익도 손실도 아니다» — 「+$0.00」은 작은 거짓말이라 부호를 붙이지 않는다 */
          <div className={`jrow__v num ${r > 0 ? 'up' : r < 0 ? 'down' : 'flat'}`}>{r === 0 ? money(0) : signedMoney(r)}</div>
        ) : (
          /* ★개시 줄의 금액은 «부주인공»이다: 굵기 700 + 중립색.
             실현 손익(800 + 색)과 «같은 자리»에 있으므로 굵기로 위계를 만든다 */
          <div className="jrow__v num" style={{ color: 'var(--t2)', fontWeight: 700 }}>
            {money(e.notional ?? e.margin ?? 0)}
          </div>
        )}
        {/* ⛔수수료가 0 인 상품(선도·스왑·정산)에 「$0.00」을 찍지 않는다 — 없는 것과 0 은 다르다 */}
        {e.fee > 0.005 && <div className="jrow__f num">{t('feeShort', { v: money(e.fee) })}</div>}
      </div>
    </div>
  );
}

type TFn = (k: string, o?: Record<string, unknown>) => string;

/** 「D5 · 14:22」 — 게임 일차가 이 앱의 기본 시간 단위다. 실제 시각은 보조로 붙인다 */
function when(t: TFn, e: JournalEntry): string {
  const d = new Date(e.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${t('day', { n: num(e.gameDay) })} · ${hh}:${mm}`;
}

/**
 * 둘째 줄 — 「무엇을 얼마나」. ★상품마다 «다른 사실»이라 문장을 갈라 쓴다.
 * ⛔길어지면 잘린다(로케일마다 길이가 다르다). 그래서 토큰을 «2개까지»만 쓴다.
 */
function detail(t: TFn, e: JournalEntry): string {
  /* ★리워드는 매매가 «아니다» — 「무엇을 얼마나」가 아니라 「어디로 들어갔나」다.
     ⇒ 행위 라벨(매수/청산/정산) 문법 자체를 타지 않는다. */
  if (e.product === 'reward') return t('rewardToCash');
  /*
   * ★배당은 «행위»가 아니라 «수령»이다. 그리고 ★배당락을 «여기서» 설명한다 —
   *   토스트는 사라지지만 이 줄은 남는다. 「배당 받았는데 왜 물렸지」의 답이 항상 여기 있어야 한다.
   * ⛔경고문처럼 쓰지 마라. 기능 설명이다.
   * ★주당 배당금은 «한 종목일 때만» 뜻이 있다(여러 종목을 묶은 줄은 단가가 없다).
   */
  /*
   * ☠️★[2026-08-23 실렌더 확인으로 잡음] 여기에 «두 토막»을 넣으면 안 된다.
   *   처음엔 「현금으로 받았어요 · 배당을 준 만큼 주가도 조정돼요」로 썼는데
   *   스크린샷에서 ★「… 배당을 준 만큼 주가도 조…」로 «잘렸다».
   *   `.jrow__d` 가 `white-space:nowrap; text-overflow:ellipsis` 라서다(app.css:2385).
   *   ⇒ ★가장 중요한 «배당락 설명»이 잘려 나갔다. ⛔주당 단가 같은 «곁가지»를 앞에 두지 마라.
   *   ★그리고 `innerText` 검사로는 이걸 «못 잡는다» — CSS 말줄임은 텍스트를 안 바꾼다.
   *     그래서 검사기에 `scrollWidth > clientWidth` 항목을 따로 넣었다.
   */
  if (e.product === 'dividend') return t('divExNote');
  const act = actionLabel(t, e);
  switch (e.product) {
    case 'spot':
      return join(act, t('atPrice', { q: num(e.qty ?? 0, e.qty && e.qty < 10 ? 2 : 0), v: money(e.price ?? 0) }));
    case 'leverage':
    case 'futures':
      return join(act, t('levSize', { x: num(e.leverage ?? 0), v: money(e.margin ?? 0, 0) }));
    case 'option':
      return join(
        act,
        t('optSize', {
          k: t(e.optKind === 'put' ? 'put' : 'call'),
          n: num(e.qty ?? 0),
          s: money(e.strike ?? 0),
        })
      );
    case 'forward':
      return join(act, t('notional', { v: money(e.notional ?? 0, 0) }));
    case 'swap':
      return join(act, t('notional', { v: money(e.notional ?? 0, 0) }));
    default:
      return act;
  }
}

function join(a: string, b: string): string {
  return b ? `${a} · ${b}` : a;
}

/**
 * 무슨 «행위»였나.
 * ★현물은 매수/매도, 파생은 개시/청산이 자연스럽다 — 억지로 한 단어로 묶지 않는다.
 * ★옵션은 «매수인지 매도인지»가 손익식을 가르는 축이라 청산 줄에도 그대로 남긴다.
 * ★강제 정리(liquidated)와 만기 정산(settle)은 «다른 일»이다. 같은 말로 쓰면 안 된다.
 */
function actionLabel(t: TFn, e: JournalEntry): string {
  if (e.action === 'liquidated') return t('actLiquidated');
  if (e.action === 'settle') return t('actSettled');
  if (e.product === 'spot') return t(e.side === 'buy' ? 'actBuy' : 'actSell');
  if (e.product === 'option') {
    /*
     * ★옵션 청산은 «되파는 것»(매수 포지션)과 «되사는 것»(매도 포지션)이 서로 반대 동작이다.
     *   한 단어(「청산」)로 묶으면 같은 줄이 두 가지 뜻을 갖는다 — 그래서 4갈래로 쓴다.
     */
    if (e.action === 'open') return t(e.optSide === 'sell' ? 'optOpenSell' : 'optOpenBuy');
    return t(e.optSide === 'sell' ? 'optCloseSell' : 'optCloseBuy');
  }
  if (e.action === 'open') {
    const dir = dirLabel(t, e);
    return dir ? t('actOpenOf', { s: dir }) : t('actOpen');
  }
  return t('actClose');
}

/**
 * 방향 — 레버리지·선물·선도는 롱/숏, 스왑은 「{{종목}} 쪽」이다.
 * ⛔스왑에 «회사 이름»과 «조사»를 넣지 않는다(U-2 ⛔4): 한국어 조사는 받침에 따라 갈리고
 *   회사 이름은 길어서 줄이 접힌다. 그래서 «티커» + 조사가 필요 없는 「~ 쪽」이다.
 */
function dirLabel(t: TFn, e: JournalEntry): string {
  if (e.product === 'swap') return t('swapSide', { s: e.side === 'b' ? (e.tickerB ?? e.ticker) : e.ticker });
  if (e.side === 'long') return t('long');
  if (e.side === 'short') return t('short');
  return '';
}
