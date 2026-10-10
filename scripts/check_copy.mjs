#!/usr/bin/env node
/**
 * 카피 「AI 티」 검사 — ★유저에게 «보이는 문자열»만 본다(locales/*.json).
 *
 *   node scripts/check_copy.mjs
 *   node scripts/check_copy.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★왜 검사기인가 (President 지시 2026-08-21 「AI 티를 모두 제거」)
 *   이번에 손으로 13건을 고쳤다. 「주의하라」로 두면 다음 카피에서 그대로 돌아온다.
 *   ⇒ 규칙을 «세어지는 것»으로 만든다.
 *
 * ★검사 항목 (전부 taste-skill §9 의 명시 항목 또는 그 파생)
 *   ① em-dash(—) 0건. §9.G 「headlines, body copy, buttons, alt text 어디에도 금지」.
 *      ⇒ 붙임표로 «바꾸기»만 하면 문장이 여전히 어색하다. 쪼개거나 다시 써라.
 *   ② 한 줄에 가운뎃점(·) 2개 이상 금지. §9.F 「middle-dot is rationed, max 1 per line」.
 *      ★이 앱은 «데이터 행»이 많아 · 를 구분자로 쓴다 — 그래서 «0개»가 아니라 «1개»가 상한이다.
 *   ③ 뭉툭한 상투 표현(「~해보세요」·「경험해 보세요」류) 금지 —
 *      다음 행동을 «구체적으로» 말해야 한다.
 *
 * ★★그리고 «음성대조»가 있다: 정상 카피를 넣었을 때 «안 잡히는지»도 본다.
 *   양성대조만 있으면 「전부 잡는 검사기」도 통과한다 — 그건 검사기가 아니라 알람이다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LOCALES = resolve(ROOT, 'src/locales');
const LANGS = ['ko', 'en'];
const SELFTEST = new Set(process.argv.slice(2)).has('--selftest');

/** 「~해보세요」 계열 — ⛔모양이 아니라 «명단»이다. 늘릴 때는 왜인지 적어라 */
const CLICHES = ['해보세요', '해 보세요', '경험해', '구경해보세요', '즐겨보세요', '만나보세요'];

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

function scan(flat, lng) {
  const errs = [];
  for (const [k, v] of Object.entries(flat)) {
    if (v.includes('—')) errs.push([`[em-dash] ${lng}:${k}`, v]);
    for (const line of v.split('\n')) {
      const dots = (line.match(/·/g) ?? []).length;
      if (dots >= 2) errs.push([`[가운뎃점 ${dots}개] ${lng}:${k}`, line]);
    }
    for (const c of CLICHES) {
      if (v.includes(c)) errs.push([`[상투 표현 「${c}」] ${lng}:${k}`, v]);
    }
  }
  return errs;
}

function run(overrides = {}) {
  const errs = [];
  for (const lng of LANGS) {
    const flat = overrides[lng] ?? flatten(JSON.parse(readFileSync(resolve(LOCALES, `${lng}.json`), 'utf8')));
    errs.push(...scan(flat, lng));
  }
  return errs;
}

if (SELFTEST) {
  const results = [];
  results.push(['① em-dash 검출', run({ ko: { 'x.y': '가 — 나' } }).some(([m]) => m.startsWith('[em-dash]'))]);
  results.push(['② 가운뎃점 2개 검출', run({ ko: { 'x.y': 'a · b · c' } }).some(([m]) => m.startsWith('[가운뎃점'))]);
  results.push(['③ 상투 표현 검출', run({ ko: { 'x.y': '지금 시작해보세요' } }).some(([m]) => m.startsWith('[상투'))]);
  /* ★음성대조 — 정상 카피는 «안» 잡혀야 한다. 안 그러면 그냥 알람이다 */
  results.push(['④ 정상 카피는 «안» 잡힌다(음성대조)', run({ ko: { 'x.y': 'NVDA · 12주 매수' }, en: { 'x.y': 'Buy 12 shares' } }).length === 0]);
  results.push(['⑤ 가운뎃점 1개는 «안» 잡힌다(음성대조)', run({ ko: { 'x.y': 'a · b' }, en: {} }).length === 0]);

  console.log('copy checker — 양성/음성 대조');
  let ok = true;
  for (const [n, caught] of results) {
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${n}`);
    if (!caught) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    process.exit(1);
  }
  console.log(`\nOK: 대조 ${results.length}종 전부 통과 — 검사기가 살아 있다.`);
} else {
  const errs = run();
  console.log('카피 AI 티 검사 (locales · 유저에게 보이는 문자열)');
  if (!errs.length) {
    console.log('  0건');
    process.exit(0);
  }
  for (const [m, v] of errs) console.log(`  ${m}\n      ${v.slice(0, 90)}`);
  console.error(`\nFAILED: ${errs.length}건`);
  process.exit(1);
}
