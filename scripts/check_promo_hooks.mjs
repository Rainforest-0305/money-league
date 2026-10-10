#!/usr/bin/env node
/**
 * ★프로모션 훅 3종 «단위검사» — 실제 `src/lib/promoRules.ts` · `src/toss/promoCore.ts` 를 «불러서».
 *
 *   node scripts/check_promo_hooks.mjs             본검사 + 소스 정적검사
 *   node scripts/check_promo_hooks.mjs --selftest  ★양성/음성 대조 먼저(검사기가 «잡는지»)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★왜 필요한가 (2026-08-29)
 *   08-26 머니 리그에서 토스포인트 알림이 «2회» 뜬 중복 의심 건이 있다. 방어 3중(로컬 grantedAt ·
 *   in-flight 락 · 토스 4113)은 «코드로만 확인»됐고 실행으로 센 적이 없었다.
 *   ⇒ 이 검사기는 «가짜 저장·가짜 브릿지»를 꽂아 «실제 promoCore» 를 돌리고 브릿지 호출 «횟수»를 센다.
 *
 * ⛔규칙을 이 파일에 «다시 구현하지» 않는다 — 실제 모듈을 import 한다(check_attendance.mjs 와 같은 규율).
 *   `promoRules.ts`(import: daykey 뿐) · `promoCore.ts`(런타임 import 0 — bridge 는 type-only) 는
 *   JSX 가 없어 Node 타입 스트리핑으로 «그대로» 읽힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★이 검사기가 «못 보는» 것
 *   1. ⛔store.ts 가 훅을 «실제로 부르는지»는 정적 grep 으로만 본다(아래 SRC 검사). 실행은 못 한다.
 *   2. ⛔실기기 브릿지 응답 형태·토스 알림 횟수는 못 본다 → TESTONLY .ait 실기기 검증 몫.
 *   3. ⛔.ait 안에 코드가 «실렸는지»는 `ait_scan_promo.py` 몫.
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
      if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELFTEST = process.argv.slice(2).includes('--selftest');

const R = await import(pathToFileURL(resolve(ROOT, 'src/lib/promoRules.ts')).href);
const C = await import(pathToFileURL(resolve(ROOT, 'src/toss/promoCore.ts')).href);

/**
 * ★★TESTONLY 스위치 감지 (2026-09-01)
 *   `PROMO_IGNORE_BASELINE` 는 «정본 소스에 존재하지 않는다» — promo_testonly_patch.mjs 가
 *   TESTONLY 빌드에만 심는 상수다. 그래서 정본에서는 undefined 다.
 *   ⇒ 기준선 검사의 «기대값»을 여기서 갈라 준다. 갈라 주지 않으면 TESTONLY 소스에서 검사기가
 *     떨어져서 「TESTONLY 는 검사 못 하는 상태」가 된다(그게 이번 사고를 늦게 잡은 이유다).
 *   ⛔갈라도 «두 방향»은 그대로 본다: TESTONLY 는 이미달성 «1회» / 정본은 이미달성 «0회».
 *     한쪽만 보면 「아무에게도 안 나감」·「전원에게 나감」을 둘 다 놓친다.
 */
const IGNORE_BASE = C.PROMO_IGNORE_BASELINE === true;
console.log(`  [mode] baseline-gate = ${IGNORE_BASE ? '★BYPASSED (TESTONLY 소스)' : 'ON (정본 소스)'}`);

/* ── 가짜 의존성 ───────────────────────────────────────────────────────── */
function fakeDeps(opts = {}) {
  const store = new Map();
  const calls = []; // { method, params }
  const cfg = {
    streak3: { code: 'CODE_STREAK3', amount: 10 },
    hold10: { code: 'CODE_HOLD10', amount: 10 },
    cash100k: { code: 'CODE_CASH100K', amount: 100 },
    equity1m: { code: 'CODE_EQUITY1M', amount: 200 },
    play1h: { code: 'CODE_PLAY1H', amount: 200 },
    ...(opts.cfg || {}),
  };
  let seq = 0;
  const deps = {
    inToss: () => (opts.inToss === undefined ? true : opts.inToss),
    readConfig: (id) => cfg[id] ?? { code: '', amount: 0 },
    loadRecord: async (id) => (opts.loadFails ? (() => { throw new Error('load fail'); })() : store.get(id) ?? {}),
    saveRecord: async (id, rec) => {
      if (opts.saveFails) throw new Error('save fail');
      store.set(id, rec);
    },
    callBridge: async (method, params) => {
      calls.push({ method, params });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const fn = opts.respond ?? (() => ({ key: 'K' + ++seq }));
      return fn(method, params, calls.length);
    },
    now: () => 1_700_000_000_000,
    log: () => {},
  };
  return { deps, store, calls };
}

