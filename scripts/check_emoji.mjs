#!/usr/bin/env node
/**
 * 이모지 0건 검사 — ★UI 아이콘으로 쓰인 이모지를 «구조로» 막는다.
 *
 *   node scripts/check_emoji.mjs              (= npm run check:emoji · 소스 검사)
 *   node scripts/check_emoji.mjs --selftest   (★양성대조: 검사기가 살아있는지 먼저 증명)
 *   node scripts/check_emoji.mjs --dist       (★번들 검사 — 빌드 «후»에 쓴다)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 필요한가 (President 지시 2026-08-21 「AI 티를 모두 제거」)
 *
 *   이모지를 UI 아이콘으로 쓰는 것은 AI 생성 UI 의 «가장 흔한 표식»이다. 그리고
 *   실제 결함도 같이 온다:
 *     · 플랫폼마다 «다르게» 그려진다(iOS/안드로이드/토스 웹뷰의 모양·크기·기준선이 다르다)
 *     · 최신 이모지(🫙 🥇)는 구형 안드로이드에서 «두부(□)»가 된다
 *     · 폰트에 종속돼 색·굵기를 브랜드에 맞출 수 없다
 *   ⇒ 「주의하라」는 대책이 아니다. 검사기여야 한다.
 *
 * ★★검사기의 함정 3가지 — 전부 실제로 밟았다:
 *   ① ★주석에 쓴 기호까지 세면 «헛수»가 나온다. Partner 의 첫 검사기가 5,566건을 뱉었다.
 *     ⇒ 소스 모드는 «주석을 지운 뒤» 센다.
 *   ② ★번들에서 한글·이모지가 `\\uXXXX` 로 «이스케이프»되는 구간이 실제로 있다.
 *     ⇒ dist 모드는 «해제한 뒤» 센다. 안 풀면 0건이 거짓이 된다.
 *   ③ ★문서용 기호(★ ⛔ ✓ ● ─ …)는 이모지 «범위 안»에 있지만 화면 아이콘이 아니다.
 *     ⇒ 규칙으로 거르지 않고 ★«명단»(ALLOW)으로 둔다 — 명단은 세어볼 수 있다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'src');

const ARGV = new Set(process.argv.slice(2));
const SELFTEST = ARGV.has('--selftest');
const DIST_MODE = ARGV.has('--dist');

/**
 * ★허용 «명단» — 이모지 코드 범위에 들지만 «화면 아이콘이 아닌» 문자.
 *   ⛔모양 규칙(예: 「U+2xxx 는 봐준다」)으로 거르지 마라. 그러면 진짜 이모지도 같이 샌다.
 *   ★여기에 넣을 때는 «왜 아이콘이 아닌지»를 한 줄로 적어라.
 */
const ALLOW = new Set([
  '⛔', // 주석 금지 표시 — 이 레포 주석 규약상 다수 쓰인다
  '✅', // 주석 확인 표시
]);

/**
 * ★★ALLOW 는 «살아 있어야» 한다 — EMOJI_RE 가 애초에 안 잡는 문자를
 * 명단에 두면 «고려해서 봐준 것»으로 읽히지만 실제로는 무의미하다.
 *
 * ★★그게 이번에 실제로 사고로 나왔다 [2026-08-21 실측]:
 *   `✓`(U+2713) 은 이 명단에 «근거까지 적혀» 있었는데, EMOJI_RE 에는 애초에
 *   없는 문자였다. 즉 «걸러진 적이 없는 면제»였고, 그 덕분에 화면 아이콘으로
 *   쓰인 ✓ 2건이 ★출하물까지 그대로 갔다. 명단이 검사기를 «누그러뜨리지» 않고
 *   «가리기만» 한 것이다.
 * ⇒ 그래서 이제 대조 ⑥ 가 «ALLOW 의 모든 원소가 EMOJI_RE 에 잡히는지»를
 *   먼저 증명한다. 죽은 면제는 «조용히» 남을 수 없다.
 * ★문서 기호(★ ● ○ → ⇒ ↔ ⚠)는 명단에서 «뺐다» — 원래부터 EMOJI_RE 밖이라
 *   면제가 필요 없었다. 음성대조 ⑤ 가 그 사실을 직접 검사한다.
 */

