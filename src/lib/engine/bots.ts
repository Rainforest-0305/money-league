/**
 * 봇 210개 자동매매 — 서버 `build/server/src/bots/bots.ts` 이식본(로직 1:1).
 *
 * ★ 구 mockWorld.ts 와의 차이가 이 파일의 존재 이유다.
 *   구현: botFlow() 가 종목별 "집계 주문흐름" 한 덩어리를 tanh 로 합성하고,
 *         봇 자산은 botEquity[i] *= (1 + 시장수익률*beta + noise) 로 굴렸다.
 *         bots.generated.ts 의 strategy 필드는 **한 번도 읽지 않았다**(grep 0건).
 *   여기: 봇 210개가 각자 계정·현금·보유종목을 갖고, 아키타입 5종 × 42 의 실제
 *         전략 로직으로 World.placeSpotOrder / openLeverage / buyOption 을 호출한다.
 *         즉 플레이어와 **동일한 orderFlow 파이프라인**을 탄다(ARCHITECTURE.md 6장).
 *         파생 헤비 봇의 청산이 곧 ARCHITECTURE 2-A 청산곡선의 재현이다.
 *
 * 상수(actProb/seedCash/sizeMin/sizeMax)는 서버 bots.ts:23-34 그대로다.
 * whale seedCash 2,000,000 은 설정값이며 가격 임팩트의 원천이다 — 바꾸지 마라.
 */
import { TICKS_PER_GAME_DAY, TRADING_DAYS_PER_YEAR } from '../constants';
import { optionPremium } from '../options';
import { Rng } from './rng';
import { GameError, World } from './world';
import { CONCEPTS, Universes, actConcept, isNewConcept, type ConceptCtx, type NewConcept } from './concepts';
import type { BotDef, LegacyBotStrategy } from './types';

export interface BotProfile {
  /** 틱당 행동 확률 */
  actProb: number;
  /** 시드 자본 */
  seedCash: number;
  /** 1회 주문 규모 (평가자산 대비 비율 범위) */
  sizeMin: number;
  sizeMax: number;
}

export const BOT_PROFILES: Record<LegacyBotStrategy, BotProfile> = {
  // 추세 추종 — 중빈도 중규모
  momentum: { actProb: 0.1, seedCash: 80_000, sizeMin: 0.03, sizeMax: 0.09 },
  // 역추세 — 중빈도 중규모
  mean_reversion: { actProb: 0.1, seedCash: 80_000, sizeMin: 0.03, sizeMax: 0.09 },
  // 화이트웨일 — 저빈도 초대형 (가격 임팩트 원천)
  whale: { actProb: 0.012, seedCash: 2_000_000, sizeMin: 0.06, sizeMax: 0.18 },
  // 노이즈 — 고빈도 소액 (유동성 공급)
  noise: { actProb: 0.3, seedCash: 20_000, sizeMin: 0.01, sizeMax: 0.05 },
  // 파생 헤비 — 레버리지/옵션 (청산 이벤트 발생원)
  derivatives_heavy: { actProb: 0.07, seedCash: 150_000, sizeMin: 0.05, sizeMax: 0.15 },
};

/** 봇이 파산하면 시장 유동성이 마르므로 자동 재자본화 (플레이어 충전 쿼터와 무관) */
const BOT_RECAP_RATIO = 0.05;

/**
 * 신규 봇 «로스터 회전» 창 크기.
 *
 * ★ 왜 필요한가 [실측]: 명부가 2,520명이 되면 매 틱 전원을 순회하는 현행 방식은
 *   틱 2.43ms / 랭킹 8.29ms / 워밍업 5.1초 / 백그라운드 복귀 catchup 728ms 가 된다
 *   (Node 24 데스크톱. 폰은 몇 배 느리다). 프레임보다 «워밍업 프리즈»와 «복귀 프리즈»가
 *   먼저 터진다. 창을 걸면 틱 0.20ms / 워밍업 0.46초 / catchup 59ms 다.
 *
 * ★ 기존 210명은 «창에 넣지 않는다» — 매 틱 전원이 그대로 돈다.
 *   그들이 시장 조성자(유동성·가격 임팩트·청산 이벤트)이기 때문이다. 창에 넣으면
 *   행동 빈도가 명부 크기에 반비례해 줄어 시장 자체가 바뀐다(밸런스 회귀).
 *   신규 봇은 «조용한 참가자»다 — 랭킹을 채우고, 열람했을 때 개성 있는 포트폴리오를
 *   보여주는 게 역할이다.
 */
