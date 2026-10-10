#!/usr/bin/env node
/**
 * i18n «사용처 ↔ locales» 대조 검사 — 미번역 키 노출 0건 보증 장치 (3/3).
 *
 *   node scripts/check_i18n_usage.mjs            (= npm run check:i18n:usage)
 *   node scripts/check_i18n_usage.mjs --selftest (★양성대조: 검사기가 살아있는지 먼저 증명)
 *   node scripts/check_i18n_usage.mjs --strict   (죽은 키도 FAIL 로 승격)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 이 검사기가 «따로» 필요한가 (2026-08-20, 실제 사고에서 도출)
 *
 *   기존 `check_i18n_keys.mjs` 는 ko ↔ en 을 «대조»한다. 즉 «한쪽에만 있는» 키를 잡는다.
 *   ⇒ ★«양쪽에 똑같이 없으면 통과한다». 이건 죽은 검사기가 아니라
 *     ★«애초에 안 보는 영역»이다 — 더 나쁘다. 0건이 부재의 증거가 되지 못한다.
 *
 *   실사고: `traders.concept.liquidation_hunter` 가 ko/en ★양쪽에 없는 채로
 *   `ROSTER_GROWTH_ENABLED = true` 가 켜졌다. 30게임일차 240명이 랭킹에 뜨는데
 *   배지 글자가 raw 키(`traders.concept.liquidation_hunter.name`)로 새어나갈 상태였다.
 *   check:i18n 은 «OK» 를 뱉고 있었다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★검사 항목
 *
 *   1) ★정방향 — 코드가 쓰는 키가 locales 에 «있는가» (없으면 FAIL)
 *      · `t('key')` · `t('ns:key')` · `t(cond ? 'a' : 'b')` · `i18next.t('key')`
 *      · `<Trans i18nKey="ns:key" />` · `i18nKey={cond ? 'a' : 'b'}`
 *      네임스페이스는 파일의 `useTranslation('ns')` 선언에서 «유도»한다.
 *
 *   2) ★★동적 조립 키 — 정적 추출이 «불가능»한 종류. ⛔못 잡는다고 «없는 셈» 치지 않는다.
 *      예: `t(\`common:${meta.i18nKey}.name\`)` — 값이 런타임에 만들어진다.
 *      ⇒ 아래 DYNAMIC 에 «접두 + 접미» 로 선언하고, ★필요한 «구성원 집합»은
 *        ★엔진 소스(BotStrategy 유니언 · MacroType 유니언)에서 «파싱해 유도»한다.
 *        손으로 적으면 그 목록 자체가 다음 사고의 원인이 된다.
 *
 *   3) ★역방향 — locales 에 있는데 코드가 «안 쓰는» 키(죽은 키). 기본 WARN.
 *      아직 화면이 없는 «예정» 키는 PENDING 에 사유와 함께 선언한다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패. 순수 node, 네트워크·설치 불필요.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'src');
const LOCALES = resolve(SRC, 'locales');

const ARGV = new Set(process.argv.slice(2));
const STRICT = ARGV.has('--strict');
const SELFTEST = ARGV.has('--selftest');

/** i18n/index.ts 의 defaultNS */
const DEFAULT_NS = 'common';
/** i18next CLDR 복수형 접미사 — 'shares_one' 은 'shares' 로 접어서 대조한다 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * ★동적 조립 키 그룹.
 *   `members` 는 ★엔진 소스에서 «유도»한다 — 이 배열을 손으로 채우지 마라.
 */
