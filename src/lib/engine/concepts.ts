/**
 * 봇 «콘셉트» 정의 — 신규 8종 (2026-08-20, President 지시 「직관적인 전략 위주」).
 *
 * ★ 이 파일의 존재 이유 = «기존 5종을 건드리지 않기 위해서»다.
 *   기존 momentum/mean_reversion/whale/noise/derivatives_heavy 의 매매 로직·시드·
 *   actProb 는 시장 조성(유동성·가격 임팩트·청산 이벤트)의 캘리브레이션 결과다
 *   (constants.ts 의 LIQUIDITY_DEPTH 재캘리브레이션 근거 주석 참조).
 *   신규 콘셉트를 그 파일에 섞어 넣으면 밸런스 회귀를 «분리해서 검증할 수 없다».
 *   그래서 신규 8종은 여기 따로 두고, bots.ts 는 dispatch 만 한다.
 *
 * ★ 설계 제약 (President 원문): 「막 되게 복잡한 전략 말고 직관적인 전략들 위주로」
 *   ⇒ 각 콘셉트의 매매 규칙은 if-then 몇 줄을 넘지 않는다. 퀀트 팩터·최적화 금지.
 *   ⇒ 유저가 열람권으로 포트폴리오를 열었을 때 «한눈에» 스타일이 보여야 한다.
 *      그래서 콘셉트마다 «보유 종목 수»와 «종목 유니버스»가 다르다 —
 *      기존 5종은 randTicker() 균등추출이라 1인당 평균 53종목을 들고 있어
 *      전원이 「100종목을 조금씩」으로 똑같이 보인다(실측). 그 문제를 여기서 푼다.
 *
 * ★ 한 줄 설명은 «i18n 키»만 돌려준다. 문자열을 여기 박으면 en 로케일이 죽는다.
 *   실제 문구는 UI 레인이 src/locales/{ko,en}/*.json 에 넣는다.
 */
import type { Rng } from './rng';
import type { Instrument } from './types';
import type { World } from './world';

/** 기존 5종 — 값·철자 모두 engine/types.ts 의 BotStrategy 와 동일해야 한다 */
export const LEGACY_CONCEPTS = [
  'momentum',
  'mean_reversion',
  'whale',
  'noise',
  'derivatives_heavy',
] as const;

/** 신규 8종 */
export const NEW_CONCEPTS = [
  'blue_chip',
  'dip_buyer',
  'all_in',
  'diversifier',
  'day_trader',
  'hodler',
  'short_seller',
  'low_vol',
  'liquidation_hunter',
] as const;

export type LegacyConcept = (typeof LEGACY_CONCEPTS)[number];
export type NewConcept = (typeof NEW_CONCEPTS)[number];
export type ConceptId = LegacyConcept | NewConcept;

/** 종목 유니버스 — 콘셉트마다 «고르는 판»이 다르다. 이게 포트폴리오의 개성을 만든다. */
export type UniverseKind = 'all' | 'top20' | 'top50' | 'lowVol30' | 'highVol30';

export interface ConceptDef {
  id: NewConcept;
  /** 틱당 행동 확률 — 회전율 */
  actProb: number;
  /**
   * 시드 자본 10,000~30,000.
   * ★플레이어 시드(SEED_CASH=10,000)와 같은 대역이다. 기존 봇 최저 시드는 20,000
   *   (noise) 이라 플레이어는 구조적으로 211/211 최하위였다(lib/rank.ts 주석).
   *   신규 봇을 이 대역에 두면 매일 들어오는 새 참가자가 «플레이어 아래»에도 깔린다.
   */
  seedCash: number;
  sizeMin: number;
  sizeMax: number;
  universe: UniverseKind;
  /** 목표 보유 종목 수 — 화면에서 콘셉트를 구분하는 1차 신호 */
  maxHoldings: number;
  /** 생성 시 시드 자본 중 «현물로 채워 넣을» 비율 (주문흐름 미경유) */
  initialInvested: number;
  /** 현금비중이 이 아래로 내려가면 리밸런싱 매도 — hodler 는 0(=절대 안 판다) */
  cashFloor: number;
  /**
   * i18n 키. 실제 문구는 locales 에 있다.
   * ★ 키에 「bot」 이라는 낱말을 쓰지 않는다 — President 지시(2026-08-20)로 유저에게
   *   보이는 곳에서 「봇」 표기를 전부 없앴다. 화면 대체어는 「트레이더」·「참가자」다.
   *   (식별자·API·파일명은 그대로 둔다. 저장 데이터의 botId 가 흔들리면 안 된다.)
   */
  i18nKey: string;
}

