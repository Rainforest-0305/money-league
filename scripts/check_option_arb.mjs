#!/usr/bin/env node
/**
 * 옵션 «무차익» 검사기 — 2026-09-05 신설 (President 「블랙숄츠 모형에 따라 효율적 가격 책정」).
 *
 * ★check_strikes.mjs 가 «행사가 사다리»를 지키듯, 이 검사기는 «가격 자체»를 지킨다.
 *   행사가가 예뻐도 프리미엄이 무차익을 깨면 그건 곧 공짜 돈이다.
 *
 * ── 검사 항목 ──────────────────────────────────────────────────────────
 *   ① 풋콜 패리티      C − P = F − K        (F = 선도가 · 이 게임의 r 은 0 이다 — 아래 주석)
 *   ② 만기 수렴        T → 0  ⇒ 프리미엄 → 내재가치
 *   ③ 델타 범위        콜 ∈ [0,1] · 풋 ∈ [−1,0] · 해석델타 ≈ 유한차분델타
 *   ④ 단조성           K↑ ⇒ 콜↓ · 풋↑   /   σ↑ ⇒ 둘 다 ↑   /   T↑ ⇒ 둘 다 ↑
 *   ⑤ 하한             프리미엄 ≥ 내재가치 · ≥ $0.01
 *   ⑥ 계약 크기 사다리  전 종목 v×개시가 ≤ 목표 · 사다리에서 «가장 큰» 값 · 주식은 전부 10
 *   ⑦ 소스 배선        엔진이 `engine.sigmaOf` 를 쓰고 `inst.sigma` 로 되돌아가지 않았는지
 *   ⑧ ★선도가 일치     «옵션이 쓰는 F» 와 «선도 견적의 공정가» 가 같은 규칙에서 나오는가
 *      (2026-09-05 President 결정 ③ — 두 상품이 다른 선도가를 쓰면 그 차이가 곧 차익이다)
 *
 * ⛔왜 r 이 없는가 (①의 우변에 `K·e^{−rT}` 가 아니라 그냥 `K` 인 이유):
 *   ★이 게임의 무위험이자율은 «측정된 0%»다. 현금은 이자를 «한 푼도» 낳지 않는다
 *     (world.ts 어디에도 현금에 이자를 붙이는 경로가 없다 — 이 검사기가 아래에서 실제로 확인한다).
 *   ⇒ r 을 0 이 아닌 값으로 넣으면 «게임 안에 존재하지 않는 금융비용»을 값에 넣는 것이고,
 *     그 순간 옵션 합성포지션과 실제 선도(ContractOrder)의 가격이 갈려 ★차익이 «생긴다».
 *   ⇒ 즉 r=0 은 게으름이 아니라 «이 경제에 맞는 값»이다. 근거 수치는 보고서 ④ 참조.
 *
 * ★배당은 «수량» 검사에서 제외한다: `optionPremium` 자체는 배당을 모른다(엔진이 S 에
 *   `divFactor` 를 곱해서 넘긴다). 그러므로 여기서는 배당 없는 S 로 모델 성질만 본다.
 *
 * 재현:  node scripts/check_option_arb.mjs --selftest && node scripts/check_option_arb.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/* TS 소스를 그대로 부르기 위한 확장자 해석 훅.
   ⚠check_strikes.mjs 판은 «확장자가 없을 때만» .ts 를 붙인다. 그 조건은
   `../../data/tickers.generated` 에서 깨진다 — `.generated` 가 확장자로 «보이기» 때문이다.
   ⇒ 여기서는 상대경로면 무조건 .ts 를 한 번 더 시도한다(엔진 전체를 불러야 하므로). */
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.')) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELFTEST = new Set(process.argv.slice(2)).has('--selftest');

const { optionPremium, optionDelta, strikeChoices } = await import(
  pathToFileURL(resolve(ROOT, 'src/lib/options.ts')).href
);
const {
  TRADING_DAYS_PER_YEAR,
  OPTION_EXPIRY_CHOICES,
  SHARES_PER_CONTRACT,
  CONTRACT_SIZE_LADDER,
  TARGET_CONTRACT_NOTIONAL_USD,
  sharesPerContractFor,
} = await import(pathToFileURL(resolve(ROOT, 'src/lib/constants.ts')).href);

