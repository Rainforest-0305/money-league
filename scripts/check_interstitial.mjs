#!/usr/bin/env node
/**
 * ★전면(Interstitial) 광고 «단위검사» — 실제 `src/lib/ads.ts` 를 «불러서» 돌린다.
 *
 *   node scripts/check_interstitial.mjs             본검사 + 소스 정적검사
 *   node scripts/check_interstitial.mjs --selftest  ★양성/음성 대조 먼저(검사기가 «잡는지»)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★왜 필요한가
 *   광고 호출은 ★에러를 내지 않고 조용히 틀린다. 실제로 그랬다:
 *     출석 2배 버튼이 14일 동안 «파산충전 지면»으로 나가고 있었는데
 *     타입 에러도 런타임 에러도 없었고, 콘솔 리포트에 null 이 찍혀 있을 뿐이었다.
 *   ⇒ 「어느 지면으로 나가는가」와 「몇 번 나가는가」를 ★실행으로 세야 한다.
 *   ⛔운영 광고 ID 로 로컬 «실렌더»는 계정 중단 사유다. 그래서 이 검사기는
 *     SDK 를 «가짜»로 꽂고 ★호출 파라미터만 본다 — 광고를 그리지 않는다.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★★이 검사기는 「전면 지면 ID 가 있는지 없는지」를 ★기대값으로 박지 않는다
 *
 *   ⚠️이 파일의 «1차 판»이 정확히 그 결함이었다: 지면이 아직 없던 시점의 상태
 *     (`interstitialMain: ''`)를 기대값으로 박아 두었다. 그래서 Partner 가 콘솔에서
 *     지면을 발급해 ID 한 줄을 넣자 ★검사기가 3건 FAIL + 앵커 미발견으로 죽었다.
 *     ⇒ ★코드가 옳아졌는데 검사기가 틀렸다고 말한 것이다.
 *       (메모리 `test-locks-in-wrong-value` — 「테스트가 틀린 값을 고정한다」의 실물)
 *
 *   ⇒ 그래서 규율을 바꾼다. ID 의 «현재 값»은 검사 대상이 아니라 ★«입력»이다:
 *       ID 가 비어 있다  → hasPlacement=false → 전면은 `no-placement` 로 «SDK 호출 0»
 *       ID 가 채워져 있다 → hasPlacement=true  → 가드를 통과하면 «그 ID 로» 1회 호출
 *     두 상태 «모두»를 매 실행마다 ★사본으로 만들어 돌린다(아래 §2). 정본이 어느
 *     상태든 검사기는 통과하고, 발급·회수 어느 방향으로 바뀌어도 죽지 않는다.
 *
 * ⛔규칙을 이 파일에 «다시 구현하지» 않는다 — 실제 모듈을 import 한다
 *   (check_attendance.mjs · check_promo_hooks.mjs 와 같은 규율).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️★이 검사기가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
 *   1. ⛔**실제 광고가 뜨는지는 못 본다.** SDK 는 토스 앱 «안»에서만 산다 → 실기기 몫.
 *   2. ⛔**화면이 버튼을 그리는지는 «정적 grep»으로만 본다**(아래 §6). 실렌더는
 *      `verify_interstitial.py` 몫이다.
 *   3. ⛔**콘솔 지면이 실제로 ENABLED 인지는 못 본다** → `iaa_placement_group_list` 몫(Partner).
 *      ⇒ ★ID 가 «형식에 맞는다»는 것과 「그 지면이 산다」는 것은 다른 말이다.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/* ── 가짜 SDK ──────────────────────────────────────────────────────────
 * ★호출을 «세기만» 한다. 광고를 그리지 않는다.
 * ★`isSupported()` 는 SDK 가 실제로 노출하는 모양 그대로다(safeIsSupported 가 그걸 본다). */
const CALLS = { load: [], show: [], banner: [] };
let LOAD_BEHAVIOR = 'loaded'; // 'loaded' | 'error' | 'silent'
let SHOW_BEHAVIOR = 'dismissed'; // 'dismissed' | 'failedToShow' | 'error'

function resetCalls() {
  CALLS.load = [];
  CALLS.show = [];
  CALLS.banner = [];
}

const loadFn = (arg) => {
  CALLS.load.push(arg?.options?.adGroupId);
  if (LOAD_BEHAVIOR === 'loaded') queueMicrotask(() => arg?.onEvent?.({ type: 'loaded' }));
  else if (LOAD_BEHAVIOR === 'error') queueMicrotask(() => arg?.onError?.(new Error('nofill')));
  return () => {};
};
loadFn.isSupported = () => true;

const showFn = (arg) => {
  CALLS.show.push(arg?.options?.adGroupId);
  if (SHOW_BEHAVIOR === 'dismissed') queueMicrotask(() => arg?.onEvent?.({ type: 'dismissed' }));
  else if (SHOW_BEHAVIOR === 'failedToShow') queueMicrotask(() => arg?.onEvent?.({ type: 'failedToShow' }));
  else if (SHOW_BEHAVIOR === 'error') queueMicrotask(() => arg?.onError?.(new Error('boom')));
  return () => {};
};
showFn.isSupported = () => true;

const attachFn = (id) => {
  CALLS.banner.push(id);
  return { destroy() {} };
};
attachFn.isSupported = () => true;

globalThis.__ML_FAKE_ADMOB__ = { loadAppsInTossAdMob: loadFn, showAppsInTossAdMob: showFn };
/* ★`ensureInitReady()` 는 «onInitialized 가 올 때까지» 기다린다 — 안 부르면 배너가 영영 안 붙는다(20초 타임아웃).
   가짜 SDK 도 «초기화 완료»를 알려야 실제 경로가 돈다. */
const initFn = Object.assign((arg) => queueMicrotask(() => arg?.callbacks?.onInitialized?.()), { isSupported: () => true });
globalThis.__ML_FAKE_TOSSADS__ = { attachBanner: attachFn, initialize: initFn };

/* ── 가짜 브라우저 ─────────────────────────────────────────────────────
 * ★`isInToss()` 가 true 가 되게 «토스 안»을 흉내낸다. 그래야 SDK 경로가 열린다. */
const STORE = new Map();
const fakeStorage = {
  getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
  setItem: (k, v) => STORE.set(k, String(v)),
  removeItem: (k) => STORE.delete(k),
  clear: () => STORE.clear(),
};
globalThis.window = {
  ReactNativeWebView: { postMessage: () => {} },
  __GRANITE_NATIVE_EMITTER: { on: () => () => {} },
  localStorage: fakeStorage,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};

/* ── TS 소스를 그대로 부르기 위한 훅 ──────────────────────────────────── */
const FRAMEWORK = '@apps-in-toss/web-framework';
const STUB_URL = 'ml-stub:framework';
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === FRAMEWORK) return { url: STUB_URL, shortCircuit: true };
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const GoogleAdMob = globalThis.__ML_FAKE_ADMOB__;\n' +
          'export const TossAds = globalThis.__ML_FAKE_TOSSADS__;\n',
      };
    }
    return next(url, ctx);
  },
});

/**
 * ★보류 중인 마이크로태스크·타이머를 «비운다».
 * ⛔안 비우면 앞 항의 콜백이 «다음 항»의 카운터로 샌다 — 실제로 샜다:
 *   셀프테스트의 리워드 호출이 §2 의 show 카운트를 1 로 만들어 거짓 FAIL 이 났다.
 *   (검사기가 스스로를 오염시키는 형태 — 「0건」이 부재의 증거가 아닌 것의 사촌이다)
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const results = [];
const fails = [];
function check(name, cond, detail = '') {
  results.push([name, cond, detail]);
  console.log('  %s  %s%s', cond ? 'PASS' : '★FAIL', name, detail ? '  ' + detail : '');
  if (!cond) fails.push(name);
}

const ADS_PATH = resolve(ROOT, 'src/lib/ads.ts');
const ADS_SRC = readFileSync(ADS_PATH, 'utf8');

/* ★★전면 지면 «선언 줄»을 값에 무관하게 잡는다.
 *   ⛔빈 문자열 리터럴을 앵커로 쓰면 ID 가 채워지는 순간 검사기가 죽는다(1차 판의 결함).
 *   ⇒ 잡는 것은 ★「키가 있는가 + 값이 우리가 아는 두 형태 중 하나인가」다.
 *     허용 형태: `''`(미발급) 또는 `ait.v2.live.<16 hex>`(발급). 그 밖은 ★오타로 본다. */