/**
 * ★★[설계 예약 — 아직 «구현하지 않았다»] 대기주문(지정가·스톱·브래킷)
 *
 * 현재 엔진의 주문은 «시장가 즉시체결» 한 종류뿐이다(world.placeSpotOrder).
 * 대기주문 큐가 생기면 콘셉트마다 «다른 종류»를 쓴다 — 균일하게 주면 개성이 죽는다.
 * ★그리고 미체결 대기주문이 프로필에 보이면 그 자체가 «전략의 얼굴»이 된다:
 *   「이 트레이더는 지금 NVDA 를 $180 에 사려고 걸어놨구나」 — 열람권의 값어치다.
 *
 *   blue_chip     시장가. 느긋한 성격이라 굳이 걸어두지 않는다
 *   dip_buyer     ★지정가 매수(현재가 -3%). 이 전략의 «정체» 그 자체다
 *   all_in        스톱로스 1건(-8%). 갈아탈 때만 쓴다
 *   diversifier   지정가 매수(목표비중 미달 종목). 급하지 않다
 *   day_trader    ★브래킷(손절 -1.5% / 익절 +2%) — 진입과 동시에 두 개를 건다
 *   hodler        ⛔없음. 아무것도 안 거는 게 캐릭터다
 *   short_seller  스톱 진입(급등 후 꺾일 때) + 익절 +15%
 *   low_vol       지정가 매수만. 아주 낮은 가격에 오래 걸어둔다
 *
 * ★★대기주문 «하드 제약» 2건 — Partner 채택(2026-08-20). 구현 시 반드시 지켜라.
 *
 *   (1) ★참가자 대기주문 «총량 상한» = 2,000건 (참가자 1인당 최대 2건)
 *       로스터 회전은 «행동»을 상수 시간으로 만들었지만, 대기주문은 «매 틱 큐 전체
 *       판정»이라 다시 «참가자 수에 비례»하는 상시 부하를 만든다. 회전으로 번 것을
 *       그대로 반납하는 셈이다. 30일차에 대기주문을 쓰는 콘셉트가 1,300명 남짓이라
 *       큐가 1,300~2,600건까지 커진다 -> 2,000 에서 자른다.
 *       ticker 별 버킷 + 가격순 정렬이면 틱당 비용은 무시할 수준이다(현재 틱 0.198ms).
 *
 *   (2) ★★«틱당 체결 상한» = 20건. 초과분은 다음 틱으로 이월(가격 유리한 순).
 *       ★진짜 위험은 부하가 아니라 «동시 체결»이다 — 급락 한 번에 지정가 수백 건이
 *       같은 틱에 터지면 orderFlow 스파이크로 가격이 튄다.
 *       ★이건 파생 «자가 펌핑» 결함과 «같은 뿌리»다(자기 주문이 가격을 밀고 그 가격이
 *       다시 자기 평가액이 되는 되먹임). 그쪽은 위로 미는 사고, 이쪽은 아래로 미는 사고다.
 *       상한 20건의 근거: 정상 상태의 틱당 총 주문이 21.5~24.6건(실측)이다. 대기주문
 *       체결이 그 규모를 넘지 않으면 orderFlow 분포가 기존 캘리브레이션을 벗어나지 않는다.
 */