const DYNAMIC = [
  {
    id: 'traders.concept',
    // roster.ts:  i18nKey: `traders.concept.${b.strategy}`
    // 사용처:      Leaderboard.tsx / TraderProfile.tsx  t(`common:${meta.i18nKey}.name`)
    prefix: 'common.traders.concept',
    suffixes: ['name', 'oneLiner'],
    members: () => unionMembers('src/lib/engine/types.ts', 'BotStrategy'),
    source: 'engine/types.ts  BotStrategy 유니언',
  },
  {
    id: 'macro',
    // macro.ts:  titleKey: `macro.${type}.title` / bodyKey: `macro.${type}.body`
    // 사용처:     홈 시황 카드 · 피드 (defaultNS=common 으로 해석된다)
    prefix: 'common.macro',
    suffixes: ['title', 'body'],
    members: () => unionMembers('src/lib/engine/macro.ts', 'MacroType'),
    source: 'engine/macro.ts  MacroType 유니언',
  },
  {
    id: 'recharge.diagnosis',
    // Recharge.tsx:  <Trans i18nKey={`recharge:${diagnosisKey(s)}`} />
    // ★폴백이 «없다» — diagnosisKey 가 돌려주는 값은 전부 locales 에 있어야 한다.
    prefix: 'recharge',
    suffixes: [''],
    members: () => returnLiterals('src/screens/Recharge.tsx', 'diagnosisKey'),
    source: 'Recharge.tsx  diagnosisKey() 반환 리터럴',
  },
  {
    id: 'err',
    // OrderSheet/LeverageOrder/... :  t([`common:err.${code}`, 'common:err.GENERIC'])
    // ★★soft 인 이유: 호출부가 «배열 폴백»을 쓴다 — 개별 코드가 없어도 GENERIC 으로 떨어진다.
    //   즉 raw 키가 화면에 새지 «않는다». 그래서 누락은 FAIL 이 아니라 WARN 이다.
    //   ⛔단 «안 보는 영역»으로 두지는 않는다 — 전용 문구가 없는 코드를 목록으로 드러낸다.
    prefix: 'common.err',
    suffixes: [''],
    soft: true,
    members: () => gameErrorCodes(),
    source: 'engine/*.ts  new GameError(CODE)',
  },
  {
    id: 'exit',
    // tossBoot.ts 의 지역 t 래퍼(common:exit.*) — 리터럴은 localPrefix 경로에서 이미 해석된다.
    // 여기서는 «동적 템플릿이 선언돼 있음»만 표시해 «안 보는 영역» 경고를 없앤다.
    prefix: 'common.exit',
    suffixes: [''],
    coverAll: true,
    source: 'tossBoot.ts 지역 t 래퍼',
  },
];

/** `function NAME(...) { ... return 'x'; ... }` 의 반환 문자열 리터럴 전부 */
function returnLiterals(relPath, fnName) {
  const src = readFileSync(resolve(ROOT, relPath), 'utf8');
  const i = src.indexOf(`function ${fnName}`);
  if (i < 0) throw new Error(`${relPath} 에서 function ${fnName} 을 찾지 못했다`);
  const body = src.slice(i, src.indexOf('\n}', i));
  const out = [...body.matchAll(/return\s+'([^']+)'/g)].map((m) => m[1]);
  if (!out.length) throw new Error(`${relPath} ${fnName}: 반환 리터럴 0개`);
  return [...new Set(out)];
}

/** 엔진이 던지는 GameError 코드 전부 — 「전용 문구가 있는가」의 기준 집합 */
function gameErrorCodes() {
  const out = new Set();
  for (const f of walk(resolve(SRC, 'lib'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/new GameError\('([A-Z_]+)'/g)) out.add(m[1]);
  }
  if (!out.size) throw new Error('GameError 코드 0개 — 검사기가 소스를 못 읽고 있다');
  return [...out];
}

/**
 * ★역방향(죽은 키) 검사에서 «아직» 제외하는 것.
 *   ⛔영구 면제가 아니다. 사유와 «해제 조건»을 반드시 같이 적어라.
 */
/**
 * ★알려진 «오탐» 리터럴 — t( 로 보이지만 키가 아닌 것.
 *   ⛔모양으로 거르지 마라(니들 ① 를 놓친 원인). ★개별 리터럴만 사유와 함께 등재한다.
 */
const IGNORE_LITERALS = new Set([
  // 여기에 항목을 넣을 때는 «왜 키가 아닌지»를 반드시 한 줄로 적어라.
]);

/**
 * ★「키 표」 수확이 잡아 오지만 i18n 키가 «아닌» 접두.
 *   ⛔규칙(모양)으로 거르지 않고 ★«명단»으로 둔다 — 명단은 세어볼 수 있고, 규칙은 안 보인다.
 *   · `ml.` : 이 앱의 localStorage 키 이름공간(store.ts 의 LS 표).
 *             화면 문구가 아니라 저장소 키다. i18n 과 무관하다.
 */
const NON_KEY_PREFIXES = ['ml.'];

const PENDING = [
  /*
   * ★[2026-08-21] 파생 4종 58키 면제를 ★«지웠다» — 화면이 들어왔기 때문이다.
   *   ★면제를 남겨 두면 ★그 접두 아래의 «다음 누락»을 조용히 통과시킨다.
   *     ⇒ 내가 만든 장치에 내가 구멍을 내는 셈이다.
   *   ★면제는 «생길 때»가 아니라 ★«필요 없어질 때» 위험해진다.
   *     지금 PENDING 은 «비어 있다». 새로 넣을 때는 사유와 ★해제 조건을 같이 적어라.
   */
];

// ── locales 로드 ────────────────────────────────────────────────────────
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}
function stripPlural(key) {
  const i = key.lastIndexOf('_');
  if (i > 0 && PLURAL_SUFFIXES.includes(key.slice(i + 1))) return key.slice(0, i);
  return key;
}
function loadLocale(lng) {
  return flatten(JSON.parse(readFileSync(resolve(LOCALES, `${lng}.json`), 'utf8')));
}

