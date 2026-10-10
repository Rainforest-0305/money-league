# -*- coding: utf-8 -*-
"""
★기준선(baseline) 게이트 패치 — 「프로모션 개설 «전»에 이미 달성한 사람에게는 지급하지 않는다」
  (2026-09-01 President 지시. 스모 바운스에만 있던 규칙을 신설 훅 2종에 적용)

  적용 대상 = ★09-01 신설 2종만
    equity1m (총자산 100만 USD) = «상태 보유형»  → 기준선에서 이미 달성이면 «영구 미지급»
    play1h   (실플레이 1시간)   = «누적 카운터형» → 기준선 이후분만 0부터 새로 센다
  ⛔기존 라이브 3종(streak3/hold10/cash100k)은 «무접촉». 실제 지급이 나가는 프로모션이라 회귀 = 실사고.

  python scripts/promo2_baseline_patch_20260901.py apply
  python scripts/promo2_baseline_patch_20260901.py revert
"""
import hashlib
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAK = os.path.join(ROOT, '_baseline')
SUF = '.pre_baseline_20260901'

CORE = 'src/toss/promoCore.ts'
PROM = 'src/toss/promotion.ts'
IDX = 'src/toss/index.ts'
STORE = 'src/store/store.ts'
FILES = [CORE, PROM, IDX, STORE]

# ══════════════════════════════════════════════════════════════════════════
# ① promoCore.ts
# ══════════════════════════════════════════════════════════════════════════
CORE_OUTCOME_OLD = """  | 'skipped' // 조건 미달 — 아무것도 안 했다"""
CORE_OUTCOME_NEW = """  | 'skipped' // 조건 미달 — 아무것도 안 했다
  | 'ineligible' // ★기준선 «시점»에 이미 달성 상태였다(프로모션 개설 전 달성) — 영구 미지급"""

CORE_REC_OLD = """  /** 4113(이미 지급)으로 닫힌 경우 표시 */
  viaAlreadyGranted?: boolean;
}"""
CORE_REC_NEW = """  /** 4113(이미 지급)으로 닫힌 경우 표시 */
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
}"""

CORE_IFACE_OLD = """  /** 브릿지를 «실제로» 부른 횟수(훅별). 검사·디버그용 */
  bridgeCalls(id: PromoId): number;
}"""
CORE_IFACE_NEW = """  /** 브릿지를 «실제로» 부른 횟수(훅별). 검사·디버그용 */
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
}"""

CORE_IMPL_OLD = """  const calls = new Map<PromoId, number>();

  async function run(id: PromoId): Promise<PromoOutcome> {"""
CORE_IMPL_NEW = """  const calls = new Map<PromoId, number>();
  /**
   * ★기준선 메모리 캐시 — 훅별. 코드가 바뀌면 무효(코드를 같이 들고 있는다).
   *   매 틱 경로(총자산)가 저장을 «매번» 읽지 않게 하는 값싼 문이다.
   *   ⛔진실의 원본은 저장이다. 이 캐시는 저장을 읽은 «뒤에만» 채워진다.
   */
  const bases = new Map<PromoId, PromoBaseline & { code: string }>();

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
  async function ensureBase(id: PromoId, code: string, make: () => PromoBaseline): Promise<PromoBaseline> {
    const memo = bases.get(id);
    if (memo && memo.code === code) return memo;
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
  }

  async function run(id: PromoId): Promise<PromoOutcome> {"""

CORE_SAVE1_OLD = """      try {
        await deps.saveRecord(id, { grantedAt: deps.now(), key: res.key, code });
      } catch (e) {"""
CORE_SAVE1_NEW = """      try {
        /* ★기준선을 «보존»한다 — 같은 코드의 기록이면 기존 칸을 그대로 이어 쓴다 */
        await deps.saveRecord(id, { ...(rec.code === code ? rec : {}), grantedAt: deps.now(), key: res.key, code });
      } catch (e) {"""

CORE_SAVE2_OLD = """        try {
          await deps.saveRecord(id, { grantedAt: deps.now(), viaAlreadyGranted: true, code });
        } catch {"""
CORE_SAVE2_NEW = """        try {
          await deps.saveRecord(id, { ...(rec.code === code ? rec : {}), grantedAt: deps.now(), viaAlreadyGranted: true, code });
        } catch {"""

CORE_RET_OLD = """    bridgeCalls: (id) => calls.get(id) ?? 0,
  };
}"""
CORE_RET_NEW = """    bridgeCalls: (id) => calls.get(id) ?? 0,

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
}"""