/* ── 허용오차 — ⛔전부 «근거»가 붙어 있다 ────────────────────────────────
 * normCdf 는 Abramowitz-Stegun 7.1.26 근사라 절대오차가 최대 7.5e-8 이다.
 * 패리티 오차는 그 오차 × (S + K) 규모로 커지므로 «상대» 허용오차로 잡는다.
 */
const PARITY_REL_TOL = 5e-6;
/** 만기 수렴: T=1e-6 게임일이면 시간가치가 사실상 0 이어야 한다 */
const CONVERGE_ABS_TOL = 1e-6;
/** 유한차분 델타 대조 허용오차(주당). h = S×1e-4 로 잡을 때의 2차 항 규모 */
const DELTA_TOL = 2e-3;

function tickers() {
  const src = readFileSync(resolve(ROOT, 'src/data/tickers.generated.ts'), 'utf8');
  const rows = [];
  for (const m of src.matchAll(/\{"rank".*?\}/g)) rows.push(JSON.parse(m[0]));
  if (rows.length < 50) throw new Error(`ticker 수집 실패 (${rows.length}개)`);
  return rows;
}

/** 현재가 스트레스 배수 — 개시가만 보면 «게임 중 가격»을 안 본 것이다 */
const DRIFTS = [0.5, 0.85, 1.0, 1.3, 2.0];
/** 실현변동성 EWMA 가 실제로 도달하는 구간(데이터 sigma 대비 0.15~1.2배, 실측) */
const SIGMA_MULTS = [0.15, 0.5, 1.0, 1.2];

/**
 * 모델 검사 본체.
 * @param impl 검사 대상 구현 — 양성대조 때 «망가뜨린 구현»을 끼워 넣는다.
 */
