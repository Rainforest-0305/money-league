import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Icon, PriceText, Segment, TickerTile } from '../components/Primitives';
import {
  AreaChart,
  CandleChart,
  FlowGauge,
  VolumeBars,
  buildCandles,
  movingAverage,
} from '../components/Charts';
import { OrderSheet } from '../components/OrderSheet';
import { AdBanner } from '../components/AdBanner';
import { metaOf, useQuote, useStore, useTick } from '../store/hooks';
import type { MacroType } from '../lib/types';
import { gameDaysToRealMinutes, money, num, pct, signedMoney, signedPct } from '../lib/format';
import {
  CANDLE_UNIT_GAME_DAYS,
  MA_LONG_DIVISOR,
  MA_MIN_WINDOW_TICKS,
  MA_SHORT_DIVISOR,
  MOOD_WINDOW_TICKS,
  PRICE_HISTORY_LEN,
  TICKS_PER_GAME_DAY,
  VOLUME_BUCKET_TICKS,
  ticksPerCandleDays,
} from '../lib/constants';
import { BOTS } from '../data/bots.generated';
import { CONCEPT_BADGE } from '../components/ConceptBadge';
/* ★엔진이 «실제로 지급할 때 쓰는 그 함수»를 그대로 쓴다. 화면이 따로 계산하면 언젠가 갈라진다 */
import { DIVIDEND_INTERVAL_GAME_DAYS, annualYieldOf } from '../lib/engine/dividends';

/**
 * 차트 기간 — ★«게임 시간» 기준이다.
 *
 * ── 왜 갈아엎었나 (2026-08-19, Partner 실측) ────────────────────────────
 * 예전 정의는 라벨과 데이터가 «전부» 어긋나 있었다:
 *     라벨   틱     실제시간   게임시간
 *     1시간  120    4분        0.8게임일   ← 1시간이 아니다
 *     하루   300    10분       2게임일     ← 하루가 아니다(2배)
 *     1주    600    20분       4게임일     ← 1주(7일)가 아니다
 *     1달    900    30분       6게임일     ← ★5배 틀림. 게다가
 *   PRICE_HISTORY_LEN=900틱(=6게임일)이 «존재하는 전부»라 「1달」은 데이터가
 *   아예 없었다. 라벨만 그렇게 붙어 있었던 것이다.
 *
 * 유저가 「하루」를 눌렀는데 2게임일이 나오면 시간 감각이 통째로 깨진다.
 * 그래서 기간을 «게임일»로 정의하고, 틱 수는 상수에서 «유도»한다.
 * 만기(3·5·7게임일)·펀딩(게임일당)과 같은 단위라 앱 전체가 한 단위로 맞는다.
 */
type Period = 'd1' | 'd2' | 'd4' | 'all';
/** 히스토리 전체가 몇 게임일치인가 — 900틱 / 150틱 = 6 */
const HISTORY_GAME_DAYS = PRICE_HISTORY_LEN / TICKS_PER_GAME_DAY;
/**
 * ★[2026-08-26] 「0.5일」을 뺐다 — «봉 단위 개편에 딸려온» 정리다.
 *   0.5게임일 = 75틱이다. 그 구간에서는
 *     · 봉으로 못 선다(1일봉 기준 0봉)
 *     · 거래량 칸(30틱)이 2칸뿐이다
 *     · 라인 이동평균 창이 9틱 = «구간의 1/8» 이라 원본선과 겹친다
 *   ⇒ 화면이 «응답은 하는데 아무것도 안 보이는» 유일한 구간이었다. 지웠다.
 *   ⇒ 남은 4개는 전부 봉·막대·평균선이 «다 서는» 구간이다.
 */
const PERIOD_GAME_DAYS: Record<Period, number> = {
  d1: 1,
  d2: 2,
  d4: 4,
  all: HISTORY_GAME_DAYS,
};
const POINTS: Record<Period, number> = Object.fromEntries(
  (Object.keys(PERIOD_GAME_DAYS) as Period[]).map((k) => [
    k,
    Math.min(PRICE_HISTORY_LEN, Math.round(PERIOD_GAME_DAYS[k] * TICKS_PER_GAME_DAY)),
  ])
) as Record<Period, number>;

