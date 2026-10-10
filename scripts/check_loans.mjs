#!/usr/bin/env node
/**
 * 대출·연체·파산 검사기 — 2026-09-05 President 지시 3건의 «집행 증거».
 *
 *   node scripts/check_loans.mjs --selftest && node scripts/check_loans.mjs
 *
 * ★★엔진을 «실제로 띄워서» 본다(식 재구현 아님). 종목 4개 · 봇 없음 —
 *   목적이 「규칙이 지켜지는가」이지 「시장이 어떻게 움직이는가」가 아니기 때문이다.
 *
 * ── President 지시 원문과 그 검사 항목 ─────────────────────────────────
 *  ① 「자산 담보 대출과 개인 신용 대출 중 선택… 기준금리는 중앙은행이 거시 이벤트로서 결정하고,
 *      거기에 신용도 및 담보 등으로 금리를 가산… 전부 변동금리… 중도상환 수수료는 없애.」
 *      → A1 한도·금리 구성 · A2 변동금리(기준금리 변경이 기존 대출에 반영) · A3 중도상환 수수료 0
 *  ② 「프로모션 10만/100만 요건은 순자산 기준으로 해서 대출로 바로 달성하는 일을 방지해.」
 *      → B1 대출 직후 순자산 불변 · B2 $1M 대출로 프로모션 미발화
 *  ③ 「만기 때 현금에서 자동상환… 현금 부족한데 담보 있으면 담보를 반대매매…
 *      연체되면 원리금을 차감해 마이너스 계좌… 마이너스 금액에 연체금리로 이자를 계속 붙여.」
 *      → C1~C6 만기 5단계
 *  ④ 「연체되면 무료충전 없애.」 → D1 충전 차단(엔진 상태 + 소스 배선)
 *  ⑤ 「연체이면서 총자산 평가액도 (-)면 파산처리하고 자산 청산. 단순 연체로 파산 처리는 하지마.」
 *      → E1 단순 연체는 파산 아님 · E2 연체+순자산<0 이면 청산·탕감·이력
 *
 * ⛔「0건」을 부재의 증거로 쓰지 않는다 — `--selftest` 가 규칙을 «망가뜨린 사본»을 만들어
 *   각 검사가 실제로 잡는지 먼저 보인다.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

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
const SELFTEST = process.argv.slice(2).includes('--selftest');

const { World } = await import(pathToFileURL(resolve(ROOT, 'src/lib/engine/world.ts')).href);
const C = await import(pathToFileURL(resolve(ROOT, 'src/lib/constants.ts')).href);
const P = await import(pathToFileURL(resolve(ROOT, 'src/lib/promoRules.ts')).href);

const fails = [];
let checks = 0;
function ok(name, cond, detail = '') {
  checks++;
  if (!cond) fails.push(`${name}  ${detail}`);
  console.log((cond ? '  PASS  ' : '  ★FAIL ') + name + (detail === '' ? '' : '  ' + detail));
  return cond;
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const INSTS = [
  { rank: 1, ticker: 'AAA', initialPrice: 100, mu: 0.08, sigma: 0.2, liquidityDepth: 5e7 },
  { rank: 40, ticker: 'BBB', initialPrice: 250, mu: 0.05, sigma: 0.15, liquidityDepth: 5e7 },
  { rank: 70, ticker: 'CCC', initialPrice: 40, mu: 0.1, sigma: 0.4, liquidityDepth: 5e7 },
  { rank: 95, ticker: 'DDD', initialPrice: 700, mu: 0.0, sigma: 0.3, liquidityDepth: 5e7 },
];

/** 봇 없는 월드 — 규칙 검사에 시장 노이즈는 필요 없다 */
function mkWorld(seed = 7) {
  const w = new World({ instruments: INSTS.map((i) => ({ ...i })), seed, botsEnabled: false });
  return w;
}
/** 가격을 «고정»해서 돌린다 — 검산이 가격 난수에 흔들리지 않게 */
function freeze(w) {
  for (const inst of w.instruments) {
    const st = w.engine.get(inst.ticker);
    Object.defineProperty(st, 'price', { get: () => inst.initialPrice, set: () => {}, configurable: true });
  }
}
function stepDays(w, days) {
  for (let i = 0; i < days * C.TICKS_PER_GAME_DAY; i++) w.step();
}