function runModel(impl) {
  const { premium, delta } = impl;
  const errs = [];
  const push = (rule, at, detail) => {
    if (errs.length < 40) errs.push([rule, at, detail]);
    else errs.push(null);
  };
  const rows = tickers();
  let cases = 0;
  let parityMax = 0;
  let floored = 0;

  for (const r of rows) {
    for (const dr of DRIFTS) {
      const S = Number((r.initialPrice * dr).toFixed(4));
      for (const sm of SIGMA_MULTS) {
        const sig = r.sigma * sm;
        for (const T of OPTION_EXPIRY_CHOICES) {
          const ks = strikeChoices('call', S);
          for (const K of ks) {
            cases++;
            const at = `${r.ticker} S=${S} K=${K} σ=${sig.toFixed(4)} T=${T}`;
            const c = premium('call', S, K, sig, T);
            const p = premium('put', S, K, sig, T);

            // ⑤ 하한 — 내재가치 밑으로 내려가면 즉시 차익이다
            const ic = Math.max(S - K, 0);
            const ip = Math.max(K - S, 0);
            if (c < ic - 1e-9) push('⑤ 콜이 내재가치보다 싸다', at, `${c} < ${ic}`);
            if (p < ip - 1e-9) push('⑤ 풋이 내재가치보다 싸다', at, `${p} < ${ip}`);
            if (c < 0.01 - 1e-9 || p < 0.01 - 1e-9) push('⑤ 프리미엄이 $0.01 하한 아래다', at, `c=${c} p=${p}`);

            // ① 풋콜 패리티 — ★«하한에 걸린» 칩은 제외한다.
            //   0.01 하한은 모델이 아니라 «표시 최소단위»라 패리티를 깨는 게 정상이다.
            const cFloored = c <= 0.01 + 1e-12 || Math.abs(c - ic) < 1e-12;
            const pFloored = p <= 0.01 + 1e-12 || Math.abs(p - ip) < 1e-12;
            if (!cFloored && !pFloored) {
              const lhs = c - p;
              const rhs = S - K;
              const rel = Math.abs(lhs - rhs) / Math.max(1, Math.abs(S));
              parityMax = Math.max(parityMax, rel);
              if (rel > PARITY_REL_TOL) push('① 풋콜 패리티 위반', at, `C−P=${lhs} vs S−K=${rhs} (rel ${rel.toExponential(2)})`);
            } else {
              floored++;
            }

            // ③ 델타 범위 + 유한차분 대조
            const dc = delta('call', S, K, sig, T);
            const dp = delta('put', S, K, sig, T);
            if (!(dc >= -1e-9 && dc <= 1 + 1e-9)) push('③ 콜 델타가 [0,1] 밖', at, String(dc));
            if (!(dp >= -1 - 1e-9 && dp <= 1e-9)) push('③ 풋 델타가 [−1,0] 밖', at, String(dp));
            if (Math.abs(dc - dp - 1) > 1e-6 && !cFloored && !pFloored) {
              push('③ 델타 패리티 위반 (Δc − Δp ≠ 1)', at, `${dc} − ${dp}`);
            }
            /* ★유한차분 대조는 «세 점 모두» 하한에서 자유로울 때만 뜻이 있다.
               $0.01 하한이나 내재가치 하한에 한 점이라도 닿으면 기울기가 인위적으로 잘려
               「모델이 틀렸다」가 아니라 「표시 최소단위에 눌렸다」를 보게 된다.
               [실측] 이 가드가 없으면 깊은 OTM 에서 FD 가 정확히 절반으로 나온다
               (NEM S=283.92 K=290 σ=0.0657: 해석 0.01116 vs FD 0.00610). */
            const h = S * 1e-4;
            const cm = premium('call', S - h, K, sig, T);
            const cp = premium('call', S + h, K, sig, T);
            const free = (x, s) => x > 0.01 + 1e-9 && x > Math.max(s - K, 0) + 1e-9;
            if (free(c, S) && free(cm, S - h) && free(cp, S + h)) {
              const fd = (cp - cm) / (2 * h);
              if (Math.abs(fd - dc) > DELTA_TOL) push('③ 해석델타 ≠ 유한차분델타', at, `${dc} vs ${fd}`);
            }

            // ② 만기 수렴 — ★잔여 시간가치는 S·σ·√T 규모다. 허용오차도 그 척도로 잡는다.
            const c0 = premium('call', S, K, sig, 0);
            const tEps = 1e-9;
            const cEps = premium('call', S, K, sig, tEps);
            const tol = Math.max(CONVERGE_ABS_TOL, 10 * S * sig * Math.sqrt(tEps / TRADING_DAYS_PER_YEAR));
            if (c0 !== ic && Math.abs(c0 - ic) > 1e-12) push('② T=0 이 내재가치가 아니다', at, `${c0} vs ${ic}`);
            if (cEps - Math.max(ic, 0.01) > tol)
              push('② T→0 수렴 실패', at, `${cEps} vs ${Math.max(ic, 0.01)} (tol ${tol.toExponential(2)})`);
          }

          // ④ 단조성 — 같은 (S, σ, T) 에서 K 를 «촘촘히» 올리며 본다
          let prevC = Infinity;
          let prevP = -Infinity;
          for (let i = 0; i <= 20; i++) {
            const K = S * (0.6 + i * 0.04);
            const c = premium('call', S, K, sig, T);
            const p = premium('put', S, K, sig, T);
            const at = `${r.ticker} S=${S} K=${K.toFixed(4)} σ=${sig.toFixed(4)} T=${T}`;
            if (c > prevC + 1e-9) push('④ K↑ 인데 콜이 비싸졌다', at, `${prevC} → ${c}`);
            if (p < prevP - 1e-9) push('④ K↑ 인데 풋이 싸졌다', at, `${prevP} → ${p}`);
            prevC = c;
            prevP = p;
          }
          // ④ σ↑ ⇒ 프리미엄 ↑ (베가 ≥ 0)
          const Katm = Math.round(S);
          const lo = premium('call', S, Katm, sig, T);
          const hi = premium('call', S, Katm, sig * 1.5, T);
          if (hi < lo - 1e-9) push('④ σ↑ 인데 콜이 싸졌다', `${r.ticker} S=${S} K=${Katm} T=${T}`, `${lo} → ${hi}`);
          // ④ T↑ ⇒ 프리미엄 ↑
          const t1 = premium('call', S, Katm, sig, T);
          const t2 = premium('call', S, Katm, sig, T * 2);
          if (t2 < t1 - 1e-9) push('④ T↑ 인데 콜이 싸졌다', `${r.ticker} S=${S} K=${Katm} σ=${sig}`, `${t1} → ${t2}`);
        }
      }
    }
  }
  return { errs: errs.filter(Boolean), cases, parityMax, floored };
}