const ID_LINE_RE = /(interstitialMain:\s*')([^']*)('\s+as string,)/;
const ID_SHAPE_RE = /^(?:|ait\.v2\.live\.[0-9a-f]{16})$/;

/* ★[-33] 거래 N번째 전면의 «배선» 앵커 — commitOrder 의 되돌리기 토스트가 만료될 때 onTradeCompleted 로 간다 */
const TRADE_WIRING_RE = /this\.showToast\(\{[\s\S]{0,900}?onExpire: \(\) => this\.onTradeCompleted\(\),/;

const idLine = ADS_SRC.match(ID_LINE_RE);
if (!idLine) {
  console.error('★FAIL  ads.ts 에서 `interstitialMain: \'…\' as string,` 선언을 못 찾았다.');
  console.error('       ⇒ 선언 «형태»가 바뀌었다면 이 검사기의 ID_LINE_RE 를 같이 고쳐라.');
  process.exit(1);
}
const CURRENT_ID = idLine[2];
const CURRENT_STATE = CURRENT_ID === '' ? 'EMPTY(미발급)' : 'FILLED(발급됨)';

const A = await import(pathToFileURL(ADS_PATH).href);
/*
 * ★[2026-09-12 · -34] 원장은 이제 «메모리 거울»을 함께 본다(저장 실패 시 상한이 무력화되던 결함 수정).
 *   ⇒ 가짜 저장소(STORE)를 비우는 것만으로는 모듈 상태가 안 지워진다 — 시나리오가 서로 새어 든다.
 *   ⇒ 저장소를 건드릴 때마다 «그 시나리오가 쓰는 모듈»의 런타임 상태도 같이 되돌린다.
 */
let RESET = () => A.__resetAdRuntimeStateForTest();
/** 계측 원장 조회 — §⑩ 실행 회귀가 「실제로 세어졌는가」를 이걸로 본다 */
const STATS = await import(pathToFileURL(resolve(ROOT, 'src/lib/adStats.ts')).href);
/* ⛔daykey 는 «캐시버스팅 없이» 부른다 — 사본이 쓰는 것과 ★같은 인스턴스여야
   `setTimeSource` 주입이 사본에도 먹는다(query 를 붙이면 별개 모듈이 된다). */
const DAY = await import(pathToFileURL(resolve(ROOT, 'src/lib/daykey.ts')).href);

const TODAY = DAY.kstDateKey(Date.now());
const T0 = Date.parse('2026-09-05T05:00:00Z'); // 임의의 고정 시각 — 순수 함수라 «지금»이 필요 없다
const led = (o = {}) => ({ dateKey: TODAY, count: 0, lastAt: 0, lastRewardAt: 0, ...o });
const env = (o = {}) => ({ hasId: true, supported: true, sessionStartedAt: T0 - 10 * 60_000, ...o });
const reason = (g) => (g.ok ? 'OK' : g.reason);

/* ═════════════════════════ 0. 양성/음성 대조 ═════════════════════════ */
if (SELFTEST) {
  console.log('\n전면 광고 검사기 — 양성/음성 대조 (검사기가 «잡는지»)');
  const fired = [];
  const probe = (label, cond) => {
    console.log('  %s  %s', cond ? 'CAUGHT' : '★MISSED', label);
    if (cond) fired.push(label);
    else fails.push('selftest:' + label);
  };

  probe('① 판정 함수가 «살아 있다» — 정상 상태는 통과한다', A.interstitialGateOn(led(), env(), T0, TODAY).ok === true);
  probe('② 지면 ID 를 지우면 잡힌다', reason(A.interstitialGateOn(led(), env({ hasId: false }), T0, TODAY)) === 'no-placement');
  probe('③ SDK 미지원이면 잡힌다', reason(A.interstitialGateOn(led(), env({ supported: false }), T0, TODAY)) === 'unsupported');
  probe(
    '④ 진입 직후(59초)면 잡힌다 — ★토스 정책 명문 금지',
    reason(A.interstitialGateOn(led(), env({ sessionStartedAt: T0 - 59_000 }), T0, TODAY)) === 'session-start'
  );
  probe('⑤ 오늘 3회를 채우면 잡힌다', reason(A.interstitialGateOn(led({ count: 3 }), env(), T0, TODAY)) === 'daily-cap');
  probe(
    '⑥ 직전 전면 9분 59초 뒤면 잡힌다',
    reason(A.interstitialGateOn(led({ count: 1, lastAt: T0 - (10 * 60_000 - 1_000) }), env(), T0, TODAY)) === 'too-soon'
  );
  probe(
    '⑦ 리워드 광고 59초 뒤면 잡힌다 — ★연속 광고 금지',
    reason(A.interstitialGateOn(led({ lastRewardAt: T0 - 59_000 }), env(), T0, TODAY)) === 'after-reward'
  );
  probe(
    '⑧ 가짜 SDK 가 «살아 있다» — 호출을 실제로 센다',
    (() => {
      resetCalls();
      LOAD_BEHAVIOR = 'silent'; /* ⛔'loaded' 로 두면 show 콜백이 «다음 항»으로 새어 든다 */
      A.runRewardedAd('rewardAttendance');
      LOAD_BEHAVIOR = 'loaded';
      /* ⛔이 리워드는 «영영 안 끝난다»(silent). 그대로 두면 rewardedInFlight 가 켜진 채로 남아
         뒤의 전면 검사가 전부 `reward-active` 로 막힌다 — 실측으로 6항이 그렇게 죽었다. */
      A.__resetAdRuntimeStateForTest();
      return CALLS.load.length === 1;
    })()
  );
  probe(
    '⑨ 음성대조: 상한 «직전»(2회 · 10분 1초 전 · 61초 전)은 통과한다(오탐 0)',
    A.interstitialGateOn(led({ count: 2, lastAt: T0 - 10 * 60_000 - 1_000, lastRewardAt: T0 - 61_000 }), env(), T0, TODAY).ok === true
  );
  /* ★★1차 판이 죽었던 자리 — 「ID 가 채워져도 앵커를 찾는가」를 «검사기 자신»에게 묻는다.
     ⛔빈 문자열 리터럴을 앵커로 박았던 탓에 Partner 가 ID 를 넣자 검사기가 throw 했다. */
  probe(
    '⑩ ★ID 앵커가 «빈 값·발급값 둘 다»에서 잡힌다 (1차 판이 죽었던 자리)',
    [`  interstitialMain: '' as string,`, `  interstitialMain: 'ait.v2.live.XXXXXXXXXXXXXXXX' as string,`].every(
      (s) => ID_LINE_RE.test(s)
    )
  );
  probe(
    '⑪ ★형태 검사가 «오타 ID» 는 잡는다 (아무 문자열이나 통과시키지 않는다)',
    !ID_SHAPE_RE.test('ait.v2.live.NOPE') && !ID_SHAPE_RE.test('ait.v2.live.XXXXXXXXXXXXXXX') && ID_SHAPE_RE.test('') && ID_SHAPE_RE.test('ait.v2.live.XXXXXXXXXXXXXXXX')
  );
  /* ★★[-33] 거래 N번째 전면 — 순수 판정이 «살아 있고» 경계에서 갈린다 */
  probe('⑫ ★거래 N번째 판정: 3번째만 참(2·4 는 거짓)', A.tradeInterstitialDue(3) === true && A.tradeInterstitialDue(2) === false && A.tradeInterstitialDue(4) === false);
  probe('⑬ ★N 을 5 로 늦추면 5번째만 참(되감기 스위치가 실제로 먹는다)', A.tradeInterstitialDue(5, 5) === true && A.tradeInterstitialDue(3, 5) === false);
  probe('⑭ ★깨진 입력(NaN·0·음수·소수)은 전부 거짓', [NaN, 0, -3, 2.5].every((n) => A.tradeInterstitialDue(n) === false));
  /* ★★[-33] 배너 오류 백오프 — 표가 살아 있고 «끝»이 있다 */
  probe('⑮ ★백오프 30→60→120초 뒤 «끝»(4번째 null)', A.bannerRetryDelay(0) === 30_000 && A.bannerRetryDelay(1) === 60_000 && A.bannerRetryDelay(2) === 120_000 && A.bannerRetryDelay(3) === null);
  probe('⑯ ★실패 사유 분류가 코드를 «가른다»(1001 network · 1013 timeout · init 문구)', A.bannerFailReason({ code: 1001 }) === 'network' && A.bannerFailReason({ code: 1013 }) === 'timeout' && A.bannerFailReason({ code: 0, message: 'Call initialize() before attaching an ad.' }) === 'init');
  /* ★★[-33] 배선 정적검사의 «정규식 자체»가 끊긴 소스를 잡는가 — 원본을 잘라 넣어 본다 */
  {
    const STORE_SRC = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
    const cut = STORE_SRC.replace(/onExpire: \(\) => this\.onTradeCompleted\(\),/, '');
    probe('⑰ ★commitOrder 에서 onExpire 배선을 «끊은» 사본이 잡힌다', TRADE_WIRING_RE.test(STORE_SRC) && !TRADE_WIRING_RE.test(cut));
    const ADB = readFileSync(resolve(ROOT, 'src/components/AdBanner.tsx'), 'utf8');
    probe('⑱ ★AdBanner 가 attachBanner( 를 «직접» 부르게 되돌린 사본이 잡힌다', !/\battachBanner\(/.test(ADB) && /\battachBanner\(/.test(ADB.replace('mountBannerSlot(', 'attachBanner(')));
  }

  /*
   * ★★⑲ [2026-09-12 · Codex 리뷰 8번] 「실패 콜백을 «빈 함수»로 바꿔도 통과한다」를 «실제로» 잡는가.
   *   원문: 「§8·9의 20항을 그대로 실행했을 때 onAdFailedToRender 를 빈 함수로 바꿔도 20/20 통과·exit 0」.
   *   ⇒ 정규식 검사만으로는 못 잡는다. 사본을 만들어 «돌려» 보고, 계측이 0 이 되는지 본다.
   *   ⛔이 대조가 MISSED 면 §⑩ R1·R2 가 죽은 것이다 — 그때는 종료코드도 1 이 된다(probe 가 fails 에 넣는다).
   */
  {
    const deadPath = resolve(ROOT, 'src/lib/__ads_deadfail.check.ts');
    const mkNode = () => ({
      children: [],
      get firstChild() {
        return this.children.length ? this.children[0] : null;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      getBoundingClientRect: () => ({ height: 50, top: 100 }),
    });
    let caughtDead = false;
    try {
      const broken = ADS_SRC.replace('onAdFailedToRender: (p) => mySink.fail(bannerFailReason(p?.error)),', 'onAdFailedToRender: () => {},');
      if (broken !== ADS_SRC) {
        writeFileSync(deadPath, broken, 'utf8');
        globalThis.document = { visibilityState: 'visible', createElement: () => mkNode(), addEventListener: () => {}, removeEventListener: () => {} };
        let cbs = null;
        const realAttach = globalThis.__ML_FAKE_TOSSADS__.attachBanner;
        const cap = (id, el, opts) => {
          cbs = opts?.callbacks ?? null;
          return { destroy() {} };
        };
        cap.isSupported = () => true;
        globalThis.__ML_FAKE_TOSSADS__.attachBanner = cap;
        STORE.clear();
        const D = await import(pathToFileURL(deadPath).href);
        const ctl = D.mountBannerSlot('bannerHome', mkNode(), 'light', () => {});
        await flush();
        cbs?.onAdFailedToRender?.({ error: { code: 1001 } });
        await flush();
        /* ★빈 함수 판에서는 실패가 «세어지지 않는다» = 우리 R1 이 그걸 잡는다는 뜻 */
        caughtDead = STATS.adStatsToday('bannerHome').fail === 0;
        ctl.dispose();
        D.__resetAdRuntimeStateForTest();
        globalThis.__ML_FAKE_TOSSADS__.attachBanner = realAttach;
        delete globalThis.document;
        STORE.clear();
      }
    } finally {
      if (existsSync(deadPath)) unlinkSync(deadPath);
    }
    probe('⑲ ★실패 콜백을 «빈 함수»로 바꾼 사본이 잡힌다 (Codex 8번 — 정규식으로는 못 잡던 자리)', caughtDead);
    probe('⛔⑲ 사본이 남지 않았다', !existsSync(resolve(ROOT, 'src/lib/__ads_deadfail.check.ts')));
  }
  console.log('SELFTEST %s (양성/음성 %d종)\n', fails.length ? '★FAIL' : 'PASS', fired.length);
  await flush();
  resetCalls();
  STORE.clear(); RESET();
}

/* ═════════════════════════ 1. 지면 매핑 ═════════════════════════ */
console.log('① 지면 매핑 — 「어느 ID 로 나가는가」');
console.log('   [정본 상태] interstitialMain = %s  → %s', JSON.stringify(CURRENT_ID), CURRENT_STATE);
check('출석 전용 지면이 AD_IDS 에 있다', A.AD_IDS.rewardAttendance === 'ait.v2.live.XXXXXXXXXXXXXXXX', A.AD_IDS.rewardAttendance);
check('충전·출석 지면이 «서로 다르다»', A.AD_IDS.rewardTopup !== A.AD_IDS.rewardAttendance);
/* ⛔「비어 있어야 한다」가 아니다 — «형태»만 본다. 값은 Partner 가 콘솔에서 정한다 */
check('전면 지면 값이 아는 형태다 ( 빈 값 또는 ait.v2.live.<16hex> )', ID_SHAPE_RE.test(CURRENT_ID), JSON.stringify(CURRENT_ID));
check('전면 ID 가 다른 지면과 겹치지 않는다', CURRENT_ID === '' || Object.entries(A.AD_IDS).filter(([, v]) => v === CURRENT_ID).length === 1, CURRENT_ID);
/* ★기대값을 «상태에서 유도»한다. 이 한 줄이 1차 판의 결함을 구조로 막는다 */
check(
  `hasPlacement 가 «현재 상태»와 일치한다 (${CURRENT_STATE})`,
  A.hasPlacement('interstitialMain') === (CURRENT_ID !== ''),
  `hasPlacement=${A.hasPlacement('interstitialMain')}`
);
{
  const table = [];
  for (const slot of ['rewardTopup', 'rewardTraderView', 'rewardSeasonExtend', 'rewardAttendance']) {
    resetCalls();
    LOAD_BEHAVIOR = 'silent';
    A.runRewardedAd(slot);
    table.push([slot, CALLS.load[0] ?? '(호출 0)']);
  }
  LOAD_BEHAVIOR = 'loaded';
  for (const [slot, id] of table) check(`runRewardedAd('${slot}') → ${id}`, id === A.AD_IDS[slot]);
  console.log('   ┌ 리워드 호출 경로 표');
  for (const [slot, id] of table) console.log('   │ ' + slot.padEnd(20) + ' → ' + id);
  console.log('   └');
}

/* ═════════════════════════ 2. 전면 — «두 상태 모두» 사본으로 증명 ═════════════════════════
 *
 * ★정본이 어느 상태든 상관없이 매 실행마다 두 사본을 만들어 «둘 다» 돌린다:
 *     EMPTY  : interstitialMain = ''                       → SDK 호출 0 이 «정상»
 *     FILLED : interstitialMain = 정본 ID(없으면 검사용 ID) → 그 ID 로 1회 호출이 «정상»
 * ⇒ 발급 전/후 어느 쪽으로 정본이 움직여도 검사기는 죽지 않고, 두 방향을 다 증명한다.
 *
 * ★세션 «진입 직후 60초» 가드를 넘기는 법: 사본을 import 하기 «직전»에 daykey 의 시각
 *   소스를 -5분으로 주입한다. 사본의 SESSION_STARTED_AT 이 그 시각으로 굳는다.
 *   (`setTimeSource` 는 daykey 원본이 «그러라고» 낸 구멍이다 — daykey.ts 주석) */
console.log('\n② 전면 — 지면 «미발급/발급» 두 상태 (매 실행 사본 대조)');
const FALLBACK_PROBE_ID = 'ait.v2.live.XXXXXXXXXXXXXXXX'; // 정본이 비어 있을 때만 쓰는 검사용 값
const VARIANTS = [
  { name: 'EMPTY ', id: '', file: 'src/lib/__ads_empty.check.ts' },
  { name: 'FILLED', id: CURRENT_ID || FALLBACK_PROBE_ID, file: 'src/lib/__ads_filled.check.ts' },
];
const made = [];
try {
  for (const v of VARIANTS) {
    const p = resolve(ROOT, v.file);
    made.push(p);
    writeFileSync(p, ADS_SRC.replace(ID_LINE_RE, `$1${v.id}$3`), 'utf8');

    /* 사본의 SESSION_STARTED_AT 을 «5분 전»으로 굳힌 뒤 시각을 되돌린다 */
    DAY.setTimeSource(() => Date.now() - 5 * 60_000);
    const M = await import(pathToFileURL(p).href);
    RESET = () => M.__resetAdRuntimeStateForTest();
    DAY.setTimeSource(() => Date.now());

    const filled = v.id !== '';
    console.log('   ── %s (id=%s)', v.name.trim(), JSON.stringify(v.id));
    check(`[${v.name}] hasPlacement = ${filled}`, M.hasPlacement('interstitialMain') === filled);

    /* ①회차 — 원장이 비어 있는 상태 */
    await flush();
    resetCalls();
    STORE.clear(); RESET();
    const r1 = await M.runInterstitialAd('interstitialMain');
    if (filled) {
      check(`[${v.name}] 1회차 → 노출 성공(dismissed)`, r1.ok === true, reason(r1));
      check(`[${v.name}] ★SDK 가 «그 ID» 로 정확히 1회 불렸다`, CALLS.load.length === 1 && CALLS.load[0] === v.id && CALLS.show[0] === v.id, `load=${CALLS.load} show=${CALLS.show}`);
      check(`[${v.name}] 원장 count=1 로 기록`, M.readInterstitialLedger().count === 1, JSON.stringify(M.readInterstitialLedger()));
    } else {
      check(`[${v.name}] 1회차 → no-placement`, r1.ok === false && r1.reason === 'no-placement', reason(r1));
      check(`[${v.name}] ★SDK 호출 0 (load 0 · show 0)`, CALLS.load.length === 0 && CALLS.show.length === 0, `load=${CALLS.load.length} show=${CALLS.show.length}`);
      check(`[${v.name}] 원장에 아무것도 안 쓴다`, STORE.get('ml.ads.interstitial') === undefined, String(STORE.get('ml.ads.interstitial')));
    }

    /* ②회차 — 직전 노출 직후. 발급됐으면 too-soon, 미발급이면 여전히 no-placement */
    await flush();
    resetCalls();
    const r2 = await M.runInterstitialAd('interstitialMain');
    check(`[${v.name}] 2회차(직후) → ${filled ? 'too-soon' : 'no-placement'} · SDK 호출 0`,
      r2.ok === false && r2.reason === (filled ? 'too-soon' : 'no-placement') && CALLS.load.length === 0,
      `${reason(r2)} load=${CALLS.load.length}`);

    /* ③ 리워드 직후 연속 광고 금지 — 발급 상태에서만 «실행»으로 확인된다 */
    if (filled) {
      await flush();
      STORE.clear(); RESET();
      resetCalls();
      LOAD_BEHAVIOR = 'silent';
      M.runRewardedAd('rewardTopup');
      LOAD_BEHAVIOR = 'loaded';
      /* ⛔silent 리워드는 «끝나지 않는다» → rewardedInFlight 가 켜진 채 남아 뒤가 전부 reward-active 로 막힌다.
         여기서는 「닫힌 «뒤»의 after-reward」를 보려는 것이므로 진행 중 플래그만 내리고 시각은 남긴다. */
      M.__resetAdRuntimeStateForTest();
      M.markRewardedShown();
      resetCalls();
      const r3 = await M.runInterstitialAd('interstitialMain');
      check(`[${v.name}] 리워드 직후 → after-reward · SDK 호출 0 (⛔연속 광고 금지)`,
        r3.ok === false && r3.reason === 'after-reward' && CALLS.load.length === 0, `${reason(r3)} load=${CALLS.load.length}`);

      /* ④ 하루 상한 — 원장을 3회로 채우고 부른다 */
      await flush();
      STORE.clear(); RESET();
      RESET(); STORE.set('ml.ads.interstitial', JSON.stringify({ dateKey: DAY.kstDateKey(Date.now()), count: 3, lastAt: Date.now() - 3600_000, lastRewardAt: 0 }));
      resetCalls();
      const r4 = await M.runInterstitialAd('interstitialMain');
      check(`[${v.name}] 오늘 3회 뒤 → daily-cap · SDK 호출 0`,
        r4.ok === false && r4.reason === 'daily-cap' && CALLS.load.length === 0, `${reason(r4)} load=${CALLS.load.length}`);

      /* ⑤ 날짜가 바뀌면 리셋된다 */
      await flush();
      RESET(); STORE.set('ml.ads.interstitial', JSON.stringify({ dateKey: '2000-01-01', count: 3, lastAt: Date.now() - 3600_000, lastRewardAt: 0 }));
      resetCalls();
      const r5 = await M.runInterstitialAd('interstitialMain');
      check(`[${v.name}] 어제분 3회는 오늘을 막지 않는다(KST 자정 리셋)`, r5.ok === true && CALLS.load.length === 1, `${reason(r5)} load=${CALLS.load.length}`);

      /* ⑦ ★★[-33] «동시» 호출 — 호출부가 3곳이라 겹칠 수 있다. 원장은 show 시점에야 써지므로
             잠금이 없으면 «둘 다» 게이트를 통과해 하루 3회·10분 간격이 한 번에 뚫린다
             [2026-09-10 Codex 리뷰 시뮬레이션 SIMULTANEOUS_INTERSTITIAL: loads 2 · shows 2 · count 2]. */
      await flush();
      STORE.clear(); RESET();
      resetCalls();
      {
        const both = await Promise.all([M.runInterstitialAd('interstitialMain'), M.runInterstitialAd('interstitialMain')]);
        const okCount = both.filter((r) => r.ok).length;
        check(
          `[${v.name}] ★동시 호출 2건 → SDK load «1회»만 · 성공 1 · 원장 count 1`,
          CALLS.load.length === 1 && CALLS.show.length === 1 && okCount === 1 && M.readInterstitialLedger().count === 1,
          `load=${CALLS.load.length} show=${CALLS.show.length} ok=${okCount} count=${M.readInterstitialLedger().count}`
        );
      }
      /* ⑧ ★잠금이 «끝나고 나면» 다시 열린다(영구 잠금이 아니다) — 원장을 비우고 한 번 더 */
      await flush();
      STORE.clear(); RESET();
      resetCalls();
      {
        const r8 = await M.runInterstitialAd('interstitialMain');
        check(`[${v.name}] ★잠금 해제 뒤 다음 호출은 정상 통과(영구 잠금 아님)`, r8.ok === true && CALLS.load.length === 1, `${reason(r8)} load=${CALLS.load.length}`);
      }
    }

    /* ⑥ ★순수 판정 규칙은 «상태와 무관»하게 같다 — 사본이 규칙을 바꾸지 않았다는 증거 */
    const same = ['no-placement', 'unsupported', 'session-start', 'daily-cap', 'too-soon', 'after-reward'].every((want, i) => {
      const cases = [
        M.interstitialGateOn(led(), env({ hasId: false }), T0, TODAY),
        M.interstitialGateOn(led(), env({ supported: false }), T0, TODAY),
        M.interstitialGateOn(led(), env({ sessionStartedAt: T0 - 59_000 }), T0, TODAY),
        M.interstitialGateOn(led({ count: 3 }), env(), T0, TODAY),
        M.interstitialGateOn(led({ count: 1, lastAt: T0 - 59_000 }), env(), T0, TODAY),
        M.interstitialGateOn(led({ lastRewardAt: T0 - 30_000 }), env(), T0, TODAY),
      ];
      return reason(cases[i]) === want;
    });
    check(`[${v.name}] 순수 판정 규칙 6종이 «상태와 무관»하게 동일`, same);
  }
} finally {
  for (const p of made) if (existsSync(p)) unlinkSync(p);
  /* ★사본 모듈은 여기서 끝이다 — 아래 본검사는 «정본» A 를 쓰므로 RESET 도 A 로 되돌린다 */
  RESET = () => A.__resetAdRuntimeStateForTest();
  await flush();
  STORE.clear(); RESET();
  resetCalls();
}

/* ═════════════════════════ 3. 정본 자신의 동작 ═════════════════════════
 * ★사본이 아니라 «지금 배포될 소스»가 자기 상태대로 도는지 한 번 더 본다.
 *   ⛔정본 모듈은 방금 로드돼서 SESSION_STARTED_AT 이 «지금»이다 ⇒ 발급 상태라면
 *     `session-start` 로 막히는 것이 ★정상이다(토스 정책). 그것까지 기대값에 넣는다. */
console.log('\n③ 정본 소스 자신 — %s', CURRENT_STATE);
{
  await flush();
  resetCalls();
  STORE.clear(); RESET();
  const r = await A.runInterstitialAd('interstitialMain');
  const want = CURRENT_ID === '' ? 'no-placement' : 'session-start';
  check(`정본 → ${want} (앱 진입 직후라 어느 쪽이든 광고는 안 나간다)`, r.ok === false && r.reason === want, reason(r));
  check('정본 → ★SDK 호출 0', CALLS.load.length === 0 && CALLS.show.length === 0, `load=${CALLS.load.length} show=${CALLS.show.length}`);
}

/* ═════════════════════════ 4. 원장 ═════════════════════════ */
console.log('\n④ 원장');
{
  await flush();
  STORE.clear(); RESET();
  const before = A.readInterstitialLedger();
  check('원장이 비어 있으면 0 으로 읽는다', before.count === 0 && before.lastAt === 0 && before.lastRewardAt === 0);
  A.markRewardedShown(1_700_000_000_000);
  check('markRewardedShown 이 lastRewardAt 만 남긴다', A.readInterstitialLedger().lastRewardAt === 1_700_000_000_000 && A.readInterstitialLedger().count === 0);
  RESET(); STORE.set('ml.ads.interstitial', '{{{ broken');
  check('망가진 원장을 읽어도 throw 하지 않고 0 을 준다', A.readInterstitialLedger().count === 0);
  RESET(); STORE.set('ml.ads.interstitial', JSON.stringify({ dateKey: TODAY, count: 'NaN', lastAt: null, lastRewardAt: 'x' }));
  const bad = A.readInterstitialLedger();
  check('숫자가 아닌 값도 0 으로 정화된다', bad.count === 0 && bad.lastAt === 0 && bad.lastRewardAt === 0);
  STORE.clear(); RESET();
}

/* ═════════════════════════ 5. 상수 ═════════════════════════ */
console.log('\n⑤ 빈도 상수 (Partner 지시값)');
check('하루 최대 3회', A.INTERSTITIAL_MAX_PER_DAY === 3, String(A.INTERSTITIAL_MAX_PER_DAY));
check('전면 간 최소 10분', A.INTERSTITIAL_MIN_GAP_MS === 600_000, String(A.INTERSTITIAL_MIN_GAP_MS));
check('리워드 직후 60초 금지', A.INTERSTITIAL_AFTER_REWARD_MS === 60_000, String(A.INTERSTITIAL_AFTER_REWARD_MS));
check('진입 직후 60초 금지', A.INTERSTITIAL_MIN_SESSION_MS === 60_000, String(A.INTERSTITIAL_MIN_SESSION_MS));

/* ═════════════════════════ 6. 소스 정적검사(배선) ═════════════════════════
 * ⛔실행으로 못 보는 부분이다. 「어디에 끼웠는가」는 grep 으로만 확인된다 — 그 한계를 적어 둔다. */
console.log('\n⑥ 배선 정적검사 (⚠grep — 실행으로 본 것이 아니다)');
const RECHARGE = readFileSync(resolve(ROOT, 'src/screens/Recharge.tsx'), 'utf8');
const GATE = readFileSync(resolve(ROOT, 'src/components/SeasonGate.tsx'), 'utf8');
const REWARDAD = readFileSync(resolve(ROOT, 'src/components/RewardAd.tsx'), 'utf8');
/* ★[-33] 출석 «추가 지급(광고)» 버튼은 components/AttendanceBonus.tsx 한 벌로 옮겨졌다(홈 시트·충전 카드가 같이 쓴다) */
const ATTBONUS = readFileSync(resolve(ROOT, 'src/components/AttendanceBonus.tsx'), 'utf8');
const HOME = readFileSync(resolve(ROOT, 'src/screens/Home.tsx'), 'utf8');

check("출석 추가지급이 useRewardAd('attendance') 를 쓴다 (AttendanceBonus.tsx)", /useRewardAd\('attendance'/.test(ATTBONUS));
check('출석 추가지급 훅이 «한 벌»이다 — Recharge 에는 더 이상 attendance 훅 선언이 없다', !/const \w+ = useRewardAd\('attendance'/.test(RECHARGE));
check('홈 출석 시트 «와» 충전 소진 카드가 «같은» <AttendanceBonus /> 를 그린다', /<AttendanceBonus \/>/.test(HOME) && /<AttendanceBonus \/>/.test(RECHARGE));
check('출석 추가지급은 «해제 조건»(store.attendBonusUnlocked) 을 본다 — 홈 진입 즉시 자동 재생 ⛔', /attendBonusUnlocked/.test(ATTBONUS) && !/\.run\(\)\s*;?\s*\}\s*,\s*\[\]\)/.test(ATTBONUS));
/* ⛔주석 안의 인용(「예전에는 'topup' 이었다」)까지 세면 안 된다 → «선언문»만 센다.
   이 한 줄을 안 갈랐다가 거짓 FAIL 이 났다 — 검사기가 자기 문서를 코드로 읽은 형태다. */
{
  const decls = (RECHARGE.match(/const \w+ = useRewardAd\('topup'/g) || []).length;
  check("⛔출석 2배가 더 이상 'topup' 으로 안 나간다 — 충전 CTA 1곳만 'topup'", decls === 1, `선언 ${decls}건`);
}
check('RewardAd 매핑이 Record 다(삼항 아님) — kind 를 늘리면 컴파일이 깨진다', /REWARD_SLOT: Record<RewardKind, RewardSlotId>/.test(REWARDAD) && !/kind === 'topup' \? 'rewardTopup'/.test(REWARDAD));
check('출석은 grantAdReward(충전 경제)를 «타지 않는다»', /attendance: 'extern'/.test(REWARDAD));
check('완료 화면 CTA 가 leaveDone() 을 부른다', /onClick=\{\(\) => void leaveDone\(\)\}/.test(RECHARGE));
check('leaveDone 이 ★무료 충전일 때만 전면을 부른다', /topupVia === 'free'\) await runInterstitialAd\('interstitialMain'\)/.test(RECHARGE));
check('⛔광고 충전 직후 전면 호출 «없음» — 전면 호출은 Recharge 에 1곳뿐', (RECHARGE.match(/runInterstitialAd\(/g) || []).length === 1);
check('완료 화면 CTA 가 중복 탭을 막는다(disabled)', /disabled=\{leavingDone\}/.test(RECHARGE));
check('SeasonGate restart 가 전면을 부른다', /await runInterstitialAd\('interstitialMain'\)/.test(GATE));
check('SeasonGate 전면 호출은 1곳뿐 — ⛔「시즌 연장」 경로엔 «없다»', (GATE.match(/runInterstitialAd\(/g) || []).length === 1);
check('SeasonGate 가 광고 «뒤»에 startNewSeason 을 부른다(순서)', GATE.indexOf('runInterstitialAd(') < GATE.indexOf('s.startNewSeason()'));
check('SeasonGate 가 광고 성패와 무관하게 새 시즌으로 간다(finally)', /finally \{\s*\n\s*s\.startNewSeason\(\);/.test(GATE));
check('SeasonGate restart 가 중복 탭을 막는다(busy)', /const restart = async \(\) => \{\s*\n\s*if \(busy\) return;/.test(GATE));

/* ═════════════════════════ 7. ★[-33] 거래 N번째 전면 — 상수·순수 판정·배선 ═════════════════════════
 * 「세션 내 3번째 «완료된» 거래의 결과 화면」. 완료 = 되돌리기 창이 되돌림 없이 닫힘(store.commitOrder onExpire).
 * ⛔가드는 새로 만들지 않았다 — store 는 runInterstitialAd('interstitialMain') «하나»만 부른다(기존 가드 전부 재사용). */
console.log('\n⑦ ★거래 N번째 전면 (2026-09-10 · -33)');
/* ⛔이름 주의: `STORE` 는 위 «가짜 localStorage»(Map)다. 소스 문자열은 STORE_TS 로 부른다 */
const STORE_TS = readFileSync(resolve(ROOT, 'src/store/store.ts'), 'utf8');
const ADSTATS_SRC = readFileSync(resolve(ROOT, 'src/lib/adStats.ts'), 'utf8');
const PRIVACY_SRC = readFileSync(resolve(ROOT, 'public/privacy.html'), 'utf8');
check('INTERSTITIAL_TRADE_NTH = 3 (President 승인 전략 · 되감기 스위치는 5)', A.INTERSTITIAL_TRADE_NTH === 3, String(A.INTERSTITIAL_TRADE_NTH));
check('tradeInterstitialDue: 1·2 → 거짓, 3 → 참, 4 → 거짓 (정확히 N번째 한 번)', !A.tradeInterstitialDue(1) && !A.tradeInterstitialDue(2) && A.tradeInterstitialDue(3) && !A.tradeInterstitialDue(4));
check('store: commitOrder 의 되돌리기 토스트 «만료»에 onTradeCompleted 가 걸려 있다(⛔시트 닫힘 즉시가 아니다)', TRADE_WIRING_RE.test(STORE_TS));
check('store: 판정은 lib/ads 의 tradeInterstitialDue 를 «그대로» 쓴다(규칙 복제 없음)', /tradeInterstitialDue\(this\.sessionTradesDone\)/.test(STORE_TS));
check("store: 전면 호출은 runInterstitialAd('interstitialMain' …) «1곳»뿐(새 가드·새 지면 없음)", (STORE_TS.match(/runInterstitialAd\('interstitialMain'/g) || []).length === 1);
check('store: 세션당 «한 번»만 시도(tradeInterstitialFired)', /tradeInterstitialFired = true/.test(STORE_TS));
/* ★[-34] 가드 판정은 `tradeInterstitialVeto` 한 곳으로 모았다 — hidden·시즌게이트도 그 안에 있다 */
check('store: 문서 hidden · 시즌 게이트 중엔 호출 0(가드 계측만)',
  /tradeInterstitialVeto\([\s\S]{0,600}?this\.seasonLocked\) return 'season-gate';[\s\S]{0,200}?visibilityState !== 'visible'\) return 'hidden';/.test(STORE_TS));
check('store: showToast 가 «타이머로 닫힐 때만» onExpire 를 부른다(액션이 닫으면 안 부른다)', /const alive = this\.toasts\.some\(\(x\) => x\.id === id\);[\s\S]{0,120}?if \(alive\) onExpire\?\.\(\);/.test(STORE_TS));
check('store: 체결(placed)·완료(done) 카운터가 «분리»돼 있다', /sessionTradesPlaced \+= 1/.test(STORE_TS) && /sessionTradesDone \+= 1/.test(STORE_TS));

/* ═════════════════════════ 8. ★[-33] 배너 「보일 때 1회」 배선 ═════════════════════════ */
console.log('\n⑧ ★배너 요청 규율 (2026-09-10 · -33)');
const ADBANNER = readFileSync(resolve(ROOT, 'src/components/AdBanner.tsx'), 'utf8');
const DERIV = readFileSync(resolve(ROOT, 'src/screens/Derivatives.tsx'), 'utf8');
check('AdBanner 는 mountBannerSlot(컨트롤러)에 위임하고 attachBanner( 를 직접 부르지 않는다', /mountBannerSlot\(/.test(ADBANNER) && !/\battachBanner\(/.test(ADBANNER));
check('컨트롤러: IntersectionObserver 로 «교차 시점»에 attach (threshold 0)', /new IntersectionObserver\(/.test(ADS_SRC) && /threshold: 0/.test(ADS_SRC));
check('컨트롤러: 문서 hidden 이면 요청 0 · visible 복귀에 재판정', /visibilityState === 'visible'/.test(ADS_SRC) && /addEventListener\('visibilitychange', onVis\)/.test(ADS_SRC));
check('컨트롤러: SDK init «완료»를 기다린다(ensureInitReady · onInitialized)', /ensureInitReady\(\)/.test(ADS_SRC) && /onInitialized: \(\) => finish\(true\)/.test(ADS_SRC));
{
  /* ⛔창(300자) 안에 «다음 콜백»(onAdFailedToRender → onFail)이 들어와 거짓 FAIL 이 났다 — 블록 «본문»만 잘라 본다 */
  const noFillBody = (ADS_SRC.match(/onNoFill: \(\) => \{([\s\S]*?)\n\s*\},/) || [])[1] ?? '';
  check('컨트롤러: no-fill 은 재시도하지 «않는다»(요청만 늘려 시청률을 낮춘다)', /set\('nofill'\);/.test(noFillBody) && !/onFail\(|scheduleRetry|retryDue = true/.test(noFillBody), noFillBody.replace(/\s+/g, ' ').slice(0, 80));
}
check('컨트롤러: 오류 백오프 표 = [30s, 60s, 120s]', JSON.stringify([...A.BANNER_RETRY_DELAYS_MS]) === JSON.stringify([30_000, 60_000, 120_000]));
check('컨트롤러: 재시도는 «교차 중 + visible» 일 때만(숨김 재시도 0)', /if \(!intersecting \|\| !visible\(\)\) return;/.test(ADS_SRC));
check('컨트롤러: dispose 가 IO 해제·대기 취소·slot destroy(또는 주차)를 전부 한다',
  /dispose: \(\) => \{[\s\S]{0,900}?io\?\.disconnect\(\);[\s\S]{0,400}?clearRetryTimer\(\);[\s\S]{0,600}?(parkSlot\(|destroySlot\?\.\(\);)/.test(ADS_SRC));
check('⛔파생 탭 배너 «제거» — Derivatives.tsx 에 AdBanner 없음', !/AdBanner/.test(DERIV.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')));
check('⛔AD_IDS 에 bannerDerivatives 없음 (제거 지면 ID 가 번들에 실리지 않게)', !('bannerDerivatives' in A.AD_IDS) && !/XXXXXXXXXXXXXXXX/.test(ADS_SRC) && !/XXXXXXXXXXXXXXXX/.test(DERIV));
check('계측(ml.ads.stats)이 요청·로드·노출·노필·실패·가드를 «갈라» 센다', ['req', 'load', 'shown', 'nofill', 'fail', 'guard'].every((ev) => new RegExp(`noteAd\\('(banner|interstitial|rewarded)', [^)]*'${ev}'`).test(ADS_SRC)));

/* ═════════ 9. ★[-33 · Codex 리뷰 반영] 시뮬레이션이 잡은 5건이 «고쳐진 채로» 있는가 ═════════
 * ⛔이 검사들은 「고쳤다」가 아니라 「고친 것이 «남아 있다»」를 지킨다. 지우면 같은 결함이 조용히 돌아온다. */
console.log('\n⑨ ★Codex 리뷰 지적 반영 (2026-09-10)');
check('① 전면 «동시 호출» 잠금이 있다(interstitialInFlight) · finish 에서 반드시 푼다',
  /let interstitialInFlight = false;/.test(ADS_SRC) && /if \(interstitialInFlight\)/.test(ADS_SRC) && /settled = true;\s*\n\s*interstitialInFlight = false;/.test(ADS_SRC));
check('② show() «직전»에 가시성 + 가드를 다시 본다(로드 6초 사이에 바뀔 수 있다)',
  /const show = \(\) => \{[\s\S]{0,700}?visibilityState !== 'visible'[\s\S]{0,200}?'hidden-at-show'[\s\S]{0,400}?const g2 = interstitialGate\(slot\);/.test(ADS_SRC));
check('③ 배너 실패 백오프가 «지면»에 붙는다(bannerCooldowns) — 주차·재마운트에도 유지',
  /const bannerCooldowns = new Map<BannerSlotId, BannerCooldown>\(\);/.test(ADS_SRC) && /if \(cooldownLeft\(\) > 0\) \{/.test(ADS_SRC) && !/attempt: number;\s*\n\s*timer: number;/.test(ADS_SRC));
check('③-b 응답이 오면(load·nofill) 쿨다운을 «푼다» — 다음 실패는 30초부터',
  (ADS_SRC.match(/settled\(\);/g) || []).length >= 2 && /const settled = \(\) => bannerCooldowns\.delete\(slot\);/.test(ADS_SRC));
check('④ 재시도 타이머를 «중복으로» 걸지 않는다(armRetry 가 먼저 clear)',
  /const armRetry = \(\) => \{[\s\S]{0,200}?clearRetryTimer\(\);/.test(ADS_SRC));
check('⑤ 주차·회수에서 콜백 sink 를 «그대로» 물려준다(상태가 끊기지 않는다)',
  /mySink = re\.sink;/.test(ADS_SRC) && /sink: mySink/.test(ADS_SRC) && !/sink,\s*state: lastState/.test(ADS_SRC));
check('⑥ attachBanner 가 «던졌을 때» 조용히 삼키지 않는다(onAttachError → onFail)',
  /onAttachError\?: \(reason: string\) => void/.test(ADS_SRC) && /onAttachError\?\.\('attach-threw'\)/.test(ADS_SRC) && /\(reason\) => onFail\(reason\)/.test(ADS_SRC));

/* ★③ 을 넣다가 «새로» 낸 결함 — 하네스가 잡았다(verify_ads33 23항 FAIL).
 *   쿨다운이 「응답이 오면 지워지는」 값이라, 「쿨다운 0」을 「지금 다시 붙여야 한다」로 읽으면
 *   IO 재교차·visible 복귀마다 정상 배너를 죽이고 재요청한다(홈 스크롤 왕복 5회 = 요청 6).
 *   ⇒ tryRetry 는 «실패 상태 + 쿨다운 항목이 있을 때»만 움직인다. */
check('③-c tryRetry 는 «재시도가 밀려 있을 때»만 — 실패 상태 ∧ 쿨다운 항목이 있어야 한다',
  /const tryRetry = \(\) => \{[\s\S]{0,900}?lastState !== 'failed' && lastState !== 'retry-wait'\) return;[\s\S]{0,300}?const cd = bannerCooldowns\.get\(slot\);\s*\n\s*if \(!cd\) return;/.test(ADS_SRC));
check('③-d 아직 쿨다운 중이면 «다시 깨우도록» 걸어두고 물러난다(주차로 타이머를 잃어도 재시도가 온다)',
  /if \(cooldownLeft\(\) > 0\) \{\s*\n[\s\S]{0,200}?armRetry\(\);\s*\n\s*return;\s*\n\s*\}\s*\n[\s\S]{0,200}?if \(!intersecting \|\| !visible\(\)\) return;/.test(ADS_SRC));

/* ═════════ 9-B. ★[-34] Codex 2차 리뷰 P1 3건이 «고쳐진 채로» 있는가 ═════════ */
console.log('\n⑨-B ★Codex 2차 리뷰 P1 반영 (2026-09-12)');
check('P1-1 전면은 «열린 되돌리기 창»이 없을 때만 나간다(undo-open)', /if \(this\.openUndoCount > 0\) return 'undo-open';/.test(STORE_TS));
check('P1-1 미뤄 둔 전면이 «되돌리기를 눌러» 닫힐 때도 풀린다(dismissToast → flush)',
  /dismissToast\(id: number\): void \{[\s\S]{0,400}?this\.maybeFlushTradeInterstitial\(\);/.test(STORE_TS));
check('P1-1 새 주문·화면 이탈이면 취소한다(new-order · screen-left)',
  /return 'new-order';/.test(STORE_TS) && /return 'screen-left';/.test(STORE_TS));
check('P1-1 그 판정을 «요청 전·노출 전» 두 번 쓴다(canShow 로 넘긴다)',
  /canShow: \(\) => this\.tradeInterstitialVeto\(/.test(STORE_TS) && (ADS_SRC.match(/opts\.canShow\?\.\(\) \?\? null/g) || []).length >= 2);
check('P1-1 N번째를 «미뤘다가» 띄운다(tradeInterstitialPending)', /tradeInterstitialPending/.test(STORE_TS));
check('P1-2 리워드가 «도는 중»이면 전면 차단(reward-active)', /reward-active/.test(ADS_SRC) && /env\.rewardActive === true/.test(ADS_SRC));
check('P1-2 리워드 «닫힘»에 lastRewardAt 을 다시 찍는다', /if \(didShow\) markRewardedShown\(\);/.test(ADS_SRC));
check('P1-3 원장은 «메모리 먼저»(저장 실패해도 이번 실행 상한이 산다)', /memLedger = \{ \.\.\.l \};/.test(ADS_SRC));
check('P1-3 영속 실패면 «막는다»(no-ledger)', /ledgerPersistOk = false;/.test(ADS_SRC) && /env\.ledgerOk === false\) return \{ ok: false, reason: 'no-ledger' \};/.test(ADS_SRC));
check('P2-4 배너 실패도 sink 로 승계한다(옛 컨트롤러에 묶이지 않는다)', /mySink\.fail = onFail;/.test(ADS_SRC) && /mySink\.fail\(bannerFailReason/.test(ADS_SRC));
check('P2-6 리워드도 노출 «직전»에 가시성·취소를 다시 본다', /noteAd\('rewarded', slot, 'guard', \{ reason: 'hidden-at-show' \}\)/.test(ADS_SRC));
check('★9번 계측에서 화면 경로·요청 id 를 «저장하지 않는다»',
  !/screen: currentScreen\(\),/.test(ADSTATS_SRC) && !/rid: String\(extra\.rid\)/.test(ADSTATS_SRC) && /vis: currentVis\(\),/.test(ADSTATS_SRC));
check('★9번 방침 ko/en 이 「화면 주소·요청 번호를 담지 않는다」를 말한다',
  /화면 주소·광고 요청 번호/.test(PRIVACY_SRC) && /no user identifier, page address, ad request id/.test(PRIVACY_SRC));

/* ═════════ 10. ★[-34] «실행» 회귀 — 소스를 읽는 대신 «돌려서» 본다 ═════════
 * ★왜 생겼나 (2026-09-12 Codex 리뷰 8번, 원문):
 *   「§8·9의 20항을 그대로 실행했을 때 `onAdFailedToRender` 를 빈 함수로 바꿔도 20/20 통과·exit 0」.
 *   ⇒ 정규식은 「그 줄이 있다」만 본다. 콜백이 «실제로 무엇을 하는지»는 못 본다.
 *   ⇒ 여기서는 가짜 SDK·가짜 DOM·가짜 시계로 컨트롤러를 «돌리고» 결과를 센다. */
console.log('\n⑩ ★실행 회귀 (2026-09-12 · -34)');
{
  /* ── 가짜 DOM — mountBannerSlot 이 필요한 최소한만 ─────────────────────── */
  const mkNode = () => {
    const n = {
      children: [],
      get firstChild() {
        return this.children.length ? this.children[0] : null;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      getBoundingClientRect: () => ({ height: 50, top: 100 }),
    };
    return n;
  };
  globalThis.document = {
    visibilityState: 'visible',
    createElement: () => mkNode(),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  /* ── 콜백을 «붙잡는» 가짜 배너 SDK ─────────────────────────────────────── */
  let captured = null;
  let attaches = 0;
  const realAttach = globalThis.__ML_FAKE_TOSSADS__.attachBanner;
  const capturingAttach = (id, el, opts) => {
    attaches += 1;
    captured = opts?.callbacks ?? null;
    return { destroy() {} };
  };
  capturingAttach.isSupported = () => true;

  const counters = (slot) => STATS.adStatsToday(slot);
  const withCapture = async (fn) => {
    globalThis.__ML_FAKE_TOSSADS__.attachBanner = capturingAttach;
    try {
      return await fn();
    } finally {
      globalThis.__ML_FAKE_TOSSADS__.attachBanner = realAttach;
    }
  };

  /* (R1) 실패 콜백이 «실제로» 계측·백오프를 탄다 — 빈 함수로 바꾸면 여기서 죽는다 */
  await withCapture(async () => {
    STORE.clear();
    RESET();
    attaches = 0;
    captured = null;
    const host = mkNode();
    const states = [];
    const ctl = A.mountBannerSlot('bannerHome', host, 'light', (s) => states.push(s));
    await flush();
    check('R1 배너가 «붙는다»(attach 1회)', attaches === 1, `attaches=${attaches}`);
    check('R1 실패 콜백이 «넘어왔다»(onAdFailedToRender 가 있다)', typeof captured?.onAdFailedToRender === 'function', Object.keys(captured ?? {}).join(','));
    captured?.onAdFailedToRender?.({ error: { code: 1001 } });
    await flush();
    const c = counters('bannerHome');
    check('R1 실패가 «계측»된다(fail 1) — 빈 함수로 바꾸면 0 이 된다', c.fail === 1, JSON.stringify(c));
    check('R1 실패 뒤 상태가 retry-wait 로 간다', states.includes('retry-wait'), states.join('>'));
    ctl.dispose();
  });

  /* (R2) 주차→회수 뒤에도 실패가 «새» 컨트롤러로 간다 (Codex 리뷰 4번) */
  await withCapture(async () => {
    STORE.clear();
    RESET();
    attaches = 0;
    const host1 = mkNode();
    const c1 = A.mountBannerSlot('bannerHome', host1, 'light', () => {});
    await flush();
    captured?.onAdRendered?.({});
    await flush();
    c1.dispose(); /* 주차 */
    const host2 = mkNode();
    const states2 = [];
    const c2 = A.mountBannerSlot('bannerHome', host2, 'light', (s) => states2.push(s));
    await flush();
    check('R2 회수는 «재요청 0»(attach 는 그대로 1회)', attaches === 1, `attaches=${attaches}`);
    captured?.onAdFailedToRender?.({ error: { code: 1001 } });
    await flush();
    const c = counters('bannerHome');
    check('R2 주차·회수 뒤 실패가 «새» 컨트롤러로 간다(fail 1 · retry-wait)', c.fail === 1 && states2.includes('retry-wait'), `${JSON.stringify(c)} ${states2.join('>')}`);
    c2.dispose();
  });

  /* (R6) ★주차 «경계»는 의도된 값이다 — 유예를 넘겨 재마운트하면 새로 요청한다 (Codex 리뷰 5번 기각 근거) */
  await withCapture(async () => {
    STORE.clear();
    RESET();
    attaches = 0;
    const c1 = A.mountBannerSlot('bannerHome', mkNode(), 'light', () => {});
    await flush();
    captured?.onAdRendered?.({});
    await flush();
    c1.dispose(); /* 주차 시작 */
    await new Promise((r) => setTimeout(r, A.PARK_GRACE_MS + 150)); /* ★유예를 «넘긴다» */
    const c2 = A.mountBannerSlot('bannerHome', mkNode(), 'light', () => {});
    await flush();
    check(`R6 주차 유예(${A.PARK_GRACE_MS}ms)를 «넘기면» 새로 요청한다(attach 2회) — 경계가 우연이 아님`,
      attaches === 2, `attaches=${attaches}`);
    c2.dispose();
    RESET();
  });

  delete globalThis.document;

  /* (R3) 리워드가 «도는 중»에는 전면이 나가지 않는다 (Codex 리뷰 2번 · P1)
     ★진입 60초 금지를 «지나간» 세션으로 만든다 — 안 그러면 전부 session-start 로 막혀 아무것도 증명 못 한다 */
  {
    STORE.clear();
    RESET();
    resetCalls();
    const t0 = Date.now() + 120_000;
    DAY.setTimeSource(() => t0);
    try {
      LOAD_BEHAVIOR = 'silent';
      A.runRewardedAd('rewardTopup'); /* 로드 중 = 진행 중 */
      LOAD_BEHAVIOR = 'loaded';
      resetCalls(); /* ⛔리워드 자신의 load 를 세면 안 된다 — 여기서 세는 건 «전면»이다 */
      const rA = await A.runInterstitialAd('interstitialMain');
      check('R3 리워드 진행 중 전면 → reward-active · SDK 호출 0',
        rA.ok === false && rA.reason === 'reward-active' && CALLS.load.length === 0, `${reason(rA)} load=${CALLS.load.length}`);
      A.__resetAdRuntimeStateForTest(); /* 리워드가 «닫혔다»고 본다(원장의 lastRewardAt 도 함께 비운다) */
      STORE.clear();
      resetCalls();
      const rB = await A.runInterstitialAd('interstitialMain');
      check('R3 리워드가 닫히면 다시 열린다(영구 차단 아님)', rB.ok === true && CALLS.load.length === 1, `${reason(rB)} load=${CALLS.load.length}`);
    } finally {
      DAY.setTimeSource(null);
    }
  }

  /* (R4) 리워드 «닫힘» 시각부터 60초를 센다 — 긴 광고를 닫자마자 전면이 나가면 안 된다 */
  {
    STORE.clear();
    RESET();
    resetCalls();
    let t = Date.parse('2026-09-12T05:00:00Z');
    DAY.setTimeSource(() => t);
    try {
      SHOW_BEHAVIOR = 'silent-show';
      /* show 는 나가지만 dismissed 는 «우리가» 61초 뒤에 쏜다 */
      let showArg = null;
      const realShow = globalThis.__ML_FAKE_ADMOB__.showAppsInTossAdMob;
      const capShow = (arg) => {
        CALLS.show.push(arg?.options?.adGroupId);
        showArg = arg;
        return () => {};
      };
      capShow.isSupported = () => true;
      globalThis.__ML_FAKE_ADMOB__.showAppsInTossAdMob = capShow;
      const p = A.runRewardedAd('rewardTopup');
      await flush();
      t += 61_000; /* ★61초짜리 리워드 — 옛 판은 여기서 이미 「60초 지남」이었다 */
      showArg?.onEvent?.({ type: 'userEarnedReward', data: { unitType: 'x', unitAmount: 1 } });
      showArg?.onEvent?.({ type: 'dismissed' });
      await p;
      globalThis.__ML_FAKE_ADMOB__.showAppsInTossAdMob = realShow;
      SHOW_BEHAVIOR = 'dismissed';
      const led = A.readInterstitialLedger();
      check('R4 lastRewardAt 이 «닫힌 시각»으로 갱신된다', led.lastRewardAt === t, `${led.lastRewardAt} vs ${t}`);
      resetCalls();
      const r = await A.runInterstitialAd('interstitialMain');
      check('R4 리워드를 닫자마자 전면 → after-reward · SDK 호출 0 (⛔토스 정책)',
        r.ok === false && r.reason === 'after-reward' && CALLS.load.length === 0, `${reason(r)} load=${CALLS.load.length}`);
      t += 61_000;
      resetCalls();
      const r2 = await A.runInterstitialAd('interstitialMain');
      check('R4 닫힘 뒤 61초가 지나면 열린다', r2.ok === true && CALLS.load.length === 1, `${reason(r2)} load=${CALLS.load.length}`);
    } finally {
      DAY.setTimeSource(null);
    }
  }

  /* (R5) 원장을 «저장하지 못하면» 상한을 셀 수 없다 → 보수적으로 막는다 (Codex 리뷰 3번 · P1) */
  {
    STORE.clear();
    RESET();
    resetCalls();
    const realSet = fakeStorage.setItem;
    const t0 = Date.now() + 120_000;
    DAY.setTimeSource(() => t0);
    fakeStorage.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    try {
      const r1 = await A.runInterstitialAd('interstitialMain');
      const r2 = await A.runInterstitialAd('interstitialMain');
      const r3 = await A.runInterstitialAd('interstitialMain');
      const r4 = await A.runInterstitialAd('interstitialMain');
      check('R5 저장이 죽어도 «메모리 원장»이 산다 — 노출은 1회뿐(옛 판은 4회)',
        CALLS.show.length === 1, `show=${CALLS.show.length} ${[r1, r2, r3, r4].map(reason).join(',')}`);
      check('R5 그 뒤 사유는 no-ledger (세지 못하는 상한은 없는 상한이다)',
        reason(r2) === 'no-ledger' && reason(r4) === 'no-ledger', `${reason(r2)}/${reason(r4)}`);
    } finally {
      fakeStorage.setItem = realSet;
      DAY.setTimeSource(null);
      RESET();
    }
  }

  STORE.clear();
  RESET();
  resetCalls();
}

/* ⛔사본 파일이 남으면 다음 빌드에 «검사용 ID» 가 실린다. 남지 않았음을 «확인»한다 */
check('⛔검사용 사본이 남지 않았다', made.every((p) => !existsSync(p)), made.map((p) => p.split(/[\\/]/).pop()).join(' '));

console.log('');
console.log('check_interstitial %s — 검사 %d항 · 실패 %d  [정본 상태 %s]', fails.length ? '★FAIL' : 'PASS', results.length, fails.length, CURRENT_STATE);
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
