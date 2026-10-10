/**
 * 지수 = «구성종목 가중합» 추종 (President 지시 ③, 2026-08-22).
 *
 *   지수가격 = Σ(구성종목가 × 가중치) / 제수
 *
 * ★President 지시의 핵심: 「S&P 500 및 나스닥은 각 종목들의 «가중합을 추종»하도록」.
 *   ⇒ 지수는 «자기 난수»로 굴러가지 않는다. 구성종목이 움직여야만 지수가 움직인다.
 *   ⇒ priceEngine.step() 에서 지수는 GBM 을 «타지 않는다».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⛔⛔ 되먹임 없음 (설계 확정 · 이유를 여기 남긴다)
 * ══════════════════════════════════════════════════════════════════════════
 * 지수에 주문이 들어와도 그 임팩트를 «구성종목으로 되돌리지 않는다».
 *
 * ★발산 조건을 수치로: 루프 이득 g = a (지수→종목 임팩트 계수).
 *   종목→지수 반영은 가중합이라 계수가 1 이다.
 *     a < 1  수렴 (등비급수 1/(1−a))
 *     a >= 1 ★발산
 *   우리는 a = 0 이다 ⇒ 루프 이득 0 ⇒ «발산이 구조적으로 불가능»하다.
 *   그래서 별도 감쇠 장치가 필요 없다. 감쇠를 넣고 싶어지면 이 문단을 먼저 읽어라.
 *
 * ★그럼 반대 방향은? 「종목으로 밀고 지수에서 먹기」 — 이건 «막아야 한다».
 *   공격 이익 = M · w_i · W · N_i / depth_i      (M=지수 명목, w_i=구성비중, W=ORDER_FLOW_WEIGHT)
 *   공격 손실 = 2W · N_i² / depth_i + 수수료      (종목 왕복에서 «자기 임팩트»를 두 번 문다)
 *   이익 > 손실  ⟺  M > 2·N_i / c_i
 *
 * ⛔★c_i 는 «비중»이 아니라 «기여도»다 — 내 최초 유도가 여기서 틀렸다(2026-08-22 실측으로 정정).
 *      기여도 c_i = w_i × P_i / (제수 × 지수가)
 *   같은 비중이어도 «가격이 높은» 종목이 지수를 더 많이 민다.
 *   [실측] SPX 최대비중 7.76% 인데 최대 «기여도»는 12.07% (1.56배).
 *   비중으로 계산하면 차단 여유를 ★과대평가한다. 반드시 기여도를 써라.
 *
 *   [실측 · 현재 설정] 필요 지수명목 $12.0M vs 지수 주문상한 $2.9M ⇒ ★여유 4.1배 (SPX·NDX 동일)
 *   ⚠️기여도는 «가격에 따라 변한다» — 고비중 종목이 급등하면 커지고 여유가 줄어든다.
 *     위 4.1배는 «시작 시점» 값이다. 동적 최악값은 indexarb 벤치가 재야 한다.
 *   ★여러 종목을 동시에 밀어도 비율이 안 변한다 — 이익·손실이 «둘 다» 종목 수에 선형이다.
 *   ⛔단 이건 «유도»다. scripts/bench/indexarb.ts 로 왕복 EV 음수를 «실측»하기 전에는
 *     닫힌 것으로 치지 마라. 이 앱은 유도상 안전해 보이던 경로에서 무한돈 버그가 났다.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Instrument } from './types';

export type AssetClass = 'stock' | 'index' | 'commodity' | 'crypto';

/** 종목 메타 중 지수 구성에 «필요한 것만» — 데이터 소스에 의존하지 않게 좁혔다 */
export interface BasketMeta {
  ticker: string;
  rank: number;
  assetClass: AssetClass | string;
  exchange?: string;
}

export interface IndexConstituent {
  ticker: string;
  weight: number;
}

export interface IndexDef {
  ticker: string;
  constituents: IndexConstituent[];
  /** 시작 시점 가중합을 초기가에 맞추는 제수 */
  divisor: number;
}

/**
 * ★가중치 지수 α — w_r ∝ r^(−α).
 *
 * ⛔실제 시가총액을 쓰지 «않는» 이유: 시총에는 «주가»가 필요한데, 주가를 주는 소스는
 *   대부분 이용약관으로 재배포를 막는다(저작권이 아니라 «계약» 문제다).
 *   ⇒ 랭크 기반으로 «합성»한다. ★합성했다는 사실을 여기 명시한다.
 *
 * ★α = 0.8 인 근거: 500종목에서 최상위 비중이 7.76% 가 되는 값이다(실측).
 *   α 를 올리면 비중이 상위로 쏠려 기여도가 커지고 «차익거래 차단 여유가 줄어든다».
 *   ⇒ α 를 바꾸면 indexcheck·indexarb 벤치를 «둘 다» 다시 돌려라.
 */
export const INDEX_WEIGHT_ALPHA = 0.8;

/**
 * ★구성비중 «상한». 초과분은 나머지에 비례 재분배한다(수렴할 때까지 반복).
 *
 * ⛔왜 필요한가 [실측 2026-08-22 · 내 최초 유도가 틀렸다]:
 *   차익거래 차단 유도에서 w_i ≈ 0.07 을 가정했는데, α=0.8 의 «실제» 최대비중은
 *     구성 500종목(SPX) -> 7.76%   (가정과 비슷)
 *     구성 100종목(NDX) -> ★12.29% (가정의 1.76배)
 *   구성 수가 적을수록 상위로 쏠린다. NDX 는 차단 여유가 28.6배가 아니라 ★2.0배였다.
 *   ⇒ 상한을 걸어 두 지수의 w_i 를 «같은 자리»로 눌러야 유도가 두 지수 모두에 유효하다.
 * ★실제 지수도 상한 규칙을 갖는다(캡핑 방법론) — 게임만의 장치가 아니다.
 */
