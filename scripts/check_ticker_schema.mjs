/**
 * 종목 생성 데이터 <-> TickerMeta 타입 «정합» 검사기.
 *
 *   node scripts/check_ticker_schema.mjs [--selftest]
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★왜 생겼나 (2026-08-22 실사고 — 지우지 마라)
 * ══════════════════════════════════════════════════════════════════════════
 * `gen_tickers_1000.mjs` 가 `assetClass`·`exchange` 필드를 뱉었는데
 * `src/data/types.ts` 의 `TickerMeta` 에는 그 필드가 «없었다».
 *   -> `npm run typecheck` 실패 -> `npm run build` 는 `tsc -b && vite build` 라
 *      ★vite build 가 아예 안 돌고 `check:all` 전체가 막혔다.
 *
 * ★근본 원인은 부주의가 아니다. **생성기와 타입이 «두 벌»로 갈라져 있었다.**
 *   생성기는 타입을 «읽지 않고» 필드를 만들었고, 어긋나도 생성 시점엔 아무도 안 죽었다.
 *   종목이 100 -> 1,000 이 된 지금 같은 사고가 또 난다.
 * ⇒ ★그래서 이 검사기는 «기대 필드 목록을 하드코딩하지 않는다».
 *   `types.ts` 에서 «읽어» 만든다. 타입을 고치면 기대값이 «저절로» 따라온다.
 *   (인계문서 U-4: 「주의하라고 적는 것은 대책이 아니다. 구조를 바꾸거나 검사기를 만들어라」)
 *
 * ★그리고 optional 필드의 «생략»은 타입이 못 막는다 — 그건 여기서 막는다.
 *   `REQUIRE_PRESENT` 에 적힌 필드는 optional 이어도 «데이터에는 반드시» 있어야 한다.
 *
 * ⛔정규식을 최소로 쓴다. 이 레포는 이스케이프 사고가 반복됐다(check_position_paths 규약).
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, '..');
const TYPES = resolve(CLIENT, 'src/data/types.ts');
const DATA_FILES = [
  resolve(CLIENT, 'src/data/tickers.generated.ts'),
  resolve(CLIENT, 'src/data/tickers1000.generated.ts'),
];

/**
 * ★optional 이어도 «생성 데이터에는» 반드시 있어야 하는 필드.
 * ⛔여기에 넣을 때는 이유를 적어라. 이유 없는 항목은 다음 사람의 눈만 가린다.
 */
const REQUIRE_PRESENT = {
  assetClass: '지수 구성·배당 대상 판정이 이 값으로 갈린다. 없으면 «말없이» 제외된다',
};

/** types.ts 에서 interface 본문을 문자열 탐색으로 떼어낸다(정규식 없음) */
function sliceBlock(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, k);
    }
  }
  return null;
}

/** 주석을 지운다 — 주석 안의 콜론을 필드로 오인하지 않게 */
function stripComments(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 2;
    } else if (s[i] === '/' && s[i + 1] === '/') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e;
    } else {
      out += s[i++];
    }
  }
  return out;
}

/** interface 본문 -> { name: {optional} } */
function parseFields(body) {
  const fields = {};
  for (const rawLine of stripComments(body).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    let name = line.slice(0, colon).trim();
    let optional = false;
    if (name.endsWith('?')) { optional = true; name = name.slice(0, -1).trim(); }
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    fields[name] = { optional };
  }
  return fields;
}

/** `export type AssetClass = 'a' | 'b';` -> ['a','b'] */
function parseUnion(src, name) {
  const key = `export type ${name} =`;
  const i = src.indexOf(key);
  if (i < 0) return null;
  const end = src.indexOf(';', i);
  const body = src.slice(i + key.length, end < 0 ? undefined : end);
  const vals = [];
  for (const part of body.split('|')) {
    const t = part.trim();
    if (t.length >= 2 && (t[0] === "'" || t[0] === '"')) vals.push(t.slice(1, -1));
  }
  return vals.length ? vals : null;
}

/** 생성 파일에서 행 JSON 을 읽는다 */
function readRows(path) {
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim().replace(/,$/, '');
    if (t.startsWith('{"rank":')) {
      try { rows.push(JSON.parse(t)); } catch { /* 형식 오류는 아래에서 잡힌다 */ }
    }
  }
  return rows;
}

