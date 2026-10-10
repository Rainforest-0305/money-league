#!/usr/bin/env node
/**
 * ★출석 «규칙»을 숫자로 검사한다 — 실제 `src/lib/attendance.ts` 를 «불러서».
 *
 *   node scripts/check_attendance.mjs
 *   node scripts/check_attendance.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★왜 필요한가
 *   출석은 «날짜 산술»이다. 그리고 날짜 산술은 ★에러를 내지 않고 «조용히» 틀린다:
 *     8일차에 배열 인덱스를 벗어나 `undefined` → NaN 이 잔고로 간다
 *     하루 유예가 «증가»로 새면 이틀에 한 번씩 와도 streak 이 오른다
 *     시계를 되돌린 상태에서 지급되면 streak 조작이 열린다
 *   ⇒ 화면으로는 못 잡는다. 「7일 연속으로 눌러 보기」를 사람이 매번 할 수 없다.
 *
 * ⛔규칙을 이 파일에 «다시 구현하지» 않는다 — 실제 모듈을 import 한다.
 *   (`check_chart_windows.mjs` 가 규칙 복제로 지적받은 그 교훈)
 *   `attendance.ts` 는 JSX 가 없어 Node 타입 스트리핑으로 «그대로» 읽힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★이 검사기가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
 *   1. ⛔**지급이 «실제로» 일어났는지는 안 본다.** 규칙 함수의 산술만 본다.
 *      엔진이 `grantBonusCash` 를 안 부르면 여기선 0건이다 ⇒ `verify_attendance.py` 몫.
 *   2. ⛔**저장·복원은 안 본다.** `ml.attendance` 가 안 써져도 여기선 통과한다.
 *   3. ⛔**화면 표시는 안 본다.** 「출석 3일차」가 4일차로 찍혀도 모른다.
 *   4. ⛔**기기 시계를 «앞으로» 돌리는 것은 «막지 않는다»**(서버가 없어 불가). 뒤로만 막는다.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/* TS 소스를 그대로 부르기 위한 확장자 해석 훅 (check_strikes.mjs 와 같은 패턴) */
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

const A = await import(pathToFileURL(resolve(ROOT, 'src/lib/attendance.ts')).href);
const D = await import(pathToFileURL(resolve(ROOT, 'src/lib/daykey.ts')).href);

/** 기존 리워드 상수 — ★밸런스 비교의 «기준»이다. 소스에서 읽는다 */
const C = await import(pathToFileURL(resolve(ROOT, 'src/lib/constants.ts')).href);

const key = (d) => {
  /* 2026-01-01 부터 d 일 뒤의 KST 날짜키 */
  const base = Date.parse('2026-01-01T00:00:00Z') + 9 * 3600 * 1000;
  return D.kstDateKey(base + d * 86400000);
};