/**
 * ★★봉 단위 — President 확정 「1일봉으로 가」(2026-08-26).
 *
 * ★1봉 = 게임 1일. 단위는 «하나»뿐이고, 그 하나가 설 수 있는 기간도 «전체»뿐이다:
 *     히스토리 900틱 = 6 게임일 ⇒ 1일봉 6개가 «존재하는 전부»다.
 *     1일 구간이면 1봉, 2일이면 2봉 — 차트가 아니라 «막대 몇 개»다.
 *   ⇒ 그래서 캔들 모드는 ★기간을 «전체로 고정»한다. 고를 수 있는 척하지 않는다.
 *   ⇒ 그 대신 기간 알약이 있던 자리에 «지금 보고 있는 것»을 한 줄로 적는다.
 *
 * ⛔단위 알약(30초·1분·5분)을 되살리지 마라. 그건 «실제 시간» 표기였고,
 *   1봉이 게임 1일이 된 이상 그 이름은 전부 거짓말이다.
 */
const CANDLE_GAME_DAYS = CANDLE_UNIT_GAME_DAYS[0];
const CANDLE_TICKS = ticksPerCandleDays(CANDLE_GAME_DAYS);

/**
 * 시황 한 줄의 색조 — ★MacroCard 의 LOOK 과 «같은 규칙»이다(카드 색 = 일의 종류, 방향 아님).
 * ⛔두 곳에서 색이 갈리면 같은 사건이 화면마다 다른 색이 된다.
 */
const MACRO_TONE: Record<MacroType, string> = {
  rate_cut: 'macro--brand',
  earnings_season: 'macro--gold',
  recession_fear: 'macro--warn',
};

