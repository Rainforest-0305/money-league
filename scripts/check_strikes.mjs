#!/usr/bin/env node
/**
 * 옵션 «행사가 사다리» 검사 — ★실제 `strikeChoices()` 를 «불러서» 숫자로 검사한다.
 *
 *   node scripts/check_strikes.mjs
 *   node scripts/check_strikes.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★왜 검사기인가 (2026-08-21 President 지적 「가격이 하드코딩 된 거야?」)
 *   옛 사다리는 자릿수 계단(`10^floor(log10(spot))`)으로 간격을 만들어
 *   «간격/현재가» 가 통제되지 않았다. 100종목 실측 1.67% ~ 22.48%.
 *   그 결과 ① ATM 칩이 현재가에서 최대 10.10% 떨어지고
 *          ② 만기 5일 콜 칩 400개 중 167개가 프리미엄 하한 $0.01 —
 *             즉 «가격이 없는 칩»이었고
 *          ③ 현재가 아래 콜이 딥 ITM 하나뿐이라 내재가치만으로도 비쌌다.
 *   전부 «에러가 안 나고 숫자만 이상한» 종류다. 주석으로는 못 막는다(U-4).
 *   ⇒ 간격은 «비율»이어야 한다는 규칙을 «세어지는 것»으로 만든다.
 *
 * ★검사 항목
 *   ① 칩 4개
 *   ② 모든 행사가가 0.5 의 배수 (부동소수 먼지·표기 어긋남 방지)
 *   ③ 표기 왕복 — `strikeLabel(k)` 를 다시 숫자로 읽으면 k 와 «같아야» 한다
 *   ④ 간격/현재가 ≤ MAX_STEP_PCT
 *   ⑤ ATM 칩 이탈 ≤ 간격의 절반  그리고  ≤ MAX_ATM_DEV_PCT
 *   ⑥ ITM 칩이 2개 (콜은 현재가 «아래» 2, 풋은 «위» 2) — President 지적 지점
 *   ⑦ 프리미엄 하한($0.01) 칩 비율 ≤ MAX_FLOOR_RATE
 *   ⑧ 「살 만한가」 — 가장 «얕은» ITM 칩의 깊이 ≤ MAX_ITM_DEPTH
 *
 * ★★양성대조는 «옛 구현»이다. 가짜 니들을 만들지 않는다 —
 *   실제로 문제였던 코드를 그대로 넣어 「이 검사기가 그걸 잡는가」를 본다.
 *   음성대조도 있다: 현행 구현은 «한 건도» 잡히면 안 된다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/* TS 소스를 그대로 부르기 위한 확장자 해석 훅 (Node 24 의 타입 스트리핑 사용) */
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELFTEST = new Set(process.argv.slice(2)).has('--selftest');

const { strikeChoices, optionPremium } = await import(pathToFileURL(resolve(ROOT, 'src/lib/options.ts')).href);
const { strikeLabel } = await import(pathToFileURL(resolve(ROOT, 'src/lib/format.ts')).href);
const { SEED_CASH, sharesPerContractFor, FEE_OPTION_BP, BP, OPTION_EXPIRY_CHOICES } = await import(
  pathToFileURL(resolve(ROOT, 'src/lib/constants.ts')).href
);

