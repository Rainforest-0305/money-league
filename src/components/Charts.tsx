import { useId, useMemo } from 'react';
import { money, signedMoney } from '../lib/format';
import { MA_LONG_DIVISOR, MA_SHORT_DIVISOR } from '../lib/constants';
import { breakEven, optionPayoff, type OptionKind } from '../lib/options';

/* 색은 전부 CSS 변수 — 하드코딩 hex 금지(ui_spec 6장) */

/* ══════════════════════════════════════════════════════════════════════════
   캔들 «표시» 상수 — ★여기가 정본이다 (2026-08-22)
   ══════════════════════════════════════════════════════════════════════════
   ★소유 경계: 이 값들은 «그림을 어떻게 그리는가»이지 시장 규칙이 아니다.
     그래서 엔진 상수 파일(lib/constants.ts)이 아니라 ★그리는 컴포넌트 옆에 둔다.
   ────────────────────────────────────────────────────────────────────────── */

/** 캔들 이동평균의 «최소» 창(봉). 1 이면 평균이 아니라 종가선이다 */
export const CANDLE_MA_MIN_BARS = 2;

/**
 * 봉 «몸통»의 최대 폭(px).
 *
 * ★★[2026-08-26] 1봉 = 게임 1일이 되면서 전체 구간이 ★6봉이다. 칸 폭이 65px 라
 *   기존 비율(칸의 56%)이면 몸통이 ★36px 짜리 «색 블록»이 된다 — 실렌더로 확인했다.
 *   심지(1.2px)와 몸통의 굵기 차이가 30배라 캔들의 «모양»이 사라진다.
 * ★그래서 폭을 «비율»과 «상한»의 min 으로 잡는다. 봉이 많으면 비율이,
 *   봉이 적으면 상한이 이긴다. 22px = 390px 폭에서 6개가 서로 붙지 않으면서
 *   몸통-심지 대비가 유지되는 값(실렌더로 고른 «선택»이지 유도값이 아니다).
 */
export const CANDLE_MAX_BODY_W = 22;

/**
 * 거래량 막대의 «천장»을 잡는 분위수.
 *
 * ★0.9 였다가 0.75 로 내렸다 [2026-08-22 실측]. 이유는 아래 VolumeBars 주석에 있다:
 *   칸 수가 적어지면(봉 단위 집계) `floor(n*0.9)` 가 ★최대값 자신이 되어
 *   「최대값으로 나누기」가 부활한다.
 * ★0.75 = 상위 25% 를 천장에 붙이고 나머지를 그 아래로 편다. 큰손 한 칸이
 *   나머지를 깔아뭉개지 않으면서, 평상시 거래의 «상대 크기»는 그대로 읽힌다.
 */
export const VOLUME_SCALE_QUANTILE = 0.75;

/**
 * 거래가 «있었던» 칸의 최소 막대 높이(px).
 * ★0 인 칸에는 막대를 아예 그리지 않는다 — 「없음」과 「아주 적음」은 다른 사실이다.
 * ★2px = 390x844 화면에서 «있다»가 보이는 최소치(1px 은 안티에일리어싱에 먹힌다).
 */
export const VOLUME_MIN_BAR_H = 2;

/**
 * 평균선이 «정보»가 되려면 그려지는 점이 몇 개여야 하는가.
 *
 * ★★[2026-08-26] 3 → 6 으로 올렸다. 3 은 「선이라 부를 수 있는 하한」이지
 *   «정보»의 기준이 아니다 — 이 프로젝트가 `CANDLE_TARGET_BARS` 에서 이미 한 번
 *   배운 것과 같은 실수다(하한을 목표로 쓰면 화면이 항상 하한에 머문다).
 * ★[실렌더 2026-08-26] 6봉 캔들에서 장기창 4봉 ⇒ 점 3개 ⇒ 차트 «오른쪽 절반»에만
 *   짧게 뚝 떨어진 조각이 그려졌다. 추세를 말하지 않는다. 잔해다.
 * ⇒ 6점이면 화면 폭의 최소 절반을 지나가며 방향이 읽힌다.
 */
export const CANDLE_MA_MIN_POINTS = 6;

