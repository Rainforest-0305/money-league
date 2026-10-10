/*
 * ⛔★이 파일은 «사본»이다. 원본: 20260802_Partner업무/_shared/daykey.ts
 * (2026-08-22 머니 리그로 이식. 원본 지침 「권장 사본 경로 <프로젝트>/src/lib/daykey.ts」 그대로)
 * ⛔여기서 고치지 마라. 원본을 먼저 고치고 사본 전부를 다시 맞춰라.
 * ⛔「우리 프로젝트에 맞게」 손보지 마라 — 조정이 필요하면 setTimeSource 로 «주입»해라.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════
 * ★★★배포 «원본» — KST 날짜키 정본 (2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ★이 파일은 ★«배포 원본»이다. 머니 리그 · 게임 4종이 여기서 **복사**해 간다.
 *   ⛔사본 쪽에서 고치지 마라. 고치면 이 원본을 먼저 고치고 사본 전부를 다시 맞춰라.
 *   ⛔사본을 만든 뒤 「우리 프로젝트에 맞게」 손보지 마라 — 그 순간 이식 단위가 깨진다.
 *     조정이 필요하면 `setTimeSource` 로 «주입»해라. 그러라고 만든 구멍이다.
 *
 * ★배포 위치:  C:\Users\USER\Downloads\20260802_Partner업무\_shared\daykey.ts
 * ★권장 사본 경로: <프로젝트>/src/lib/daykey.ts
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 이 파일이 필요한가 — 실측에서 나왔다
 *
 *   머니 리그에서 «같은 날짜 규칙»이 ★두 벌로 존재하고 있었다:
 *     `engine/gameWorld.ts` 의 `kstDateKey`   ← 하루 카운터(충전·열람권·공유 리워드) 리셋
 *     `engine/roster.ts`   의 `kstDayKey`     ← «첫 접속일». 순환참조를 피하려고 로컬 정의
 *   ⇒ 규칙이 갈리면 ★「첫 접속일」과 「오늘」이 서로 «다른 날»을 가리킨다.
 *     그리고 ⛔에러가 안 난다. 참가자 수가 조용히 틀리고 하루 몫이 조용히 어긋난다.
 *
 *   ★그리고 게임 5개 레인에 `kstDateKey` 6줄만 배포했더니
 *     `dayDiff`·`nowMs`·`setTimeSource` 가 빠져서 **각자 다시 짜게 됐다.**
 *     ⇒ 다시 짜면 또 갈린다. 그래서 «파일 하나»가 이식 단위여야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 시각 «소스»를 주입 가능하게 두는가
 *
 *   출석·충전·열람권은 전부 「하루에 몇 번」이고, 그 판정이 `Date.now()` 에 걸려 있다.
 *   ⇒ 기기 시계를 앞으로 돌리면 하루가 앞당겨진다. 서버가 없으면 ★원천 차단은 불가능하다.
 *   ⇒ 그런데 토스 «안»에서는 서버 시각을 받을 수 있다
 *     [실측: `@apps-in-toss/web-bridge/dist/bridge.js` 의
 *            `export var getServerTime = createAsyncBridge("getServerTime")`].
 *   ⇒ 시각을 ★«한 곳»에서 갈라야 그 보정이 앱 전체에 한 번에 먹는다.
 *     ⛔`Date.now()` 가 코드 곳곳에 있으면 이식할 때마다 그 구멍이 «복제»된다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⛔이식 조건 (깨뜨리면 이식 단위가 아니게 된다)
 *   1. ⛔**import 가 0개다.** React·엔진·SDK·유틸 무의존. 이 파일만 복사하면 끝나야 한다.
 *   2. ⛔**절대 throw 하지 않는다.** 날짜 판정이 게임 루프 «안»에서 돈다.
 *      소스가 망가져도 게임은 계속 돌아야 한다 — 그래서 전부 폴백이 있다.
 *   3. ⛔**전역 상태는 `timeSource` 하나뿐이다.** 더 늘리지 마라.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 이식 절차
 *   ① 이 파일을 `<프로젝트>/src/lib/daykey.ts` 로 복사
 *   ② 프로젝트의 `Date.now()` 중 «날짜/하루 판정»에 쓰이는 것을 `nowMs()` 로 치환
 *      (⛔성능 측정·애니메이션 타이밍용 `Date.now()` 는 그대로 둬라 — 그건 «시각»이 아니다)
 *   ③ 이미 같은 규칙의 함수가 있으면 ★재수출로 바꿔 «한 벌»로 만든다
 *      예) `export { kstDateKey } from '../daykey';`
 *   ④ 토스 빌드면 부팅에서 `setTimeSource(...)` 를 ★한 번만 부른다
 */

