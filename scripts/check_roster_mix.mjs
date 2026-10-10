/**
 * 명부 «파생 상수» 정합 검사 — `cohortMix` 가중치 합 == `BOTS_PER_DAY`.
 *
 *   node scripts/check_roster_mix.mjs [--selftest]
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★왜 생겼나 (2026-08-22 · 지우지 마라)
 * ══════════════════════════════════════════════════════════════════════════
 * `BOTS_PER_DAY` 를 77 → 300 으로 바꾸는 작업이었는데,
 * **그 값으로부터 «유도»되는 4번째 상수**가 `cohortMix()` 의 가중치 합이었다.
 * 같이 안 바꾸면 `out.slice(0, BOTS_PER_DAY)` 가 ★**조용히 잘라낸다.**
 *
 * ⛔실제 사고 이력: 합이 79 인데 `slice(0,77)` 로 잘려 `liquidation_hunter` 가
 *   **6 → 4 로 33% 깎였다.** 청산 사냥꾼은 «과열 억제» 역할이라 그 기능도 그만큼 약해졌다.
 *   ★에러가 안 난다. 런타임 `console.error` 는 있지만 «빌드를 막지 못한다».
 *
 * ⇒ ★**「상수를 바꾸면 그 상수로부터 «유도»되는 값을 찾아라」**를 사람 기억이 아니라
 *   여기서 «세게» 한다. 특히 «합»과 «길이»는 `slice`·`padStart`·고정길이 배열에서
 *   **실패해도 예외를 안 던진다.**
 *
 * ⛔정규식을 최소로 쓴다(이 레포 이스케이프 사고 이력 + 규율 M).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROSTER = resolve(HERE, '..', 'src', 'lib', 'engine', 'roster.ts');

/** `export const NAME = 123;` 에서 123 을 문자열 탐색으로 뽑는다 */
function constNum(src, name) {
  const key = 'export const ' + name + ' = ';
  const i = src.indexOf(key);
  if (i < 0) return null;
  let j = i + key.length;
  let out = '';
  while (j < src.length && src[j] !== ';') { out += src[j]; j++; }
  const n = Number(out.trim().replace(/_/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * `const weights: Record<NewConcept, number> = { ... }` 블록의 «숫자 값»을 모은다.
 * ★주석 안의 숫자에 속지 않도록 «중괄호 블록»만 잘라서 본다.
 */
function weightsOf(src) {
  const key = 'const weights: Record<NewConcept, number> = {';
  const i = src.indexOf(key);
  if (i < 0) return null;
  const open = i + key.length - 1;
  let depth = 0;
  let end = -1;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const out = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const val = Number(line.slice(colon + 1).replace(',', '').trim());
    if (!name || !Number.isFinite(val)) continue;
    out[name] = val;
  }
  return out;
}

function run(src) {
  const errs = [];
  const perDay = constNum(src, 'BOTS_PER_DAY');
  const cap = constNum(src, 'BOT_ROSTER_CAP');
  const extra = constNum(src, 'STARTING_EXTRA_BOTS');
  if (perDay === null) errs.push('BOTS_PER_DAY 를 못 읽었다 — 검사기가 죽었다');
  const w = weightsOf(src);
  if (!w || Object.keys(w).length === 0) errs.push('cohortMix weights 를 못 읽었다 — 검사기가 죽었다');
  if (errs.length) return { errs, perDay, cap, extra, w, sum: null };

  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum !== perDay) {
    errs.push(
      '★cohortMix 가중치 합 ' + sum + ' != BOTS_PER_DAY ' + perDay +
      '  -> slice() 가 «조용히» 자르거나 채운다. 뒤쪽 콘셉트가 깎인다'
    );
  }
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isInteger(v) || v < 0) errs.push('가중치 ' + k + ' = ' + v + ' (0 이상 정수여야 한다)');
  }
  /* 상한 정합 — 상한이 「시작 + 하루치 x N일」로 «떨어지는가». 안 떨어지면 마지막 코호트가 잘린다 */
  if (perDay && cap !== null && extra !== null) {
    const start = 210 + extra;
    const room = cap - start;
    if (room < 0) errs.push('BOT_ROSTER_CAP(' + cap + ') 이 시작 총원(' + start + ') 보다 작다');
    else if (room % perDay !== 0) {
      errs.push(
        '⚠️(경고) BOT_ROSTER_CAP − 시작총원 = ' + room + ' 이 BOTS_PER_DAY(' + perDay +
        ') 로 나눠떨어지지 않는다 -> 마지막 코호트가 부분만 들어온다'
      );
    }
  }
  return { errs, perDay, cap, extra, w, sum };
}

// ── 양성대조 ──────────────────────────────────────────────────────────────
function selftest() {
  const src = readFileSync(ROSTER, 'utf8');
  const cases = [
    ['가중치 합 불일치', src.replace('short_seller: 55,', 'short_seller: 54,')],
    ['음수 가중치', src.replace('hodler: 27,', 'hodler: -1,')],
    ['BOTS_PER_DAY 변경만 하고 가중치 방치', src.replace('export const BOTS_PER_DAY = 300;', 'export const BOTS_PER_DAY = 301;')],
  ];
  let bad = 0;
  for (const [label, mutated] of cases) {
    const r = run(mutated);
    const caught = r.errs.length > 0;
    console.log('  ' + (caught ? '[OK]  ' : '[FAIL]') + ' 니들 「' + label + '」 ' + (caught ? '잡힘' : '★안 잡힘 — 검사기가 죽었다'));
    if (!caught) bad++;
  }
  const clean = run(src);
  const ok = clean.errs.length === 0;
  console.log('  ' + (ok ? '[OK]  ' : '[FAIL]') + ' 음성대조 「현재 소스」 ' + (ok ? '안 잡힘' : '★오탐: ' + clean.errs[0]));
  if (!ok) bad++;
  if (bad) { console.error('\n⛔대조 ' + bad + '건 실패 — 이 검사기의 결과를 믿지 마라'); process.exit(1); }
  console.log('★대조 4종 통과 — 검사기가 살아 있다\n');
}

selftest();
const src = readFileSync(ROSTER, 'utf8');
const r = run(src);
if (r.errs.length) {
  console.error('⛔명부 파생상수 불일치 ' + r.errs.length + '건:');
  for (const e of r.errs) console.error('  ' + e);
  process.exit(1);
}
const start = 210 + r.extra;
const days = (r.cap - start) / r.perDay;
console.log(
  '✓ 명부 파생상수 정합: 가중치 합 ' + r.sum + ' == BOTS_PER_DAY ' + r.perDay +
  ' · 시작 ' + start + ' + ' + r.perDay + '/일 x ' + days + '일 = 상한 ' + r.cap
);
