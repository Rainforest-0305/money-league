#!/usr/bin/env node
/**
 * ★포트폴리오 «복사 계획»을 숫자로 검사한다 — 실제 `src/lib/copyPortfolio.ts` 를 «불러서».
 *
 *   node scripts/check_copy_plan.mjs
 *   node scripts/check_copy_plan.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ★무엇을 잡나 (President 지시 2026-08-30 「현재 보유 현금 규모에 맞게 비중을 조정해서 복사」)
 *   ① 비중 합 = 1 (주식 평가액 + 레버리지 증거금이 분모)
 *   ② Σ예상 투입 ≤ 가용 현금 · 남는 현금 = 현금 − 투입
 *   ③ 수량은 정수(floor) · 1주도 못 사는 줄은 skip=tooSmall · 배정액 0 이면 아무것도 안 산다
 *   ④ 레버리지: 배율·방향이 대상과 같다 · 증거금 정수 · 최소 증거금 미만은 skip · 없는 배율은 skip
 *   ⑤ ★[2026-09-05 President 결정 「괜찮아. 캡 풀어.」] 단일 주문 상한이 «없다» —
 *      배정액이 아무리 커도 «비중대로» 산다. 계획은 깊이를 «묻지도 않는다».
 *      ⛔이 검사는 「없음」을 지키는 검사다: q 에서 maxOrderNotional 을 «뺐으므로»,
 *        모듈이 다시 그걸 부르면 TypeError 로 «즉시» 터진다(양성대조가 내장돼 있다).
 *   ⑥ 빈 포트폴리오면 empty · 현금 0 이면 전부 skip
 * ⛔규칙을 여기 «다시 쓰지» 않는다 — 모듈을 import 해 «출력»만 본다. 같은 입력이면 같은 출력이어야 한다.
 *
 * ⚠️못 보는 것: 실제 주문(엔진)·저장·화면. 그건 scripts/verify_copy_ui.py 몫이다.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

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
const SELFTEST = process.argv.slice(2).includes('--selftest');
const M = await import(pathToFileURL(resolve(ROOT, 'src/lib/copyPortfolio.ts')).href);
const C = await import(pathToFileURL(resolve(ROOT, 'src/lib/constants.ts')).href);

const PRICES = { AAA: 100, BBB: 250, CCC: 10, DDD: 1000, EEE: 3.5, ZZZ: 5000 };
/* ⛔[2026-09-05] `maxOrderNotional` 을 «일부러» 넣지 않는다 — 계획이 그걸 다시 부르면
   TypeError 로 즉시 터진다. 「상한을 다시 걸었다」는 회귀를 잡는 «내장 양성대조»다. */
const q = {
  priceOf: (t) => PRICES[t] ?? 0,
  priceImpactFrac: (t, n) => (n >= 0 ? 0.001 : -0.001),
};
const pub = {
  holdings: [
    { ticker: 'AAA', qty: 100, avgCost: 90 }, // 10,000
    { ticker: 'BBB', qty: 40, avgCost: 200 }, //  10,000
    { ticker: 'CCC', qty: 500, avgCost: 9 },  //   5,000
    { ticker: 'DDD', qty: 5, avgCost: 900 },  //   5,000
    { ticker: 'EEE', qty: 100, avgCost: 3 },  //     350
  ],
  leverage: [
    { ticker: 'AAA', side: 'long', leverage: 5, margin: 10_000 },
    { ticker: 'BBB', side: 'short', leverage: 2, margin: 5_000 },
    { ticker: 'CCC', side: 'long', leverage: 3, margin: 5_000 }, // 3배 = 없는 배율
  ],
};
// 분모 = 30,350 + 20,000 = 50,350

const fails = [];
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : '★FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(name);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function sumW(plan) {
  return plan.spot.reduce((a, l) => a + l.weight, 0) + plan.lev.reduce((a, l) => a + l.weight, 0);
}