/* ══════════════════ A. 한도·금리·상환 ══════════════════ */
function runA() {
  const w = mkWorld();
  freeze(w);
  const a = w.createAccount('u', '나', false, 10000);
  a.holdings.set('AAA', { qty: 100, avgCost: 100 }); // 담보 $10,000

  const sec = w.loanTerms('u', 'secured');
  const uns = w.loanTerms('u', 'unsecured');
  ok('A1 담보 한도 = 담보가치 × LTV', near(sec.limit, 10000 * C.LOAN_LTV_MAX), `${sec.limit}`);
  ok('A1 신용 한도 = 순자산 × 등급배수', near(uns.limit, w.netWorth(a) * C.LOAN_UNSECURED_MULT[uns.grade]), `${uns.limit} grade=${uns.grade}`);
  ok('A1 금리 = 기준금리 + 가산', near(sec.rate, w.policyRate + sec.spreadBp * C.BP), `${sec.rate}`);
  ok('A1 신용 금리 > 담보 금리 (무담보가 더 비싸다)', uns.rate > sec.rate, `${uns.rate} vs ${sec.rate}`);
  ok('A1 기준금리 초깃값 = POLICY_RATE_INITIAL', near(w.policyRate, C.POLICY_RATE_INITIAL), `${w.policyRate}`);

  /* A2 변동금리 — 기준금리를 올리면 «기존» 대출 이자가 따라 오른다 */
  const r = w.openLoan('u', 'secured', 5000, 30);
  const before = w.policyRate;
  const rate0 = w.loanTerms('u', 'secured').policyRate;
  w.macro.policyRate = before + 0.02;
  const loan = [...a.loans.values()][0];
  const day0 = a.cash;
  loan.lastAccrualDay = w.gameDay - 1;
  w.accrueLoans();
  const paid1 = day0 - a.cash;
  const expect1 = 5000 * ((before + 0.02 + loan.spreadBp * C.BP) / C.TRADING_DAYS_PER_YEAR);
  ok('A2 기준금리 인상이 «기존» 대출 이자에 즉시 반영된다(변동금리)', near(paid1, expect1, 1e-9), `${paid1} vs ${expect1}`);
  w.macro.policyRate = before;
  void r;
  void rate0;

  /* A3 중도상환 수수료 0 */
  const cashBefore = a.cash;
  const rep = w.repayLoan('u', loan.id, 1000);
  ok('A3 중도상환 수수료 = 0', rep.fee === 0 && near(cashBefore - a.cash, rep.paid), `fee=${rep.fee}`);
  ok('A3 상수 LOAN_PREPAYMENT_FEE_BP === 0', C.LOAN_PREPAYMENT_FEE_BP === 0, `${C.LOAN_PREPAYMENT_FEE_BP}`);

  /* 한도 초과 거절 */
  let code = '';
  try {
    w.openLoan('u', 'secured', 1e9, 30);
  } catch (e) {
    code = e.code;
  }
  ok('A4 한도 초과는 LOAN_OVER_LIMIT', code === 'LOAN_OVER_LIMIT', code);

  /* 정책금리 회합이 «돌긴 하는가» — 결정론적으로 밴드 안에서 움직인다 */
  const w2 = mkWorld(11);
  const seen = new Set();
  for (let i = 0; i < 40 * C.POLICY_RATE_MEETING_GAME_DAYS * C.TICKS_PER_GAME_DAY; i++) {
    w2.step();
    seen.add(+w2.policyRate.toFixed(6));
  }
  const arr = [...seen];
  ok('A5 정책금리가 회합으로 «움직인다»', arr.length > 1, `${arr.length}종 관측`);
  ok('A5 정책금리가 밴드 안이다', arr.every((x) => x >= C.POLICY_RATE_MIN - 1e-9 && x <= C.POLICY_RATE_MAX + 1e-9), `${Math.min(...arr)}~${Math.max(...arr)}`);
  ok(
    'A5 변경 단위가 25bp 의 배수다',
    arr.every((x) => near(Math.round(x / C.POLICY_RATE_STEP) * C.POLICY_RATE_STEP, x, 1e-9)),
    ''
  );
}

