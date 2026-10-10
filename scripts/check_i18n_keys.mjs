#!/usr/bin/env node
/**
 * i18n 정합성 검사 — 미번역 키 노출 0건 보증 장치 (2/2, 빌드 전 검사).
 * 런타임 쪽 장치는 src/i18n/index.ts 의 dev 전용 missingKeyHandler 다.
 *
 *   node scripts/check_i18n_keys.mjs      (= npm run check:i18n)
 *
 * 검사 항목
 *  1) 키 집합 일치      : ko / en 의 키가 완전히 같아야 한다.
 *                        단, CLDR 복수형 접미사(_one/_other/...)는 언어마다 다르므로
 *                        "베이스 키"로 묶어 비교한다. 한국어는 Intl.PluralRules('ko')
 *                        카테고리가 ["other"] 하나뿐이라 _one 변형이 없는 게 정상이다.
 *  2) 복수형 카테고리   : 각 언어가 자기 CLDR 카테고리를 정확히 갖췄는지.
 *  3) 보간 변수 동기화  : {{var}} 집합이 언어 간 같아야 한다. 다르면 한쪽 화면에서
 *                        변수가 빈 문자열로 사라진다(i18next 는 값 없는 보간을 ''로 지운다).
 *  4) 레버리지 티어     : 문자열에 박힌 배율이 lib/constants.ts 의 ALLOWED_LEVERAGE 와
 *                        어긋나면 실패. "2배·3배·5배" 같은 stale 카피 재발 방지.
 *  5) HTML 태그 대칭    : <b> 등 인라인 태그 불일치는 경고(치명 아님).
 *
 * 종료 코드: 0 = 통과, 1 = 실패. 네트워크·설치 불필요(순수 node).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LOCALES = resolve(ROOT, 'src/locales');
const CONSTANTS = resolve(ROOT, 'src/lib/constants.ts');

const LANGS = ['ko', 'en'];
/** i18next 가 쓰는 CLDR 복수형 접미사 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const errors = [];
const warnings = [];

// ── 로드 ────────────────────────────────────────────────────────────────
const raw = {};
for (const lng of LANGS) {
  const p = resolve(LOCALES, `${lng}.json`);
  try {
    raw[lng] = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`FAIL  ${lng}.json 을 읽을 수 없습니다: ${e.message}`);
    process.exit(1);
  }
}

/** 중첩 객체 -> { 'ns.a.b': '값' } */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const flat = Object.fromEntries(LANGS.map((l) => [l, flatten(raw[l])]));

/** 'common.shares_one' -> { base:'common.shares', cat:'one' } */
function splitPlural(key) {
  const i = key.lastIndexOf('_');
  if (i > 0) {
    const cat = key.slice(i + 1);
    if (PLURAL_SUFFIXES.includes(cat)) return { base: key.slice(0, i), cat };
  }
  return { base: key, cat: null };
}

/** 언어별 { base -> Set(cat|null) } */
const bases = {};
for (const lng of LANGS) {
  const m = new Map();
  for (const key of Object.keys(flat[lng])) {
    const { base, cat } = splitPlural(key);
    if (!m.has(base)) m.set(base, new Set());
    m.get(base).add(cat);
  }
  bases[lng] = m;
}

// ── 1) 키 집합 일치 (복수형은 베이스로 묶어 비교) ───────────────────────
const [A, B] = LANGS;
const onlyA = [...bases[A].keys()].filter((k) => !bases[B].has(k)).sort();
const onlyB = [...bases[B].keys()].filter((k) => !bases[A].has(k)).sort();
for (const k of onlyA) errors.push(`[키 누락] ${B}.json 에 없음: ${k}`);
for (const k of onlyB) errors.push(`[키 누락] ${A}.json 에 없음: ${k}`);

// ── 2) 복수형 카테고리가 언어별 CLDR 규칙과 맞는지 ──────────────────────
const cldr = Object.fromEntries(
  LANGS.map((l) => [l, new Set(new Intl.PluralRules(l).resolvedOptions().pluralCategories)])
);
for (const lng of LANGS) {
  for (const [base, cats] of bases[lng]) {
    if (cats.has(null)) {
      if (cats.size > 1) errors.push(`[복수형] ${lng}.json ${base}: 단수형 키와 _${[...cats].filter(Boolean).join('/_')} 변형이 섞여 있음`);
      continue; // 복수형이 아닌 평범한 키
    }
    const want = cldr[lng];
    const missing = [...want].filter((c) => !cats.has(c));
    const extra = [...cats].filter((c) => !want.has(c));
    if (missing.length) errors.push(`[복수형] ${lng}.json ${base}: CLDR 카테고리 누락 _${missing.join(', _')}`);
    if (extra.length) {
      warnings.push(
        `[복수형] ${lng}.json ${base}: 이 언어에 없는 카테고리 _${extra.join(', _')} ` +
          `(허용 = ${[...want].map((c) => '_' + c).join(', ')})`
      );
    }
  }
}

