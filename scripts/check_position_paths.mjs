#!/usr/bin/env node
/**
 * ★포지션 타입 «경로 누락» 검사기 (2026-08-20 파생 4종 작업에서 도출).
 *
 * ── 왜 필요한가 (실사고) ────────────────────────────────────────────────
 * 선도·스왑을 추가하면서 생성·평가·정산·저장·복원·취소는 챙겼는데
 * ★`rescaleAccounts`(새로고침 복귀 시 가격 축척 맞추기) «한 경로»를 빠뜨렸다.
 * 결과는 「복귀하면 선도 손익만 이상한」 버그 — 에러가 안 나고 재현도 어렵다.
 * ★근본 원인은 부주의가 아니라 «새 포지션 타입이 몇 개의 경로를 지나야 하는지
 *   아무 데도 안 적혀 있다»는 것이다. 그래서 아는 사람만 다 챙긴다.
 * ⇒ 이 검사기가 그 목록을 «강제»한다.
 *
 * ── 쓰는 법 ─────────────────────────────────────────────────────────────
 *   node scripts/check_position_paths.mjs
 *   실패하면 exit 1. CI 에 걸어도 된다.
 *
 * ── 새 포지션 타입을 추가한다면 ─────────────────────────────────────────
 *   1) 아래 KINDS 에 «컬렉션 이름»을 추가한다
 *   2) 검사기를 돌린다 → 빠진 경로가 전부 나온다
 *   3) 의도적으로 안 지나는 경로는 EXPECTED_ABSENT 에 «이유와 함께» 적는다
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = process.env.ENGINE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'engine');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** 계정이 들고 있는 포지션 컬렉션 = 「포지션 타입」 */
const KINDS = ['levPositions', 'optPositions', 'fwdPositions', 'swapPositions'];

/** ★반드시 지나야 하는 경로 (파일 · 함수 · 왜) */
const PATHS = [
  ['world.ts', 'createAccount', '생성 — 계정에 빈 컬렉션이 있어야 한다'],
  ['world.ts', 'equity', '평가 — 총자산에 반영돼야 한다'],
  ['gameWorld.ts', 'serialize', '저장 — 직렬화돼야 한다'],
  ['gameWorld.ts', 'deserialize', '복원 — 역직렬화돼야 한다'],
  ['gameWorld.ts', 'resetPlayer', '초기화 — 로그아웃 시 비워져야 한다'],
  ['gameWorld.ts', 'rescaleAccounts', '★가격 재축척 — 복귀 시 손익이 보존돼야 한다'],
  ['persistence.ts', 'loadGame', '저장본 하드닝 — 손상돼도 살릴 수 있어야 한다'],
];

/** 타입별 «필수 연산» — 이름 존재만 확인한다 */
const OPS = {
  levPositions: ['openLeverage', 'closeLeverage', 'cancelLeverage', 'settleExpiredFutures'],
  optPositions: [
    'buyOption',
    'writeOption',
    'sellOption',
    'buybackOption',
    'cancelOption',
    'settleExpiredOptions',
  ],
  fwdPositions: ['openForward', 'closeForward', 'cancelForward', 'settleExpiredForwards'],
  swapPositions: ['openSwap', 'closeSwap', 'cancelSwap', 'settleExpiredSwaps'],
};

/**
 * ★정산 «이벤트»를 흘려야 하는 경로 (2026-08-21 추가).
 *
 * ★왜: 엔진이 만기에 포지션을 delete 하면 화면에서 카드가 «그냥 사라진다».
 *   정산은 손익이 확정되는 순간인데 유저가 아무것도 못 본다 — 「조용히 일어나는 일」의 UI 버전이다.
 *   ⇒ 각 정산 함수는 `type: 'settled'` 이벤트를 반드시 emit 해야 한다.
 */
const EMIT_PATHS = [
  ['world.ts', 'settleExpiredForwards', '선도 만기'],
  ['world.ts', 'settleExpiredSwaps', '스왑 만기'],
  ['world.ts', 'settleExpiredFutures', '선물 만기'],
  ['world.ts', 'settleExpiredOptions', '옵션 만기(매수·매도)'],
  ['world.ts', 'checkLiquidations', '옵션 매도 강제 정리'],
];