/**
 * ★ actProb 는 «신규 봇이 시장을 흔들지 않게» 기존 5종보다 낮게 잡았다.
 *   신규 봇은 로스터 회전 창으로 샘플링되므로(bots.ts) 개별 행동 빈도가 더 낮아진다.
 *   시장 조성은 기존 210명이 그대로 담당한다 — 그래야 가격 임팩트가 현행과 같다.
 */
export const CONCEPTS: Record<NewConcept, ConceptDef> = {
  // 「1등 주식만 삽니다」 — 시총 상위 20 종목만, 사서 거의 안 판다
  blue_chip: {
    id: 'blue_chip', actProb: 0.02, seedCash: 30_000, sizeMin: 0.08, sizeMax: 0.2,
    universe: 'top20', maxHoldings: 5, initialInvested: 0.85, cashFloor: 0.05,
    i18nKey: 'traders.concept.blue_chip',
  },
  // 「싸지면 줍습니다」 — 최근 고점 대비 빠진 종목만 산다
  dip_buyer: {
    id: 'dip_buyer', actProb: 0.08, seedCash: 20_000, sizeMin: 0.05, sizeMax: 0.12,
    universe: 'all', maxHoldings: 10, initialInvested: 0.6, cashFloor: 0.1,
    i18nKey: 'traders.concept.dip_buyer',
  },
  // 「한 종목에 다 겁니다」 — 항상 딱 1종목
  all_in: {
    id: 'all_in', actProb: 0.06, seedCash: 10_000, sizeMin: 0.5, sizeMax: 0.95,
    universe: 'top50', maxHoldings: 1, initialInvested: 0.95, cashFloor: 0.02,
    i18nKey: 'traders.concept.all_in',
  },
  // 「골고루 나눠 담습니다」 — 20종목 균등
  diversifier: {
    id: 'diversifier', actProb: 0.05, seedCash: 25_000, sizeMin: 0.03, sizeMax: 0.06,
    universe: 'all', maxHoldings: 20, initialInvested: 0.8, cashFloor: 0.05,
    i18nKey: 'traders.concept.diversifier',
  },
  // 「샀다 팔았다 반복합니다」 — 사면 곧 판다. 보유 2종목 상한
  day_trader: {
    id: 'day_trader', actProb: 0.3, seedCash: 15_000, sizeMin: 0.15, sizeMax: 0.4,
    universe: 'highVol30', maxHoldings: 2, initialInvested: 0.4, cashFloor: 0.15,
    i18nKey: 'traders.concept.day_trader',
  },
  // 「한번 사면 안 팝니다」 — 매도 경로가 아예 없다
  hodler: {
    id: 'hodler', actProb: 0.01, seedCash: 20_000, sizeMin: 0.1, sizeMax: 0.25,
    universe: 'all', maxHoldings: 12, initialInvested: 0.9, cashFloor: 0,
    i18nKey: 'traders.concept.hodler',
  },
  // 「내릴 것 같으면 공매도합니다」 — 현물 0. 숏 레버리지 2배 전용
  short_seller: {
    id: 'short_seller', actProb: 0.12, seedCash: 30_000, sizeMin: 0.15, sizeMax: 0.35,
    universe: 'all', maxHoldings: 0, initialInvested: 0, cashFloor: 0,
    i18nKey: 'traders.concept.short_seller',
  },
  // 「안 흔들리는 것만 삽니다」 — 변동성 하위 30 종목
  low_vol: {
    id: 'low_vol', actProb: 0.03, seedCash: 25_000, sizeMin: 0.06, sizeMax: 0.15,
    universe: 'lowVol30', maxHoldings: 8, initialInvested: 0.85, cashFloor: 0.05,
    i18nKey: 'traders.concept.low_vol',
  },
  // 「위험한 포지션을 노립니다」 — 청산 임박 물량이 몰린 쪽 «반대»로 5배를 건다
  liquidation_hunter: {
    id: 'liquidation_hunter', actProb: 0.05, seedCash: 25_000, sizeMin: 0.08, sizeMax: 0.2,
    universe: 'all', maxHoldings: 0, initialInvested: 0, cashFloor: 0,
    i18nKey: 'traders.concept.liquidation_hunter',
  },
};

