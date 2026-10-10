#!/usr/bin/env node
/**
 * ★계측 페이로드에 «사람을 알아볼 수 있는 값»이 섞이는 것을 빌드에서 막는다.
 *
 *   node scripts/check_analytics.mjs
 *   node scripts/check_analytics.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★왜 검사기여야 하나
 * ═══════════════════════════════════════════════════════════════════════
 *   계측은 호출 지점이 20곳이고 «나중에 한 줄 더 넣는» 방식으로 자란다.
 *   사람이 매번 「이 값 보내도 되나」를 기억할 수 없다 — U-4 「주석은 막지 못한다」.
 *   그리고 개인정보는 ★한 번 새면 되돌릴 수 없다. 사후 발견이 의미가 없는 종류다.
 *
 * ★★그리고 이 검사기는 ★코드와 «문서»를 묶는다.
 *   전송이 켜졌는데 `privacy.html` 에 이용 통계 문단이 없으면 FAIL 이다.
 *   ⇒ 「코드가 먼저 나가고 방침이 늦게 따라오는」 사고를 «구조적으로» 막는다.
 *     (그 사고가 이미 세 겹으로 나 있었다: 광고 SDK · 외부 통신 · 저장소 키 표)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★대상이 «아직 없을 때» (2026-08-22 현재)
 *   `src/lib/analytics.ts` 는 아직 없다(앱스인토스 Analytics 가용성 실측 대기).
 *   ⇒ ★그때 «조용히 0건」을 내지 않는다. `NOTE: 대상 부재` 를 «소리내어» 찍고 exit 0.
 *     ⛔「0건」과 「볼 게 없었다」는 다른 사실이다. 이 프로젝트가 반복해서 데인 그 형태다.
 *   ⇒ ★그래도 `--selftest` 는 «합성 소스»로 돌아간다. 대상이 생기기 «전»에도
 *     이 검사기가 살아 있음을 증명할 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★★이 검사기가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
 *
 *   1. ⛔**«값»이 아니라 «키 이름»을 본다.** `track('x', { note: user.nickname })` 처럼
 *      허용된 키에 금지된 «값»을 담으면 못 잡는다.
 *      ⇒ 그래서 ②-e 가 «리터럴만» 허용한다 — 변수를 통째로 넘기는 길을 막는다.
 *        그래도 「리터럴 키 + 위험한 표현식」은 남는다. ★사람의 검토가 필요한 잔여 구멍이다.
 *   2. ⛔**전송된 것을 «보지» 않는다.** 소스 정적 검사다. 어댑터가 몰래 다른 걸 붙이면 못 잡는다.
 *      ⇒ 그 층은 하네스(실행 중 큐를 들여다보는 실측)가 봐야 한다.
 *   3. ⛔**호출 «누락»은 못 잡는다.** 「이 지점에 track 이 있어야 한다」는 검사하지 않는다.
 *      ⇒ 깔때기가 비면 데이터로 드러난다. 검사기가 아니라 «지표»가 잡는 층이다.
 *   4. ⛔**동적 이벤트 이름을 못 본다.** `track(name, …)` 형태는 정적 추출 불가다.
 *      ⇒ ②-f 가 그런 호출을 «있으면 FAIL» 로 막는다. 못 보는 것을 «금지»로 바꿨다.
 *   5. ⛔**방침 문구가 «정확한지»는 안 본다.** 이용 통계 문단이 «존재하는지»만 본다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패. 순수 node, 네트워크·설치 불필요.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'src');
const ANALYTICS = resolve(ROOT, 'src/lib/analytics.ts');
const PRIVACY = resolve(ROOT, 'public/privacy.html');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/**
 * ★금지 필드 — ⛔모양 규칙이 아니라 «명단»이다. 세어볼 수 있어야 한다.
 * 늘릴 때는 «왜»를 옆에 적어라.
 */
const FORBIDDEN = new Map([
  ['nickname', '표시명 — 유저가 직접 정한 문자열이라 재식별 가능'],
  ['nick', '위와 같다'],
  ['cash', '절대금액 — 시계열로 모으면 개인을 특정할 수 있다'],
  ['equity', '위와 같다'],
  ['balance', '위와 같다'],
  ['realizedPnl', '위와 같다'],
  ['feesPaid', '위와 같다'],
  ['notional', '주문 «내용»'],
  ['margin', '주문 «내용»'],
  ['strike', '주문 «내용»'],
  ['price', '주문 «내용»'],
  ['userKey', '토스 식별키 — 방침에 「게임 데이터의 식별자로 쓰지 않는다」고 명시돼 있다'],
  ['tossUserKey', '위와 같다'],
  ['anonymousKey', '위와 같다'],
]);

