#!/usr/bin/env node
/**
 * ★개인정보처리방침 §2 의 「기록하는 항목은 «다음이 전부입니다»」를 ★참인 채로 유지한다.
 *
 *   node scripts/check_privacy_keys.mjs
 *   node scripts/check_privacy_keys.mjs --selftest   (★양성/음성 대조 먼저)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★왜 이 검사기가 생겼나 (2026-08-22, 실측에서 도출)
 * ═══════════════════════════════════════════════════════════════════════
 *   `public/privacy.html` §2 는 「본 게임이 기기의 저장소에 기록하는 항목은
 *   **다음이 전부입니다**」라고 «단언»한다. 그런데 실측 결과:
 *
 *       문서에 적힌 것   9개
 *       코드가 쓰는 것  11개   → ★ml.journal · ml.traderwatch · ml.quotesession · ml.firstSeen 누락
 *
 *   ⇒ 넷 다 「세이브 블롭(ml.game)과 «다른 키»로 일부러 분리한 것」이다.
 *     `SAVE_VERSION` 을 안 건드리려고 분리했고, 그 판단은 옳았다.
 *     ★그런데 방침 갱신이 «같이 가지 않았다».
 *
 *   ★★이건 「트레이더 210명」이 1,000 → 3,310 으로 두 번 틀린 것과 ★«완전히 같은 형태»다:
 *     ★라벨이 코드보다 늦게 따라간다. 그리고 아무도 모른다 — 에러가 안 나니까.
 *
 *   ⛔풀이를 «문구를 무르게 하는 것»으로 하지 마라. 「등이 있습니다」로 흐리면
 *     개인정보처리방침으로서 «더 나쁘다». 이 문서는 완전해야 한다.
 *   ⇒ 그래서 ★검사기로 푼다. 문구는 「전부입니다」 그대로 두고, «그게 참인지»를 빌드가 센다.
 *     (U-4 「주석은 막지 못한다 — 구조를 바꾸거나 검사기를 만들어라」의 세 번째 적용)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★검사 내용
 *   ① 코드가 «실제로» 쓰는 저장소 키를 전수 수확 (`'ml.…'` · `'ml:…'` 리터럴)
 *   ② `privacy.html` 의 ko / en §2 표에서 `<code>` 키 목록을 파싱
 *   ③ ★양쪽을 «집합 비교» — 어느 쪽에만 있어도 FAIL
 *   ④ ko 표와 en 표가 «서로» 같은지 (한쪽만 갱신하는 사고를 막는다)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★이 검사기가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
 *
 *   1. ⛔**키 «이름»만 본다. 「무엇이 담기는지」는 안 본다.** `ml.game` 에 갑자기
 *      전화번호를 넣어도 이 검사기는 0건이다. ⇒ 그 층은 `check_analytics.mjs`(전송
 *      페이로드)와 사람의 검토 몫이다.
 *   2. ⛔**동적으로 조립된 키를 못 본다.** `'ml.' + name` 같은 코드는 리터럴이 아니라
 *      수확되지 않는다. ⇒ 그래서 ★대조 ⑤ 가 「동적 조립이 «없는지»」를 직접 검사한다.
 *      (있으면 FAIL — 그때는 사람이 명단에 적어야 한다)
 *   3. ⛔**`sessionStorage` 는 대상이 아니다.** `ads.preview` 는 검증 도구 전용이고
 *      브라우저를 닫으면 사라진다. 방침 §2 는 「기기에 «저장»되는 항목」이다.
 *   4. ⛔**네이티브 미러(`ml:mirror.` 접두)는 개별 키로 세지 않는다.** 같은 값의 사본이고
 *      방침이 그 규칙을 문장으로 이미 설명한다.
 *
 * 종료 코드: 0 = 통과, 1 = 실패. 순수 node, 네트워크·설치 불필요.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'src');
const PRIVACY = resolve(ROOT, 'public/privacy.html');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/**
 * ★수확 대상이 «아닌» 것 — 이유를 적어야만 들어간다(⛔모양 규칙 금지, «명단»이다).
 * 세어볼 수 있어야 다음 사람이 「왜 빠졌지」를 물을 수 있다.
 */
const NOT_STORAGE = new Map([
  ['ml:mirror.', '네이티브 저장소 미러의 «접두사»다. 개별 키가 아니라 규칙이고, 방침이 문장으로 설명한다'],
]);

