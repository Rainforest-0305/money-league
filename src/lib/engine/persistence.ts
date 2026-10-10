/**
 * 로컬 영속화 — 새로고침해도 내 계좌가 남는다.
 *
 * 왜 필요했나: 구 mockWorld.ts:97 은 생성자에서 매번 `cash = SEED_CASH` 로 시작해서
 * 새로고침 한 번에 자산이 시드로 리셋됐다(저장 자체가 없었다).
 *
 * 저장 shape 는 서버 `world/gameService.ts:17-27` 의 SerializedAccount 가 정본이고,
 * 여기에 (a) 충전 카운터(KST 날짜키/당일 사용횟수/마지막 충전시각),
 * (b) 종목별 마지막 가격 을 더했다.
 *
 * ★ 봇 210개는 저장하지 않는다 — 근거:
 *   봇 계정은 각자 최대 100종목 보유 + 레버리지/옵션 포지션을 갖는다. 최악
 *   210 × (100 holdings + 4 lev + n opt) ≈ 2만 엔트리로 JSON 수 MB 가 되어
 *   localStorage 한도(대개 5MB)를 넘긴다. 반면 봇은 "시장을 만드는 장치"이지
 *   플레이어의 소유물이 아니다. 그래서 봇은 매 세션 워밍업 3000틱으로 새로
 *   만들고(=자산 분포는 실매매 결과로 다시 벌어진다), 유저 자산에 직접 영향을 주는
 *   **종목 가격만** 저장해 연속성을 지킨다(gameWorld.ts 의 rescale 참조).
 *   비용: 랭킹의 봇 순위/자산은 세션마다 달라진다. 서버가 없는 이상 불가피하다.
 */
import type { ForwardPosition, Holding, LeveragePosition, Loan, OptionPosition, SwapPosition } from './types';
/**
 * 네이티브 Storage «미러 전용» 헬퍼(iOS ITP 7일 삭제 대비).
 * 이 파일은 localStorage 쓰기를 자체 방어로직(disabled 플래그)과 함께 이미
 * 수행하므로, localStorage 를 또 건드리지 않는 mirrorSave/mirrorDrop 을 쓴다.
 * 토스 밖에서는 둘 다 no-op 이라 웹 배포본 동작은 완전히 동일하다.
 */
import { mirrorSave, mirrorDrop } from '../../toss/storage';

export const SAVE_KEY = 'ml.game';
export const SAVE_VERSION = 1;

export interface SavedAccount {
  cash: number;
  holdings: [string, Holding][];
  levPositions: LeveragePosition[];
  optPositions: OptionPosition[];
  /**
   * ★선도·스왑 (2026-08-20 파생 확장). ★optional 이다 —
   *   기존 저장본엔 이 키가 «아예 없다». 없으면 빈 배열로 복원한다.
   *   ⛔SAVE_VERSION 은 올리지 않는다(올리면 라이브 유저 진행이 통째로 날아간다).
   */
  fwdPositions?: ForwardPosition[];
  swapPositions?: SwapPosition[];
  realizedPnl: number;
  feesPaid: number;
  tradeCount: number;
  liquidationCount: number;
  topupCount: number;
  /**
   * ★충전 외 경로로 주입된 시드(USD) — 공유 리워드. 2026-08-22 신설.
   *   ★optional 이다: 기존 저장본엔 이 키가 «아예 없다». 없으면 0 으로 복원한다.
   *   ⛔SAVE_VERSION 은 올리지 않는다(올리면 라이브 유저 진행이 통째로 날아간다).
   */
  bonusSeed?: number;
  /**
   * ★대출 (2026-09-05 President 지시). ★optional 이다 —
   *   2026-09-05 «이전» 저장본엔 이 키가 «아예 없다». 없으면 빈 배열 = 대출 없음으로 복원된다.
   *   ⛔SAVE_VERSION 은 올리지 않는다(올리면 라이브 유저 진행이 통째로 날아간다).
   *   ⇒ 구 저장본을 그대로 읽으면 순자산 = 총자산이라 «지금까지와 완전히 같은 게임»이다.
   *     그 무변경을 `scripts/check_loans.mjs` 가 수치로 증명한다.
   */
  loans?: Loan[];
  /** ★대출 연체 «이력» 횟수. 없으면 0 */
  delinquencyCount?: number;
  /**
   * ★«마이너스 계좌»(연체) 상태 — 2026-09-05. 잔액은 여기 없다(음수 `cash` 가 잔액이다).
   *   없으면 null = 정상. ⛔잔액 필드를 여기 만들지 마라 — 두 벌이 되면 갈린다.
   */
  overdraft?: { spreadBp: number; sinceDay: number; lastAccrualDay: number } | null;
  /** ★연체 파산 이력 횟수(영구). 없으면 0 */
  bankruptcyCount?: number;
}