export function isNewConcept(id: string): id is NewConcept {
  return Object.prototype.hasOwnProperty.call(CONCEPTS, id);
}

// ── 유니버스 ────────────────────────────────────────────────────────────
/** 종목 유니버스를 한 번만 만들어 재사용한다(매 틱 정렬하면 봇 수만큼 비용이 곱해진다) */
export class Universes {
  readonly all: string[];
  readonly top20: string[];
  readonly top50: string[];
  readonly lowVol30: string[];
  readonly highVol30: string[];

  constructor(instruments: Instrument[]) {
    this.all = instruments.map((i) => i.ticker);
    const byRank = [...instruments].sort((a, b) => a.rank - b.rank);
    this.top20 = byRank.slice(0, 20).map((i) => i.ticker);
    this.top50 = byRank.slice(0, 50).map((i) => i.ticker);
    const bySigma = [...instruments].sort((a, b) => a.sigma - b.sigma);
    this.lowVol30 = bySigma.slice(0, 30).map((i) => i.ticker);
    this.highVol30 = bySigma.slice(-30).map((i) => i.ticker);
  }

  of(kind: UniverseKind): string[] {
    switch (kind) {
      case 'top20':
        return this.top20;
      case 'top50':
        return this.top50;
      case 'lowVol30':
        return this.lowVol30;
      case 'highVol30':
        return this.highVol30;
      default:
        return this.all;
    }
  }
}

// ── 매매 로직 ───────────────────────────────────────────────────────────
/**
 * 콘셉트 봇 1회 행동. bots.ts 가 dispatch 한다.
 *
 * ★ 규칙은 «전부 여기 한 화면 안»에 있어야 한다. 길어지면 「직관적」이 아니다.
 * ★ 주문은 전부 World 의 공개 경로(placeSpotOrder/openLeverage)를 탄다 —
 *   플레이어와 동일한 검증·수수료·orderFlow 를 받는다(ARCHITECTURE 6장).
 */
export interface ConceptCtx {
  world: World;
  botId: string;
  def: ConceptDef;
  rng: Rng;
  uni: Universes;
  /** day_trader 전용: ticker -> 매수한 틱 */
  entryTick: Map<string, number>;
  /** 매수 예산 (bots.ts 의 buyBudget 과 동일 규칙) */
  budget: (ticker: string) => number;
  /** 부분 매도 (bots.ts 의 sellPartial 과 동일 규칙) */
  sell: (ticker: string, frac: number) => boolean;
  cashRatio: () => number;
}

function pick(rng: Rng, arr: readonly string[]): string {
  return arr[rng.int(arr.length)];
}

/**
 * 유니버스에서 «아직 안 들고 있는» 종목 하나. 없으면 null.
 * ★ 최대 6회만 시도한다 — 유니버스를 다 채운 봇에서 무한루프가 되지 않게.
 */
function pickUnheld(ctx: ConceptCtx): string | null {
  const acc = ctx.world.getAccount(ctx.botId);
  const u = ctx.uni.of(ctx.def.universe);
  for (let i = 0; i < 6; i++) {
    const t = pick(ctx.rng, u);
    if (!acc.holdings.has(t)) return t;
  }
  return null;
}

export function actConcept(ctx: ConceptCtx): void {
  switch (ctx.def.id) {
    case 'blue_chip':
      return actBlueChip(ctx);
    case 'dip_buyer':
      return actDipBuyer(ctx);
    case 'all_in':
      return actAllIn(ctx);
    case 'diversifier':
      return actDiversifier(ctx);
    case 'day_trader':
      return actDayTrader(ctx);
    case 'hodler':
      return actHodler(ctx);
    case 'short_seller':
      return actShortSeller(ctx);
    case 'low_vol':
      return actLowVol(ctx);
    case 'liquidation_hunter':
      return actLiquidationHunter(ctx);
  }
}