function run(typesSrc, dataFiles) {
  const errs = [];
  const body = sliceBlock(typesSrc, 'interface TickerMeta');
  if (!body) return ['types.ts 에서 interface TickerMeta 를 못 찾았다'];
  const fields = parseFields(body);
  const names = Object.keys(fields);
  if (names.length < 5) return [`TickerMeta 필드 파싱 실패(${names.length}개) — 검사기가 죽었다`];

  const unions = {};
  const ac = parseUnion(typesSrc, 'AssetClass');
  if (ac) unions.assetClass = ac;

  for (const f of dataFiles) {
    if (!existsSync(f)) continue;
    const rows = readRows(f);
    const short = f.split(/[\\/]/).pop();
    if (rows.length === 0) { errs.push(`${short}: 행 0개 — 검사기가 죽었거나 파일이 비었다`); continue; }
    for (const r of rows) {
      const tk = r.ticker ?? '?';
      // ① 타입에 없는 필드를 데이터가 갖고 있으면 typecheck 가 깨진다
      for (const k of Object.keys(r)) {
        if (!(k in fields)) errs.push(`${short} ${tk}: 타입에 없는 필드 '${k}'`);
      }
      // ② 필수 필드 누락
      for (const [k, meta] of Object.entries(fields)) {
        if (meta.optional) continue;
        if (!(k in r)) errs.push(`${short} ${tk}: 필수 필드 '${k}' 누락`);
      }
      // ③ optional 이어도 데이터에는 있어야 하는 것
      for (const k of Object.keys(REQUIRE_PRESENT)) {
        if (!(k in r)) errs.push(`${short} ${tk}: '${k}' 누락 (${REQUIRE_PRESENT[k]})`);
      }
      // ④ 리터럴 유니언 값 검사
      for (const [k, vals] of Object.entries(unions)) {
        if (k in r && !vals.includes(r[k])) {
          errs.push(`${short} ${tk}: ${k}='${r[k]}' 는 유니언(${vals.join('|')}) 밖이다`);
        }
      }
    }
  }
  return errs;
}

// ── 양성대조 ──────────────────────────────────────────────────────────────
function selftest() {
  const typesSrc = readFileSync(TYPES, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'tkschema-'));
  const good = readRows(DATA_FILES[0])[0];
  if (!good) { console.error('[FAIL] 양성대조 준비 실패 — 원본에서 행을 못 읽었다'); process.exit(1); }

  const cases = [
    ['타입에 없는 필드', { ...good, bogusField: 1 }],
    ['필수 필드 누락', (() => { const c = { ...good }; delete c.ticker; return c; })()],
    ['assetClass 누락', (() => { const c = { ...good }; delete c.assetClass; return c; })()],
    ['assetClass 오타', { ...good, assetClass: 'stok' }],
  ];
  let bad = 0;
  for (const [label, row] of cases) {
    const f = join(dir, 'probe.generated.ts');
    writeFileSync(f, 'export const TICKERS = [\n  ' + JSON.stringify(row) + ',\n];\n');
    const errs = run(typesSrc, [f]);
    const caught = errs.length > 0;
    console.log(`  ${caught ? '[OK]  ' : '[FAIL]'} 니들 「${label}」 ${caught ? '잡힘' : '★안 잡힘 — 검사기가 죽었다'}`);
    if (!caught) bad++;
  }
  // 음성대조 — 정상 행은 «안» 잡혀야 한다
  const f = join(dir, 'probe.generated.ts');
  writeFileSync(f, 'export const TICKERS = [\n  ' + JSON.stringify(good) + ',\n];\n');
  const clean = run(typesSrc, [f]);
  const ok = clean.length === 0;
  console.log(`  ${ok ? '[OK]  ' : '[FAIL]'} 음성대조 「정상 행」 ${ok ? '안 잡힘' : '★오탐: ' + clean[0]}`);
  if (!ok) bad++;
  if (bad) { console.error(`\n⛔양성/음성 대조 ${bad}건 실패 — 이 검사기의 결과를 믿지 마라`); process.exit(1); }
  console.log('★대조 5종 통과 — 검사기가 살아 있다\n');
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  console.log('=== check_ticker_schema 자가진단 ===');
  selftest();
  process.exit(0);
}

selftest();
const errs = run(readFileSync(TYPES, 'utf8'), DATA_FILES);
if (errs.length) {
  console.error(`⛔종목 스키마 불일치 ${errs.length}건:`);
  for (const e of errs.slice(0, 30)) console.error('  ' + e);
  if (errs.length > 30) console.error(`  ... 외 ${errs.length - 30}건`);
  process.exit(1);
}
console.log('✓ 생성 데이터가 TickerMeta 와 일치한다 (필드·필수·유니언 전부).');