/** ⑥ 계약 크기 사다리 불변식 — 전 1,000종목 전수 */
function runLadder() {
  const errs = [];
  const rows = tickers();
  let stockNot10 = 0;
  const byTicker = {};
  for (const r of rows) {
    const v = sharesPerContractFor(r.initialPrice);
    byTicker[r.ticker] = v;
    if (!CONTRACT_SIZE_LADDER.includes(v)) errs.push(['⑥ 사다리 밖의 값', r.ticker, String(v)]);
    const notional = v * r.initialPrice;
    // 사다리 «맨 아래»(0.01)로도 목표를 못 맞추는 초고가 자산은 예외로 허용한다
    const atFloor = v === CONTRACT_SIZE_LADDER[CONTRACT_SIZE_LADDER.length - 1];
    if (notional > TARGET_CONTRACT_NOTIONAL_USD + 1e-9 && !atFloor)
      errs.push(['⑥ 계약 명목이 목표를 넘는다', r.ticker, `${notional.toFixed(0)} > ${TARGET_CONTRACT_NOTIONAL_USD}`]);
    // «가장 큰» 사다리 값이어야 한다 — 한 칸 위는 반드시 목표를 넘어야 한다
    const idx = CONTRACT_SIZE_LADDER.indexOf(v);
    if (idx > 0) {
      const up = CONTRACT_SIZE_LADDER[idx - 1];
      if (up * r.initialPrice <= TARGET_CONTRACT_NOTIONAL_USD + 1e-9)
        errs.push(['⑥ 더 큰 사다리 값이 가능한데 안 골랐다', r.ticker, `${v} → ${up}`]);
    }
    if ((r.assetClass ?? 'stock') === 'stock' && v !== SHARES_PER_CONTRACT) stockNot10++;
  }
  return { errs, stockNot10, byTicker, total: rows.length };
}

/**
 * ⑦ 소스 배선 — «값»이 아니라 «누가 값을 정하는가»를 지킨다.
 *   0건은 부재의 증거가 아니므로, 각 패턴은 「있어야 한다」와 「있으면 안 된다」를 «쌍»으로 본다.
 */