export interface SavedTopup {
  /** KST 날짜키 'YYYY-MM-DD' — 이 값이 바뀌면 당일 사용횟수를 0으로 리셋한다 */
  dateKey: string;
  usedToday: number;
  lastTopupAt: number;
}

/**
 * 일일 카운터 — 리워드 광고 도입(2026-08-19)으로 «새로 생긴» 저장 항목.
 *
 * ★ 라이브 앱이라 «기존 저장본에는 이 키가 아예 없다». 그래서
 *   (a) SavedGame 에서 optional 이고, (b) loadGame() 이 빠졌을 때 안전한
 *   기본값을 만들어 넣는다. ★SAVE_VERSION 은 «올리지 않는다» —
 *   올리면 loadGame() 이 `s.v !== SAVE_VERSION` 에서 null 을 돌려주고
 *   기존 유저의 «현금·보유종목·포지션이 전부 날아간다».
 */
export interface SavedDaily {
  /** KST 날짜키. 바뀌면 아래 값이 전부 리셋된다(충전과 같은 기준) */
  dateKey: string;
  /** 오늘 리워드 광고로 얻은 «추가» 충전 횟수 (0..TOPUP_AD_BONUS_MAX) */
  topupBonus: number;
  /**
   * 그중 «실제로 받아간» 횟수. 2026-08-20 신설.
   *
   * ★왜 따로 세는가: 이제 «무료 충전»과 «광고 충전»의 규칙이 다르다.
   *   - 무료 3회 = 파산(총자산 < $200) 구제 전용
   *   - 광고 10회 = 파산과 무관, 언제든
   *   한 카운터(usedToday)로 섞으면 「광고로 받은 것 때문에 파산 구제분이 줄어드는」
   *   일이 생긴다. 역할이 다른 자원은 따로 센다.
   * ★기존 저장본에는 이 키가 «없다» → loadGame 이 0 으로 채운다.
   *   ⛔SAVE_VERSION 은 올리지 않는다(올리면 기존 유저 진행이 통째로 날아간다).
   */
  topupAdUsed: number;
  /** 오늘 이미 연 트레이더 accountId (재열람 무료) */
  viewedTraders: string[];
  /** 오늘 리워드 광고로 얻은 «추가» 열람권 */
  viewBonus: number;
  /**
   * ★오늘 «공유 리워드»를 지급한 횟수. 2026-08-22 신설.
   *
   * ★★이게 «중복 지급 방지»의 본체다. 왜 여기 두는가:
   *   ① 앱 재시작 후에도 유지돼야 한다 → 저장본에 있어야 한다.
   *   ② 현금 가산과 ★같은 `save()` 한 번에 기록돼야 한다 → 별도 키였다면
   *      「돈은 들어갔는데 카운터는 안 남는」 창이 생긴다. 같은 블롭이면 그 창이 없다.
   *   ③ KST 자정에 «다른 일일 카운터와 같이» 리셋된다 — 리셋 시각을 두 개 만들지 않는다.
   * ★토스는 `sendViral` 이벤트에 ★식별자를 주지 않는다 [실측: contactsViral.d.ts 스키마].
   *   ⇒ 「이벤트 단위 멱등」이 원천적으로 불가능하다. 그래서 멱등의 «단위»를
   *     ★«하루 슬롯»으로 잡았다: 같은 이벤트가 두 번 와도 두 번째는 상한에 막힌다.
   * ★기존 저장본에는 없다 → 0.
   */
  shareGrants: number;
  /** 오늘 공유 리워드로 «실제 지급된» 누적 금액(USD). 화면·일지 대조용 */
  shareUsd: number;
}