# ══════════════════════════════════════════════════════════════════════════
# ② promotion.ts
# ══════════════════════════════════════════════════════════════════════════
PROM_EXPORT_OLD = """/** 이미 받았는지 조회(읽기 전용, 로컬 기록 기준). UI 표시용 */
export function alreadyRewarded(id: PromoId): Promise<boolean> {
  return claimer.alreadyRewarded(id);
}"""
PROM_EXPORT_NEW = """/** 이미 받았는지 조회(읽기 전용, 로컬 기록 기준). UI 표시용 */
export function alreadyRewarded(id: PromoId): Promise<boolean> {
  return claimer.alreadyRewarded(id);
}

/* ── ★기준선 경로 (2026-09-01 President 「개설 전 이미 달성한 사람에겐 지급 없음」) ──────
 *   ⛔기존 라이브 3종(streak3/hold10/cash100k)은 이 경로를 «쓰지 않는다» — 무접촉.
 *     신설 2종만: equity1m = 상태 보유형(전이) · play1h = 누적 카운터형(기준선 이후분).
 */

/** ★상태 보유형 — 기준선 미달성 → 이후 달성 «전이»일 때만 지급(equity1m) */
export function claimPromoOnTransition(id: PromoId, reachedNow: boolean): Promise<PromoOutcome> {
  return claimer.claimOnTransition(id, reachedNow);
}

/** ★누적 카운터형 — 기준선 이후분만 센다(play1h) */
export function claimPromoOnDelta(id: PromoId, current: number, reached: (v: number) => boolean): Promise<PromoOutcome> {
  return claimer.claimOnDelta(id, current, reached);
}

/** 기준선이 이 세션 메모리에 잡혔는가 — 매 틱 경로가 값싸게 건너뛰는 데 쓴다 */
export function promoBaselined(id: PromoId): boolean {
  return claimer.baselined(id);
}

/** 기준선 시점에 이미 달성이라 «영구 미지급»인가 — 매 틱 경로의 값싼 문 */
export function promoIneligible(id: PromoId): boolean {
  return claimer.ineligible(id);
}

/** 기준선 스냅샷(읽기 전용). 검증·디버그용 */
export function promoBaseline(id: PromoId) {
  return claimer.baselineOf(id);
}"""

PROM_FOLD_OLD = """      /* ★지급은 세션 락·로컬 기록이 막으므로 1시간을 넘긴 뒤 매 비트 불려도 «한 번»만 나간다 */
      void claimer.maybeClaim('play1h', playReached(next.totalMs));"""
PROM_FOLD_NEW = """      /*
       * ★지급은 세션 락·로컬 기록이 막으므로 1시간을 넘긴 뒤 매 비트 불려도 «한 번»만 나간다.
       * ★[2026-09-01] «누적 카운터형» — 기준선 이후분만 센다. 첫 비트에서 기준선(from = 그때의 누적)을
       *   박고, 그 뒤로는 (현재 − from) 이 문턱을 넘어야 지급이다. 과거 누적값은 «이월하지 않는다».
       */
      void claimer.claimOnDelta('play1h', next.totalMs, playReached);"""

# ══════════════════════════════════════════════════════════════════════════
# ③ toss/index.ts 재수출
# ══════════════════════════════════════════════════════════════════════════
IDX_OLD = """  playtimeMs,
  playtimeActive,
} from './promotion';"""
IDX_NEW = """  playtimeMs,
  playtimeActive,
  claimPromoOnTransition,
  claimPromoOnDelta,
  promoBaselined,
  promoIneligible,
  promoBaseline,
} from './promotion';"""

# ══════════════════════════════════════════════════════════════════════════
# ④ store.ts — 총자산 훅을 «전이» 판정으로 교체
# ══════════════════════════════════════════════════════════════════════════
STORE_IMP_OLD = """  playtimeResume,
  playtimeBeat,
  playtimePause,
} from '../toss/promotion';"""
STORE_IMP_NEW = """  playtimeResume,
  playtimeBeat,
  playtimePause,
  claimPromoOnTransition,
  promoBaselined,
  promoIneligible,
} from '../toss/promotion';"""

STORE_FN_OLD = """  private checkEquityPromo(): void {
    if (promoSettled('equity1m')) return;
    if (!equityReached(this.portfolio?.equity)) return;
    void maybeClaimPromo('equity1m', true);
  }"""