/**
 * 청산 사냥꾼 — 청산에 몰린 «방향»의 반대편에 선다.
 *
 * ★⛔특정 계정을 «지목하지 않는다». world.vulnerable 은 종목별 «집계»라 봇인지
 *   사람인지 알 수 없다. 롱이 몰렸으면 숏, 숏이 몰렸으면 롱 — 완전히 대칭이다.
 * ★강도를 5배로 묶어둔 이유: 20배로 풀면 캐스케이드를 스스로 만들어 청산 폭주를 낸다
 *   (대책 없이 봇을 늘렸을 때 2,814건이 났던 사례). 5배 + 소수 인원이면 «자극»만 준다.
 */
function actLiquidationHunter(ctx: ConceptCtx): void {
  const w = ctx.world;
  const acc = w.getAccount(ctx.botId);
  for (const pos of [...acc.levPositions.values()]) {
    const roi = w.levPositionEquity(pos) / pos.margin - 1;
    if (roi > 0.2 || roi < -0.25 || w.tick - pos.openedTick > 150) {
      w.closeLeverage(ctx.botId, pos.id);
      return;
    }
  }
  if (acc.levPositions.size >= 2) return;

  let best: string | null = null;
  let bestVal = 0;
  let side: 'long' | 'short' = 'short';
  for (const [tk, v] of w.vulnerable) {
    const net = v.long - v.short;
    if (Math.abs(net) > bestVal) {
      bestVal = Math.abs(net);
      best = tk;
      side = net > 0 ? 'short' : 'long';
    }
  }
  if (!best || bestVal < 1_000) return;
  const margin = Math.min(
    w.equity(acc) * ctx.rng.range(ctx.def.sizeMin, ctx.def.sizeMax),
    acc.cash * 0.9,
    w.maxOrderNotional(best) / 5
  );
  if (margin < 10) return;
  w.openLeverage(ctx.botId, best, side, 5, margin);
}

/** 1등 주식만 산다. 5종목 채우면 그냥 들고 있는다. */
function actBlueChip(ctx: ConceptCtx): void {
  const acc = ctx.world.getAccount(ctx.botId);
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const size = ctx.budget(t);
  if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}

/** 최근 300틱(=2게임일) 평균 대비 3% 아래면 산다. 원가 대비 5% 오르면 절반 판다. */
function actDipBuyer(ctx: ConceptCtx): void {
  const acc = ctx.world.getAccount(ctx.botId);
  for (const [t, h] of acc.holdings) {
    if (ctx.world.engine.priceOf(t) > h.avgCost * 1.05) {
      if (ctx.sell(t, 0.5)) return;
    }
  }
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const px = ctx.world.engine.priceOf(t);
  const ma = ctx.world.engine.sma(t, 300);
  if (!Number.isFinite(ma) || px >= ma * 0.97) return;
  const size = ctx.budget(t);
  if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}

/** 딱 1종목. 원가 대비 8% 빠지면 전량 갈아탄다. */
function actAllIn(ctx: ConceptCtx): void {
  const acc = ctx.world.getAccount(ctx.botId);
  const held = [...acc.holdings.entries()][0];
  if (held) {
    const [t, h] = held;
    if (ctx.world.engine.priceOf(t) < h.avgCost * 0.92) {
      ctx.sell(t, 1);
      return;
    }
    // 남은 현금이 있으면 같은 종목에 더 태운다
    if (ctx.cashRatio() > 0.15) {
      const size = ctx.budget(t);
      if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
    }
    return;
  }
  const t = pick(ctx.rng, ctx.uni.of(ctx.def.universe));
  const size = ctx.budget(t);
  if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}

