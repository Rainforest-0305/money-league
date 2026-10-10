/**
 * 세션을 «넘어» 이어지는 화면 기록 두 가지 — 홈 자산 흐름 · 중앙은행 체결 (2026-08-31, -23).
 *
 * ── 왜 생겼나 (President 08-30) ─────────────────────────────────────────
 *   「나갔다가 들어오면 기록이 다 날아가? 그래프도 … 중앙은행 거래 기록도 초기화된 거 같아서」
 *   [실측 L6] 계좌·일지·출석은 유지됐다. 날아간 것은 «메모리에만» 있던 두 가지였다:
 *     · `store.equityHistory`(자산 흐름 180틱) — 세션마다 빈 배열에서 시작
 *     · 엔진 중앙은행 링버퍼(세션 한정) — gameWorld.centralBankView 가 그대로 흘림
 *   ⇒ 둘 다 «스토어 쪽» 별도 키로 영속한다. ⛔엔진(lib/engine/*) 은 «한 줄도» 건드리지 않는다 —
 *     엔진 링버퍼는 «세션 체결»만 내고, 이 파일의 원장이 그것을 «흡수»해 세션을 넘겨 보관한다.
 *
 * ── 저장 경계 (선례: ml.journal · ml.attendance) ────────────────────────
 *   ★세이브 블롭(`ml.game`) «밖»의 독립 키다 ⇒ SAVE_VERSION 불변 · 마이그레이션 0.
 *   ★손상돼도 게임이 죽으면 안 되는 데이터다 — 못 읽으면 «빈 기록»으로 시작한다(sane).
 *   ★lsSet 이 네이티브 미러도 쓴다 → toss/storage.APP_STORAGE_KEYS 에 넣어 부팅 때 «없는 키만» 되살린다.
 *
 * ── 세션 경계 «마커» ────────────────────────────────────────────────────
 *   이어붙이면 «접속 사이» 구간이 점프/평평으로 보인다 — 버그로 오해되지 않게 화면이 경계를 «그린다».
 *   · 자산 흐름: `marks` = «새 세션의 첫 점 인덱스». 차트가 그 자리에 점선을 세운다.
 *   · 중앙은행: 체결마다 `sid`(세션 시작 시각) 와 `at`(체결 벽시계) 을 남겨 시트가 세션 헤더(날짜·시각)를 끼운다.
 */
import { EQUITY_HISTORY_LEN } from '../lib/constants';
import type { CentralBankFillView } from '../lib/types';
import { lsRemove, lsSet } from '../toss/storage';

export const LS_EQUITY = 'ml.equity';
export const LS_CBFILLS = 'ml.cbfills';
/** 중앙은행 체결 보관 수(세션을 넘어). 원장 규격: 최근 100건 */
export const CB_LEDGER_MAX = 100;

function nums(x: unknown): number[] {
  return Array.isArray(x) ? x.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
}

/* ── 자산 흐름 ──────────────────────────────────────────────────────────── */
export class EquityHistory {
  /** 오래된 → 최신. 길이 ≤ EQUITY_HISTORY_LEN */
  pts: number[] = [];
  /** «새 세션의 첫 점» 인덱스들(오름차순, 0 < m < pts.length). 차트 점선 자리 */
  marks: number[] = [];
  private dirty = false;

  constructor() {
    try {
      const raw = localStorage.getItem(LS_EQUITY);
      if (!raw) return;
      const o = JSON.parse(raw) as { pts?: unknown; marks?: unknown };
      const pts = nums(o.pts);
      this.pts = pts.slice(Math.max(0, pts.length - EQUITY_HISTORY_LEN));
      const drop = pts.length - this.pts.length;
      this.marks = nums(o.marks)
        .map((m) => Math.floor(m) - drop)
        .filter((m) => m > 0 && m < this.pts.length);
    } catch {
      /* 손상값 → 빈 기록. 게임이 죽는 것보다 낫다 */
      this.pts = [];
      this.marks = [];
    }
  }

  /**
   * 부팅 복원 직후 1회 — 저장된 점이 있으면 «여기부터 새 세션»을 표시한다.
   * ⛔push 보다 «먼저» 불러야 한다(첫 점이 새 세션의 첫 점이다).
   */
  startSession(): void {
    const n = this.pts.length;
    if (n > 0 && this.marks[this.marks.length - 1] !== n) {
      this.marks.push(n);
      this.dirty = true;
    }
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    /*
     * ★배열을 «새로» 만든다(제자리 push 금지). AreaChart 의 useMemo 가 data «참조»로 재계산을 판단하므로
     *   제자리 변경이면 홈에 머무는 동안 그래프가 «멈춘다» — -22 까지의 in-place push 가 실제로 그랬다
     *   (실측 _probe_flush: -22 번들에서 12초 뒤에도 chart 4점 고정 · 화면을 갔다 와야 갱신). 180개 복사는 틱당 1회라 비용이 없다.
     */
    const keep = Math.max(0, this.pts.length - (EQUITY_HISTORY_LEN - 1));
    const next = this.pts.slice(keep);
    next.push(v);
    this.pts = next;
    /* 창이 밀리면 경계도 그만큼 앞으로. 0 이하가 된 경계는 «왼쪽 끝 밖»이라 버린다 */
    if (keep > 0) this.marks = this.marks.map((m) => m - keep).filter((m) => m > 0);
    this.dirty = true;
  }

