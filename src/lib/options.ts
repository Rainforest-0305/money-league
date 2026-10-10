/**
 * 옵션 프리미엄/델타/페이오프 — 서버 engine/options.ts 와 동일 공식(이식 완료).
 * 정적 단독 빌드에서는 이 파일이 유일한 정본이다:
 *   (1) 행사가 칩의 프리미엄 미리보기, (2) 만기 손익 그래프,
 *   (3) 로컬 엔진(lib/engine/world.ts)의 실제 체결가·평가액 계산.
 */
import { TRADING_DAYS_PER_YEAR } from './constants';

export type OptionKind = 'call' | 'put';

/** 표준정규 누적분포 (Abramowitz-Stegun 7.1.26) */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** 프리미엄 = 내재가치 + 시간가치 (Black-Scholes, r=0) */
export function optionPremium(
  kind: OptionKind,
  S: number,
  K: number,
  sigma: number,
  tGameDays: number
): number {
  const intrinsic = kind === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (tGameDays <= 0) return intrinsic;
  const T = tGameDays / TRADING_DAYS_PER_YEAR;
  const vs = sigma * Math.sqrt(T);
  if (vs <= 1e-12) return intrinsic;
  const d1 = (Math.log(S / K) + 0.5 * vs * vs) / vs;
  const d2 = d1 - vs;
  const px = kind === 'call' ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
  return Math.max(px, intrinsic, 0.01);
}

export function optionDelta(
  kind: OptionKind,
  S: number,
  K: number,
  sigma: number,
  tGameDays: number
): number {
  if (tGameDays <= 0) {
    const itm = kind === 'call' ? S > K : S < K;
    return itm ? (kind === 'call' ? 1 : -1) : 0;
  }
  const T = tGameDays / TRADING_DAYS_PER_YEAR;
  const vs = sigma * Math.sqrt(T);
  if (vs <= 1e-12) return kind === 'call' ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + 0.5 * vs * vs) / vs;
  return kind === 'call' ? normCdf(d1) : normCdf(d1) - 1;
}

