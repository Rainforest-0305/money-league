/**
 * 숫자 포맷 — Intl.NumberFormat 기반 (ui_spec 6장 i18n 규칙).
 * 통화는 게임 화폐라 로케일 무관 $ 고정, 천단위 콤마 고정.
 * 문자열 리소스에 숫자를 박지 않고 여기서만 만든다.
 */
import { GAME_DAY_REAL_SECONDS } from './constants';

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

const f2 = nf(2, 2);
const f0 = nf(0, 0);
const f4 = nf(0, 4);

/** $12,483.40 */
export function money(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '$0.00';
  const abs = Math.abs(v);
  const body = decimals === 0 ? f0.format(abs) : f2.format(abs);
  return `${v < 0 ? '-' : ''}$${body}`;
}

/**
 * 축약 통화 — «칸이 좁은» 자리 전용. $5,000 → $5K · $100,000 → $100K · $1,500 → $1.5K · $1,234,567.89 → $1.23M.
 *   쓰는 곳: 출석표 7칸(폭 ≈37px) · 홈 출석 칩 · 홈 요약 3칸(현금·평가금액, ★7자리 이상만).
 *   ⛔잔고·손익처럼 «정확한 값»이 필요한 자리에는 쓰지 마라. 1,000 미만은 그대로 `money(v, 0)` 다.
 *   ★K 는 소수 1자리(출석 금액이 전부 정수 K 라 표기 불변) · M/B/T 는 «고정» 소수 2자리(「$1.00M」·「$12.35M」·「$1.00T」).
 *     ⇒ 총자산 헤드라인(bigMoney)과 «같은 모양»이라 홈 위아래가 같은 값을 다르게 부르지 않는다.
 *   ★M(백만)·B(십억)·T(조) 단위는 «넘침 0» 목적 «만»이다 — 13자 이상 표기가 좁은 칸에 «오지 않게» 한다. 다른 용도로 쓰지 마라.
 */
export function compactMoney(v: number): string {
  if (!Number.isFinite(v)) return '$0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs < 1000) return money(v, 0);
  for (const [unit, div] of [['T', 1e12], ['B', 1e9], ['M', 1e6]] as const) {
    if (abs >= div) return `${sign}$${(abs / div).toFixed(2)}${unit}`;
  }
  const k = abs / 1000;
  const body = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
  return `${sign}$${body}K`;
}

/**
 * 헤드라인 금액(총자산·순위 자산·프로필 자산·시즌 최종 자산·일지 합계) — ★10억($1,000,000,000) 미만은 그대로,
 *   그 이상은 `compactMoney` 와 «같은» 축약(「$1.00B」·「$1.00T」). 「$1,000,039,640.53」(17자)은 어느 칸에도 안 들어가서다.
 *   ★임계 10억 = 총자산 .eqnum--xlong 이 «실측으로 들어가는» 마지막 단계(15자 「$123,456,789.01」)의 바로 위.
 *   ⇒ 기존 verify_eqplus 24케이스(≤15자)는 표기 «무변경». 큰 값 실측 scripts/verify_bigmoney.py.
 */
export function bigMoney(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return money(0, decimals);
  if (Math.abs(v) < 1e9) return money(v, decimals);
  return compactMoney(v);
}

/** 부호 붙는 헤드라인 금액(오늘 손익·프로필 손익·일지 실현 손익) */
export function signedBigMoney(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return signedMoney(0, decimals);
  if (Math.abs(v) < 1e9) return signedMoney(v, decimals);
  return `${v >= 0 ? '+' : '-'}${bigMoney(Math.abs(v), decimals)}`;
}