const errs = [];
const push = (m) => errs.push(m);
const eq = (a, b, m) => {
  if (a !== b) push(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

/* ── ① 규칙(순수 함수) ─────────────────────────────────────────────────── */
function testRules() {
  // 태그 == 상수 (번들 검사 표식의 근거)
  const tag = `ml-promo-rules:streak=${R.PROMO_STREAK_DAYS};hold=${R.PROMO_HOLD_TICKERS};cash=${R.PROMO_CASH_USD};equity=${R.PROMO_EQUITY_USD};play=${R.PROMO_PLAY_MS}`;
  eq(R.PROMO_RULE_TAG, tag, 'PROMO_RULE_TAG 가 상수와 다르다');
  eq(
    [...C.PROMO_IDS].join(','),
    'streak3,hold10,cash100k,equity1m,play1h',
    'PROMO_IDS 5종(top100 은 08-29 반려로 제거 · equity1m/play1h 는 09-01 신설)'
  );

  // streak
  const s0 = R.emptyStreak();
  const d1 = R.advanceStreak(s0, '2026-08-29');
  eq(d1.streak, 1, '첫 접속 streak');
  eq(d1.lastDate, '2026-08-29', '첫 접속 lastDate');
  const same = R.advanceStreak(d1, '2026-08-29');
  eq(same, d1, '같은 날 재접속은 «같은 객체»(무변화)');
  const d2 = R.advanceStreak(d1, '2026-08-30');
  eq(d2.streak, 2, '다음날 +1');
  const d3 = R.advanceStreak(d2, '2026-08-31');
  eq(d3.streak, 3, '3일째');
  const skip = R.advanceStreak(d2, '2026-09-01'); // 08-31 건너뜀
  eq(skip.streak, 1, '하루 건너뛰면 리셋');
  eq(skip.lastDate, '2026-09-01', '리셋 후 lastDate = 오늘');
  const back = R.advanceStreak(d2, '2026-08-29'); // 시계 되돌림
  eq(back, d2, '시계 되돌림은 무변화');
  const bad = R.advanceStreak({ lastDate: 'garbage', streak: 2 }, '2026-08-30');
  eq(bad.streak, 2, '형식 깨진 lastDate → 무변화');
  // 문턱: N-1 미달, N 달성
  eq(R.streakReached(R.PROMO_STREAK_DAYS - 1), false, 'streak 문턱-1 미달');
  eq(R.streakReached(R.PROMO_STREAK_DAYS), true, 'streak 문턱 달성');
  eq(R.streakReached(NaN), false, 'streak NaN');
  // sane
  const sane = R.saneStreak({ streak: 1e9, lastDate: '2026-08-29' });
  eq(sane.streak, R.PROMO_STREAK_SANE_MAX, 'saneStreak 상한');
  eq(R.saneStreak('x').streak, 0, 'saneStreak 손상값 → 0');
  eq(R.saneStreak({ streak: -3, lastDate: 5 }).lastDate, null, 'saneStreak lastDate 타입');

  // holdings
  const H = (n, extra = []) => [...Array.from({ length: n }, (_, i) => ({ ticker: 'T' + i, qty: 1 })), ...extra];
  eq(R.distinctHoldings(H(3, [{ ticker: 'T0', qty: 5 }])), 3, '중복 티커는 1로');
  eq(R.distinctHoldings(H(3, [{ ticker: 'Z', qty: 0 }])), 3, 'qty 0 은 안 센다');
  eq(R.distinctHoldings(null), 0, 'null → 0');
  eq(R.holdReached(R.distinctHoldings(H(R.PROMO_HOLD_TICKERS - 1))), false, 'hold 문턱-1 미달');
  eq(R.holdReached(R.distinctHoldings(H(R.PROMO_HOLD_TICKERS))), true, 'hold 문턱 달성');

  // cash (★08-29 top100 → cash100k). 문턱 «이상» 달성. 기대값은 상수에서 «유도»(TESTONLY 완화값에서도 같은 검사)
  eq(R.cashReached(R.PROMO_CASH_USD - 1), false, 'cash 문턱-1 미달');
  eq(R.cashReached(R.PROMO_CASH_USD - 0.01), false, 'cash 문턱-0.01 미달');
  eq(R.cashReached(R.PROMO_CASH_USD), true, 'cash 문턱 달성(이상)');
  eq(R.cashReached(R.PROMO_CASH_USD * 3), true, 'cash 문턱 초과 달성');
  eq(R.cashReached(0), false, 'cash 0 미달');
  eq(R.cashReached(-5), false, 'cash 음수(펀딩비 초과) 미달');
  eq(R.cashReached(NaN), false, 'cash NaN 미달');
  eq(R.cashReached(Infinity), false, 'cash Infinity(깨진 값) 미달');
  eq(R.cashReached(null), false, 'cash null 미달');
  eq(R.cashReached(undefined), false, 'cash undefined(portfolio 없음) 미달');
  eq(typeof R.rankReached, 'undefined', '반려된 rankReached 가 남아 있다');
  eq(typeof R.PROMO_TOP_RANK, 'undefined', '반려된 PROMO_TOP_RANK 가 남아 있다');

  /* ── ④ 총자산(equity1m, ★09-01). 기대값은 «상수에서 유도» — TESTONLY 완화값에서도 같은 검사가 돈다 ── */
  eq(R.equityReached(R.PROMO_EQUITY_USD - 1), false, 'equity 문턱-1 미달');
  eq(R.equityReached(R.PROMO_EQUITY_USD - 0.01), false, 'equity 문턱-0.01 미달');
  eq(R.equityReached(R.PROMO_EQUITY_USD), true, 'equity 문턱 달성(이상)');
  eq(R.equityReached(R.PROMO_EQUITY_USD * 2), true, 'equity 문턱 초과 달성');
  eq(R.equityReached(0), false, 'equity 0 미달');
  eq(R.equityReached(-1), false, 'equity 음수(파산) 미달');
  eq(R.equityReached(NaN), false, 'equity NaN 미달');
  eq(R.equityReached(Infinity), false, 'equity Infinity(깨진 값) 미달');
  eq(R.equityReached(null), false, 'equity null 미달');
  eq(R.equityReached(undefined), false, 'equity undefined(portfolio 없음) 미달');

  /* ── ⑤ 플레이 «실시간»(play1h, ★09-01) ── */
  eq(R.emptyPlay().totalMs, 0, 'emptyPlay 0');
  eq(R.sanePlay(null).totalMs, 0, 'sanePlay null → 0');
  eq(R.sanePlay('x').totalMs, 0, 'sanePlay 손상값 → 0');
  eq(R.sanePlay({ totalMs: -5 }).totalMs, 0, 'sanePlay 음수 → 0');
  eq(R.sanePlay({ totalMs: NaN }).totalMs, 0, 'sanePlay NaN → 0');
  eq(R.sanePlay({ totalMs: 1234.7 }).totalMs, 1234, 'sanePlay 소수 내림');
  eq(R.sanePlay({ totalMs: 1e15 }).totalMs, R.PROMO_PLAY_SANE_MAX, 'sanePlay 상한');
  const p0 = R.emptyPlay();
  eq(R.addPlayMs(p0, 0), p0, '0 은 «같은 객체»(무변화)');
  eq(R.addPlayMs(p0, -5), p0, '음수(시계 되돌림) 무변화');
  eq(R.addPlayMs(p0, NaN), p0, 'NaN 무변화');
  eq(R.addPlayMs(p0, R.PROMO_PLAY_BEAT_MS).totalMs, R.PROMO_PLAY_BEAT_MS, '정상 비트 = 그대로 누적');
  /* ★핵심: 얼었다 깨어난 «거대한» 경과는 잘린다. 과대 계상 = 「안 논 시간에 지급」이라 의도와 어긋난다 */
  eq(R.addPlayMs(p0, 9 * 60 * 60 * 1000).totalMs, R.PROMO_PLAY_DELTA_MAX, '★9시간 점프 → DELTA_MAX 로 절단');
  eq(R.addPlayMs(p0, R.PROMO_PLAY_DELTA_MAX + 1).totalMs, R.PROMO_PLAY_DELTA_MAX, 'DELTA_MAX+1 → 절단');
  if (!(R.PROMO_PLAY_DELTA_MAX >= 2 * R.PROMO_PLAY_BEAT_MS)) push('DELTA_MAX 가 비트 2회분보다 작다 — 정상 포그라운드에서도 잘린다');
  if (!(R.PROMO_PLAY_MS > R.PROMO_PLAY_BEAT_MS)) push('플레이 문턱이 비트 간격 이하다 — 해상도가 문턱을 삼킨다');
  if (!(R.PROMO_PLAY_SANE_MAX > R.PROMO_PLAY_MS)) push('SANE_MAX 가 플레이 문턱 이하 — 영원히 달성 불가');
  eq(R.playReached(R.PROMO_PLAY_MS - 1), false, 'play 문턱-1 미달');
  eq(R.playReached(R.PROMO_PLAY_MS), true, 'play 문턱 달성(이상)');
  eq(R.playReached(0), false, 'play 0 미달');
  eq(R.playReached(NaN), false, 'play NaN 미달');
  eq(R.playReached(null), false, 'play null 미달');
  eq(R.playReached(undefined), false, 'play undefined 미달');
}

/* ── ② 지급 코어(락·기록·브릿지) ─────────────────────────────────────────── */
async function testCore() {
  // 미달 → 아무것도 안 한다
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.maybeClaim('hold10', false), 'skipped', '미달 outcome');
    eq(calls.length, 0, '미달 → 브릿지 0회');
    eq(store.size, 0, '미달 → 저장 0건');
    eq(c.settled('hold10'), false, '미달은 세션 락을 «안» 건다');
  }
  // 충족 → 정확히 1회, 코드·금액이 설정과 «정확히» 같다
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.maybeClaim('cash100k', true), 'granted', '충족 outcome');
    eq(calls.length, 1, '충족 → 브릿지 1회');
    eq(calls[0].method, 'grantPromotionReward', '현행 API 먼저');
    eq(calls[0].params.promotionCode, 'CODE_CASH100K', '코드 전달');
    eq(calls[0].params.amount, 100, '금액 = 카드 금액');
    eq(store.get('cash100k')?.grantedAt, 1_700_000_000_000, '성공 «직후» 기록');
    eq(store.get('cash100k')?.key, 'K1', '리워드 키 기록');
    eq(store.get('cash100k')?.code, 'CODE_CASH100K', '★기록에 프로모션 코드 저장(코드 교체 대비)');
    // 재충족(같은 세션) → 락. 저장도 안 읽는다(loadRecord 를 실패시켜도 결과 같다)
    eq(await c.maybeClaim('cash100k', true), 'locked', '재충족 → locked');
    eq(await c.claim('cash100k'), 'locked', 'claim 직접 호출도 locked');
    eq(calls.length, 1, '★재충족 → 브릿지 «여전히» 1회');
  }
  // ★세션 락의 핵심: 기록 저장이 «실패»해도 같은 세션에서 두 번 못 부른다
  {
    const { deps, calls } = fakeDeps({ saveFails: true });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'granted', '저장 실패해도 지급은 granted');
    eq(await c.claim('hold10'), 'locked', '★저장 실패 + 재호출 → locked (08-26 시나리오)');
    eq(calls.length, 1, '★저장 실패 시나리오 브릿지 1회');
  }
  // 동시 호출(in-flight) → 1회
  {
    const { deps, calls } = fakeDeps({ delayMs: 20 });
    const c = C.createPromoClaimer(deps);
    const [a, b, d] = await Promise.all([c.claim('streak3'), c.claim('streak3'), c.claim('streak3')]);
    eq(a, 'granted', '동시 1');
    eq(b, 'granted', '동시 2 = 같은 promise');
    eq(d, 'granted', '동시 3');
    eq(calls.length, 1, '★동시 3회 호출 → 브릿지 1회');
  }
  // 새 세션 + 로컬 기록 있음 → already, 브릿지 0회
  {
    const { deps, calls, store } = fakeDeps();
    store.set('streak3', { grantedAt: 1, code: 'CODE_STREAK3' });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('streak3'), 'already', '기록 있음(같은 코드) → already');
    eq(calls.length, 0, '기록 있음 → 브릿지 0회');
    eq(await c.alreadyRewarded('streak3'), true, 'alreadyRewarded');
    eq(await c.alreadyRewarded('hold10'), false, 'alreadyRewarded 다른 훅');
  }
  // 훅 «독립»: 하나 받아도 다른 훅은 각자 나간다. 키도 각자.
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('streak3'), 'granted', '독립 1');
    eq(await c.claim('hold10'), 'granted', '독립 2');
    eq(await c.claim('cash100k'), 'granted', '독립 3');
    eq(await c.claim('equity1m'), 'granted', '독립 4');
    eq(await c.claim('play1h'), 'granted', '독립 5');
    eq(calls.length, 5, '훅 5종 각 1회 = 5회');
    eq(new Set(calls.map((x) => x.params.promotionCode)).size, 5, '코드 5종 각각');
    eq([...store.keys()].sort().join(','), 'cash100k,equity1m,hold10,play1h,streak3', '기록 키 5종 각각');
    eq(calls.map((x) => x.params.amount).join(','), '10,10,100,200,200', '금액 10/10/100/200/200');
  }
  // 4113 → already + 기록 복원
  {
    const { deps, calls, store } = fakeDeps({ respond: () => ({ errorCode: '4113', message: 'dup' }) });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'already', '4113 → already');
    eq(store.get('hold10')?.viaAlreadyGranted, true, '4113 → 기록 복원');
    eq(store.get('hold10')?.code, 'CODE_HOLD10', '4113 기록에도 코드 저장');
    eq(calls.length, 1, '4113 브릿지 1회');
  }
  // 4112(예산 소진)/4100 → failed, 기록 없음, 그래도 «세션 락»
  {
    const { deps, calls, store } = fakeDeps({ respond: () => ({ errorCode: '4112', message: 'budget' }) });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'failed', '4112 → failed');
    eq(store.size, 0, '실패는 기록하지 않는다(다음 실행 재시도)');
    eq(await c.claim('hold10'), 'locked', '실패 뒤 같은 세션 재호출 → locked');
    eq(calls.length, 1, '실패 시나리오 브릿지 1회');
    // 새 세션(새 claimer) → 재시도된다
    const c2 = C.createPromoClaimer(deps);
    eq(await c2.claim('hold10'), 'failed', '새 세션 재시도');
    eq(calls.length, 2, '새 세션 → 브릿지 +1');
  }
  // 폴백: 현행 undefined → 레거시 호출. 둘 다 undefined → unsupported
  {
    const { deps, calls } = fakeDeps({ respond: (m) => (m === 'grantPromotionReward' ? undefined : { key: 'LEG' }) });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('cash100k'), 'granted', '레거시 폴백 성공');
    eq(calls.map((x) => x.method).join(','), 'grantPromotionReward,grantPromotionRewardForGame', '폴백 순서');
  }
  {
    const { deps } = fakeDeps({ respond: () => undefined });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('cash100k'), 'unsupported', '둘 다 undefined → unsupported');
  }
  // 'ERROR' 문자열 → 폴백 → 'ERROR' → failed
  {
    const { deps, calls } = fakeDeps({ respond: () => 'ERROR' });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('cash100k'), 'failed', 'ERROR → failed');
    eq(calls.length, 2, 'ERROR 는 폴백까지 2회');
  }
  // 토스 밖 → unsupported, 브릿지 0회
  {
    const { deps, calls } = fakeDeps({ inToss: false });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'unsupported', '토스 밖');
    eq(calls.length, 0, '토스 밖 브릿지 0회');
  }
  // 미설정 → unconfigured
  {
    const { deps, calls } = fakeDeps({ cfg: { hold10: { code: '', amount: 0 } } });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'unconfigured', '미설정');
    eq(calls.length, 0, '미설정 브릿지 0회');
  }
  // 브릿지가 throw 해도 게임은 산다(failed) — deps 규약 위반까지 흡수
  {
    const { deps } = fakeDeps({ respond: () => { throw new Error('boom'); } });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'failed', '브릿지 throw → failed');
  }
  // loadRecord throw → 빈 기록으로 진행
  {
    const { deps, calls } = fakeDeps({ loadFails: true });
    const c = C.createPromoClaimer(deps);
    eq(await c.claim('hold10'), 'granted', 'loadRecord throw → 진행');
    eq(calls.length, 1, 'loadRecord throw 브릿지 1회');
  }
}

