#!/usr/bin/env node
/**
 * ★「되돌리기가 «없는» 주문 경로」가 0 임을 ★구조로 확인한다.
 *
 *   node scripts/check_undo_paths.mjs
 *   node scripts/check_undo_paths.mjs --selftest   (★양성대조 먼저)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 필요한가 (President 지시의 «전제»를 지키는 장치다)
 *
 *   이 앱은 주문 «확인창»을 전부 없앴다(President 2026-08-19).
 *   그 결정의 전제가 ★「대신 되돌리기가 있다」였다 — 마찰을 «주문 전»에서
 *   «주문 후 5초»로 «옮긴» 것이지 «없앤» 게 아니다.
 *   ⇒ 되돌리기가 빠진 경로가 하나라도 생기면 ★그 상품만 «오조작 복구 수단이 0» 이 된다.
 *
 *   ★그리고 그건 «실제로 일어났다»: 파생 4종을 붙일 때 4종 중 ★3종에 cancel 이 없었고,
 *   옵션 «매도»는 cancelOption 이 «매수 식»을 써서 되돌리기 한 번에 약 $3,055 가 어긋났다
 *   (에러 없이 숫자만 틀리는 종류). 화면을 늘리다 조용히 빠뜨리는 걸 사람이 막을 수 없다.
 *
 * ★검사 내용
 *   ① 주문 «커밋» 호출부(`s.commitOrder(..., () => s.X(...))`)가 부르는 X 를 전수 수집
 *   ② 각 X 가 store 에서 `Promise<UndoHandle>` 을 돌려주는지
 *   ③ 그 본문이 실제로 `undo: () => ...` 를 만드는지 (선언만 하고 안 만드는 걸 막는다)
 *   ④ 그 undo 가 부르는 엔진 cancel* 이 gameWorld 에 «존재»하는지
 *   ⑤ ★필수 상품 목록이 전부 덮였는지 (현물·레버리지·선물·옵션매수·옵션매도·선도·스왑)
 *
 * 종료 코드: 0 = 통과, 1 = 실패.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'src');

/**
 * ★반드시 되돌릴 수 있어야 하는 «주문 경로» 7종.
 * ★store 메서드 이름으로 적는다 — 화면 이름이 아니라 «원장을 바꾸는 함수»가 기준이다.
 * ⛔여기서 항목을 빼려면 「그 상품은 되돌리기가 필요 없다」를 President 가 정해야 한다.
 */
const REQUIRED = {
  현물: 'orderSpot',
  레버리지: 'openLeverage',
  선물: 'openFutures',
  옵션매수: 'buyOption',
  옵션매도: 'writeOption',
  선도: 'openForward',
  스왑: 'openSwap',
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'locales') continue;
      walk(p, out);
    } else if (['.ts', '.tsx'].includes(extname(name))) out.push(p);
  }
  return out;
}

