/**
 * 거시 이벤트 3종 — 시장 전체 또는 섹터에 «시황»을 만든다 (2026-08-20 President 지시).
 *
 * ★왜 필요한가: 임팩트 감쇠를 켜면서 종목 간 차별화가 크게 줄었다(cv 100% -> 71% 실측).
 *   모든 종목이 비슷하게 움직이면 «고르는 재미»가 없다. 거시 이벤트가 섹터별로
 *   다르게 때려서 그 차별화를 되돌린다. 특히 «실적 시즌»은 종목마다 부호가 갈린다.
 *
 * ★구현 원칙 3가지
 *   1) ⛔r(무위험이자율)은 «여전히 0»이다. 「금리 인하」는 서사일 뿐 optionPremium 에
 *      먹이지 «않는다». 먹이면 라이브 유저의 옵션 평가액이 전부 바뀐다(President 하드게이트).
 *   2) 효과는 «드리프트 보정»으로 준다(priceEngine.driftBonus). orderFlow 로 밀면
 *      임팩트 감쇠에 걸려 되돌아오는데, 시황 변화는 되돌아오면 안 된다.
 *   3) 결정론적이다 — seed 와 이벤트 순번만으로 정해진다. 같은 seed 면 같은 시황.
 *
 * ★문구는 «i18n 키»만 돌려준다. locales 는 UI 레인 소유다.
 */
import { TICKERS } from '../../data/tickers.generated';
import {
  POLICY_RATE_INITIAL,
  POLICY_RATE_MAX,
  POLICY_RATE_MEETING_GAME_DAYS,
  POLICY_RATE_MIN,
  POLICY_RATE_STEP,
  TICKS_PER_GAME_DAY,
} from '../constants';
import { Rng } from './rng';
import type { PriceEngine } from './priceEngine';

export type MacroType = 'rate_cut' | 'earnings_season' | 'recession_fear';

export interface MacroEvent {
  id: string;
  type: MacroType;
  /** i18n 키 (제목) */
  titleKey: string;
  /** i18n 키 (본문) */
  bodyKey: string;
  /** 연율 드리프트 보정의 «기준» 크기. 종목별로 배수가 다르게 적용된다 */
  magnitude: number;
  /** 영향받는 섹터 표시용 (빈 배열 = 시장 전체) */
  sectors: string[];
  startTick: number;
  durationTicks: number;
}

/** 경기 민감 섹터 — 침체 우려에 더 크게 맞는다 */
const CYCLICAL = ['반도체', '자동차', '은행', '유통', '금융지주', '항공', '건설', '화학', '철강', '에너지'];
/** 방어 섹터 — 덜 맞는다 */
const DEFENSIVE = ['제약', '바이오', '통신', '필수소비재', '식품', '헬스케어'];

const SECTOR_OF = new Map(TICKERS.map((t) => [t.ticker, t.sectorKo]));
const TIER_OF = new Map(TICKERS.map((t) => [t.ticker, t.tierKo]));

/** 이벤트 사이 간격: 게임 2~5일 */
const GAP_MIN = 2 * TICKS_PER_GAME_DAY;
const GAP_MAX = 5 * TICKS_PER_GAME_DAY;
/** 지속: 게임 1~3일 */
const DUR_MIN = 1 * TICKS_PER_GAME_DAY;
const DUR_MAX = 3 * TICKS_PER_GAME_DAY;

/** ★정책금리 «회합»의 결정 (2026-09-05) */
export type RateDecision = 'hike' | 'hold' | 'cut';

export interface RateEvent {
  id: string;
  decision: RateDecision;
  /** 변경 폭(연율, 부호 있음). 동결이면 0 */
  deltaRate: number;
  from: number;
  to: number;
  tick: number;
  titleKey: string;
  bodyKey: string;
}

/** 회합 간격(틱) */
const MEETING_TICKS = POLICY_RATE_MEETING_GAME_DAYS * TICKS_PER_GAME_DAY;