/** 코드가 실제로 쓰는 저장소 키를 전수 수확한다 */
function harvestCodeKeys(srcRoot) {
  const found = new Map(); // key -> 첫 출처
  const dynamic = []; // ★동적 조립 흔적
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'locales') continue; // 문안이지 코드가 아니다
        walk(p);
      } else if (['.ts', '.tsx'].includes(extname(name))) {
        const src = readFileSync(p, 'utf8');
        const where = relative(ROOT, p).split('\\').join('/');
        /* ①-a 그냥 리터럴 */
        for (const m of src.matchAll(/'(ml[.:][A-Za-z0-9._-]+)'/g)) {
          if (!found.has(m[1])) found.set(m[1], where);
        }
        /*
         * ①-b ★«접두 상수 + 템플릿» 형태를 «펼친다».
         *
         * ★★[2026-08-22 — 이 검사기가 «스스로» 잡은 자기 구멍]
         *   `toss/storage.ts` 는  const NS = 'ml:';  …  `${NS}localAnonId`  로 쓴다.
         *   ⇒ 리터럴 수확에 ★안 잡힌다. 그래서 「방침엔 있는데 코드가 안 쓴다」로
         *     `ml:localAnonId` · `ml:sdkSelfTest` 2건이 «거짓 오류»로 나왔다.
         *   ⇒ 더 나쁜 것: 아래 「동적 조립 탐지」도 그걸 못 봤다. 옛 정규식은
         *     «리터럴이 앞»인 `ml:${x}` 만 봤는데 실제는 ★«보간이 앞»이었다.
         *     ⇒ 대조 ⑥ 이 「0건」으로 CAUGHT 를 찍었지만 그건 ★거짓 통과였다.
         *   ★교훈: 한 방향만 보는 탐지기는 «반대 방향»에서 조용히 죽는다.
         *   ⇒ 이제 접두 상수를 «해석해» 펼치고, 못 펼치는 것만 dynamic 으로 남긴다.
         */
        const prefixes = new Map();
        for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'(ml[.:][A-Za-z0-9._-]*)'/g)) {
          prefixes.set(m[1], m[2]);
        }
        for (const m of src.matchAll(/`\$\{([A-Za-z_$][\w$]*)\}([A-Za-z0-9._-]*)`/g)) {
          const base = prefixes.get(m[1]);
          if (base === undefined) continue;
          const full = base + m[2];
          if (!found.has(full)) found.set(full, where);
        }
        /*
         * ★동적 조립 — «펼칠 수 없는» 형태만 남긴다. 있으면 이 검사기의 0건이 거짓이 된다.
         * ⛔한 방향(리터럴이 앞)만 보지 마라 — 그게 위에서 실제로 겪은 실패다.
         */
        for (const m of src.matchAll(/['"`]ml[.:]['"`]\s*\+|`ml[.:]\$\{/g)) {
          dynamic.push(where + ' : ' + m[0].trim() + '  (리터럴 접두 + 런타임 값)');
        }
        for (const m of src.matchAll(/`\$\{([A-Za-z_$][\w$]*)\}[A-Za-z0-9._-]*`/g)) {
          if (prefixes.has(m[1])) continue; // 위에서 펼쳤다
          /* 접두 상수를 이 파일에서 못 찾았다 — 다른 파일에서 왔거나 런타임 값이다 */
          if (/KEY|NS|PREFIX|STORAGE/i.test(m[1])) {
            dynamic.push(where + ' : ' + m[0].trim() + '  (접두 상수를 이 파일에서 못 찾음)');
          }
        }
      }
    }
  };
  walk(srcRoot);
  for (const prefix of NOT_STORAGE.keys()) found.delete(prefix);
  return { keys: new Set(found.keys()), origin: found, dynamic };
}

/**
 * `privacy.html` 의 §2 표에서 키를 파싱한다.
 * ★ko / en 두 표를 «따로» 돌려준다 — 한쪽만 갱신하는 사고를 잡기 위해서다.
 */