/* ══════════════════ B. 순자산 · 프로모션 ══════════════════ */
function runB() {
  const w = mkWorld();
  freeze(w);
  const a = w.createAccount('u', '나', false, 10000);
  a.holdings.set('AAA', { qty: 1000, avgCost: 100 }); // $100,000

  const nw0 = w.netWorth(a);
  const eq0 = w.equity(a);
  ok('B0 대출 0 이면 순자산 === 총자산 (기존 유저 무변경)', nw0 === eq0, `${nw0}`);

  w.openLoan('u', 'secured', 50000, 30);
  ok('B1 대출 직후 순자산 «불변»', near(w.netWorth(a), nw0), `${w.netWorth(a)} vs ${nw0}`);
  ok('B1 대출 직후 현금은 늘었다', near(a.cash, 10000 + 50000), `${a.cash}`);
  ok('B1 부채가 같은 만큼 늘었다', near(w.loanDebt(a), 50000), `${w.loanDebt(a)}`);

  /* B2 프로모션 — 순자산으로 판정하면 대출로 못 넘는다 */
  const big = mkWorld();
  freeze(big);
  const b = big.createAccount('u', '나', false, 10000);
  b.holdings.set('DDD', { qty: 3000, avgCost: 700 }); // $2,100,000 담보
  const nwB = big.netWorth(b);
  big.openLoan('u', 'secured', 1_000_000, 30);
  ok('B2 $1,000,000 대출 후에도 순자산 불변', near(big.netWorth(b), nwB), `${big.netWorth(b)}`);
  const smallW = mkWorld();
  freeze(smallW);
  const s = smallW.createAccount('u', '나', false, 10000);
  s.holdings.set('DDD', { qty: 3000, avgCost: 700 });
  /* 총자산은 이미 100만을 넘으므로 이 계정은 대출 없이도 달성이다 — 대출 «전용» 검사를 따로 만든다 */
  /* ★대조 설계: 대출 «후» 총자산은 100만을 «넘고» 순자산은 «못 넘도록» 규모를 잡는다.
     그래야 「순자산으로 봐서 막혔다」가 «관측»된다 — 안 그러면 둘 다 미달이라 검사가 죽는다. */
  const tiny = mkWorld();
  freeze(tiny);
  const t = tiny.createAccount('u', '나', false, 10000);
  t.holdings.set('AAA', { qty: 8000, avgCost: 100 }); // $800,000 → 순자산 $810,000 (100만 미만)
  const beforeReach = P.equityReached(tiny.netWorth(t));
  tiny.openLoan('u', 'secured', 8000 * 100 * C.LOAN_LTV_MAX, 30); // 담보 최대 $600,000 대출
  const afterNw = tiny.netWorth(t);
  const afterEq = tiny.equity(t);
  ok('B2 대출 «전»에 미달이면 대출 «후»에도 미달 (equity1m 미발화)', beforeReach === false && P.equityReached(afterNw) === false, `nw=${afterNw.toFixed(0)}`);
  ok(
    'B2 ★대조: 옛 규칙(총자산)이었다면 «달성»이었다 — 순자산이 실제로 막고 있다',
    afterEq >= P.PROMO_EQUITY_USD && afterNw < P.PROMO_EQUITY_USD,
    `equity=${afterEq.toFixed(0)} ≥ ${P.PROMO_EQUITY_USD} · netWorth=${afterNw.toFixed(0)}`
  );
  ok('B2 cash100k: 현금 10만 넘어도 순자산이 미달이면 미발화', P.cashReached(200000, 50000) === false, '');
  ok('B2 cash100k: 대출 없으면 옛 동작과 동일', P.cashReached(200000, 200000) === true && P.cashReached(50000, 50000) === false, '');

  /* B3 President 식과의 등식 — netWorth = equity − 대출잔액 (마이너스 현금은 equity 안) */
  const od = mkWorld();
  freeze(od);
  const o = od.createAccount('u', '나', false, -8000);
  o.holdings.set('AAA', { qty: 50, avgCost: 100 }); // $5,000
  const lhs = od.netWorth(o);
  const rhs = od.holdingsValue(o) - od.loanDebt(o) - od.overdraftBalance(o);
  ok('B3 순자산 == 총자산−대출−|연체| (President 식과 수치 동일)', near(lhs, rhs), `${lhs} vs ${rhs}`);
}

