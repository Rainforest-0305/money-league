#!/usr/bin/env node
/**
 * ★「캔들 이동평균을 그릴 것인가」의 ★정책 정합을 빌드에서 막는다.
 *
 *   node scripts/check_chart_windows.mjs
 *   node scripts/check_chart_windows.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★[2026-08-26 개정] 검사 대상이 바뀌었다 — 「창이 봉 수 안에 드는가」에서
 *    ★「지금 봉 수에서 평균선이 «정보»인가, 그리고 화면이 그 판정과 일치하는가」로.
 * ═══════════════════════════════════════════════════════════════════════
 *   배경: 1봉 = 게임 1일이 되면서 도달 가능한 봉이 ★6개로 «고정»됐다.
 *         그 6봉에서 규칙이 내는 창은 2봉/4봉이고 4봉 평균은 점이 ★3개다.
 *         화면에서는 오른쪽 절반에만 짧게 뚝 떨어진 조각이 그려졌다 — 정보가 아니라 잔해다.
 *   ⇒ President 「너 판단대로 해」 · Partner 확정: ★캔들 모드 이평선을 «뺀다».
 *   ⇒ ⛔라인 모드는 «그대로»다(900틱 전체를 쓰므로 평균이 정상적으로 선다).
 *
 * ★★그래서 이 검사기는 ★«양방향»이다. 한쪽만 보면 둘 다 지워도 통과한다:
 *     A) 캔들에 이평선 «경로가 없다»       (잔해가 되돌아오면 잡는다)
 *     B) ★라인에는 이평선 «경로가 있다»    (양성대조 — 라인까지 지우면 잡는다)
 *
 * ★★그리고 ★«되살릴 시점»을 사람 기억에 안 맡긴다:
 *     C) 지금 도달 가능한 봉 수로 `candleMaWindows` 를 돌려서 `ok` 가 true 가 되면
 *        (= `PRICE_HISTORY_LEN` 이 늘어 봉이 minBarsForMa() 에 닿으면) ★FAIL 로 알린다.
 *        되살리는 법: `StockDetail.tsx` 의 「[2026-08-26 제거] 캔들 이동평균」 블록을
 *        복원하고 `CandleChart` 에 maShort/maLong 을 다시 넘긴다. 범례 분기도 같이.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★규칙을 ⛔«복제하지 않는다». 실제 `candleMaWindows` 를 esbuild 로 묶어 «불러서» 쓴다.
 *   (규칙을 복제한 검사기는 ★자기 복제본이 틀리면 «틀린 답에 도장을 찍는다».)
 *   대조 ④ 가 그 사실을 증명한다: 규칙 «소스»를 고치면 검사 결과가 «바뀐다».
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★★이 검사기가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
 *   1. ⛔**그려진 SVG 는 안 본다.** 여기서 보는 것은 «산술»과 «소스 전달 여부»뿐이다.
 *      `CandleChart` 가 maShort 를 받고도 렌더에서 빠뜨리면 이 검사기는 0건을 낸다.
 *      ⇒ 그 층은 `verify_chart.py`(실렌더 SVG 계수)가 본다. ★둘 중 하나만 돌리고
 *        「검증됐다」고 하지 마라.
 *   2. ⛔**라인 이평선이 «보기 좋은지»는 안 본다.** 창이 서는지만 본다.
 *   3. ⛔**시드·데이터 분포와 무관하다.** 봉 «개수»만 본다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패. 네트워크 불필요(esbuild 는 devDependency).
 */
/* ★esbuild 는 «Node API» 로 부른다.
   ⛔`node_modules/.bin/esbuild.cmd` 를 execFileSync 로 부르면 Node 24 윈도우에서
     EINVAL 로 죽는다(.cmd 는 shell 없이는 못 띄운다). 실제로 그렇게 짜서 한 번 죽었다. */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/* ★산출물은 node_modules 안에 둔다 — 레포를 안 더럽히고, esbuild 의 `react` 해석도 된다 */
const WORK = resolve(ROOT, 'node_modules/.cache/ml-chartwin');

const CHARTS = resolve(ROOT, 'src/components/Charts.tsx');
const CONSTANTS = resolve(ROOT, 'src/lib/constants.ts');
const STOCK = resolve(ROOT, 'src/screens/StockDetail.tsx');