if (SELFTEST) {
  console.log('[selftest] 양성대조 — 검사기가 «잡는지»');
  const plan = M.planCopy(pub, 100_000, q);
  // (a) 비중을 일부러 깨뜨린 사본 → ① 이 잡아야 한다
  const broken = { ...plan, spot: plan.spot.map((l, i) => (i === 0 ? { ...l, weight: l.weight + 0.1 } : l)) };
  ok('(a) 비중 합 변조 → 잡힘', !near(sumW(broken), 1, 1e-6));
  // (b) 투입이 현금을 넘는 사본 → ② 가 잡아야 한다
  const over = { ...plan, spend: plan.cash + 1 };
  ok('(b) 투입 > 현금 변조 → 잡힘', !(over.spend <= over.cash));
  // (c) 소수 수량 사본 → ③ 이 잡아야 한다
  const frac = plan.spot.map((l) => ({ ...l, qty: l.qty + 0.5 }));
  ok('(c) 소수 수량 변조 → 잡힘', frac.some((l) => !Number.isInteger(l.qty)));
  // (d) 음성대조 — 정상 계획은 통과
  ok('(d) 음성대조: 정상 계획 비중 합 1', near(sumW(plan), 1, 1e-9));
  ok('(d) 음성대조: 정상 계획 투입 ≤ 현금', plan.spend <= plan.cash);
  console.log(fails.length ? 'SELFTEST FAIL' : 'SELFTEST PASS (양성 3 FIRED · 음성 0)');
  process.exit(fails.length ? 1 : 0);
}