/**
 * 기본 시각 소스. `setTimeSource` 로 갈아끼운다.
 * ⛔이 값을 직접 읽지 마라 — `nowMs()` 를 써라(폴백이 거기 있다).
 */
let timeSource: () => number = () => Date.now();

/**
 * 시각 소스 교체(예: 토스 서버시각 보정).
 *
 * ★부팅에서 «한 번»만 부른다. ⛔런타임 중 여러 번 바꾸면 날짜가 앞뒤로 튀고,
 *   그러면 「어제 받았는데 오늘 또 받는」 상태가 만들어진다.
 * ★넘기는 함수는 «절대 throw 하지 않아야» 한다. throw 해도 `nowMs()` 가 살려내지만,
 *   그건 안전망이지 설계가 아니다.
 *
 * @example
 *   // 토스 안: 부팅 시 서버시각과의 «차이»만 기억하고 로컬 시계에 더한다.
 *   // ⛔매번 브릿지를 부르지 마라 — 날짜 판정은 게임 루프 안에서 돈다.
 *   const skew = serverNow - Date.now();
 *   setTimeSource(() => Date.now() + skew);
 */
export function setTimeSource(fn: () => number): void {
  timeSource = fn;
}

/** 지금(ms). ⛔날짜·하루 판정에서는 `Date.now()` 대신 이걸 쓴다 */
export function nowMs(): number {
  try {
    const t = timeSource();
    /* ★소스가 망가져도 게임은 돈다. NaN·Infinity·문자열 전부 여기서 걸러진다 */
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * KST(UTC+9) 날짜키 `'YYYY-MM-DD'`.
 * ★하루 카운터 리셋의 «유일한» 기준이다. 두 번째 기준을 만들지 마라 —
 *   유저가 「무엇이 언제 초기화되는지」를 하나만 외우게 해야 한다.
 */
export function kstDateKey(now: number = nowMs()): string {
  const kst = new Date(now + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 다음 KST 자정까지 남은 ms. 화면 카운트다운용.
 * ★음수가 나오지 않는다(항상 0 초과 ~ 하루 이하).
 */
export function msUntilKstMidnight(now: number = nowMs()): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const kst = now + 9 * 60 * 60 * 1000;
  return dayMs - (((kst % dayMs) + dayMs) % dayMs);
}

/**
 * 두 날짜키 사이의 «일» 차이 (b − a).
 *
 * ★문자열을 ★UTC 자정으로 파싱해 뺀다 — 로컬 타임존·서머타임에 흔들리지 않는다.
 *   ⛔`new Date('2026-08-22')` 와 `new Date(2026, 7, 22)` 는 «다른 시각»이다.
 *     후자를 쓰면 실행 기기의 타임존에 따라 하루가 밀린다.
 * ★출석 streak 판정(어제/그제/그 이상)이 이 함수 하나로 갈린다.
 *
 * @returns 일 수. 형식이 깨졌으면 `NaN` — 호출부가 «반드시» 확인해야 한다.
 */
export function dayDiff(a: string, b: string): number {
  const pa = Date.parse(a + 'T00:00:00Z');
  const pb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return NaN;
  return Math.round((pb - pa) / 86_400_000);
}

/**
 * 어떤 날짜키로부터 «오늘까지» 지난 일수. 0 이상으로 자른다.
 *
 * ★★시계를 «되돌려도» 음수가 되지 않는다. 이게 중요한 이유:
 *   음수 일수가 그대로 흘러가면 「참가자 −3명」·「출석 −2일차」 같은 값이 만들어지고,
 *   그건 대개 ⛔에러가 아니라 «이상한 화면»으로 나온다.
 * ★형식이 깨진 값이 들어와도 0 을 준다 — 게임이 멈추는 것보다 낫다.
 */
export function daysSince(fromKey: string, now: number = nowMs()): number {
  const d = dayDiff(fromKey, kstDateKey(now));
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/** 날짜키 형식이 유효한가 (`'YYYY-MM-DD'` 이고 실제 존재하는 날인가) */
export function isDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  if (!Number.isFinite(t)) return false;
  /* ★'2026-02-31' 같은 값은 Date.parse 가 «받아준다». 되돌려서 같은지 본다 */
  return new Date(t).toISOString().slice(0, 10) === v;
}