export interface SavedGame {
  v: number;
  savedAt: number;
  /** 저장 시점의 월드 틱 (게임일 연속성) */
  tick: number;
  account: SavedAccount;
  topup: SavedTopup;
  /** 2026-08-19 신설. 기존 저장본에는 «없다» — 반드시 기본값 처리 */
  daily?: SavedDaily;
  /** ticker -> 마지막 가격 */
  prices: Record<string, number>;
}

/** 기존 저장본(daily 키 없음)도 안전하게 오늘자로 시작하게 하는 기본값 */
export function emptyDaily(dateKey: string): SavedDaily {
  return { dateKey, topupBonus: 0, topupAdUsed: 0, viewedTraders: [], viewBonus: 0, shareGrants: 0, shareUsd: 0 };
}

/** 저장이 한 번이라도 실패하면(프라이빗 모드·용량초과) 이후 시도를 멈춘다 */
let disabled = false;
let warned = false;

export function persistenceDisabled(): boolean {
  return disabled;
}

/**
 * 저장본에서 읽은 값을 «숫자로» 만든다.
 *
 * ★★[하드닝 2026-08-20] 예전에는 `typeof v === 'number'` 가 아니면 «무조건 fallback(0)» 이었다.
 *   그래서 현금이 문자열 "3000" 으로 들어오면 ★0 이 됐다 — ★유저 돈 $3,000 이 조용히 사라진다
 *   (경계 저장본 B3 실측으로 잡았다).
 *   문자열 숫자는 «손상»이 아니라 «형이 어긋난 것»뿐이다. 되살릴 수 있으면 되살린다.
 *   ⇒ 숫자 모양의 문자열은 «변환»하고, 진짜로 못 읽는 값만 fallback 으로 떨어뜨린다.
 * ⛔boolean 은 «일부러» 안 받는다 — Number(true)=1 이라 true 가 1주/1달러가 되는 게 더 나쁘다.
 *
 * ★★최종 관문은 `Number.isFinite()` 다 — 변환 «후»에 유한수가 아니면 무조건 fallback.
 *   그래야 Infinity·NaN 이 «구조적으로» 못 들어온다. 실측 경계표(전부 확인함):
 *     "1e999" → fallback   "Infinity"/"-Infinity" → fallback   "NaN" → fallback
 *     ""/" " → fallback     "abc12"/"12abc" → fallback          "1,000" → fallback
 *     " 12 " → 12           "0x10" → 16                          "-500" → -500(부호 보존)
 *     true/false → fallback  []/["5"]/[5,6]/{} → fallback (typeof 가 object 라 Number() 를 «아예 안 부른다»)
 *   ⚠️"1,000"(콤마)은 되살리지 «않는다». 로케일마다 콤마가 소수점인 곳이 있어
 *     추측 복원이 오히려 값을 «틀리게» 만든다. 못 읽는 건 못 읽는다고 둔다.
 */
function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** localStorage 자체가 없는 환경(구형 웹뷰·프라이빗 모드)도 있다 */
function storage(): Storage | null {
  if (disabled) return null;
  try {
    const ls = window.localStorage;
    if (!ls) return null;
    return ls;
  } catch {
    disabled = true;
    return null;
  }
}