STORE_FN_NEW = """  private checkEquityPromo(): void {
    if (promoSettled('equity1m')) return;
    /* ★[2026-09-01] 기준선에서 이미 100만 달러였던 기기 — «영구 미지급». 저장도 안 읽고 끝낸다 */
    if (promoIneligible('equity1m')) return;
    /*
     * ★판정 «불가»면 아무것도 하지 않는다. false 를 넘기면 기준선이 「미달성」으로 박혀
     *   이미 부자였던 기기에 지급이 나갈 수 있다(이 훅의 가장 위험한 오류다).
     */
    const eq = this.portfolio?.equity;
    if (typeof eq !== 'number' || !Number.isFinite(eq)) return;
    const reached = equityReached(eq);
    /* ★기준선이 아직 없으면 «미달성일 때도» 한 번은 태운다 — 기준선을 박기 위해서다.
       박힌 뒤에는 미달성 틱에서 «할당 0»으로 끊는다(매 틱 경로라 값싸야 한다). */
    if (!reached && promoBaselined('equity1m')) return;
    void claimPromoOnTransition('equity1m', reached);
  }"""

PROM_LOAD_OLD = """    const st = sanePlay(raw ? JSON.parse(raw) : null);
    playSaved = st.totalMs;
    playCur = st;
    return st;
"""
PROM_LOAD_NEW = """    const st = sanePlay(raw ? JSON.parse(raw) : null);
    playSaved = st.totalMs;
    playCur = st;
    /*
     * ★[2026-09-01] 기준선을 «누적을 시작하기 전»에 박는다(President 「개설 전 이미 달성한 사람 제외」).
     *   · 새 기기      → from = 0      ⇒ 1시간을 «온전히» 채워야 지급
     *   · 이미 논 기기 → from = 복원값  ⇒ 과거 누적은 «이월되지 않는다»(0부터 새로)
     *   ★여기서 박아야 «결정적»이다 — 첫 비트에서 박으면 그 비트분이 기준선에 먹힌다.
     *   ★이 await 는 playChain 의 «머리»라 모든 비트보다 먼저 끝난다. 절대 throw 하지 않는다.
     */
    await claimer.claimOnDelta('play1h', st.totalMs, playReached);
    return st;
"""

PATCH = [
    (CORE, CORE_OUTCOME_OLD, CORE_OUTCOME_NEW),
    (CORE, CORE_REC_OLD, CORE_REC_NEW),
    (CORE, CORE_IFACE_OLD, CORE_IFACE_NEW),
    (CORE, CORE_IMPL_OLD, CORE_IMPL_NEW),
    (CORE, CORE_SAVE1_OLD, CORE_SAVE1_NEW),
    (CORE, CORE_SAVE2_OLD, CORE_SAVE2_NEW),
    (CORE, CORE_RET_OLD, CORE_RET_NEW),
    (PROM, PROM_EXPORT_OLD, PROM_EXPORT_NEW),
    (PROM, PROM_FOLD_OLD, PROM_FOLD_NEW),
    (PROM, PROM_LOAD_OLD, PROM_LOAD_NEW),
    (IDX, IDX_OLD, IDX_NEW),
    (STORE, STORE_IMP_OLD, STORE_IMP_NEW),
    (STORE, STORE_FN_OLD, STORE_FN_NEW),
]


def md5b(b):
    return hashlib.md5(b).hexdigest()


def rd(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def eol_of(t):
    crlf = t.count('\r\n')
    return '\r\n' if crlf >= (t.count('\n') - crlf) else '\n'


def fit(block, eol):
    n = block.replace('\r\n', '\n')
    return n.replace('\n', '\r\n') if eol == '\r\n' else n


def apply():
    for rel, old, new in PATCH:
        p = os.path.join(ROOT, rel)
        t = io.open(p, encoding='utf-8', newline='').read()
        eol = eol_of(t)
        o = fit(old, eol)
        n = t.count(o)
        if n != 1:
            raise SystemExit('replace: expected exactly 1 match in %s, got %d for: %r' % (rel, n, old[:70]))
        io.open(p, 'w', encoding='utf-8', newline='').write(t.replace(o, fit(new, eol)))
        print('  patched %-24s' % rel)
    print('[baseline] applied %d edits' % len(PATCH))
    for rel in FILES:
        print('  %s  md5=%s' % (rel, md5b(rd(rel))))


def revert():
    for rel in FILES:
        src = os.path.join(BAK, os.path.basename(rel) + SUF)
        with open(src, 'rb') as f:
            b = f.read()
        with open(os.path.join(ROOT, rel), 'wb') as g:
            g.write(b)
        print('  restored %-24s md5=%s' % (rel, md5b(b)))


if __name__ == '__main__':
    c = sys.argv[1] if len(sys.argv) > 1 else ''
    if c == 'apply':
        apply()
    elif c == 'revert':
        revert()
    else:
        print(__doc__)
        sys.exit(2)
