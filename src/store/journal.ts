/**
 * 거래 일지 원장 — 「거래 내역 N건」의 ★N 건이 «무엇이었는지»를 남긴다.
 *
 * ── 왜 새로 만드나 (2026-08-21, 코드 실측) ────────────────────────────
 * 엔진 `Account` 가 들고 있는 거래 관련 값은 ★누적치 3개뿐이다:
 *     realizedPnl · feesPaid · tradeCount
 * 개별 체결 기록은 ★어디에도 없었다. `world.placeSpotOrder` 는 `trade` 이벤트를
 * emit 하지만 그건 «홈 피드용 표본추출»로만 쓰이고(3% 샘플·봇 한정) 저장되지 않는다.
 * ⇒ 설정 화면의 「거래 내역 N건」은 «셀 수는 있지만 열 수는 없는» 숫자였다.
 *
 * ── 저장 경계 ──────────────────────────────────────────────────────────
 * ★세이브 블롭(`ml.game`)과 ★«다른 키»에 둔다(`ml.journal`).
 *   ⇒ `SAVE_VERSION` 을 건드리지 않는다 = 라이브 유저의 포지션·잔고가 그대로다
 *     (President 하드게이트). `ml.traderwatch` · `ml.quotesession` 과 같은 패턴이다.
 * ★그리고 «옛 기기에 이 키가 없는 것»이 정상이다 — 그때는 빈 일지로 시작하고,
 *   화면이 「이전 거래 N건은 합계에만 있다」를 사실대로 말한다. ⛔지어내지 않는다.
 *
 * ── 손익·수수료를 여기서 «계산하지 않는다» ─────────────────────────────
 * `realized` · `fee` 는 호출부가 넘겨준 ★엔진 원장의 «증분»이다.
 * ⛔화면이 자기 식으로 다시 계산하면 엔진이 규칙을 바꾸는 날 조용히 틀린다
 *   (store.ts 의 「옵션 매도에 매수식 → 수수료 이중부과 + realizedPnl 매수기준」 경고).
 */
import type { JournalEntry } from '../lib/types';
import { JOURNAL_MAX } from '../lib/constants';
import { lsSet, lsRemove } from '../toss/storage';

const LS_JOURNAL = 'ml.journal';

/**
 * 저장본에서 읽어 온 값 한 건을 «믿지 않고» 검증한다 (traderWatch 와 같은 패턴).
 *
 * ⛔★[2026-08-23] `product` · `action` 은 «캐스팅만 하고 유니온을 검증하지 않는다».
 *   그게 «의도»다 — 덕분에 상품을 늘려도 구/신 버전이 «양방향»으로 호환된다:
 *     · 새 버전이 쓴 `product:'dividend'` 를 옛 버전이 읽어도 «줄이 사라지지 않는다»
 *       (화면에서 배지만 undefined 가 되므로 그쪽은 화면이 방어한다)
 *     · 옛 버전이 쓴 일지를 새 버전이 읽는 것도 그대로 된다
 *   ⇒ ★그러니 여기에 「유니온에 있는 값인지」 검사를 «넣지 마라».
 *     넣는 순간 «구버전에서 신버전 항목이 조용히 증발»한다. 정말 넣어야 한다면
 *     모르는 값을 «버리지 말고» 별도 상품으로 격하시켜라.
 */