/**
 * ★★주석을 «지우고» 본다 — ⛔이게 없으면 검사기가 자기 자신을 속인다.
 *   [실측 2026-09-05] 「⛔`ref * (1 + c.total)` 로 되돌리지 마라」라는 «금지 안내 주석»이
 *   금지패턴 스캔에 걸려 ★거짓 위반 2건이 났다. 반대로 「must」 패턴이 주석에만 있어도
 *   ★거짓 통과가 난다 — 두 방향 다 위험하다.
 * ⚠한계: 문자열 리터럴 안의 `//`·`/*` 도 지운다. 이 엔진 파일들에는 그런 문자열이 없다
 *   (있게 되면 이 함수부터 고쳐라 — 조용히 틀리는 것보다 낫다).
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function runWiring() {
  const errs = [];
  const world = stripComments(readFileSync(resolve(ROOT, 'src/lib/engine/world.ts'), 'utf8'));
  const engine = stripComments(readFileSync(resolve(ROOT, 'src/lib/engine/priceEngine.ts'), 'utf8'));
  const bots = stripComments(readFileSync(resolve(ROOT, 'src/lib/engine/bots.ts'), 'utf8'));

  const must = [
    ['world 에 선도가 «단일 통로»가 있어야 한다', world, /forwardPrice\(ticker: string, basePrice: number, gameDays: number\): number/],
    ['optionQuote 가 carryFactor 로 선도가를 만들어야 한다', world, /const cf = this\.carryFactor\(ticker, expiryGameDays\)/],
    ['optionMarkValue 가 forwardPrice 를 써야 한다', world, /this\.forwardPrice\(pos\.ticker, S, remainDays\)/],
    ['quotesFor 가 forwardFairPrice 를 써야 한다', world, /const fair = this\.forwardFairPrice\(ticker, gameDays\)/],
    ['priceEngine 에 sigmaOf 가 있어야 한다', engine, /sigmaOf\(ticker: string\): number/],
    ['priceEngine 이 varEwma 를 갱신해야 한다', engine, /varEwma \+= VOL_EWMA_LAMBDA/],
    ['optionQuote 가 engine.sigmaOf 를 써야 한다', world, /const sigma = this\.engine\.sigmaOf\(ticker\)/],
    ['optionMarkValue 가 engine.sigmaOf 를 써야 한다', world, /optionPremium\(pos\.kind, Sd, pos\.strike, this\.engine\.sigmaOf\(pos\.ticker\)/],
    ['world 에 sharesPerContractOf 가 있어야 한다', world, /sharesPerContractOf\(ticker: string\): number/],
    ['옵션 개시가 계약 크기를 찍어야 한다', world, /sharesPerContract: this\.sharesPerContractOf\(ticker\)/],
    ['봇도 같은 sigma 를 써야 한다', bots, /w\.engine\.sigmaOf\(t\)/],
    ['봇도 같은 계약 크기를 써야 한다', bots, /w\.sharesPerContractOf\(t\)/],
  ];
  for (const [name, src, re] of must) if (!re.test(src)) errs.push(['⑦ 배선 끊김', name, '패턴 없음']);

  const banned = [
    ['옵션 식이 inst.sigma 로 되돌아갔다', world, /optionPremium\([^)]*inst\.sigma/],
    ['델타 식이 inst.sigma 로 되돌아갔다', world, /optionDelta\([^)]*inst\.sigma/],
    ['옵션 명목에 SHARES_PER_CONTRACT 가 직접 곱해졌다', world, /contracts \* SHARES_PER_CONTRACT/],
    ['계약 수 상한이 되살아났다', world, /MAX_OPTION_CONTRACTS/],
    ['옵션이 divFactor(배당만) 로 되돌아갔다', world, /(optionPremium|optionDelta)\([^)]*divFactor/],
    ['선도 공정가를 손으로 다시 계산했다', world, /ref \* \(1 \+ c\.total\)/],
    ['유동성 상한 검사가 되살아났다', world, /this\.assertOrderSize\(/],
  ];
  for (const [name, src, re] of banned) if (re.test(src)) errs.push(['⑦ 금지 패턴 부활', name, String(src.match(re)?.[0]).slice(0, 80)]);

  // ★현금에 이자를 붙이는 경로가 «없다»는 것 = 이 게임의 r 이 0 이라는 근거
  if (/cash \*= \(1 \+|cash \+= [^;]*interest|RISK_FREE/i.test(world)) {
    errs.push(['⑦ 현금 이자 경로 발견', 'r=0 전제가 깨졌다 — check_option_arb 의 패리티 식을 갱신하라', '']);
  }
  return errs;
}

/**
 * ⑧ ★선도가 일치 — «엔진을 실제로 띄워서» 본다(모델식 재구현 아님).
 *
 * ★작은 합성 월드를 쓴다(봇 없음·종목 4개). 목적이 «규칙의 일치»이지 «시장»이 아니라서다.
 * ★검사 3종:
 *   (a) 옵션 견적이 돌려주는 F 가 정확히 `S × carryFactor(ticker, T)` 다
 *   (b) 그 F 가 «패리티로 역산한 선도가»(C − P + K)와 같다  ⇒ 모델이 실제로 F 를 썼다
 *   (c) `forwardFairPrice(tk,T) / refPrice(tk,N)` == `carryFactor(tk,T)`
 *       ⇒ 선도 견적과 옵션이 «같은 캐리 규칙»을 쓴다. 남는 차이는 «기준가»(체결가 vs 중앙값)뿐이고
 *         그건 의도된 설계다(계약 조건은 펌프에 면역, 옵션 평가는 시세 추종).
 * ★허용오차: (a)(c) 는 «부동소수 반올림»만 허용 → 상대 1e-12.
 *            (b) 는 BS 두 번(콜·풋)의 normCdf 근사 오차가 누적된다 → 선도가 대비 상대 5e-6.
 */