/* ── ②-b 코드 «교체» (★08-29 해오름·미리 실결함) — 지급 기록은 «코드별»이다 ──────────
   기록이 코드와 무관하면 콘솔에서 코드를 바꿀 때 옛 기록이 새 지급을 «영원히» 막는다.
   ⇒ 「이미 받음」은 기록의 code == 현재 code 일 때만. code 없는 옛 기록은 «다른 프로모션 것». */
async function testCodeRotation() {
  // 코드 A 지급 기록 상태에서 코드 B 로 바뀌면 → 호출된다(새 프로모션)
  {
    const { deps, calls, store } = fakeDeps({ cfg: { hold10: { code: 'CODE_B', amount: 10 } } });
    store.set('hold10', { grantedAt: 1, code: 'CODE_A', key: 'oldkey' });
    const c = C.createPromoClaimer(deps);
    eq(await c.alreadyRewarded('hold10'), false, '코드 A 기록은 코드 B 에 대해 alreadyRewarded false');
    eq(await c.claim('hold10'), 'granted', '★코드 A 기록 + 코드 B → granted');
    eq(calls.length, 1, '★코드 B → 브릿지 1회');
    eq(calls[0].params.promotionCode, 'CODE_B', '코드 B 전달');
    eq(store.get('hold10')?.code, 'CODE_B', '기록이 코드 B 로 갱신');
    eq(await c.claim('hold10'), 'locked', '같은 세션 같은 코드 재호출 → locked');
    eq(calls.length, 1, '같은 세션 → 여전히 1회');
    const c2 = C.createPromoClaimer(deps); // 새 세션 + 같은 코드 B
    eq(await c2.claim('hold10'), 'already', '★새 세션 + 같은 코드 → already');
    eq(calls.length, 1, '같은 코드 → 브릿지 0회 추가');
    eq(await c2.alreadyRewarded('hold10'), true, 'alreadyRewarded 같은 코드 true');
  }
  // 옛 기록에 code 가 «없으면» 다른 프로모션 것으로 본다 → 막지 않는다
  {
    const { deps, calls, store } = fakeDeps();
    store.set('streak3', { grantedAt: 1 });
    const c = C.createPromoClaimer(deps);
    eq(await c.alreadyRewarded('streak3'), false, 'code 없는 옛 기록 → alreadyRewarded false');
    eq(await c.claim('streak3'), 'granted', '★code 없는 옛 기록 → granted');
    eq(calls.length, 1, 'code 없는 옛 기록 → 브릿지 1회');
    eq(store.get('streak3')?.code, 'CODE_STREAK3', '기록에 코드가 채워진다');
  }
  // 4113 으로 닫힌 기록도 코드별 — 코드가 바뀌면 다시 나간다
  {
    const { deps, calls, store } = fakeDeps({ cfg: { cash100k: { code: 'CODE_B', amount: 100 } } });
    store.set('cash100k', { grantedAt: 1, viaAlreadyGranted: true, code: 'CODE_A' });
    eq(await C.createPromoClaimer(deps).claim('cash100k'), 'granted', '4113 기록(코드 A) + 코드 B → granted');
    eq(calls.length, 1, '4113 기록 코드 교체 → 1회');
  }
}

/* ── ③ 스트릭 «시나리오» — 규칙+코어를 이어서: 3일 연속이면 «1회», 4일째는 «0회» ── */
async function testStreakScenario() {
  const { deps, calls } = fakeDeps();
  const c = C.createPromoClaimer(deps);
  let st = R.emptyStreak();
  const days = ['2026-08-29', '2026-08-29', '2026-08-30', '2026-08-31', '2026-08-31', '2026-09-01'];
  const outcomes = [];
  for (const d of days) {
    st = R.advanceStreak(st, d);
    outcomes.push(await c.maybeClaim('streak3', R.streakReached(st.streak)));
  }
  // 기대값은 문턱에서 «유도»한다(TESTONLY 완화값에서도 같은 검사가 돌아야 한다). streak 열: 1,1,2,3,3,4
  const streaks = [1, 1, 2, 3, 3, 4];
  const firstHit = streaks.findIndex((v) => v >= R.PROMO_STREAK_DAYS);
  const expected = streaks.map((_, i) => (i < firstHit ? 'skipped' : i === firstHit ? 'granted' : 'locked'));
  eq(outcomes.join(','), expected.join(','), '스트릭 시나리오 outcome');
  eq(calls.length, 1, '★3일 연속 시나리오 브릿지 «정확히 1회»');
  // 하루 건너뛰고 다시 3일 → 새 세션이어도 «로컬 기록»이 막는다
  const c2 = C.createPromoClaimer(deps);
  let st2 = R.advanceStreak(st, '2026-09-03');
  eq(st2.streak, 1, '건너뛴 뒤 리셋');
  for (let d = 4; st2.streak < R.PROMO_STREAK_DAYS; d++) st2 = R.advanceStreak(st2, `2026-09-${String(d).padStart(2, '0')}`);
  eq(await c2.maybeClaim('streak3', R.streakReached(st2.streak)), 'already', '두 번째 3일 연속 → already(로컬 기록)');
  eq(calls.length, 1, '두 번째 3일 연속 → 브릿지 «여전히» 1회');
}