console.log('check_copy_plan — planCopy() 실측');
{
  const cash = 100_000;
  const plan = M.planCopy(pub, cash, q);
  ok('① 비중 합 = 1', near(sumW(plan), 1, 1e-9), sumW(plan).toFixed(9));
  ok('① AAA 주식 비중 = 10,000/50,350', near(plan.spot[0].weight, 10_000 / 50_350, 1e-9));
  ok('① AAA 롱 5배 비중 = 10,000/50,350', near(plan.lev[0].weight, 10_000 / 50_350, 1e-9));
  ok('② Σ투입 ≤ 현금', plan.spend <= cash, `${plan.spend.toFixed(2)} ≤ ${cash}`);
  ok('② 남는 현금 = 현금 − 투입', near(plan.leftover, cash - plan.spend, 1e-6));
  ok('③ 수량 전부 정수', plan.spot.every((l) => Number.isInteger(l.qty)));
  const aaa = plan.spot[0];
  const unit = 100 * (1 + 0.001) * (1 + C.FEE_SPOT_BP * C.BP);
  ok('③ AAA 수량 = floor(배정액 / (가격×임팩트×수수료))', aaa.qty === Math.floor((cash * aaa.weight) / unit), `${aaa.qty}`);
  ok('③ 줄마다 투입 ≤ 배정액', plan.spot.every((l) => l.cost <= l.alloc + 1e-6) && plan.lev.every((l) => l.cost <= l.alloc + 1e-6));
  ok('④ 레버리지 배율·방향 = 대상', plan.lev[0].side === 'long' && plan.lev[0].leverage === 5 && plan.lev[1].side === 'short' && plan.lev[1].leverage === 2);
  ok('④ 증거금 정수', plan.lev.every((l) => Number.isInteger(l.margin)));
  ok('④ 증거금 + 수수료 ≤ 배정액', plan.lev.filter((l) => !l.skip).every((l) => l.margin * (1 + C.FEE_LEVERAGE_BP * C.BP * l.leverage) <= l.alloc + 1e-6));
  ok('④ 없는 배율(3배) → skip=badLeverage', plan.lev[2].skip === 'badLeverage' && plan.lev[2].margin === 0);
  ok('⑥ empty=false', plan.empty === false);
}
{
  // 작은 현금 — 비싼 종목은 1주도 못 산다 · 증거금 최소 미만은 skip
  const plan = M.planCopy(pub, 1_000, q);
  const ddd = plan.spot.find((l) => l.ticker === 'DDD');
  ok('③ 현금 $1,000: DDD($1,000·비중 9.9%) 배정 $99 → skip=tooSmall', ddd.skip === 'tooSmall' && ddd.qty === 0);
  const bbbLev = plan.lev.find((l) => l.ticker === 'BBB');
  ok('④ 현금 $1,000: BBB 숏 증거금 배정 $99 → skip=tooSmall(최소 $' + M.LEV_MIN_MARGIN + ')', bbbLev.skip === 'tooSmall' && bbbLev.margin === 0);
  const aaaLev = plan.lev.find((l) => l.ticker === 'AAA');
  ok('④ 현금 $1,000: AAA 롱 증거금 배정 $198 → 산다(198 ≥ 100)', !aaaLev.skip && aaaLev.margin >= M.LEV_MIN_MARGIN, `${aaaLev.margin}`);
  ok('② 남는 현금 ≥ 0 · Σ투입 ≤ 현금', plan.leftover >= 0 && plan.spend <= 1_000);
}
{
  /* ★[2026-09-05] 상한이 «없다»는 것을 지킨다. ZZZ 는 $5,000 짜리 종목이고
     예산 $200,000 을 주식/레버리지가 반씩 나눠 가지므로 각 줄 배정은 $100,000 이다.
     옛 규칙이었다면 $20,000 에서 잘렸다. 지금은 «안 잘린다». */
  const p2 = { holdings: [{ ticker: 'ZZZ', qty: 10, avgCost: 1 }], leverage: [{ ticker: 'ZZZ', side: 'long', leverage: 10, margin: 50_000 }] };
  const plan = M.planCopy(p2, 200_000, q);
  const z = plan.spot[0];
  ok('⑤ 주식: 상한 클립 «없음» — 배정 전액을 쓴다(옛 상한 $20,000 를 넘는다)',
     z.capped === undefined && z.cost > 20_000 && z.cost <= z.alloc + 1e-6, `cost=${z.cost.toFixed(0)} alloc=${z.alloc.toFixed(0)}`);
  const zl = plan.lev[0];
  ok('⑤ 레버리지: 상한 클립 «없음» — 명목이 옛 상한을 넘는다',
     zl.capped === undefined && zl.margin * zl.leverage > 20_000, `${zl.margin}×${zl.leverage}`);
  ok('⑤ capped 필드가 «사라졌다» (죽은 UI 분기가 남지 않게)',
     !('capped' in z) && !('capped' in zl), `${Object.keys(z).join(',')}`);
}
{
  const plan = M.planCopy(pub, 0, q);
  ok('⑥ 현금 0 → 전부 skip · 투입 0', plan.spot.every((l) => l.skip) && plan.lev.every((l) => l.skip) && plan.spend === 0);
  const e = M.planCopy({ holdings: [], leverage: [] }, 100_000, q);
  ok('⑥ 빈 포트폴리오 → empty', e.empty === true && e.spend === 0);
  const n = M.planCopy(pub, Number.NaN, q);
  ok('⑥ NaN 현금 → 예산 0 (NaN 이 잔고로 새지 않는다)', n.cash === 0 && Number.isFinite(n.spend));
}
{
  // 청산 예상 — 부호와 방향만 본다(임팩트·수수료 «차감»이어야 한다)
  const est = M.estimateLiquidation(
    { holdings: [{ ticker: 'AAA', qty: 100 }], leverage: [{ notional: 50_000, equity: 12_000 }], options: [], forwards: [], swaps: [] },
    q
  );
  ok('청산 예상: 주식 < 시가 평가액(임팩트·수수료 차감)', est.spot < 10_000 && est.spot > 9_900, est.spot.toFixed(2));
  ok('청산 예상: 레버리지 = 평가액 − 수수료', near(est.deriv, 12_000 - 50_000 * C.FEE_LEVERAGE_BP * C.BP, 1e-6));
  ok('청산 예상: 항목 수 2', est.count === 2);
}
console.log(fails.length ? `\ncheck_copy_plan FAIL (${fails.length})` : '\ncheck_copy_plan PASS');
process.exit(fails.length ? 1 : 0);