  /** 시즌 초기화·로그아웃 — 그래프도 처음부터 */
  reset(): void {
    this.pts = [];
    this.marks = [];
    this.dirty = false;
    lsRemove(LS_EQUITY);
  }

  /** 15틱마다·탭 숨김·페이지 이탈에 부른다(세이브 블롭과 같은 박자). 바뀐 게 없으면 안 쓴다 */
  flush(tick: number): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      lsSet(LS_EQUITY, JSON.stringify({ v: 1, tick, at: Date.now(), pts: this.pts, marks: this.marks }));
    } catch {
      /* 용량 초과 등 — 그래프 때문에 게임이 멈추면 안 된다 */
    }
  }
}

/* ── 중앙은행 체결 원장 ─────────────────────────────────────────────────── */
export interface CbFillRecord extends CentralBankFillView {
  /** 체결 벽시계(ms) — 세션 헤더의 날짜·시각 */
  at: number;
  /** 세션 id = 그 세션의 부팅 시각(ms). 같으면 같은 접속 */
  sid: number;
}

function saneFill(x: unknown): CbFillRecord | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  const n = (k: string) => (typeof e[k] === 'number' && Number.isFinite(e[k] as number) ? (e[k] as number) : null);
  const id = n('id');
  const at = n('at');
  const sid = n('sid');
  const notional = n('notional');
  const price = n('price');
  if (id === null || at === null || sid === null || notional === null || price === null || typeof e.ticker !== 'string') return null;
  return {
    id,
    at,
    sid,
    tick: n('tick') ?? 0,
    gameDay: n('gameDay') ?? 0,
    ticker: e.ticker,
    side: e.side === 'sell' ? 'sell' : 'buy',
    notional,
    price,
    basisBefore: n('basisBefore') ?? 0,
    /* ★[-24] 바스켓 다리(있을 때만) */
    ...(n('basketNotional') !== null && n('basketPrice') !== null
      ? { basketSide: (e.basketSide === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell', basketNotional: n('basketNotional')!, basketPrice: n('basketPrice')! }
      : {}),
  };
}

export class CbLedger {
  /** 최신이 앞. 길이 ≤ CB_LEDGER_MAX */
  fills: CbFillRecord[] = [];
  /** 누적 개입 횟수(세션을 넘어). 순위표 카드 「N회 개입」 */
  total = 0;
  /** 이번 세션 id — 부팅 시각 */
  readonly sid = Date.now();
  /** 엔진 링버퍼는 세션마다 id 가 1 부터 다시 시작한다 — 이 세션에서 마지막으로 흡수한 id */
  private lastId = 0;

  constructor() {
    try {
      const raw = localStorage.getItem(LS_CBFILLS);
      if (!raw) return;
      const o = JSON.parse(raw) as { fills?: unknown; total?: unknown };
      const list = Array.isArray(o.fills) ? o.fills : [];
      for (const x of list) {
        const f = saneFill(x);
        if (f) this.fills.push(f);
      }
      this.fills = this.fills.slice(0, CB_LEDGER_MAX);
      this.total = typeof o.total === 'number' && Number.isFinite(o.total) ? Math.max(this.fills.length, Math.floor(o.total)) : this.fills.length;
    } catch {
      this.fills = [];
      this.total = 0;
    }
  }

  /**
   * 엔진 «세션 링버퍼»(최신 앞, id 오름차순 부여)에서 아직 못 본 체결만 흡수한다. 매 틱 불러도 싸다 —
   * 맨 앞 id 가 lastId 이하이면 즉시 돌아간다(할당 0).
   * @returns 새로 들어온 게 있으면 true (호출자가 bump)
   */
  absorb(engineFills: readonly CentralBankFillView[]): boolean {
    if (engineFills.length === 0 || engineFills[0].id <= this.lastId) return false;
    const fresh = engineFills.filter((f) => f.id > this.lastId).sort((a, b) => a.id - b.id);
    const now = Date.now();
    for (const f of fresh) {
      this.fills.unshift({ ...f, at: now, sid: this.sid });
      this.lastId = f.id;
      this.total++;
    }
    if (this.fills.length > CB_LEDGER_MAX) this.fills.length = CB_LEDGER_MAX;
    this.flush();
    return true;
  }

  reset(): void {
    this.fills = [];
    this.total = 0;
    this.lastId = 0;
    lsRemove(LS_CBFILLS);
  }

  /** 체결은 드물다(≈1회/500틱) — 들어올 때 «즉시» 쓴다. 모아 쓸 이유가 없다 */
  private flush(): void {
    try {
      lsSet(LS_CBFILLS, JSON.stringify({ v: 1, total: this.total, fills: this.fills }));
    } catch {
      /* 용량 초과 등 — 원장 때문에 게임이 멈추면 안 된다 */
    }
  }
}