export function StockDetail() {
  const { ticker = 'NVDA' } = useParams();
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('stock');
  const ko = i18n.language !== 'en';
  const m = metaOf(ticker);
  const q = useQuote(ticker);

  /*
   * ★진행 중인 시황이 «이 종목»을 건드리고 있을 때만 값이 있다.
   *   ★useTick() 이 위에 있어 매 틱 재평가된다 — Map 조회 1회라 비용이 없다.
   */
  const macro = s.macro && s.macroTouches(ticker) ? s.macro : null;

  /**
   * ★기본 기간 = «전체» (2026-08-26, 옛 기본값은 'd1').
   *
   * ★★캔들이 «전체» 고정이 되면서 기본값을 맞췄다 — 그래야 라인↔봉 전환이
   *   ★«보는 구간»을 안 바꾼다. 표현만 바뀐다. (옛 기본값이면 「1일봉」을 누르는
   *   순간 구간이 1일→6일로 조용히 넓어진다. 유저는 자기가 뭘 눌렀는지 모른다.)
   * ★덤: 거래량이 «읽히는» 상태로 시작한다. 이 게임의 한 종목 체결은 듬성듬성해서
   *   [실측 · NVDA · 시드 20260822] 1게임일 구간이면 30틱짜리 칸 5개 중 ★1개만 찼다.
   *   전체(900틱)면 30칸 중 14칸이 찬다. 같은 데이터, 다른 창.
   */
  const [period, setPeriod] = useState<Period>('all');
  const [chart, setChart] = useState<'line' | 'candle'>('line');
  const [order, setOrder] = useState<'buy' | 'sell' | null>(null);
  /**
   * ★★가격·거래대금·«그때의 틱»을 ★한 번에 잡는다.
   *
   * ⛔예전에는 가격만 `await seriesOf(...)` 로 받고 거래대금은 동기로 받았다.
   *   그 사이에 틱이 지나가면 두 배열이 «한 칸 어긋난» 채 같은 x축에 그려진다.
   *   ★게다가 봉을 게임일 경계에 맞추려면 「이 배열의 마지막 점이 몇 번째 틱인가」가
   *     필요한데, 그건 배열 안에 없다 — ★같은 순간에 같이 잡아 둬야 한다.
   * ★`s.series` 는 동기다(`seriesOf` 는 그 위의 deprecated 래퍼였다).
   */
  const [win, setWin] = useState<{ series: number[]; gross: number[]; net: number[]; tick: number }>({
    series: [],
    gross: [],
    net: [],
    tick: 0,
  });

  /** 캔들 모드는 «전체» 고정이다 — 1일봉이 설 수 있는 유일한 구간이라서다 */
  const points = chart === 'candle' ? PRICE_HISTORY_LEN : POINTS[period];

  useEffect(() => {
    const f = s.flowSeries(ticker, points);
    setWin({ series: s.series(ticker, points), gross: f.gross, net: f.net, tick: s.tick });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, points, s.tickVersion]);

  const series = win.series;
  const flow = win;

  /*
   * ★이동평균 창 — 「20일선·60일선」을 그대로 옮기지 «않았다».
   *   이 게임의 히스토리는 900틱(6 게임일)이 전부라 20일선은 «데이터가 없다».
   *   대신 «지금 보고 있는 구간»에 비례시킨다: 단기 = 구간/8, 장기 = 구간/3.
   *   ⇒ 0.5일을 보면 짧은 평균도 짧아지고, 전체를 보면 길어진다. 화면과 지표가 늘 맞는다.
   * ★숫자는 전부 상수에서 «유도»한다. 라벨에도 숫자를 박지 않는다(오늘 라벨 오류 7건의 원인).
   */
  const maWin = useMemo(() => {
    const n = series.length;
    const short = Math.max(MA_MIN_WINDOW_TICKS, Math.round(n / MA_SHORT_DIVISOR));
    const long = Math.max(short * 2, Math.round(n / MA_LONG_DIVISOR));
    return { short, long, ok: n >= long + 1 };
  }, [series.length]);
  const maS = useMemo(() => (maWin.ok ? movingAverage(series, maWin.short) : undefined), [series, maWin]);
  const maL = useMemo(() => (maWin.ok ? movingAverage(series, maWin.long) : undefined), [series, maWin]);

  /**
   * ★★마지막 봉에 들어갈 틱 수 — «게임일 경계»에 봉을 맞추는 유일한 입력값이다.
   *
   * ★엔진의 하루는 [150k, 150k+149] 다(gameDay = floor(tick / TICKS_PER_GAME_DAY)).
   *   그러니 최신 틱 T 가 속한 «오늘»에 이미 쌓인 틱 수는 (T % 150) + 1 이다.
   * ★이렇게 맞추면 지나간 봉이 ★«고정»된다. 안 맞추면 창이 매 틱 1칸씩 미끄러져
   *   6봉짜리 화면에서 봉이 눈에 띄게 꿈틀거린다(그리고 「1일봉」이라는 이름도
   *   「하루치 분량」이라는 약한 뜻으로 내려앉는다).
   * ★거래량 막대에 ★같은 값을 넘긴다 — 한 칸이라도 밀리면 막대와 봉이 다른 시각이 된다.
   */
  const tailFor = (step: number) => (win.tick % step) + 1;
  const barTail = tailFor(CANDLE_TICKS);

  const bars = useMemo(() => buildCandles(series, CANDLE_TICKS, barTail), [series, barTail]);
  /*
   * ★★[2026-08-26 제거] 캔들 이동평균 — President 「너 판단대로 해」, Partner 확정.
   *
   *   1봉 = 게임 1일이 되면서 도달 가능한 봉이 ★«6개»로 고정됐다.
   *   그 6봉에서 규칙(candleMaWindows)이 내는 창은 항상 2봉 / 4봉이고,
   *   4봉 평균은 그려지는 점이 ★«3개»다 — 「선」의 최소 요건을 가스로 넘는다.
   *   ⇒ 화면에서는 오른쪽 절반에만 짧게 뚝 떨어진다. 그건 정보가 아니라 ★잔해다.
   *
   * ★President 과거 지시 「이평선 제대로 나오게 고쳐」는 «반쪽짜리를 남겨두라»가 아니다.
   *   6봉에서 제대로 나오게 할 방법이 없으면 ★«빼는 것»이 그 지시에 부합한다.
   * ⛔라인 모드는 «그대로»다 — 900틱을 통째로 쓰므로 평균이 정상적으로 선다.
   *   그쪽까지 지우지 마라. President 지시의 원래 대상이 라인 쪽이다.
   *
   * ★★«언제 되살리나»를 사람 기억에 맡기지 않는다:
   *   `scripts/check_chart_windows.mjs` 가 매 실행 «지금 봉 수»로 규칙을 돌려서
   *   평균선이 «정보가 되는» 순간(minBarsForMa() 이상)이 오면 ★FAIL 로 알린다.
   *   그때 이 블록을 되살리면 된다(그 검사기에 되살리는 법이 적혀 있다).
   */

  const price = q?.price ?? m.initialPrice;
  const chg = q?.totalChangePct ?? 0;
  const chgAbs = price - m.initialPrice;
  const holding = s.portfolio?.holdings.find((h) => h.ticker === ticker);
  const watched = s.watchlist.includes(ticker);
  /* ★연 배당수익률. 무배당 종목·지수·원자재·코인은 0 이고, 0 이면 아래에서 «줄을 안 그린다» */
  const divYield = annualYieldOf(m.ticker, m.sectorKo, m.assetClass);

  /**
   * "지금 분위기" — ★이제 «실제» 주문흐름이다.
   *
   * ★예전 구현은 최근 가격 수익률을 tanh 로 눌러 만든 «프록시»였고, 주석은
   *   「서버가 netOrderFlow 를 아직 공개하지 않아」라고 적혀 있었다.
   *   이 빌드에는 서버가 «없고», 엔진은 처음부터 netOrderFlow 를 갖고 있었다.
   *   지금은 틱별로 링버퍼에 쌓으므로 근사할 이유가 사라졌다.
   * ★계산: 한 틱의 gross = |매수|+|매도|, net = 매수-매도 ⇒ 매수액 = (gross+net)/2.
   *   최근 MOOD_WINDOW_TICKS 틱을 합쳐 비율을 낸다.
   */
  const buyPct = useMemo(() => {
    const g = flow.gross;
    const nt = flow.net;
    if (g.length === 0) return 50;
    const from = Math.max(0, g.length - MOOD_WINDOW_TICKS);
    let sg = 0;
    let sn = 0;
    for (let i = from; i < g.length; i++) {
      sg += g[i];
      sn += nt[i];
    }
    if (!(sg > 0)) return 50;
    const buy = (sg + sn) / 2;
    return Math.round(Math.max(2, Math.min(98, (buy / sg) * 100)));
  }, [flow]);

  const volLabel = m.sigma > 0.38 ? t('volHigh') : m.sigma > 0.26 ? t('volMid') : t('volLow');
  const volDots = m.sigma > 0.38 ? '●●●' : m.sigma > 0.26 ? '●●○' : '●○○';

  // 이 종목을 거래한 참가자 샘플 (봇 로스터 실데이터)
  const traders = useMemo(() => {
    const h = [...ticker].reduce((a, c) => a + c.charCodeAt(0), 0);
    return [0, 1, 2].map((i) => {
      const b = BOTS[(h * 7 + i * 53) % BOTS.length];
      return {
        nickname: b.nickname,
        buy: (h + i) % 3 !== 2,
        qty: 40 + ((h * (i + 3)) % 900),
        /* ★아이콘을 «지어내지» 않는다 — 그 참가자의 «실제 콘셉트»를 그린다.
           표는 ConceptBadge 한 벌뿐이라 랭킹·프로필과 같은 그림이 나온다. */
        strategy: b.strategy,
        bg: ['var(--gold-weak)', 'var(--brand-weak)', 'var(--down-weak)'][i],
        ink: ['var(--gold-ink)', 'var(--brand-ink)', 'var(--down-ink)'][i],
        ago: [0, 14, 32][i],
      };
    });
  }, [ticker]);

  return (
    <div className="screen" style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:back')}>
          {Icon.back}
        </button>
        <TickerTile meta={m} size="xs" />
        <span style={{ fontSize: 17, fontWeight: 800 }}>{ko ? m.nameKo : m.nameEn}</span>
        <button
          className="iconbtn"
          style={{ marginLeft: 'auto' }}
          onClick={() => s.toggleWatch(ticker)}
          aria-label={watched ? t('watchRemove') : t('watchAdd')}
          aria-pressed={watched}
        >
          {Icon.star(watched)}
        </button>
      </div>

      <div className="scroll">
        <div style={{ padding: '2px 20px 0' }}>
          <div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 600 }}>
            {m.ticker} · {ko ? m.sectorKo : m.sectorEn} · {ko ? m.tierKo : m.tierEn}
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', marginTop: 4 }}>
            <PriceText value={price} render={(v) => money(v)} />
          </div>
          <div className={`num ${chg >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
            {signedMoney(chgAbs)} ({signedPct(chg)}){' '}
            <span style={{ color: 'var(--t3)', fontWeight: 500 }}>{t('common:today')}</span>
          </div>
          {/*
            ★배당수익률 — ⛔0 이면 «줄 자체를 숨긴다». 「0.0%」로 찍으면
              「배당이 있는데 지금 0」으로 읽힌다. 없는 것과 0 은 다르다.
            ★금·원유·비트코인·이더리움·지수는 `annualYieldOf` 가 assetClass 로 걸러 0 을 준다
              (President 지시: 「금이나 가상자산은 당연히 아니겠지만」) ⇒ 여기서 «자동으로» 안 뜬다.
              ⛔화면이 종목 종류를 다시 판정하지 마라 — 엔진이 쓰는 «그 함수»를 그대로 쓴다.
            ★배당락을 여기서도 말한다 — 사는 «결정을 하는 자리»가 여기다.

            ★★[2026-08-26 밀도] 두 줄 → ★한 줄.
              President 지적: 「설명문이 값과 같은 무게로 읽힌다」. 실제로 그랬다 —
              12px/700 한 줄 아래 11px/500 한 줄이 붙어 ★36px 짜리 «덩어리»가 되어
              바로 위 36px 가격과 경쟁했다. 위계가 아니라 «두 번째 제목»이었다.
            ⇒ 값(수익률·주기)만 잉크를 올리고, 배당락은 ★같은 줄의 «꼬리»로 내린다.
              사실은 하나도 안 지웠다. 무게만 바꿨다.
          */}
          {divYield > 0 && (
            <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.45, color: 'var(--t3)' }}>
              <b style={{ fontWeight: 700, color: 'var(--t2)' }}>
                {t('divYield', { v: pct(divYield * 100, 1), d: num(DIVIDEND_INTERVAL_GAME_DAYS) })}
              </b>{' '}
              {t('divExShort')}
            </div>
          )}
        </div>

        {/*
          ★★차트 블록 (2026-08-26 재구성 — President 「UI 좀더 이쁘게 · AI 티」)

          ⛔전(前) 상태 [실렌더로 셈]: 차트 아래에 «줄»이 6개였다.
              ① 범례(거래량 + 평균선)  ② 시가 / 기간·단위 설명  ③ 기간 알약 5개
              ④ 게임↔실제 환산 문구    ⑤ 라인/캔들 2개        ⑥ 단위 3개
            ⇒ ★버튼 10개가 3줄. 그리고 차트 종류 토글이 ★첫 화면 밖에 있었다
              (390x652 에서 ⑤⑥ 이 접힌다 — 스크롤해야 캔들로 바꿀 수 있었다).
          ★후: ★2줄. ① 컨트롤 한 줄(기간 + 종류) ② 범례 한 줄.
            · 단위 3개 = ★삭제(단위가 하나뿐이면 그건 버튼이 아니라 이름이다 — 토글이 말한다)
            · 환산 문구 = ★화면 맨 아래 고지문으로 이동(항상 볼 필요가 없다)
            · 「시작가 $x」 = ★삭제(바로 위 「-$2.02 (-0.56%) 오늘」 이 정확히 그 차이다)
        */}
        <div style={{ marginTop: 14 }}>
          {chart === 'line' ? (
            <AreaChart data={series} height={176} maShort={maS} maLong={maL} />
          ) : (
            <CandleChart bars={bars} height={200} />
          )}
          {/* ★거래량 — 가격 차트 «아래», 낮은 높이. 색은 그 구간의 매수/매도 우위다.
              ★★칸 폭을 «시간»으로 넘긴다. 캔들이면 봉과 같은 틱 수(막대 하나 = 봉 하나),
                라인이면 VOLUME_BUCKET_TICKS.
              ⛔칸 «개수»(48 고정)로 되돌리지 마라 — 1게임일 구간에서 3.1틱/칸이 되어
                실측 48칸 중 막대 2개만 그려졌다(거래 0인 칸은 안 그린다). */}
          <VolumeBars
            gross={flow.gross}
            net={flow.net}
            groupTicks={chart === 'candle' ? CANDLE_TICKS : VOLUME_BUCKET_TICKS}
            tail={chart === 'candle' ? barTail : tailFor(VOLUME_BUCKET_TICKS)}
            height={44}
            emptyLabel={t('volumeEmpty')}
          />
        </div>

        {/*
          범례 — ★«지금 화면에 실제로 그려진 것»만 적는다.

          ⛔라인 모드에 「38초 평균」처럼 ★실제 시간을 적지 «마라». 이 화면의 시간은
            전부 게임 시간인데 거기만 실제 시간이면 한 화면에 두 시계가 돈다.
            라인의 창은 «보고 있는 구간의 1/8·1/3» 이라 게임일로 적으면 0.1일 같은
            값이 나온다 — 숫자가 정보를 못 나른다. ⇒ 길이를 «이름»으로 말한다.
        */}
        <div className="chartlegend">
          <span className="chartlegend__k">{t('volumeLabel')}</span>
          {/* ★★캔들 분기가 «없다» — 캔들 모드엔 평균선을 안 그리기 때문이다(2026-08-26).
              ⛔「평균선은 N봉부터」 같은 «없는 걸 설명하는» 줄도 같이 뺐다.
                사실이긴 하지만 유저가 이 화면에서 할 수 있는 일이 없는 사실이라 잡음이다.
              ★라인 모드는 그대로 둘 다 말한다 — 거기엔 선이 «실제로» 있다. */}
          {chart === 'line' && maWin.ok && (
            <>
              <LegendItem dashed={false} label={t('maShort')} />
              <LegendItem dashed label={t('maLong')} />
            </>
          )}
        </div>

        {/*
          ★★컨트롤 한 줄 — 「무엇을 볼까(기간)」와 「어떻게 볼까(종류)」를 ★같은 높이에 둔다.

          ★캔들 모드에는 기간이 «없다»(1일봉은 전체 구간에서만 선다). 그래서 알약 대신
            «지금 보고 있는 것»을 같은 자리에 한 줄로 적는다 —
            ⛔행을 «지우지» 않는다: 지우면 모드를 바꿀 때마다 아래 내용이 34px 뛴다.
          ★종류 토글이 ★단위 이름을 그대로 말한다(「1일봉」). 그래서 단위 줄이 필요 없다.
        */}
        <div className="chartctl">
          {chart === 'line' ? (
            <div className="pillrow pillrow--flush">
              {(Object.keys(PERIOD_GAME_DAYS) as Period[]).map((p) => (
                <button
                  key={p}
                  className={`pill ${period === p ? 'pill--on' : ''}`}
                  onClick={() => setPeriod(p)}
                  aria-pressed={period === p}
                >
                  {p === 'all' ? t('periodAll') : t('periodGameDays', { d: PERIOD_GAME_DAYS[p] })}
                </button>
              ))}
            </div>
          ) : (
            <span className="chartctl__now">{t('candleSpan', { d: num(HISTORY_GAME_DAYS) })}</span>
          )}
          {/* ⛔세그를 손으로 다시 짜지 않는다 — 앱에 이미 한 벌(Primitives.Segment)이 있다.
              두 벌이 되면 선택 표시·키보드 동작이 화면마다 갈린다. */}
          <Segment
            className="seg--sm"
            ariaLabel={t('chartType')}
            value={chart}
            onChange={setChart}
            options={[
              { value: 'line', label: t('chartLine') },
              { value: 'candle', label: t('chartCandle') },
            ]}
          />
        </div>


        {/* 내가 가진 것 */}
        <div className="sec">
          <h3 className="sec__h">{t('myHolding')}</h3>
          {holding ? (
            <div className="card card--sub" style={{ padding: '6px 16px' }}>
              <div className="kv">
                <span className="kv__k">{t('qty')}</span>
                <span className="kv__v num">{t('common:shares', { count: Math.round(holding.qty) })}</span>
              </div>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">{t('avgCost')}</span>
                <span className="kv__v num">{money(holding.avgCost)}</span>
              </div>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">{t('value')}</span>
                <span className="kv__v num">{money(holding.qty * price)}</span>
              </div>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">{t('profit')}</span>
                <span className={`kv__v num ${holding.pnl >= 0 ? 'up' : 'down'}`}>
                  {signedMoney((price - holding.avgCost) * holding.qty)} ({signedPct((price / holding.avgCost - 1) * 100)})
                </span>
              </div>
            </div>
          ) : (
            <div className="card card--sub" style={{ padding: 16, fontSize: 12, color: 'var(--t3)' }}>{t('notOwned')}</div>
          )}
        </div>

        {/*
          ★「지금 이 종목에 영향을 주는 일」 (2026-08-20 신설)

          ★★왜 홈에만 두지 «않는가»: 「어느 종목을 살까」의 판단은 ★종목 화면에서 일어난다.
            홈에서 업종을 봤어도, 이 종목을 열었을 때 그 사실이 사라지면 고리가 끊긴다.
          ★★그러나 ⛔«방향을 주지 않는다» — 「이 종목이 오른다」를 찍어 주면 그건 떠먹이는 것이고,
            실적 시즌에는 ★사실도 아니다(같은 업종에서도 종목마다 부호가 갈린다).
            ⇒ 「지금 이런 일이 있다」까지만. 그 일이 이 종목에 «어떻게» 작용하는지는 유저가 본다.
          ★판정은 store.macroTouches() — ★엔진이 이 티커에 «실제로 꽂아 둔» driftBonus 유무다.
            선언된 sectors 목록이 아니라 «적용된 값»을 본다(지어낸 숫자를 만들지 않는다).
          ★위치: 차트·보유 바로 «다음», 「지금 분위기」 앞. 분위기(주문흐름)는 «몇 초»의 일이고
            시황은 «며칠»의 일이라, 긴 것부터 짧은 것 순으로 읽히게 둔다.
        */}
        {macro && (
          <div className="sec">
            <div className={`macroline ${MACRO_TONE[macro.type]}`}>
              <span className="macroline__k">{t('macroNow')}</span>
              <span className="macroline__v">{t(`common:${macro.titleKey}`)}</span>
            </div>
          </div>
        )}

        {/* 지금 분위기 — 가격엔진 30% 임팩트의 사용자 언어 번역 */}
        <div className="sec">
          <h3 className="sec__h">{t('mood')}</h3>
          <div className="card card--pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 800 }}>
              <span className="up">{t('buyers', { p: `${buyPct}%` })}</span>
              <span className="down">{t('sellers', { p: `${100 - buyPct}%` })}</span>
            </div>
            <FlowGauge buyPct={buyPct} />
            <p style={{ fontSize: 12, color: 'var(--t3)', marginTop: 11, lineHeight: 1.5 }}>
              <Trans
                i18nKey={buyPct >= 50 ? 'stock:moodBuy' : 'stock:moodSell'}
                components={{ b: <b className={buyPct >= 50 ? 'up' : 'down'} /> }}
              />
            </p>
            {/*
              ★[제거 2026-08-19] 「최근 1분 거래」·「참여 트레이더」 2칸.
                값이 각각 `3000 + sigma*42000` / `12 + rank%40` 이었다 — 엔진 어디에도
                없는 «지어낸 숫자»다. 게다가 「1분」은 이 게임에 존재하지 않는 단위다
                (1틱 2초 · 1게임일 5분). 표기와 실제가 맞을 수가 없었다.
              ★대신 «실제로 계산되는 값»만 남긴다: 변동성 + 하루 변동폭(σ 유도).
                없는 지표를 만들어 채우지 않는다.
            */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <Stat label={t('volatility')} value={`${volLabel} ${volDots}`} />
              <Stat label={t('dailyRange')} value={pct(m.sigma * 100, 1)} />
            </div>
          </div>
        </div>

        {/*
          ★B3 — 종목 상세 배너 (2026-08-21 신설).
            ★이 화면에는 배너가 «아예 없었다» — 100종목 목록에서 탭할 때마다 들어가는,
              앱에서 가장 자주 열리는 화면인데 지면이 0이었다.
          ⛔자리를 «여기»로 잡은 이유 (정책 원문: 「사용자 상호작용 요소와 인접하게
            광고를 배치하여 의도치 않은 클릭이 발생하도록 하는 구조」 금지):
              · 이 화면 하단에는 «고정» 주문바(.orderbar, 사기/팔기)가 있다.
              · 배너를 «맨 끝»에 두면 스크롤을 내렸을 때 그 버튼과 맞닿는다.
              ⇒ 그래서 아래에 남은 내용이 «많은» 자리에 둔다(거래한 사람들 · 시황 ·
                레버리지 CTA · 고지문). 끝까지 내려도 배너는 주문바에서 멀리 있다.
              · 그리고 차트·기간 알약보다 «아래»라 첫 화면에도 들어오지 않는다.
            ★두 거리(첫 화면 · 주문바)는 ★실렌더로 «잰다». 추측으로 두지 않는다.
        */}
        {/*
          ★여백을 `AdBanner` 에 «직접» 준다(30/30 = 이 화면의 `.sec` 리듬 그대로).
            예전에는 `<div className="sec">` 로 감쌌다 — 지금은 마진 상쇄 덕에 «보이지는»
            않았지만 광고가 없을 때 빈 `.sec` 가 남는 «같은 구조»다(프로필·파생에서는 실제로 보였다).
            `scripts/verify_adgaps.py` 가 「광고 없음 상태에 빈 상자 0개」를 매 실행 검사한다.
        */}
        <AdBanner slot="bannerStockDetail" style={{ margin: '30px 20px 0' }} />

        {/* 이 종목 거래한 사람들 */}
        <div className="sec">
          <h3 className="sec__h">{t('whoTraded')}</h3>
          <div className="card" style={{ padding: '6px 0' }}>
            {traders.map((tr) => (
              <div key={tr.nickname} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
                <span
                  style={{ width: 28, height: 28, borderRadius: '50%', background: tr.bg, color: tr.ink, display: 'grid', placeItems: 'center', flex: '0 0 auto' }}
                  aria-hidden
                >
                  {CONCEPT_BADGE[tr.strategy]?.icon}
                </span>
                <span style={{ fontSize: 12 }}>
                  <b>{tr.nickname}</b>{' '}
                  <span className={tr.buy ? 'up' : 'down'} style={{ fontWeight: 700 }}>
                    {t(tr.buy ? 'boughtQty' : 'soldQty', { qty: num(tr.qty) })}
                  </span>
                </span>
                <span className="num" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)' }}>
                  {tr.ago === 0 ? t('home:justNow') : t('home:secondsAgo', { n: tr.ago })}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 파생 진입점 + 가상가격 고지(상시 노출) */}
        <div className="sec" style={{ paddingBottom: 24 }}>
          <button
            onClick={() => nav(`/leverage/${ticker}`)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              background: 'var(--brand-weak)',
              borderRadius: 16,
              padding: '15px 16px',
              textAlign: 'left',
            }}
          >
            <span style={{ display: 'grid', placeItems: 'center', color: 'var(--brand-ink)' }} aria-hidden>
              {Icon.leverage}
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 800, color: 'var(--brand-ink)' }}>{t('leverCta')}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--brand-ink)', opacity: 0.75 }}>{t('leverCtaSub')}</span>
            </span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-ink)" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="m9 5 7 7-7 7" />
            </svg>
          </button>
          {/*
            ★★게임 시간 ↔ 실제 시간 환산을 ★«여기 한 곳»에만 둔다 (2026-08-26).

            ⛔예전에는 차트 바로 밑에 「게임 {N}일 = 실제 약 {M}분」이 ★상시로 떠 있었고,
              고른 기간에 따라 숫자가 바뀌었다. 그래서
                ① 항상 볼 필요가 없는 설명문이 컨트롤 한복판을 차지했고
                ② 봉·기간 라벨(게임 시간)과 ★한 화면에서 두 시계가 돌았다.
            ★이제 화면의 시간 표기는 «전부 게임 시간»이고, 실제 시간과의 관계는
              「이 가격은 가상이다」와 ★같은 성격의 사실이라 같은 자리에서 말한다.
            ★기간에 안 딸린 «고정 문장»이라 다시 계산되지도 않는다.
          */}
          <p className="hint" style={{ marginTop: 16 }}>
            <Trans i18nKey="stock:virtualNotice" components={{ b: <b /> }} />{' '}
            {/* ★숫자를 «봉 단위»에 묶는다 — 이 문장이 설명하는 「하루」가 곧 봉 하나다.
                ⛔`1` 을 직접 쓰지 마라. 봉 단위가 바뀌면 이 문장만 옛 값으로 남는다. */}
            {t('timeNote', { d: num(CANDLE_GAME_DAYS), m: gameDaysToRealMinutes(CANDLE_GAME_DAYS) })}
          </p>
        </div>
      </div>

      <div className="orderbar">
        <button className="btn btn--lg btn--sub" style={{ flex: 1 }} onClick={() => setOrder('sell')} disabled={!holding}>
          {t('common:sell')}
        </button>
        <button className="btn btn--lg" style={{ flex: 1.3, background: 'var(--up)', color: '#fff' }} onClick={() => setOrder('buy')}>
          {t('common:buy')}
        </button>
      </div>

      {order && <OrderSheet ticker={ticker} side={order} onClose={() => setOrder(null)} />}
    </div>
  );
}

/** 이동평균 범례 한 칸 — ★색이 아니라 «점선 여부»로도 구분된다(색맹 대응) */
function LegendItem({ dashed, label }: { dashed: boolean; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}>
      <svg width="16" height="6" viewBox="0 0 16 6" aria-hidden>
        <line
          x1="0"
          y1="3"
          x2="16"
          y2="3"
          stroke={dashed ? 'var(--t3)' : 'var(--t2)'}
          strokeWidth="1.8"
          strokeDasharray={dashed ? '5 4' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{label}</div>
      <div className="num" style={{ fontSize: 15, fontWeight: 800 }}>
        {value}
      </div>
    </div>
  );
}