// ── 엔진 소스에서 유니언 멤버를 «유도» ──────────────────────────────────
/**
 * 유니언 타입의 «리터럴 멤버 전부»를 뽑는다.
 *
 * ★단순 `export type X = 'a' | 'b'` 만 보면 «틀린다» — 실제 소스는 합성이다:
 *     export type BotStrategy = LegacyBotStrategy | 'blue_chip' | ...
 *     export type NewConcept  = (typeof NEW_CONCEPTS)[number];
 *   ⇒ ★타입 «참조»와 ★`(typeof ARR)[number]` 를 «따라가야» 14종이 나온다.
 *   ⇒ 실제로 이 재귀를 넣기 «전»에는 9종만 잡혀 momentum·whale 등 5종이
 *     「죽은 키」로 오분류됐다. 얕게 파싱하면 검사기가 조용히 틀린다.
 */
const TYPE_SOURCE_FILES = [
  'src/lib/engine/types.ts',
  'src/lib/engine/concepts.ts',
  'src/lib/engine/macro.ts',
];
function unionMembers(relPath, typeName, srcOverride) {
  const bodies = new Map();
  const arrays = new Map();
  const files = srcOverride ? [['<override>', srcOverride]] : TYPE_SOURCE_FILES.map((p) => [p, readFileSync(resolve(ROOT, p), 'utf8')]);
  for (const [, src] of files) {
    for (const m of src.matchAll(/export type (\w+)\s*=([\s\S]*?);/g)) bodies.set(m[1], m[2]);
    for (const m of src.matchAll(/export const (\w+)\s*=\s*\[([\s\S]*?)\]\s*as const/g)) arrays.set(m[1], m[2]);
  }

  const seen = new Set();
  const out = new Set();
  (function expand(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const body = bodies.get(name);
    if (body === undefined) return;
    for (const m of body.matchAll(/'([^']+)'/g)) out.add(m[1]);
    // (typeof ARR)[number]
    for (const m of body.matchAll(/typeof\s+(\w+)\s*\)?\s*\[\s*number\s*\]/g)) {
      const arr = arrays.get(m[1]);
      if (arr === undefined) throw new Error(`${name}: (typeof ${m[1]})[number] 인데 ${m[1]} 배열을 못 찾았다`);
      for (const a of arr.matchAll(/'([^']+)'/g)) out.add(a[1]);
    }
    // 다른 타입 참조 (| Foo)
    for (const m of body.matchAll(/(?:^|\|)\s*([A-Z]\w+)\b/g)) expand(m[1]);
  })(typeName);

  if (!bodies.has(typeName)) throw new Error(`${relPath} 에서 'export type ${typeName}' 을 찾지 못했다`);
  if (out.size === 0) throw new Error(`${relPath} ${typeName}: 유니언 멤버 0개`);
  return [...out];
}

// ── 소스 스캔 ───────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'locales' || name === 'node_modules') continue;
      walk(p, out);
    } else if (['.ts', '.tsx'].includes(extname(name))) out.push(p);
  }
  return out;
}

/**
 * `open` 위치(여는 괄호 인덱스)부터 «첫 번째 인자»의 원문을 잘라 온다.
 * 괄호 깊이를 세고 따옴표 안은 건너뛴다 — 정규식으로는 못 하는 부분이다.
 */
function firstArg(src, open) {
  let depth = 0;
  let i = open;
  const start = open + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    } else if (c === ',' && depth === 1) return src.slice(start, i);
  }
  return src.slice(start, i);
}