export const ROTATION_WINDOW = 210;

/** 거시 이벤트 신호를 나눠 담을 상위 종목 수 (몰림 방지). 측정으로 정한 값 */
export const SIGNAL_TOP_N = 8;

/** 콘셉트(신규 8종) 프로필을 BotProfile 모양으로 변환 */
function conceptProfile(id: NewConcept): BotProfile {
  const c = CONCEPTS[id];
  return { actProb: c.actProb, seedCash: c.seedCash, sizeMin: c.sizeMin, sizeMax: c.sizeMax };
}

/** 기존 5종 + 신규 8종 공통 프로필 조회 */
export function profileOf(strategy: string): BotProfile {
  if (isNewConcept(strategy)) return conceptProfile(strategy);
  return BOT_PROFILES[strategy as LegacyBotStrategy] ?? BOT_PROFILES.noise;
}

export class BotEngine {
  readonly bots: BotDef[];
  readonly rng: Rng;
  /**
   * 신규 콘셉트 봇 전용 난수. ★기존 5종과 «스트림을 분리»한 이유:
   * 같은 Rng 를 쓰면 신규 봇이 난수를 뽑는 만큼 기존 210명의 난수 소비 순서가 밀려
   * 「봇을 추가했을 뿐인데 기존 시장이 통째로 달라지는」 회귀가 난다.
   * 분리하면 명부가 몇 명이든 기존 210명의 «행동 시퀀스»가 그대로다(결정론성 보존).
   */
  readonly conceptRng: Rng;
  private tickers: string[] = [];
  private legacy: BotDef[] = [];
  private newcomers: BotDef[] = [];
  private uni: Universes | null = null;
  /** day_trader 전용 진입 틱 기록 (botId -> ticker -> tick). 저장 대상이 아니다 */
  private entryTicks = new Map<string, Map<string, number>>();
  private cursor = 0;
  /** 거시 이벤트 신호 캐시 — 이벤트가 바뀔 때만 다시 정렬한다 */
  private sigEventId = '';
  private sigRanked: [string, number][] = [];
  recapCount = 0;

  constructor(bots: BotDef[], seed = 12345) {
    this.bots = bots;
    this.rng = new Rng(seed);
    this.conceptRng = new Rng((seed ^ 0x51ed270b) >>> 0);
  }

  /** World 에 봇 계정 등록 + botStep 훅 주입 */
  attach(world: World): void {
    this.tickers = world.instruments.map((i) => i.ticker);
    this.uni = new Universes(world.instruments);
    for (const b of this.bots) {
      const p = profileOf(b.strategy);
      world.createAccount(b.botId, b.nickname, true, p.seedCash, b.strategy);
      if (isNewConcept(b.strategy)) {
        this.newcomers.push(b);
        this.seedPortfolio(world, b, b.strategy);
      } else {
        this.legacy.push(b);
      }
    }
    world.botStep = (w) => this.step(w);
  }

  /**
   * 신규 봇을 «이미 포트폴리오를 들고 있는» 상태로 만든다.
   *
   * ★ 왜 매수 주문으로 채우지 않는가 [실측]: 신규 봇의 시드 현금은 전부 «새 돈»이라
   *   주문으로 들어오면 영구적인 순매수 압력이 된다. 봇을 2,520명으로 늘린 측정에서
   *   5게임일 만에 종목 중앙값이 1.042배 -> 1.448배로 부풀었다
   *   («아무거나 사면 오르는 게임»이 된다).
   *   여기서는 orderFlow 를 «타지 않고» 원장에 직접 기록한다. 엔진에 발행주식수·
   *   유통물량 개념이 없으므로(world.ts 어디에도 총주식수가 없다) 부작용이 없다.
   * ★ 덤으로 콘셉트가 «첫 화면부터» 보인다 — 우량주 봇은 처음부터 1등주 5종목을 들고 있다.
   */
  private seedPortfolio(world: World, b: BotDef, concept: NewConcept): void {
    const def = CONCEPTS[concept];
    if (def.initialInvested <= 0 || def.maxHoldings <= 0) return;
    const acc = world.getAccount(b.botId);
    if (!this.uni) return;
    const universe = this.uni.of(def.universe);
    const n = Math.max(1, Math.min(def.maxHoldings, universe.length));
    const per = (acc.cash * def.initialInvested) / n;
    if (!(per >= 1)) return;
    const picked = new Set<string>();
    for (let i = 0; i < n * 3 && picked.size < n; i++) {
      picked.add(universe[this.conceptRng.int(universe.length)]);
    }
    for (const ticker of picked) {
      const px = world.engine.priceOf(ticker);
      if (!(px > 0)) continue;
      acc.holdings.set(ticker, { qty: per / px, avgCost: px });
      acc.cash -= per;
    }
  }

