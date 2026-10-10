/**
 * 로컬 게임 엔진 — 서버(build/server) 이식본.
 *
 * 구성:
 *   rng.ts         mulberry32 + Marsaglia polar (서버 rng.ts)
 *   priceEngine.ts ARCHITECTURE 1장 가격 공식 + 링버퍼 지표 (서버 engine/priceEngine.ts)
 *   world.ts       체결·레버리지·옵션·강제청산·랭킹 (서버 world/world.ts)
 *   bots.ts        봇 210개 5전략 실매매 (서버 bots/bots.ts)
 *   data.ts        generated 데이터 -> 엔진 입력 (서버 data/loadData.ts)
 *   persistence.ts localStorage 영속 (서버 db/db.ts + gameService 스냅샷)
 *   gameWorld.ts   위 전부를 묶는 파사드 (서버 world/gameService.ts)
 */
export { GameWorld, GameError, kstDateKey, resolveSeed } from './gameWorld';
export type { GameWorldOptions } from './gameWorld';
export { World } from './world';
export type { WorldEvent } from './world';
export { BotEngine, BOT_PROFILES } from './bots';
export { PriceEngine } from './priceEngine';
export { Rng } from './rng';
export { loadBots, loadInstruments } from './data';
export type { Account, BotDef, BotStrategy, Instrument, LeveragePosition, OptionPosition } from './types';
