/**
 * ★assetClass — 자산군. 리터럴 유니언으로 «좁게» 둔다.
 *
 * ⛔`string` 으로 넓히지 마라. 넓히면 'stok' 같은 오타가 조용히 통과하고,
 *   그 종목은 지수 구성에서도 배당 대상에서도 «말없이» 빠진다(에러가 안 난다).
 * ★engine/indexBasket.ts 의 AssetClass 와 «같은 집합»이어야 한다.
 *   scripts/check_ticker_schema.mjs 가 매 실행 대조한다.
 */
export type AssetClass = 'stock' | 'index' | 'commodity' | 'crypto';

export interface TickerMeta {
  rank: number;
  ticker: string;
  /** CSV 원문 법인명 (출처 추적용) */
  legalName: string;
  nameKo: string;
  nameEn: string;
  sectorKo: string;
  sectorEn: string;
  tierKo: string;
  tierEn: string;
  /** 상표 회피용 이니셜 2글자 타일 */
  initials: string;
  /** 기업 연상색 (로고 대체) */
  color: string;
  initialPrice: number;
  /** 연율 드리프트 */
  mu: number;
  /** 연율 변동성 */
  sigma: number;
  /**
   * ★자산군. 2026-08-22 신설 (President 지시 ② 금·원유·지수·코인 추가).
   *
   * ★왜 optional 인가 (필수로 두려다 되돌린 기록):
   *   필수로 두면 `store/hooks.ts` 의 «알 수 없는 티커» 폴백 객체가 타입에서 깨진다.
   *   그 파일은 frontend 소유라 내가 못 고치고, 고치려고 기다리면 빌드가 계속 막힌다.
   * ★그렇다고 «오타가 새는» 건 아니다 — 값 자체는 리터럴 유니언이라
   *   'stok' 같은 오타는 «여전히» 타입에서 죽는다. optional 이 허용하는 건 «생략»뿐이다.
   * ★그 «생략»은 타입이 아니라 ★검사기가 막는다:
   *      node scripts/check_ticker_schema.mjs
   *   생성 데이터의 «모든» 행에 assetClass 가 있고 유니언 안인지 전수 검사한다.
   *   ⇒ 「타입으로 못 막는 것은 검사기로 막는다」 — 인계문서 U-4 규율 그대로다.
   */
  assetClass?: AssetClass;
  /**
   * 상장 거래소 ('Nasdaq' | 'NYSE' | '-'). 나스닥 지수 구성 자격 판정에 쓴다.
   * ★비주식 자산은 '-' 다. optional 로 둔 이유는 기존 100종목 데이터에 없어도
   *   읽는 쪽이 죽지 않게 하기 위해서다.
   */
  exchange?: string;
}

export type BotStrategy = 'momentum' | 'mean_reversion' | 'whale' | 'noise' | 'derivatives_heavy';

export interface BotMeta {
  botId: string;
  nickname: string;
  strategy: BotStrategy | string;
}