/* ── ③-b 현금 «시나리오» (★08-29) — 규칙+코어를 이어서: 미달→0 / 도달→1회 / 재도달→locked / 부팅 시 이미 도달→1회 ── */
async function testCashScenario() {
  const T = R.PROMO_CASH_USD;
  // (1) 미달 — 잔고가 오르내려도 문턱 아래면 브릿지 0회·저장 0건·락 없음
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    for (const cash of [0, T * 0.1, T - 1, T * 0.5, T - 0.01, -3]) {
      eq(await c.maybeClaim('cash100k', R.cashReached(cash)), 'skipped', `현금 ${cash} 미달`);
    }
    eq(calls.length, 0, '★미달 → 브릿지 0회');
    eq(store.size, 0, '미달 → 저장 0건');
    eq(c.settled('cash100k'), false, '미달은 세션 락을 «안» 건다');
  }
  // (2) 도달 → 정확히 1회  (3) 같은 세션 재도달(더 오르든, 내렸다 다시 오르든) → locked, 여전히 1회
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.maybeClaim('cash100k', R.cashReached(T - 1)), 'skipped', '도달 직전 skipped');
    eq(await c.maybeClaim('cash100k', R.cashReached(T)), 'granted', '★도달 → granted');
    eq(calls.length, 1, '★도달 → 브릿지 1회');
    eq(calls[0].params.promotionCode, 'CODE_CASH100K', '현금 훅 코드 전달');
    eq(calls[0].params.amount, 100, '현금 훅 금액 = 카드 금액 100');
    eq(store.get('cash100k')?.grantedAt, 1_700_000_000_000, '도달 → 성공 «직후» 기록');
    eq(await c.maybeClaim('cash100k', R.cashReached(T * 2)), 'locked', '재도달(상승) → locked');
    eq(await c.maybeClaim('cash100k', R.cashReached(T / 2)), 'skipped', '문턱 아래로 내려감 → skipped(락은 그대로)');
    eq(await c.maybeClaim('cash100k', R.cashReached(T)), 'locked', '다시 도달 → locked');
    eq(c.settled('cash100k'), true, '도달 뒤 세션 락');
    eq(calls.length, 1, '★재도달 → 브릿지 «여전히» 1회');
  }
  // (4) 부팅 시 이미 도달 — 저장본 복원 직후 잔고 ≥ 문턱, 지급 기록 없음 → 새 세션에서 «정확히 1회»
  {
    const { deps, calls } = fakeDeps();
    const boot = C.createPromoClaimer(deps); // 새 세션 = 새 claimer (store.boot 의 checkCashPromo)
    eq(await boot.maybeClaim('cash100k', R.cashReached(T + 123)), 'granted', '★부팅 시 이미 도달 → granted');
    eq(calls.length, 1, '★부팅 시 이미 도달 → 브릿지 1회');
    // 같은 세션에서 claimAttendance→afterOrder 가 이어 불러도 0회 추가
    eq(await boot.maybeClaim('cash100k', R.cashReached(T + 123)), 'locked', '부팅 직후 afterOrder → locked');
    eq(calls.length, 1, '부팅+afterOrder 합계 1회');
    // (5) 다음 부팅(새 세션) — 로컬 기록이 막는다 → already, 브릿지 0회 추가
    const boot2 = C.createPromoClaimer(deps);
    eq(await boot2.maybeClaim('cash100k', R.cashReached(T + 123)), 'already', '다음 부팅 → already(로컬 기록)');
    eq(calls.length, 1, '★다음 부팅 → 브릿지 «여전히» 1회');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ③-c ★★기준선 게이트 (2026-09-01 President 「프로모션 개설 «전»에 이미 달성한 사람에겐 지급 없음」)
   ══════════════════════════════════════════════════════════════════════════
   ⚠1순위 검사다. ★«두 방향»을 반드시 같이 본다 —
     (가) 이미 달성했던 기기 → 0회   (나) 기준선 이후 새로 달성한 기기 → 1회
   한쪽만 보면 「아무에게도 안 나가는」 고장을 정상으로 «오판»한다(양성대조의 뿌리).
   ══════════════════════════════════════════════════════════════════════════ */
const BASE_STATS = { richCalls: -1, poorCalls: -1, playOldCalls: -1, playNewCalls: -1 };

async function testBaseline() {
  const T = R.PROMO_EQUITY_USD;

  /* (가) 상태 보유형 · 「이미 100만 달러였던 기기」 ⇒ 정본 «0회» / ★TESTONLY «1회» ------------- */
  if (IGNORE_BASE) {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const outs = [];
    for (const v of [T * 2, T * 3, T * 0.5, T * 4, T, T * 10]) outs.push(await c.claimOnTransition('equity1m', R.equityReached(v)));
    BASE_STATS.richCalls = calls.length;
    eq(outs[0], 'granted', '★TESTONLY: 이미 달성한 기기도 «첫 판정»에서 granted');
    eq(calls.length, 1, '★★TESTONLY: 이미 달성한 기기(총자산) → 브릿지 «정확히 1회»');
    eq(calls[0].params.promotionCode, 'CODE_EQUITY1M', 'TESTONLY 총자산 훅 코드');
    eq(calls[0].params.amount, 200, 'TESTONLY 총자산 훅 금액');
    eq([...new Set(outs.slice(1))].join(','), 'locked', 'TESTONLY 지급 뒤는 «전부» 세션 락(미달로 내려가도 락이 먼저다)');
    eq(store.get('equity1m')?.grantedAt, 1_700_000_000_000, 'TESTONLY 지급 기록');
    eq(store.get('equity1m')?.base, undefined, '★TESTONLY: 기준선을 «박지도 않는다»');
    eq(c.ineligible('equity1m'), false, 'TESTONLY 는 ineligible 이 절대 켜지지 않는다');
    /* ★중복 방지는 살아 있어야 한다 — 재부팅(새 claimer)은 로컬 기록이 막는다 */
    const c2 = C.createPromoClaimer(deps);
    eq(await c2.claimOnTransition('equity1m', true), 'already', '★TESTONLY 재부팅 → already(중복 방지 생존)');
    eq(calls.length, 1, '★TESTONLY 재부팅 후에도 브릿지 «여전히» 1회');
  } else {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const outs = [];
    /* 첫 판정부터 문턱 이상. 중간에 문턱 «아래»로 내려갔다 다시 올라오는 «우회»도 섞는다 */
    for (const v of [T * 2, T * 3, T * 0.5, T * 4, T, T * 10]) outs.push(await c.claimOnTransition('equity1m', R.equityReached(v)));
    BASE_STATS.richCalls = calls.length;
    eq(calls.length, 0, '★★이미 달성했던 기기(총자산) → 브릿지 «0회»');
    eq(outs[0], 'ineligible', '첫 판정 = ineligible');
    eq([...new Set(outs)].join(','), 'ineligible', '★이후 «전부» ineligible — 내렸다 다시 올라도 안 준다');
    eq(store.get('equity1m')?.base?.had, true, '기준선에 had=true 가 박힌다');
    eq(store.get('equity1m')?.base?.at, 1_700_000_000_000, '기준선 시각 기록');
    eq(store.get('equity1m')?.grantedAt, undefined, '지급 기록 «없음»');
    eq(store.get('equity1m')?.code, 'CODE_EQUITY1M', '★기준선도 «코드별»');
    eq(c.ineligible('equity1m'), true, 'ineligible() 값싼 문 true');
    /* ★재부팅(새 claimer) — 메모리 캐시가 아니라 «저장»이 막는지 본다 */
    const c2 = C.createPromoClaimer(deps);
    eq(c2.ineligible('equity1m'), false, '새 세션은 캐시가 비어 있다(저장을 읽어야 한다)');
    eq(await c2.claimOnTransition('equity1m', true), 'ineligible', '★재부팅해도 ineligible');
    eq(calls.length, 0, '★재부팅 후에도 브릿지 0회');
  }

  /* (나) 상태 보유형 · 「기준선 이후 새로 달성한 기기」 ⇒ 지급 «1회» ------------------------- */
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const outs = [];
    for (const v of [T * 0.1, T * 0.9, T - 1, T, T * 2]) outs.push(await c.claimOnTransition('equity1m', R.equityReached(v)));
    BASE_STATS.poorCalls = calls.length;
    eq(outs.join(','), 'skipped,skipped,skipped,granted,locked', '★기준선 이후 «전이»하는 순간 지급');
    eq(calls.length, 1, '★★새로 달성한 기기(총자산) → 브릿지 «정확히 1회»');
    eq(calls[0].params.promotionCode, 'CODE_EQUITY1M', '총자산 훅 코드 전달');
    eq(calls[0].params.amount, 200, '총자산 훅 금액 = 카드 금액 200');
    eq(store.get('equity1m')?.grantedAt, 1_700_000_000_000, '지급 기록');
    if (!IGNORE_BASE) {
      eq(store.get('equity1m')?.base?.had, false, '기준선 had=false');
      eq(store.get('equity1m')?.base?.at, 1_700_000_000_000, '★지급 저장이 기준선을 «지우지 않는다»');
    }
    /* 다음 부팅 — 로컬 기록이 막는다 */
    const c2 = C.createPromoClaimer(deps);
    eq(await c2.claimOnTransition('equity1m', true), 'already', '다음 부팅 → already');
    eq(calls.length, 1, '★다음 부팅 → 브릿지 여전히 1회');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     (아) ★★「base.had=true 레코드가 «이미» 저장에 박힌 기기」 = 2026-09-01 President 실기기 상태
     ══════════════════════════════════════════════════════════════════════════
     TESTONLY 빌드가 그 기기에서 한 번이라도 돈 뒤의 상태다. 스위치만 켜고 이 레코드를 그대로
     읽으면 «여전히» 안 나간다 — 이번 사고에서 가장 중요한 항목이라 «독립 검사»로 못 박는다.
       정본    → ineligible / 브릿지 0회 (소급 차단 생존)
       TESTONLY → granted    / 브릿지 1회 (실기기 검증 가능)
     ══════════════════════════════════════════════════════════════════════════ */
  {
    const { deps, calls, store } = fakeDeps();
    /* 「총자산이 문턱을 한참 넘고, had=true 가 이미 박힌」 기기 */
    store.set('equity1m', { code: 'CODE_EQUITY1M', base: { at: 1, had: true } });
    const c = C.createPromoClaimer(deps);
    const out = await c.claimOnTransition('equity1m', R.equityReached(T * 1000));
    if (IGNORE_BASE) {
      eq(out, 'granted', '★★TESTONLY: base.had=true 레코드가 있어도 «지급된다»(President 기기)');
      eq(calls.length, 1, '★★TESTONLY: 브릿지 «정확히 1회»');
      eq(calls[0].params.amount, 200, 'TESTONLY 금액 200');
      eq(store.get('equity1m')?.grantedAt, 1_700_000_000_000, 'TESTONLY 지급 기록');
      const c2 = C.createPromoClaimer(deps);
      eq(await c2.claimOnTransition('equity1m', true), 'already', 'TESTONLY 재부팅 → already');
      eq(calls.length, 1, 'TESTONLY 재부팅 → 여전히 1회');
    } else {
      eq(out, 'ineligible', '★정본: base.had=true 레코드 → 영구 미지급');
      eq(calls.length, 0, '★정본: 브릿지 0회(소급 차단 생존)');
      eq(store.get('equity1m')?.grantedAt, undefined, '정본: 지급 기록 없음');
    }
  }

  /* (다) 누적 카운터형 · 「이미 1시간 넘게 논 기기」 ⇒ 과거 누적 «이월 없음», 지급 0회 ------ */
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const had = R.PROMO_PLAY_MS * 5; // 저장본에 이미 5배 누적
    eq(await c.claimOnDelta('play1h', had, R.playReached), 'skipped', '★이미 문턱 5배 누적 → 지급 안 됨(기준선만 박힘)');
    eq(store.get('play1h')?.base?.from, had, '★기준선 from = 그때의 누적값');
    eq(store.get('play1h')?.code, 'CODE_PLAY1H', '기준선도 코드별');
    eq(await c.claimOnDelta('play1h', had + R.PROMO_PLAY_MS - 1, R.playReached), 'skipped', '기준선 이후 문턱-1 → 미지급');
    BASE_STATS.playOldCalls = calls.length;
    eq(calls.length, 0, '★★이미 달성했던 기기(플레이) → 브릿지 «0회»');
    /* ★기준선 «이후»로 온전히 문턱을 채우면 그때 지급된다 */
    eq(await c.claimOnDelta('play1h', had + R.PROMO_PLAY_MS, R.playReached), 'granted', '★기준선 이후 문턱 도달 → 지급');
    eq(calls.length, 1, '기준선 이후 달성 → 1회');
  }

  /* (라) 누적 카운터형 · 「새 기기」 ⇒ 0 부터 세어 문턱을 채우면 1회 ------------------------ */
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const BEAT = R.PROMO_PLAY_BEAT_MS;
    const NEED = Math.ceil(R.PROMO_PLAY_MS / BEAT);
    /* ★부팅 시 «누적 전»에 기준선을 박는다(promotion.ts loadPlay 와 같은 순서) */
    eq(await c.claimOnDelta('play1h', 0, R.playReached), 'skipped', '부팅 기준선 박기');
    eq(store.get('play1h')?.base?.from, 0, '★새 기기 기준선 from = 0');
    let total = 0;
    const outs = [];
    for (let i = 0; i < NEED; i++) {
      total += BEAT;
      outs.push(await c.claimOnDelta('play1h', total, R.playReached));
    }
    BASE_STATS.playNewCalls = calls.length;
    eq(outs[NEED - 2], 'skipped', '문턱 직전 비트는 skipped');
    eq(outs[NEED - 1], 'granted', '★문턱에 «닿는» 비트에서 지급');
    eq(outs.filter((x) => x === 'granted').length, 1, 'granted 정확히 1건');
    eq(calls.length, 1, '★★새 기기(플레이) → 브릿지 «정확히 1회»');
    eq(calls[0].params.promotionCode, 'CODE_PLAY1H', '플레이 훅 코드 전달');
    eq(calls[0].params.amount, 200, '플레이 훅 금액 = 카드 금액 200');
    /* 지급 뒤 비트는 locked, 다음 부팅은 already */
    total += BEAT;
    eq(await c.claimOnDelta('play1h', total, R.playReached), 'locked', '지급 뒤 비트 → locked');
    eq(await C.createPromoClaimer(deps).claimOnDelta('play1h', total, R.playReached), 'already', '다음 부팅 → already');
    eq(calls.length, 1, '★다음 부팅 → 브릿지 여전히 1회');
  }

  /* (마) ★코드 교체 — 기준선도 «코드별». 옛 코드의 had=true 가 새 프로모션을 막지 않는다 --- */
  {
    const { deps, calls, store } = fakeDeps();
    store.set('equity1m', { code: 'CODE_OLD', base: { at: 1, had: true }, grantedAt: 1 });
    const c = C.createPromoClaimer(deps); // 현재 코드 = CODE_EQUITY1M
    eq(await c.claimOnTransition('equity1m', false), 'skipped', '★옛 코드의 had=true 는 새 코드를 막지 않는다');
    if (!IGNORE_BASE) {
      eq(store.get('equity1m')?.code, 'CODE_EQUITY1M', '새 코드로 기준선 재수립');
      eq(store.get('equity1m')?.base?.had, false, '새 기준선 had = «지금» 상태');
      eq(store.get('equity1m')?.grantedAt, undefined, '옛 코드의 지급 기록은 새 판에 안 실린다');
    } else {
      eq(store.get('equity1m')?.code, 'CODE_OLD', '★TESTONLY: 기준선을 안 박으니 저장이 «그대로»다');
    }
    eq(await c.claimOnTransition('equity1m', true), 'granted', '새 코드 기준선 이후 전이 → 지급');
    eq(calls.length, 1, '코드 교체 후 정확히 1회');
    /* 누적형도 같다 */
    const { deps: d2, calls: k2, store: s2 } = fakeDeps({ cfg: { play1h: { code: 'CODE_NEWPLAY', amount: 200 } } });
    s2.set('play1h', { code: 'CODE_OLD', base: { at: 1, from: 0 }, grantedAt: 1 });
    const c3 = C.createPromoClaimer(d2);
    eq(await c3.claimOnDelta('play1h', R.PROMO_PLAY_MS * 3, R.playReached), 'skipped', '★코드 교체 시 누적 기준선도 «다시» 잡힌다');
    eq(s2.get('play1h')?.base?.from, R.PROMO_PLAY_MS * 3, '새 코드 기준선 from = 지금 누적값');
    eq(k2.length, 0, '코드 교체 직후엔 지급 없음(이후분부터)');
  }

  /* (바) 이미 «지급»된 기록이 있으면 기준선을 다시 박지 않는다(already 가 먼저 닫는다) ----- */
  {
    const { deps, calls, store } = fakeDeps();
    store.set('equity1m', { code: 'CODE_EQUITY1M', grantedAt: 5 }); // base 없는 옛 형태
    const c = C.createPromoClaimer(deps);
    eq(await c.claimOnTransition('equity1m', true), 'already', 'base 없는 지급 기록 → already');
    eq(store.get('equity1m')?.base, undefined, '기준선을 새로 박지 «않는다»');
    eq(calls.length, 0, '브릿지 0회');
  }

  /* (사) ★대조 요약 — «둘 다» 맞아야 통과. 한쪽만 보면 「아무에게도 안 나감」을 정상으로 오판한다.
     ★TESTONLY 는 기준선을 «의도적으로» 무시하므로 이미달성도 1회가 «정상»이다(0회면 그게 고장이다) */
  const WANT_RICH = IGNORE_BASE ? 1 : 0;
  if (BASE_STATS.richCalls !== WANT_RICH || BASE_STATS.poorCalls !== 1) {
    push(`★기준선 대조(총자산) 실패: 이미달성=${BASE_STATS.richCalls}회(${WANT_RICH} 이어야) · 새달성=${BASE_STATS.poorCalls}회(1 이어야)`);
  }
  if (BASE_STATS.playOldCalls !== 0 || BASE_STATS.playNewCalls !== 1) {
    push(`★기준선 대조(플레이) 실패: 이미달성=${BASE_STATS.playOldCalls}회(0 이어야) · 새달성=${BASE_STATS.playNewCalls}회(1 이어야)`);
  }
  console.log(
    `  [baseline] 총자산: 이미달성 ${BASE_STATS.richCalls}회 / 새달성 ${BASE_STATS.poorCalls}회 · ` +
      `플레이: 이미달성 ${BASE_STATS.playOldCalls}회 / 새달성 ${BASE_STATS.playNewCalls}회`
  );
}