export function loadGame(): SavedGame | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedGame>;
    if (!s || s.v !== SAVE_VERSION || !s.account) return null;

    const a = s.account as Partial<SavedAccount>;
    const account: SavedAccount = {
      cash: num(a.cash),
      /*
       * ★★[하드닝 2026-08-20] 예전에는 «필드 두 개»만 봤다:
       *     보유   → qty 만
       *     레버리지 → id · margin 만   ← ★notional·qty·entryPrice 는 «검사도 안 했다»
       *     옵션   → id · contracts 만
       *   그런데 equity() 는 그 안 본 필드들로 계산한다. 하나라도 undefined/NaN 이면
       *   ★총자산이 통째로 NaN 이 되고, 화면 전체가 NaN 으로 덮이며 차트 path 가 깨진다
       *   (실측: <path> d "L390.0 NaN" · <circle> cy NaN — 화면이 «조용히» 망가진다).
       * ★그래서 «버리지 말고 고친다»: 파생 필드는 정본 필드에서 다시 계산할 수 있다.
       *   notional = margin × leverage · qty = notional / entryPrice.
       *   ⛔포지션을 통째로 버리면 그건 유저 돈을 지우는 것이다. 되살릴 수 있으면 되살린다.
       * ★되살릴 수 없는 것(증거금·배율·진입가가 망가진 경우)만 «어쩔 수 없이» 뺀다.
       */
      holdings: (Array.isArray(a.holdings) ? a.holdings : []).flatMap((h): [string, Holding][] => {
        if (!Array.isArray(h) || typeof h[0] !== 'string' || !h[1]) return [];
        const qty = num((h[1] as Partial<Holding>).qty, 0);
        const avgCost = num((h[1] as Partial<Holding>).avgCost, 0);
        if (!(qty > 0) || !(avgCost >= 0)) return [];
        return [[h[0], { qty, avgCost }]];
      }),
      levPositions: (Array.isArray(a.levPositions) ? a.levPositions : []).flatMap(
        (raw): LeveragePosition[] => {
          const p = raw as Partial<LeveragePosition> | null;
          if (!p || typeof p.id !== 'string' || typeof p.ticker !== 'string') return [];
          const margin = num(p.margin, 0);
          const leverage = num(p.leverage, 0);
          const entryPrice = num(p.entryPrice, 0);
          // 정본 3종이 살아 있어야 나머지를 유도할 수 있다
          if (!(margin > 0) || !(leverage > 0) || !(entryPrice > 0)) return [];
          const notional = num(p.notional, 0) > 0 ? num(p.notional) : margin * leverage;
          const qty = num(p.qty, 0) > 0 ? num(p.qty) : notional / entryPrice;
          const openedTick = Math.max(0, Math.floor(num(p.openedTick, 0)));
          return [
            {
              id: p.id,
              ticker: p.ticker,
              side: p.side === 'short' ? 'short' : 'long',
              leverage,
              margin,
              notional,
              qty,
              entryPrice,
              openedTick,
              fundingPaid: Math.max(0, num(p.fundingPaid, 0)),
              lastFundingTick: Math.max(0, Math.floor(num(p.lastFundingTick, openedTick))),
              /*
               * ★선물 만기. 키가 «없으면» undefined = 무기한 레버리지(기존 동작 그대로).
               * ★키가 있는데 값이 손상됐으면 0 → «이미 만기»로 본다(즉시 정산).
               *   옵션 만기와 «같은 규칙»이다 — 무한 존속보다 즉시 정산이 안전하다.
               */
              ...(p.expiryTick === undefined
                ? {}
                : { expiryTick: Math.max(0, Math.floor(num(p.expiryTick, 0))) }),
            },
          ];
        }
      ),
      optPositions: (Array.isArray(a.optPositions) ? a.optPositions : []).flatMap(
        (raw): OptionPosition[] => {
          const p = raw as Partial<OptionPosition> | null;
          if (!p || typeof p.id !== 'string' || typeof p.ticker !== 'string') return [];
          const contracts = num(p.contracts, 0);
          const strike = num(p.strike, 0);
          if (!(contracts > 0) || !(strike > 0)) return [];
          const openedTick = Math.max(0, Math.floor(num(p.openedTick, 0)));
          return [
            {
              id: p.id,
              ticker: p.ticker,
              kind: p.kind === 'put' ? 'put' : 'call',
              strike,
              contracts,
              premiumPaid: Math.max(0, num(p.premiumPaid, 0)),
              feePaid: Math.max(0, num(p.feePaid, 0)),
              openedTick,
              // 만기 정보가 망가졌으면 «이미 만기»로 본다(즉시 정산). 무한 존속보다 낫다.
              expiryTick: Math.max(0, Math.floor(num(p.expiryTick, openedTick))),
              /*
               * ★옵션 «매도(숏)» 복원 (2026-08-20).
               * ★side 가 없으면 'buy' 다 — 기존 저장본은 전부 매수였다.
               * ★margin 이 손상돼도 «포지션을 버리지 않는다». 버리면 유저가 예치한 증거금이
               *   통째로 사라진다. 정본인 premiumPaid 에서 «다시 계산»해 최소한을 살린다
               *   (증거금은 정의상 수취 프리미엄 이상이다).
               */
              ...(p.side === 'sell'
                ? {
                    side: 'sell' as const,
                    margin: (() => {
                      const m = num(p.margin, 0);
                      const prem = Math.max(0, num(p.premiumPaid, 0));
                      return m > 0 ? m : prem;
                    })(),
                  }
                : {}),
            },
          ];
        }
      ),
      /*
       * ★선도 복원. 정본 3종(contractPrice · notional · margin)이 살아 있어야 한다.
       *   qty 는 파생 필드라 «버리지 말고 재계산»한다 — 레버리지 qty 와 같은 원칙이다.
       */
      fwdPositions: (Array.isArray(a.fwdPositions) ? a.fwdPositions : []).flatMap(
        (raw): ForwardPosition[] => {
          const p = raw as Partial<ForwardPosition> | null;
          if (!p || typeof p.id !== 'string' || typeof p.ticker !== 'string') return [];
          const contractPrice = num(p.contractPrice, 0);
          const notional = num(p.notional, 0);
          const margin = num(p.margin, 0);
          if (!(contractPrice > 0) || !(notional > 0) || !(margin > 0)) return [];
          const qty = num(p.qty, 0) > 0 ? num(p.qty) : notional / contractPrice;
          const openedTick = Math.max(0, Math.floor(num(p.openedTick, 0)));
          return [
            {
              id: p.id,
              ticker: p.ticker,
              side: p.side === 'short' ? 'short' : 'long',
              notional,
              qty,
              contractPrice,
              refPrice: num(p.refPrice, 0) > 0 ? num(p.refPrice) : contractPrice,
              margin,
              counterparty: (typeof p.counterparty === 'string' ? p.counterparty : 'noise') as ForwardPosition['counterparty'],
              openedTick,
              // 만기가 망가졌으면 «이미 만기» — 옵션과 같은 규칙(즉시 정산)
              expiryTick: Math.max(0, Math.floor(num(p.expiryTick, openedTick))),
              feePaid: Math.max(0, num(p.feePaid, 0)),
            },
          ];
        }
      ),
      /*
       * ★스왑 복원. 정본 4종(entryA · entryB · notional · margin)이 살아 있어야 한다.
       *   carrySpread 는 0 이 «유효한 값»이라 >0 검사를 하면 안 된다 — num() 만 태운다.
       */
      swapPositions: (Array.isArray(a.swapPositions) ? a.swapPositions : []).flatMap(
        (raw): SwapPosition[] => {
          const p = raw as Partial<SwapPosition> | null;
          if (!p || typeof p.id !== 'string') return [];
          if (typeof p.tickerA !== 'string' || typeof p.tickerB !== 'string') return [];
          const entryA = num(p.entryA, 0);
          const entryB = num(p.entryB, 0);
          const notional = num(p.notional, 0);
          const margin = num(p.margin, 0);
          if (!(entryA > 0) || !(entryB > 0) || !(notional > 0) || !(margin > 0)) return [];
          const openedTick = Math.max(0, Math.floor(num(p.openedTick, 0)));
          return [
            {
              id: p.id,
              tickerA: p.tickerA,
              tickerB: p.tickerB,
              side: p.side === 'b' ? 'b' : 'a',
              notional,
              entryA,
              entryB,
              carrySpread: num(p.carrySpread, 0),
              margin,
              counterparty: (typeof p.counterparty === 'string' ? p.counterparty : 'noise') as SwapPosition['counterparty'],
              openedTick,
              expiryTick: Math.max(0, Math.floor(num(p.expiryTick, openedTick))),
              feePaid: Math.max(0, num(p.feePaid, 0)),
            },
          ];
        }
      ),
      /*
       * ★부호 규칙을 «필드마다» 정한다 (2026-08-20).
       *   · cash · realizedPnl → ★부호를 «건드리지 않는다». 손실이면 realizedPnl 은 음수가 맞고,
       *     펀딩비가 현금을 넘기면 cash 도 음수가 될 수 있다. 0으로 올리면 «없는 돈을 만드는» 것이다.
       *   · feesPaid · 각종 횟수 → ★음수가 «도메인상 불가»하다. 누적값·카운터다.
       *     음수로 들어오면 그건 손상이므로 0으로 자른다(정수화도 함께).
       */
      realizedPnl: num(a.realizedPnl),
      feesPaid: Math.max(0, num(a.feesPaid)),
      tradeCount: Math.max(0, Math.floor(num(a.tradeCount))),
      liquidationCount: Math.max(0, Math.floor(num(a.liquidationCount))),
      topupCount: Math.max(0, Math.floor(num(a.topupCount))),
      /* ★기존 저장본에는 없는 키다. num() 이 undefined 를 0 으로 떨어뜨린다(NaN 금지).
         ★금액이라 정수화하지 «않는다» — 콘솔이 소수를 내려보낼 수 있다. 음수만 자른다. */
      bonusSeed: Math.max(0, num(a.bonusSeed)),
      /*
       * ★대출 복원 (2026-09-05). 정본 2종(principal · spreadBp)이 살아 있어야 한다.
       *   ⛔망가진 대출을 «버리면» 그건 유저의 «빚을 지워주는» 것이다 — 돈을 지우는 것보다 나쁘다
       *     (빌리고 저장본만 건드리면 되니까). 되살릴 수 있으면 되살리고, 못 읽는 값만 보수적으로 «크게» 잡는다.
       *   ★그래서 principal 은 «0 이하면 버리지만», 나머지 필드가 깨지면 안전한 쪽(=빚이 유지되는 쪽)으로 채운다.
       * ★2026-09-05 이전 저장본에는 이 키가 «아예 없다» → 빈 배열 = 대출 없음.
       */
      loans: (Array.isArray(a.loans) ? a.loans : []).flatMap((raw): Loan[] => {
        const p = raw as Partial<Loan> | null;
        if (!p || typeof p.id !== 'string') return [];
        const principal = num(p.principal, 0);
        const accruedInterest = Math.max(0, num(p.accruedInterest, 0));
        if (!(principal > 0) && !(accruedInterest > 0)) return [];
        return [
          {
            id: p.id,
            kind: p.kind === 'unsecured' ? 'unsecured' : 'secured',
            principal: Math.max(0, principal),
            accruedInterest,
            /* ★가산금리가 깨졌으면 «가장 비싼 등급»으로 본다 — 유리하게 추정하면 그게 곧 익스플로잇이다 */
            spreadBp: num(p.spreadBp, 0) > 0 ? num(p.spreadBp) : 2000,
            grade: typeof p.grade === 'string' ? p.grade : 'D',
            openedTick: Math.max(0, Math.floor(num(p.openedTick, 0))),
            /* ★만기가 «없는» 저장본(만기 도입 전)은 undefined 그대로 둔다 —
               0 으로 채우면 「이미 만기」가 되어 복원 즉시 자동상환·담보매도가 터진다. */
            ...(Number.isFinite(num(p.maturityTick, NaN))
              ? { maturityTick: Math.max(0, Math.floor(num(p.maturityTick, 0))) }
              : {}),
            lastAccrualDay: Math.max(0, Math.floor(num(p.lastAccrualDay, 0))),
            delinquentDays: Math.max(0, Math.floor(num(p.delinquentDays, 0))),
            marginCallDay: Math.floor(num(p.marginCallDay, -1)),
            interestPaid: Math.max(0, num(p.interestPaid, 0)),
          },
        ];
      }),
      delinquencyCount: Math.max(0, Math.floor(num(a.delinquencyCount))),
      /*
       * ★마이너스 계좌 상태. ⛔없으면 «현금 부호로 추정하지 마라» — null 이 기본이고,
       *   현금이 음수인데 상태가 없으면 다음 게임일 정산에서 `accrueOverdraft` 가
       *   ...는 못 만든다. 그래서 아래 `deserialize` 가 «음수 현금이면 상태를 만들어» 준다.
       *   여기서는 저장된 것만 «있는 그대로» 읽는다(추정 금지 원칙).
       */
      overdraft:
        a.overdraft && typeof a.overdraft === 'object'
          ? {
              spreadBp: Math.max(0, num((a.overdraft as { spreadBp?: number }).spreadBp, 0)),
              sinceDay: Math.max(0, Math.floor(num((a.overdraft as { sinceDay?: number }).sinceDay, 0))),
              lastAccrualDay: Math.max(0, Math.floor(num((a.overdraft as { lastAccrualDay?: number }).lastAccrualDay, 0))),
            }
          : null,
      bankruptcyCount: Math.max(0, Math.floor(num(a.bankruptcyCount))),
    };

    const t = (s.topup ?? {}) as Partial<SavedTopup>;
    const topup: SavedTopup = {
      dateKey: typeof t.dateKey === 'string' ? t.dateKey : '',
      usedToday: Math.max(0, Math.floor(num(t.usedToday))),
      lastTopupAt: num(t.lastTopupAt),
    };

    /*
     * daily: 기존 유저에게는 undefined 로 들어온다. 그때 NaN 이 되지 않게
     * 숫자는 num() 으로, 배열은 문자열만 남기고 거른다.
     * dateKey 가 비면 gameWorld.syncDailyDay() 가 «오늘»로 갈아끼운다.
     */
    const dd = (s.daily ?? {}) as Partial<SavedDaily>;
    const daily: SavedDaily = {
      dateKey: typeof dd.dateKey === 'string' ? dd.dateKey : '',
      topupBonus: Math.max(0, Math.floor(num(dd.topupBonus))),
      /* ★기존 저장본에는 없는 키다. num() 이 undefined 를 0 으로 떨어뜨린다(NaN 금지) */
      topupAdUsed: Math.max(0, Math.floor(num(dd.topupAdUsed))),
      viewBonus: Math.max(0, Math.floor(num(dd.viewBonus))),
      /* ★공유 리워드 — 기존 저장본에는 없다. 손상되면 0 이 «보수적으로 안전»하다:
         0 이면 오늘 몫이 다시 열릴 뿐이고, 큰 수로 들어오면 지급이 조용히 막힌다. */
      shareGrants: Math.max(0, Math.floor(num(dd.shareGrants))),
      shareUsd: Math.max(0, num(dd.shareUsd)),
      viewedTraders: (Array.isArray(dd.viewedTraders) ? dd.viewedTraders : []).filter(
        (x): x is string => typeof x === 'string'
      ),
    };

    const prices: Record<string, number> = {};
    if (s.prices && typeof s.prices === 'object') {
      for (const [k, v] of Object.entries(s.prices)) if (typeof v === 'number' && v > 0 && Number.isFinite(v)) prices[k] = v;
    }

    return {
      v: SAVE_VERSION,
      savedAt: num(s.savedAt),
      tick: Math.max(0, Math.floor(num(s.tick))),
      account,
      topup,
      daily,
      prices,
    };
  } catch {
    // 손상된 저장본 — 게임이 안 열리는 것보다 초기화가 낫다
    // ★ 네이티브 미러도 같이 지운다. 안 지우면 다음 부팅에서
    //   primeAppStorage() 가 «손상된 저장본»을 그대로 되살려 무한 반복된다.
    mirrorDrop(SAVE_KEY);
    try {
      ls.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function saveGame(g: SavedGame): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(SAVE_KEY, JSON.stringify(g));
    // 네이티브 Storage 미러링(토스 안에서만). fire-and-forget — 저장 때문에
    // 게임 루프가 멈추면 안 된다. 실패는 storage.ts 가 흡수한다.
    mirrorSave(SAVE_KEY, JSON.stringify(g));
    return true;
  } catch (e) {
    // QuotaExceededError / SecurityError — 게임 진행은 계속되어야 한다
    disabled = true;
    if (!warned) {
      warned = true;
      console.warn('[persist] 저장 불가 — 이후 저장을 중단한다', e);
    }
    return false;
  }
}

export function clearGame(): void {
  // ★ ls 가 null(프라이빗 모드 등)이어도 네이티브 미러는 지워야 한다.
  //   안 지우면 다음 부팅에서 primeAppStorage() 가 «지운 세이브»를 되살린다.
  mirrorDrop(SAVE_KEY);
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}