/**
 * ★★캔들 이동평균 창을 ★«봉 개수에서 유도»한다.
 *
 * ── ⚠️소비처가 바뀌었다 (2026-08-26) ────────────────────────────────────
 * ★지금 «화면은 이 함수를 안 쓴다». 캔들 모드에서 이평선을 뺐기 때문이다
 *   (1봉 = 게임 1일 ⇒ 도달 가능 봉 6개 ⇒ 창 2/4봉 ⇒ 점 3개. 위 상수 주석 참조).
 * ★그래서 이 규칙은 이제 ★«언제 되살릴지 판정하는 기준»으로 산다.
 *   `scripts/check_chart_windows.mjs` 가 매 실행 «지금 도달 가능한 봉 수»로 이걸 돌려서
 *   `ok` 가 true 가 되는 날 ★FAIL 로 알린다 — 「이제 평균선을 되살려라」.
 * ⛔그러니 이 함수를 «안 쓴다»는 이유로 지우지 마라. 지우면 되살릴 시점을 아무도 모른다.
 *
 * ── 왜 고정 상수를 버렸나 (2026-08-22, President 실기기 지적에서 출발) ──────
 * 옛 값은 CANDLE_MA_SHORT_BARS = 5 · CANDLE_MA_LONG_BARS = 20 고정이었다.
 * ★코드에는 «있었는데 화면에는 안 나왔다».
 *   [실측 · 조합 30개 전수] 장기 이평선이 안 그려진 조합 ★22/30 · 단기 ★6/30.
 *   기전: movingAverage 는 창보다 짧은 구간에 null 만 준다. 상수가 데이터보다 컸다.
 * ⇒ 라인 모드가 이미 쓰던 규칙(MA_SHORT_DIVISOR 8 · MA_LONG_DIVISOR 3)을
 *   ★그대로 «봉»에 적용한다. 규칙이 «한 벌»이면 두 모드가 갈릴 수 없다.
 * ⛔고정 봉수로 되돌리지 마라 — 데이터가 그만큼 없으면 선이 통째로 사라지고,
 *   그건 «에러 없이 그림만 없는» 종류라 아무도 모른다.
 *
 * ★★그리고 ⛔「창보다 데이터가 적으면 짧게 잘라서라도 그린다」를 «하지 않는다».
 *   「20봉 평균」이라 써놓고 6봉 평균을 그리는 것은 표시 결함이 아니라 ★데이터 위조다.
 *
 * @returns ok 가 false 면 점이 CANDLE_MA_MIN_POINTS 개도 안 나온다 = 그릴 값이 없다.
 */
export function candleMaWindows(bars: number): { short: number; long: number; ok: boolean } {
  const short = Math.max(CANDLE_MA_MIN_BARS, Math.round(bars / MA_SHORT_DIVISOR));
  const long = Math.max(short * 2, Math.round(bars / MA_LONG_DIVISOR));
  /* 점 개수 = bars - long + 1 */
  return { short, long, ok: bars - long + 1 >= CANDLE_MA_MIN_POINTS };
}

/**
 * ★평균선이 «설 수 있는» 최소 봉 수 — 위 규칙에서 «찾아낸다».
 *
 * ⛔여기에 숫자를 적지 마라. 분모·최소창·최소점수를 바꾸면 답이 달라지는데,
 *   숫자를 박아 두면 ★판정만 옛 값으로 남는다.
 *   이 프로젝트가 반복해서 데인 「라벨은 그대로, 값만 바뀐」 형태다.
 * ★소비처: `check_chart_windows.mjs` — 「지금 봉 수가 이 값에 닿았는가」를 매 실행 본다.
 *   닿으면 캔들 이평선을 되살릴 때다.
 */
export function minBarsForMa(): number {
  for (let b = CANDLE_MA_MIN_BARS; b <= 400; b++) {
    if (candleMaWindows(b).ok) return b;
  }
  return 400;
}

function extent(v: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  return [lo, hi];
}

/**
 * 단순이동평균 — ★«접두합(prefix sum)» 으로 O(n) 에 끝낸다.
 *
 * ⛔각 지점마다 창을 다시 더하면 O(n·w) 다. 900점 × 창 300 = 27만 연산이 «2초마다» 돈다.
 *   차트가 게임 루프와 같은 스레드를 쓰므로 그건 그대로 프레임 손실이다.
 * ★창이 채워지기 «전» 구간은 null 이다 — 억지로 짧은 평균을 그리면 선 앞머리가
 *   원본과 붙어 「평균이 아닌 구간」이 평균처럼 보인다.
 */
export function movingAverage(data: number[], window: number): (number | null)[] {
  const n = data.length;
  const w = Math.max(1, Math.min(window, n));
  const out: (number | null)[] = new Array(n).fill(null);
  if (n === 0) return out;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += data[i];
    if (i >= w) acc -= data[i - w];
    if (i >= w - 1) out[i] = acc / w;
  }
  return out;
}

/**
 * MA 선 하나를 SVG path 로. ★null 구간에서 선을 «끊는다»(M 으로 다시 시작).
 * ⛔막대·선을 요소 여러 개로 그리지 않는다 — path 문자열 하나가 DOM 1개다.
 */