function run(dec = A.decideAttendance) {
  const errs = [];
  const push = (m) => errs.push(m);

  /* ① 곡선 — 7칸이 «증가»하고 마지막이 크게 튄다 */
  const R = A.ATTENDANCE_REWARDS;
  for (let i = 1; i < R.length; i++) {
    if (R[i] <= R[i - 1]) push(`곡선이 ${i + 1}일차에서 안 오른다: ${R[i - 1]} → ${R[i]}`);
  }
  if (R[R.length - 1] < R[R.length - 2] * 2) {
    push(`마지막 칸 점프가 2배 미만이다(${R[R.length - 2]} → ${R[R.length - 1]}) — 「여기까지 왔는데」가 안 만들어진다`);
  }

  /* ② ★밸런스 — 기존 리워드를 «죽이지 않는다» */
  const adDay = C.TOPUP_AMOUNT * C.TOPUP_AD_BONUS_MAX;                 // 광고 하루 최대
  const shareDay = C.SHARE_REWARD_MAX_USD * C.SHARE_REWARD_DAILY_MAX;  // 공유 하루 최대
  const perDay = A.ATTENDANCE_CYCLE_TOTAL / A.ATTENDANCE_CYCLE_DAYS;
  if (perDay >= adDay) push(`출석 일평균(${perDay})이 광고 하루 최대(${adDay}) 이상이다 — 광고를 죽인다`);
  if (A.ATTENDANCE_CYCLE_TOTAL >= shareDay) {
    push(`출석 «7일 누적»(${A.ATTENDANCE_CYCLE_TOTAL})이 공유 «하루» 최대(${shareDay}) 이상이다 — 공유를 죽인다`);
  }
  if (R[0] > C.TOPUP_AMOUNT) push(`1일차(${R[0]})가 광고 1회(${C.TOPUP_AMOUNT})보다 크다 — 마찰당 보상이 뒤집힌다`);

  /* ③ 주기 반복 — 8일차가 undefined/NaN 이 아니다 */
  for (const s of [1, 7, 8, 14, 15, 100, 1000]) {
    const v = A.rewardForStreak(s);
    if (!Number.isFinite(v) || v <= 0) push(`rewardForStreak(${s}) = ${v}`);
  }
  if (A.rewardForStreak(8) !== R[0]) push('8일차가 주기 1번째와 다르다');
  if (A.rewardForStreak(14) !== R[6]) push('14일차가 주기 7번째와 다르다');

  /* ④ ★멱등 — 같은 날 여러 번 불러도 한 번만 */
  const today = key(10);
  const first = dec(3, key(9), today);
  if (!first.claimable) push('어제 받았으면 오늘은 받을 수 있어야 한다');
  const again = dec(first.streak, today, today);
  if (again.claimable) push('★같은 날 두 번째 호출이 지급 가능하다 — 멱등이 깨졌다');
  if (again.reason !== 'already') push(`같은 날 재호출 reason=${again.reason}`);

  /* ⑤ ★streak 규칙 — 어제 / 그제 / 그 이상 */
  const cont = dec(3, key(9), key(10));
  if (cont.streak !== 4 || cont.reason !== 'continued') push(`어제→오늘: streak ${cont.streak} reason ${cont.reason}`);
  const grace = dec(7, key(8), key(10));
  if (grace.streak !== 7 || grace.reason !== 'grace') push(`★하루 유예: streak ${grace.streak} reason ${grace.reason} (7 유지여야 한다)`);
  const half = dec(7, key(6), key(10));
  if (half.streak !== 3 || half.reason !== 'halved') push(`★반감: streak ${half.streak} reason ${half.reason} (floor(7/2)=3 이어야 한다)`);
  const half1 = dec(1, key(0), key(10));
  if (half1.streak !== 1) push(`★반감이 1 밑으로 갔다: ${half1.streak}`);

  /* ⑥ ★시계 되돌림 — 저장된 날짜가 «미래»면 지급하지 않는다 */
  const future = dec(5, key(20), key(10));
  if (future.claimable) push('★저장 날짜가 미래인데 지급된다 — streak 조작이 열린다');
  if (future.reason !== 'future') push(`미래 키 reason=${future.reason}`);

  /* ⑦ 깨진 저장값에도 «죽지 않는다» */
  for (const bad of [null, undefined, '', 'zzz', '2026-02-31', '2026-8-2']) {
    const r = dec(3, bad, today);
    if (!r.claimable || r.streak !== 1 || !Number.isFinite(r.amount)) {
      push(`깨진 키(${String(bad)}) 처리 실패: ${JSON.stringify(r)}`);
    }
  }
  for (const bad of [NaN, -5, Infinity, 1e12]) {
    const r = dec(bad, key(9), today);
    if (!Number.isFinite(r.streak) || r.streak < 1 || !Number.isFinite(r.amount)) {
      push(`깨진 streak(${bad}) 처리 실패: ${JSON.stringify(r)}`);
    }
  }

  /* ⑧ ★7일 «연속»으로 돌려 누적이 설계값과 같은가 */
  let streak = 0;
  let last = null;
  let total = 0;
  for (let d = 0; d < A.ATTENDANCE_CYCLE_DAYS; d++) {
    const r = dec(streak, last, key(d));
    if (!r.claimable) { push(`연속 ${d + 1}일차에서 지급이 막혔다`); break; }
    streak = r.streak;
    last = key(d);
    total += r.amount;
  }
  if (total !== A.ATTENDANCE_CYCLE_TOTAL) {
    push(`7일 연속 누적 ${total} ≠ 설계값 ${A.ATTENDANCE_CYCLE_TOTAL}`);
  }
  return { errs, adDay, shareDay, perDay, total };
}

