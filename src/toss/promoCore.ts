/**
 * 프로모션 지급 «핵심» — SDK 무의존 (★2026-08-29 훅 3종 신설에 맞춰 분리)
 *
 * ── 왜 분리했나 ───────────────────────────────────────────────────────────
 *   옛 promotion.ts 는 storage(@apps-in-toss/web-framework)·bridge-core 를 직접 import
 *   해서 Node 에서 «불러 검사할 수 없었다». 08-26 에 토스포인트 알림이 «2회» 뜬 중복
 *   의심 건이 있는데, 3중 방어(로컬 grantedAt · in-flight 락 · 토스 4113)가 «실제로
 *   두 번째 호출을 막는지»를 코드로만 읽고 실행으로 검증한 적이 없었다.
 *   ⇒ 의존성(저장·브릿지·환경판별)을 «주입»받게 하고, 검사기(`scripts/check_promo_hooks.mjs`)
 *     가 가짜 의존성으로 «같은 코드»를 돌려 호출 횟수를 센다.
 *   ⇒ 실제 배선은 promotion.ts 가 한다(이 파일은 DOM·SDK 를 모른다).
 *
 * ── ★방어 4겹 (훅마다 «독립») ─────────────────────────────────────────────
 *   ① 로컬 기록 `grantedAt`   — 세션을 넘어 막는다. 저장 키는 훅마다 따로.
 *        ★기록은 «코드별»이다(08-29 해오름·미리 실결함): 기록의 `code` 가 «현재 코드와 같을 때만» 「이미 받음」.
 *        코드가 없는 옛 기록은 «다른 프로모션 것»으로 본다 — 콘솔에서 코드를 바꾸면 새 프로모션은 «다시» 나간다.
 *        (기록이 코드와 무관하면 옛 기록이 새 지급을 «영원히» 막는다.) 저장 키 이름은 «안 바꾼다».
 *   ② in-flight 락            — «동시» 호출을 하나로 합친다(저장 왕복 사이의 틈).
 *   ③ ★세션 락(신설)          — 한 훅은 «한 세션에 한 번만» 브릿지를 탄다. 결과가 무엇이든.
 *        08-26 의심 시나리오: 지급 성공 → 기록 저장 실패(또는 늦음) → 다음 호출이
 *        「아직 안 받았다」로 읽고 «또» 요청 → 토스가 4113 을 주더라도 그 사이 알림이
 *        한 번 더 뜰 수 있다. ①·② 는 이 틈을 못 막는다. ③ 이 막는다.
 *        ⇒ 「실패했으니 이번 세션에 다시 시도」는 «없다». 다음 실행에서 재시도된다.
 *   ④ 토스 4113(이미 지급)     — 서버 쪽 최종 방어. 받으면 로컬 기록을 «복원»하고 닫는다.
 *
 * ── ⛔ 한계는 그대로다 (President 결정 2026-08-26, promotion.ts 옛 주석) ──────
 *   서버가 없다. 재설치·저장 삭제 후 재수령은 «못 막는다». 최종 방어선은 콘솔 «예산»뿐.
 */
import type { GrantPromotionResult } from './bridge';

/** 훅 식별자. index.html 의 `data-promo-<id>-code/amount` 와 저장 키가 이 이름을 쓴다 */
export type PromoId = 'streak3' | 'hold10' | 'cash100k' | 'equity1m' | 'play1h';
export const PROMO_IDS: readonly PromoId[] = ['streak3', 'hold10', 'cash100k', 'equity1m', 'play1h'];
/*
 * ★2026-09-01 훅 2종 추가(equity1m 200원 · play1h 200원).
 *   이 파일의 «로직»은 한 줄도 안 바뀌었다 — 코어는 훅 id 를 모른다(락·기록·브릿지만 안다).
 *   ⇒ 코드별 기록(rec.code === code)·세션 락·in-flight 락·4113 방어가 새 훅에도 «그대로» 적용된다.
 */

export type BridgeMethod = 'grantPromotionReward' | 'grantPromotionRewardForGame';

export type PromoOutcome =
  | 'granted' // 실제로 지급됐다
  | 'already' // 이미 받았다(로컬 기록 또는 토스 4113)
  | 'locked' // ★이 세션에서 이미 한 번 처리했다 — 저장도 브릿지도 «안 탄다»
  | 'skipped' // 조건 미달 — 아무것도 안 했다
  | 'ineligible' // ★기준선 «시점»에 이미 달성 상태였다(프로모션 개설 전 달성) — 영구 미지급
  | 'unconfigured' // 프로모션 코드가 안 꽂혔다
  | 'unsupported' // 토스 밖이거나 앱 버전 미달
  | 'failed'; // 지급 시도했으나 실패(다음 «실행»에서 재시도 가능)