// ── 3) 보간 변수 동기화 ─────────────────────────────────────────────────
const VAR_RE = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g;
function varsOf(text) {
  const set = new Set();
  for (const m of text.matchAll(VAR_RE)) set.add(m[1]);
  return set;
}
/** 베이스 키 단위로 모든 복수형 변형의 변수를 합집합 */
function varsForBase(lng, base) {
  const set = new Set();
  for (const cat of bases[lng].get(base) ?? []) {
    const key = cat === null ? base : `${base}_${cat}`;
    for (const v of varsOf(flat[lng][key] ?? '')) set.add(v);
  }
  return set;
}
for (const base of bases[A].keys()) {
  if (!bases[B].has(base)) continue;
  const va = varsForBase(A, base);
  const vb = varsForBase(B, base);
  const missB = [...va].filter((v) => !vb.has(v));
  const missA = [...vb].filter((v) => !va.has(v));
  if (missB.length) errors.push(`[보간 변수] ${base}: ${B}.json 에 {{${missB.join('}} {{')}}} 없음 (${A} 에는 있음)`);
  if (missA.length) errors.push(`[보간 변수] ${base}: ${A}.json 에 {{${missA.join('}} {{')}}} 없음 (${B} 에는 있음)`);
}

// ── 4) 레버리지 티어 표기가 ALLOWED_LEVERAGE 와 일치하는지 ──────────────
let allowedTiers = null;
try {
  const src = readFileSync(CONSTANTS, 'utf8');
  const m = src.match(/export const ALLOWED_LEVERAGE\s*=\s*\[([^\]]+)\]/);
  if (m) allowedTiers = new Set(m[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite));
} catch {
  /* constants.ts 를 못 읽으면 이 항목만 건너뛴다 */
}
if (allowedTiers && allowedTiers.size) {
  /*
   * ko: "5배" / en: "5x" — 목업 i18n 규칙(mockup_settings_language.html:400).
   * ko 는 "2·5·10·20배" 처럼 가운뎃점으로 묶인 형태를 쓰므로 "배" 앞의 숫자 나열을
   * 통째로 잡아 하나씩 검사한다. (\d+배 만 보면 stale 카피 "2·3·5배로 걸기" 의
   * 3 을 놓친다 — 실제로 놓쳤다.)
   */
  const TIER_RE = { ko: /((?:\d+\s*[·・,]\s*)*\d+)\s*배/g, en: /((?:\d+x\s*[·・,]\s*)*\d+)x\b/g };
  const SPLIT_RE = /[·・,]/;
  /**
   * 배율이 아닌 "배수"라서 제외하는 키.
   *
   * ★[2026-08-21] derivatives.feeNote 면제를 ★«지웠다». 지금 값은
   *   "레버리지는 열 때와 닫을 때 양쪽에 수수료가 붙고..." 로 배수 문장이 «없다»
   *   (수수료가 5/5/5bp 로 같아져 "현물보다 3배" 자체가 사실이 아니게 됐다).
   * ★★필요 없어진 면제를 남겨 두면 그 키에 «다음 오류»가 들어와도 조용히 통과한다.
   *   면제는 «지금 필요한 것»만 남긴다. 지금은 0건이다.
   * 새로 추가할 땐 반드시 이유와 «해제 조건»을 같이 적어라. 그냥 늘리면 검사가 무력해진다.
   */
  const TIER_EXEMPT = new Set();
  for (const lng of LANGS) {
    const re = TIER_RE[lng];
    if (!re) continue;
    for (const [key, val] of Object.entries(flat[lng])) {
      if (TIER_EXEMPT.has(splitPlural(key).base)) continue;
      for (const m of val.matchAll(re)) {
        for (const part of m[1].split(SPLIT_RE)) {
          const n = Number(part.replace(/x/g, '').trim());
          if (!Number.isFinite(n) || allowedTiers.has(n)) continue;
          errors.push(
            `[티어] ${lng}.json ${key}: 허용되지 않은 배율 "${part.trim()}" (매치 "${m[0]}") ` +
              `(ALLOWED_LEVERAGE = ${[...allowedTiers].join(', ')}) -> "${val}"`
          );
        }
      }
    }
  }
} else {
  warnings.push('[티어] lib/constants.ts 에서 ALLOWED_LEVERAGE 를 찾지 못해 배율 검사를 건너뜀');
}

// ── 5) HTML 인라인 태그 대칭 (경고) ─────────────────────────────────────
const TAG_RE = /<\s*\/?\s*([a-zA-Z][\w-]*)/g;
function tagsOf(text) {
  const set = new Set();
  for (const m of text.matchAll(TAG_RE)) set.add(m[1].toLowerCase());
  return set;
}
for (const base of bases[A].keys()) {
  if (!bases[B].has(base)) continue;
  const cat = [...bases[A].get(base)][0];
  const key = cat === null ? base : `${base}_${cat}`;
  const catB = [...bases[B].get(base)][0];
  const keyB = catB === null ? base : `${base}_${catB}`;
  const ta = tagsOf(flat[A][key] ?? '');
  const tb = tagsOf(flat[B][keyB] ?? '');
  const diff = [...new Set([...ta, ...tb])].filter((x) => ta.has(x) !== tb.has(x));
  if (diff.length) warnings.push(`[태그] ${base}: <${diff.join('>, <')}> 가 한쪽에만 있음`);
}

// ── 리포트 ──────────────────────────────────────────────────────────────
const counts = Object.fromEntries(LANGS.map((l) => [l, Object.keys(flat[l]).length]));
console.log('i18n key check');
for (const l of LANGS) console.log(`  ${l}.json : ${counts[l]} keys (${bases[l].size} base keys)`);

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.error(`FAIL  ${e}`);

if (errors.length) {
  console.error(`\nFAILED: ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`\nOK: ${LANGS.join('/')} 키·보간 변수·배율 표기 일치 (warnings: ${warnings.length})`);