/**
 * 인자 원문에서 정적 문자열 리터럴과 «동적 템플릿»을 갈라 담는다.
 *
 * ★★비교식 피연산자를 «먼저 지운다». 안 지우면 삼항의 «조건»이 키로 잡힌다:
 *     t(item.side === 'long' ? 'sideLong' : 'sideShort')
 *   여기서 'long' 은 키가 «아니다». 실제로 이 처리를 넣기 전 FAIL 10건 중 9건이
 *   전부 이 오탐이었다. ★오탐을 「모양으로 봐주기」로 덮으면 진짜 누락도 같이 덮인다 —
 *   그래서 «조건부 피연산자»라는 «구문상 근거»로만 지운다.
 */
function literalsOf(arg) {
  const cleaned = arg
    .replace(/[!=]==?\s*(?:'[^']*'|"[^"]*")/g, ' ')
    .replace(/(?:'[^']*'|"[^"]*")\s*[!=]==?/g, ' ');
  const statics = [];
  const dynamics = [];
  for (const m of cleaned.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)) statics.push(m[1] ?? m[2]);
  for (const m of cleaned.matchAll(/`([^`]*)`/g)) {
    if (m[1].includes('${')) dynamics.push(m[1]);
    else statics.push(m[1]);
  }
  return { statics, dynamics };
}

/**
 * ★지역 `t` 래퍼 감지 — tossBoot.ts 는 `const t = (k) => i18next.t(\`common:exit.${k}\`)` 다.
 *   이 파일의 `t('title')` 은 `common.exit.title` 이다. 손으로 맵을 유지하면 그 맵이
 *   다음 사고의 원인이 되므로 ★코드에서 «유도»한다.
 */
function localPrefixOf(src) {
  const m = src.match(/const\s+t\s*=\s*\([^)]*\)\s*=>[^\n]*?`(\w+):([\w.]+)\.\$\{/);
  return m ? `${m[1]}.${m[2]}` : null;
}

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  // 파일이 선언한 네임스페이스. useTranslation() 인자 없음 = defaultNS
  const ns = new Set();
  for (const m of src.matchAll(/useTranslation\(\s*(?:'([^']+)'|"([^"]+)")?\s*\)/g)) {
    ns.add(m[1] ?? m[2] ?? DEFAULT_NS);
  }
  if (/i18next\.t\(/.test(src)) ns.add(DEFAULT_NS);

  const statics = [];
  const dynamics = [];
  const varArgs = [];

  // t( ... ) · i18next.t( ... )   ★`(?<![\w.$])t\(` 로 `.at(` `split(` 등 오탐을 막는다
  for (const m of src.matchAll(/(?<![\w.$])(?:i18next\.)?t\(/g)) {
    const open = m.index + m[0].length - 1;
    const arg = firstArg(src, open);
    const { statics: s, dynamics: d } = literalsOf(arg);
    if (!s.length && !d.length && arg.trim()) varArgs.push(arg.trim());
    statics.push(...s);
    dynamics.push(...d);
  }
  // i18nKey="..." / i18nKey={...}
  for (const m of src.matchAll(/i18nKey\s*=\s*(\{|"|')/g)) {
    const at = m.index + m[0].length - 1;
    let arg;
    if (m[1] === '{') arg = firstArg(src, at);
    else {
      const q = m[1];
      const end = src.indexOf(q, at + 1);
      arg = src.slice(at, end + 1);
    }
    const { statics: s, dynamics: d } = literalsOf(arg);
    statics.push(...s);
    dynamics.push(...d);
  }

  /*
   * ★★`t(tab.key)` 처럼 «변수»를 넘기는 형태 — 정적 추출로는 «아무것도» 안 잡힌다.
   *   실제로 TabBar.tsx 의 탭 라벨 5개가 이 형태라서, 이 처리를 넣기 «전»에는
   *   common.tabs.* 5개가 통째로 「죽은 키」로 오분류됐다.
   *   ⇒ ★키를 «담는» 속성 이름을 수확한다. 그리고 ★변수를 넘기는 호출 자체를
   *     「안 보는 영역」으로 «드러낸다» — 조용히 넘어가지 않는다.
   */
  const stems = [];
  for (const m of src.matchAll(/\b(?:key|i18nKey|titleKey|bodyKey|labelKey|descKey)\s*:\s*'([^']+)'/g)) {
    stems.push(m[1]);
  }
  /*
   * ★★「키 표」 형태 — 속성 «이름»이 key/i18nKey 가 아닌 경우.
   *     const CHIP_KEY: Record<Product, string> = { futures: 'chip.futures', ... };
   *     t(CHIP_KEY[product])
   *   ⇒ 속성 이름이 «상품 id» 라 위 규칙에 안 걸렸고, ★실제로 chip.* · desc.* 4개가
   *     「죽은 키」로 «오분류»됐다 — 그 키들은 화면에서 «쓰이고 있다».
   *   ★그래서 «값이 키 모양(소문자로 시작하는 점 표기)»인 객체 속성도 수확한다.
   *   ⛔검사를 약화시키지 않는다: 없는 키를 수확하면 그건 여전히 [누락]으로 FAIL 한다.
   */
  for (const m of src.matchAll(/[{,]\s*['"]?[\w$]+['"]?\s*:\s*'([a-z][\w]*(?:\.[\w]+)+)'/g)) {
    stems.push(m[1]);
  }
  /*
   * ★★`'ns:key'` 표기 리터럴은 ★«어디에 있든» 키다.
   *   실사고: store.ts 가 조건에 따라 키를 «변수에 담아» 넘긴다 —
   *       const key = e.forced ? 'derivatives:toast.settledForced' : 'derivatives:toast.settled';
   *       i18next.t(key, {...})
   *     ⇒ t() «안»을 보는 규칙에는 안 걸려서 ★실제로 쓰는 키 3개가 「죽은 키」로 «오분류»됐다.
   *   ★네임스페이스 표기(`ns:`)는 이 코드베이스에서 «i18n 키에만» 쓰는 형태라
   *     파일 어디서 발견하든 키로 봐도 안전하다. 없는 키를 수확하면 여전히 [누락]으로 FAIL 한다.
   */
  for (const m of src.matchAll(/'([a-z][\w]*:[\w.]+)'/g)) {
    stems.push(m[1]);
  }
  return { file, ns, statics, stems, dynamics, varArgs, localPrefix: localPrefixOf(src) };
}

/**
 * 리터럴 하나를 «완전 키»(ns.a.b)로 해석한다.
 *   'common:appName' -> 'common.appName'
 *   'greeting'       -> 파일이 선언한 ns 중 실제로 존재하는 것
 */
function resolveKey(lit, declaredNs, keys) {
  if (!lit || /\s/.test(lit)) return null; // 문장·빈 문자열은 키가 아니다
  if (lit.includes(':')) {
    const [ns, ...rest] = lit.split(':');
    return { full: `${ns}.${rest.join(':')}`, explicit: true };
  }
  if (!/^[\w.-]+$/.test(lit)) return null;
  for (const ns of declaredNs) {
    if (keys.has(stripPlural(`${ns}.${lit}`))) return { full: `${ns}.${lit}`, explicit: false };
  }
  // 선언한 ns 어디에도 없다 — 다른 ns 에 있는지 보고(오배치 경고), 없으면 미해결
  const first = [...declaredNs][0] ?? DEFAULT_NS;
  return { full: `${first}.${lit}`, explicit: false, unresolved: true };
}

// ── 본 검사 ─────────────────────────────────────────────────────────────
function run({ koOverride, srcOverrides = {}, dynamicOverride } = {}) {
  const errors = [];
  const warnings = [];

  const ko = koOverride ?? loadLocale('ko');
  const keys = new Set(Object.keys(ko).map(stripPlural));
  const allNs = new Set([...keys].map((k) => k.split('.')[0]));

  const files = walk(SRC);
  const used = new Set();
  const unresolvedDynamics = [];

  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const scanned = srcOverrides[rel]
      ? (() => {
          const orig = readFileSync;
          return scanFileFromString(f, srcOverrides[rel]);
        })()
      : scanFile(f);
    const declared = scanned.ns.size ? scanned.ns : new Set([DEFAULT_NS]);

    for (const lit of scanned.statics) {
      // ★지역 t 래퍼가 있는 파일은 그 접두로 «먼저» 해석한다(tossBoot.ts 의 common:exit.*)
      if (scanned.localPrefix && /^[\w-]+$/.test(lit)) {
        const full = `${scanned.localPrefix}.${lit}`;
        if (keys.has(stripPlural(full))) { used.add(stripPlural(full)); continue; }
        errors.push(`[누락] ${rel}: 지역 t 래퍼 '${lit}' -> ${full} 가 locales 에 없다`);
        continue;
      }
      const r = resolveKey(lit, declared, keys);
      if (!r) continue;
      if (keys.has(stripPlural(r.full))) {
        used.add(stripPlural(r.full));
        continue;
      }
      // 다른 ns 에 있으면 «오배치»(경고), 어디에도 없으면 «누락»(실패)
      const elsewhere = [...allNs].map((n) => `${n}.${lit}`).find((k) => keys.has(stripPlural(k)));
      if (!r.explicit && elsewhere) {
        used.add(stripPlural(elsewhere));
        warnings.push(`[ns 불일치] ${rel}: t('${lit}') 가 선언 ns(${[...declared].join(',')}) 에 없고 ${elsewhere} 로만 풀린다`);
      } else if (IGNORE_LITERALS.has(lit)) {
        /*
         * ★여기에 «키 모양» 기준으로 거르는 규칙을 넣지 마라.
         *   처음에 「점 없는 짧은 리터럴은 넘긴다」로 짰다가 ★양성대조 니들 ①
         *   (home.greeting 삭제)을 «놓쳤다». t() 의 첫 인자는 정의상 «키»다 —
         *   모양으로 봐주기 시작하면 그 순간 이 검사기도 「안 보는 영역」을 갖게 된다.
         *   오탐이 나오면 «그 리터럴 하나»를 사유와 함께 아래 목록에 적어라.
         */
        // 알려진 오탐 — 아래 IGNORE_LITERALS 주석 참조
      } else {
        errors.push(`[누락] ${rel}: 코드가 쓰는 '${lit}' 가 locales 에 없다 (해석: ${r.full})`);
      }
    }

    /*
     * ★수확한 «줄기»(key:/i18nKey: 속성 리터럴)는 «완전 키»일 수도, «접두»일 수도 있다.
     *     TabBar    key: 'tabs.home'                  -> 완전 키
     *     concepts  i18nKey: 'traders.concept.all_in' -> 접두 (.name/.oneLiner 가 붙는다)
     *   ⇒ 둘 다 인정한다. 접두조차 아니면 그건 «진짜 누락»이다.
     */
    for (const stem of scanned.stems ?? []) {
      if (NON_KEY_PREFIXES.some((x) => stem.startsWith(x))) continue;
      /*
       * ★`ns:key` 모양이지만 «ns 가 실제 네임스페이스가 아니면» 키가 아니다.
       *   실사고: tossBoot.ts 의 인라인 CSS 문자열 `'position:fixed'` · `'display:flex'` 가
       *   ★네임스페이스 표기로 오인돼 [누락] 4건이 떴다.
       * ⇒ 판정 기준을 «모양»이 아니라 ★«locales 에 그 네임스페이스가 있는가»로 둔다.
       *   목록을 손으로 유지하지 않으므로 네임스페이스가 늘어도 따라온다.
       */
      if (stem.includes(':') && !allNs.has(stem.split(':')[0])) continue;
      const cands = stem.includes(':')
        ? [stem.replace(':', '.')]
        : [...declared, DEFAULT_NS].map((n) => `${n}.${stem}`);
      let hit = false;
      for (const c of cands) {
        if (keys.has(stripPlural(c))) { used.add(stripPlural(c)); hit = true; break; }
        const kids = [...keys].filter((k) => k.startsWith(`${c}.`));
        if (kids.length) { for (const k of kids) used.add(k); hit = true; break; }
      }
      if (!hit) errors.push(`[누락] ${rel}: 키 속성 '${stem}' 에 대응하는 locales 항목이 없다`);
    }
    for (const tpl of scanned.dynamics) unresolvedDynamics.push({ rel, tpl });
    for (const v of new Set(scanned.varArgs)) {
      warnings.push(`[변수 키] ${rel}: t(${v}) — 정적 추출 «불가». 키 리터럴이 어딘가에 수확 가능한 형태로 있어야 한다`);
    }
  }

  // ── 2) 동적 조립 키 — 접두 선언 + 엔진 유니언에서 유도한 구성원 전수 ──
  const dyn = dynamicOverride ?? DYNAMIC;
  const dynCovered = [];
  for (const g of dyn) {
    if (g.coverAll) {
      // 구성원을 유도할 «근거 소스»가 없는 접두 — 완전성은 주장하지 않고 커버만 한다
      for (const k of keys) if (k.startsWith(`${g.prefix}.`)) { used.add(k); dynCovered.push(k); }
      continue;
    }
    let members;
    try {
      members = g.members();
    } catch (e) {
      errors.push(`[동적] ${g.id}: 구성원을 유도하지 못했다 — ${e.message}`);
      continue;
    }
    for (const mem of members) {
      for (const suf of g.suffixes) {
        const full = suf ? `${g.prefix}.${mem}.${suf}` : `${g.prefix}.${mem}`;
        dynCovered.push(full);
        if (keys.has(full)) used.add(full);
        else if (g.soft) warnings.push(`[전용 문구 없음] ${full} — 폴백(GENERIC)으로 떨어진다 (출처: ${g.source})`);
        else errors.push(`[동적 누락] ${full} 없음 (구성원 출처: ${g.source})`);
      }
    }
    // soft 그룹은 «기존 키»도 전부 사용 처리한다(폴백 경로라 정적 참조가 없다)
    if (g.soft) for (const k of keys) if (k.startsWith(`${g.prefix}.`)) used.add(k);
  }
  // 동적 템플릿이 «선언되지 않은» 접두를 쓰고 있으면 알린다 (안 보는 영역이 생기는 걸 막는다)
  const seenTpl = new Set();
  for (const { rel, tpl } of unresolvedDynamics) {
    // `common:err.${code}`      -> head 'common.err' · tail ''
    // `common:${x.i18nKey}.name` -> head 'common'     · tail '.name'
    const at = tpl.indexOf('${');
    const head = tpl.slice(0, at).replace(':', '.').replace(/\.$/, '');
    const tail = tpl.slice(tpl.indexOf('}', at) + 1);
    const covered = dyn.some((g) => {
      const headOk = g.prefix === head || g.prefix.startsWith(`${head}.`);
      const tailOk = !tail || g.suffixes.some((s) => s && tail === `.${s}`);
      return headOk && tailOk;
    });
    const sig = `${rel}::${tpl}`;
    if (!covered && !seenTpl.has(sig)) {
      seenTpl.add(sig);
      warnings.push(`[동적 미선언] ${rel}: \`${tpl}\` — DYNAMIC 에 접두 선언 없음 (★안 보는 영역이 생긴다)`);
    }
  }

  // ── 3) 역방향: 죽은 키 ─────────────────────────────────────────────────
  const dead = [];
  for (const k of keys) {
    if (used.has(k)) continue;
    if (PENDING.some((p) => p.re.test(k))) continue;
    dead.push(k);
  }
  dead.sort();

  return { errors, warnings, dead, usedCount: used.size, totalCount: keys.size, dynCovered };
}

/** scanFile 의 «문자열 입력» 판 — 셀프테스트에서 니들을 메모리로 주입하려고 쓴다 */
function scanFileFromString(fakePath, src) {
  const ns = new Set();
  for (const m of src.matchAll(/useTranslation\(\s*(?:'([^']+)'|"([^"]+)")?\s*\)/g)) ns.add(m[1] ?? m[2] ?? DEFAULT_NS);
  if (/i18next\.t\(/.test(src)) ns.add(DEFAULT_NS);
  const statics = [];
  const dynamics = [];
  for (const m of src.matchAll(/(?<![\w.$])(?:i18next\.)?t\(/g)) {
    const { statics: s, dynamics: d } = literalsOf(firstArg(src, m.index + m[0].length - 1));
    statics.push(...s);
    dynamics.push(...d);
  }
  for (const m of src.matchAll(/i18nKey\s*=\s*(\{|"|')/g)) {
    const at = m.index + m[0].length - 1;
    let arg;
    if (m[1] === '{') arg = firstArg(src, at);
    else {
      const end = src.indexOf(m[1], at + 1);
      arg = src.slice(at, end + 1);
    }
    const { statics: s, dynamics: d } = literalsOf(arg);
    statics.push(...s);
    dynamics.push(...d);
  }
  return { file: fakePath, ns, statics, stems: [], dynamics, varArgs: [], localPrefix: localPrefixOf(src) };
}

// ── 양성대조 (--selftest) ───────────────────────────────────────────────
/**
 * ★「0건」을 말하기 «전에» 검사기가 살아있음을 증명한다.
 *   니들을 «메모리로» 주입한다 — 소스 파일을 건드리지 않으므로 워크스페이스를 오염시키지 않는다.
 */
function selftest() {
  const base = run();
  const results = [];
  const ko = loadLocale('ko');

  // 니들 ①: locales 에서 «실제로 쓰이는» 키 하나를 지운다 -> [누락] 이 떠야 한다
  {
    const victim = 'home.greeting';
    const cut = { ...ko };
    delete cut[victim];
    const r = run({ koOverride: cut });
    const caught = r.errors.some((e) => e.includes(`'greeting'`) || e.includes(victim));
    results.push(['① 정방향(쓰는데 없음)', `${victim} 삭제`, caught]);
  }
  // 니들 ②: 동적 조립 키 하나를 지운다 -> [동적 누락] 이 떠야 한다
  {
    const victim = 'common.traders.concept.liquidation_hunter.name';
    const cut = { ...ko };
    delete cut[victim];
    const r = run({ koOverride: cut });
    const caught = r.errors.some((e) => e.startsWith('[동적 누락]') && e.includes(victim));
    results.push(['② 동적 조립 키 누락', `${victim} 삭제`, caught]);
  }
  // 니들 ③: 엔진에 콘셉트가 «추가»됐는데 locales 가 안 따라온 상황 -> [동적 누락]
  {
    const fakeUnion = `export type BotStrategy = 'momentum' | 'ghost_concept';`;
    const g = [{ ...DYNAMIC[0], members: () => unionMembers('x', 'BotStrategy', fakeUnion) }];
    const r = run({ dynamicOverride: g });
    const caught = r.errors.some((e) => e.includes('common.traders.concept.ghost_concept.name'));
    results.push(['③ 엔진에 신규 콘셉트 추가', 'BotStrategy 에 ghost_concept 주입', caught]);
  }
  // 니들 ④: 죽은 키 -> dead 목록에 떠야 한다
  {
    const add = { ...ko, 'common.zz_dead_needle': '아무도 안 쓰는 키' };
    const r = run({ koOverride: add });
    const caught = r.dead.includes('common.zz_dead_needle');
    results.push(['④ 역방향(죽은 키)', 'common.zz_dead_needle 주입', caught]);
  }
  // 니들 ⑤: 엔진 유니언 파싱 실패 -> 조용히 통과하면 안 된다
  {
    const g = [{ ...DYNAMIC[1], members: () => unionMembers('x', 'MacroType', 'export type Nope = 1;') }];
    const r = run({ dynamicOverride: g });
    const caught = r.errors.some((e) => e.startsWith('[동적]'));
    results.push(['⑤ 유니언 파싱 실패', 'MacroType 제거', caught]);
  }

  console.log('i18n usage checker — 양성대조 (니들 주입)');
  console.log(`  기준 상태: errors ${base.errors.length} · dead ${base.dead.length}`);
  let ok = true;
  for (const [name, needle, caught] of results) {
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${name}  (${needle})`);
    if (!caught) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 검사기가 니들을 놓쳤다. 이 상태의 「0건」은 «부재의 증거가 아니다».');
    process.exit(1);
  }
  console.log('\nOK: 니들 5종 전부 잡힘 — 검사기가 살아 있다.');
}

// ── 실행 ────────────────────────────────────────────────────────────────
if (SELFTEST) {
  selftest();
} else {
  const { errors, warnings, dead, usedCount, totalCount, dynCovered } = run();
  console.log('i18n usage check (코드 ↔ locales)');
  console.log(`  locales 키 : ${totalCount} (base)`);
  console.log(`  코드가 씀  : ${usedCount}  (동적 조립 커버 ${dynCovered.length})`);
  console.log(`  미사용     : ${dead.length}${STRICT ? ' (--strict: FAIL)' : ' (WARN)'}`);

  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const k of dead) console.log(`${STRICT ? 'FAIL' : 'WARN'}  [죽은 키] ${k}`);
  for (const e of errors) console.error(`FAIL  ${e}`);

  const fatal = errors.length + (STRICT ? dead.length : 0);
  if (fatal) {
    console.error(`\nFAILED: ${fatal} problem(s).`);
    process.exit(1);
  }
  console.log(`\nOK: 코드가 쓰는 키가 전부 locales 에 있다 (warnings: ${warnings.length + dead.length})`);
}