export const MAX_CONSTITUENT_WEIGHT = 0.08;

/**
 * ★지수 유동성 깊이 배수 (기준 종목 깊이 대비).
 *
 * ⛔올리지 마라 — 이게 「종목으로 밀고 지수에서 먹기」의 차단선이다.
 *   차단 조건: 지수 주문상한 < 2·N_i / c_i  (c_i = «기여도», 비중이 아니다)
 *   [실측] 최대기여도 12.07% · N_i = $0.72M 일 때
 *   필요 지수명목 $12.0M vs 지수 주문상한 $2.9M ⇒ ★여유 4.1배.
 *   8 로 올리면 여유가 2.1배로 줄고, 그 위는 사실상 문턱이다.
 * ⛔이 값을 바꾸면 scripts/bench/indexarb.ts 를 «반드시» 다시 돌려라.
 */
export const INDEX_DEPTH_MULT = 4;

/** 지수 정의 — 구성 규칙만 적고 «명단은 런타임에 유도»한다(데이터가 바뀌어도 따라온다) */
const INDEX_SPECS: Array<{
  ticker: string;
  size: number;
  /** 구성 자격 */
  eligible: (m: BasketMeta) => boolean;
}> = [
  {
    ticker: 'SPX',
    size: 500,
    eligible: (m) => m.assetClass === 'stock',
  },
  {
    ticker: 'NDX',
    size: 100,
    eligible: (m) => m.assetClass === 'stock' && m.exchange === 'Nasdaq',
  },
];

/**
 * 비중 상한을 적용하고 초과분을 «나머지에 비례» 재분배한다.
 * ★한 번으로 안 끝난다 — 재분배가 다른 종목을 상한 위로 밀 수 있어서 수렴할 때까지 돈다.
 * ★상한 × 구성수 < 1 이면 수학적으로 불가능하다(예: 상한 8% × 10종목 = 80%).
 *   그때는 «균등»으로 떨어뜨린다 — 조용히 합이 1 이 아닌 상태로 두지 않는다.
 */
export function capWeights(cs: IndexConstituent[], cap = MAX_CONSTITUENT_WEIGHT): IndexConstituent[] {
  const n = cs.length;
  if (n === 0) return cs;
  if (cap * n <= 1) return cs.map((c) => ({ ...c, weight: 1 / n }));
  const w = cs.map((c) => c.weight);
  for (let iter = 0; iter < 100; iter++) {
    let excess = 0;
    let freeSum = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] > cap) { excess += w[i] - cap; w[i] = cap; }
      else freeSum += w[i];
    }
    if (excess <= 1e-12) break;
    if (freeSum <= 0) break;
    for (let i = 0; i < n; i++) if (w[i] < cap) w[i] += (excess * w[i]) / freeSum;
  }
  const total = w.reduce((a, b) => a + b, 0);
  return cs.map((c, i) => ({ ticker: c.ticker, weight: w[i] / total }));
}

/**
 * 지수 정의를 만든다.
 * @param instruments 엔진에 실린 종목(초기가를 여기서 읽어 제수를 정한다)
 * @param metas       assetClass·exchange 를 아는 메타
 */
export function buildIndexes(instruments: Instrument[], metas: BasketMeta[]): Map<string, IndexDef> {
  const instOf = new Map(instruments.map((i) => [i.ticker, i]));
  const out = new Map<string, IndexDef>();

  for (const spec of INDEX_SPECS) {
    // 지수 자신이 종목 목록에 없으면 만들지 않는다(종목 100개 데이터에서는 지수가 없다)
    const self = instOf.get(spec.ticker);
    if (!self) continue;

    const members = metas
      .filter((m) => spec.eligible(m) && instOf.has(m.ticker))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, spec.size);
    if (members.length === 0) continue;

    // w_r ∝ r^(−α) — r 은 «지수 안에서의» 순위(1부터). 전체 랭크가 아니다.
    let wsum = 0;
    const raw = members.map((m, i) => {
      const w = Math.pow(i + 1, -INDEX_WEIGHT_ALPHA);
      wsum += w;
      return { ticker: m.ticker, weight: w };
    });
    const constituents = capWeights(raw.map((c) => ({ ticker: c.ticker, weight: c.weight / wsum })));

    // 제수: 시작 가중합 / 초기가 → 지수가 초기가에서 출발한다
    let start = 0;
    for (const c of constituents) start += c.weight * (instOf.get(c.ticker)?.initialPrice ?? 0);
    const divisor = start > 0 && self.initialPrice > 0 ? start / self.initialPrice : 1;

    out.set(spec.ticker, { ticker: spec.ticker, constituents, divisor });
  }
  return out;
}

/**
 * 현재 지수가 = Σ(구성종목가 × 가중치) / 제수.
 * ★priceOf 가 throw 하지 않도록 «없는 종목은 건너뛴다» — 명단과 엔진이 어긋나도 죽지 않는다.
 */
export function indexPriceOf(def: IndexDef, priceOf: (t: string) => number | undefined): number {
  let acc = 0;
  for (const c of def.constituents) {
    const p = priceOf(c.ticker);
    if (p !== undefined && Number.isFinite(p)) acc += c.weight * p;
  }
  return def.divisor > 0 ? acc / def.divisor : 0;
}

/** 최대 구성비중 — 차익거래 차단 유도에 쓰는 w_i 를 «실제 값»으로 확인할 때 */
export function maxWeight(def: IndexDef): number {
  let m = 0;
  for (const c of def.constituents) if (c.weight > m) m = c.weight;
  return m;
}