function maPath(ma: (number | null)[], step: number, y: (v: number) => number, x0 = 0): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < ma.length; i++) {
    const v = ma[i];
    if (v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${(x0 + i * step).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

/* ── 스파크라인 (리스트 행) ─────────────────────────────────────────── */
export function Sparkline({
  data,
  width = 46,
  height = 26,
  up,
}: {
  data: number[];
  width?: number;
  height?: number;
  up: boolean;
}) {
  const d = useMemo(() => {
    if (data.length < 2) return '';
    const [lo, hi] = extent(data);
    const step = width / (data.length - 1);
    return data
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(height - 3 - ((v - lo) / (hi - lo)) * (height - 6)).toFixed(1)}`)
      .join(' ');
  }, [data, width, height]);
  if (!d) return <span style={{ width, height }} />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/* ── 라인(면적) 차트 — 기본 차트 ────────────────────────────────────── */
export function AreaChart({
  data,
  height = 176,
  showDot = true,
  showBaseline = true,
  tone,
  maShort,
  maLong,
  marks,
}: {
  data: number[];
  height?: number;
  showDot?: boolean;
  showBaseline?: boolean;
  tone?: 'up' | 'down';
  /**
   * 이동평균 오버레이(선택). ★두 개까지만 받는다 — 세 개 이상은 원본 가격선을 덮는다.
   * ★색은 --up/--down 을 «쓰지 않는다». 손익 색으로 오독되면 안 되기 때문이다.
   *   대신 중립 잉크(--t2/--t3) + «점선 여부»로 구분한다(색맹 사용자에게도 구분된다).
   */
  maShort?: (number | null)[];
  maLong?: (number | null)[];
  /**
   * ★[-23] «세션 경계» — 이 인덱스의 점부터 새 접속이다. 그 «앞» 틈에 세로 점선을 세운다.
   *   이어붙인 그래프의 점프/평평 구간을 버그로 안 보이게 하는 표지. 값 자체는 손대지 않는다.
   */
  marks?: number[];
}) {
  const gid = useId().replace(/:/g, '');
  const W = 390;
  const up = tone ? tone === 'up' : data.length > 1 && data[data.length - 1] >= data[0];
  const color = up ? 'var(--up)' : 'var(--down)';

  const { line, area, lastY, baseY, maS, maL } = useMemo(() => {
    if (data.length < 2) return { line: '', area: '', lastY: 0, baseY: 0, maS: '', maL: '' };
    const [lo, hi] = extent(data);
    const pad = 14;
    const step = W / (data.length - 1);
    const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
    const pts = data.map((v, i) => `${(i * step).toFixed(1)} ${y(v).toFixed(1)}`);
    /* ★이동평균은 «자기 창의 평균»이라 항상 원본 데이터의 [min,max] 안에 있다.
       따라서 축척(extent)을 다시 계산할 필요가 없다 — 같은 y 를 그대로 쓴다. */
    return {
      line: `M${pts.join(' L')}`,
      area: `M${pts.join(' L')} L${W} ${height} L0 ${height}Z`,
      lastY: y(data[data.length - 1]),
      baseY: y(data[0]),
      maS: maShort ? maPath(maShort, step, y) : '',
      maL: maLong ? maPath(maLong, step, y) : '',
    };
  }, [data, height, maShort, maLong]);

  if (!line) return <div style={{ height }} />;

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showBaseline && (
        <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="var(--t3)" strokeDasharray="3 5" opacity="0.35" />
      )}
      {marks &&
        marks.map((m) =>
          m > 0 && m < data.length ? (
            <line
              key={m}
              x1={((m - 0.5) * W) / (data.length - 1)}
              y1="0"
              x2={((m - 0.5) * W) / (data.length - 1)}
              y2={height}
              stroke="var(--t3)"
              strokeWidth="1.2"
              strokeDasharray="3 4"
              opacity="0.6"
              vectorEffect="non-scaling-stroke"
            />
          ) : null
        )}
      <path d={area} fill={`url(#${gid})`} />
      {/* ★평균선을 «가격선 아래»에 깐다. 위에 그리면 지금 가격을 가린다 */}
      {maL && (
        <path
          d={maL}
          fill="none"
          stroke="var(--t3)"
          strokeWidth="1.6"
          strokeDasharray="5 4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {maS && (
        <path d={maS} fill="none" stroke="var(--t2)" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      )}
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {showDot && <circle cx={W - 2} cy={lastY} r="4.5" fill={color} />}
    </svg>
  );
}

/* ── 캔들 + 거래량 (옵트인) ─────────────────────────────────────────── */

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  /** 이 봉의 «종가»가 놓인 원본 틱 인덱스 */
  idx: number;
}

/**
 * ★★«묶는 규칙» 그 자체 — 봉도 거래량 막대도 ★이 함수 «하나»를 쓴다.
 *
 * ── 왜 함수로 뽑았나 [2026-08-26] ────────────────────────────────────────
 *   옛 코드는 같은 규칙이 `buildCandles` 와 `VolumeBars` 에 ★두 벌 있었고,
 *   주석이 「글자 그대로 같아야 한다 · 어긋나도 ★에러는 안 난다」고 경고하고 있었다.
 *   ⇒ 경고문은 규율이지 «보증»이 아니다. 한 벌로 만들면 갈릴 방법이 없다.
 *   ⇒ 그러니 ⛔여기서 다시 복제하지 마라. 새 소비처도 이 함수를 부른다.
 *
 * ★★`tail` = «마지막(가장 최근) 봉에 들어갈 틱 수». 게임일 경계에 봉을 맞추려고 받는다.
 *   ⛔안 주면(또는 step 과 같으면) 예전과 «똑같이» 뒤에서부터 자른다 — 회귀 안전.
 *   ★경계에 맞추면 과거 봉이 ★«고정»된다. 안 맞추면 창이 매 틱 1칸씩 미끄러져
 *     6봉짜리 화면에서는 봉이 눈에 띄게 «꿈틀거린다»(실렌더로 확인).
 *   ★앞의 불완전한 조각은 버린다. 마지막 봉만 «자라는 중»인 봉이다 —
 *     실제 일봉 차트의 «오늘 봉»과 같은 뜻이라 거짓이 없다.
 *
 * @returns [start, end) 쌍의 배열. 길이가 곧 봉 개수다.
 */
export function barSlices(len: number, ticksPerBar: number, tail?: number): [number, number][] {
  const step = Math.max(1, Math.floor(ticksPerBar));
  const last = tail && tail > 0 && tail <= step ? Math.floor(tail) : step;
  if (len < last) return [];
  const full = Math.floor((len - last) / step);
  const out: [number, number][] = [];
  let a = len - last - full * step;
  for (let i = 0; i < full; i++) {
    out.push([a, a + step]);
    a += step;
  }
  out.push([a, len]);
  return out;
}

/**
 * 틱 시계열을 «명시된 시간 단위»의 봉으로 묶는다.
 *
 * ⛔[2026-08-21 교체] 예전에는 구간을 «무조건 34등분»했다. 그래서 「캔들」 버튼 하나에
 *   기간에 따라 4.4초봉 ~ 53초봉이 섞여 나왔다 — ★같은 이름의 다른 그림이다.
 * ★봉 폭은 «틱 수»로 못 박는다. 화면 폭이 아니라 «시간»이 봉을 정한다.
 * ★묶는 일은 전부 `barSlices` 가 한다 — 이 함수는 OHLC 만 만든다.
 */
export function buildCandles(data: number[], ticksPerBar: number, tail?: number): Candle[] {
  const out: Candle[] = [];
  for (const [a, b] of barSlices(data.length, ticksPerBar, tail)) {
    const seg = data.slice(a, b);
    if (!seg.length) continue;
    const [lo, hi] = extent(seg);
    out.push({ o: seg[0], c: seg[seg.length - 1], h: hi, l: lo, idx: b - 1 });
  }
  return out;
}

export function CandleChart({
  bars,
  height = 210,
  maShort,
  maLong,
}: {
  /** ★이미 «단위대로» 묶인 봉. 차트는 묶는 규칙을 모른다(화면 폭이 단위를 정하면 안 된다) */
  bars: Candle[];
  height?: number;
  /**
   * ★★«봉» 단위 이동평균이다 — 배열 길이가 `bars` 와 같아야 한다.
   * ⛔틱 단위 MA 를 봉 경계에서 샘플링해 넘기지 «마라». 그러면 단위를 1분→5분으로 바꿔도
   *   평균선이 그대로 남아 ★「맞아 보이는데 틀린」 화면이 된다.
   */
  maShort?: (number | null)[];
  maLong?: (number | null)[];
}) {
  const W = 390;
  /*
   * ★[제거 2026-08-20] 여기 있던 «거래량» v 는 ★가짜였다:
   *     v: 0.35 + (Math.abs(c / o - 1) * 120) % 0.65
   *   가격 변화율을 0.65 로 나눈 나머지 — 거래량과 아무 관계가 없는 «지어낸 숫자»다.
   *   이제는 엔진이 실제 «틱별 거래대금»을 쌓는다(priceEngine.volHistory).
   *   막대는 아래 VolumeBars 가 그 «실데이터»로 그린다.
   */

  if (!bars.length) return <div style={{ height }} />;
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const pad = 10;
  const y = (v: number) => pad + ((hi - v) / (hi - lo || 1)) * (height - pad * 2);
  const cw = W / bars.length;
  /* ★봉이 적을 때 몸통이 «색 블록»이 되지 않게 상한을 씌운다(CANDLE_MAX_BODY_W 주석 참조) */
  const bw = Math.min(cw * 0.56, CANDLE_MAX_BODY_W);
  const last = bars[bars.length - 1];

  return (
    <>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} style={{ display: 'block' }} aria-hidden>
        <line x1="0" y1={y(bars[0].o)} x2={W} y2={y(bars[0].o)} stroke="var(--t3)" strokeDasharray="3 5" opacity="0.5" />
        {bars.map((b, i) => {
          const x = i * cw + cw / 2;
          const col = b.c >= b.o ? 'var(--up)' : 'var(--down)';
          const yt = y(Math.max(b.o, b.c));
          const yb = y(Math.min(b.o, b.c));
          return (
            <g key={i}>
              <line x1={x} y1={y(b.h)} x2={x} y2={y(b.l)} stroke={col} strokeWidth="1.2" />
              <rect x={x - bw / 2} y={yt} width={bw} height={Math.max(1.4, yb - yt)} rx="1" fill={col} />
            </g>
          );
        })}
        {/* ★MA 는 «봉 종가»의 평균이다 — 배열 인덱스가 곧 봉 인덱스라 한 칸도 밀리지 않는다.
            ⛔예전처럼 «틱 MA 를 봉 경계에서 샘플링»하지 않는다: 그러면 봉 단위를 바꿔도
              평균선이 그대로 남아 «맞아 보이는데 틀린» 그림이 된다. */}
        {maLong && (
          <path
            d={maPath(maLong, cw, y, cw / 2)}
            fill="none"
            stroke="var(--t3)"
            strokeWidth="1.6"
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {maShort && (
          <path
            d={maPath(maShort, cw, y, cw / 2)}
            fill="none"
            stroke="var(--t2)"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/*
          ★★[2026-08-26 제거] 오른쪽 «현재가 알약»(둥근 상자 + 숫자).
            ① ★같은 숫자가 이 화면 위쪽에 36px 로 이미 떠 있다. 차트 안의 10.5px 복사본은
               정보를 더하지 않는다.
            ② ⛔그리고 1봉 = 게임 1일이 되면서 봉이 6개가 됐다 — 알약(폭 58px)이
               ★마지막 봉을 «통째로 가렸다»(실렌더로 확인). 가려진 그 봉이 하필
               «지금 자라고 있는 오늘 봉»이다.
          ★현재가의 «높이»는 아래 점선이 그대로 말한다. 색(--up)이 시작가 선(--t3)과 다르다.
        */}
        <line x1="0" y1={y(last.c)} x2={W} y2={y(last.c)} stroke="var(--up)" strokeDasharray="2 4" opacity="0.7" />
      </svg>
    </>
  );
}

/**
 * 거래량 막대 — ★엔진이 «실제로» 쌓은 틱별 거래대금이다(지어낸 값이 아니다).
 *
 * ★높이 = gross(그 구간에 오간 총 주문금액) · 색 = net 부호(매수가 이겼나 매도가 이겼나).
 *   net 으로 «높이»를 그리면 100만 매수 + 100만 매도인 «가장 치열했던» 구간이 0 이 된다.
 * ★스케일은 «데이터에서 유도»한다 — 고정 최대값을 박으면 엔진 파라미터가 바뀌는 순간
 *   (ORDER_FLOW_WEIGHT 0.30→0.50, 수수료 인하 → 회전율 상승) 막대가 전부 천장에 붙거나 사라진다.
 * ★★DOM 비용: 막대 48개를 <rect> 로 그리면 요소가 48개다. 여기서는 «path 2개»로 끝낸다
 *   (매수 우위 묶음 1개 + 매도 우위 묶음 1개). 차트는 2초마다 다시 그려진다.
 */
export function VolumeBars({
  gross,
  net,
  groupTicks,
  tail,
  height = 44,
  emptyLabel,
}: {
  gross: number[];
  net: number[];
  /**
   * ★★한 «칸»이 몇 틱인가. ⛔칸 «개수»가 아니다 — 개수를 받으면 화면 폭이 시간을 정한다.
   *
   * ── 왜 라인 모드도 이 값을 받게 됐나 [2026-08-26 실측] ──────────────────
   *   옛 코드는 라인 모드에서 «48칸 고정»이었다. 1게임일 구간이면 3.1틱/칸이라
   *   ★48칸 중 막대가 «2개»만 그려졌다(거래가 0인 칸은 안 그린다).
   *   데이터는 맞는데 화면이 고장으로 읽힌다.
   *   ⇒ 이제 두 모드 모두 «칸 폭»을 시간으로 받는다.
   *     캔들 = 봉과 같은 틱 수(막대 하나 = 봉 하나) · 라인 = VOLUME_BUCKET_TICKS.
   */
  groupTicks: number;
  /** 마지막 칸에 들어갈 틱 수 — 봉과 «같은 값»을 줘야 x축이 한 칸도 안 밀린다 */
  tail?: number;
  height?: number;
  emptyLabel?: string;
}) {
  const W = 390;
  const { up, down, hasData } = useMemo(() => {
    /*
     * ★★묶는 규칙은 ★`barSlices` «한 벌»뿐이다 — 봉과 같은 함수를 부른다.
     *   ⛔여기에 규칙을 다시 적지 마라. 두 벌이 되는 순간 막대와 봉이 서로 다른 시각을
     *     가리키고, ★에러는 안 난다(2026-08-22 에 실제로 그렇게 어긋나 있었다).
     */
    const slices = barSlices(gross.length, groupTicks, tail);
    const n = slices.length;
    if (n <= 0) return { up: '', down: '', hasData: false };
    const g: number[] = new Array(n).fill(0);
    const v: number[] = new Array(n).fill(0);
    for (let b = 0; b < n; b++) {
      const [a, e] = slices[b];
      for (let i = a; i < e; i++) {
        g[b] += gross[i];
        v[b] += net[i];
      }
    }
    /*
     * ★★스케일 — «최대값»으로 나누면 안 된다 [실렌더로 확인한 실패].
     *   봇 명부에는 시드 200만짜리 큰손이 있어 한 틱에 수백만 달러짜리 주문이 들어온다.
     *   그 한 칸이 나머지를 전부 «0.8px 선»으로 눌러 버려서, 첫 구현은
     *   「막대 하나 + 바닥에 깔린 점선」처럼 보였다.
     *   ⇒ 상위 분위수를 «천장»으로 삼고 넘치는 건 자른다. 평상시 거래가 읽히게 된다.
     *   ⇒ 스케일 값은 «데이터에서 유도»한다 — 고정 최대값을 박으면 엔진 파라미터가
     *     바뀌는 순간(ORDER_FLOW_WEIGHT 0.30→0.50 · 수수료 인하) 전부 천장에 붙는다.
     *
     * ★★[2026-08-22 실측으로 잡은 «되살아난» 결함]
     *   옛 코드는 p90 을 `sorted[floor(n * 0.9)]` 로 잡았다. 칸이 48개일 때는 43번째라
     *   제대로 동작했지만, ★칸을 «봉 수»(6~60)로 줄이자 그 식이 ★«최대값 자신»이 됐다:
     *     n=6  → floor(5.4)=5 = 최대값     n=10 → floor(9)=9 = 최대값
     *   ⇒ 막으려던 「최대값으로 나누기」가 ★그대로 부활했다.
     *     [실측] 10봉 중 «보이는 막대 2개»(비율 0.20)까지 나왔다.
     *   ⇒ 그래서 분위수를 «내리고»(0.75) 인덱스를 ★반올림-1 로 잡는다.
     *     n=6 → 4(2번째로 큰 값) · n=10 → 7 · n=60 → 44. 어느 n 에서도 최대값이 아니다.
     */
    /*
     * ★★[2026-08-26 실측으로 잡은 세 번째 판] 분위수를 ★«거래가 있었던 칸»에서만 잡는다.
     *   옛 코드는 0 인 칸까지 넣고 정렬했다. 이 게임은 한 종목 체결이 듬성듬성해서
     *   [실측 · NVDA · 전체 구간] 30칸 중 ★19칸이 0 이었다.
     *     ⇒ sorted[21] 이 «0 이 아닌 값 중 세 번째로 작은 것»이 되어
     *       ★보이는 막대 11개 중 8개가 천장에 붙었다 — 높이가 «전부 같아» 보였다.
     *       즉 「거래량 막대」가 «거래가 있었다/없었다»만 말하고 크기를 못 말했다.
     *   ⇒ 0 은 «분포»가 아니라 «부재»다. 분포에서 빼야 천장이 제자리로 간다.
     */
    const nz = g.filter((x) => x > 0).sort((a, b) => a - b);
    if (!nz.length) return { up: '', down: '', hasData: false };
    const qi = Math.min(nz.length - 1, Math.max(0, Math.round(nz.length * VOLUME_SCALE_QUANTILE) - 1));
    const max = nz[qi] > 0 ? nz[qi] : nz[nz.length - 1];
    if (!(max > 0)) return { up: '', down: '', hasData: false };
    const cw = W / n;
    const bw = Math.max(1.2, cw * 0.58);
    let pu = '';
    let pd = '';
    for (let i = 0; i < n; i++) {
      /*
       * ★★거래가 «없었던» 칸은 ⛔막대를 그리지 않는다.
       *   옛 코드는 `Math.max(0.8, ...)` 라 0 인 칸에도 0.8px 선이 깔렸다 —
       *   「아주 조금 거래됐다」와 「한 건도 없었다」가 ★같은 그림이 된다.
       *   ⇒ 없으면 «없게» 그린다. 그리고 있으면 ★최소 VOLUME_MIN_BAR_H 는 보이게 한다.
       */
      if (!(g[i] > 0)) continue;
      const h = Math.max(VOLUME_MIN_BAR_H, Math.min(1, g[i] / max) * (height - 4));
      const x = i * cw + (cw - bw) / 2;
      const seg = `M${x.toFixed(1)} ${(height - h).toFixed(1)}h${bw.toFixed(1)}v${h.toFixed(1)}h-${bw.toFixed(1)}Z`;
      if (v[i] >= 0) pu += seg;
      else pd += seg;
    }
    if (!pu && !pd) return { up: '', down: '', hasData: false };
    return { up: pu, down: pd, hasData: true };
  }, [gross, net, groupTicks, tail, height]);

  if (!hasData) {
    return (
      <div style={{ height, display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--t3)' }}>
        {emptyLabel ?? ''}
      </div>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden>
      {/* ★바닥선 — 막대가 «드문» 구간에서 스트립이 「빈 상자」가 아니라 «축»으로 읽히게 한다.
          ⛔요소를 늘리는 장식이 아니다: 거래 0인 칸에 가짜 막대를 그리지 않기로 한 대가를
            이 선 «하나»가 갚는다(막대 48개를 path 2개로 그리는 예산과 같은 급이다). */}
      <line x1="0" y1={height - 0.5} x2={W} y2={height - 0.5} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {down && <path d={down} fill="var(--down)" opacity="0.55" />}
      {up && <path d={up} fill="var(--up)" opacity="0.55" />}
    </svg>
  );
}

/* ── 주문 흐름 게이지 ("사려는 사람 68%") ──────────────────────────── */
export function FlowGauge({ buyPct }: { buyPct: number }) {
  const b = Math.max(2, Math.min(98, buyPct));
  return (
    <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 9 }} aria-hidden>
      <div style={{ width: `${b}%`, background: 'var(--up)' }} />
      <div style={{ width: `${100 - b}%`, background: 'var(--down)' }} />
    </div>
  );
}

/* ── 청산 게이지 (청산 구간 + 현재가 마커) ─────────────────────────── */
export function LiquidationGauge({
  bufferPct,
  side,
}: {
  /** 현재가에서 청산가까지 남은 거리 % (0 = 청산 직전) */
  bufferPct: number;
  side: 'long' | 'short';
}) {
  const clamped = Math.max(0, Math.min(60, bufferPct));
  // 안전거리가 클수록 마커가 오른쪽(안전)
  const markerPct = Math.max(4, Math.min(96, (clamped / 60) * 100));
  const danger = side === 'long' ? 'var(--down)' : 'var(--up)';
  const dangerSoft = side === 'long' ? 'var(--down-weak)' : 'var(--up-weak)';
  return (
    <div
      className="gauge"
      style={{ background: `linear-gradient(90deg, ${danger}, ${dangerSoft} ${markerPct}%, var(--surface-2) ${markerPct}%)` }}
      aria-hidden
    >
      <span className="gauge__now" style={{ left: `${markerPct}%` }} />
    </div>
  );
}

/* ── 옵션 만기 손익 그래프 ─────────────────────────────────────────── */
export function PayoffChart({
  kind,
  strike,
  premiumPerShare,
  spot,
  shares,
  side = 'buy',
}: {
  kind: OptionKind;
  strike: number;
  premiumPerShare: number;
  spot: number;
  /** 계약 주식 수 (항상 «양수»로 준다) */
  shares: number;
  /**
   * ★'sell' = 권리 «매도». 손익이 정확히 뒤집힌다 (2026-08-20 옵션 매도 신설).
   *
   * ⛔처음엔 `shares` 에 «음수»를 넘겨 뒤집으려 했다 — ★그러면 차트가 깨진다:
   *   maxLoss = premiumPerShare × shares 가 «음수»가 되어 세로 범위(range)의 부호가 뒤집히고,
   *   좌하단 「최대 손실」 라벨이 `-$-1,234` 로 찍힌다.
   *   ⇒ ★부호를 «데이터»에 섞지 않고 «의미»로 받는다. 그리고 세로 범위는
   *     아래처럼 «그려진 값에서» 구한다 — 그러면 매수·매도 어느 쪽이든 자동으로 맞는다.
   */
  side?: 'buy' | 'sell';
}) {
  const W = 320;
  const H = 130;
  const dir = side === 'sell' ? -1 : 1;
  const qty = Math.abs(shares);
  const be = breakEven(kind, strike, premiumPerShare);
  const lo = Math.max(0.01, Math.min(spot, strike, be) * 0.82);
  const hi = Math.max(spot, strike, be) * 1.2;

  const steps = 60;
  const vals: { p: number; v: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const pr = lo + ((hi - lo) * i) / steps;
    vals.push({ p: pr, v: (optionPayoff(kind, pr, strike) - premiumPerShare) * qty * dir });
  }
  /*
   * ★세로 범위를 «그려진 값»에서 구한다. 0 은 항상 범위 안에 둔다 —
   *   손익 그래프에서 «본전선»이 화면 밖으로 나가면 그림이 뜻을 잃는다.
   */
  let vMin = 0;
  let vMax = 0;
  for (const { v } of vals) {
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const pad = (vMax - vMin) * 0.18 || 1;
  const lowV = vMin - pad;
  const highV = vMax + pad;
  /** 좌하단 라벨용 «그려진 구간의 최악값» */
  const worst = vMin;

  const x = (p: number) => ((p - lo) / (hi - lo)) * W;
  const y = (v: number) => {
    const top = 14;
    const bottom = H - 16;
    return bottom - ((v - lowV) / (highV - lowV)) * (bottom - top);
  };

  const pts: string[] = vals.map(({ p: pr, v }) => `${x(pr).toFixed(1)} ${y(v).toFixed(1)}`);
  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden>
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--t3)" opacity="0.3" />
      <path
        d={`M${pts.join(' L')} L${W} ${H} L0 ${H}Z`}
        fill="var(--down)"
        opacity="0.08"
      />
      <path d={`M${pts.join(' L')}`} fill="none" stroke="var(--up)" strokeWidth="2.6" strokeLinejoin="round" />
      <circle cx={x(be)} cy={zeroY} r="4" fill="var(--t1)" />
      <text x={Math.min(W - 96, x(be) + 6)} y={zeroY - 8} fontSize="10.5" fontWeight="700" fill="var(--t2)">
        {money(be)}
      </text>
      {/* ★「-」를 문자열로 «붙이지» 않는다 — 값이 음수면 부호가 두 번 붙는다.
          signedMoney 가 부호를 만들고, 0 이면 라벨 자체를 그리지 않는다. */}
      {worst < 0 && (
        <text x="4" y={H - 4} fontSize="10.5" fontWeight="700" fill="var(--down-ink)">
          {signedMoney(worst)}
        </text>
      )}
      <line x1={x(spot)} y1="8" x2={x(spot)} y2={H - 8} stroke="var(--t3)" strokeDasharray="2 4" opacity="0.6" />
    </svg>
  );
}

/* ── 원형 카운트다운 (충전 쿨다운) ─────────────────────────────────── */
export function RingCountdown({ ratio, big, small }: { ratio: number; big: string; small: string }) {
  const R = 70;
  const C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(1, ratio)));
  return (
    <svg width="164" height="164" viewBox="0 0 164 164" style={{ display: 'block', margin: '0 auto' }} aria-hidden>
      <circle cx="82" cy="82" r={R} fill="none" stroke="var(--line)" strokeWidth="11" />
      <circle
        cx="82"
        cy="82"
        r={R}
        fill="none"
        stroke="var(--gold)"
        strokeWidth="11"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 82 82)"
      />
      <text x="82" y="76" textAnchor="middle" fontSize="30" fontWeight="800" fill="var(--t1)" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {big}
      </text>
      <text x="82" y="99" textAnchor="middle" fontSize="12.5" fontWeight="700" fill="var(--t3)">
        {small}
      </text>
    </svg>
  );
}

/** 총자산 게이지 (파산 화면) */
export function EquityBar({
  equity,
  seed,
  threshold,
  midLabel,
  endLabel,
}: {
  equity: number;
  seed: number;
  threshold: number;
  midLabel: string;
  endLabel: string;
}) {
  const w = Math.max(0.8, Math.min(100, (equity / seed) * 100));
  const mark = Math.max(1, (threshold / seed) * 100);
  return (
    <>
      <div style={{ marginTop: 12, height: 8, borderRadius: 4, background: 'var(--surface-2)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${w}%`, background: 'var(--down)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: `${mark}%`, top: -4, width: 2, height: 16, background: 'var(--t3)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, color: 'var(--t3)' }}>
        <span className="num">{money(0, 0)}</span>
        <span>{midLabel}</span>
        <span className="num">{endLabel}</span>
      </div>
    </>
  );
}