/** `async name(...): Promise<UndoHandle> { ... }` 의 본문을 중괄호 균형으로 잘라 온다 */
function methodBody(src, name) {
  const re = new RegExp(`async ${name}\\s*\\(`);
  const m = src.match(re);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf('Promise<', m.index) >= 0 ? src.indexOf('Promise<', m.index) : m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

function run({ storeOverride, gwOverride } = {}) {
  const errors = [];
  const rows = [];
  const store = storeOverride ?? readFileSync(resolve(SRC, 'store/store.ts'), 'utf8');
  const gw = gwOverride ?? readFileSync(resolve(SRC, 'lib/engine/gameWorld.ts'), 'utf8');

  // ── ① 화면이 «실제로» commitOrder 에 물리는 메서드 수집 ─────────────
  const committed = new Set();
  for (const f of walk(SRC)) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('commitOrder')) continue;
    for (const m of src.matchAll(/commitOrder\(([\s\S]{0,600}?)\n\s*\);/g)) {
      for (const c of m[1].matchAll(/\bs\.(\w+)\(/g)) {
        if (c[1] !== 'commitOrder') committed.add(c[1]);
      }
    }
  }

  // ── ②③④ 각 필수 경로 검사 ──────────────────────────────────────────
  for (const [label, fn] of Object.entries(REQUIRED)) {
    const declared = new RegExp(`async ${fn}\\s*\\(`).test(store);
    const returnsUndo = new RegExp(`async ${fn}\\s*\\([\\s\\S]{0,400}?Promise<UndoHandle>`).test(store);
    const body = methodBody(store, fn);
    const makesUndo = Boolean(body && /undo:\s*\(\)\s*=>/.test(body));
    const cancels = body ? [...body.matchAll(/this\.world\.(cancel\w+)\(/g)].map((x) => x[1]) : [];
    const cancelsExist = cancels.length > 0 && cancels.every((c) => new RegExp(`\\b${c}\\s*\\(`).test(gw));
    const used = committed.has(fn);

    rows.push({ label, fn, declared, returnsUndo, makesUndo, cancels, cancelsExist, used });
    if (!declared) errors.push(`[없음] ${label}: store.${fn}() 이 없다`);
    else if (!returnsUndo) errors.push(`[되돌리기 없음] ${label}: store.${fn}() 이 Promise<UndoHandle> 이 아니다`);
    else if (!makesUndo) errors.push(`[되돌리기 없음] ${label}: store.${fn}() 본문이 undo 를 만들지 않는다`);
    else if (!cancelsExist)
      errors.push(`[엔진 없음] ${label}: undo 가 부르는 ${cancels.join(',') || '(없음)'} 이 gameWorld 에 없다`);
    if (declared && !used) errors.push(`[미배선] ${label}: store.${fn}() 이 commitOrder 경로에 «물려 있지 않다»`);
  }

  return { errors, rows };
}

// ── 양성대조 ────────────────────────────────────────────────────────────
function selftest() {
  const store = readFileSync(resolve(SRC, 'store/store.ts'), 'utf8');
  const gw = readFileSync(resolve(SRC, 'lib/engine/gameWorld.ts'), 'utf8');
  const results = [];

  /*
   * ★★니들을 «실제로 주입했는지»부터 확인한다.
   *
   * ★실사고(2026-08-21): 거래 일지 기록이 들어가면서 `openForward` 본문이 길어졌고,
   *   아래 정규식의 창 {0,600} 을 넘겨 ★니들이 «아예 주입되지 않았다».
   *   그러면 원본과 «같은 소스»를 검사하게 된다 — 이번엔 운 좋게 MISSED 로 드러났지만,
   *   니들이 우연히 다른 에러를 만드는 형태였다면 ★«CAUGHT 로 조용히 통과»했을 것이다.
   *   ⇒ 「니들이 안 잡혔다」와 「니들을 넣지도 못했다」는 ★다른 고장이다. 갈라서 말한다.
   */
  const injected = (before, after, what) => {
    if (before === after) {
      console.error(`\nFAILED: 니들 «주입» 자체가 실패했다 (${what}) — 검사 대상이 아니라 «니들»이 낡았다`);
      process.exit(1);
    }
    return after;
  };

  // ① 되돌리기를 «만들지 않는» 주문 — 실제로 파생 4종에서 일어난 형태
  const cut = injected(
    store,
    store.replace(
      /(async openForward[\s\S]{0,4000}?)return \{ undo: \(\) => [^\n]*\n/,
      '$1return { undoX: () => false };\n'
    ),
    'store.openForward 의 undo 생성부'
  );
  results.push(['① 되돌리기 미생성', run({ storeOverride: cut }).errors.some((e) => e.includes('openForward'))]);

  // ② 엔진 cancel 이 «없어진» 경우 — 파생 레인이 넣기 «전»의 상태
  const gwCut = injected(gw, gw.replace(/cancelSwap\s*\(/g, 'cancelSwapREMOVED('), 'gameWorld.cancelSwap');
  results.push(['② 엔진 cancel 부재', run({ gwOverride: gwCut }).errors.some((e) => e.startsWith('[엔진 없음]'))]);

  // ③ 상품은 있는데 «화면에 안 물린» 경우
  const noCommit = injected(
    store,
    store.replace(/async writeOption\s*\(/, 'async writeOptionUNUSED('),
    'store.writeOption'
  );
  results.push(['③ store 메서드 부재', run({ storeOverride: noCommit }).errors.some((e) => e.includes('옵션매도'))]);

  console.log('undo path checker — 양성대조');
  let ok = true;
  for (const [n, caught] of results) {
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${n}`);
    if (!caught) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 니들을 놓쳤다. 이 검사기의 「7/7」은 «부재의 증거가 아니다».');
    process.exit(1);
  }
  console.log('\nOK: 니들 3종 전부 잡힘 — 검사기가 살아 있다.');
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  const { errors, rows } = run();
  console.log('되돌리기 경로 검사 (확인창을 없앤 «전제»를 지키는 장치)');
  console.log('  상품        store 메서드      UndoHandle  undo생성  엔진 cancel        화면배선');
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(10)}  ${r.fn.padEnd(16)}  ${(r.returnsUndo ? 'O' : 'X').padEnd(10)}  ${(r.makesUndo ? 'O' : 'X').padEnd(8)}  ${(r.cancels.join(',') || '-').padEnd(18)}  ${r.used ? 'O' : 'X'}`
    );
  }
  const okCount = rows.filter((r) => r.returnsUndo && r.makesUndo && r.cancelsExist && r.used).length;
  for (const e of errors) console.error(`FAIL  ${e}`);
  if (errors.length) {
    console.error(`\nFAILED: ${okCount}/${rows.length} — ⛔되돌리기가 없는 주문 경로가 있다. 빌드하지 마라.`);
    process.exit(1);
  }
  console.log(`\n✓ 주문 경로 ${okCount}/${rows.length} 전부 되돌릴 수 있다.`);
}