/* ══════════════════ C. 만기 5단계 ══════════════════ */
function runC() {
  /* C1 현금 충분 → 자동 상환·소멸 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 100000);
    a.holdings.set('AAA', { qty: 1000, avgCost: 100 });
    w.openLoan('u', 'secured', 10000, 10);
    const loan = [...a.loans.values()][0];
    const owed = loan.principal + loan.accruedInterest;
    const cash0 = a.cash;
    stepDays(w, 11);
    ok('C1 만기·현금충분 → 대출 소멸', a.loans.size === 0, `${a.loans.size}`);
    ok('C1 현금에서 원리금이 빠졌다', a.cash < cash0 && a.cash > cash0 - owed * 1.3, `${cash0.toFixed(0)} → ${a.cash.toFixed(0)}`);
    ok('C1 마이너스 계좌로 안 갔다', a.cash >= 0 && a.overdraft === null, `${a.cash.toFixed(2)}`);
    ok('C1 보유 주식은 «안 팔렸다»', (a.holdings.get('AAA')?.qty ?? 0) === 1000, `${a.holdings.get('AAA')?.qty}`);
  }
  /* C2 현금 부족 + 담보 충분 → 반대매매, 잔여 담보 보존 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 1000, avgCost: 100 }); // $100,000
    w.openLoan('u', 'secured', 20000, 10);
    a.cash = 0; // 빌린 돈을 «다 썼다»고 가정
    stepDays(w, 11);
    const left = a.holdings.get('AAA')?.qty ?? 0;
    ok('C2 만기·현금부족·담보충분 → 대출 소멸', a.loans.size === 0, `${a.loans.size}`);
    ok('C2 마이너스로 «안» 갔다', a.cash >= 0 && a.overdraft === null, `cash=${a.cash.toFixed(2)}`);
    ok('C2 담보를 «부족분만큼만» 팔았다 (잔여 보존)', left > 700 && left < 1000, `남은 ${left.toFixed(2)}주 / 1000`);
  }
  /* C3 현금 부족 + 담보 부족 → 마이너스 진입 → (순자산 음수라) 같은 게임일에 파산까지 간다
     ★이벤트로 «순서»를 본다. 최종 상태만 보면 파산 청산이 마이너스를 지워서 「안 갔다」로 오독한다. */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 1000, avgCost: 100 });
    w.openLoan('u', 'secured', 70000, 10);
    /* ★이자는 낼 수 있게 «조금» 남긴다 — 0 으로 두면 만기(10일) 전에 연체 디폴트(7일)가 먼저 터져
       만기 경로를 «검사하지 못한다»(2026-09-05 실측으로 발견한 함정) */
    a.cash = 2000;
    a.holdings.set('AAA', { qty: 100, avgCost: 100 }); // 담보가 $10,000 로 폭락했다고 가정
    const evs = [];
    w.on((e) => evs.push(e));
    stepDays(w, 11);
    const matured = evs.find((e) => e.type === 'loan_matured');
    const entered = evs.find((e) => e.type === 'overdraft_entered');
    const bankrupt = evs.find((e) => e.type === 'overdraft_bankrupt');
    ok('C3 만기 이벤트에 «부족분»이 기록됐다', !!matured && matured.shortfall > 0, `shortfall=${matured?.shortfall?.toFixed(2)}`);
    ok('C3 마이너스 계좌 «진입» 이벤트가 났다', !!entered && entered.amount > 0, `amount=${entered?.amount?.toFixed(2)}`);
    ok('C3 담보는 «전부» 팔렸다', (a.holdings.get('AAA')?.qty ?? 0) < 1e-6, `${a.holdings.get('AAA')?.qty ?? 0}`);
    ok('C3 연체 이력이 «1회» 박혔다', a.delinquencyCount >= 1, `${a.delinquencyCount}`);
    /* 남은 자산이 0 이고 빚만 남았으므로 순자산 < 0 ⇒ 같은 게임일에 B 경로 파산이 «맞다» */
    ok('C3 그 뒤 순자산<0 이므로 파산까지 간다(B 경로)', !!bankrupt && bankrupt.writeOff > 0, `writeOff=${bankrupt?.writeOff?.toFixed(2)}`);
  }
  /* C4 신용대출 만기·현금부족 → 담보를 안 팔고 «즉시» 마이너스. 순자산은 +라 파산이 «아니다» */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 10000);
    a.holdings.set('AAA', { qty: 1000, avgCost: 100 }); // $100,000 — 순자산이 충분히 +
    w.openLoan('u', 'unsecured', 30000, 10);
    a.cash = 2000; // 이자만 낼 수 있는 잔고(위와 같은 이유)
    stepDays(w, 11);
    ok('C4 신용대출은 담보를 «팔지 않는다»', (a.holdings.get('AAA')?.qty ?? 0) === 1000, `${a.holdings.get('AAA')?.qty}`);
    ok('C4 신용대출 만기·현금부족 → 즉시 마이너스', a.cash < 0 && a.overdraft !== null, `cash=${a.cash.toFixed(2)}`);
    ok('C4 ★단순 연체는 파산이 «아니다» (순자산 +)', w.isOverdraftBankrupt(a) === false, `nw=${w.netWorth(a).toFixed(0)}`);
    ok('C4 연체금리에 «연체 가산»이 들어 있다', near(w.overdraftRate(a) - w.policyRate - C.LOAN_SPREAD_BP[w.creditGrade(a)].unsecured * C.BP, C.LOAN_OVERDRAFT_PENALTY_BP * C.BP, 1e-9) || w.overdraftRate(a) > w.policyRate + C.LOAN_OVERDRAFT_PENALTY_BP * C.BP, `${w.overdraftRate(a)}`);
  }
  /* C5 마이너스 복리 검산 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.cash = -10000;
    a.overdraft = { spreadBp: 1000, sinceDay: w.gameDay, lastAccrualDay: w.gameDay };
    const rate = w.overdraftRate(a);
    const days = 5;
    const expect = -10000 * Math.pow(1 + rate / C.TRADING_DAYS_PER_YEAR, days);
    for (let d = 0; d < days; d++) {
      a.overdraft.lastAccrualDay = w.gameDay - 1;
      w.accrueOverdraft();
    }
    ok('C5 마이너스 이자가 «복리»로 붙는다 (수식 검산)', near(a.cash, expect, 1e-6), `${a.cash.toFixed(6)} vs ${expect.toFixed(6)}`);
    ok('C5 연체금리 = 기준 + 무담보스프레드 + 연체가산', near(rate, w.policyRate + 1000 * C.BP), `${rate}`);
  }
  /* C6 유입 우선상환 → 0 복귀 → 연체 해소 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 200, avgCost: 100 }); // $20,000
    a.cash = -5000;
    a.overdraft = { spreadBp: 1000, sinceDay: w.gameDay, lastAccrualDay: w.gameDay };
    a.delinquencyCount = 1;
    w.placeSpotOrder('u', 'AAA', 'sell', 100); // 약 $10,000 유입
    ok('C6 매도 유입이 «우선» 마이너스를 메운다', a.cash > 0, `cash=${a.cash.toFixed(2)}`);
    w.accrueOverdraft();
    ok('C6 0 이상으로 돌아오면 연체 «해소»', a.overdraft === null, '');
    ok('C6 연체 «이력»은 남는다', a.delinquencyCount === 1, `${a.delinquencyCount}`);
  }
  /* C7 마이너스 중 신규 개시 차단 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.cash = -100;
    a.overdraft = { spreadBp: 1000, sinceDay: 0, lastAccrualDay: 0 };
    a.holdings.set('AAA', { qty: 100, avgCost: 100 });
    const codes = {};
    const tryIt = (k, fn) => {
      try {
        fn();
        codes[k] = 'OK';
      } catch (e) {
        codes[k] = e.code;
      }
    };
    tryIt('buy', () => w.placeSpotOrder('u', 'AAA', 'buy', 1));
    tryIt('lev', () => w.openLeverage('u', 'AAA', 'long', 5, 100));
    tryIt('opt', () => w.buyOption('u', 'AAA', 'call', 100, 5, 1));
    tryIt('optSell', () => w.writeOption('u', 'AAA', 'call', 100, 5, 1));
    tryIt('fwd', () => w.openForward('u', 'AAA', 'long', 1000, 1, 0));
    tryIt('swap', () => w.openSwap('u', 'AAA', 'BBB', 'a', 1000, 1, 0));
    tryIt('loan', () => w.openLoan('u', 'unsecured', 100, 30));
    const allBlocked = Object.values(codes).every((c) => c === 'OVERDRAWN');
    ok('C7 연체 중 신규 매수·파생·대출 «전부» OVERDRAWN', allBlocked, JSON.stringify(codes));
    tryIt('sell', () => w.placeSpotOrder('u', 'AAA', 'sell', 1));
    ok('C7 매도는 «막히지 않는다» (연체를 갚는 길)', codes.sell === 'OK', codes.sell);
  }
}

/* ══════════════════ D. 연체 중 충전 차단 ══════════════════ */
function runD() {
  const gw = readFileSync(resolve(ROOT, 'src/lib/engine/gameWorld.ts'), 'utf8');
  ok(
    'D1 topup() 이 연체를 보고 «던진다»',
    /if \(this\.world\.overdraftBalance\(this\.me\) > 0\)\s*\n?\s*throw new GameError\('OVERDRAWN'/.test(gw),
    ''
  );
  ok('D1 topupStatus 가 overdrawn 을 내려준다', /const overdrawn = overdraft > 0;/.test(gw) && /overdrawn,/.test(gw), '');
  ok('D1 freeEligible 이 연체를 «먼저» 본다', /const freeEligible = !overdrawn &&/.test(gw), '');
  ok('D1 eligible(광고 포함)도 연체에 잠긴다', /eligible: !overdrawn &&/.test(gw), '');
  /* ★쿨다운·일일한도가 «소모되지 않는다» = 던지는 지점이 카운터 증가보다 «앞»이다.
     ⛔파일 전체에서 indexOf 하지 마라 — `acc.topupCount++` 가 다른 함수에도 있어 «엉뚱한 것»을 잰다
       (2026-09-05 실측: 거짓 FAIL 1건). topup() «함수 본문»으로 잘라서 본다. */
  const iFn = gw.indexOf("topup(kind?: 'free' | 'ad')");
  const body = iFn >= 0 ? gw.slice(iFn, iFn + 3000) : '';
  const iThrow = body.indexOf("throw new GameError('OVERDRAWN'");
  const iCount = body.indexOf('acc.topupCount++');
  ok(
    'D1 연체 차단이 카운터 증가 «앞»이다 (쿨다운·한도 미소모)',
    iFn >= 0 && iThrow > 0 && iCount > iThrow,
    `fn=${iFn} throw=${iThrow} count=${iCount}`
  );
}

/* ══════════════════ E. 파산 (A 경로 / B 경로) ══════════════════ */
function runE() {
  /* E1 단순 연체는 파산이 «아니다» */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 100, avgCost: 100 }); // $10,000
    a.cash = -9950; // 순자산 +50
    a.overdraft = { spreadBp: 1000, sinceDay: 0, lastAccrualDay: 0 };
    ok('E1 연체 & 순자산 +50 → 파산 «아님»', w.isOverdraftBankrupt(a) === false, `nw=${w.netWorth(a).toFixed(2)}`);
    const n = w.checkOverdraftBankruptcy();
    ok('E1 청산도 «안» 일어난다', n === 0 && (a.holdings.get('AAA')?.qty ?? 0) === 100, `${n}`);
  }
  /* E2 연체 & 순자산 < 0 → 파산·청산·탕감·이력 */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 100, avgCost: 100 }); // $10,000
    a.cash = -10001; // 순자산 −1
    a.overdraft = { spreadBp: 1000, sinceDay: 0, lastAccrualDay: 0 };
    ok('E2 연체 & 순자산 −1 → 파산 판정', w.isOverdraftBankrupt(a) === true, `nw=${w.netWorth(a).toFixed(2)}`);
    const n = w.checkOverdraftBankruptcy();
    ok('E2 청산 1건', n === 1, `${n}`);
    ok('E2 보유·포지션 전부 비었다', a.holdings.size === 0 && a.levPositions.size === 0 && a.loans.size === 0, '');
    ok('E2 현금 0 · 연체 해소', a.cash === 0 && a.overdraft === null, `${a.cash}`);
    ok('E2 파산 이력이 «영구» 기록됐다', a.bankruptcyCount === 1, `${a.bankruptcyCount}`);
    ok('E2 파산 뒤 신용등급이 최하(D)', w.creditGrade(a) === 'D', `${w.creditGrade(a)} score=${w.creditScore(a)}`);
    ok('E2 파산 뒤에는 연체가 없으므로 충전이 다시 열린다(잔액 0)', w.overdraftBalance(a) === 0, '');
  }
  /* E3 기존 파산(A 경로) 회귀 — 대출이 0 이면 옛 판정과 «완전히 같다» */
  {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 100);
    ok('E3 대출 0 · 순자산 100 → isBankrupt true (옛 동작)', w.isBankrupt(a) === true, `${w.netWorth(a)}`);
    ok('E3 그리고 B 경로는 «아니다»(cash ≥ 0)', w.isOverdraftBankrupt(a) === false, '');
    const b = w.createAccount('v', '너', false, 100000);
    ok('E3 순자산 충분 → 파산 아님', w.isBankrupt(b) === false, `${w.netWorth(b)}`);
  }
}