export interface PromoRecord {
  /** 지급이 «확정»된 시각(ms). 있으면 다시 요청하지 않는다 */
  grantedAt?: number;
  /** 토스가 준 리워드 키. 사고 시 추적용 */
  key?: string;
  /** ★이 기록이 «어느 프로모션 코드»의 지급인가. 현재 코드와 다르면(또는 없으면) 「이미 받음」이 아니다 */
  code?: string;
  /** 4113(이미 지급)으로 닫힌 경우 표시 */
  viaAlreadyGranted?: boolean;
  /** ★기준선. «이 코드»의 프로모션을 이 기기에서 처음 본 순간의 상태(아래 PromoBaseline) */
  base?: PromoBaseline;
}

/**
 * ★기준선 — 「프로모션 개설 «전»에 이미 달성한 사람에게는 지급하지 않는다」(President 2026-09-01)
 *
 *   이 코드가 들어간 빌드가 그 기기에서 «처음 판정하는 순간» 한 번 박고, 그 뒤로 바뀌지 않는다.
 *   ★기준선도 «코드별»이다 — 지급 기록과 «같은 레코드»에 넣어 rec.code 로 함께 스코프된다.
 *     콘솔에서 코드를 바꾸면(= 새 프로모션) 기준선도 «새로» 잡힌다.
 *
 *   유형별로 쓰는 칸이 다르다:
 *     상태 보유형(equity1m)   `had`  기준선 시점에 이미 달성이었나. true 면 «어떤 경우에도» 지급 없음
 *                                    (문턱 아래로 내려갔다 다시 올라오는 우회도 막힌다 — 값이 아니라 «기록»이 막는다)
 *     누적 카운터형(play1h)   `from` 기준선 시점의 누적값. 이후분(current − from)만 센다. 과거분 이월 «없음»
 */
export interface PromoBaseline {
  /** 기준선을 박은 시각(ms) */
  at: number;
  /** 상태 보유형 — 기준선 시점에 «이미» 달성이었나 */
  had?: boolean;
  /** 누적 카운터형 — 기준선 시점의 누적값 */
  from?: number;
}

export interface PromoConfig {
  code: string;
  amount: number;
}

export interface PromoDeps {
  /** 토스 미니앱 WebView 안인가 */
  inToss(): boolean;
  /** 훅별 코드·금액. 비어 있으면 { code:'', amount:0 } */
  readConfig(id: PromoId): PromoConfig;
  loadRecord(id: PromoId): Promise<PromoRecord>;
  /** 실패해도 throw 하지 말 것(호출부가 감싼다) */
  saveRecord(id: PromoId, rec: PromoRecord): Promise<void>;
  /**
   * 브릿지 호출. 미응답·타임아웃·예외는 «undefined» 로 돌려줘야 한다(safeBridge 규약).
   * ⛔여기서 throw 하면 안 된다 — 그래도 아래가 잡아서 'failed' 로 닫는다.
   */
  callBridge(method: BridgeMethod, params: { promotionCode: string; amount: number }): Promise<GrantPromotionResult>;
  now(): number;
  log?: (level: 'log' | 'warn' | 'error', msg: string) => void;
}

export interface PromoClaimer {
  /** 조건을 «이미 만족했을 때» 부른다. 절대 throw 하지 않는다 */
  claim(id: PromoId): Promise<PromoOutcome>;
  /** 조건 판정 결과를 같이 넘기는 편의 경로. reached=false 면 아무것도 «안 한다» */
  maybeClaim(id: PromoId, reached: boolean): Promise<PromoOutcome>;
  /** 이 세션에서 이미 처리됐는가(세션 락). 호출부가 «값싸게» 건너뛰는 데 쓴다 */
  settled(id: PromoId): boolean;
  /** 로컬 기록 기준 «이미 받았는가». UI 표시용(읽기 전용) */
  alreadyRewarded(id: PromoId): Promise<boolean>;
  /** 브릿지를 «실제로» 부른 횟수(훅별). 검사·디버그용 */
  bridgeCalls(id: PromoId): number;

