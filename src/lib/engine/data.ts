/**
 * 생성 데이터(`src/data/*.generated.ts`) → 엔진 입력 어댑터.
 * 서버의 `src/data/loadData.ts`(CSV 로더)에 해당한다. 정적 빌드에서는 CSV 대신
 * 빌드타임에 생성된 TS 모듈을 그대로 쓴다(런타임 fetch 0건).
 */
import { EXPECTED_BOT_COUNT, EXPECTED_TICKER_COUNT, LIQUIDITY_DEPTH_BASE_USD, depthFactorForRank } from '../constants';
import { BOTS } from '../../data/bots.generated';
import { TICKERS } from '../../data/tickers.generated';
import { buildRoster, elapsedDays, STARTING_EXTRA_BOTS } from './roster';
import { INDEX_DEPTH_MULT, type BasketMeta } from './indexBasket';
import type { BotDef, BotStrategy, Instrument } from './types';

/**
 * 신규 참가자 «합류» 스위치 — 폰 실측·i18n 키·배지 조회가 준비될 때까지 꺼 둔다.
 *
 * ★ 왜 코드를 지우지 않고 스위치로 끄는가:
 *   끈 상태에서는 명부가 210명이라 isNewConcept() 가 전부 false -> newcomers 가 빈 배열이 되고
 *   stepNewcomers() 가 즉시 return 한다. concepts.ts 는 «한 번도 실행되지 않는다».
 *   기존 210명의 난수 스트림도 그대로라 시장이 완전히 동일하다(실측 확인).
 * ★ 그리고 elapsedDays() 가 호출되지 않으므로 localStorage 에 'ml.firstSeen' 이 «기록되지 않는다».
 *   따라서 나중에 켜는 날이 0일차가 된다 — 켜는 순간 며칠치가 한꺼번에 쏟아지지 않는다.
 * ★ 켜기 전 선행조건(순서 엄수): (1) traders.concept.* 13종 ko/en 등재
 *   (2) Leaderboard/TraderProfile 의 static BOTS 조회를 botMeta() 로 교체
 *   (3) 폰 실기기 실측(워밍업·catchup·heap·store.flushRanks 2,521행 경로)
 *   이 셋이 끝난 «뒤에» 이 값을 true 로 바꾼다.
 */
const ROSTER_GROWTH_ENABLED = true;

const STRATEGIES: readonly BotStrategy[] = [
  'momentum',
  'mean_reversion',
  'whale',
  'noise',
  'derivatives_heavy',
];

/**
 * bots.generated.ts 의 strategy 는 타입이 `BotStrategy | string` 이다(생성기 산출).
 * 알 수 없는 값이 들어오면 유동성 공급 봇으로 떨어뜨린다 — 봇 1개 때문에
 * 월드 전체가 죽지 않게 하는 방어이며, 정상 데이터에서는 절대 타지 않는다.
 */
function normalizeStrategy(s: string): BotStrategy {
  return (STRATEGIES as readonly string[]).includes(s) ? (s as BotStrategy) : 'noise';
}

/**
 * 종목 목록 — 유동성 깊이는 랭크(시총 프록시)에 따라 1.0 ~ 0.25 배.
 *
 * ★지수(assetClass==='index')만 «별도 깊이»를 쓴다: LIQUIDITY_DEPTH_BASE_USD x INDEX_DEPTH_MULT.
 *   ⛔그 배수를 올리면 「종목으로 밀고 지수에서 먹기」 차단이 깨진다 — indexBasket.ts 머리주석 참조.
 *   ⛔랭크 기반 depthFactorForRank 를 지수에 쓰면 «rank 999» 라 0.25 배가 되어 더 얕아진다.
 *     그러면 지수 주문상한이 작아져 «오히려» 안전하지만, 지수를 살 수 있는 금액이 비현실적으로 준다.
 */