/* ── ③-d 총자산 «시나리오» — ⛔주문 «0건»으로 가격만 움직여 넘는 경로까지 태운다 ── */
async function testEquityScenario() {
  const T = R.PROMO_EQUITY_USD;
  // (1) 미달 — 오르내려도 문턱 아래면 브릿지 0회. 기준선은 «박힌다»(그게 정상)
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    for (const v of [0, T * 0.5, T - 1, T - 0.01, -3, NaN]) {
      eq(await c.claimOnTransition('equity1m', R.equityReached(v)), 'skipped', `총자산 ${v} 미달`);
    }
    eq(calls.length, 0, '★총자산 미달 → 브릿지 0회');
    eq(c.settled('equity1m'), false, '미달은 세션 락을 «안» 건다');
    if (!IGNORE_BASE) {
      eq(store.get('equity1m')?.base?.had, false, '미달 상태에서 기준선 had=false');
      eq(c.baselined('equity1m'), true, '기준선이 메모리에 잡혔다(매 틱 값싼 문)');
    } else {
      eq(store.has('equity1m'), false, '★TESTONLY: 미달이면 저장을 «건드리지 않는다»');
      eq(c.baselined('equity1m'), false, '★TESTONLY: 기준선을 잡지 않는다(store.ts 값싼 문이 항상 열린다)');
    }
  }
  // (2) ★주문 0건 — 매 틱 판정만으로 도달(가격 상승) → 정확히 1회
  {
    const { deps, calls } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    const ticks = [T * 0.98, T * 0.99, T * 0.999, T, T * 1.2, T * 0.5, T * 1.5];
    const out = [];
    for (const v of ticks) out.push(await c.claimOnTransition('equity1m', R.equityReached(v)));
    eq(out.join(','), 'skipped,skipped,skipped,granted,locked,locked,locked', '★가격만으로 도달하는 틱 시나리오');
    eq(calls.length, 1, '★매 틱 판정 7회 → 브릿지 «정확히 1회»');
  }
  // (3) ★현금 훅과 «독립» — 서로의 기록·락을 오염시키지 않는다
  {
    const { deps, calls, store } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.maybeClaim('cash100k', R.cashReached(R.PROMO_CASH_USD)), 'granted', '현금 도달 → granted');
    eq(c.settled('equity1m'), false, '★현금 훅이 총자산 훅의 세션 락을 건드리지 않는다');
    eq(store.has('equity1m'), false, '★현금 훅이 총자산 기록을 쓰지 않는다');
    eq(calls.filter((x) => x.params.promotionCode === 'CODE_EQUITY1M').length, 0, '총자산 훅 0회');
  }
}

/* ── ③-e 플레이 «실시간» 누적 시나리오 — 비트·백그라운드·절단 ── */
async function testPlayScenario() {
  const BEAT = R.PROMO_PLAY_BEAT_MS;
  // (1) ★백그라운드는 «안 센다» — 배선이 delta 0 을 주는 구간(playSince === null)
  {
    let st = R.emptyPlay();
    for (let i = 0; i < 10; i++) st = R.addPlayMs(st, 0);
    eq(st.totalMs, 0, '★백그라운드 10비트 → 누적 0');
  }
  // (2) ★얼었다 깨어난 «큰 점프» 한 번으로는 지급되지 않는다(과대 계상 방지)
  {
    const { deps, calls } = fakeDeps();
    const c = C.createPromoClaimer(deps);
    eq(await c.claimOnDelta('play1h', 0, R.playReached), 'skipped', '부팅 기준선(from=0)');
    const st = R.addPlayMs(R.emptyPlay(), 8 * 60 * 60 * 1000);
    eq(st.totalMs, R.PROMO_PLAY_DELTA_MAX, '★8시간 점프 → DELTA_MAX 로 절단');
    const expect = R.playReached(R.PROMO_PLAY_DELTA_MAX) ? 'granted' : 'skipped';
    eq(await c.claimOnDelta('play1h', st.totalMs, R.playReached), expect, '절단 뒤 판정');
    if (!R.playReached(R.PROMO_PLAY_DELTA_MAX)) eq(calls.length, 0, '★8시간 점프 한 번으로는 브릿지 0회');
  }
  // (3) 포그라운드 비트 누적의 «총합»이 맞는가(규칙 층)
  {
    let st = R.emptyPlay();
    const n = 40;
    for (let i = 0; i < n; i++) st = R.addPlayMs(st, BEAT);
    eq(st.totalMs, n * BEAT, `비트 ${n}회 누적 총합`);
  }
}