function harvestDocKeys(html) {
  /* `<code>ml.game</code>` 형태만 취한다. 본문 속 `<code>local</code>` 같은 건 걸러진다 */
  const all = [...html.matchAll(/<code>(ml[.:][A-Za-z0-9._-]+)<\/code>/g)].map((m) => ({
    key: m[1],
    at: m.index,
  }));
  /*
   * 영문 절의 시작점 — 그 앞이 ko, 뒤가 en.
   * ⛔`indexOf('langsplit')` 로 찾지 «마라»: 같은 낱말이 문서 «맨 위 <style> 블록»에
   *   CSS 규칙(`.langsplit{...}`)으로 먼저 나온다. 그러면 split 이 거의 0 이 되어
   *   ★ko 표 전체가 en 으로 분류된다. 실제로 그렇게 짜서 「ko 0개 / en 9개」가 나왔다.
   * ⇒ ★«본문에만» 있는 형태로 고정한다: `class="langsplit"`.
   */
  const split = html.indexOf('class="langsplit"');
  const ko = new Set();
  const en = new Set();
  for (const it of all) {
    if (NOT_STORAGE.has(it.key)) continue;
    (split > 0 && it.at > split ? en : ko).add(it.key);
  }
  return { ko, en, total: all.length, split };
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

function run(codeKeys, html) {
  const errs = [];
  const doc = harvestDocKeys(html);
  if (doc.split <= 0) errs.push('영문 절 구분점을 못 찾았다 — 문서 구조가 바뀌었으면 검사기를 고쳐라');
  if (doc.ko.size === 0) errs.push('ko §2 표에서 저장소 키를 하나도 못 읽었다 — 파싱이 죽었다');

  for (const k of diff(codeKeys, doc.ko)) {
    errs.push('[ko 방침에 «없음»] ' + k + ' — 코드는 쓰는데 §2 표에 없다. 「전부입니다」가 거짓이 된다');
  }
  for (const k of diff(doc.ko, codeKeys)) {
    errs.push('[코드에 «없음»] ' + k + ' — 방침에는 있는데 코드가 안 쓴다. 지웠으면 방침도 지워라');
  }
  for (const k of diff(doc.ko, doc.en)) errs.push('[en 표에 «없음»] ' + k + ' — 한쪽만 갱신됐다');
  for (const k of diff(doc.en, doc.ko)) errs.push('[ko 표에 «없음»] ' + k + ' — 한쪽만 갱신됐다');
  return { errs, doc };
}

/* ── 실행 ────────────────────────────────────────────────────────────── */
const HTML = readFileSync(PRIVACY, 'utf8');
const CODE = harvestCodeKeys(SRC);

if (SELFTEST) {
  const results = [];
  const base = run(CODE.keys, HTML);

  /* ★음성대조 — 지금 상태를 그대로 넣으면 «현재의 결과»가 재현돼야 한다(계수기가 산다) */
  results.push(['① 파싱이 살아 있다 — ko/en 표에서 키를 읽는다',
                base.doc.ko.size >= 5 && base.doc.en.size >= 5]);
  results.push(['② 코드 수확이 살아 있다 — 저장소 키를 읽는다', CODE.keys.size >= 5]);

  /* ★양성대조 ③ — 코드에 «새 키»가 생기면 잡힌다 */
  const plusCode = new Set([...CODE.keys, 'ml.needleNewKey']);
  results.push(['③ ★코드에 새 키가 생기면 잡힌다',
                run(plusCode, HTML).errs.some((e) => e.includes('ml.needleNewKey'))]);

  /* ★양성대조 ④ — 방침 표에서 «한 행»이 사라지면 잡힌다 */
  const victim = [...base.doc.ko][0];
  const cut = HTML.replace('<code>' + victim + '</code>', '<code>ml.zzz_removed</code>');
  results.push(['④ ★방침 표에서 한 행이 사라지면 잡힌다 (' + victim + ')',
                run(CODE.keys, cut).errs.some((e) => e.includes(victim))]);

  /* ★양성대조 ⑤ — ko 만 갱신하고 en 을 안 고치면 잡힌다 */
  const koOnly = HTML.slice(0, base.doc.split) .replace('</table>', '<tr><td><code>ml.koOnlyNeedle</code></td><td>x</td></tr></table>')
                 + HTML.slice(base.doc.split);
  results.push(['⑤ ★ko 만 갱신하면(en 미갱신) 잡힌다',
                run(CODE.keys, koOnly).errs.some((e) => e.includes('ml.koOnlyNeedle'))]);

  /* ★⑥ 동적 조립이 «없는가» — 있으면 리터럴 수확의 0건이 거짓이다 */
  results.push(['⑥ ★저장소 키를 «동적으로 조립»하는 코드가 없다', CODE.dynamic.length === 0]);

  /* ★음성대조 ⑦ — 손대지 않은 현재 문서·코드로는 «추가 오류»가 안 난다 */
  results.push(['⑦ 음성대조 — 원본 그대로면 결과가 바뀌지 않는다',
                run(CODE.keys, HTML).errs.length === base.errs.length]);

  console.log('방침 저장소 키 검사기 — 양성/음성 대조');
  let ok = true;
  for (const r of results) {
    console.log('  ' + (r[1] ? 'CAUGHT' : 'MISSED') + '  ' + r[0]);
    if (!r[1]) ok = false;
  }
  if (CODE.dynamic.length) {
    console.log('\n  ⚠️동적 조립 흔적:');
    for (const d of CODE.dynamic) console.log('    - ' + d);
  }
  if (!ok) {
    console.error('\nFAILED: 대조 실패 — 이 검사기의 「0건」은 부재의 증거가 아니다.');
    process.exit(1);
  }
  console.log('\nOK: 대조 ' + results.length + '종 전부 통과 — 검사기가 살아 있다.');
  console.log('   (현재 코드 ' + CODE.keys.size + '개 · ko 표 ' + base.doc.ko.size + '개 · en 표 ' + base.doc.en.size + '개)');
} else {
  const { errs, doc } = run(CODE.keys, HTML);
  console.log('방침 §2 「기록하는 항목은 다음이 전부입니다」 대조');
  console.log('  코드가 쓰는 키 ' + CODE.keys.size + ' · ko 표 ' + doc.ko.size + ' · en 표 ' + doc.en.size);
  console.log('');
  for (const k of [...CODE.keys].sort()) {
    console.log('  ' + (doc.ko.has(k) ? 'O' : '★X') + ' ' + (doc.en.has(k) ? 'O' : '★X') + '  ' +
                k.padEnd(20) + CODE.origin.get(k));
  }
  if (errs.length) {
    console.error('\nFAILED: ' + errs.length + '건');
    for (const e of errs) console.error('  -', e);
    console.error('\n  ⇒ 방침 문구를 «무르게» 고치지 마라. 표를 실제와 맞춰라.');
    process.exit(1);
  }
  console.log('\n  0건');
}