export function loadInstruments(): Instrument[] {
  const out = TICKERS.map((t) => ({
    rank: t.rank,
    ticker: t.ticker,
    initialPrice: t.initialPrice,
    mu: t.mu,
    sigma: t.sigma,
    liquidityDepth: t.assetClass === 'index'
      ? LIQUIDITY_DEPTH_BASE_USD * INDEX_DEPTH_MULT
      : LIQUIDITY_DEPTH_BASE_USD * depthFactorForRank(t.rank),
  }));
  if (out.length !== EXPECTED_TICKER_COUNT)
    console.warn(`[engine] ticker count ${out.length} != ${EXPECTED_TICKER_COUNT}`);
  return out;
}

/**
 * 참가자 명부 = 원년 멤버 210명(아키타입 5종 × 42) + 하루 77명씩 합류한 신규 참가자.
 *
 * ★ 「하루」는 «실제 KST 경과일»이다 — 근거는 roster.ts 머리주석.
 * ★ 반환 타입이 BotDef[] 그대로인 이유: gameWorld 는 `new BotEngine(loadBots(), seed)`
 *   한 줄로 봇을 붙인다. 여기서 명부를 통째로 돌려주면 «호출부를 하나도 고치지 않고»
 *   신규 참가자가 합류한다(gameWorld.ts 는 다른 레인이 동시 작업 중이라 손대지 않는다).
 * ★ strategy 필드에는 신규 콘셉트 id(blue_chip 등)가 들어간다. engine/types.ts 의
 *   BotStrategy 유니언은 아직 기존 5종이라 여기서 캐스트한다 — 유니언 확장은
 *   공유 파일 작업창이 열릴 때 함께 넣는다(그때 이 캐스트를 지운다).
 *
 * @param daysOverride 시뮬레이션·테스트용. 실제 앱은 KST 경과일을 쓴다.
 */
export function loadBots(daysOverride?: number): BotDef[] {
  const base = BOTS.map((b) => ({
    botId: b.botId,
    nickname: b.nickname,
    strategy: normalizeStrategy(String(b.strategy)),
  }));
  // ★ 이 경고는 «원년 멤버»에만 건다. 명부 전체는 날짜에 따라 늘어나는 게 정상이다
  if (base.length !== EXPECTED_BOT_COUNT)
    console.warn(`[engine] base bot count ${base.length} != ${EXPECTED_BOT_COUNT}`);

  // ★ elapsedDays() 를 «삼항 안에 남긴다». `?? 0` 으로 지우면 import 가 미사용이 되어
  //   noUnusedLocals 로 빌드가 깨진다(2026-08-20 TS6133 실사고와 같은 구조).
  const days = daysOverride ?? (ROSTER_GROWTH_ENABLED ? elapsedDays() : 0);
  // ★개장 멤버(★9,790명 — 2026-08-23 B안)도 «같은 스위치»에 묶는다. 스위치가 꺼져 있으면 명부는 원년 210명뿐이라
  //   신규 콘셉트가 화면에 한 명도 나타나지 않는다 — i18n·배지 미비 상태에서 새는 사고를
  //   구조적으로 막는 장치다(2026-08-20 실사고 대응).
  const startingExtra = ROSTER_GROWTH_ENABLED ? STARTING_EXTRA_BOTS : 0;
  return buildRoster(base, days, startingExtra).map((r) => ({
    botId: r.botId,
    nickname: r.nickname,
    strategy: r.concept as BotStrategy, // roster 는 문자열을 돌려준다(유니언은 types.ts)
  }));
}

/**
 * 지수 구성에 필요한 메타. `buildIndexes()` 에 넘긴다.
 * ★`loadInstruments()` 와 «같은 원본(TICKERS)»에서 나온다 — 두 벌이 갈릴 수 없다.
 */
export function loadBasketMetas(): BasketMeta[] {
  return TICKERS.map((t) => ({
    ticker: t.ticker,
    rank: t.rank,
    assetClass: t.assetClass ?? 'stock',
    exchange: t.exchange,
  }));
}

/**
 * 배당 판정용 종목 메타 (섹터·자산군). `World` 에 넘긴다.
 * ★`loadInstruments()` 와 «같은 원본(TICKERS)»에서 나온다 — 두 벌이 갈릴 수 없다.
 */
export function loadTickerMeta(): Map<string, { sectorKo: string; assetClass?: string }> {
  return new Map(TICKERS.map((t) => [t.ticker, { sectorKo: t.sectorKo, assetClass: t.assetClass }]));
}