if (SELFTEST) {
  const results = [];
  const base = run();
  results.push(['① 현행 규칙은 «안» 잡힌다 — 음성대조', base.errs.length === 0]);

  /* ★양성대조 — 규칙을 «어긋나게» 넣으면 반드시 잡혀야 한다 */
  const resetRule = (prev, lastKey, todayKey) => {
    const d = D.dayDiff(lastKey || '', todayKey);
    if (!Number.isFinite(d)) return { claimable: true, streak: 1, amount: A.rewardForStreak(1), reason: 'first' };
    if (d === 0) return { claimable: false, streak: prev, amount: 0, reason: 'already' };
    /* ⛔완전 리셋(우리가 «하지 않기로» 한 규칙) */
    const s = d === 1 ? prev + 1 : 1;
    return { claimable: true, streak: s, amount: A.rewardForStreak(s), reason: d === 1 ? 'continued' : 'halved' };
  };
  results.push(['② ★「완전 리셋」 규칙을 넣으면 잡힌다 — 양성대조', run(resetRule).errs.length > 0]);

  const noIdem = (prev, lastKey, todayKey) => {
    const r = A.decideAttendance(prev, lastKey, todayKey);
    return r.reason === 'already' ? { ...r, claimable: true, amount: A.rewardForStreak(prev) } : r;
  };
  results.push(['③ ★멱등을 깨뜨리면 잡힌다 — 양성대조', run(noIdem).errs.length > 0]);

  const noFuture = (prev, lastKey, todayKey) => {
    const r = A.decideAttendance(prev, lastKey, todayKey);
    return r.reason === 'future' ? { ...r, claimable: true, amount: A.rewardForStreak(prev) } : r;
  };
  results.push(['④ ★시계 되돌림 방어를 빼면 잡힌다 — 양성대조', run(noFuture).errs.length > 0]);

  const graceGrows = (prev, lastKey, todayKey) => {
    const r = A.decideAttendance(prev, lastKey, todayKey);
    return r.reason === 'grace' ? { ...r, streak: prev + 1, amount: A.rewardForStreak(prev + 1) } : r;
  };
  results.push(['⑤ ★하루 유예가 «증가»로 새면 잡힌다 — 양성대조', run(graceGrows).errs.length > 0]);

  /* ★밸런스 대조 — 곡선을 키우면 「공유를 죽인다」가 잡혀야 한다 */
  const before = A.ATTENDANCE_REWARDS.slice();
  const bigTotal = before.reduce((a, b) => a + b, 0) * 20;
  results.push(['⑥ ★출석이 공유 하루 최대를 넘으면 «막을 수 있는» 산술이 있다',
                bigTotal >= base.shareDay]);

  console.log('출석 규칙 검사기 — 양성/음성 대조 (★실제 attendance.ts 를 «불러서»)');
  let ok = true;
  for (const r of results) {
    console.log('  ' + (r[1] ? 'CAUGHT' : 'MISSED') + '  ' + r[0]);
    if (!r[1]) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    process.exit(1);
  }
  console.log('\nOK: 대조 ' + results.length + '종 전부 통과 — 검사기가 살아 있다.');
} else {
  const { errs, adDay, shareDay, perDay, total } = run();
  console.log('출석 규칙 검사  ★실제 attendance.ts 를 «불러서»');
  console.log('  곡선: ' + A.ATTENDANCE_REWARDS.map((v) => '$' + v.toLocaleString()).join(' → '));
  console.log('  주기 ' + A.ATTENDANCE_CYCLE_DAYS + '일 · 누적 $' + A.ATTENDANCE_CYCLE_TOTAL.toLocaleString() +
              ' · 일평균 $' + Math.round(perDay).toLocaleString());
  console.log('  ★밸런스 — 광고 하루 최대 $' + adDay.toLocaleString() +
              ' (출석 일평균의 ' + (adDay / perDay).toFixed(1) + '배)');
  console.log('  ★밸런스 — 공유 하루 최대 $' + shareDay.toLocaleString() +
              ' (출석 7일 누적의 ' + (shareDay / total).toFixed(1) + '배)');
  if (errs.length) {
    console.error('\nFAILED: ' + errs.length + '건');
    for (const e of errs) console.error('  -', e);
    process.exit(1);
  }
  console.log('\n  0건');
}