  step(w: World): void {
    // 1) 기존 210명 — 매 틱 전원. 시장 조성자라 샘플링하지 않는다
    for (const b of this.legacy) {
      // legacy 배열에는 원년 5종만 들어간다(attach 에서 isNewConcept 로 갈랐다)
      const p = BOT_PROFILES[b.strategy as LegacyBotStrategy];
      if (!this.rng.bool(p.actProb)) continue;
      try {
        this.act(w, b, p);
      } catch (e) {
        // 잔고부족 등 정상적 거절은 무시 (플레이어와 동일한 검증 경로를 탄 결과)
        if (!(e instanceof GameError)) throw e;
      }
      this.recapIfBroke(w, b, p);
    }
    // 2) 신규 참가자 — 창(ROTATION_WINDOW)만큼만 훑는다. 명부가 커져도 비용이 상수다
    this.stepNewcomers(w);
  }

  private stepNewcomers(w: World): void {
    const n = this.newcomers.length;
    if (n === 0 || !this.uni) return;
    const win = Math.min(ROTATION_WINDOW, n);
    for (let i = 0; i < win; i++) {
      const b = this.newcomers[(this.cursor + i) % n];
      const concept = b.strategy as unknown as NewConcept;
      const def = CONCEPTS[concept];
      if (!def) continue;
      if (!this.conceptRng.bool(def.actProb)) continue;
      const p = conceptProfile(concept);
      try {
        this.actNewcomer(w, b, concept);
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
      this.recapIfBroke(w, b, p);
    }
    this.cursor = (this.cursor + win) % n;
  }

  /** 신규 콘셉트 봇 1회 행동 — 규칙 본문은 concepts.ts 에 있다 */
  private actNewcomer(w: World, b: BotDef, concept: NewConcept): void {
    const uni = this.uni;
    if (!uni) return;
    const def = CONCEPTS[concept];
    const p = conceptProfile(concept);
    // 현금이 마르면 리밸런싱 매도. hodler 는 cashFloor 0 이라 «절대» 팔지 않는다
    if (def.cashFloor > 0 && this.cashRatio(w, b.botId) < def.cashFloor && this.conceptRng.bool(0.6)) {
      if (this.rebalanceSell(w, b.botId)) return;
    }
    let entry = this.entryTicks.get(b.botId);
    if (!entry) {
      entry = new Map();
      this.entryTicks.set(b.botId, entry);
    }
    const ctx: ConceptCtx = {
      world: w,
      botId: b.botId,
      def,
      rng: this.conceptRng,
      uni,
      entryTick: entry,
      budget: (ticker) => this.buyBudget(w, b.botId, ticker, p),
      sell: (ticker, frac) => this.sellPartial(w, b.botId, ticker, frac),
      cashRatio: () => this.cashRatio(w, b.botId),
    };
    actConcept(ctx);
  }

  private recapIfBroke(w: World, b: BotDef, p: BotProfile): void {
    const acc = w.getAccount(b.botId);
    if (w.equity(acc) < p.seedCash * BOT_RECAP_RATIO) {
      acc.cash += p.seedCash;
      acc.topupCount++;
      this.recapCount++;
    }
  }

  /**
   * 매수 예산. 총 평가자산(equity) 기준으로 잡고 현금·유동성 상한으로 자른다.
   * 현금 기준으로 잡으면 봇이 매수편향으로 현금을 소진하면서 주문흐름이
   * 시간에 따라 말라버린다(비정상성). equity 기준이면 정상상태가 유지된다.
   */
  private buyBudget(w: World, botId: string, ticker: string, p: BotProfile): number {
    const acc = w.getAccount(botId);
    const eq = w.equity(acc);
    return Math.min(
      eq * this.rng.range(p.sizeMin, p.sizeMax),
      acc.cash * 0.98,
      w.maxOrderNotional(ticker) * 0.98
    );
  }

  /** 현금비중 = cash / equity. 정상상태 유지용 리밸런싱 신호 */
  private cashRatio(w: World, botId: string): number {
    const acc = w.getAccount(botId);
    const eq = w.equity(acc);
    return eq > 0 ? acc.cash / eq : 1;
  }

  /** 현금이 마르면 강제로 일부를 되판다 -> 주문흐름 정상성(stationarity) 유지 */
  private rebalanceSell(w: World, botId: string): boolean {
    const acc = w.getAccount(botId);
    if (acc.holdings.size === 0) return false;
    const keys = [...acc.holdings.keys()];
    const t = keys[this.rng.int(keys.length)];
    return this.sellPartial(w, botId, t, this.rng.range(0.3, 0.8));
  }

  /**
   * 보유분 부분 매도. 유동성 상한을 넘으면 넘지 않는 수량으로 잘라서 낸다.
   * @returns 매도했으면 true
   */
  private sellPartial(w: World, botId: string, ticker: string, frac: number): boolean {
    const acc = w.getAccount(botId);
    const h = acc.holdings.get(ticker);
    if (!h) return false;
    const px = w.engine.priceOf(ticker);
    const maxQty = (w.maxOrderNotional(ticker) * 0.98) / px;
    const qty = Math.min(h.qty * frac, maxQty);
    if (qty * px < 0.5) return false;
    w.placeSpotOrder(botId, ticker, 'sell', qty);
    return true;
  }

  /** 현금비중이 높으면 매수, 낮으면 매도 쪽으로 기울인다 */
  private buyProb(w: World, botId: string): number {
    return Math.max(0.1, Math.min(0.9, 0.15 + this.cashRatio(w, botId) * 0.7));
  }

  private randTicker(): string {
    return this.tickers[this.rng.int(this.tickers.length)];
  }

  private act(w: World, b: BotDef, p: BotProfile): void {
    // 현금비중이 20% 아래로 떨어지면 우선 리밸런싱 매도 (봇 유동성 고갈 방지)
    if (this.cashRatio(w, b.botId) < 0.2 && this.rng.bool(0.6)) {
      if (this.rebalanceSell(w, b.botId)) return;
    }
    switch (b.strategy) {
      case 'momentum':
        return this.actMomentum(w, b, p);
      case 'mean_reversion':
        return this.actMeanReversion(w, b, p);
      case 'whale':
        return this.actWhale(w, b, p);
      case 'noise':
        return this.actNoise(w, b, p);
      case 'derivatives_heavy':
        return this.actDerivatives(w, b, p);
    }
  }

  /** 1) 모멘텀 추종형 — 최근 30틱 추세를 따라 순매수/순매도 */
  private actMomentum(w: World, b: BotDef, p: BotProfile): void {
    for (let k = 0; k < 2; k++) {
      const t = this.randTicker();
      const r = w.engine.returnOver(t, 30);
      const size = this.buyBudget(w, b.botId, t, p);
      if (r > 0.0015 && size > 1) {
        w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
      } else if (r < -0.0015) {
        this.sellPartial(w, b.botId, t, this.rng.range(0.4, 1.0));
      }
    }
  }

  /** 2) 역추세/평균회귀형 — 150틱(=1게임일) 이평 대비 괴리 매매 */
  private actMeanReversion(w: World, b: BotDef, p: BotProfile): void {
    for (let k = 0; k < 2; k++) {
      const t = this.randTicker();
      const ma = w.engine.sma(t, 150);
      const px = w.engine.priceOf(t);
      if (!Number.isFinite(ma) || ma <= 0) continue;
      const z = px / ma - 1;
      const size = this.buyBudget(w, b.botId, t, p);
      if (z < -0.004 && size > 1) {
        w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
      } else if (z > 0.004) {
        this.sellPartial(w, b.botId, t, this.rng.range(0.4, 1.0));
      }
    }
  }

  /** 3) 화이트웨일형 — 저빈도 대량주문. 가격 임팩트의 주 원천 */
  private actWhale(w: World, b: BotDef, p: BotProfile): void {
    const t = this.randTicker();
    const drift = w.engine.returnOver(t, 120);
    // 추세에 약하게 기운 방향 (완전 랜덤 아님)
    const buyBias = Math.max(
      0.1,
      Math.min(
        0.9,
        0.5 + Math.max(-0.2, Math.min(0.2, drift * 8)) + (this.cashRatio(w, b.botId) - 0.5) * 0.6
      )
    );
    const buy = this.rng.bool(buyBias);
    const size = this.buyBudget(w, b.botId, t, p);
    if (buy) {
      if (size > 1) w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
    } else if (!this.sellPartial(w, b.botId, t, this.rng.range(0.5, 1.0))) {
      if (size > 1) w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
    }
  }

  /** 4) 노이즈/랜덤 소액 트레이더 — 유동성 공급 */
  private actNoise(w: World, b: BotDef, p: BotProfile): void {
    const t = this.randTicker();
    const size = this.buyBudget(w, b.botId, t, p);
    if (this.rng.bool(this.buyProb(w, b.botId))) {
      if (size > 0.5) w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
    } else if (!this.sellPartial(w, b.botId, t, this.rng.range(0.3, 1.0))) {
      if (size > 0.5) w.placeSpotOrderByNotional(b.botId, t, 'buy', size);
    }
  }

  /**
   * ★거시 이벤트 신호 — 지금 «드리프트»가 가장 세게 밀리는 종목과 그 방향.
   *
   * ★왜 이게 결정적인가 [실측 2026-08-20]: 임팩트 감쇠는 «주문흐름»만 되돌리고
   *   «드리프트»는 되돌리지 않는다. 그래서 거시 이벤트가 만든 방향은 «남는다».
   *   같은 조건에서 30게임일 수익률: 이벤트+20배 «+24.3%» / 이벤트+현물 +8.3% /
   *   랜덤+현물 +1.9% / ★랜덤+20배 «-70.2%».
   *   ⇒ 레버리지가 나쁜 게 아니라 «신호 없이 레버리지를 쓰는 것»이 나빴다.
   * ★신호가 없으면 null 을 돌려준다 — 그때는 종전 로직 그대로다(무이벤트 구간 회귀 없음).
   */
  private macroSignal(w: World, botId: string): { ticker: string; dir: number } | null {
    const act = w.macro.active;
    if (!act || w.engine.driftBonus.size === 0) return null;

    /*
     * ★«인지 시차» — 봇마다 이벤트를 알아채는 시점이 다르다.
     *   botId 해시로 0~89틱을 준다. 같은 틱에 42명이 동시에 들어가면 서로의 슬리피지를
     *   밟아 «각자는 옳은데 집단으로는 손해»가 난다(1차 수정에서 실측된 실패 원인).
     */
    let h = 0;
    for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) >>> 0;
    if (w.tick - act.startTick < h % 90) return null;

    /*
     * ★신호 종목 «분산» — 상위 SIGNAL_TOP_N 개 중 하나를 고른다.
     *   1개로 몰면 그 종목에서 서로를 밟는다. 너무 넓히면 신호를 못 먹는다.
     *   정렬은 이벤트가 바뀔 때 «한 번»만 한다(매 틱 × 봇 수로 정렬하면 비싸다).
     */
    if (this.sigEventId !== act.id) {
      this.sigEventId = act.id;
      this.sigRanked = [...w.engine.driftBonus.entries()]
        .filter(([, b]) => Math.abs(b) > 1e-9)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, SIGNAL_TOP_N);
    }
    if (this.sigRanked.length === 0) return null;
    const [tk, bonus] = this.sigRanked[this.rng.int(this.sigRanked.length)];
    return { ticker: tk, dir: bonus > 0 ? 1 : -1 };
  }

  /** 5) 파생 헤비유저 — 레버리지/옵션 위주. 청산 이벤트 발생원 */
  private actDerivatives(w: World, b: BotDef, p: BotProfile): void {
    const acc = w.getAccount(b.botId);

    // 보유 레버리지 포지션 일부는 익절/손절로 자발 청산
    if (acc.levPositions.size > 0 && this.rng.bool(0.25)) {
      const pos = [...acc.levPositions.values()][this.rng.int(acc.levPositions.size)];
      const eq = w.levPositionEquity(pos);
      const roi = eq / pos.margin - 1;
      const heldDays = (w.tick - pos.openedTick) / TICKS_PER_GAME_DAY;
      /*
       * ★익절·손절을 «변동성에서 유도»한다(상수를 박지 않는다).
       *   held 틱 동안 기대되는 «증거금 대비» 움직임 = (변동성 + 이벤트 드리프트) x 레버리지.
       *   이벤트 중에는 driftBonus 가 붙어 목표가 «자동으로» 커진다 —
       *   고정 +25%(20배에서 가격 +1.25%)로는 3%대 이벤트를 다 먹기 전에 조기 익절됐다(실측).
       */
      const inst = w.instrumentOf(pos.ticker);
      const heldTicks = Math.max(1, w.tick - pos.openedTick);
      const yrs = heldTicks / (TRADING_DAYS_PER_YEAR * TICKS_PER_GAME_DAY);
      const bonus = Math.abs(w.engine.driftBonus.get(pos.ticker) ?? 0);
      const expMove = (inst.sigma * Math.sqrt(yrs) + bonus * yrs) * pos.leverage;
      const tp = Math.max(0.25, 1.2 * expMove);
      const sl = -Math.max(0.35, 1.5 * expMove);
      if (roi > tp || roi < sl || heldDays > 4) {
        w.closeLeverage(b.botId, pos.id);
        return;
      }
    }

    if (acc.levPositions.size >= 4) return;

    // ★거시 이벤트가 «드리프트»를 흔들면 그 방향은 감쇠가 지우지 못한다.
    //   신호가 있으면 그 종목·그 방향으로 간다. 없으면 종전대로 무작위 종목.
    const sig = this.macroSignal(w, b.botId);
    const t = sig ? sig.ticker : this.randTicker();
    if (this.rng.bool(0.72)) {
      // 레버리지 진입 — World 가 허용한 티어(ALLOWED_LEVERAGE = 2/5/10/20)에서만 고른다
      const tiers = w.allowedLeverage;
      const lev = tiers[this.rng.int(tiers.length)];
      /*
       * ★베팅 크기는 «키우지 않는다» — 3배로 열어봤더니 전 구간이 악화됐다(실측):
       *   파생 p10/p50/p90/max −54.6/−38.8/−23.1/−11.7 -> −71.2/−52.1/−33.5/−20.9.
       *   42명이 동시에 크게 걸면 집단 임팩트와 슬리피지가 같이 커져 «서로를 더 밟는다».
       *   되돌렸다. 이 주석은 같은 시도를 반복하지 않기 위한 기록이다.
       */
      const margin = Math.min(
        w.equity(acc) * this.rng.range(p.sizeMin, p.sizeMax),
        acc.cash * 0.9,
        w.maxOrderNotional(t) / lev
      );
      if (margin < 10) return;
      const drift = w.engine.returnOver(t, 60);
      // ★이벤트 신호가 있으면 그 방향에 크게 기운다(0.85). 없으면 종전 추세 편향.
      const longBias = sig ? (sig.dir > 0 ? 0.85 : 0.15) : 0.55 + Math.max(-0.25, Math.min(0.25, drift * 10));
      w.openLeverage(b.botId, t, this.rng.bool(longBias) ? 'long' : 'short', lev, margin);
    } else {
      // 옵션 매수
      const S = w.engine.priceOf(t);
      const kind = (sig ? this.rng.bool(sig.dir > 0 ? 0.85 : 0.15) : this.rng.bool(0.55)) ? 'call' : 'put';
      const moneyness = this.rng.range(0.95, 1.05);
      const strike = Math.round(S * moneyness * 100) / 100;
      const expiry = 3 + this.rng.int(5); // 3~7 게임일
      const budget = Math.min(acc.cash * this.rng.range(0.01, 0.04), w.maxOrderNotional(t) * 0.5);
      /* ★[2026-09-05] 봇의 «예산 추정»도 화면·엔진과 «같은 sigma»(실현변동성 EWMA)를 쓴다.
         ⛔`inst.sigma` 로 두면 봇만 약 2배 비싼 값으로 계약 수를 세어 예산을 남긴다 —
         「식이 두 벌」이 되는 순간이고, 이 프로젝트가 반복해서 당한 사고의 형태다(U-4). */
      const prem = optionPremium(kind, S, strike, w.engine.sigmaOf(t), expiry);
      /* ★계약당 지출 = 프리미엄 × «그 종목의» 계약 크기. ⛔10 을 박지 마라 —
         BTC·NDX 같은 고가 자산에서 봇이 예산을 10~200배 잘못 세게 된다. */
      const contracts = Math.floor(budget / Math.max(prem * w.sharesPerContractOf(t), 0.01));
      if (contracts >= 1) w.buyOption(b.botId, t, kind, strike, expiry, contracts);
    }
  }
}