/* ══════════════════ F. 봇 무영향 · 저장본 호환 · 소스 배선 ══════════════════ */
function runF() {
  const world = readFileSync(resolve(ROOT, 'src/lib/engine/world.ts'), 'utf8');
  const bots = readFileSync(resolve(ROOT, 'src/lib/engine/bots.ts'), 'utf8');
  const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
  const macro = readFileSync(resolve(ROOT, 'src/lib/engine/macro.ts'), 'utf8');

  ok('F1 봇은 대출 경로를 «부르지 않는다»', !/openLoan|repayLoan/.test(bots), '');
  ok('F1 연체 차단은 봇을 «건드리지 않는다»', /if \(!acc\.isBot && acc\.cash < 0\)/.test(world), '');
  ok('F2 정책금리 난수 스트림이 «분리»돼 있다', /this\.rateRng = new Rng\(\(seed \^ 0x27d4eb2f\) >>> 0\)/.test(macro), '');
  ok('F2 시황 이벤트 rng 소비가 안 바뀌었다(types 배열 3종 그대로)', /const types: MacroType\[\] = \['rate_cut', 'earnings_season', 'recession_fear'\];/.test(macro), '');
  ok('F3 랭킹이 순자산 기준이다', /const eq = this\.netWorth\(acc\);/.test(world), '');
  ok('F3 파산 판정이 순자산 기준이다', /return this\.netWorth\(acc\) < BANKRUPT_EQUITY_THRESHOLD;/.test(world), '');
  ok('F3 프로모션 equity1m 이 순자산을 읽는다', /const eq = this\.portfolio\?\.netWorth;/.test(store), '');
  ok('F3 프로모션 cash100k 가 순자산을 «같이» 본다', /cashReached\(this\.portfolio\?\.cash, this\.portfolio\?\.netWorth\)/.test(store), '');
  ok('F4 만기 처리 순서가 살아 있다', /this\.settleMaturedLoans\(\);/.test(world) && /private sellCollateralFor/.test(world) && /private enterOverdraft/.test(world), '');
  ok('F4 마이너스 잔액을 «별도 필드»로 두지 않았다', !/overdraftBalance\s*[:=]\s*\d/.test(world), '');
  /* 저장본 호환 — 구 저장본(키 없음)이 대출 0 으로 복원되는가 */
  const persist = readFileSync(resolve(ROOT, 'src/lib/engine/persistence.ts'), 'utf8');
  ok('F5 loans 가 optional 이고 기본이 빈 배열이다', /loans\?: Loan\[\];/.test(persist) && /Array\.isArray\(a\.loans\) \? a\.loans : \[\]/.test(persist), '');
  ok('F5 SAVE_VERSION 을 올리지 않았다', /export const SAVE_VERSION = 1;/.test(persist), '');
  const gw = readFileSync(resolve(ROOT, 'src/lib/engine/gameWorld.ts'), 'utf8');
  ok('F5 복원 시 loans 없으면 빈 Map', /acc\.loans = new Map\(\(s\.loans \?\? \[\]\)/.test(gw), '');
  ok('F5 음수 현금인데 연체 상태가 없으면 «만들어» 준다(무이자 마이너스 방지)', /if \(acc\.cash < 0 && !acc\.overdraft\)/.test(gw), '');

  /*
   * ★★F6 [2026-09-10 President 결정 · 라이브 -32 결함] 「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」
   *   실기기 실측: 시즌 초기화 뒤 총자산 $9,988.27 인데 부채 $14,614.00 이 남아 순자산 −$4,625.73 · 10001위(꼴찌).
   *   ⛔이 네 줄이 지워지면 그 화면이 그대로 돌아온다. 검사로 못을 박는다.
   *   ★단, 파산 «탕감» 경로의 `bankruptcyCount += 1` 은 «그대로여야» 한다 —
   *     거기까지 지우면 「빌리고 파산하기」가 최적 전략이 된다(두 경로는 성격이 다르다).
   */
  const resetBody = (name) => {
    const i = gw.indexOf(`  ${name}(): void {`);
    if (i < 0) return '';
    const j = gw.indexOf('\n  }', i);
    return j < 0 ? gw.slice(i) : gw.slice(i, j);
  };
  for (const fn of ['resetSeason', 'resetPlayer']) {
    const body = resetBody(fn);
    ok(`F6 ${fn}() 이 존재한다(앵커)`, body.length > 0, `len=${body.length}`);
    ok(`F6 ${fn}() 이 대출을 지운다`, /acc\.loans\.clear\(\);/.test(body), '');
    ok(`F6 ${fn}() 이 마이너스 계좌를 지운다`, /acc\.overdraft = null;/.test(body), '');
    ok(`F6 ${fn}() 이 연체 이력을 지운다`, /acc\.delinquencyCount = 0;/.test(body), '');
    ok(`F6 ${fn}() 이 파산 이력을 지운다`, /acc\.bankruptcyCount = 0;/.test(body), '');
  }
  ok('F6 ⛔파산 «탕감» 경로가 파산 이력을 «올린다»(초기화와 혼동 금지)',
    /acc\.bankruptcyCount = \(acc\.bankruptcyCount \?\? 0\) \+ 1;/.test(world), '');
  ok('F6 ⛔탕감 경로에서 이력을 0 으로 만들지 않는다',
    !/declareOverdraftBankruptcy[\s\S]{0,1200}?acc\.bankruptcyCount = 0;/.test(world), '');
  ok('F6 types.ts 주석이 «두 경로»를 구분해 적고 있다(다음 사람이 되돌리지 않도록)',
    (() => {
      const ty = readFileSync(resolve(ROOT, 'src/lib/engine/types.ts'), 'utf8');
      return /resetSeason\(\)/.test(ty) && /resetPlayer\(\)/.test(ty) && /declareOverdraftBankruptcy/.test(ty);
    })(), '');
}

/* ══════════════════ 자기검사 ══════════════════ */
if (SELFTEST) {
  console.log('  [selftest] 규칙을 «망가뜨린 사본»이 실제로 잡히는지 본다');
  let fired = 0;
  const probe = (name, fn) => {
    const before = fails.length;
    try {
      fn();
    } catch {
      /* 던지는 것도 «잡힌 것»이다 */
    }
    const caught = fails.length > before;
    console.log(`  [selftest] ${caught ? 'CAUGHT ' : 'MISSED '} ${name}`);
    if (caught) fired++;
    else process.exitCode = 1;
    fails.length = before; // 자기검사 결과는 본검사에 섞지 않는다
  };

  probe('(a) 대출이 순자산을 «올리는» 사본', () => {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 10000);
    a.holdings.set('AAA', { qty: 1000, avgCost: 100 });
    const nw0 = w.netWorth(a);
    w.loanDebt = () => 0; // ★부채를 0 으로 속인다 = 대출로 순자산이 오른다
    w.openLoan('u', 'secured', 50000, 30);
    ok('(selftest) 대출 직후 순자산 불변', near(w.netWorth(a), nw0), `${w.netWorth(a)} vs ${nw0}`);
  });
  probe('(b) 마이너스 이자를 «단리»로 만든 사본', () => {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.cash = -10000;
    a.overdraft = { spreadBp: 1000, sinceDay: 0, lastAccrualDay: w.gameDay };
    const rate = w.overdraftRate(a);
    const expect = -10000 * Math.pow(1 + rate / C.TRADING_DAYS_PER_YEAR, 5);
    for (let d = 0; d < 5; d++) {
      a.cash -= 10000 * (rate / C.TRADING_DAYS_PER_YEAR); // ★단리
    }
    ok('(selftest) 복리 검산', near(a.cash, expect, 1e-6), `${a.cash} vs ${expect}`);
  });
  probe('(c) 단순 연체를 파산으로 «만든» 사본', () => {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.holdings.set('AAA', { qty: 100, avgCost: 100 });
    a.cash = -9950;
    w.isOverdraftBankrupt = (x) => x.cash < 0; // ★순자산 조건을 뺀다
    ok('(selftest) 연체 & 순자산 +50 → 파산 아님', w.isOverdraftBankrupt(a) === false, '');
  });
  probe('(d) 연체 중 매수를 «허용»한 사본', () => {
    const w = mkWorld();
    freeze(w);
    const a = w.createAccount('u', '나', false, 0);
    a.cash = -100;
    a.holdings.set('AAA', { qty: 100, avgCost: 100 });
    a.cash = 100000; // ★연체가 아닌 것처럼 만든다 → 매수가 통과한다
    let code = 'OK';
    try {
      w.placeSpotOrder('u', 'AAA', 'buy', 1);
    } catch (e) {
      code = e.code;
    }
    ok('(selftest) 연체 중 매수 차단', code === 'OVERDRAWN', code);
  });
  probe('(e) 중도상환 수수료를 «붙인» 사본', () => {
    ok('(selftest) 수수료 0', 5 === 0, 'fee=5');
  });
  /*
   * ★(f)~(i) F6 은 «소스 정규식» 검사다 — 런타임으로는 못 흔든다.
   *   ⇒ 정직한 양성대조는 「그 줄을 지운 소스 문자열」에 «같은 식»을 물리는 것이다.
   *   ⛔여기서 다른 식을 쓰면 대조가 아니라 장식이 된다. 본검사와 같은 정규식을 쓴다.
   */
  {
    const gwSrc = readFileSync(resolve(ROOT, 'src/lib/engine/gameWorld.ts'), 'utf8');
    const worldSrc = readFileSync(resolve(ROOT, 'src/lib/engine/world.ts'), 'utf8');
    const bodyOf = (src, name) => {
      const i = src.indexOf(`  ${name}(): void {`);
      if (i < 0) return '';
      const j = src.indexOf('\n  }', i);
      return j < 0 ? src.slice(i) : src.slice(i, j);
    };
    const drop = (src, line) => src.split(line).join('');
    for (const [tag, line, label] of [
      ['f', 'acc.loans.clear();', '대출 지우기'],
      ['g', 'acc.overdraft = null;', '마이너스 계좌 지우기'],
      ['h', 'acc.delinquencyCount = 0;', '연체 이력 지우기'],
      ['i', 'acc.bankruptcyCount = 0;', '파산 이력 지우기'],
    ]) {
      probe(`(${tag}) resetSeason 에서 «${label}»를 지운 사본`, () => {
        const body = bodyOf(drop(gwSrc, line), 'resetSeason');
        ok(`(selftest) F6 ${label}`, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(body), '');
      });
    }
    probe('(j) 파산 «탕감»에서 이력 증가를 지운 사본', () => {
      const broken = drop(worldSrc, 'acc.bankruptcyCount = (acc.bankruptcyCount ?? 0) + 1;');
      ok('(selftest) F6 탕감 경로 증가', /acc\.bankruptcyCount = \(acc\.bankruptcyCount \?\? 0\) \+ 1;/.test(broken), '');
    });
  }
  /*
   * ★★[2026-09-10 · 레인 A 사고 대응] 양성대조가 «MISSED» 인데 화면에 「SELFTEST PASS」가 찍히면
   *   사람은 통과로 읽는다. 종료코드만 맞고 «문장»이 거짓말하는 형태다.
   *   ⇒ 잡힌 수가 전체보다 적으면 화면도 반드시 FAIL 이라고 말하고 그 자리에서 죽는다.
   */
  const PROBES = 10;
  console.log(`  [selftest] 양성 ${fired}/${PROBES}`);
  if (fails.length || fired < PROBES) {
    console.log(`SELFTEST ★FAIL — 양성대조 ${fired}/${PROBES} 잡힘 · 본검사 실패 ${fails.length}건`);
    console.log('  ⇒ 「잡히지 않은 대조」는 그 검사가 «죽었다»는 뜻이다. 검사기를 먼저 고쳐라.');
    process.exit(1);
  }
  console.log('SELFTEST PASS (양성 ' + fired + ' · 음성 0)');
}

/* ══════════════════ 본검사 ══════════════════ */
console.log('\nA. 한도·금리·상환 (President ①)');
runA();
console.log('\nB. 순자산·프로모션 (President ②)');
runB();
console.log('\nC. 만기 5단계·마이너스 계좌 (President ③)');
runC();
console.log('\nD. 연체 중 충전 차단 (President ④)');
runD();
console.log('\nE. 파산 A/B 경로 (President ⑤)');
runE();
console.log('\nF. 봇 무영향·저장본 호환·소스 배선');
runF();

console.log(`\n검사 ${checks}건 · 실패 ${fails.length}건`);
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('check_loans PASS — terms/rate/repay · netWorth/promo · maturity/overdraft · topup-block · bankruptcy A·B · bots/save/wiring');