async function runForwardParity(breakIt = false) {
  const errs = [];
  const { World } = await import(pathToFileURL(resolve(ROOT, 'src/lib/engine/world.ts')).href);
  const { Rng } = await import(pathToFileURL(resolve(ROOT, 'src/lib/engine/rng.ts')).href);
  void Rng;
  const instruments = [
    { rank: 1, ticker: 'AAA', initialPrice: 100, mu: 0.1, sigma: 0.25, liquidityDepth: 5e6 },
    { rank: 50, ticker: 'BBB', initialPrice: 2500, mu: 0.05, sigma: 0.15, liquidityDepth: 3e6 },
    { rank: 90, ticker: 'CCC', initialPrice: 40, mu: 0.2, sigma: 0.6, liquidityDepth: 2e6 },
    { rank: 99, ticker: 'DDD', initialPrice: 700, mu: 0.0, sigma: 0.35, liquidityDepth: 4e6 },
  ];
  const meta = new Map(instruments.map((i) => [i.ticker, { sectorKo: '반도체', assetClass: 'stock' }]));
  const w = new World({ instruments, seed: 11, botsEnabled: false, tickerMeta: meta });
  w.muted = true;
  for (let i = 0; i < 400; i++) w.step();
  w.muted = false;
  /* ★캐리 EWMA 를 «강제로» 데운다 — 워밍업 전에는 base=0 이라 (a)(b)(c) 가 전부
     「1 × 1 == 1」이 되어 ★아무것도 검사하지 못한다(죽은 검사). 여기서는 규칙 일치를 봐야 한다. */
  w.engine.carrySamples = 1e9;
  w.engine.carryEwmaPerTick = 3e-6;
  /* ★양성대조 — 「옵션만 옛 규칙(배당만)으로 되돌린」 사본을 만든다.
     선도는 carryFactor 를 계속 쓰므로 ⑧이 «반드시» 걸려야 한다. 안 걸리면 이 검사는 죽은 것이다. */
  if (breakIt) {
    const orig = w.optionQuote.bind(w);
    w.optionQuote = (...a) => {
      const q = orig(...a);
      const df = w.divFactor(a[0], a[3]);
      return { ...q, F: q.S * df, carryFactor: df };
    };
  }

  for (const inst of instruments) {
    const tk = inst.ticker;
    for (const T of OPTION_EXPIRY_CHOICES) {
      const cf = w.carryFactor(tk, T);
      const ref = w.engine.refPrice(tk, 21);
      const at = `${tk} T=${T} cf=${cf.toFixed(10)}`;

      // (c) 선도 견적의 공정가가 «같은» 캐리 규칙에서 나오는가
      const fairRatio = w.forwardFairPrice(tk, T) / ref;
      if (Math.abs(fairRatio / cf - 1) > 1e-12)
        errs.push(['⑧ 선도 공정가가 옵션과 다른 캐리를 쓴다', at, `${fairRatio} vs ${cf}`]);

      const S0 = w.engine.priceOf(tk);
      for (const K of strikeChoices('call', S0)) {
        // 계약 1개 · 임팩트가 콜/풋에 «같은 방향»으로 걸리도록 매수로 통일한다
        const c = w.optionQuote(tk, 'call', K, T, 1, 'buy');
        const p = w.optionQuote(tk, 'put', K, T, 1, 'buy');
        const at2 = `${tk} K=${K} T=${T}`;

        // (a) 견적의 F 가 S × carryFactor 인가
        for (const q of [c, p]) {
          if (Math.abs(q.F / (q.S * cf) - 1) > 1e-12)
            errs.push(['⑧ 견적 F ≠ S × carryFactor', at2, `${q.F} vs ${q.S * cf}`]);
          if (Math.abs(q.carryFactor - cf) > 1e-12)
            errs.push(['⑧ 견적 carryFactor 불일치', at2, `${q.carryFactor} vs ${cf}`]);
        }

        /* (b) 패리티 역산 — ★콜과 풋의 헤지 임팩트가 달라 S 가 «다르다».
           그래서 «같은 F» 에서 다시 매긴 값으로 본다(모델 성질 검사이지 체결가 검사가 아니다). */
        const F = c.F;
        const sig = w.engine.sigmaOf(tk);
        const cc = optionPremium('call', F, K, sig, T);
        const pp = optionPremium('put', F, K, sig, T);
        const floored = cc <= 0.01 + 1e-12 || pp <= 0.01 + 1e-12 ||
          Math.abs(cc - Math.max(F - K, 0)) < 1e-12 || Math.abs(pp - Math.max(K - F, 0)) < 1e-12;
        if (!floored) {
          const implied = cc - pp + K;
          if (Math.abs(implied / F - 1) > 5e-6)
            errs.push(['⑧ 패리티 역산 선도가 ≠ F', at2, `${implied} vs ${F}`]);
        }
      }
    }
  }
  return errs;
}