/** 「수량으로 읽히는」 키 — `ticker` 와 «같이» 오면 주문 재구성이 된다 */
const QUANTITY_LIKE = ['qty', 'shares', 'contracts', 'amount', 'count', 'size'];

/** 유일하게 허용된 식별자 */
const ALLOWED_ID = 'ml:localAnonId';

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'locales') continue;
      walkFiles(p, out);
    } else if (['.ts', '.tsx'].includes(extname(name))) {
      out.push({ path: relative(ROOT, p).split('\\').join('/'), src: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

/**
 * `src/lib/analytics.ts` 의 이벤트 표를 «파싱»한다.
 * ⛔검사기에 이벤트 목록을 다시 적지 «않는다» — 두 벌이 되면 갈린다.
 * 기대 형태:  export const EVENTS = { app_open: ['inToss','lang'], … } as const;
 */
function parseEventTable(src) {
  const m = src.match(/export const EVENTS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!m) return null;
  const table = new Map();
  for (const e of m[1].matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    const props = [...e[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    table.set(e[1], props);
  }
  return table;
}

/** `track('name', { a, b })` 호출을 전수 수확한다 */
function findTrackCalls(src) {
  const out = [];
  for (const m of src.matchAll(/\btrack\(\s*([\s\S]{0,400}?)\)\s*;/g)) {
    const body = m[1];
    const nameM = body.match(/^\s*'([^']+)'/);
    if (!nameM) {
      out.push({ name: null, props: [], nonLiteralName: true, spread: false, nonLiteralProps: false });
      continue;
    }
    const rest = body.slice(nameM[0].length).replace(/^\s*,\s*/, '');
    if (rest.trim() === '') {
      out.push({ name: nameM[1], props: [], nonLiteralName: false, spread: false, nonLiteralProps: false });
      continue;
    }
    const objM = rest.match(/^\{([\s\S]*)\}\s*$/);
    if (!objM) {
      out.push({ name: nameM[1], props: [], nonLiteralName: false, spread: false, nonLiteralProps: true });
      continue;
    }
    const inner = objM[1];
    const spread = /\.\.\./.test(inner);
    const props = [];
    /*
     * 최상위 키만 센다 — 중첩은 ②-g 가 «금지»로 막는다.
     * ⛔`matchAll(/(?:^|,)\s*(\w+)/g)` 로 세지 «마라»: 앞 매치가 쉼표를 «먹어»
     *   두 번째 키부터 못 읽는다. 실제로 그렇게 짜서 ★대조 4종이 한꺼번에 MISSED 였다
     *   (「정상인데 잡힌다」 + 「금지 조합인데 못 잡는다」가 «같은 원인»이었다).
     * ⇒ 쉼표로 «쪼개서» 읽는다. 중첩이 금지라 최상위 쉼표만 존재한다.
     */
    for (const piece of inner.split(',')) {
      const k = piece.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) props.push(k);
    }
    out.push({ name: nameM[1], props, nonLiteralName: false, spread, nonLiteralProps: false, inner });
  }
  return out;
}

function run({ analyticsSrc, files, privacyHtml, transportForced = null }) {
  const errs = [];
  const table = parseEventTable(analyticsSrc);
  if (!table) {
    errs.push('analytics.ts 에서 EVENTS 표를 못 찾았다 — 이름이 바뀌었으면 검사기를 고쳐라');
    return { errs, table: new Map() };
  }

  for (const f of files) {
    for (const c of findTrackCalls(f.src)) {
      /* ②-f 동적 이벤트 이름 — 정적 추출 불가라 «금지»로 바꿨다 */
      if (c.nonLiteralName) {
        errs.push(`${f.path}: 이벤트 이름이 리터럴이 아니다 — 정적 검사가 불가능해진다`);
        continue;
      }
      /* ②-a 정의에 없는 이벤트 */
      if (!table.has(c.name)) {
        errs.push(`${f.path}: 정의에 없는 이벤트 '${c.name}' — EVENTS 표에 먼저 적어라`);
        continue;
      }
      /* ②-e 리터럴이 아닌 페이로드 · 전개 */
      if (c.nonLiteralProps) {
        errs.push(`${f.path}: '${c.name}' 의 페이로드가 «리터럴»이 아니다 — 무엇이 갈지 알 수 없다`);
        continue;
      }
      if (c.spread) {
        errs.push(`${f.path}: '${c.name}' 에 «전개(...)»가 있다 — 무엇이 갈지 알 수 없다`);
        continue;
      }
      /* ②-g 중첩 객체 — 최상위만 세므로 안쪽이 사각지대가 된다. 금지로 막는다 */
      if (c.inner && /:\s*\{/.test(c.inner)) {
        errs.push(`${f.path}: '${c.name}' 에 «중첩 객체»가 있다 — 최상위만 검사하므로 금지한다`);
        continue;
      }
      /* ②-c 금지 필드 */
      for (const k of c.props) {
        if (FORBIDDEN.has(k)) errs.push(`${f.path}: '${c.name}' 에 금지 필드 '${k}' (${FORBIDDEN.get(k)})`);
      }
      /* ②-d ★종목 «단독»은 허용. `ticker` + 수량 «조합»만 금지 */
      if (c.props.includes('ticker') && c.props.some((k) => QUANTITY_LIKE.includes(k))) {
        errs.push(`${f.path}: '${c.name}' 이 종목과 수량을 «같이» 보낸다 — 주문이 재구성된다`);
      }
      /* ②-b props 가 정의와 «정확히» 일치하는가 */
      const want = table.get(c.name);
      const extra = c.props.filter((k) => !want.includes(k));
      const miss = want.filter((k) => !c.props.includes(k));
      if (extra.length) errs.push(`${f.path}: '${c.name}' 에 정의에 없는 키 ${extra.join(',')}`);
      if (miss.length) errs.push(`${f.path}: '${c.name}' 에 정의된 키가 빠졌다 ${miss.join(',')}`);
    }
  }

  /* ③ ★식별자 단일성 — analytics.ts «밖»에서 로컬 식별자를 읽거나 새로 만들지 않는다 */
  for (const f of files) {
    if (f.path.endsWith('lib/analytics.ts')) continue;
    if (f.src.includes(ALLOWED_ID) && /track\(/.test(f.src)) {
      errs.push(`${f.path}: 계측 식별자(${ALLOWED_ID})를 analytics.ts «밖»에서 읽는다`);
    }
  }
  if (/crypto\.randomUUID|Math\.random\(\)\.toString\(36\)/.test(analyticsSrc) &&
      !analyticsSrc.includes(ALLOWED_ID)) {
    errs.push(`analytics.ts: 새 식별자를 «만든다» — 기존 ${ALLOWED_ID} 를 재사용해야 한다`);
  }

  /* ④ ★전송이 켜졌는데 방침이 안 따라왔으면 FAIL — 코드와 문서를 «묶는다» */
  const transportOn = transportForced !== null
    ? transportForced
    : /export const TRANSPORT_ENABLED\s*=\s*true/.test(analyticsSrc);
  const privacyMentions = /이용 통계|usage analytics/i.test(privacyHtml);
  if (transportOn && !privacyMentions) {
    errs.push('★전송이 켜졌는데 privacy.html 에 「이용 통계」 문단이 없다 — 방침 갱신이 «먼저»다');
  }
  return { errs, table, transportOn };
}

/* ── 합성 소스 (대조용) ─────────────────────────────────────────────── */
const SYN_ANALYTICS = [
  "export const TRANSPORT_ENABLED = false;",
  "export const EVENTS = {",
  "  app_open: ['inToss', 'lang'],",
  "  order_done: ['product', 'side'],",
  "  screen_view: ['route', 'ticker'],",
  "} as const;",
  "const ID_KEY = 'ml:localAnonId';",
].join('\n');
const SYN_OK = [
  { path: 'syn/ok.ts', src: "track('app_open', { inToss, lang });\ntrack('order_done', { product, side });\ntrack('screen_view', { route, ticker });\n" },
];
/*
 * ⛔★이 «없음» 표본에 「이용 통계」라는 말이 들어가면 안 된다.
 *   처음에 '방침 원문 — 이용 통계 문단 없음' 이라고 써서 ★표본 자신이 그 낱말을 포함했고,
 *   그래서 대조 ⑪ 이 MISSED 로 죽었다. 검사기가 아니라 ★«대조 표본»이 틀린 것이다.
 *   (같은 형태를 어포던스 감사에서도 한 번 겪었다 — 니들이 틀릴 수 있다)
 */
const SYN_PRIVACY_NO = '<html>policy body without the phrase</html>';
const SYN_PRIVACY_YES = '<html>… 이용 통계 … usage analytics …</html>';

if (SELFTEST) {
  const R = [];
  const base = run({ analyticsSrc: SYN_ANALYTICS, files: SYN_OK, privacyHtml: SYN_PRIVACY_NO });
  R.push(['① 정상 페이로드는 «안» 잡힌다 — 음성대조', base.errs.length === 0]);
  R.push(['② EVENTS 표를 «소스에서» 읽는다(3종)', base.table.size === 3]);

  const bad = (src) => run({ analyticsSrc: SYN_ANALYTICS, files: [{ path: 'syn/x.ts', src }], privacyHtml: SYN_PRIVACY_NO }).errs;
  R.push(['③ ★금지 필드(nickname)를 잡는다', bad("track('app_open', { inToss, lang, nickname });").some((e) => e.includes('nickname'))]);
  R.push(['④ ★종목+수량 «조합»을 잡는다', bad("track('screen_view', { route, ticker, qty });").some((e) => e.includes('재구성'))]);
  R.push(['⑤ ★변수 전개(...)를 잡는다', bad("track('order_done', { ...p });").some((e) => e.includes('전개'))]);
  R.push(['⑥ ★리터럴 아닌 페이로드를 잡는다', bad("track('order_done', payload);").some((e) => e.includes('리터럴'))]);
  R.push(['⑦ ★정의에 없는 이벤트를 잡는다', bad("track('ghost_event', {});").some((e) => e.includes('ghost_event'))]);
  R.push(['⑧ ★정의와 키가 다르면 잡는다', bad("track('order_done', { product });").some((e) => e.includes('빠졌다'))]);
  R.push(['⑨ ★동적 이벤트 이름을 잡는다', bad("track(name, { product, side });").some((e) => e.includes('리터럴이 아니다'))]);
  R.push(['⑩ ★중첩 객체를 잡는다', bad("track('app_open', { inToss, lang: { deep: 1 } });").some((e) => e.includes('중첩'))]);

  /* ★★④ 코드-문서 결합 */
  const tOn = run({ analyticsSrc: SYN_ANALYTICS, files: SYN_OK, privacyHtml: SYN_PRIVACY_NO, transportForced: true });
  R.push(['⑪ ★★전송 켜짐 + 방침 미갱신 → 잡힌다', tOn.errs.some((e) => e.includes('방침 갱신이 «먼저»'))]);
  const tOnOk = run({ analyticsSrc: SYN_ANALYTICS, files: SYN_OK, privacyHtml: SYN_PRIVACY_YES, transportForced: true });
  R.push(['⑫ 음성대조 — 전송 켜짐 + 방침 갱신됨 → «안» 잡힌다', tOnOk.errs.length === 0]);

  /* 음성대조 — 종목 «단독» 은 허용 */
  R.push(['⑬ 음성대조 — 종목 «단독»은 «안» 잡힌다',
          bad("track('screen_view', { route, ticker });").length === 0]);

  console.log('계측 페이로드 검사기 — 양성/음성 대조 (★합성 소스로 «대상 부재»에서도 증명된다)');
  let ok = true;
  for (const r of R) {
    console.log('  ' + (r[1] ? 'CAUGHT' : 'MISSED') + '  ' + r[0]);
    if (!r[1]) ok = false;
  }
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    process.exit(1);
  }
  console.log('\nOK: 대조 ' + R.length + '종 전부 통과 — 검사기가 살아 있다.');
} else {
  console.log('계측 페이로드 검사 (금지 필드 · 종목+수량 조합 · 전개 · 코드↔방침 결합)');
  if (!existsSync(ANALYTICS)) {
    /* ⛔조용한 0건 금지 — 「볼 게 없었다」를 «소리내어» 말한다 */
    console.log('  NOTE: ★대상 부재 — src/lib/analytics.ts 가 아직 없다(앱스인토스 Analytics 가용성 대기).');
    console.log('        ⛔이건 「0건」이 아니라 「검사할 것이 없었다」다. 계측이 들어오면 자동으로 검사된다.');
    console.log('        ★그래도 --selftest 는 합성 소스로 «지금» 통과한다 — 검사기는 살아 있다.');
    process.exit(0);
  }
  const files = walkFiles(SRC);
  const { errs, table, transportOn } = run({
    analyticsSrc: readFileSync(ANALYTICS, 'utf8'),
    files,
    privacyHtml: existsSync(PRIVACY) ? readFileSync(PRIVACY, 'utf8') : '',
  });
  const calls = files.reduce((n, f) => n + findTrackCalls(f.src).length, 0);
  console.log('  이벤트 정의 ' + table.size + '종 · 호출 지점 ' + calls + '곳 · 전송 ' + (transportOn ? '★켜짐' : '꺼짐'));
  if (errs.length) {
    console.error('\nFAILED: ' + errs.length + '건');
    for (const e of errs) console.error('  -', e);
    process.exit(1);
  }
  console.log('\n  0건');
}