/* ── 임계값 — ⛔전부 «근거»가 붙어 있다. 올리려면 근거를 갱신해라 ─────────── */
/** 간격/현재가 상한. 실제 시장이 1~2.5% 이고 현행 실측 max 3.94% 다. */
const MAX_STEP_PCT = 0.05;
/** ATM 칩 이탈 상한. 현행 실측 max 1.74%. 옛 구현은 10.10% 였다. */
const MAX_ATM_DEV_PCT = 0.025;
/** 프리미엄 하한 칩 허용 비율. 현행 실측 0.35%. 옛 구현은 만기 5일에서 41.75% 였다. */
const MAX_FLOOR_RATE = 0.01;
/**
 * 「가장 얕은 ITM 칩」의 깊이 상한 = (|현재가 − 행사가|) / 현재가.
 *
 * ★왜 «비용»이 아니라 «깊이»인가: 비용은 주가에 비례해서 커진다($659 종목의 ITM 은
 *   당연히 비싸다). 그러면 임계값이 「측정치에 맞춘 숫자」가 되어 죽은 검사가 된다.
 *   깊이는 척도가 없어서 설계 의도로 정할 수 있다.
 * ★왜 6% 인가: 이 앱에서 가장 «안 움직이는» 조합(sigma 0.15 · 만기 3게임일)의
 *   1시그마 이동이 1.64% 다. 6% ITM 은 3.7시그마 안쪽 — 그보다 깊으면 옵션이 아니라
 *   «비싼 주식»이고, 내재가치만으로 값이 정해져 프리미엄을 고를 이유가 없다.
 * ★실측: 옛 구현 최대 24.8%(VZ@100.16 → K125) · 현행 최대 3.8%(BKNG@129.94 → K125).
 */
const MAX_ITM_DEPTH = 0.06;

/** 현재가 스트레스 배수 — 초기가만 보면 «게임 중 가격»을 안 본 것이다 */
const DRIFTS = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0];

function tickers() {
  const src = readFileSync(resolve(ROOT, 'src/data/tickers.generated.ts'), 'utf8');
  const rows = [];
  for (const m of src.matchAll(/\{"rank".*?\}/g)) rows.push(JSON.parse(m[0]));
  if (rows.length < 50) throw new Error(`ticker 수집 실패 (${rows.length}개)`);
  return rows;
}

/**
 * ★★[2026-09-05] 검사기가 «화면이 실제로 매기는 값»을 보게 만든다.
 *
 * ⛔이 검사기는 `r.sigma`(생성 데이터의 GBM 입력값)로 프리미엄을 매기고 있었다.
 *   그런데 2026-09-05 부터 엔진은 «실현변동성 EWMA»(engine.sigmaOf)를 쓴다.
 *   ⇒ 그대로 두면 이 검사기는 «아무도 안 보는 가격»을 검사하는 ★죽은 검사기가 된다.
 *     (「0건」이 부재의 증거가 아니었던 사례 목록에 하나 더 얹는 짓이다)
 *
 * ★배수의 근거 [실측 · scripts/bench/run.mjs deriv --mode vol · 1,000종목 × 3,000틱]
 *   실현변동성 / 데이터 sigma = 전 종목 p50 ★0.525 (엔진이 GBM 항에 DRIFT_WEIGHT=0.5 를 곱한다)
 *   ★지수만 다르다: SPX 0.169 · NDX 0.154 — 지수는 GBM 을 «타지 않고» 구성종목 가중합이라
 *     분산효과로 훨씬 조용하다. 그래서 지수는 별도 배수를 쓴다.
 * ⛔한 배수로 뭉개지 마라 — 지수를 0.5 로 보면 「없는 여유」를 있다고 보고한다.
 */
const PRICING_SIGMA_MULT_STOCK = 0.5;
const PRICING_SIGMA_MULT_INDEX = 0.16;
function pricingSigma(r) {
  return r.sigma * ((r.assetClass ?? 'stock') === 'index' ? PRICING_SIGMA_MULT_INDEX : PRICING_SIGMA_MULT_STOCK);
}

function costPerContract(kind, S, K, sigma, T, initialPrice) {
  /* ★[2026-09-05] 1계약이 담는 주수는 «종목마다 다르다»(constants.sharesPerContractFor).
     ⛔SHARES_PER_CONTRACT 를 박으면 BTC 계약 비용을 200배 크게 세어 «없는 문제»를 보고한다. */
  return optionPremium(kind, S, K, sigma, T) * sharesPerContractFor(initialPrice) * (1 + FEE_OPTION_BP * BP);
}

/**
 * 사다리 하나를 검사한다.
 * @param ladder (kind, spot) => number[]  — 검사 대상 구현(양성대조 때 옛 구현을 넣는다)
 */