/**
 * ★P1 «포지션 색인» 등록 경로 (2026-08-22 신설).
 *
 * ⛔왜: `checkLiquidations`·`settleExpired*` 는 이제 «전 계정»이 아니라
 *   `positionHolders()`(색인)만 훑는다. 포지션이 생기는 경로가 색인에 등록하지 «않으면»
 *   그 포지션은 ★청산도 만기정산도 «영영 안 된다». 에러가 나지 않는다 — 조용히 안 돈다.
 *
 * ★★특히 `gameWorld.deserialize` 가 위험하다. 거기서는 Map 을 «통째로 갈아끼우므로»
 *   개시 경로를 타지 않는다. 그리고 ⛔**`verify_save_compat.py`(저장본 4세대 대조)는
 *   이걸 «못 잡는다»** — 복원 «직후» 값만 보고 만기까지 진행하지 않기 때문이다.
 *   (실측: `run.mjs restoreidx` — 등록을 빼면 만기가 지나도 포지션이 그대로 남는다)
 *   ⇒ 그래서 «문서»가 아니라 여기 «검사»로 둔다.
 */
/**
 * ⛔★orderFlow 를 «넣으면 안 되는» 경로 (2026-08-22 무한돈 사고 대응).
 *
 * 인계문서 ⛔10: 「선도·스왑은 addOrderFlow 를 넣지 않는다 — 넣으면 «체결가에 자기 임팩트를
 *   물지 않으면서 가격만 미는» 경로가 생겨 fillPrice 로 막아둔 자가펌핑이 부활한다」
 * ★그 규율이 «있었는데 옵션만 안 따랐다». 그래서 라이브에 무한돈이 났다
 *   (시드 $10,000 이 6.7분에 +685%).
 * ⇒ 이제 옵션도 넣지 않는다. **그리고 다시 넣을 수 없게 여기서 «센다».**
 * ⛔이 명단에서 항목을 빼려면 그 상품의 왕복 EV 가 «전 조합에서» 음수임을 먼저 실측하라
 *   (`run.mjs optpump` · `run.mjs divarb`).
 */
const NO_FLOW_PATHS = [
  ['world.ts', 'buyOption', '옵션 매수 — 델타헤지 물량을 밀면 자가펌핑이 부활한다'],
  ['world.ts', 'writeOption', '옵션 매도 — 위와 같다(부호만 반대)'],
  ['world.ts', 'sellOption', '옵션 전매 — 넣을 것도 되감을 것도 없어야 한다'],
  ['world.ts', 'buybackOption', '옵션 되사기 — 같다'],
  ['world.ts', 'openForward', '선도 — ⛔10 원문'],
  ['world.ts', 'openSwap', '스왑 — ⛔10 원문'],
  ['world.ts', 'closeForward', '선도 청산'],
  ['world.ts', 'closeSwap', '스왑 청산'],
];

const INDEX_PATHS = [
  ['world.ts', 'openLeverage', '레버리지·선물 개시'],
  ['world.ts', 'buyOption', '옵션 매수'],
  ['world.ts', 'writeOption', '옵션 매도'],
  ['world.ts', 'openForward', '선도 개시'],
  ['world.ts', 'openSwap', '스왑 개시'],
  ['gameWorld.ts', 'deserialize', '★저장본 복원 — 개시 경로를 «안» 탄다'],
];

/**
 * ★의도적으로 «안» 지나는 경로 — 이유 없이는 여기 못 적는다.
 * key = `${함수}:${컬렉션}`
 */
const EXPECTED_ABSENT = {
  'checkLiquidations:fwdPositions':
    '선도는 손실 상한이 증거금이다(정산이 max(0, margin+pnl)). 강제청산이 불필요하다.',
  'checkLiquidations:swapPositions': '스왑도 같다 — 손실 상한이 증거금이다.',
  'portfolio:fwdPositions':
    'lib/types.ts 의 Portfolio 는 UI 레인 소유라 건드리지 않았다. forwardViews() 로 노출한다.',
  'portfolio:swapPositions': '위와 같다 — swapViews() 로 노출한다.',
};

/**
 * 함수 본문을 중괄호 짝으로 뽑는다.
 * ★정규식을 쓰지 않는다 — 이스케이프 사고가 이 파일에서만 세 번 났다. 문자열 탐색이면 그럴 일이 없다.
 */