export function optionPayoff(kind: OptionKind, S: number, K: number): number {
  return kind === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** 본전(break-even) 가격: 콜 = K + 주당프리미엄, 풋 = K - 주당프리미엄 */
export function breakEven(kind: OptionKind, K: number, premiumPerShare: number): number {
  return kind === 'call' ? K + premiumPerShare : K - premiumPerShare;
}

/**
 * 행사가 «간격»의 목표치 — ★현재가 대비 «비율»이다.
 *
 * ★[2026-08-21 실측으로 교체] 옛 구현은 자릿수(`10^floor(log10(spot))`)로 계단을 만들어
 *   같은 계단 안에서 «간격 비율»이 통제되지 않았다. 100종목 실측:
 *     간격/현재가 = 1.67% ~ **22.48%** (중앙값 13.20%)
 *     ATM 칩이 현재가에서 최대 **10.10%** 벗어남 (앰페놀 111.80 → ATM 100)
 *     만기 5일 콜 칩 400개 중 **167개(41.75%)** 가 프리미엄 하한 $0.01 —
 *     즉 「가격이 없는 칩」이었다. 고르면 $0.01 복권을 사는 것과 같다.
 *   실제 시장의 행사가 간격은 유동성 있는 종목에서 대략 1~2.5% 다
 *   (예: $2.50 간격 × 주가 $180~$250). 그래서 목표를 2.5% 로 잡는다.
 *
 * ★확정 후 실측(현재가 0.5x ~ 2.0x 스트레스 · 100종목 × 콜/풋 × 만기 3/5/7):
 *     간격/현재가  min 1.63% · p50 2.58% · max 3.94%
 *     ATM 이탈     p50 0.63% · max 1.74%
 *     프리미엄 하한 칩  58/16,800 (0.35%)
 *
 * ★★[2026-09-05 재조정 2.5% → 1.25%] — 「효율적 가격」 작업이 sigma 를 반으로 줄였기 때문이다.
 *
 *   프리미엄 계산이 «데이터 sigma» 대신 «실현변동성 EWMA»(≈ 0.5배)를 쓰게 되면서
 *   같은 간격이 시그마 기준으로 «두 배 멀어졌다». 그 결과가 그대로 나왔다 —
 *   ⛔이건 추측이 아니라 실렌더에서 «먼저 터진» 회귀다:
 *     `python scripts/verify_options.py` → APH put · C call · C put 3건이
 *     「프리미엄 하한($0.01) 칩 없음」 대조에서 실패했다(칩이 하한에 주저앉았다).
 *
 *   ★전수 실측 (1,000종목 × 배수 7 × 콜/풋 × 만기 3/5/7 = 168,000칩 · 하한칩 비율)
 *     간격       sigma 1.0배(옛 값)    sigma 0.5배(현행 실현변동성)
 *     2.50%      0.18%                ★4.01%   ← 검사기 임계 1% 초과
 *     1.50%      0.01%                 0.87%
 *     ★1.25%     0.01%                ★0.39%   ← 채택
 *     1.00%      0.01%                 0.17%
 *   ⇒ 1.25% 는 sigma 가 반이 된 것을 «정확히» 상쇄한다(2.50 → 1.25).
 *     간격/현재가 중앙값 2.55% → 1.26% 로 실제 시장 구간(1~2.5%) «안»에 그대로 있고,
 *     ATM 이탈 중앙값도 0.62% → 0.30% 로 좋아진다.
 *   ⛔여기를 다시 올리려면 sigma 를 되돌린다는 뜻이다. 둘은 «한 쌍»이다.
 */
export const STRIKE_STEP_PCT = 0.0125;

/** 간격의 하한. ★0.5 미만으로 내리지 마라 — 아래 `strikeChoices` 의 «0.5 배수» 불변식이 깨진다. */
const MIN_STRIKE_STEP = 0.5;

/**
 * 1 · 2 · 5 × 10^k 중 `raw` 에 «로그 거리»로 가장 가까운 값 (하한 `MIN_STRIKE_STEP`).
 *
 * ★왜 로그 거리인가: 간격은 «비율»이라 3 과 5 의 거리는 5 와 7 의 거리와 다르다.
 * ★왜 1·2·5 인가: 실제 옵션 시장의 행사가 간격이 그 모양이고, 무엇보다
 *   결과 행사가가 **항상 0.5 의 배수**가 되어 화면 표기가 «값과 어긋나지 않는다».
 *   (0.1 · 0.2 를 허용하면 2진 부동소수 오차가 생기고 표기도 흔들린다)
 */
function niceStep(raw: number): number {
  const e = Math.floor(Math.log10(raw));
  let best = MIN_STRIKE_STEP;
  let bestD = Infinity;
  for (let dec = e - 1; dec <= e + 1; dec++) {
    for (const n of [1, 2, 5]) {
      const v = n * Math.pow(10, dec);
      if (v < MIN_STRIKE_STEP) continue;
      const d = Math.abs(Math.log(v / raw));
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
  }
  return best;
}

/**
 * 행사가 칩 4개 생성 — ★현재가에서 «비율»로 유도한다(ui_spec 3.4: 옵션체인 표 대신 칩 4개).
 *
 * 콜은 «아래 2 / ATM / 위 1», 풋은 «위 2 / ATM / 아래 1» 이다.
 * ★[2026-08-21 실측으로 변경] 옛 배치는 콜 `[-1,0,1,2]`(아래 1 / 위 2)였다.
 *   위쪽 2칸은 간격이 넓을수록 «프리미엄 하한 $0.01» 로 주저앉는다 — 실측:
 *     새 간격 · 만기 3일 기준 `[-1,0,1,2]` 는 400칩 중 **46칩**이 하한,
 *                              `[-2,-1,0,1]` 은 **0칩**.
 *     칩 최대/최소 비용비 중앙값도 265.6배 → 43.6배로 좁혀진다.
 *   ⇒ 「현재가보다 낮은 행사가의 콜」이 **2칸**으로 늘고(President 지적),
 *     동시에 «값이 없는 칩»이 사라진다. 위 1칸은 남아서 저가 OTM 도 여전히 있다.
 *
 * ★불변식 2개 (`scripts/check_strikes.mjs` 가 매 실행마다 검사한다):
 *   ① 모든 행사가는 **0.5 의 배수**다 → 화면이 표기를 반올림해 «값과 다르게» 적지 않는다.
 *   ② ATM 칩과 현재가의 거리는 **간격의 절반 이하**다 → 현재가에서 멀리 떨어지지 않는다.
 *
 * ⛔여기는 «후보 목록»일 뿐이다. 저장된 포지션의 `strike` 는 임의값이며
 *   이 함수를 거치지 않는다(호출처는 `screens/OptionOrder.tsx` 하나뿐).
 */
export function strikeChoices(kind: OptionKind, spot: number): number[] {
  const s = Math.max(spot, 1);
  const step = niceStep(s * STRIKE_STEP_PCT);
  const atm = Math.round(s / step) * step;
  const offsets = kind === 'call' ? [-2, -1, 0, 1] : [2, 1, 0, -1];
  const out = offsets
    // 0.5 배수로 «못 박는다» — step 이 0.5 의 배수라 값은 이미 정확하지만,
    // 이 한 줄이 있으면 간격을 바꿔도 불변식 ①이 유지된다.
    .map((o) => Math.round((atm + o * step) * 2) / 2)
    .filter((k) => k > 0)
    .sort((a, b) => a - b);
  return [...new Set(out)];
}