/**
 * 화면에 그려질 수 있는 «그림 문자» 범위.
 *
 * ★[2026-08-21 추가] `✓`(U+2713) · `✗`(U+2717).
 *   이 둘은 유니코드상 «이모지» 가 아니라 Dingbats 글자다. 그래서 범위 밖에 있었고,
 *   그 틈으로 «통과 표시»·«선택 표시» 2곳이 출하물까지 살아서 갔다.
 * ★★이모지가 아니지만 «문제는 똑같다»:
 *   폰트가 모양·폭·기준선을 정하고(플랫폼마다 다르다), 획 굵기를 브랜드에 맞출 수 없고,
 *   색은 currentColor 하나로만 바뀐다. ⇒ 화면 아이콘이면 SVG 여야 한다.
 * ⚠문서·주석에서는 여전히 써도 된다 — 소스 모드가 주석을 «지우고» 센다(음성대조 ⑦).
 */
const EMOJI_RE =
  /[⌚-⌛⏩-⏺◽-◾☔-☕♈-♓♿⚓⚡⚪-⚫⚽-⚾⛄-⛅⛎⛔⛪⛲-⛳⛵⛺⛽✅✓✗✊-✋✨❌❎❓-❕❗➕-➗➰➿⬛-⬜⭐⭕\u{1F004}-\u{1FAFF}\u{FE0F}\u{20E3}]/gu;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else if (['.ts', '.tsx', '.json', '.css', '.html'].includes(extname(name))) out.push(p);
  }
  return out;
}

/**
 * ★주석을 «지운다»(자리는 유지해 줄 번호가 안 밀린다).
 * ⛔문자열 안의 `//` 를 주석으로 오인하지 않도록 따옴표를 «건너뛴다».
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
          if (i < n) {
            out += src[i];
            i++;
          }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** ★`\uXXXX` · `\u{XXXXX}` 를 «되돌린다». 안 풀면 번들의 0건이 거짓이 된다 */
export function unescapeUnicode(s) {
  return s
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function scanText(text, { unescape = false, strip = false } = {}) {
  let t = text;
  if (strip) t = stripComments(t);
  if (unescape) t = unescapeUnicode(t);
  const hits = [];
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    EMOJI_RE.lastIndex = 0;
    for (const m of lines[i].matchAll(EMOJI_RE)) {
      if (ALLOW.has(m[0])) continue;
      hits.push({ line: i + 1, ch: m[0], code: [...m[0]].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' '), ctx: lines[i].trim().slice(0, 90) });
    }
  }
  return hits;
}

function runSource({ srcOverrides = {} } = {}) {
  const hits = [];
  for (const f of walk(SRC)) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const text = srcOverrides[rel] ?? readFileSync(f, 'utf8');
    for (const h of scanText(text, { strip: f.endsWith('.ts') || f.endsWith('.tsx'), unescape: false })) {
      hits.push({ file: rel, ...h });
    }
  }
  return hits;
}

function runDist() {
  const dist = resolve(ROOT, process.env.ML_DIST || 'dist');
  const hits = [];
  for (const f of walk(dist)) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    for (const h of scanText(readFileSync(f, 'utf8'), { strip: false, unescape: true })) {
      hits.push({ file: rel, ...h });
    }
  }
  return hits;
}