/* ══════════════════ 자기검사 (양성/음성 대조) ══════════════════ */
if (SELFTEST) {
  const good = { premium: optionPremium, delta: optionDelta };
  const cases = [];

  // (a) 패리티를 깬 구현 — 풋에 5% 를 더한다
  cases.push([
    '(a) 패리티 위반',
    { premium: (k, S, K, s, T) => (k === 'put' ? optionPremium(k, S, K, s, T) * 1.05 : optionPremium(k, S, K, s, T)), delta: optionDelta },
    '①',
  ]);
  // (b) 만기 수렴 실패 — T=0 에서도 시간가치를 남긴다
  cases.push([
    '(b) 만기 수렴 실패',
    { premium: (k, S, K, s, T) => optionPremium(k, S, K, s, Math.max(T, 0.5)), delta: optionDelta },
    '②',
  ]);
  // (c) 델타 범위 위반
  cases.push(['(c) 델타 범위 위반', { premium: optionPremium, delta: (k, S, K, s, T) => optionDelta(k, S, K, s, T) * 1.8 }, '③']);
  // (d) K 단조성 위반 — 콜이 K 에 «증가»하게 만든다
  cases.push([
    '(d) K 단조성 위반',
    { premium: (k, S, K, s, T) => optionPremium(k, S, K, s, T) + (k === 'call' ? K * 0.01 : 0), delta: optionDelta },
    '④',
  ]);
  // (e) 내재가치 하한 위반
  cases.push([
    '(e) 내재가치 하한 위반',
    { premium: (k, S, K, s, T) => Math.max(0.01, optionPremium(k, S, K, s, T) * 0.5), delta: optionDelta },
    '⑤',
  ]);

  let fired = 0;
  for (const [name, impl, rule] of cases) {
    const { errs } = runModel(impl);
    const hit = errs.some((e) => e[0].startsWith(rule));
    console.log(`  [selftest] ${hit ? 'CAUGHT ' : 'MISSED '} ${name} → ${rule} (총 ${errs.length}건)`);
    if (hit) fired++;
    else process.exitCode = 1;
  }

  // (f) 음성대조 — 현행 구현은 «안» 잡혀야 한다
  const base = runModel(good);
  console.log(`  [selftest] ${base.errs.length === 0 ? 'CLEAN  ' : 'FALSE+ '} (f) 현행 구현 음성대조 → ${base.errs.length}건`);
  if (base.errs.length !== 0) process.exitCode = 1;

  // (g) 사다리 양성대조 — 목표를 1/10 로 낮추면 지금 값들은 «너무 크다»고 잡혀야 한다
  const ladderNeg = tickers().filter((r) => sharesPerContractFor(r.initialPrice) * r.initialPrice > TARGET_CONTRACT_NOTIONAL_USD / 10).length;
  console.log(`  [selftest] ${ladderNeg > 0 ? 'CAUGHT ' : 'MISSED '} (g) 사다리 임계 축소 시 걸리는 종목 → ${ladderNeg}종`);
  if (ladderNeg === 0) process.exitCode = 1;

  // (h) 배선 양성대조 — 옛 코드(inst.sigma)를 심은 «사본»을 잡는가
  const worldSrc = readFileSync(resolve(ROOT, 'src/lib/engine/world.ts'), 'utf8');
  const mutated = worldSrc.replace('const sigma = this.engine.sigmaOf(ticker)', 'const sigma = inst.sigma');
  const wiringWouldFire = mutated !== worldSrc && !/const sigma = this\.engine\.sigmaOf\(ticker\)/.test(mutated);
  console.log(`  [selftest] ${wiringWouldFire ? 'CAUGHT ' : 'MISSED '} (h) 배선 되돌린 사본 → ⑦`);
  if (!wiringWouldFire) process.exitCode = 1;

  // (i) ⑧ 양성대조 — 옵션만 옛 규칙(배당만)으로 되돌린 사본을 잡는가
  const fwdBroken = await runForwardParity(true);
  const fwdClean = await runForwardParity(false);
  console.log(`  [selftest] ${fwdBroken.length > 0 ? 'CAUGHT ' : 'MISSED '} (i) 옵션만 divFactor 로 되돌린 사본 → ⑧ (${fwdBroken.length}건)`);
  console.log(`  [selftest] ${fwdClean.length === 0 ? 'CLEAN  ' : 'FALSE+ '} (j) 현행 선도가 음성대조 → ${fwdClean.length}건`);
  if (fwdBroken.length === 0 || fwdClean.length !== 0) process.exitCode = 1;

  console.log(
    `SELFTEST ${process.exitCode ? 'FAIL' : 'PASS'} (양성 ${fired + (ladderNeg > 0 ? 1 : 0) + (wiringWouldFire ? 1 : 0) + (fwdBroken.length > 0 ? 1 : 0)} · 음성 ${base.errs.length + fwdClean.length})`
  );
  if (process.exitCode) process.exit(process.exitCode);
}