export class MacroEngine {
  private rng: Rng;
  private seq = 0;
  private nextAt: number;
  active: MacroEvent | null = null;
  /** 이번 이벤트에서 종목별로 적용 중인 보정(연율) — 표시·검증용 */
  private applied = new Map<string, number>();

  /* ── 정책금리 (2026-09-05 President 「기준금리는 중앙은행이 거시 이벤트로서 결정」) ──
   *
   * ★★난수 스트림을 «따로» 둔다. ⛔기존 `this.rng` 를 쓰면 소비 순서가 밀려
   *   ★시장 경로가 통째로 달라진다(같은 이유로 concepts 봇도 스트림을 분리했다 — bots.ts:84).
   *   ⇒ 분리하면 대출 기능을 붙여도 «가격 히스토리가 비트 동일»하다. 실제로 그것을
   *     `scripts/bench/run.mjs deriv --mode hash` 로 증명한다.
   * ★기존 `rate_cut` «시황» 이벤트와는 «다른 것»이다: 저쪽은 성장주 드리프트를 밀고,
   *   이쪽은 «빌린 돈의 값»을 정한다. 둘을 합치지 마라 — 합치면 시황 이벤트를
   *   건드릴 때마다 대출 금리가 따라 흔들린다.
   */
  private rateRng: Rng;
  private rateSeq = 0;
  private nextMeetingAt: number;
  policyRate = POLICY_RATE_INITIAL;

  constructor(seed: number) {
    this.rng = new Rng((seed ^ 0x1b873593) >>> 0);
    this.nextAt = Math.floor(this.rng.range(GAP_MIN, GAP_MAX));
    this.rateRng = new Rng((seed ^ 0x27d4eb2f) >>> 0);
    /* 첫 회합은 «한 주기 뒤»다 — 부팅 직후에 금리가 바뀌면 워밍업 구간이 흔들린다 */
    this.nextMeetingAt = MEETING_TICKS;
  }

  /**
   * ★정책금리 회합. 주기가 되면 인상/동결/인하를 결정하고 그 «공시»를 돌려준다.
   *   ⛔`update()` 와 «별도»로 부른다 — 난수 스트림이 다르고, 이벤트의 성격도 다르다.
   *
   * ★확률(인상 25 / 동결 50 / 인하 25)의 근거: 실제 정책금리는 대부분의 회합에서
   *   «동결»된다. 동결이 다수여야 「변동금리」가 잡음이 아니라 «사건»으로 느껴진다.
   * ★밴드 끝에서는 방향을 반대로 «접는다» — 0% 에서 인하, 8% 에서 인상은 없다.
   * ★빅스텝(50bp) 10% — 실제 관행에도 있고, 없으면 금리가 늘 25bp 씩만 기어간다.
   */
  updatePolicyRate(tick: number): RateEvent | null {
    if (tick < this.nextMeetingAt) return null;
    this.nextMeetingAt = tick + MEETING_TICKS;
    const from = this.policyRate;
    const r = this.rateRng.range(0, 1);
    let decision: RateDecision = r < 0.25 ? 'hike' : r < 0.75 ? 'hold' : 'cut';
    // 밴드 끝에서는 접는다
    if (decision === 'cut' && from <= POLICY_RATE_MIN + 1e-12) decision = 'hold';
    if (decision === 'hike' && from >= POLICY_RATE_MAX - 1e-12) decision = 'hold';
    const steps = this.rateRng.range(0, 1) < 0.1 ? 2 : 1;
    const raw =
      decision === 'hold' ? 0 : (decision === 'hike' ? 1 : -1) * steps * POLICY_RATE_STEP;
    const to = Math.min(POLICY_RATE_MAX, Math.max(POLICY_RATE_MIN, from + raw));
    /* ★밴드에 잘렸으면 실제 변경폭은 raw 가 아니라 to−from 이다. 표시와 실제가 갈리면 안 된다 */
    const deltaRate = +(to - from).toFixed(10);
    this.policyRate = to;
    return {
      id: `rate_${this.rateSeq++}`,
      decision: deltaRate === 0 ? 'hold' : decision,
      deltaRate,
      from,
      to,
      tick,
      titleKey: `macro.policy.${deltaRate === 0 ? 'hold' : decision}.title`,
      bodyKey: `macro.policy.${deltaRate === 0 ? 'hold' : decision}.body`,
    };
  }