function body(src, fnName) {
  const NL = String.fromCharCode(10);
  const prefixes = [NL + '  ', NL + '    ', NL + '  private ', NL + '  async ', NL + 'function ', NL + 'export function '];
  let at = -1;
  for (const pre of prefixes) {
    const i = src.indexOf(pre + fnName + '(');
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return null;
}

const files = {
  'world.ts': read('world.ts'),
  'gameWorld.ts': read('gameWorld.ts'),
  'persistence.ts': read('persistence.ts'),
};
const all = Object.values(files).join(String.fromCharCode(10));
const problems = [];
const rows = [];

for (const [file, fn, why] of PATHS) {
  const b = body(files[file], fn);
  if (b === null) {
    problems.push('✗ 경로 함수를 못 찾음: ' + file + ' :: ' + fn + '()  — 이름이 바뀌었나? 검사기를 고쳐라');
    continue;
  }
  const cells = KINDS.map((k) => {
    const ok = b.includes(k);
    const excused = EXPECTED_ABSENT[fn + ':' + k];
    if (!ok && !excused) problems.push('✗ ' + file + ' :: ' + fn + '() 가 ' + k + ' 를 «안 다룬다»  (' + why + ')');
    return ok ? 'O' : excused ? '-' : '✗';
  });
  rows.push([fn + '()', ...cells]);
}

const emitRows = [];
for (const [file, fn, why] of EMIT_PATHS) {
  const b2 = body(files[file], fn);
  if (b2 === null) {
    problems.push('✗ 정산 경로 함수를 못 찾음: ' + file + ' :: ' + fn + '()');
    continue;
  }
  const ok = b2.includes("type: 'settled'");
  if (!ok) problems.push('✗ ' + file + ' :: ' + fn + '() 이 정산 이벤트를 «안 흘린다»  (' + why + ')');
  emitRows.push([fn + '()', ok ? 'O' : '✗', why]);
}

const noFlowRows = [];
for (const [file, fn, why] of NO_FLOW_PATHS) {
  const b4 = body(files[file], fn);
  if (b4 === null) {
    problems.push('✗ orderFlow 금지 경로 함수를 못 찾음: ' + file + ' :: ' + fn + '()');
    continue;
  }
  const n = b4.split('addOrderFlow(').length - 1;
  if (n > 0) {
    problems.push('✗ ★' + file + ' :: ' + fn + '() 이 addOrderFlow 를 ' + n +
      '회 «넣는다» — 자가펌핑 경로다  (' + why + ')');
  }
  noFlowRows.push([fn + '()', n === 0 ? 'O' : '✗ ' + n, why]);
}

const indexRows = [];
for (const [file, fn, why] of INDEX_PATHS) {
  const b3 = body(files[file], fn);
  if (b3 === null) {
    problems.push('✗ 색인 경로 함수를 못 찾음: ' + file + ' :: ' + fn + '()');
    continue;
  }
  const ok = b3.includes('trackPositions(');
  if (!ok) {
    problems.push('✗ ' + file + ' :: ' + fn + '() 이 trackPositions() 를 «안 부른다»  (' + why +
      ')  -> 이 경로로 생긴 포지션은 청산·정산이 «조용히» 안 돈다');
  }
  indexRows.push([fn + '()', ok ? 'O' : '✗', why]);
}

for (const [kind, ops] of Object.entries(OPS)) {
  for (const op of ops) {
    if (!all.includes(op + '(')) problems.push('✗ ' + kind + ': 필수 연산 ' + op + '() 이 없다');
  }
}

const W = [24, 16, 16, 16, 16];
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('');
console.log('포지션 타입 × 필수 경로   (O=처리 · -=의도적 제외 · ✗=누락)');
console.log('');
console.log(pad('경로', W[0]) + KINDS.map((k, i) => pad(k, W[i + 1])).join(''));
console.log('-'.repeat(W.reduce((a, b) => a + b, 0)));
for (const r of rows) console.log(pad(r[0], W[0]) + r.slice(1).map((c, i) => pad(c, W[i + 1])).join(''));

console.log('');
console.log('정산 이벤트 emit   (O=흘림 · ✗=조용히 사라짐)');
console.log('');
for (const r of emitRows) console.log(pad(r[0], 30) + pad(r[1], 8) + r[2]);

if (problems.length) {
  console.log('');
  console.log(problems.join(String.fromCharCode(10)));
  console.log('');
  console.log('✗ ' + problems.length + '건 누락. 위 경로를 채워라.');
  process.exit(1);
}
console.log('');
console.log('✓ 전 포지션 타입이 필수 경로를 모두 지난다.');
