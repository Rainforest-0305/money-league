/**
 * 공개 인덱스에서 export 되지 않는 브릿지들을 직접 선언한다.
 *
 * ── 왜 직접 만드는가 (★ 이 프로젝트의 node_modules 에서 «재실측», 인용 아님) ──
 * @apps-in-toss/web-framework 는 `export * from '@apps-in-toss/web-bridge'`
 * 뿐인데, 이 프로젝트에 설치된 web-bridge@2.10.8 기준:
 *
 *   dist/bridge.js  (구현은 «있다»)
 *     closeView        = createAsyncBridge("closeView")
 *     getAnonymousKey  = createAsyncBridge("getAnonymousKey")
 *     getUserKeyForGame= createAsyncBridge("getUserKeyForGame")
 *
 *   dist/index.js   (재export 는 «없다» — grep 히트 0건)
 *     getAnonymousKey 0 / getUserKeyForGame 0 / closeView 0
 *     ※ 대조: SafeAreaInsets 11건 · Storage 12건 · graniteEvent 3건 은 정상 노출.
 *       즉 「0건」이 검색 실패가 아니라 실제 미노출임을 같은 파일·같은 명령으로 확인했다.
 *
 * package.json exports 에 서브패스가 없어 deep import 도 막힌다. 그래서 우리가
 * 직접 선언한다.
 *
 * createAsyncBridge(method) 는 method 문자열을 그대로 네이티브에 postMessage 하는
 * 얇은 래퍼라, SDK 가 공식 export 했든 우리가 직접 선언했든 런타임 동작은 동일하다.
 * 해킹이 아니라 SDK 가 공식 노출한 확장점이다.
 *
 * ※ import 는 @apps-in-toss/bridge-core 에서 한다. web-bridge 의 .d.ts 는
 *   createAsyncBridge 를 타입 export 하지 않아(런타임 export 목록과 .d.ts 가
 *   어긋난 업스트림 불일치) web-framework 경유로 import 하면 TS 에러가 난다.
 *   bridge-core 는 같은 싱글턴 모듈이고 타입도 온전하다.
 *
 * 출처: 트랙 K 네온스레드 src/toss/bridge.ts. 로직 무변경, 근거만 재실측으로 갱신.
 */
import { createAsyncBridge } from '@apps-in-toss/bridge-core';

export interface AnonymousKeySuccess {
  type: 'HASH';
  hash: string;
}

/**
 * 필수 SDK ①-a — 사용자 식별키 (레거시 이름)
 *
 * 반환:
 *   { type:'HASH', hash } — 성공
 *   'INVALID_CATEGORY'    — 콘솔에서 앱 카테고리가 '게임'이 아님
 *   'ERROR'               — 알 수 없는 오류
 *   undefined             — 토스 앱 버전이 최소 지원 버전 미만
 *
 * 'INVALID_CATEGORY' 가 뜨면 «코드 문제가 아니라 콘솔 설정 문제»다.
 * granite.config.ts 의 webViewProps.type='game' 과 «별개»로, 토스 콘솔에서
 * 앱 카테고리를 게임으로 등록해야 이 API 가 열린다.
 */
export const getUserKeyForGame = createAsyncBridge<
  [],
  AnonymousKeySuccess | 'INVALID_CATEGORY' | 'ERROR' | undefined
>('getUserKeyForGame');

/**
 * 필수 SDK ①-b — 사용자 식별키 (신규 이름, 권장)
 *
 * ★★ 웹 경로와 RN 경로에서 동작이 다르다:
 *   [RN 경로] getUserKeyForGame() 이 getAnonymousKey() 를 부르는 단순 별칭.
 *   [웹 경로] web-bridge@2.10.8 dist/bridge.js — **별칭이 아니다.** 위 실측대로
 *     서로 «다른 네이티브 메서드 이름»으로 나간다.
 *
 * 그래서 웹 경로에서 getAnonymousKey 만 쓰는 것은 위험하다. 네이티브 핸들러
 * 레지스트리에 'getAnonymousKey' 가 없으면 Promise 가 resolve 도 reject 도
 * 못 받고 **영원히 pending** 이다(브릿지 코어에 타임아웃 없음). 부팅 경로에서
 * await 하면 무한 로딩 = 흰 화면이다.
 *
 * → identity.ts 는 (1) 신규 이름 먼저, (2) safeBridge 3초 타임아웃,
 *   (3) 실패 시 레거시 이름 폴백 순으로 두 채널을 모두 시도한다.
 *   [확인] 두 브릿지의 메서드명이 다르다 / [추정] 네이티브가 신규 이름을 아는지
 *   — 실기기 검증 필요.
 */
export const getAnonymousKey = createAsyncBridge<[], AnonymousKeySuccess | 'ERROR' | undefined>(
  'getAnonymousKey'
);

/** 미니앱 종료 (뒤로가기 → 종료확인 모달의 '종료' 버튼에서 사용) */
export const closeView = createAsyncBridge<[], void>('closeView');

/* ===========================================================================
   프로모션(토스 포인트) 지급 — ★2026-08-26 신설
   ---------------------------------------------------------------------------
   조건: 「거래 성공」(현물 주문 체결) → 100원 (President 확정 2026-08-26)
     ⚠️「자산 10만 달러 돌파」에서 바뀐 것이다. 토스 프로모션 심사 체크리스트에
       「지급하는 포인트가 게임 결과나 등수를 기준으로 정해지지 않나요?」와
       「사용자가 가진 재화를 토스 포인트로 교환·전환해 주는 형태는 아닌가요?」가
       있다. 게임 내 자산 액수를 기준으로 삼으면 양쪽에 걸린다.
       ⇒ 「거래 «완료»」는 결과·금액과 무관한 «행동»이라 안전하다. 문서의 가능
         예시 「튜토리얼 완료 시 N포인트」와 동형이다.

   ★ 왜 createAsyncBridge 로 «직접» 만드는가
     web-bridge@2.10.8 의 `dist/index.js` 재수출 배럴에 이 둘이 «없다»(실측 0건).
     그런데 `dist/bridge.js` 에 정의가 있고 d.ts 도 각각 존재한다.
     ⇒ 「배럴에서만 빠진 것」이지 「없는 것」이 아니다.
       ★「0건은 부재의 증거가 아니다」.

   ★ 파라미터가 «중첩»이다(d.ts 실측 — 개발자센터 문서와 다르다):
       grantPromotionReward({ params: { promotionCode, amount } })
   ★ 반환 4갈래: { key } / { errorCode, message } / 'ERROR' / undefined(구버전)
     ⇒ `isSupported()` 는 이 브릿지들에 «없다». 미지원 판정은 undefined 반환으로 한다.
   ⛔ 네이티브 무응답 시 «영원히 pending» — 반드시 safeBridge 로 감싸라.
   =========================================================================== */

export interface GrantPromotionSuccess {
  key: string;
}
export interface GrantPromotionFailure {
  errorCode: string;
  message: string;
}
export type GrantPromotionResult =
  | GrantPromotionSuccess
  | GrantPromotionFailure
  | 'ERROR'
  | undefined;

export interface GrantPromotionParams {
  params: { promotionCode: string; amount: number };
}

/** 현행 API. 게임/비게임 공통. */
export const grantPromotionReward = createAsyncBridge<
  [GrantPromotionParams],
  GrantPromotionResult
>('grantPromotionReward');

/** 레거시(@deprecated). 신규가 네이티브에 없을 때의 폴백 전용. */
export const grantPromotionRewardForGame = createAsyncBridge<
  [GrantPromotionParams],
  GrantPromotionResult
>('grantPromotionRewardForGame');