function run(ladder = strikeChoices) {
  const errs = [];
  const rows = tickers();
  let floorHits = 0;
  let chipCount = 0;
  let itmDepthMax = 0;
  let itmCostMax = 0;

  for (const dr of DRIFTS) {
    for (const r of rows) {
      const spot = Number((r.initialPrice * dr).toFixed(2));
      for (const kind of ['call', 'put']) {
        const ks = ladder(kind, spot);
        const at = `${r.ticker}@${spot}(${kind})`;

        if (ks.length !== 4) errs.push([`① 칩이 4개가 아니다 (${ks.length})`, at, ks.join(',')]);
        for (const k of ks) {
          if (Math.abs(k * 2 - Math.round(k * 2)) > 1e-9) errs.push([`② 0.5 의 배수가 아니다`, at, String(k)]);
          const back = Number(strikeLabel(k).replace(/[$,]/g, ''));
          if (Math.abs(back - k) > 1e-9) errs.push([`③ 표기가 값과 다르다`, at, `${k} → ${strikeLabel(k)}`]);
        }

        const step = ks.length >= 2 ? ks[1] - ks[0] : 0;
        if (step / spot > MAX_STEP_PCT)
          errs.push([`④ 간격이 너무 넓다 ${(step / spot) * 100 > 0 ? ((step / spot) * 100).toFixed(1) : '?'}%`, at, ks.join(',')]);

        const atm = ks.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), ks[0]);
        const dev = Math.abs(atm - spot);
        if (step > 0 && dev > step / 2 + 1e-9) errs.push([`⑤ ATM 칩이 «가장 가까운 격자»가 아니다`, at, `${atm} vs ${spot}`]);
        if (dev / spot > MAX_ATM_DEV_PCT)
          errs.push([`⑤ ATM 칩 이탈 ${((dev / spot) * 100).toFixed(1)}%`, at, `${atm} vs ${spot}`]);

        const itm = kind === 'call' ? ks.filter((k) => k < spot) : ks.filter((k) => k > spot);
        if (itm.length < 2) errs.push([`⑥ ITM 칩이 ${itm.length}개다 (2개여야 한다)`, at, ks.join(',')]);

        if (itm.length) {
          const near = itm.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), itm[0]);
          const depth = Math.abs(spot - near) / spot;
          itmDepthMax = Math.max(itmDepthMax, depth);
          if (depth > MAX_ITM_DEPTH)
            errs.push([`⑧ 가장 얕은 ITM 칩이 ${(depth * 100).toFixed(1)}% 깊다`, at, `K=${near} vs ${spot}`]);
        }

        for (const T of OPTION_EXPIRY_CHOICES) {
          for (const k of ks) {
            chipCount++;
            if (optionPremium(kind, spot, k, pricingSigma(r), T) <= 0.0101) floorHits++;
          }
          for (const k of itm)
            itmCostMax = Math.max(itmCostMax, costPerContract(kind, spot, k, pricingSigma(r), T, r.initialPrice));
        }
      }
    }
  }

  const floorRate = chipCount ? floorHits / chipCount : 0;
  if (floorRate > MAX_FLOOR_RATE)
    errs.push([`⑦ 프리미엄 하한 칩 ${(floorRate * 100).toFixed(2)}%`, `${floorHits}/${chipCount}`, `상한 ${MAX_FLOOR_RATE * 100}%`]);

  return { errs, floorRate, floorHits, chipCount, itmDepthMax, itmCostMax };
}

/* ── 양성대조용 «옛 구현» — 2026-08-21 이전 src/lib/options.ts 원문 ────────── */
function ladderOld(kind, spot) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(spot, 1))) - 1);
  const step = Math.max(magnitude * (spot > 300 ? 5 : spot > 60 ? 2.5 : 1), 0.5);
  const atm = Math.round(spot / step) * step;
  const offsets = kind === 'call' ? [-1, 0, 1, 2] : [1, 0, -1, -2];
  const out = offsets
    .map((o) => Number((atm + o * step).toFixed(2)))
    .filter((k) => k > 0)
    .sort((a, b) => a - b);
  return [...new Set(out)];
}

