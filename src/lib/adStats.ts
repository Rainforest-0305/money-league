/**
 * 광고 «계측» 원장 — 요청 → 로드 → 노출 사이 어디서 새는지를 «기기 안에서» 센다 (2026-09-10 · -33).
 *
 * ── 왜 생겼나 (President 직접 질의) ─────────────────────────────────────────
 *   콘솔 실측: 머니 리그 배너 요청 19,369 → 노출 2,033 (7일 · 10.5%). 요청 10건 중 9건이 노출로 안 이어진다.
 *   코드·SDK 실측으로 구조적 원인은 잡았다(요청 = attach 즉시 · 노출 = 1px 가시). 그래도 «실기기»에서
 *   어느 층이 새는지는 기기 안 카운터가 있어야 다음에 답할 수 있다. 그래서 «원인 분기»별로 센다.
 *
 * ── 무엇을 세나 (Codex 12_광고시청률_개선안 §6 최소 계측을 이 앱 규율에 맞게 줄인 것) ──
 *   fmt  : 'banner' | 'rewarded' | 'interstitial'
 *   ev   : req(SDK 호출 직전) · load(로드 성공) · showReq(show 호출) · shown(노출 콜백) · viewable(50%·1초)
 *          · nofill · fail(reason) · guard(reason · 요청 «전» 차단) · reward · abandon · dismiss
 *   extra: reason(no_fill/network/render/timeout/left_screen/unknown/…) · rid(SDK requestId) · h0(높이 0) · vis(문서 가시성)
 *
 * ── 규율 ───────────────────────────────────────────────────────────────────
 *   · «새 키» `ml.ads.stats` 하나. 세이브 블롭·SAVE_VERSION 무접촉. privacy.html §2 표에 같은 키를 적는다.
 *   · 전송 0. 사용자 ID·URL·개인정보 0. 세션 ID 0.
 *
 * ── ★[2026-09-12 · -34] 저장 필드를 줄였다 (Codex 리뷰 9번 · Partner 지시) ──────────
 *   -33 은 원시 이벤트에 `screen`(해시 경로)과 `rid`(SDK 요청 id)까지 «저장»했다.
 *   그런데 `privacy.html` 은 「화면 주소를 담지 않는다」고 적혀 있었고 릴리즈 노트는 「횟수만」이라고 말했다.
 *   ⇒ 문서가 사실보다 «좁게» 적혀 있었다. 두 길 중 **저장을 줄이는 쪽**을 골랐다 —
 *     고지를 늘리는 것보다 안 남기는 것이 언제나 안전하고, 되돌릴 수 없는 쪽은 「이미 저장된 것」이다.
 *   ⇒ 진단 손실은 작다: 배너는 지면 id 자체가 화면이고(bannerHome·bannerStockDetail…),
 *     `rid` 는 「같은 요청의 load/shown 잇기」용인데 이제 지면당 요청이 «한 번에 하나»라 이을 것이 없다.
 *     전면·리워드만 호출 화면을 잃는데, 그건 `reason`(guard 사유)과 호출 지점 수(3곳)로 충분히 좁혀진다.
 *   ⇒ 남는 저장 필드는 «정확히» 이것뿐이다: t(앱 시작 뒤 경과) · fmt · slot · ev · reason? · vis · h0?
 *     화면 경로·요청 id 는 콘솔 한 줄에만 남고 저장되지 않는다.
 *   · 날짜별 집계는 14일만 보관, 원시 이벤트는 최근 200건만(순환). 그 이상은 지운다.
 *   · 절대 throw 하지 않는다 — 계측 때문에 광고나 게임이 멈추면 안 된다.
 *   · ⛔`track(` 이라는 이름을 쓰지 않는다 — `check_analytics.mjs` 가 «전송 계측» 호출 패턴으로 보는 이름이다. 이건 전송이 아니다.
 */
import { kstDateKey, nowMs } from './daykey';