function sane(x: unknown): JournalEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined);
  const n = (k: string) => (typeof e[k] === 'number' && Number.isFinite(e[k] as number) ? (e[k] as number) : undefined);
  const id = s('id');
  const product = s('product');
  const action = s('action');
  const ticker = s('ticker');
  if (!id || !product || !action) return null;
  /*
   * ★종목이 «없는» 항목이 있다: 공유 리워드(product='reward')는 매매가 아니라 지급이다.
   *   ⛔여기서 ticker 를 무조건 요구하면 그 줄이 ★재시작 때마다 조용히 사라진다
   *     (에러도 안 나고 유저는 「받았는데 기록이 없다」만 본다).
   *   ⇒ 예외를 «모양 규칙»이 아니라 ★«한 상품»으로 못박는다 — 세어볼 수 있게(U-4).
   */
  /* ★배당도 «종목이 없을 수 있다» — 같은 틱에 여러 종목이 지급되면 «묶어서 한 줄»로 남기고
     그때는 ticker 가 빈 문자열이고 count 에 종목 수가 들어간다(store.flushDividends).
     ⛔묶지 않고 종목마다 한 줄씩 남기면 20종목 보유 시 25분마다 20줄이 쌓여
       JOURNAL_MAX(250) 안에서 «매매 기록이 배당에 밀려 사라진다». */
  if (!ticker && product !== 'reward' && product !== 'dividend') return null;
  const out: JournalEntry = {
    id,
    at: n('at') ?? 0,
    tick: n('tick') ?? 0,
    gameDay: n('gameDay') ?? 0,
    product: product as JournalEntry['product'],
    action: action as JournalEntry['action'],
    ticker: ticker ?? '',
    fee: n('fee') ?? 0,
  };
  /* ★선택 필드는 «하나씩 이름으로» 옮긴다. 동적 인덱싱으로 접으면 타입이 사라지고,
     그러면 필드를 추가할 때 여기만 조용히 빠진다(이 프로젝트의 반복 실패 유형). */
  out.qty = n('qty');
  out.price = n('price');
  out.notional = n('notional');
  out.margin = n('margin');
  out.leverage = n('leverage');
  out.strike = n('strike');
  out.realized = n('realized');
  out.tickerB = s('tickerB');
  out.side = s('side');
  out.optKind = s('optKind') as JournalEntry['optKind'];
  out.optSide = s('optSide') as JournalEntry['optSide'];
  out.posId = s('posId');
  out.count = n('count');
  out.via = s('via');
  return out;
}

export class Journal {
  /** ★최신이 앞이다(unshift). 화면이 정렬을 다시 하지 않아도 되게 한다 */
  entries: JournalEntry[] = [];
  /** 새로고침해도 id 가 겹치지 않도록 저장본의 최대 seq 에서 이어 붙인다 */
  private seq = 0;
  private dirty = false;
  private timer: number | null = null;

  constructor(private readonly onChange: () => void) {
    try {
      const raw = localStorage.getItem(LS_JOURNAL);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      for (const x of list) {
        const e = sane(x);
        if (e) this.entries.push(e);
      }
      this.entries = this.entries.slice(0, JOURNAL_MAX);
      for (const e of this.entries) {
        const m = /^j(\d+)$/.exec(e.id);
        if (m) this.seq = Math.max(this.seq, Number(m[1]));
      }
    } catch {
      /* 손상값이면 빈 일지로 시작한다 — 화면이 죽는 것보다 낫다 */
      this.entries = [];
    }
  }

  /** 한 건 기록하고 그 id 를 돌려준다. 되돌리기가 이 id 로 «지운다» */
  push(e: Omit<JournalEntry, 'id'>): string {
    const id = `j${++this.seq}`;
    this.entries.unshift({ ...e, id });
    if (this.entries.length > JOURNAL_MAX) this.entries.length = JOURNAL_MAX;
    this.schedule();
    return id;
  }

  /**
   * 되돌리기 성사분을 지운다. ★「없던 일」이어야 한다 —
   * 5초 안에 되돌린 주문이 일지에 남으면 유저는 자기 기록을 못 믿는다.
   */
  remove(id: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.schedule();
  }

  /** 계정 초기화(로그아웃) = 처음부터 다시. 일지도 함께 지운다 */
  clear(): void {
    this.entries = [];
    this.seq = 0;
    this.dirty = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    lsRemove(LS_JOURNAL);
    this.onChange();
  }

  /**
   * ★쓰기를 «모아서» 한다.
   *   따라잡기(catchup 300틱) 한 번에 만기 정산이 여러 건 몰릴 수 있는데,
   *   그때마다 수십 KB 를 직렬화하면 그 프레임을 먹는다. 이 앱은 60fps 가 조건이다.
   */
  private schedule(): void {
    this.dirty = true;
    this.onChange();
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 0);
  }

  /** 즉시 기록(탭 숨김·페이지 이탈 직전). 밀린 쓰기를 들고 나가면 그대로 유실이다 */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      lsSet(LS_JOURNAL, JSON.stringify(this.entries));
    } catch {
      /* 용량 초과 등 — 일지 때문에 게임이 멈추면 안 된다 */
    }
  }
}