/**
 * 홈 요약 칸(현금·평가금액) 표기 — ★한 줄·넘침 0 규칙 (2026-08-30 President 후속: 「6자리부터 옆 칸으로 넘친다」).
 *   7자리 미만($999,999.99 까지)은 소수점 유지, 7자리($1,000,000)부터 `compactMoney`(「$1.23M」).
 *   글자 수 임계는 총자산 숫자(.eqnum--long/--xlong: 13/15자)와 «같은 체계»를 칸 폭에 맞춰 낮춘 것 — 11자(「$270,000.00」)부터 --long.
 *   실측 scripts/verify_sumrow.py (ko/en × 375/390/430 × 4금액 × light/dark).
 */
export function sumCell(v: number): { text: string; cls: string } {
  const text = Math.abs(v) >= 1_000_000 ? compactMoney(v) : money(v);
  const cls = text.length >= 13 ? ' sumrow__v--xlong' : text.length >= 11 ? ' sumrow__v--long' : '';
  return { text, cls };
}

/**
 * 행사가 표기 — ★«값»과 «표기»가 어긋나지 않게 한다.
 *
 * ⚠️[2026-08-21] 옛 화면은 행사가 칩을 `money(k, 0)` 로 그렸다. 그건 「행사가는 늘 정수」라는
 *   «우연»에 기댄 것이었다(옛 간격 계단이 전부 1 이상이었을 뿐이다). 간격이 0.5 로 내려가면
 *   19.5 와 20 이 **둘 다 `$20`** 으로 찍힌다 — 에러가 안 나고 «표기만» 틀리는 종류다.
 * ⇒ 정수면 소수점을 떼고, 아니면 그대로 적는다. `scripts/check_strikes.mjs` 가
 *   「표기를 다시 숫자로 읽으면 원래 값인가」를 전 행사가에 대해 검사한다.
 */
export function strikeLabel(k: number): string {
  return Number.isInteger(k) ? money(k, 0) : money(k);
}

/** +$312.85 / -$21.85 — 부호를 항상 표기(색각 이상 대응, ui_spec 5장) */
export function signedMoney(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '$0.00';
  const abs = Math.abs(v);
  const body = decimals === 0 ? f0.format(abs) : f2.format(abs);
  return `${v < 0 ? '-' : '+'}$${body}`;
}

/** 12,483 */
export function num(v: number, decimals = 0): string {
  if (!Number.isFinite(v)) return '0';
  return nf(decimals, decimals).format(v);
}

/** 2.39% (부호 없음) */
export function pct(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '0.00%';
  return `${nf(decimals, decimals).format(v)}%`;
}

/** +2.39% / -2.29% */
export function signedPct(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '0.00%';
  return `${v < 0 ? '-' : '+'}${nf(decimals, decimals).format(Math.abs(v))}%`;
}

/** 주식 수량: 정수면 정수로, 소수면 최대 4자리 */
export function shares(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return Math.abs(v % 1) < 1e-6 ? f0.format(v) : f4.format(v);
}

/** 손익 방향 → 'up' | 'down' | 'flat' */
export function dir(v: number, eps = 1e-9): 'up' | 'down' | 'flat' {
  if (v > eps) return 'up';
  if (v < -eps) return 'down';
  return 'flat';
}

/** ms → "6:23" (분:초) */
export function mmss(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 게임일 → 실제 분.
 *
 * ★★[2026-08-26] `days * 5` 로 ★박혀 있었다. 5 는 `GAME_DAY_REAL_SECONDS`(300초)에서
 *   나온 값인데 «복사본»이었다 — 엔진 상수를 바꾸는 날 이 함수만 옛 답을 계속 낸다.
 *   그리고 이건 화면에서 «게임과 실제를 잇는 유일한 문장»이 쓰는 함수다.
 *   ⇒ 상수에서 «유도»한다. 숫자를 두 벌 두지 않는다.
 */
export function gameDaysToRealMinutes(days: number): number {
  return Math.round((days * GAME_DAY_REAL_SECONDS) / 60);
}

/** KST 자정까지 남은 ms */
export function msUntilKstMidnight(now = Date.now()): number {
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const kstNow = now + KST_OFFSET;
  const dayMs = 24 * 60 * 60 * 1000;
  return dayMs - (kstNow % dayMs);
}