  /** 저장·복원용 스냅샷 (정책금리만 — 시황 이벤트는 세션 한정이다) */
  snapshotRate(): { rate: number; nextAt: number; seq: number } {
    return { rate: this.policyRate, nextAt: this.nextMeetingAt, seq: this.rateSeq };
  }

  restoreRate(s: { rate?: number; nextAt?: number; seq?: number } | null | undefined): void {
    if (!s) return;
    if (typeof s.rate === 'number' && Number.isFinite(s.rate))
      this.policyRate = Math.min(POLICY_RATE_MAX, Math.max(POLICY_RATE_MIN, s.rate));
    if (typeof s.nextAt === 'number' && Number.isFinite(s.nextAt)) this.nextMeetingAt = s.nextAt;
    if (typeof s.seq === 'number' && Number.isFinite(s.seq)) this.rateSeq = s.seq;
  }

  /** 매 틱 호출. 새 이벤트가 «시작»되면 그 이벤트를 돌려준다(피드용) */
  update(tick: number, engine: PriceEngine): MacroEvent | null {
    if (this.active) {
      if (tick >= this.active.startTick + this.active.durationTicks) {
        for (const t of this.applied.keys()) engine.driftBonus.delete(t);
        this.applied.clear();
        this.active = null;
        this.nextAt = tick + Math.floor(this.rng.range(GAP_MIN, GAP_MAX));
      }
      return null;
    }
    if (tick < this.nextAt) return null;
    const ev = this.spawn(tick);
    this.active = ev;
    this.apply(ev, engine);
    return ev;
  }

  private spawn(tick: number): MacroEvent {
    const types: MacroType[] = ['rate_cut', 'earnings_season', 'recession_fear'];
    const type = types[this.rng.int(types.length)];
    const id = `mac_${this.seq++}_${type}`;
    const durationTicks = Math.floor(this.rng.range(DUR_MIN, DUR_MAX));
    // 기준 크기(연율). mu 가 0.09~0.14 대이므로 2~6 이면 게임 1~3일에 체감된다
    const magnitude = this.rng.range(2, 6) * (type === 'recession_fear' ? -1 : 1);
    const sectors =
      type === 'recession_fear' ? CYCLICAL.slice(0, 4) : type === 'earnings_season' ? [] : [];
    return {
      id,
      type,
      titleKey: `macro.${type}.title`,
      bodyKey: `macro.${type}.body`,
      magnitude: +magnitude.toFixed(2),
      sectors,
      startTick: tick,
      durationTicks,
    };
  }

  /** 종목별 배수를 정해 driftBonus 에 꽂는다 */
  private apply(ev: MacroEvent, engine: PriceEngine): void {
    for (const ticker of engine.order) {
      const sector = SECTOR_OF.get(ticker) ?? '';
      const tier = TIER_OF.get(ticker) ?? '';
      let k = 1;
      if (ev.type === 'rate_cut') {
        // 성장주·빅테크가 금리에 민감하다(듀레이션이 길다) — 더 크게 오른다
        k = tier === '빅테크' || tier === '성장주' ? 1.5 : tier === '우량배당' ? 0.5 : 1;
      } else if (ev.type === 'recession_fear') {
        k = CYCLICAL.includes(sector) ? 1.5 : DEFENSIVE.includes(sector) ? 0.4 : 1;
      } else {
        // ★실적 시즌 — 종목마다 «부호»가 갈린다. 차별화 회복의 핵심이다
        k = this.rng.range(-1.4, 1.4);
      }
      const bonus = ev.magnitude * k;
      if (Math.abs(bonus) < 1e-9) continue;
      engine.driftBonus.set(ticker, bonus);
      this.applied.set(ticker, bonus);
    }
  }
}