export type AdFmt = 'banner' | 'rewarded' | 'interstitial';
export type AdEv =
  | 'req'
  | 'load'
  | 'showReq'
  | 'shown'
  | 'viewable'
  | 'nofill'
  | 'fail'
  | 'guard'
  | 'reward'
  | 'abandon'
  | 'dismiss'
  /** 같은 화면 안 재마운트에 «주차된» 광고 DOM 을 옮겨 붙였다(요청 0) — 재요청을 얼마나 막았는지의 증거 */
  | 'reuse';

export interface AdEventExtra {
  reason?: string;
  /**
   * SDK 가 준 요청 id. ★[2026-09-12 · -34] «저장하지 않는다» — 콘솔 한 줄에만 쓴다.
   * 받는 자리는 남겨 둔다(호출부를 바꾸지 않기 위해). 저장 필드에서 빠진 이유는 파일 머리말 참조.
   */
  rid?: string;
  /** 광고 상자 높이가 0 이었나(렌더 실패 원인 분기) */
  h0?: boolean;
}

export interface AdSlotCounters {
  req: number;
  load: number;
  showReq: number;
  shown: number;
  viewable: number;
  nofill: number;
  fail: number;
  guard: number;
  reward: number;
  abandon: number;
  dismiss: number;
  reuse: number;
}

export interface AdRawEvent {
  /** 앱 시작 뒤 경과(ms) — 절대 시각을 남기지 않는다 */
  t: number;
  fmt: AdFmt;
  slot: string;
  ev: AdEv;
  reason?: string;
  /** 그때 앱이 «화면에 떠 있었는가» — 「안 보이는데 요청했다」를 세는 유일한 수단이다 */
  vis: 'visible' | 'hidden';
  h0?: boolean;
}

export interface AdStatsLedger {
  v: 1;
  /** KST 날짜키 → 슬롯 → 카운터 */
  days: Record<string, Record<string, AdSlotCounters>>;
  /** 최근 원시 이벤트(순환 · 최대 AD_STATS_RAW_MAX) */
  recent: AdRawEvent[];
}

export const AD_STATS_KEY = 'ml.ads.stats';
export const AD_STATS_DAYS_KEEP = 14;
export const AD_STATS_RAW_MAX = 200;

const EMPTY_COUNTERS: AdSlotCounters = {
  req: 0,
  load: 0,
  showReq: 0,
  shown: 0,
  viewable: 0,
  nofill: 0,
  fail: 0,
  guard: 0,
  reward: 0,
  abandon: 0,
  dismiss: 0,
  reuse: 0,
};

/** 모듈 평가 시각 = 앱 시작. 원시 이벤트의 상대시간 기준 */
const STATS_EPOCH = nowMs();

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function saneCounters(x: unknown): AdSlotCounters {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const out = { ...EMPTY_COUNTERS };
  for (const k of Object.keys(EMPTY_COUNTERS) as (keyof AdSlotCounters)[]) out[k] = num(o[k]);
  return out;
}

export function emptyAdStats(): AdStatsLedger {
  return { v: 1, days: {}, recent: [] };
}

/** 저장본을 «믿지 않고» 읽는다. 깨졌으면 빈 원장 — 계측이 게임을 멈추면 안 된다 */
export function readAdStats(): AdStatsLedger {
  try {
    const raw = window.localStorage.getItem(AD_STATS_KEY);
    if (!raw) return emptyAdStats();
    const o = JSON.parse(raw) as Partial<AdStatsLedger>;
    const days: AdStatsLedger['days'] = {};
    if (o.days && typeof o.days === 'object') {
      for (const [day, slots] of Object.entries(o.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !slots || typeof slots !== 'object') continue;
        days[day] = {};
        for (const [slot, c] of Object.entries(slots as Record<string, unknown>)) days[day][slot] = saneCounters(c);
      }
    }
    const recent = Array.isArray(o.recent) ? (o.recent.filter((e) => e && typeof e === 'object') as AdRawEvent[]).slice(-AD_STATS_RAW_MAX) : [];
    return { v: 1, days, recent };
  } catch {
    return emptyAdStats();
  }
}