/* ══════════════════ 본검사 ══════════════════ */
const model = runModel({ premium: optionPremium, delta: optionDelta });
const ladder = runLadder();
const wiring = runWiring();
const fwd = await runForwardParity();
const all = [...model.errs, ...ladder.errs, ...wiring, ...fwd];

console.log(
  `옵션 무차익 검사 — ${ladder.total}종목 × 배수 ${DRIFTS.join('/')} × σ배 ${SIGMA_MULTS.join('/')} × 만기 ${OPTION_EXPIRY_CHOICES.join('/')} × 행사가 4`
);
console.log(`  케이스 ${model.cases.toLocaleString()}개 · 패리티 최대 상대오차 ${model.parityMax.toExponential(2)} (허용 ${PARITY_REL_TOL.toExponential(1)})`);
console.log(`  하한($0.01)에 걸려 패리티에서 제외한 케이스 ${model.floored.toLocaleString()}개`);
console.log(
  `  계약 크기: 주식 중 10 이 아닌 종목 ${ladder.stockNot10}종 · ` +
    ['GOLD', 'WTI', 'BTC', 'ETH', 'SPX', 'NDX'].map((t) => `${t}=${ladder.byTicker[t]}`).join(' ')
);
console.log(`  소스 배선(⑦) ${wiring.length === 0 ? 'OK' : '위반 ' + wiring.length + '건'}`);
console.log(`  선도가 일치(⑧ · 엔진 실기동 · 캐리 강제 가열) ${fwd.length === 0 ? 'OK' : '위반 ' + fwd.length + '건'}`);

if (all.length) {
  console.log(`\n  ${all.length}건`);
  for (const e of all.slice(0, 40)) console.log(`   - ${e[0]} · ${e[1]} · ${e[2]}`);
  process.exit(1);
}
console.log('  0건');
console.log(
  `check_option_arb PASS — parity/converge/delta/monotone/floor(모델) · ladder(${ladder.total}종) · src-wiring · fwd-parity(엔진 실기동)`
);