/* ── ④ 소스 정적검사 — store.ts 배선 · 옛/반려 훅 제거 · index.html 코드 · 문턱↔태그 일치 ─────────── */
function testSources(overrides = {}) {
  const read = (p) => overrides[p] ?? readFileSync(resolve(ROOT, p), 'utf8');
  const store = read('src/store/store.ts');
  const html = read('index.html');
  const prom = read('src/toss/promotion.ts');
  const idx = read('src/toss/index.ts');
  const rules = read('src/lib/promoRules.ts');
  const OLD = '01M0X18BKA' + '64324584DZYWNZJT';
  /* ★08-29 콘솔 «반려·종료»된 「100위 안에 들기」 코드. 죽은 코드로 호출하면 실패만 남긴다 — 어디에도 0 */
  const REJECTED = '01M16CCAN503' + 'FZZX3JR8MS7SKS';
  const found = [];
  const f = (m) => found.push(m);

  if (/\bclaimReward\s*\(/.test(store)) f('store.ts 에 옛 훅 호출 claimReward( 가 남아 있다');
  if (/claimReward/.test(idx) || /export\s+(async\s+)?function\s+claimReward\b/.test(prom)) f('옛 claimReward export 가 남아 있다');
  for (const p of ['src/store/store.ts', 'index.html', 'src/toss/promotion.ts']) if (read(p).includes(OLD)) f(`${p} 에 옛 코드 ${OLD} 가 있다`);
  for (const p of ['src/store/store.ts', 'index.html', 'src/toss/promotion.ts', 'src/lib/promoRules.ts', 'src/toss/promoCore.ts']) {
    if (read(p).includes(REJECTED)) f(`${p} 에 반려 코드 ${REJECTED} 가 있다(「100위 안에 들기」는 08-29 콘솔 반려)`);
  }
  if ((store.match(/\bcheckHoldPromo\(\)/g) || []).length < 2) f('afterOrder → checkHoldPromo 배선 없음');
  if ((store.match(/\bcheckCashPromo\(\)/g) || []).length < 3) f('현금 훅 배선 부족 — checkCashPromo 선언+afterOrder+boot 3곳 필요');
  if (!/this\.checkHoldPromo\(\);\s*this\.checkCashPromo\(\);/.test(store)) f('afterOrder 에 checkCashPromo 가 checkHoldPromo 바로 뒤에 없다');
  if (!/this\.startLoop\(\);\s*(\/\*[\s\S]*?\*\/\s*)?this\.checkCashPromo\(\);/.test(store)) f('boot() 에 부팅 1회 checkCashPromo 가 없다');
  if (/checkRankPromo|rankReached|promoSettled\('top100'\)|maybeClaimPromo\('top100'/.test(store)) f('store.ts 에 반려된 순위 훅(top100/checkRankPromo/rankReached) 잔재가 있다');
  if (/rankReached|PROMO_TOP_RANK/.test(rules)) f('promoRules.ts 에 반려된 순위 규칙(rankReached/PROMO_TOP_RANK) 잔재가 있다');
  /* ★문턱↔태그 «소스 수준» 일치 — 상수만 바꾸고 태그를 안 바꾼(또는 그 반대) 변조를 잡는다 */
  const cSrc = rules.match(/export const PROMO_CASH_USD = (\d+);/);
  const tSrc = rules.match(/PROMO_RULE_TAG = 'ml-promo-rules:streak=(\d+);hold=(\d+);cash=(\d+);equity=(\d+);play=(\d+)'/);
  const sSrc = rules.match(/export const PROMO_STREAK_DAYS = (\d+);/);
  const hSrc = rules.match(/export const PROMO_HOLD_TICKERS = (\d+);/);
  const eSrc = rules.match(/export const PROMO_EQUITY_USD = (\d+);/);
  const pSrc = rules.match(/export const PROMO_PLAY_MS = (\d+);/);
  if (!cSrc || !tSrc || !sSrc || !hSrc || !eSrc || !pSrc) f('promoRules.ts 에서 문턱 상수/태그 리터럴을 못 읽었다(형식이 바뀌었으면 검사기를 고쳐라)');
  else {
    const got = [sSrc[1], hSrc[1], cSrc[1], eSrc[1], pSrc[1]].join('/');
    const want = [tSrc[1], tSrc[2], tSrc[3], tSrc[4], tSrc[5]].join('/');
    if (got !== want) f(`문턱 변조: 상수(${got}) ≠ 태그(${want})`);
  }
  if ((store.match(/void touchStreak\(\)/g) || []).length !== 2) f('boot/onVisibility → touchStreak 배선이 2곳이 아니다');
  if (!/maybeClaimPromo\('hold10', holdReached\(/.test(store)) f('hold10 판정이 promoRules.holdReached 를 안 쓴다');
  /* ★[2026-09-05 President 지시] 「프로모션 10만·100만 요건은 «순자산» 기준 — 대출로 바로 달성 방지」
     ⇒ cash100k 는 «현금 AND 순자산» 두 값을 다 넘겨야 한다. 하나로 되돌리면 대출 우회가 부활한다. */
  if (!/maybeClaimPromo\('cash100k', cashReached\(this\.portfolio\?\.cash, this\.portfolio\?\.netWorth\)/.test(store))
    f('cash100k 판정이 cashReached(this.portfolio?.cash, this.portfolio?.netWorth) 를 안 쓴다 — 대출로 현금만 채운 상태가 지급된다');
  if (!/export function cashReached\(\s*cash: number \| null \| undefined,\s*netWorth\?/.test(rules))
    f('promoRules.cashReached 가 순자산 인자를 받지 않는다 — 시그니처가 되돌려졌다');
  /* ── ★09-01 신설 2종 배선 ─────────────────────────────────────────────── */
  if ((store.match(/\bcheckEquityPromo\(\)/g) || []).length < 3) f('총자산 훅 배선 부족 — checkEquityPromo 선언+afterOrder+syncFromWorld 3곳 필요');
  if (!/this\.checkCashPromo\(\);\s*this\.checkEquityPromo\(\);/.test(store)) f('afterOrder 에 checkEquityPromo 가 checkCashPromo 바로 뒤에 없다');
  /* ★[2026-09-05] equity1m 도 «순자산»이다. 이름(키)은 지급 이력 때문에 그대로 두고 «값»만 바꿨다.
     ⛔`this.portfolio?.equity` 로 되돌아가면 「$1M 대출 → 즉시 지급」이 부활한다. */
  if (!/const eq = this\.portfolio\?\.netWorth;/.test(store))
    f('equity1m 이 순자산(this.portfolio?.netWorth)을 안 읽는다 — 총자산으로 되돌려졌다');
  if (/const eq = this\.portfolio\?\.equity;/.test(store))
    f('equity1m 에 총자산(this.portfolio?.equity) 경로가 남아 있다');
  if (!/export function equityReached\(netWorth: number \| null \| undefined\)/.test(rules))
    f('promoRules.equityReached 의 인자가 netWorth 가 아니다 — 시그니처가 되돌려졌다');
  if (!/if \(!equityReached\(eq\) && promoBaselined\('equity1m'\)\) return null;/.test(store)) f('equity1m 판정이 promoRules.equityReached 를 안 쓴다');
  if ((store.match(/settleEquityBaseline\(\)/g) || []).length < 2) f('★부팅 기준선 확정(settleEquityBaseline) 배선이 선언+boot 2곳이 아니다');
  /* ★★순서가 «전부»다: 출석 보상(최대 $100,000)이 기준선보다 먼저 들어가면 기준선이 밀려 올라간다 */
  if (!/await this\.settleEquityBaseline\(\);[\s\S]{0,1200}?this\.claimAttendance\(\);/.test(store))
    f('★boot() 에서 기준선 확정(await settleEquityBaseline)이 claimAttendance «앞»에 없다 — 출석 보상이 기준선을 밀어 올린다');
  if (!/pushEquity\(this\.portfolio\.equity\);\s*(\/\*[\s\S]*?\*\/\s*)?if \(!this\.booting\) this\.checkEquityPromo\(\);/.test(store))
    f('★매 틱(syncFromWorld) 총자산 판정이 pushEquity 뒤에 없다 — 주문 없이 가격만으로 넘는 경로가 «영영» 안 잡힌다');
  if (!/if \(document\.visibilityState === 'visible'\) playtimeResume\(\);/.test(store)) f('startLoop 에 playtimeResume 배선이 없다');
  if (!/window\.setInterval\(\(\) => void playtimeBeat\(\), PROMO_PLAY_BEAT_MS\)/.test(store))
    f('★플레이 비트 타이머(playtimeBeat @ PROMO_PLAY_BEAT_MS)가 없다 — 플레이 시간이 «영영» 안 쌓인다');
  if ((store.match(/playtimeResume\(\)/g) || []).length < 2) f('playtimeResume 배선이 2곳(startLoop · onVisibility visible)이 아니다');
  if ((store.match(/void playtimePause\(\)/g) || []).length < 2)
    f('★playtimePause 배선이 2곳(visibilitychange hidden · pagehide)이 아니다 — 백그라운드 시간이 «세어진다»');
  if (!/const PLAY_KEY = 'ml\.promo\.playtime';/.test(prom)) f('promotion.ts 에 누적 키 ml.promo.playtime 이 없다');
  if (!/equity1m: 'ml\.promo\.equity1m'/.test(prom) || !/play1h: 'ml\.promo\.play1h'/.test(prom)) f('promotion.ts 지급 기록 키에 신설 2종이 없다');
  /* ── ★★기준선 게이트 배선 (2026-09-01 President) ────────────────────────── */
  if ((store.match(/claimPromoOnTransition\('equity1m', equityReached\(eq\)\)/g) || []).length < 2)
    f('★equity1m 이 «전이» 경로(claimPromoOnTransition)를 2곳(매 틱·부팅)에서 안 쓴다 — 개설 전 이미 달성한 기기에 지급이 나간다');
  if (!/if \(promoIneligible\('equity1m'\)\) return null;/.test(store)) f('★equity1m 의 영구 미지급 문(promoIneligible)이 없다');
  if (!/promoBaselined\('equity1m'\)/.test(store)) f('equity1m 매 틱 값싼 문(promoBaselined)이 없다');
  if (/maybeClaimPromo\('equity1m'/.test(store)) f('★equity1m 이 기준선 «없는» 옛 경로(maybeClaimPromo)를 쓴다');
  if (!/void claimer\.claimOnDelta\('play1h', next\.totalMs, playReached\);/.test(prom))
    f('★play1h 가 «기준선 이후분» 경로(claimOnDelta)를 안 쓴다 — 과거 누적이 이월된다');
  if (!/await claimer\.claimOnDelta\('play1h', st\.totalMs, playReached\);/.test(prom))
    f('★play1h 기준선을 «누적 전»(loadPlay)에 안 박는다 — 첫 비트분이 기준선에 먹힌다');
  if (/maybeClaim\('play1h'/.test(prom)) f('★play1h 가 기준선 «없는» 옛 경로(maybeClaim)를 쓴다');
  /* ⛔기존 «라이브» 3종에는 기준선 경로를 붙이지 않는다 — 실제 지급 중이라 무접촉이 지시다 */
  for (const id of ['streak3', 'hold10', 'cash100k']) {
    if (new RegExp(`claim(Promo)?On(Transition|Delta)\\('${id}'`).test(store + prom)) f(`⛔기존 라이브 훅 ${id} 에 기준선 경로가 붙었다 — 무접촉이어야 한다`);
  }
  /* ⛔옛 프로모션 키는 «그냥 둔다» — 읽지도 지우지도 않는다(08-29 해오름·미리 실결함의 반대 방향 사고 방지) */
  /* ★주석의 언급은 «코드가 아니다» — 실제 호출만 본다(getItem/removeItem/setItem 인자) */
  if (/(get|set|remove)Item\(\s*'ml\.promo\.top100'/.test(prom) || /removeItem\(\s*'ml\.promo/.test(prom))
    f('옛 프로모션 키를 읽거나 지우는 코드가 있다 — 옛 키는 «그냥 둔다»');
  for (const n of ['playtimeResume', 'playtimeBeat', 'playtimePause', 'claimPromoOnTransition', 'promoIneligible']) {
    if (!new RegExp(`\\b${n}\\b`).test(idx)) f(`toss/index.ts 재수출에 ${n} 이 없다(재수출 배럴 누락 = 「0건」 사고의 단골)`);
  }
  /* ★기존 라이브 3종의 «코드»가 바뀌지 않았는지 — 실제 지급이 나가는 프로모션이다(회귀 = 실사고) */
  const CODES_EXPECT = {
    streak3: '__PROMOTION_CODE__',
    hold10: '__PROMOTION_CODE__',
    cash100k: '__PROMOTION_CODE__',
    equity1m: '__PROMOTION_CODE__',
    play1h: '__PROMOTION_CODE__',
  };
  for (const [id, code] of Object.entries(CODES_EXPECT)) {
    const mm = html.match(new RegExp(`data-promo-${id}-code="(?:TEST_)?([^"]*)"`));
    if (!mm || mm[1] !== code) f(`index.html data-promo-${id}-code 가 ${code} 가 아니다: ${mm ? mm[1] : '없음'}`);
  }
  const HOOKS = ['streak3', 'hold10', 'cash100k', 'equity1m', 'play1h'];
  for (const id of HOOKS) {
    const m = html.match(new RegExp(`data-promo-${id}-code="([^"]*)"`));
    if (!m || !m[1]) f(`index.html 에 data-promo-${id}-code 가 없다`);
    const a = html.match(new RegExp(`data-promo-${id}-amount="(\\d+)"`));
    if (!a) f(`index.html 에 data-promo-${id}-amount 가 없다`);
  }
  const amounts = HOOKS.map((id) => (html.match(new RegExp(`data-promo-${id}-amount="(\\d+)"`)) || [])[1]);
  if (amounts.join(',') !== '10,10,100,200,200') f(`index.html 금액이 10,10,100,200,200 이 아니다: ${amounts.join(',')}`);
  if (/data-promo-code=/.test(html)) f('index.html 에 옛 data-promo-code 속성이 남아 있다');
  if (!/PROMO_RULE_TAG/.test(prom)) f('promotion.ts 가 PROMO_RULE_TAG 를 참조하지 않는다(번들 표식 유실)');
  /* ── ★★TESTONLY 기준선 우회 스위치의 «반쪽 적용» 방지 (2026-09-01) ─────────────────────
     상수만 들어가고 분기가 빠지면(또는 그 반대) 조용히 아무 일도 안 일어난다 = 이번 사고의 재발.
     ⇒ 「둘 다 있거나 둘 다 없거나」만 허용한다. 정본이면 둘 다 0 이어야 한다. */
  const core = read('src/toss/promoCore.ts');
  const hasFlag = /export const PROMO_IGNORE_BASELINE = true;/.test(core);
  const hasBypass = /if \(PROMO_IGNORE_BASELINE && id === 'equity1m'\)/.test(core);
  const hasMark = /ml-promo-testonly:ignore-baseline=1/.test(core);
  if (hasFlag !== hasBypass || hasFlag !== hasMark)
    f(`★TESTONLY 기준선 우회가 «반쪽»이다(상수=${hasFlag} 분기=${hasBypass} 표식=${hasMark}) — promo_testonly_patch.mjs 를 확인하라`);
  /* ⛔정본에는 스위치가 «한 글자도» 없어야 한다. 새면 기존 유저 전원에게 200원이 나간다(예산 즉시 소진) */
  if (!IGNORE_BASE && hasFlag) f('⛔정본 소스에 TESTONLY 기준선 우회 스위치가 남아 있다 — 소급 차단이 죽는다');
  return found;
}

/* ── ⑤ 양성/음성 대조 — 「검사기가 «잡는지»」를 먼저 본다 ────────────────── */
async function selftest() {
  const fails = [];
  // (a) 세션 락을 «뺀» 코어 = 새 claimer 를 매번 만들어 락을 무력화한 사본. 검사기(호출 횟수 계수)가 2회를 잡는가
  {
    const { deps, calls } = fakeDeps({ saveFails: true }); // 기록도 못 쓰게 해 «락 없는 세계»를 만든다
    for (const id of ['hold10', 'cash100k']) {
      await C.createPromoClaimer(deps).claim(id);
      await C.createPromoClaimer(deps).claim(id); // 새 인스턴스 = 락 없음
    }
    const per = (id) => calls.filter((x) => x.params.promotionCode === (id === 'hold10' ? 'CODE_HOLD10' : 'CODE_CASH100K')).length;
    if (calls.length !== 4 || per('hold10') !== 2 || per('cash100k') !== 2) fails.push(`양성대조(a) 락 없는 사본이 훅별 2회 호출을 «안» 만들었다: ${calls.length}`);
    else console.log('  [selftest] (a) FIRED: 락 없는 사본 → 브릿지 hold10 2회 · cash100k 2회 (검사기가 셀 수 있음)');
  }
  // (b) 옛 코드를 심은 index.html 사본을 잡는가
  {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    const planted = html.replace('<body', `<body data-promo-code="01M0X18BKA${'64324584DZYWNZJT'}" `);
    const r = testSources({ 'index.html': planted });
    if (!r.some((m) => m.includes('옛 코드'))) fails.push('양성대조(b) 옛 코드를 심었는데 못 잡았다');
    else console.log('  [selftest] (b) FIRED: 옛 코드 심은 사본 →', r.length, '건');
  }
  // (c) store.ts 에 옛 호출을 되살린 사본을 잡는가
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const planted = store.replace('this.checkHoldPromo();', 'this.checkHoldPromo(); void claimReward();');
    const r = testSources({ 'src/store/store.ts': planted });
    if (!r.some((m) => m.includes('claimReward('))) fails.push('양성대조(c) 옛 호출을 되살렸는데 못 잡았다');
    else console.log('  [selftest] (c) FIRED: 옛 호출 되살린 사본 →', r.length, '건');
  }
  // (d) 배선을 끊은 사본을 잡는가
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = store.replace('    this.checkHoldPromo();\n', '').replace('    this.checkHoldPromo();\r\n', '');
    const r = testSources({ 'src/store/store.ts': cut });
    if (!r.some((m) => m.includes('checkHoldPromo'))) fails.push('양성대조(d) afterOrder 배선을 끊었는데 못 잡았다');
    else console.log('  [selftest] (d) FIRED: 배선 끊은 사본 →', r.length, '건');
  }
  // (e) 태그와 상수가 어긋난 «가짜 규칙»을 잡는가 — eq 로직 자체의 대조
  {
    const before = errs.length;
    eq('ml-promo-rules:streak=9;hold=9;rank=9', R.PROMO_RULE_TAG, 'selftest-tag'); // 정본·TESTONLY 어느 쪽과도 다른 값
    const fired = errs.length === before + 1;
    errs.length = before;
    if (!fired) fails.push('양성대조(e) 어긋난 태그를 못 잡았다');
    else console.log('  [selftest] (e) FIRED: 어긋난 태그 → 1건');
  }
  // (g) ★반려 코드(「100위 안에 들기」)를 심은 index.html 사본을 잡는가
  {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    const planted = html.replace('<body', `<body data-promo-cash100k-code="01M16CCAN503${'FZZX3JR8MS7SKS'}" `);
    const r = testSources({ 'index.html': planted });
    if (!r.some((m) => m.includes('반려 코드'))) fails.push('양성대조(g) 반려 코드를 심었는데 못 잡았다');
    else console.log('  [selftest] (g) FIRED: 반려 코드 심은 사본 →', r.length, '건');
  }
  // (h) ★문턱만 변조(태그 미변경)한 promoRules.ts 사본을 잡는가 — 소스 수준
  {
    const rules = readFileSync(resolve(ROOT, 'src/lib/promoRules.ts'), 'utf8');
    const m = rules.match(/export const PROMO_CASH_USD = (\d+);/);
    const planted = rules.replace(m[0], `export const PROMO_CASH_USD = ${Number(m[1]) + 7};`);
    const r = testSources({ 'src/lib/promoRules.ts': planted });
    if (!r.some((x) => x.includes('문턱 변조'))) fails.push('양성대조(h) 문턱을 변조했는데 못 잡았다');
    else console.log('  [selftest] (h) FIRED: 문턱 변조 사본 →', r.length, '건');
  }
  // (i) ★boot 의 부팅 1회 배선을 끊은 사본을 잡는가
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = store.replace(/this\.startLoop\(\);(\s*\/\*[\s\S]*?\*\/)?\s*this\.checkCashPromo\(\);/, 'this.startLoop();');
    const r = testSources({ 'src/store/store.ts': cut });
    if (!r.some((x) => x.includes('boot()'))) fails.push('양성대조(i) boot 배선을 끊었는데 못 잡았다');
    else console.log('  [selftest] (i) FIRED: boot 배선 끊은 사본 →', r.length, '건');
  }
  // (j) ★코드를 «안 보던» 옛 판정 사본이면 잡히는가 — loadRecord 가 code 를 현재 코드로 «덮어» 돌려주는 shim
  //     = 「grantedAt 만 보고 already」였던 수정 전 로직과 동치. 본검사 「코드 A 기록 + 코드 B → granted/1회」가 이걸 잡는다.
  {
    const { deps, calls, store } = fakeDeps({ cfg: { hold10: { code: 'CODE_B', amount: 10 } } });
    store.set('hold10', { grantedAt: 1, code: 'CODE_A' });
    const oldLogic = { ...deps, loadRecord: async (id) => ({ ...(store.get(id) ?? {}), code: deps.readConfig(id).code }) };
    const out = await C.createPromoClaimer(oldLogic).claim('hold10');
    if (out === 'already' && calls.length === 0) console.log('  [selftest] (j) FIRED: 코드 무관 옛 판정 사본 → already/0회 (본검사 기대값 granted/1회와 «다르다» → 잡힌다)');
    else fails.push(`양성대조(j) 옛 판정 사본이 본검사와 구분되지 않는다: ${out}/${calls.length}`);
  }
  // (k) ★매 틱 총자산 판정(syncFromWorld)을 끊은 사본을 잡는가 — 「주문 없이 가격만으로 도달」 경로가 죽는다
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = store.replace('    if (!this.booting) this.checkEquityPromo();\n', '');
    const r = testSources({ 'src/store/store.ts': cut });
    if (!r.some((x) => x.includes('매 틱'))) fails.push('양성대조(k) 매 틱 총자산 판정을 끊었는데 못 잡았다');
    else console.log('  [selftest] (k) FIRED: 매 틱 총자산 판정 끊은 사본 →', r.length, '건');
  }
  // (l) ★백그라운드 정지(playtimePause)를 «한 곳» 뗀 사본을 잡는가 — 안 논 시간이 세어진다
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = store.replace('    /* ★[play1h] 앱 종료 경로에서도 시계를 끊고 저장한다 */\n    void playtimePause();\n', '');
    const r = testSources({ 'src/store/store.ts': cut });
    if (!r.some((x) => x.includes('playtimePause'))) fails.push('양성대조(l) playtimePause 를 뗐는데 못 잡았다');
    else console.log('  [selftest] (l) FIRED: playtimePause 뗀 사본 →', r.length, '건');
  }
  // (m) ★플레이 비트 타이머를 지운 사본을 잡는가 — 시간이 영영 안 쌓인다(조용한 0건)
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = store.replace(
      'if (!this.playTimer) this.playTimer = window.setInterval(() => void playtimeBeat(), PROMO_PLAY_BEAT_MS);',
      'this.playTimer = null;'
    );
    const r = testSources({ 'src/store/store.ts': cut });
    if (!r.some((x) => x.includes('비트 타이머'))) fails.push('양성대조(m) 비트 타이머를 지웠는데 못 잡았다');
    else console.log('  [selftest] (m) FIRED: 비트 타이머 지운 사본 →', r.length, '건');
  }
  // (n) ★기존 «라이브» 코드를 바꾼 사본을 잡는가 — 실제 지급이 나가는 3종의 회귀 방지
  {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    /* ⚠TESTONLY 소스에서는 값이 TEST_ 접두라 «전문 하드코딩»으로는 아무것도 안 심긴다 = 죽은 양성대조.
       ⇒ 지금 값을 «읽어서» 마지막 글자만 바꾼다(정본·TESTONLY 양쪽에서 산다). [2026-09-01] */
    const cur = (html.match(/data-promo-cash100k-code="([^"]*)"/) || [])[1];
    if (!cur) fails.push('양성대조(n) index.html 에서 cash100k 코드를 못 읽었다');
    const planted = html.replace(`data-promo-cash100k-code="${cur}"`, `data-promo-cash100k-code="${cur.slice(0, -1)}B"`);
    if (planted === html) fails.push('양성대조(n) 코드 변조를 심지 못했다(치환 0건)');
    const r = testSources({ 'index.html': planted });
    if (!r.some((x) => x.includes('data-promo-cash100k-code'))) fails.push('양성대조(n) 라이브 코드를 바꿨는데 못 잡았다');
    else console.log('  [selftest] (n) FIRED: 라이브 코드 변조 사본 →', r.length, '건');
  }
  // (o) ★재수출 배럴에서 플레이 함수를 뺀 사본을 잡는가
  {
    const idx = readFileSync(resolve(ROOT, 'src/toss/index.ts'), 'utf8');
    /* ★index.ts 는 CRLF — 개행을 «가정하지 않는다»(LF 로 짜르면 양성대조가 조용히 죽는다) */
    const cut = idx.replace(/[ \t]*playtimeBeat,\r?\n/, '');
    const r = testSources({ 'src/toss/index.ts': cut });
    if (!r.some((x) => x.includes('playtimeBeat'))) fails.push('양성대조(o) 재수출 배럴에서 playtimeBeat 을 뺐는데 못 잡았다');
    else console.log('  [selftest] (o) FIRED: 재수출 배럴 누락 사본 →', r.length, '건');
  }
  // (p) ★★기준선 «없는» 옛 경로로 되돌린 사본을 잡는가 — 이미 부자였던 기기에 지급이 나간다
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const planted = store.replace(/claimPromoOnTransition\('equity1m', equityReached\(eq\)\)/g, "maybeClaimPromo('equity1m', true)");
    const r = testSources({ 'src/store/store.ts': planted });
    if (!r.some((x) => x.includes('전이'))) fails.push('양성대조(p) 기준선 없는 옛 경로를 심었는데 못 잡았다');
    else console.log('  [selftest] (p) FIRED: 기준선 없는 총자산 경로 →', r.length, '건');
  }
  // (q) ★★play1h 기준선 프라이밍(loadPlay)을 뗀 사본을 잡는가 — 과거 누적 이월 위험
  {
    const prom = readFileSync(resolve(ROOT, 'src/toss/promotion.ts'), 'utf8');
    const cut = prom.replace("    await claimer.claimOnDelta('play1h', st.totalMs, playReached);\r\n", '').replace("    await claimer.claimOnDelta('play1h', st.totalMs, playReached);\n", '');
    const r = testSources({ 'src/toss/promotion.ts': cut });
    if (!r.some((x) => x.includes('누적 전'))) fails.push('양성대조(q) loadPlay 기준선 프라이밍을 뗐는데 못 잡았다');
    else console.log('  [selftest] (q) FIRED: loadPlay 기준선 프라이밍 뗀 사본 →', r.length, '건');
  }
  // (r) ★★기준선 «자체»가 죽었을 때 잡히는가 — 기준선을 무시하는 사본(had 를 항상 false 로) 을 «코어에» 태운다
  //     ⛔TESTONLY 소스에서는 기준선을 «의도적으로» 끈 상태라 이 대조가 성립하지 않는다(정본에서만 돈다).
  if (IGNORE_BASE) {
    console.log('  [selftest] (r) SKIP — TESTONLY 소스(기준선 우회 ON). 정본 revert 후 다시 돌려라');
  } else {
    const { deps, calls } = fakeDeps();
    /* 저장을 항상 «비어 있게» 돌려주는 shim = 기준선이 매번 새로 박히는 세계(=기준선 무력화) */
    const noBase = { ...deps, loadRecord: async () => ({}) };
    const c = C.createPromoClaimer(noBase);
    const out = await c.claimOnTransition('equity1m', true); // 이미 달성 상태
    if (out === 'ineligible' && calls.length === 0) {
      console.log('  [selftest] (r) FIRED: 기준선 무력화 shim 도 첫 판정은 막힌다(정상) — 본검사 (가)의 «재부팅» 항이 이 사본을 잡는다');
    } else fails.push(`양성대조(r) 기준선 무력화 사본이 첫 판정에서 막히지 않았다: ${out}/${calls.length}`);
    /* ★재부팅 = 새 claimer. 저장이 비어 있으니 기준선이 다시 had=true 로 박혀 여전히 0회여야 한다 */
    const c2 = C.createPromoClaimer(noBase);
    const out2 = await c2.claimOnTransition('equity1m', true);
    if (out2 !== 'ineligible' || calls.length !== 0) fails.push(`양성대조(r) 재부팅 후 지급이 나갔다: ${out2}/${calls.length}`);
  }
  // (s) ★★부팅 기준선 확정을 출석 지급 «뒤»로 옮긴 사본을 잡는가 — 출석 보상이 기준선을 밀어 올린다
  {
    const store = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const A = '    await this.settleEquityBaseline();\n';
    const B = '    this.claimAttendance();\n';
    const swapped = store.replace(A, '@@BASE@@').replace(B, B + A).replace('@@BASE@@', ''); // ★기준선을 출석 «뒤»로 옮긴다
    const r = testSources({ 'src/store/store.ts': swapped });
    if (!r.some((x) => x.includes('출석 보상이 기준선을'))) fails.push('양성대조(s) 기준선/출석 순서를 뒤집었는데 못 잡았다');
    else console.log('  [selftest] (s) FIRED: 기준선을 출석 뒤로 옮긴 사본 →', r.length, '건');
  }
  // (f) 음성대조 — 정상 소스는 0건
  {
    const r = testSources();
    if (r.length) fails.push(`음성대조(f) 정상 소스에서 오탐 ${r.length}건: ${r.join(' | ')}`);
    else console.log('  [selftest] (f) 음성대조 0건 (오탐 없음)');
  }
  return fails;
}

if (SELFTEST) {
  const fails = await selftest();
  if (fails.length) {
    console.error('SELFTEST FAIL');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`SELFTEST PASS (양성 ${IGNORE_BASE ? '16 FIRED · (r) SKIP' : '17 FIRED'} · 음성 0)`);
  process.exit(0);
}

testRules();
await testCore();
await testCodeRotation();
await testStreakScenario();
await testCashScenario();
await testBaseline();
await testEquityScenario();
await testPlayScenario();
for (const m of testSources()) push('SRC: ' + m);

if (errs.length) {
  console.error(`check_promo_hooks FAIL (${errs.length})`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  `check_promo_hooks PASS — rules(streak=${R.PROMO_STREAK_DAYS} hold=${R.PROMO_HOLD_TICKERS} cash=${R.PROMO_CASH_USD} equity=${R.PROMO_EQUITY_USD} play=${R.PROMO_PLAY_MS}) ` +
    `core(lock/record/bridge) baseline-gate(이미달성 0회 / 새달성 1회 · 총자산·플레이) streak/cash/equity/play-scenario src-wiring`
);