/**
 * ★«진짜 규칙»을 불러온다. `chartsPath` 를 바꿔 주면 그 소스의 규칙을 쓴다(대조 ④ 용).
 * ⛔실패하면 «조용히 건너뛰지» 않는다 — 규칙을 못 부르는 검사기의 0건은 무효다.
 */
async function loadRule(chartsPath, tag) {
  mkdirSync(WORK, { recursive: true });
  const entry = resolve(WORK, 'entry.' + tag + '.ts');
  const out = resolve(WORK, 'out.' + tag + '.mjs');
  const lines = [
    'export { candleMaWindows, minBarsForMa, CANDLE_MA_MIN_BARS, CANDLE_MA_MIN_POINTS } from ' + JSON.stringify(chartsPath) + ';',
    'export { CANDLE_MIN_BARS, CANDLE_UNIT_GAME_DAYS, PRICE_HISTORY_LEN, TICK_MS, TICKS_PER_GAME_DAY, ticksPerCandleDays } from ' + JSON.stringify(CONSTANTS) + ';',
  ];
  writeFileSync(entry, lines.join('\n') + '\n', 'utf8');
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      loader: { '.tsx': 'tsx' },
      outfile: out,
      logLevel: 'error',
      absWorkingDir: ROOT,
    });
  } catch (e) {
    console.error('FAILED: 규칙 번들 실패(' + tag + '). 이 검사기는 규칙을 «불러서» 검사한다 — 못 부르면 무효다.');
    console.error(String(e && e.message ? e.message : e).slice(0, 900));
    process.exit(1);
  }
  return import(pathToFileURL(out).href + '?t=' + Date.now());
}

/**
 * ★화면 소스에서 «이평선을 실제로 넘기는가»를 읽는다.
 *
 * ⛔파일 전체에 대고 `/maShort/` 를 세지 «마라» — 주석에도 그 단어가 있고,
 *   라인 쪽 전달까지 같이 세어져 ★두 모드를 구분 못 한다(그러면 A/B 대조가 죽는다).
 *   ⇒ 각 컴포넌트의 «여는 태그 안»만 잘라서 본다.
 */
function maProps(src, component) {
  const m = src.match(new RegExp('<' + component + '\\b[^>]*?/?>', 's'));
  if (!m) return null; // 컴포넌트 자체가 없다 = 판단 불가(호출부가 FAIL 로 다룬다)
  return { tag: m[0].replace(/\s+/g, ' '), has: /\bmaShort=/.test(m[0]) && /\bmaLong=/.test(m[0]) };
}

/** 화면이 «실제로 도달하는» 캔들 상태 — 캔들 모드는 기간이 «전체» 고정이라 하나뿐이다 */
function reachableBars(M) {
  return Math.floor(M.PRICE_HISTORY_LEN / M.ticksPerCandleDays(M.CANDLE_UNIT_GAME_DAYS[0]));
}

/**
 * 한 번의 검사. `rule` 은 ★실제 `candleMaWindows` 다(대조에서만 대체 규칙이 들어온다).
 * `src` 는 StockDetail 소스(대조에서만 변형본이 들어온다).
 */
function run(M, rule, src) {
  const errs = [];
  const bars = reachableBars(M);
  const w = rule(bars);
  const cand = maProps(src, 'CandleChart');
  const line = maProps(src, 'AreaChart');

  if (!cand) errs.push('StockDetail 에서 <CandleChart> 를 못 찾았다 — 이름이 바뀌었으면 검사기를 고쳐라');
  if (!line) errs.push('StockDetail 에서 <AreaChart> 를 못 찾았다 — 이름이 바뀌었으면 검사기를 고쳐라');

  if (bars < M.CANDLE_MIN_BARS) {
    errs.push('도달 가능 봉이 ' + bars + '개다 — 최소 ' + M.CANDLE_MIN_BARS + '봉 미만이면 캔들이 아니라 막대 몇 개다');
  }

  /* A/C) 정책 정합 — 「그릴 값이 되는가」와 「화면이 그리는가」가 같아야 한다 */
  if (cand) {
    if (!w.ok && cand.has) {
      errs.push(
        '★캔들 이평선이 «되돌아왔다». 지금 ' + bars + '봉에서 창은 ' + w.short + '/' + w.long +
        ' 봉이고 그려지는 점이 ' + Math.max(0, bars - w.long + 1) + '개다(최소 ' + M.CANDLE_MA_MIN_POINTS +
        '개 필요). 정보가 아니라 잔해다 — 빼라'
      );
    }
    if (w.ok && !cand.has) {
      errs.push(
        '★★되살릴 때다. 이제 ' + bars + '봉이라 창 ' + w.short + '/' + w.long + ' 봉에서 점이 ' +
        (bars - w.long + 1) + '개 나온다(최소 ' + M.CANDLE_MA_MIN_POINTS + '개). ' +
        'StockDetail.tsx 의 「[2026-08-26 제거] 캔들 이동평균」 블록을 복원하고 ' +
        'CandleChart 에 maShort/maLong 을 다시 넘겨라(범례 분기도 같이)'
      );
    }
  }

  /* B) ★양성대조축 — 라인에는 «있어야» 한다. 이게 없으면 둘 다 지워도 이 검사기가 통과한다 */
  if (line && !line.has) {
    errs.push('★라인 모드 이평선이 «사라졌다». 라인은 900틱 전체를 쓰므로 평균이 정상적으로 선다 — 지우지 마라');
  }

  return { errs, bars, w, cand, line };
}