function writeAdStats(l: AdStatsLedger): void {
  try {
    window.localStorage.setItem(AD_STATS_KEY, JSON.stringify(l));
  } catch {
    /* 용량·시크릿 모드 — 계측은 있으면 좋은 것이지 게임을 막을 이유가 못 된다 */
  }
}

/** 14일보다 오래된 날짜는 지운다 — 방침 문구(「14일 뒤 삭제」)와 같은 값이어야 한다 */
export function pruneAdStats(l: AdStatsLedger, todayKey: string, keepDays: number = AD_STATS_DAYS_KEEP): AdStatsLedger {
  const days: AdStatsLedger['days'] = {};
  const todayMs = Date.parse(todayKey + 'T00:00:00Z');
  for (const [day, v] of Object.entries(l.days)) {
    const d = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(d) || !Number.isFinite(todayMs)) continue;
    const age = Math.round((todayMs - d) / 86_400_000);
    if (age >= 0 && age < keepDays) days[day] = v;
  }
  return { v: 1, days, recent: l.recent.slice(-AD_STATS_RAW_MAX) };
}

/** ★순수 — 원장에 이벤트 하나를 «더한» 새 원장을 돌려준다(검사기가 그대로 부른다) */
export function applyAdEvent(l: AdStatsLedger, e: AdRawEvent, todayKey: string): AdStatsLedger {
  const days = { ...l.days };
  const day = { ...(days[todayKey] ?? {}) };
  const c = { ...(day[e.slot] ?? EMPTY_COUNTERS) };
  c[e.ev] = num(c[e.ev]) + 1;
  day[e.slot] = c;
  days[todayKey] = day;
  const recent = [...l.recent, e].slice(-AD_STATS_RAW_MAX);
  return pruneAdStats({ v: 1, days, recent }, todayKey);
}

function currentScreen(): string {
  try {
    const h = window.location.hash || '';
    const raw = h.startsWith('#') ? h.slice(1) : h;
    /* ★경로만. 쿼리(`?own=1`)·파라미터 값은 남기지 않는다 — 종목 코드는 «내 행동»이라 지운다 */
    const path = raw.split('?')[0] || '/';
    return path.replace(/\/(stock|leverage|option|trader|contract)\/[^/]+.*$/, '/$1/*');
  } catch {
    return '?';
  }
}

function currentVis(): 'visible' | 'hidden' {
  try {
    return document.visibilityState === 'visible' ? 'visible' : 'hidden';
  } catch {
    return 'visible';
  }
}

/**
 * 광고 이벤트 1건 기록. ⛔절대 throw 하지 않는다.
 * 콘솔에도 한 줄 남긴다(실기기 디버깅용 · 값은 위 필드뿐).
 */
export function noteAd(fmt: AdFmt, slot: string, ev: AdEv, extra: AdEventExtra = {}): void {
  try {
    const e: AdRawEvent = {
      t: Math.max(0, Math.round(nowMs() - STATS_EPOCH)),
      fmt,
      slot,
      ev,
      vis: currentVis(),
      ...(extra.reason ? { reason: String(extra.reason).slice(0, 40) } : {}),
      ...(extra.h0 ? { h0: true } : {}),
    };
    writeAdStats(applyAdEvent(readAdStats(), e, kstDateKey()));
    /* 콘솔 한 줄은 «브라우저에서만» — Node 검사기(check_interstitial)가 가짜 SDK 로 부를 때는 소음이다.
       ★화면 경로·요청 id 는 «여기까지»다 — 저장되지 않고 콘솔에만 남는다(개발자 도구를 연 사람만 본다). */
    if (typeof document !== 'undefined')
      console.info('[ads]', fmt, slot, ev, currentScreen(), e.vis, extra.reason ?? '', extra.rid ?? '', extra.h0 ? 'h0' : '');
  } catch {
    /* 계측 실패는 무음 */
  }
}

/** 오늘 슬롯 카운터(화면·하네스 조회용) */
export function adStatsToday(slot: string, todayKey: string = kstDateKey()): AdSlotCounters {
  return { ...(readAdStats().days[todayKey]?.[slot] ?? EMPTY_COUNTERS) };
}