// ── 양성대조 ────────────────────────────────────────────────────────────
function selftest() {
  const results = [];

  // ① 소스에 «코드로» 박힌 이모지
  const needle1 = runSource({ srcOverrides: { 'src/lib/format.ts': "export const NEEDLE = '\u{1F953}';\n" } });
  results.push(['① 소스 리터럴 이모지', needle1.some((h) => h.ch === '\u{1F953}')]);

  // ② ★주석 안의 이모지는 «잡히면 안 된다»(음성대조 — 헛수 방지)
  const neg = runSource({ srcOverrides: { 'src/lib/format.ts': "/* \u{1F953} 주석 안 */\n// \u{1F953} 한 줄 주석\nexport const X = 1;\n" } });
  results.push(['② 주석 안 이모지는 «안» 잡힌다(음성대조)', !neg.some((h) => h.ch === '\u{1F953}')]);

  // ③ ★이스케이프된 이모지 — «해제 후»에 잡히는가
  const esc = '\\ud83e\\udd53';
  const escHits = scanText(`const a = "${esc}";`, { unescape: true });
  results.push(['③ \\uXXXX 이스케이프 해제 후 검출', escHits.some((h) => h.ch === '\u{1F953}')]);

  // ④ ★해제를 «안 하면» 못 잡는다 — 그래서 dist 모드가 해제를 «반드시» 한다는 증명
  const noEsc = scanText(`const a = "${esc}";`, { unescape: false });
  results.push(['④ 해제 안 하면 못 잡는다(그래서 필수)', noEsc.length === 0]);

  // ⑤ 문서 기호는 «범위 밖»이라 면제가 필요 없다 — 명단이 아니라 규칙으로 확인한다
  results.push([
    '⑤ 문서 기호(★ ● ○ → ⇒ ↔ ⚠)는 «안» 잡힌다(음성대조)',
    ['★', '●', '○', '→', '⇒', '↔', '⚠'].every((c) => scanText(`const a = "${c}";`).length === 0),
  ]);

  // ⑥ ★ALLOW 는 «살아 있는가» — 명단의 모든 원소가 EMOJI_RE 에 실제로 잡혀야 한다.
  //   ⛔이게 없으면 「명단에 근거까지 적힌 죽은 면제」가 생긴다. ✓ 가 정확히 그랬다.
  //   ⛔`scanText` 로 재면 «틀린다» — 그 함수가 ALLOW 를 걸러내므로 명단은 «항상» 0건이 된다.
  //     (실제로 첫 판에 그렇게 짰다가 ⛔·✅ 가 죽은 면제로 나왔다.) ⇒ 원본 정규식에 직접 묻는다.
  const deadAllows = [...ALLOW].filter((c) => {
    EMOJI_RE.lastIndex = 0;
    return !EMOJI_RE.test(c);
  });
  results.push([`⑥ ★ALLOW ${ALLOW.size}종이 전부 «잡히는» 문자다(죽은 면제 0)`, deadAllows.length === 0]);
  if (deadAllows.length) console.log(`      죽은 면제: ${deadAllows.join(' ')}`);

  // ⑦⑧ ★✓ — «코드»에 있으면 잡히고, «주석»에 있으면 안 잡힌다.
  //   ★니들을 문자 그대로 쓰지 않고 코드포인트로 «만든다» — 이 파일 자신이
  //     검사 대상(src)이 아니라 상관없지만, 니들과 본문이 눈으로 구분되게 하려는 것이다.
  //   ⛔니들 결과를 «전체 스캔»에서 찾으면 안 된다 — 다른 파일에 같은 문자가 하나라도
  //     있으면 음성대조가 그 문자를 보고 «잡혔다»고 오판한다(실제로 app.css 주석에서 났다).
  //     ⇒ 니들을 «심은 파일»로 좁혀서 센다.
  const CK = String.fromCharCode(0x2713);
  const NEEDLE_FILE = 'src/lib/format.ts';
  const inNeedle = (hits) => hits.filter((h) => h.file === NEEDLE_FILE && h.ch === CK);
  const ckCode = runSource({ srcOverrides: { [NEEDLE_FILE]: `export const N = '${CK} ok';\n` } });
  results.push(['⑦ ✓(U+2713) 가 코드에 있으면 잡힌다', inNeedle(ckCode).length > 0]);
  const ckCmt = runSource({ srcOverrides: { [NEEDLE_FILE]: `/* ${CK} 주석 */\n// ${CK}\nexport const X = 1;\n` } });
  results.push(['⑧ ✓ 가 주석에 있으면 «안» 잡힌다(음성대조)', inNeedle(ckCmt).length === 0]);

  console.log('emoji checker — 양성/음성 대조');
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
}

if (SELFTEST) {
  selftest();
} else {
  const hits = DIST_MODE ? runDist() : runSource();
  const where = DIST_MODE ? `번들(${process.env.ML_DIST || 'dist'}) · 이스케이프 해제 후` : '소스 · 주석 제외';
  console.log(`이모지 검사 — ${where}`);
  if (hits.length === 0) {
    console.log(`  0건 (허용 명단 ${ALLOW.size}종 제외)`);
    process.exit(0);
  }
  const byChar = new Map();
  for (const h of hits) byChar.set(h.ch, (byChar.get(h.ch) ?? 0) + 1);
  for (const h of hits.slice(0, 60)) console.log(`  ${h.file}:${h.line}  ${h.ch} (${h.code})  | ${h.ctx}`);
  if (hits.length > 60) console.log(`  … 외 ${hits.length - 60}건`);
  console.log(`\n종류 ${byChar.size}종 · 총 ${hits.length}건`);
  console.error('FAILED: UI 에 이모지가 남아 있다. SVG 아이콘(Primitives.Icon / ConceptBadge)으로 바꿔라.');
  process.exit(1);
}