const M = await loadRule(CHARTS, 'real');
const RULE = M.candleMaWindows;
const STOCK_SRC = readFileSync(STOCK, 'utf8');

if (SELFTEST) {
  const results = [];
  const base = run(M, RULE, STOCK_SRC);
  results.push(['① 현행 소스는 «안» 잡힌다 — 음성대조', base.errs.length === 0]);

  /* ② ★캔들에 이평선을 «심으면» 잡힌다 — 잔해 복귀 탐지기가 살아 있는가 */
  const injected = STOCK_SRC.replace(
    /<CandleChart\b([^>]*?)\/>/s,
    '<CandleChart$1maShort={x} maLong={y} />'
  );
  results.push([
    '② ★캔들에 이평선을 심으면 잡힌다 — 양성대조',
    injected !== STOCK_SRC && run(M, RULE, injected).errs.some((e) => e.indexOf('되돌아왔다') >= 0),
  ]);

  /* ③ ★★라인에서 이평선을 «빼면» 잡힌다 — ⛔이 대조가 없으면 둘 다 지워도 통과한다 */
  const stripped = STOCK_SRC.replace(
    /<AreaChart\b([^>]*?)\/>/s,
    (mm) => mm.replace(/\s*maShort=\{[^}]*\}/, '').replace(/\s*maLong=\{[^}]*\}/, '')
  );
  results.push([
    '③ ★라인에서 이평선을 빼면 잡힌다 — ★양성대조(한쪽만 보는 검사기가 아님의 증명)',
    stripped !== STOCK_SRC && run(M, RULE, stripped).errs.some((e) => e.indexOf('라인 모드 이평선') >= 0),
  ]);

  /*
   * ④ ★★규칙 «소스»를 망가뜨리면 잡히는가 — 이 검사기가 규칙 «복제본»이 아님의 증명.
   *    최소 점수를 옛 값(3)으로 되돌리면 6봉에서 ok=true 가 되어 ★「되살릴 때다」로 잡혀야 한다.
   *    복제본을 쓰고 있었다면 소스를 고쳐도 결과가 안 변한다(= 이 대조가 MISSED 로 죽는다).
   */
  const orig = readFileSync(CHARTS, 'utf8');
  const NEEDLE_FROM = 'ok: bars - long + 1 >= CANDLE_MA_MIN_POINTS';
  const NEEDLE_TO = 'ok: bars - long + 1 >= 3';
  if (orig.indexOf(NEEDLE_FROM) < 0) {
    console.error('FAILED: 대조 ④ 의 니들을 Charts.tsx 에서 못 찾았다 — 니들이 «안 박히면» 이 대조는 거짓이다.');
    process.exit(1);
  }
  mkdirSync(WORK, { recursive: true });
  const mutPath = resolve(WORK, 'Charts.mutated.tsx');
  const libAbs = resolve(ROOT, 'src/lib').split('\\').join('/');
  writeFileSync(
    mutPath,
    orig.replace(NEEDLE_FROM, NEEDLE_TO).replace(/from '\.\.\/lib\//g, "from '" + libAbs + '/'),
    'utf8'
  );
  const MM = await loadRule(mutPath, 'mutated');
  const mutated = run(MM, MM.candleMaWindows, STOCK_SRC);
  results.push([
    '④ ★규칙 «소스»의 최소 점수를 옛 값(3)으로 되돌리면 「되살릴 때다」로 잡힌다 — 규칙 복제본이 «아님»의 증명',
    mutated.errs.some((e) => e.indexOf('되살릴 때다') >= 0),
  ]);

  /* ⑤ ★★President 확정 스펙: 1봉 = 게임 1일. 여기가 틀리면 라벨이 통째로 거짓말이 된다 */
  results.push([
    '⑤ ★1봉 = 게임 1일 (TICKS_PER_GAME_DAY 와 «같은 틱 수»)',
    M.ticksPerCandleDays(M.CANDLE_UNIT_GAME_DAYS[0]) === M.TICKS_PER_GAME_DAY,
  ]);

  /* ⑥ ★«실제 시간» 봉 단위 표기가 화면으로 되살아나면 잡는다 — 30초/1분/5분 회귀 방지 */
  results.push([
    '⑥ ★화면에 «실제 시간» 봉 단위(unitSec/unitMin/ticksPerCandle)가 없다',
    !/unitSec|unitMin|ticksPerCandle\b/.test(STOCK_SRC),
  ]);

  /* ⑦ ★삭제한 고정 봉수 상수가 되살아나지 않았다 (constants.ts 묘비 참조) */
  results.push([
    '⑦ ★고정 봉수 상수(CANDLE_MA_SHORT/LONG_BARS)가 «코드로» 되살아나지 않았다',
    !/export const CANDLE_MA_(SHORT|LONG)_BARS/.test(readFileSync(CONSTANTS, 'utf8')),
  ]);

  console.log('캔들 이평선 정책 검사기 — 양성/음성 대조 (★실제 규칙을 «불러서» 검사)');
  let ok = true;
  for (const r of results) {
    console.log('  ' + (r[1] ? 'CAUGHT' : 'MISSED') + '  ' + r[0]);
    if (!r[1]) ok = false;
  }
  rmSync(WORK, { recursive: true, force: true });
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    process.exit(1);
  }
  console.log('\nOK: 대조 ' + results.length + '종 전부 통과 — 검사기가 살아 있다.');
} else {
  const res = run(M, RULE, STOCK_SRC);
  const historyGameDays = M.PRICE_HISTORY_LEN / M.TICKS_PER_GAME_DAY;
  console.log('캔들 이평선 정책 검사  ★실제 candleMaWindows 를 «불러서» 검사');
  console.log('  히스토리 ' + M.PRICE_HISTORY_LEN + '틱 · 게임일 ' + M.TICKS_PER_GAME_DAY +
              '틱(= ' + historyGameDays + '일치) · 틱 ' + M.TICK_MS + 'ms');
  console.log('  봉 단위 ' + M.CANDLE_UNIT_GAME_DAYS.join(' / ') + '게임일(= ' +
              M.ticksPerCandleDays(M.CANDLE_UNIT_GAME_DAYS[0]) + '틱) · 최소 봉수 ' + M.CANDLE_MIN_BARS);
  console.log('');
  console.log('  도달 가능 봉 수      : ' + res.bars + '봉  (캔들 모드는 기간 «전체» 고정)');
  console.log('  유도된 창            : 단기 ' + res.w.short + '봉 · 장기 ' + res.w.long + '봉');
  console.log('  그려질 점 개수       : ' + Math.max(0, res.bars - res.w.long + 1) +
              '개  (최소 ' + M.CANDLE_MA_MIN_POINTS + '개 필요 · 평균선은 ' + M.minBarsForMa() + '봉부터)');
  console.log('  ⇒ 정책              : 캔들 이평선 ' + (res.w.ok ? '★그린다' : '★안 그린다'));
  console.log('');
  console.log('  화면 소스 실측');
  console.log('    캔들 <CandleChart> : ' + (res.cand ? (res.cand.has ? '이평선 전달 ★있음' : '이평선 전달 없음') : '못 찾음'));
  console.log('    라인 <AreaChart>   : ' + (res.line ? (res.line.has ? '이평선 전달 ★있음' : '이평선 전달 없음') : '못 찾음'));
  rmSync(WORK, { recursive: true, force: true });
  if (res.errs.length) {
    console.error('\nFAILED: ' + res.errs.length + '건');
    for (const e of res.errs) console.error('  -', e);
    process.exit(1);
  }
  console.log('\n  0건');
}