  /* ── ★기준선 경로 (2026-09-01) ─────────────────────────────────────────── */
  /**
   * ★«상태 보유형». 「기준선에서 미달성 → 그 이후 달성으로 전이」일 때만 지급한다.
   *   · 기준선이 없으면 «지금» 박는다(had = reachedNow). 그 순간 이미 달성이면 'ineligible' — 영구 미지급.
   *   · reachedNow 는 «판정이 가능할 때만» 넘겨라. 값이 없어서 false 를 넘기면 기준선이 «미달성»으로 박힌다.
   *   절대 throw 하지 않는다.
   */
  claimOnTransition(id: PromoId, reachedNow: boolean): Promise<PromoOutcome>;
  /**
   * ★«누적 카운터형». 기준선 이후분(current − from)으로 판정한다. 과거 누적값은 «이월하지 않는다».
   *   · 기준선이 없으면 «지금» 박는다(from = current).
   *   · reached 는 promoRules 의 순수 판정 함수를 «그대로» 받는다(문턱을 여기서 다시 쓰지 않는다).
   */
  claimOnDelta(id: PromoId, current: number, reached: (v: number) => boolean): Promise<PromoOutcome>;
  /** 기준선이 «이 세션 메모리»에 잡혔는가(현재 코드 기준). 매 틱 경로가 저장을 안 읽게 하는 값싼 문 */
  baselined(id: PromoId): boolean;
  /** 기준선 시점에 이미 달성이라 «영구 미지급»인가(메모리 기준). 매 틱 경로의 값싼 문 */
  ineligible(id: PromoId): boolean;
  /** 기준선 스냅샷(읽기 전용). 검사·디버그용 */
  baselineOf(id: PromoId): PromoBaseline | undefined;
}

function isSuccess(r: GrantPromotionResult): r is { key: string } {
  return !!r && r !== 'ERROR' && typeof (r as { key?: unknown }).key === 'string';
}
function isFailure(r: GrantPromotionResult): r is { errorCode: string; message: string } {
  return !!r && r !== 'ERROR' && typeof (r as { errorCode?: unknown }).errorCode === 'string';
}