/** 20종목 균등. 한 종목 비중이 목표의 1.6배를 넘으면 덜어낸다. */
function actDiversifier(ctx: ConceptCtx): void {
  const w = ctx.world;
  const acc = w.getAccount(ctx.botId);
  const target = w.equity(acc) / ctx.def.maxHoldings;
  for (const [t, h] of acc.holdings) {
    if (h.qty * w.engine.priceOf(t) > target * 1.6) {
      if (ctx.sell(t, 0.4)) return;
    }
  }
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const size = Math.min(ctx.budget(t), target);
  if (size > 1) w.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}

/** 사면 5~15틱 안에 판다. 보유 2종목 상한. */
function actDayTrader(ctx: ConceptCtx): void {
  const w = ctx.world;
  const acc = w.getAccount(ctx.botId);
  for (const t of acc.holdings.keys()) {
    const opened = ctx.entryTick.get(t) ?? w.tick;
    if (w.tick - opened >= 5 + ctx.rng.int(11)) {
      if (ctx.sell(t, 1)) {
        ctx.entryTick.delete(t);
        return;
      }
    }
  }
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const size = ctx.budget(t);
  if (size > 1) {
    w.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
    ctx.entryTick.set(t, w.tick);
  }
}

/** 사기만 한다. 매도 경로가 아예 없다. */
function actHodler(ctx: ConceptCtx): void {
  const acc = ctx.world.getAccount(ctx.botId);
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const size = ctx.budget(t);
  if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}

/**
 * 공매도 전용 — 현물은 손대지 않고 «숏 레버리지 2배»만 쓴다.
 *
 * ★ 왜 현물 숏이 아닌가: 엔진에 음수 보유 개념이 없다. 넣으려면
 *   holdingsValue/avgCost/equity/저장 스키마를 전부 재정의해야 하고 라이브 세이브를
 *   건드린다. 숏 레버리지는 청산·펀딩비·orderFlow 가 이미 검증된 경로다.
 *   유저 화면에는 「숏 2배」로 그대로 보이므로 「공매도합니다」와 표기도 어긋나지 않는다.
 *
 * ★ 왜 2배인가: 종목 mu 가 전부 양수라(+0.087~+0.142) 숏은 장기적으로 진다.
 *   레버리지를 낮추고 «단기 급등 되돌림»만 노려 상승 드리프트 노출 시간을 줄인다.
 *   ★ 파생 주문은 명목가치만큼 orderFlow 를 미는데(증거금의 2~20배), 이 지렛대가
 *     파생봇 초과수익의 원인으로 실측됐다. 그래서 여기서는 최저 배율만 쓴다.
 */
function actShortSeller(ctx: ConceptCtx): void {
  const w = ctx.world;
  const acc = w.getAccount(ctx.botId);

  for (const pos of [...acc.levPositions.values()]) {
    const roi = w.levPositionEquity(pos) / pos.margin - 1;
    if (roi > 0.15 || roi < -0.2 || w.tick - pos.openedTick > 300) {
      w.closeLeverage(ctx.botId, pos.id);
      return;
    }
  }
  if (acc.levPositions.size >= 3) return;

  const t = pick(ctx.rng, ctx.uni.of(ctx.def.universe));
  if (w.engine.returnOver(t, 60) < 0.008) return; // 단기 급등만 노린다(되돌림)
  const margin = Math.min(
    w.equity(acc) * ctx.rng.range(ctx.def.sizeMin, ctx.def.sizeMax),
    acc.cash * 0.9,
    w.maxOrderNotional(t) / 2
  );
  if (margin < 10) return;
  w.openLeverage(ctx.botId, t, 'short', 2, margin);
}

/** 변동성 하위 30종목만. 천천히 모은다. */
function actLowVol(ctx: ConceptCtx): void {
  const acc = ctx.world.getAccount(ctx.botId);
  if (acc.holdings.size >= ctx.def.maxHoldings) return;
  const t = pickUnheld(ctx);
  if (!t) return;
  const size = ctx.budget(t);
  if (size > 1) ctx.world.placeSpotOrderByNotional(ctx.botId, t, 'buy', size);
}