if (SELFTEST) {
  const old = run(ladderOld);
  const oldCodes = new Set(old.errs.map(([m]) => m.slice(0, 1)));
  const cur = run();

  const results = [
    ['① 옛 구현의 «넓은 간격»을 잡는다', oldCodes.has('④')],
    ['② 옛 구현의 «ATM 이탈»을 잡는다', oldCodes.has('⑤')],
    ['③ 옛 구현의 «ITM 칩 부족»을 잡는다', oldCodes.has('⑥')],
    ['④ 옛 구현의 «깊은 ITM»을 잡는다', oldCodes.has('⑧')],
    [
      '⑤ 「0.5 배수 아님」을 잡는다',
      run((k, s) => [s * 1.0001, s + 1, s + 2, s + 3]).errs.some(([m]) => m.startsWith('②')),
    ],
    ['⑥ 「칩 4개 아님」을 잡는다', run((k, s) => [s - 1, s, s + 1]).errs.some(([m]) => m.startsWith('①'))],
    /* ★음성대조 — 현행 구현은 «한 건도» 잡히면 안 된다. 안 그러면 그냥 알람이다 */
    ['⑦ 현행 구현은 «안» 잡힌다(음성대조)', cur.errs.length === 0],
    ['⑧ 현행 하한 칩 비율이 상한 아래다(음성대조)', cur.floorRate <= MAX_FLOOR_RATE],
  ];

  console.log('strike ladder checker — 양성/음성 대조');
  let ok = true;
  for (const [n, caught] of results) {
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${n}`);
    if (!caught) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    if (cur.errs.length) for (const [m, at, v] of cur.errs.slice(0, 10)) console.error(`   ${m} · ${at} · ${v}`);
    process.exit(1);
  }
  console.log(`\nOK: 대조 ${results.length}종 전부 통과 — 검사기가 살아 있다.`);
  console.log(
    `   (옛 구현: ${old.errs.length}건 · 하한칩 ${(old.floorRate * 100).toFixed(2)}% · 얕은ITM 최대깊이 ${(old.itmDepthMax * 100).toFixed(1)}% · ITM 1계약 최대 $${old.itmCostMax.toFixed(0)})`
  );
  console.log(
    `   (현행  : 0건 · 하한칩 ${(cur.floorRate * 100).toFixed(2)}% · 얕은ITM 최대깊이 ${(cur.itmDepthMax * 100).toFixed(1)}% · ITM 1계약 최대 $${cur.itmCostMax.toFixed(0)})`
  );
} else {
  const { errs, floorRate, floorHits, chipCount, itmDepthMax, itmCostMax } = run();
  console.log(`행사가 사다리 검사 — 100종목 × 배수 ${DRIFTS.join('/')} × 콜/풋 × 만기 ${OPTION_EXPIRY_CHOICES.join('/')}`);
  console.log(`  칩 ${chipCount}개 · 프리미엄 하한 칩 ${floorHits} (${(floorRate * 100).toFixed(2)}%)`);
  console.log(`  가장 얕은 ITM 칩 최대 깊이 ${(itmDepthMax * 100).toFixed(1)}% · ITM 1계약 최대 $${itmCostMax.toFixed(0)} (시드 $${SEED_CASH.toLocaleString('en-US')})`);
  if (!errs.length) {
    console.log('  0건');
    process.exit(0);
  }
  const seen = new Map();
  for (const [m, at, v] of errs) {
    const key = m.slice(0, 1);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(`${m} · ${at} · ${v}`);
  }
  for (const [, list] of seen) {
    console.log(`  ${list[0]}`);
    if (list.length > 1) console.log(`      ... 외 ${list.length - 1}건`);
  }
  console.error(`\nFAILED: ${errs.length}건`);
  process.exit(1);
}