export function createPromoClaimer(deps: PromoDeps): PromoClaimer {
  const log = deps.log ?? ((level, msg) => console[level](msg));
  /** ② in-flight 락 — 훅별 */
  const inFlight = new Map<PromoId, Promise<PromoOutcome>>();
  /** ③ 세션 락 — 훅별. 한 번 들어가면 이 claimer 가 사는 동안 절대 빠지지 않는다 */
  const sessionDone = new Set<PromoId>();
  const calls = new Map<PromoId, number>();
  /**
   * ★기준선 메모리 캐시 — 훅별. 코드가 바뀌면 무효(코드를 같이 들고 있는다).
   *   매 틱 경로(총자산)가 저장을 «매번» 읽지 않게 하는 값싼 문이다.
   *   ⛔진실의 원본은 저장이다. 이 캐시는 저장을 읽은 «뒤에만» 채워진다.
   */
  const bases = new Map<PromoId, PromoBaseline & { code: string }>();
  /** 기준선 «기록 중» 락 — 훅별. 동시 진입이 기준선을 두 번 박는 것을 막는다 */
  const baseBusy = new Map<PromoId, Promise<PromoBaseline>>();

  async function loadRec(id: PromoId): Promise<PromoRecord> {
    try {
      return (await deps.loadRecord(id)) ?? {};
    } catch {
      return {};
    }
  }

  /** 기준선을 저장에 박는다. ★같은 코드의 기존 칸은 «보존», 다른 코드면 «새 판»(코드 교체 = 새 프로모션) */
  async function putBase(id: PromoId, rec: PromoRecord, code: string, base: PromoBaseline): Promise<void> {
    const next: PromoRecord = rec.code === code ? { ...rec, code, base } : { code, base };
    try {
      await deps.saveRecord(id, next);
    } catch (e) {
      log('error', `[promo:${id}] 기준선 저장 실패 — 다음 실행에서 다시 박는다: ${String(e)}`);
    }
    bases.set(id, { ...base, code });
  }

  /**
   * 기준선을 «읽거나 박는다». 반환: 지금 판정에 쓸 기준선.
   * ⛔지급 기록이 «같은 코드»로 이미 있으면 부르지 않는다(호출부가 먼저 'already' 로 닫는다).
   */
  function ensureBase(id: PromoId, code: string, make: () => PromoBaseline): Promise<PromoBaseline> {
    const memo = bases.get(id);
    if (memo && memo.code === code) return Promise.resolve(memo);
    /*
     * ★in-flight 락 — 같은 틱에 두 경로(boot · afterOrder · 매 틱)가 동시에 들어오면
     *   저장 왕복 사이의 «틈»에서 기준선이 두 번 박힌다. 나중 것이 이기면 그 사이에 들어온
     *   출석 보상·체결이 기준선에 섞인다. ⇒ 먼저 들어온 하나만 박고 나머지는 그 결과를 «같이» 쓴다.
     */
    const busy = baseBusy.get(id);
    if (busy) return busy;
    const p = (async () => {
      const rec = await loadRec(id);
      const has = rec.code === code && rec.base && typeof rec.base.at === 'number';
      if (has) {
        const b = rec.base as PromoBaseline;
        bases.set(id, { ...b, code });
        return b;
      }
      const b = make();
      await putBase(id, rec, code, b);
      log('log', `[promo:${id}] ★기준선 기록 ${JSON.stringify(b)} code=${code}`);
      return b;
    })().finally(() => baseBusy.delete(id));
    baseBusy.set(id, p);
    return p;
  }

  async function run(id: PromoId): Promise<PromoOutcome> {
    const { code, amount } = deps.readConfig(id);
    // ① 로컬 기록 — 브릿지를 아예 안 탄다. ★«같은 코드»의 기록일 때만 「이미 받음」이다.
    //   code 가 다르거나 없는 기록(옛 프로모션)은 막지 않는다 — 콘솔 코드 교체 뒤 새 지급이 나가야 한다.
    let rec: PromoRecord = {};
    try {
      rec = (await deps.loadRecord(id)) ?? {};
    } catch {
      rec = {};
    }
    if (rec.grantedAt && !!code && rec.code === code) return 'already';

    if (!code || !(amount > 0)) {
      log('warn', `[promo:${id}] 코드/금액 미설정 — 지급 요청 생략. index.html 의 data-promo-${id}-* 확인`);
      return 'unconfigured';
    }
    if (!deps.inToss()) return 'unsupported';

    log('log', `[promo:${id}] 조건 달성 — 지급 요청 code=${code} amount=${amount}`);
    const params = { promotionCode: code, amount };

    // 현행 API 먼저. 네이티브가 모르면 undefined/'ERROR' → 레거시(ForGame)로 폴백.
    let res: GrantPromotionResult;
    try {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      res = await deps.callBridge('grantPromotionReward', params);
      if (res === undefined || res === 'ERROR') {
        log('warn', `[promo:${id}] grantPromotionReward 미응답/오류 — 레거시(ForGame)로 폴백`);
        calls.set(id, (calls.get(id) ?? 0) + 1);
        res = await deps.callBridge('grantPromotionRewardForGame', params);
      }
    } catch (e) {
      log('error', `[promo:${id}] 브릿지 예외: ${String(e)}`);
      return 'failed';
    }

    if (isSuccess(res)) {
      // ★성공 «직후» 기록. 성공 «전»에 기록하면 실패 시 영영 못 받는다.
      try {
        /* ★기준선을 «보존»한다 — 같은 코드의 기록이면 기존 칸을 그대로 이어 쓴다 */
        await deps.saveRecord(id, { ...(rec.code === code ? rec : {}), grantedAt: deps.now(), key: res.key, code });
      } catch (e) {
        log('error', `[promo:${id}] 지급 기록 저장 실패 — 세션 락이 이번 세션을 막고, 다음 실행은 4113 이 막는다: ${String(e)}`);
      }
      log('log', `[promo:${id}] 지급 성공 key=${res.key}`);
      return 'granted';
    }

    if (isFailure(res)) {
      log('error', `[promo:${id}] 지급 실패 code=${res.errorCode} msg=${res.message}`);
      if (res.errorCode === '4113') {
        try {
          await deps.saveRecord(id, { ...(rec.code === code ? rec : {}), grantedAt: deps.now(), viaAlreadyGranted: true, code });
        } catch {
          /* 다음 실행에서 또 4113 으로 닫힌다 */
        }
        return 'already';
      }
      if (res.errorCode === '4112') log('warn', `[promo:${id}] 프로모션 예산 소진 — 더 지급하지 않는다`);
      // 4100/4104/4105/4108/4109 등: 기록하지 «않는다» → 다음 실행에서 재시도.
      return 'failed';
    }

    if (res === undefined) {
      log('warn', `[promo:${id}] 토스 앱 버전이 낮아 프로모션 미지원 — 건너뛴다`);
      return 'unsupported';
    }
    log('error', `[promo:${id}] 알 수 없는 오류(ERROR) — 지급되지 않았다`);
    return 'failed';
  }

  function claim(id: PromoId): Promise<PromoOutcome> {
    if (sessionDone.has(id)) return Promise.resolve('locked'); // ③
    const busy = inFlight.get(id);
    if (busy) return busy; // ②
    const p = run(id)
      .catch((e) => {
        log('error', `[promo:${id}] 예상 밖 예외 — 게임은 계속: ${String(e)}`);
        return 'failed' as PromoOutcome;
      })
      .then((out) => {
        // ★결과가 무엇이든 이 세션은 닫는다. «다시 시도»는 다음 실행의 몫이다.
        sessionDone.add(id);
        inFlight.delete(id);
        return out;
      });
    inFlight.set(id, p);
    return p;
  }

  return {
    claim,
    maybeClaim(id, reached) {
      if (!reached) return Promise.resolve('skipped');
      return claim(id);
    },
    settled: (id) => sessionDone.has(id),
    async alreadyRewarded(id) {
      try {
        const rec = await deps.loadRecord(id);
        const { code } = deps.readConfig(id);
        return !!rec?.grantedAt && !!code && rec.code === code;
      } catch {
        return false;
      }
    },
    bridgeCalls: (id) => calls.get(id) ?? 0,

    /* ── ★기준선 경로 (2026-09-01) ─────────────────────────────────────── */
    async claimOnTransition(id, reachedNow) {
      try {
        if (sessionDone.has(id)) return 'locked';
        const { code } = deps.readConfig(id);
        if (!code) return 'unconfigured';
        const memo = bases.get(id);
        /* 값싼 문: 이미 «영구 미지급»으로 판정된 훅은 저장을 읽지도 않는다 */
        if (memo && memo.code === code && memo.had) return 'ineligible';
        const rec = await loadRec(id);
        if (rec.grantedAt && rec.code === code) return 'already';
        const base = await ensureBase(id, code, () => ({ at: deps.now(), had: reachedNow }));
        /* ★기준선 시점에 이미 달성 = 프로모션 개설 전 달성 ⇒ 어떤 경우에도 지급하지 않는다.
           문턱 아래로 내려갔다 다시 올라오는 «우회»도 여기서 막힌다 — 막는 것은 현재값이 아니라 «기록»이다. */
        if (base.had) return 'ineligible';
        if (!reachedNow) return 'skipped';
        return claim(id);
      } catch (e) {
        log('error', `[promo:${id}] 기준선(전이) 판정 실패 — 게임은 계속: ${String(e)}`);
        return 'failed';
      }
    },

    async claimOnDelta(id, current, reached) {
      try {
        if (sessionDone.has(id)) return 'locked';
        if (typeof current !== 'number' || !Number.isFinite(current)) return 'skipped';
        const { code } = deps.readConfig(id);
        if (!code) return 'unconfigured';
        const rec = await loadRec(id);
        if (rec.grantedAt && rec.code === code) return 'already';
        const base = await ensureBase(id, code, () => ({ at: deps.now(), from: current }));
        /* ★기준선 «이후»분만 센다. 과거 누적값은 이월하지 않는다(0 부터 새로).
           저장이 손상돼 현재값이 기준선보다 작아지면 0 — 더 주는 쪽으로 틀리지 않는다. */
        const since = Math.max(0, current - (typeof base.from === 'number' ? base.from : 0));
        if (!reached(since)) return 'skipped';
        return claim(id);
      } catch (e) {
        log('error', `[promo:${id}] 기준선(누적) 판정 실패 — 게임은 계속: ${String(e)}`);
        return 'failed';
      }
    },

    baselined(id) {
      const { code } = deps.readConfig(id);
      const memo = bases.get(id);
      return !!memo && !!code && memo.code === code;
    },
    ineligible(id) {
      const { code } = deps.readConfig(id);
      const memo = bases.get(id);
      return !!memo && !!code && memo.code === code && !!memo.had;
    },
    baselineOf(id) {
      const memo = bases.get(id);
      return memo ? { at: memo.at, had: memo.had, from: memo.from } : undefined;
    },
  };
}
