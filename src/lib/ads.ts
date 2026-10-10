/**
 * 앱인토스 광고 — ★모든 광고 ID 와 SDK 호출을 «여기 한 곳»에 모은다.
 *
 * ── 왜 한 곳인가 (2026-08-19 Partner 지시) ───────────────────────────────
 * 지면은 발급 직후 `iaa_placement_group_create` 가 낙관적으로 ENABLED 를 돌려주지만,
 * 권위 있는 목록 조회(`iaa_placement_group_list`)로 재확인하면 한동안
 * **state=REGISTERING · groupId=null** 이다(구글 광고 시스템 반영 최대 2h).
 * 공식 경고: 「반영 전 ID 는 코드에 넣어도 광고가 나오지 않는다」.
 * ⇒ 그래서 «목록 조회로 재확인»이 규칙이다. 낙관적 응답을 믿지 마라.
 *
 * ★┃2026-08-20 확정┃아래 7종은 전부 **ENABLED 확정 ID** 다(Partner 확인분).
 *   더 이상 «잠정값»이 아니다. 바꾸려면 콘솔 지면부터 바꾸고 여기 한 줄을 고친다.
 * ⇒ ★그래도 «로컬에서 광고가 안 뜨는 것은 여전히 정상»이다 — SDK 는 토스 앱 안에서만 산다.
 *   코드 탓으로 단정하지 마라. ⛔운영 ID 로 로컬 실렌더를 시도하는 것은 계정 중단 사유다.
 *
 * ── 실행 경로 (이 프로젝트 node_modules 에서 실측, 인용 아님) ───────────
 * 이 앱은 «웹 경로»다: @apps-in-toss/web-framework/dist-web/index.d.ts 가
 *   export * from '@apps-in-toss/web-bridge'
 *   export * from '@apps-in-toss/web-analytics'
 * 두 줄뿐이다. 따라서 배너는 RN 경로의 `InlineAd`/`IOScrollView`/`withIO` 가
 * **아니라** `TossAds.attachBanner(adGroupId, target, options)` 다.
 * ⇒ 핸드북의 「IOScrollView 없으면 ImpressionArea 가 throw」 함정은 «해당 없음».
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────
 * · 이 파일의 함수는 «절대 throw 하지 않는다». 토스 밖(itch.io·GitHub Pages·
 *   MS Store 래핑·로컬 브라우저)이 이 앱의 «정상 경로»이기 때문이다.
 * · 보상은 오직 `userEarnedReward` 이벤트에서만 지급한다. 중도 이탈에는 없다.
 */
import { GoogleAdMob, TossAds } from '@apps-in-toss/web-framework';
import { isInToss } from '../toss/env';
/* ★하루 리셋 기준은 앱 전체가 «한 벌»을 쓴다(충전·열람권·출석과 같은 자정). 두 번째 기준을 만들지 마라 */
import { kstDateKey, nowMs } from './daykey';
/* ★[-33] 광고 계측(요청→로드→노출 어디서 새는가). 전송 0 · 새 키 ml.ads.stats 하나 · 절대 throw 안 함 */
import { noteAd } from './adStats';

/* ── 지면 ID (2026-08-20 ★ENABLED 확정) ────────────────────────────── */
export const AD_IDS = {
  /** REWARDED · 보상단위 「충전권」 unitAmount 1 — 무료 충전 소진 시 */
  rewardTopup: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** REWARDED · 보상단위 「열람권」 unitAmount 5 — 트레이더 열람 소진 시 */
  rewardTraderView: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /**
   * REWARDED · 보상단위 「출석 보상」 unitAmount 1 — 출석 «2배» 버튼 전용 (콘솔 2026-08-22 생성 · ENABLED).
   *
   * ★★[2026-09-05 Partner 실측 — «배선 오류» 수정] 이 줄이 «없어서» 출석 2배 버튼이
   *   `rewardTopup`(파산충전 지면)으로 나가고 있었다. 결과가 둘이다:
   *     ① 출석 지면 리포트가 14일 내내 null — 호출이 0건이라 «없는 지면»처럼 보였다
   *     ② 출석 2배가 «충전 광고 경제»를 갉아먹었다 — `grantAdReward('topup')` 을 타면서
   *        오늘 충전 광고 여유(TOPUP_AD_BONUS_MAX)를 소비하고, 그게 다 차면
   *        「상한 도달」 토스트만 뜨고 ★2배가 아예 안 됐다.
   *   ⇒ 그래서 `RewardAd` 에 kind `'attendance'` 를 따로 판다. 출석 2배는
   *     `grantAdReward` 를 ★타지 않는다 — 상한은 `store.grantAttendanceDouble`(하루 1회)이 씌운다.
   *     시즌 연장(`rewardSeasonExtend`)이 충전 경제를 안 타는 것과 «같은 이유·같은 구조»다.
   */
  rewardAttendance: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /**
   * REWARDED · MOMENT_VIDEO · 보상단위 「시즌 연장」 unitAmount 1 — 시즌 마감 화면(2026-08-29 발급).
   *
   * ★[2026-08-29 Partner 전달] 콘솔 응답 ENABLED. `iaa_placement_group_list` 재확인은 Partner 몫이다 —
   *   반영 전이면 광고가 «안 나올 뿐» 코드는 그대로다(그때는 마감 화면이 「새 시즌 시작」만 보여 준다).
   * ★보상 «의미»는 「자산·포지션·순위를 그대로 둔 채 마감을 +7일」이다. 현금을 주지 않는다 —
   *   충전·열람권과 «다른 경제»라 `grantAdReward` 를 «타지 않고» store.extendSeason() 이 받는다.
   */
  rewardSeasonExtend: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** BANNER · NORMAL — 홈 하단(비스크롤 고정 영역) */
  bannerHome: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** BANNER · NATIVE_IMAGE — 랭킹 100명 스크롤 구간 */
  bannerLeaderboard: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** BANNER · NATIVE_IMAGE — 종목 100개 스크롤 구간 */
  bannerStocks: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** BANNER · NATIVE_IMAGE — 트레이더 프로필 */
  bannerTraderProfile: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /** BANNER · NORMAL — 설정(원래 「종목목록 문구형」으로 발급한 지면의 용도 변경) */
  bannerSettings: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /**
   * BANNER · NORMAL — 충전 «완료» 화면 (2026-08-20 발급, 어뷰징 제한 NONE).
   * ★유저가 기분 좋고 다음 행동 전에 잠깐 머무는 자리다. 주문 버튼이 없어 오탭이 돈으로 안 간다.
   * ⛔CTA 와 24px 이상 띄운다.
   */
  bannerRechargeDone: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /*
   * ★[2026-09-10 · -33 제거] 파생 탭 배너(NATIVE_IMAGE · 콘솔 지면 「파생 탭 포지션 목록 아래 배너」 · ID 꼬리 XXXXXXXX…).
   *   콘솔 실측 09-02~08: 노출 797회 → 241원(하루 34.4원) · 09-08 eCPM 213원. 「내 포지션」 아래 «첫 화면 안»에
   *   들어와 노출만 많고 값이 없던 지면이다(President 승인 전략 2-2). ⇒ 코드에서 호출을 «뺀다».
   *   ⛔콘솔 지면 삭제는 Partner 게이트다. ⛔이 키를 되살리려면 `AD_RESERVED_H` 와 Derivatives.tsx 도 같이.
   *   번들 grep 은 이 ID 가 «없어야» 통과다(verify_ads33.py) — 주석에도 전체 ID 를 적지 않는다.
   */
  /**
   * BANNER · NATIVE_IMAGE — 거래 일지 목록 «중간»(2026-08-21 신설 화면).
   *
   * ★[2026-08-21 발급 완료] `iaa_placement_group_list` 재확인분:
   *   `state=ENABLED · adFormat=BANNER · adStyles=["NATIVE_IMAGE"] · abuseLevel=NONE`.
   *   ⇒ 더 이상 «잠정값»이 아니다. 위 7종과 같은 지위다.
   * ★빈 값이던 동안 `AdBanner`·`adSlotVisible()` 이 «아무것도 그리지 않게» 막고 있었다.
   *   이제 그 가드가 풀린다 — 자리는 `AD_RESERVED_H.bannerJournal` 로 이미 잡혀 있다.
   */
  bannerJournal: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /**
   * BANNER · NATIVE_IMAGE — 종목 «상세» 화면, 차트보다 아래의 스크롤 구간.
   *
   * ★[2026-08-21 Partner 실측] 이 화면에는 배너가 ★아예 없었다(`grep -c AdBanner` = 0).
   *   100종목 목록에서 탭할 때마다 들어가는, 앱에서 «가장 자주 열리는» 화면이다.
   * ★[2026-08-21 발급 완료] `iaa_placement_group_list` 재확인분:
   *   `state=ENABLED · adFormat=BANNER · adStyles=["NATIVE_IMAGE"] · abuseLevel=NONE`.
   * ⛔이 화면 «하단에는 고정 주문바»가 있다. 배너 위치를 아래로 옮기지 마라 —
   *   정책상 「상호작용 요소와 인접 배치」 금지이고, 여기서 오탭은 곧 (가상)돈이 나가는 조작이다.
   *   실측 근거는 `StockDetail.tsx` 의 배너 주석과 `verify_journal.py` 14-b 검사에 있다.
   */
  bannerStockDetail: 'ait.v2.live.XXXXXXXXXXXXXXXX',
  /**
   * INTERSTITIAL(전면) — 화면 «전환» 사이에만 낀다. 2026-09-05 현재 ★콘솔 지면 생성 진행 중.
   *
   * ⛔빈 문자열이다. 그리고 «빈 값인 채로 도는 것»이 정상 동작이다 —
   *   `interstitialGateOn` 이 `no-placement` 로 잘라서 SDK 를 ★아예 부르지 않는다.
   *   (빈 ID 로 SDK 를 부르면 조용히 실패한다. 「호출은 했다」가 「지면이 있다」가 되면 안 된다.)
   * ★발급되면 여기 «한 줄»이 전부다. 삽입 지점·빈도 가드는 이미 코드에 있다.
   * ★`'' as string` 인 이유: `as const` 아래에서 빈 리터럴 타입(`''`)으로 좁혀지면
   *   TS 가 「항상 비어 있다」로 단정해 발급 후 분기를 죽은 코드로 다룬다.
   */
  interstitialMain: 'ait.v2.live.XXXXXXXXXXXXXXXX' as string,
} as const;

export type AdSlotId = keyof typeof AD_IDS;
export type RewardSlotId = 'rewardTopup' | 'rewardTraderView' | 'rewardSeasonExtend' | 'rewardAttendance';
export type InterstitialSlotId = 'interstitialMain';
/** ⛔배너가 «아닌» 지면(리워드·전면)은 여기서 빠진다 — 안 빼면 `AD_RESERVED_H` 가 배너 아닌 것의 높이를 요구한다 */
export type BannerSlotId = Exclude<AdSlotId, RewardSlotId | InterstitialSlotId>;

/**
 * 지면별 «예약 높이»(px). 광고가 뜨기 전에도 이 높이를 미리 잡아 두어야
 * 리스트 스크롤 중 레이아웃 시프트(CLS)·스크롤 점프가 안 난다.
 * NATIVE_IMAGE 는 이미지가 들어가 NORMAL 보다 세로를 더 먹는다.
 *
 * ★★이 값의 «지위»를 정직하게 적어 둔다 (2026-08-21):
 *   · [실측] 예약 상자 자체의 렌더 높이 — `ads.preview` 모드 실렌더로 잰다.
 *     NATIVE_IMAGE 5종은 전부 116, NORMAL 3종은 전부 72 로 «같은 포맷은 같은 값»이다.
 *   · [추정] «실제 토스 광고»의 렌더 높이 — ⛔로컬에서 잴 수 없다.
 *     SDK 는 토스 앱 안에서만 살고, 운영 ID 로 로컬 실렌더를 시도하는 것은 계정 중단 사유다.
 *     SDK 타입(`AttachBannerOptions`)에도 크기 정보가 없다.
 *     ⇒ 근거는 «동일 포맷 선례»뿐이다: 116 은 bannerLeaderboard·bannerStocks·
 *       bannerTraderProfile 3종이 이미 라이브에서 쓰고 있는 값이다.
 *   ⚠️어긋나면 어떻게 되나: `AdBanner` 는 `minHeight` 라 «잘리지는» 않고 «자란다».
 *     문제는 `VirtualList` 쪽이다 — `insertHeight` 로 좌표를 «계산»하므로
 *     실제 광고가 116 보다 크면 그만큼 스크롤 좌표가 어긋난다(일지·종목목록).
 *     ⇒ 폰 실기기에서 광고가 뜬 화면을 보면 «가장 먼저» 확인할 것.
 */
export const AD_RESERVED_H: Record<BannerSlotId, number> = {
  bannerHome: 72,
  bannerLeaderboard: 116,
  bannerStocks: 116,
  bannerTraderProfile: 116,
  bannerSettings: 72,
  bannerRechargeDone: 72,
  bannerJournal: 116,
  bannerStockDetail: 116,
};

/**
 * ★`.adslot` 상자가 «호스트 영역보다 더» 쓰는 세로 길이(px).
 *   「광고」 라벨 19 + flex gap 4 = 23. (좌우 0 · 상하 패딩 18 은 `AdBanner` 가
 *   호스트 minHeight 를 `h - 18` 로 잡을 때 이미 계산에 들어가 있다)
 *
 * ★[2026-08-21 실렌더 실측] `.adslot` 실제 높이 = 139px (= 116 + 23).
 *   min-height 116 은 «닿지 않는다» — 즉 `AD_RESERVED_H` 는 «상자 높이»가 아니다.
 */
export const AD_BOX_EXTRA_H = 23;

/**
 * ★배너 블록이 목록에서 «실제로 차지하는» 세로 길이. `VirtualList.insertHeight` 전용.
 *
 * ⚠★[2026-08-21 실측으로 발견한 기존 결함] 옛 호출부는 `AD_RESERVED_H + 40` 을 넘겼다.
 *   실제 점유는 139(상자) + 10 + 10(여백) = ★159px 인데 156 을 넘기고 있었다 — ★3px 부족.
 *   근거: 일지 20행 실렌더에서 «행 간격»이 정상 83 / 삽입 지점 242 였다(242 − 83 = 159).
 *   ★삽입이 1개라 눈에 안 보였다. 그런데 이 프로젝트가 반복해서 데인 형태가 정확히
 *     「에러가 안 나고 그림만 조용히 어긋나는 것」이다(V-2 ⛔2 캔들 MA).
 *     삽입 개수가 늘면 오차도 «개수만큼» 곱해진다.
 * ⇒ ★이제 «유도»한다. 라벨·패딩·여백을 바꾸면 여기 한 곳만 고치면 된다.
 *   `scripts/verify_adslots.py` 가 매 실행마다 «실렌더 점유 높이»와 이 값을 대조한다.
 *
 * @param reservedH 지면 예약높이(`AD_RESERVED_H[slot]`)
 * @param marginY   호출부가 `AdBanner` 에 준 상하 여백(한쪽 값)
 */
export function adBlockH(reservedH: number, marginY: number): number {
  return reservedH + AD_BOX_EXTRA_H + marginY * 2;
}

/**
 * ★지면 ID 가 «실제로 있는가». 빈 값(미발급)이면 그 지면은 존재하지 않는 것으로 다룬다.
 * ⛔빈 문자열로 SDK 를 부르면 조용히 실패한다 — 「호출은 했다」가 「지면이 있다」가 되면 안 된다.
 */
export function hasPlacement(slot: AdSlotId): boolean {
  return AD_IDS[slot].length > 0;
}


/**
 * ★지면이 «지금 이 환경에서 실제로 그려지는가».
 *
 * ★★왜 필요한가 [2026-08-21 실측으로 발견한 기존 결함]:
 *   `VirtualList` 는 광고 자리 높이를 «미리» 잡는다(스크롤 점프 방지). 그런데
 *   토스 «밖»(itch.io · GitHub Pages · MS Store 래핑 · 로컬)에서는 `AdBanner` 가
 *   ★아무것도 그리지 않는다 — 그러면 종목 목록 한가운데에 ★156px 짜리 «빈 구멍»이 남는다.
 *   토스 밖은 이 앱의 «정상 경로»다. 즉 그 구멍은 실제 유저가 본다.
 *   ⇒ 호출부는 이 함수로 «그려질 때만» 자리를 잡는다.
 */
export function adSlotVisible(slot: BannerSlotId): boolean {
  return adPreviewMode() || (bannerSupported() && hasPlacement(slot));
}

/* ── 종목 목록 «반복» 지면 ───────────────────────────────────────────── */
/**
 * ★★배열 «길이»가 곧 반복 횟수다. ⛔같은 ID 를 두 번 넣지 마라.
 *
 * 근거(2026-08-21 문서 조회):
 *  · 앱인토스 광고 정책 — 「동일 화면에 동일 포맷 광고를 2개 이상 배치하는 행위는 금지」
 *  · 구글 AdMob — 「지면마다 «고유한» 광고 단위 ID 를 만들라(같은 포맷이라도)」
 * ⇒ 반복 노출을 늘리려면 ★지면을 «더 발급»해서 여기 줄을 더해야 한다.
 *   지면 발급은 콘솔 권한(되돌리기 어려운 행동)이라 Partner 승인 사항이다.
 *   ★화면 코드는 이 배열만 읽는다 — 발급되면 여기 한 줄이 전부다.
 */
export const STOCKS_BANNER_SLOTS: BannerSlotId[] = ['bannerStocks'];
/*
 * ★★[2026-08-21 확정 — Partner 원문 확인] ⛔원소를 늘리지 마라.
 *   금지 기준은 «지면 ID» 가 아니라 ★«화면 × 포맷» 이다:
 *     「동일 화면에 동일 포맷 광고를 2개 이상 배치하는 경우」 — 금지
 *      (developers-apps-in-toss.toss.im/guide/monetization/in-app-ad)
 *   ⇒ 종목 목록은 «한 화면»이므로 ID 를 3개로 늘려도 BANNER 3개 = 위반이다.
 *     ID 추가는 위반을 «가능하게» 할 뿐 «합법화» 하지 않는다.
 *   ⇒ 노출을 늘리려면 «한 화면에 여러 개»가 아니라 ★«지면이 없는 화면»을 채운다
 *     (그래서 bannerStockDetail 을 새로 넣었다).
 * ★아래 반복 삽입 기능(VirtualList 이분탐색 좌표)은 «켜지 않은 채로» 남긴다 —
 *   정책이 바뀌면 이 배열 한 줄로 켜진다.
 */

/**
 * 반복 «간격»(행 수). ⛔추측이 아니라 계산이다.
 *
 *   종목 행 높이 63px · 광고 블록 = 예약높이 116 + 상하 여백 40 = 156px
 *   폰 세로 가시높이 ≈ 710px (President 기기 실측 기준)
 *   ⇒ 광고 사이에 «한 화면 이상» 두려면  n × 63 + 156 ≥ 710  →  n ≥ 8.8
 *   ⇒ 12 행이면 12 × 63 + 156 = 912px — 한 화면(710)보다 넉넉히 넓다.
 * ★이 여백이 정책상 중요한 이유: 간격이 화면보다 좁으면 «같은 화면에 광고 2개»가
 *   실제로 동시에 보인다(위 STOCKS_BANNER_SLOTS 주석의 금지 사항).
 */
export const STOCKS_AD_EVERY = 12;

/**
 * 반복 지면의 «예약 높이». ★전부 같은 값이어야 한다 —
 * 가상 스크롤은 삽입 높이를 «하나»로 계산하므로 지면마다 높이가 다르면 좌표가 어긋난다.
 * ⇒ 다르면 개발 중에 «소리내어» 알린다(조용히 어긋나는 게 가장 나쁘다).
 */
export function stocksAdReservedH(): number {
  const hs = STOCKS_BANNER_SLOTS.map((s) => AD_RESERVED_H[s]);
  if (new Set(hs).size > 1) console.error('[ads] STOCKS_BANNER_SLOTS 의 예약 높이가 서로 다르다', hs);
  return hs[0] ?? 0;
}

/* ── 지원 여부 ───────────────────────────────────────────────────────── */

function safeIsSupported(fn: { isSupported?: () => boolean } | undefined): boolean {
  try {
    return isInToss() && typeof fn?.isSupported === 'function' && fn.isSupported() === true;
  } catch {
    return false;
  }
}

/** 배너를 붙일 수 있는가 (토스 앱 안 + SDK 지원) */
export function bannerSupported(): boolean {
  return safeIsSupported(TossAds?.attachBanner);
}

/** 리워드 광고를 돌릴 수 있는가 */
export function rewardedSupported(): boolean {
  return safeIsSupported(GoogleAdMob?.loadAppsInTossAdMob) && safeIsSupported(GoogleAdMob?.showAppsInTossAdMob);
}

/**
 * 로컬 검증용 «자리만» 미리보기.
 * ⛔운영 광고 ID 를 로컬에서 실렌더하는 것은 계정 중단 사유다. 그래서 이 플래그는
 * SDK 를 «호출하지 않고» 예약 높이와 라벨만 그린다 — 레이아웃/CLS 검증 전용.
 *   sessionStorage.setItem('ads.preview', '1')
 */
export function adPreviewMode(): boolean {
  try {
    return window.sessionStorage.getItem('ads.preview') === '1';
  } catch {
    return false;
  }
}

/* ── 배너 ────────────────────────────────────────────────────────────── */

/*
 * ★★[2026-09-10 · -33] 배너 «요청 규율» — 「요청은 보일 때 1회」 (President 직접 질의: 시청률 10.5%)
 *
 * ── 실측으로 잡은 원인 (web-bridge 2.10.8 + SpaceKit 3.1.0 소스 · scripts/probe_ads_requests.py) ──
 *   · `TossAds.attachBanner` → SpaceKit `createSlot({autoLoad:true})` → BannerSlot 생성자에서 «즉시» load()
 *     ⇒ ★광고 «요청»은 부착(마운트) 시점에 나간다. 뷰포트 위치와 무관.
 *   · 노출(IMP_1PX)은 `BaseAdType.onVisibilityRatioChange(ratio > 0)` — ★«1px 이상 실제로 보인 순간».
 *   · 이 앱의 배너는 정책상 전부 «첫 화면 밖»이다(홈 offsetTop≈1,542 · 종목상세 1,089 · 설정 858 · 랭킹 1,424 …).
 *     ⇒ 스크롤하지 않은 방문은 «요청 1 · 노출 0». 콘솔 요청 19,369 → 노출 2,033 (7일) 의 구조적 원인.
 *   · 그리고 옛 `ensureInit()` 은 SDK 스크립트 «비동기 로드»를 기다리지 않고 동기 attach 를 불렀다 →
 *     콜드 스타트 첫 배너는 web-bridge 가 throw(캐치됨) 해 «요청조차 안 나갔다» [BEFORE32 실측: 콜드 홈 요청 0].
 *
 * ── 규율 (AdBanner 한 곳 = 전 지면 공통) ──
 *   ① IntersectionObserver 로 «처음 교차한 순간» + 문서 visible + SDK init 완료 → attach 1회.
 *   ② 문서 hidden 중 요청 0 — visible 복귀 때 교차 중이면 그때 1회.
 *   ③ 한 마운트에 attach 1회(리렌더 잠금). 언마운트 = IO 해제·대기 취소·slot destroy.
 *   ④ 자동 새로고침 0. no-fill 은 재시도하지 «않는다» — 재시도는 요청만 늘려 시청률(노출/요청)을 낮춘다.
 *   ⑤ «오류»(네트워크·타임아웃·init) 만 30→60→120초 백오프로 최대 3회 재시도, 그것도 교차 중 + visible 일 때만.
 *   ⚠SDK 자체 재로드(응답 ext.refetchSeconds 기반 hidden→visible 재요청)는 attachBanner 옵션으로 못 막는다 — [한계].
 */

/** SpaceKit 로더 자체 타임아웃(15초)보다 조금 길게 — 그 뒤엔 실패로 본다 */
const INIT_TIMEOUT_MS = 20_000;
let initReady: Promise<boolean> | null = null;

/**
 * ★SDK 초기화 «완료»를 기다린다. web-bridge `initialize` 는 SpaceKit 스크립트를 비동기로 내려받고
 *   `onInitialized` 로 알린다. 같은 Promise 를 공유하므로 배너 여러 개가 동시에 기다려도 init 는 한 번이다.
 *   실패하면 캐시를 비워 다음 배너가 다시 시도한다. ⛔절대 throw 하지 않는다.
 */
export function ensureInitReady(): Promise<boolean> {
  if (initReady) return initReady;
  const p = new Promise<boolean>((resolve) => {
    if (!safeIsSupported(TossAds?.initialize)) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), INIT_TIMEOUT_MS);
    try {
      TossAds.initialize({
        callbacks: {
          onInitialized: () => finish(true),
          onInitializationFailed: (e) => {
            console.warn('[ads] initialize failed', e);
            finish(false);
          },
        },
      });
    } catch (e) {
      console.warn('[ads] initialize threw', e);
      finish(false);
    }
  });
  initReady = p;
  void p.then((ok) => {
    if (!ok && initReady === p) initReady = null;
  });
  return p;
}

type AttachOpts = NonNullable<Parameters<typeof TossAds.attachBanner>[2]>;
export type BannerCallbacks = NonNullable<AttachOpts['callbacks']>;

/**
 * 배너 부착(SDK 호출 그 자체). 실패해도 절대 throw 하지 않고 no-op cleanup 을 돌려준다.
 * ★init 대기·가시성 판정은 `mountBannerSlot` 이 한다 — 이 함수는 «지금 당장 붙여라»다.
 */
export function attachBanner(
  slot: BannerSlotId,
  el: HTMLElement,
  theme: 'light' | 'dark',
  callbacks?: BannerCallbacks,
  /**
   * ★SDK 가 «던졌을 때» 알리는 구멍. ⛔이 함수의 계약(절대 throw 안 함)은 그대로 두되,
   *   실패를 «삼키지는» 않는다 — 삼키면 호출부가 「요청했다」로 굳고 재시도도 계측도 없다
   *   [2026-09-10 Codex 리뷰 시뮬레이션 ATTACH_THROW: states ['waiting','requested'] · fail 이벤트 0].
   */
  onAttachError?: (reason: string) => void
): () => void {
  if (!bannerSupported() || !hasPlacement(slot)) return () => {};
  try {
    const r = TossAds.attachBanner(AD_IDS[slot], el, { theme, variant: 'card', callbacks });
    return () => {
      try {
        r?.destroy?.();
      } catch {
        /* ignore */
      }
    };
  } catch (e) {
    console.warn('[ads] attachBanner failed', slot, e);
    onAttachError?.('attach-threw');
    return () => {};
  }
}

/** 배너 슬롯 상태 — 하네스가 `data-ad-state` 로 읽는다. 레이아웃엔 영향 없음 */
export type BannerSlotState = 'waiting' | 'requested' | 'loaded' | 'shown' | 'nofill' | 'failed' | 'retry-wait';

/** ★«오류» 재시도 백오프. no-fill 에는 쓰지 않는다(위 규율 ④). 검사기가 이 표를 그대로 읽는다 */
export const BANNER_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
export function bannerRetryDelay(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < BANNER_RETRY_DELAYS_MS.length ? BANNER_RETRY_DELAYS_MS[attempt] : null;
}

/** SDK 오류를 계측용 사유 한 단어로. 코드는 web-bridge ERROR_CODES(1001 네트워크 · 1008/1013 타임아웃 · 1007 init …) */
export function bannerFailReason(err: { code?: number; message?: string } | undefined): string {
  const code = err?.code ?? 0;
  const msg = (err?.message ?? '').toLowerCase();
  if (code === 1001) return 'network';
  if (code === 1008 || code === 1013) return 'timeout';
  if (code === 1007 || msg.includes('initialize')) return 'init';
  if (code === 1002 || code === 1005) return 'invalid';
  if (code === 1012 || code === 1014 || code === 1015) return 'blocked';
  if (code === 1003) return 'no_fill';
  return code ? `render_${code}` : 'unknown';
}

/*
 * ── ★슬롯 «주차»(park) — 같은 화면 안 «재마운트»에 재요청하지 않기 위해 ────────────────────
 *   [실측 2026-09-10 verify_ads33] 종목 목록에서 필터 칩을 100번 누르자 배너가 «7번» 다시 요청됐다.
 *   원인: VirtualList 가 목록 길이에 따라 삽입 행을 «행 안 ↔ 꼬리»로 옮겨 그리고, 스크롤로 overscan 을 벗어나도
 *   AdBanner 가 언마운트→재마운트된다. 재마운트 = 새 attach = 새 요청(보이는 자리라 헛요청은 아니지만 「화면당 1회」가 아니다).
 *   ⇒ 언마운트 때 광고 DOM(web-bridge 가 만든 wrapper 이하)을 «떼어 보관»하고, PARK_GRACE_MS 안에 같은 지면이
 *     다시 마운트되면 새 호스트에 «옮겨 붙인다». SDK slot(IO·클릭·이벤트)은 element 에 묶여 있어 부모가 바뀌어도 살아 있다.
 *   유예가 지나면(= 화면을 떠난 것) destroy 한다. 화면을 나갔다 «다시 들어오면» 예전처럼 새 요청 1회다.
 */
/**
 * ★주차 유예. 「같은 화면 안 재마운트」와 「진짜 화면 이탈」을 가르는 «유일한» 값이다.
 *
 * ★[2026-09-12] Codex 2차 리뷰 5번은 이 값을 「방문 식별자로 바꾸라」고 했다 — **기각**했다. 이유:
 *   ① 이 앱은 지면이 «화면마다 다르다»(bannerHome·bannerStocks…). 「다른 화면에 갔다 온다」는
 *      곧 «다른 슬롯»이라, 방문 식별자를 넣어도 판정이 달라지는 경우가 사실상 없다.
 *   ② 500ms 만에 돌아온 경우를 「새 방문」으로 세면, 광고 DOM 이 «살아 있는 채로» 다시 요청된다.
 *      그건 이번 파도가 실측으로 없앤 헛요청(종목목록 재마운트 7 → 0)을 그대로 되살리는 방향이다.
 *   ③ 1,501ms 재마운트가 요청 2회인 것은 «의도»다 — 유예를 넘겼으면 광고는 이미 파괴됐다.
 *   ⇒ 대신 그 경계를 검사로 못 박았다(check_interstitial §⑩ R2·R6). 우연이 아니라 «정해 둔 값»이다.
 */
export const PARK_GRACE_MS = 1_500;
interface ParkedSlot {
  holder: HTMLDivElement;
  destroySlot: () => void;
  /**
   * 콜백이 «현재» 컨트롤러로 흘러가는 구멍. 옮겨 붙이면 새 컨트롤러가 이 자리를 넘겨받는다.
   * ★[2026-09-12 · Codex 리뷰 4번] `set`(상태)만 승계하고 `fail`(실패 처리)을 승계하지 않았더니,
   *   주차→회수 뒤 오류가 오면 **계측 0회·재시도 타이머 0개**였고 상태는 'loaded' 로 굳었다.
   *   ⇒ 실패도 같은 구멍으로 보낸다. 둘을 따로 두면 언젠가 또 한쪽만 승계한다.
   */
  sink: { set: (s: BannerSlotState) => void; fail: (reason: string) => void };
  state: BannerSlotState;
  timer: number;
}
const parkedSlots = new Map<BannerSlotId, ParkedSlot>();

/*
 * ── ★실패 «쿨다운»은 컨트롤러가 아니라 «지면»에 붙는다 ────────────────────────────────
 *   [2026-09-10 Codex 리뷰 시뮬레이션 RECLAIM_RETRY_WAIT] 백오프 대기 중에 언마운트(주차)되면
 *   그 컨트롤러의 타이머가 clearTimeout 으로 사라져 ★재시도가 영영 안 왔다(상태만 'retry-wait' 로 굳음).
 *   반대로 「실패했으니 그냥 destroy」로 두면 재마운트가 곧 «즉시 재요청»이 되어 백오프가 무력화된다.
 *   ⇒ 「이 지면은 언제부터 다시 시도해도 되는가」를 모듈에 둔다. 컨트롤러가 죽고 살아도 규율이 유지된다.
 *   ★성공(로드·노필)하면 지운다 — 다음 실패는 처음(30초)부터.
 */
interface BannerCooldown {
  /** 이 시각 전에는 attach 하지 않는다(ms · nowMs 기준) */
  until: number;
  /** 다음 백오프 단계(0 → 30s, 1 → 60s, 2 → 120s, 3 → 포기) */
  attempt: number;
}
const bannerCooldowns = new Map<BannerSlotId, BannerCooldown>();

function parkSlot(slot: BannerSlotId, host: HTMLElement, p: Omit<ParkedSlot, 'holder' | 'timer'>): void {
  const prev = parkedSlots.get(slot);
  if (prev) {
    window.clearTimeout(prev.timer);
    try {
      prev.destroySlot();
    } catch {
      /* ignore */
    }
  }
  const holder = document.createElement('div');
  while (host.firstChild) holder.appendChild(host.firstChild);
  const timer = window.setTimeout(() => {
    const cur = parkedSlots.get(slot);
    if (cur && cur.holder === holder) {
      parkedSlots.delete(slot);
      try {
        cur.destroySlot();
      } catch {
        /* ignore */
      }
    }
  }, PARK_GRACE_MS);
  parkedSlots.set(slot, { ...p, holder, timer });
}

function reclaimSlot(slot: BannerSlotId, host: HTMLElement): ParkedSlot | null {
  const p = parkedSlots.get(slot);
  if (!p) return null;
  parkedSlots.delete(slot);
  window.clearTimeout(p.timer);
  while (p.holder.firstChild) host.appendChild(p.holder.firstChild);
  return p;
}

/**
 * ★배너 슬롯 «컨트롤러» — AdBanner 가 마운트 1회에 하나 만든다. 위 규율 ①~⑤ 를 전부 여기서 지킨다.
 *
 * @param host   광고가 들어갈 호스트 요소(.adslot__host). IO 는 이 요소를 본다(예약 높이가 있어 0px 가 아니다)
 * @param onState 상태 변화 알림(화면은 `data-ad-state` 로만 쓴다)
 * @returns dispose — 언마운트 때 «반드시» 부른다
 */
export function mountBannerSlot(
  slot: BannerSlotId,
  host: HTMLElement,
  theme: 'light' | 'dark',
  onState?: (s: BannerSlotState) => void
): { dispose: () => void } {
  let disposed = false;
  /** ★리렌더·중복 잠금 — 한 마운트에 attach 1회 */
  let attached = false;
  let intersecting = false;
  let destroySlot: (() => void) | null = null;
  let retryTimer: number | null = null;
  let io: IntersectionObserver | null = null;
  let lastState: BannerSlotState = 'waiting';

  const visible = () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  const set = (s: BannerSlotState) => {
    lastState = s;
    if (!disposed) onState?.(s);
  };
  /**
   * SDK 콜백이 상태를 흘려보내는 «구멍». 주차→회수 뒤에는 새 컨트롤러의 set 으로 바뀐다.
   * ⛔주차할 때는 «이 객체 그대로» 넘긴다 — 회수할 때마다 새 객체를 넘기면 콜백이 참조하는 옛 sink 와 끊긴다
   *   [2026-09-10 Codex 리뷰 시뮬레이션 SECOND_RECLAIM_CALLBACK: 세 번째 컨트롤러에 'loaded' 가 안 왔다].
   */
  let mySink: ParkedSlot['sink'] = { set, fail: (reason) => onFail(reason) };

  const clearRetryTimer = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** 지면 쿨다운이 끝나는 시각까지 남은 ms. 0 이면 지금 시도해도 된다 */
  const cooldownLeft = (): number => {
    const cd = bannerCooldowns.get(slot);
    return cd ? Math.max(0, cd.until - nowMs()) : 0;
  };

  const onFail = (reason: string) => {
    if (disposed) return;
    noteAd('banner', slot, 'fail', { reason });
    set('failed');
    const cd = bannerCooldowns.get(slot);
    const attempt = cd ? cd.attempt : 0;
    const delay = bannerRetryDelay(attempt);
    if (delay === null) {
      /* 3회를 다 썼다 — 이 지면은 이번 실행에서 포기한다(요청을 더 늘리지 않는다) */
      bannerCooldowns.set(slot, { until: Number.POSITIVE_INFINITY, attempt: attempt + 1 });
      return;
    }
    bannerCooldowns.set(slot, { until: nowMs() + delay, attempt: attempt + 1 });
    set('retry-wait');
    armRetry();
  };

  /** 쿨다운이 끝나는 시각에 «한 번» 깨어나도록 타이머를 건다. ⛔중복으로 걸지 않는다(타이머 누수 방지) */
  const armRetry = () => {
    if (disposed) return;
    clearRetryTimer();
    const left = cooldownLeft();
    if (!Number.isFinite(left)) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      tryRetry();
    }, left);
  };

  const doAttach = async () => {
    set('waiting');
    const ok = await ensureInitReady();
    if (disposed) return;
    if (!ok) {
      onFail('init');
      return;
    }
    /* init 을 기다리는 동안 숨겨졌거나 화면 밖으로 나갔으면 «잠금을 풀고» 다시 조건을 기다린다 — 안 보이는 요청 0 */
    if (!visible() || !intersecting) {
      attached = false;
      return;
    }
    noteAd('banner', slot, 'req', { h0: host.getBoundingClientRect().height === 0 });
    set('requested');
    /** 응답이 «왔다» — 실패 쿨다운을 푼다(다음 실패는 30초부터 다시 센다) */
    const settled = () => bannerCooldowns.delete(slot);
    /* ⛔콜백은 `set` 이 아니라 `mySink.set` 을 부른다 — 주차·회수 뒤 새 컨트롤러가 상태를 이어받는다 */
    destroySlot = attachBanner(
      slot,
      host,
      theme,
      {
        onAdRendered: (p) => {
          settled();
          noteAd('banner', slot, 'load', { rid: p?.adMetadata?.requestId });
          mySink.set('loaded');
        },
        onAdImpression: (p) => {
          noteAd('banner', slot, 'shown', { rid: p?.adMetadata?.requestId });
          mySink.set('shown');
        },
        onAdViewable: (p) => noteAd('banner', slot, 'viewable', { rid: p?.adMetadata?.requestId }),
        onNoFill: () => {
          /* ★재시도 없음 — 네트워크가 «없다»고 답한 것이다. 다시 물으면 요청만 늘고 노출은 그대로다 */
          settled();
          noteAd('banner', slot, 'nofill');
          mySink.set('nofill');
        },
        /* ⛔`onFail` 을 «직접» 부르지 마라 — 주차·회수 뒤에는 이미 dispose 된 옛 컨트롤러다(Codex 리뷰 4번) */
        onAdFailedToRender: (p) => mySink.fail(bannerFailReason(p?.error)),
      },
      /* ★SDK 가 던진 경우 — 예전엔 조용히 'requested' 로 굳었다(Codex ATTACH_THROW) */
      (reason) => mySink.fail(reason)
    );
  };

  const maybeAttach = () => {
    if (disposed || attached || !intersecting || !visible()) return;
    /* ★실패 쿨다운 중이면 붙지 않는다 — 주차·재마운트로 컨트롤러가 바뀌어도 백오프가 유지된다 */
    if (cooldownLeft() > 0) {
      set('retry-wait');
      armRetry();
      return;
    }
    attached = true;
    void doAttach();
  };

  const tryRetry = () => {
    if (disposed) return;
    /*
     * ★★「재시도가 실제로 밀려 있을 때」만 다시 붙인다.
     *   [실측 2026-09-10 verify_ads33 23항 FAIL] 이 조건이 없던 판은, IO 재교차·visible 복귀가
     *   그때마다 tryRetry 를 불러 «정상 배너까지» 죽이고 다시 요청했다 —
     *   홈 스크롤 왕복 5회 = 요청 6 · 재진입마다 +1 · 종목목록 15.
     *   지면 쿨다운은 응답(load·nofill)이 오면 지워지므로 「쿨다운 0 = 지금 붙여도 된다」가
     *   「지금 «다시» 붙여야 한다」로 잘못 읽힌 것이다. 상태로 못을 박는다.
     */
    if (lastState !== 'failed' && lastState !== 'retry-wait') return;
    const cd = bannerCooldowns.get(slot);
    if (!cd) return;
    if (cooldownLeft() > 0) {
      /* 아직 이르다 — 끝나는 시각에 «한 번» 깨우도록 다시 걸어둔다(주차→회수로 타이머를 잃은 컨트롤러 구제) */
      armRetry();
      return;
    }
    /* ★숨김·화면 밖에서는 재시도 0 — 조건이 되면 그때(onVis / IO 콜백이 다시 부른다) */
    if (!intersecting || !visible()) return;
    clearRetryTimer();
    try {
      destroySlot?.();
    } catch {
      /* ignore */
    }
    destroySlot = null;
    attached = false;
    maybeAttach();
  };

  /*
   * ★SDK «초기화»(스크립트 로드 + init)는 광고 «요청»이 아니다 — 마운트 때 미리 데운다.
   *   그래야 배너가 «보이는 순간» 로드·init 을 기다리지 않고 바로 붙는다(스크롤이 지나가기 전에 노출로 이어지게).
   *   [실측 2026-09-10 verify_ads33 대조] 이 줄이 없으면 첫 배너가 보일 때까지 SDK 자체가 안 떠 있었다.
   *   요청(attach → createSlot → load)은 여전히 아래 IO 교차 + visible 조건에서만 나간다.
   */
  void ensureInitReady();

  /*
   * ★같은 지면이 유예 안에 다시 마운트됐다 — 광고 DOM 을 옮겨 붙이고 «요청하지 않는다».
   * ⛔이 블록은 `onFail`·`armRetry` «정의 뒤»에 있어야 한다 — sink 에 그 둘을 꽂기 때문이다.
   */
  const re = reclaimSlot(slot, host);
  if (re) {
    attached = true;
    destroySlot = re.destroySlot;
    /* ★콜백이 이미 가리키고 있는 sink 를 «물려받아» 내 set·fail 을 꽂는다(새 객체를 만들지 않는다) */
    mySink = re.sink;
    mySink.set = set;
    mySink.fail = onFail;
    noteAd('banner', slot, 'reuse');
    set(re.state);
  }

  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) intersecting = e.isIntersecting || e.intersectionRatio > 0;
        if (intersecting) {
          maybeAttach();
          tryRetry();
        }
      },
      { threshold: 0 }
    );
    io.observe(host);
  } else {
    /* IO 가 없는 구형 WebView — 옛 동작(마운트 즉시)으로 떨어진다. 요청이 안 나가는 것보다 낫다 */
    intersecting = true;
    maybeAttach();
  }
  const onVis = () => {
    if (visible()) {
      maybeAttach();
      tryRetry();
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);

  return {
    dispose: () => {
      disposed = true;
      io?.disconnect();
      io = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      clearRetryTimer();
      if (destroySlot && attached) {
        /* ★붙어 있던 광고는 바로 죽이지 않고 «주차» — 같은 화면 안 재마운트면 옮겨 붙여 재요청 0. 유예가 지나면 destroy.
           ⛔`mySink` 를 그대로 넘긴다(콜백이 참조하는 바로 그 객체다). 실패 백오프는 «지면» 쿨다운이 들고 있으므로 여기서 안 넘긴다. */
        parkSlot(slot, host, { destroySlot, sink: mySink, state: lastState });
      } else {
        try {
          destroySlot?.();
        } catch {
          /* ignore */
        }
      }
      destroySlot = null;
    },
  };
}

/* ── 리워드 광고 ─────────────────────────────────────────────────────── */

export type RewardResult =
  | { ok: true; unitType: string; unitAmount: number }
  /** 지원 안 함(웹·구버전) — 「내일 다시」 폴백으로 보내야 한다 */
  | { ok: false; reason: 'unsupported' }
  /** 로드 실패(노필·네트워크·타임아웃) */
  | { ok: false; reason: 'load-failed' }
  /** 노출 실패 */
  | { ok: false; reason: 'show-failed' }
  /** 끝까지 안 보고 닫음 — ★보상 없음이 «정상»이다 */
  | { ok: false; reason: 'abandoned' };

const LOAD_TIMEOUT_MS = 12_000;

/**
 * 리워드 광고 1회 실행. load → show → `userEarnedReward` 에서만 성공.
 *
 * ★보상 지급 조건을 여기 «한 곳»에만 둔다. 화면마다 복붙하면 한쪽에서만
 *   조건이 어긋나 「안 보고도 받는」 버그가 두 배로 난다(4번·6번 공통 로직).
 */
/**
 * ★리워드 광고가 «지금 돌고 있는가»(요청~닫힘). 전면 게이트가 이 값을 본다.
 *   [2026-09-12 Codex 리뷰 2번] 긴 리워드를 닫자마자 전면이 나가던 경로를 여기서 «먼저» 끊는다.
 */
let rewardedInFlight = false;

export function rewardedIsActive(): boolean {
  return rewardedInFlight;
}

export function runRewardedAd(
  slot: RewardSlotId,
  opts: {
    /**
     * ★노출 «직전»에 다시 묻는다. 문자열을 돌려주면 그 사유로 «틀지 않는다».
     *   [2026-09-12 Codex 리뷰 6번] 로드 6~12초 사이에 유저가 시트를 닫거나 다른 화면으로 가도
     *   옛 판은 그대로 전면에 광고를 띄웠다 — 부르지도 않은 광고가 갑자기 뜨는 것과 같다.
     */
    canShow?: () => string | null;
  } = {}
): Promise<RewardResult> {
  if (!rewardedSupported()) return Promise.resolve({ ok: false, reason: 'unsupported' });

  const adGroupId = AD_IDS[slot];
  /* ★[-33] 계측: 요청은 SDK 호출 «직전»에 센다. 선택형이라 버튼을 누른 뒤에만 여기 온다(프리로드 0 = 요청≈노출) */
  noteAd('rewarded', slot, 'req');
  rewardedInFlight = true;
  return new Promise<RewardResult>((resolve) => {
    let settled = false;
    let didShow = false;
    let cleanupLoad: (() => void) | undefined;
    let cleanupShow: (() => void) | undefined;
    let reward: { unitType: string; unitAmount: number } | null = null;

    /** @param why 실패 «사유»(계측용). RewardResult 의 reason 은 화면 문구용이라 그대로 둔다 */
    const finish = (r: RewardResult, why?: string) => {
      if (settled) return;
      settled = true;
      rewardedInFlight = false;
      /* ★「리워드 직후 60초」를 «닫힌 시각»부터 센다 — 광고를 보는 동안 60초가 지나가면 안 된다 */
      if (didShow) markRewardedShown();
      window.clearTimeout(timer);
      try {
        cleanupLoad?.();
      } catch {
        /* ignore */
      }
      try {
        cleanupShow?.();
      } catch {
        /* ignore */
      }
      if (r.ok) noteAd('rewarded', slot, 'reward');
      else if (r.reason === 'abandoned') noteAd('rewarded', slot, 'abandon');
      else noteAd('rewarded', slot, 'fail', { reason: why ?? r.reason });
      resolve(r);
    };

    const timer = window.setTimeout(() => finish({ ok: false, reason: 'load-failed' }, 'timeout'), LOAD_TIMEOUT_MS);

    const show = () => {
      /*
       * ★★노출 «직전» 재판정 (2026-09-12 · Codex 리뷰 6번).
       *   로드는 최대 12초다. 그 사이에 유저가 앱을 내리거나(hidden) 출석 시트를 닫고 다른 화면으로 갈 수 있다.
       *   [확인·SDK 모사] 옛 판은 그 상태에서도 show 를 1회 불렀다 — 안 보이는 화면에 노출이 세어지고,
       *   돌아왔을 때 «부르지도 않은» 광고가 떠 있다. 둘 다 유저에게는 사고다.
       */
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        noteAd('rewarded', slot, 'guard', { reason: 'hidden-at-show' });
        finish({ ok: false, reason: 'abandoned' }, 'hidden-at-show');
        return;
      }
      const veto = opts.canShow?.() ?? null;
      if (veto) {
        noteAd('rewarded', slot, 'guard', { reason: veto });
        finish({ ok: false, reason: 'abandoned' }, veto);
        return;
      }
      /* ★«노출»이 일어난 시각을 먼저 남긴다 — 앱이 그대로 죽어도 「봤다」는 남는다.
         닫힘 때 `finish` 가 «더 늦은» 시각으로 다시 찍는다(연속 광고 60초의 기준점). */
      didShow = true;
      markRewardedShown();
      /* ★계측: show «호출»(showReq) 과 SDK 의 impression(shown) 을 «갈라» 센다 — 호출 ≠ 노출(Codex 관찰 1) */
      noteAd('rewarded', slot, 'showReq');
      try {
        cleanupShow = GoogleAdMob.showAppsInTossAdMob({
          options: { adGroupId },
          onEvent: (e) => {
            if (e.type === 'userEarnedReward') {
              // SDK 가 준 보상 단위를 그대로 쓴다. 지면 설정을 코드에 다시 박지 않는다.
              reward = { unitType: e.data.unitType, unitAmount: e.data.unitAmount };
            } else if ((e as { type: string }).type === 'impression') {
              noteAd('rewarded', slot, 'shown');
            } else if (e.type === 'dismissed') {
              finish(reward ? { ok: true, ...reward } : { ok: false, reason: 'abandoned' });
            } else if (e.type === 'failedToShow') {
              finish({ ok: false, reason: 'show-failed' }, 'failedToShow');
            }
          },
          onError: () => finish({ ok: false, reason: 'show-failed' }, 'show-error'),
        });
      } catch {
        finish({ ok: false, reason: 'show-failed' }, 'show-threw');
      }
    };

    try {
      cleanupLoad = GoogleAdMob.loadAppsInTossAdMob({
        options: { adGroupId },
        onEvent: (e) => {
          if (e.type === 'loaded') {
            window.clearTimeout(timer);
            noteAd('rewarded', slot, 'load');
            show();
          }
        },
        onError: () => finish({ ok: false, reason: 'load-failed' }, 'network'),
      });
    } catch {
      finish({ ok: false, reason: 'load-failed' }, 'load-threw');
    }
  });
}

/* ── 전면(Interstitial) 광고 ─────────────────────────────────────────────
 *
 * ★★왜 «따로» 쓰는가 — 리워드와 계약이 다르다
 *   리워드: 유저가 «보상을 받으려고» 스스로 시작한다. 성공 = `userEarnedReward`.
 *   전면  : 유저가 «부르지 않았다». 화면 전환 사이에 우리가 끼운다.
 *           성공 = `dismissed`(닫힘)뿐이다 — 전면에는 `userEarnedReward` 가 ★없다.
 *   ⇒ 그래서 실패는 전부 ★«조용히» 넘긴다. 토스트도 띄우지 않는다.
 *     유저가 부르지 않은 것의 실패를 유저에게 사과할 이유가 없고,
 *     무엇보다 ⛔광고가 게임 흐름을 «막아서는» 안 된다.
 *
 * ★★토스 정책에서 명문으로 금지된 2건 (developers-apps-in-toss.toss.im
 *   /guide/monetization/in-app-ad) — 이 가드가 존재하는 «이유»다:
 *     (a) 앱 «진입 직후» 전면 노출        → `session-start`
 *     (b) 결제·계좌 등 «금융 흐름» 중 노출 → 삽입 지점을 그런 자리에 두지 않는 것으로 막는다
 *        (이 앱의 두 지점은 «가상» 자산 화면이고, 어느 쪽도 주문 버튼이 없는 «끝 화면»이다)
 *
 * ★그 위에 우리 스스로 씌우는 상한 3종 — 정책이 아니라 «유저 체감» 때문이다:
 *     하루 3회 / 직전 전면 후 10분 / 리워드 광고 직후 60초
 *   ⛔이 숫자를 늘리려면 노출 리포트를 «먼저» 보고, 이탈률과 같이 봐야 한다.
 */

/** 하루(KST 자정 기준) 전면 노출 상한 */
export const INTERSTITIAL_MAX_PER_DAY = 3;
/** 직전 «전면» 노출 이후 최소 간격 */
export const INTERSTITIAL_MIN_GAP_MS = 10 * 60_000;
/** 직전 «리워드» 노출 이후 최소 간격 — ⛔연속 광고(리워드 보고 나오자마자 전면) 금지 */
export const INTERSTITIAL_AFTER_REWARD_MS = 60_000;
/** 앱 진입 직후 «금지 구간». 토스 정책 (a) 를 코드로 막는다 */
export const INTERSTITIAL_MIN_SESSION_MS = 60_000;
/**
 * ★[2026-09-10 · -33] 세션 내 «N번째 완료된 거래»의 결과 화면에 전면 1회 (President 승인 전략 2-2).
 *
 *   «완료된 거래» = 되돌리기 창(UNDO_WINDOW_MS 5초)이 «되돌림 없이» 닫힌 주문(store.commitOrder → onExpire).
 *   ⛔시트가 닫히는 순간에 띄우지 않는다 — 확인창을 없앤 대가로 «반드시» 있어야 하는 5초 되돌리기를 광고가 가린다.
 *   ★가드는 «새로 만들지 않는다» — 기존 `runInterstitialAd`(60초·10분·일 3회·리워드 후 60초)를 그대로 지난다.
 *   ★세션당 정확히 «N번째» 한 번. 가드에 걸리면 재시도 없음(광고는 덜 나오는 편이 안전하다).
 *   ★전략의 되감기 스위치: 평균 세션이 변경 전보다 10% 넘게 줄면 이 값을 5 로 늦춘다(전략 원문).
 */
export const INTERSTITIAL_TRADE_NTH = 3;
/** ★순수 판정 — 「이번 완료 거래가 정확히 N번째인가」. 검사기가 그대로 부른다 */
export function tradeInterstitialDue(completedCount: number, nth: number = INTERSTITIAL_TRADE_NTH): boolean {
  return Number.isInteger(completedCount) && Number.isInteger(nth) && nth >= 1 && completedCount === nth;
}
/** 로드 대기 상한. ⛔리워드(12s)보다 «짧다» — 유저가 부른 광고가 아니라 흐름을 잡아둘 수 없다 */
const INTERSTITIAL_LOAD_TIMEOUT_MS = 6_000;

/** 전면 원장 저장 키. ⛔세션이 아니라 «기기»에 남아야 한다(앱을 껐다 켜도 하루 3회다) */
const INTERSTITIAL_LEDGER_KEY = 'ml.ads.interstitial';

/**
 * 전면 노출 원장. `localStorage` 한 곳에만 산다.
 * ⛔엔진 세이브(`ml.game`)에 넣지 마라 — 광고 노출 이력은 «게임 상태»가 아니다.
 *   세이브 마이그레이션에 얹히면 되돌리기 어려운 쪽에 광고가 묶인다.
 */
export type InterstitialLedger = {
  /** KST 날짜키. 바뀌면 count 가 0 으로 리셋된다 */
  dateKey: string;
  /** 오늘 «노출»된 전면 횟수 */
  count: number;
  /** 직전 «전면» 노출 시각(ms) */
  lastAt: number;
  /** 직전 «리워드» 노출 시각(ms) */
  lastRewardAt: number;
};

const EMPTY_LEDGER: InterstitialLedger = { dateKey: '', count: 0, lastAt: 0, lastRewardAt: 0 };

/** ★숫자가 아닌 값이 들어와도 게임이 멈추지 않게. 저장본은 언제든 손으로 망가질 수 있다 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/*
 * ── ★[2026-09-12 · -34] 원장은 «메모리가 먼저»다 (Codex 리뷰 3번) ─────────────────
 *   [확인·SDK 모사] `localStorage.setItem` 이 실패하면(시크릿 모드·용량 초과) 옛 판은 원장을
 *   계속 0 으로 읽어 ★같은 시각에 전면 4회가 통과했다. 하루 3회·10분 간격이 통째로 무력화된다.
 *   ⇒ ① 쓰기는 «메모리 거울»을 먼저 갱신한다 — 이번 실행 안에서는 저장이 죽어도 상한이 산다.
 *      ② 한 번이라도 영속에 실패했으면 그 뒤로는 전면을 «막는다»(`no-ledger`).
 *         재시작하면 기록이 사라져 상한을 다시 셀 수 없기 때문이다. 광고는 «덜 나오는» 쪽이 안전하다.
 *   ⛔메모리 거울을 「최신이 이긴다」로 만들지 마라 — 다른 탭·늦은 쓰기가 카운트를 «내릴» 수 있다.
 *     같은 날짜면 언제나 «큰 쪽·늦은 쪽»을 택한다(보수적 병합).
 */
let memLedger: InterstitialLedger | null = null;
let ledgerPersistOk = true;

/** 영속 저장이 «보장되는가». 한 번이라도 실패하면 false 로 굳는다(이번 실행 한정) */
export function interstitialLedgerPersistOk(): boolean {
  return ledgerPersistOk;
}

/**
 * ⛔검사기 전용 — 모듈 «런타임» 상태를 초기로 되돌린다. 앱 코드에서 부르지 마라.
 * ★정책을 «완화»하지 않는다. 한 프로세스에서 시나리오를 여러 개 돌릴 때
 *   앞 시나리오의 잠금·플래그가 다음 시나리오로 새는 것을 막을 뿐이다
 *   (실측: 로드가 영영 안 끝나는 가짜 리워드 1건이 뒤의 전면 검사 6항을 전부 `reward-active` 로 만들었다).
 */
export function __resetAdRuntimeStateForTest(): void {
  memLedger = null;
  ledgerPersistOk = true;
  rewardedInFlight = false;
  interstitialInFlight = false;
  /* ★주차된 광고와 지면 쿨다운도 비운다 — 앞 시나리오가 주차해 둔 슬롯을 다음 시나리오가 «회수»해
     「요청 0」이 되는 오염을 막는다(실측: R1 의 dispose 가 R2 의 첫 요청을 먹었다). */
  for (const p of parkedSlots.values()) {
    try {
      window.clearTimeout(p.timer);
      p.destroySlot();
    } catch {
      /* ignore */
    }
  }
  parkedSlots.clear();
  bannerCooldowns.clear();
}

function readStoredLedger(): InterstitialLedger {
  try {
    const raw = window.localStorage.getItem(INTERSTITIAL_LEDGER_KEY);
    if (!raw) return { ...EMPTY_LEDGER };
    const o = JSON.parse(raw) as Partial<InterstitialLedger>;
    return {
      dateKey: typeof o.dateKey === 'string' ? o.dateKey : '',
      count: Math.max(0, Math.floor(num(o.count))),
      lastAt: num(o.lastAt),
      lastRewardAt: num(o.lastRewardAt),
    };
  } catch {
    return { ...EMPTY_LEDGER };
  }
}

export function readInterstitialLedger(): InterstitialLedger {
  const stored = readStoredLedger();
  if (!memLedger) return stored;
  if (!memLedger.dateKey) return stored;
  /* 날짜가 다르면 «이번 실행이 쓴» 날짜를 믿는다 — 저장본이 어제 것일 수 있다 */
  if (memLedger.dateKey !== stored.dateKey) return { ...memLedger };
  return {
    dateKey: memLedger.dateKey,
    count: Math.max(memLedger.count, stored.count),
    lastAt: Math.max(memLedger.lastAt, stored.lastAt),
    lastRewardAt: Math.max(memLedger.lastRewardAt, stored.lastRewardAt),
  };
}

function writeInterstitialLedger(l: InterstitialLedger): void {
  /* ★먼저 메모리. 아래 저장이 던져도 이번 실행의 상한은 살아 있다 */
  memLedger = { ...l };
  try {
    window.localStorage.setItem(INTERSTITIAL_LEDGER_KEY, JSON.stringify(l));
  } catch {
    /* 시크릿 모드·용량 초과 — ⛔여기서 throw 하면 화면 전환이 막힌다.
       대신 「영속을 보장 못 한다」를 표시하고, 게이트가 그 뒤로 전면을 막는다 */
    ledgerPersistOk = false;
  }
}

/**
 * ★이 «세션»이 시작된 시각. 모듈이 처음 평가되는 순간 = 앱 진입이다.
 * ⛔`sessionStorage` 에 넣지 마라 — 새로고침으로 세션이 다시 시작돼도 그 값은 살아남아
 *   「진입 직후 금지」가 조용히 무력화된다. 메모리에 두는 것이 곧 「이번 실행」의 정의다.
 */
const SESSION_STARTED_AT = nowMs();

export type InterstitialBlock =
  /** SDK 미지원(토스 밖·구버전) */
  | 'unsupported'
  /** 지면 ID 미발급 — ⛔빈 ID 로 SDK 를 부르지 않는다 */
  | 'no-placement'
  /** 앱 진입 직후 — 토스 정책 명문 금지 */
  | 'session-start'
  /** 오늘 상한 도달 */
  | 'daily-cap'
  /** 직전 전면 이후 10분 미만 */
  | 'too-soon'
  /** 직전 리워드 «닫힘» 이후 60초 미만 — 연속 광고 금지 */
  | 'after-reward'
  /** ★리워드 광고가 «지금 돌고 있다» — 닫히기 전에는 전면을 준비조차 하지 않는다 */
  | 'reward-active'
  /** ★원장을 영속 저장하지 못했다 — 상한을 셀 수 없으므로 막는다 */
  | 'no-ledger';

export type InterstitialGate = { ok: true } | { ok: false; reason: InterstitialBlock };

/**
 * ★★빈도 «판정» — ⛔순수 함수다. SDK·localStorage·시계를 만지지 않는다.
 *
 * 그래서 `scripts/check_interstitial.mjs` 가 이 함수를 «그대로 불러» 표로 검증할 수 있다.
 * ⛔판정을 화면이나 `runInterstitialAd` 안에 다시 적지 마라 — 그러면 검사기가 보는 규칙과
 *   실제로 도는 규칙이 갈라진다(이 프로젝트가 반복해서 데인 형태).
 *
 * 우선순위는 «싼 것부터»: 환경 → 지면 → 정책(진입 직후) → 우리 상한.
 */
export function interstitialGateOn(
  led: InterstitialLedger,
  env: {
    hasId: boolean;
    supported: boolean;
    sessionStartedAt: number;
    /** ★리워드 광고가 «지금 화면에 떠 있는가». 옛 호출부 호환을 위해 없으면 false 로 본다 */
    rewardActive?: boolean;
    /** ★원장 영속이 보장되는가. 없으면 true(보장됨)로 본다 */
    ledgerOk?: boolean;
  },
  now: number,
  todayKey: string
): InterstitialGate {
  if (!env.supported) return { ok: false, reason: 'unsupported' };
  if (!env.hasId) return { ok: false, reason: 'no-placement' };
  /*
   * ★[2026-09-12 · -34] 리워드가 «돌고 있는 동안»에는 아예 시작하지 않는다 (Codex 리뷰 2번).
   *   [확인·SDK 모사] 61초짜리 리워드를 닫자마자 전면 load/show 가 각 1회 나갔다 —
   *   옛 판은 제한 시간을 리워드 «시작» 시각으로 쟀기 때문이다(60초가 광고 «보는 중»에 다 지나간다).
   *   ⇒ 토스 정책 「리워드 완료 직후 같은 화면 전면형 금지」 위반이다. 두 겹으로 막는다:
   *     ① 도는 중에는 `reward-active` ② 닫힘 시각부터 `after-reward` 60초(markRewardedShown 이 닫힘에 다시 찍는다).
   */
  if (env.rewardActive === true) return { ok: false, reason: 'reward-active' };
  /* ★원장을 못 쓰면 상한을 셀 수 없다 — 세지 못하는 상한은 없는 상한이다 */
  if (env.ledgerOk === false) return { ok: false, reason: 'no-ledger' };
  if (now - env.sessionStartedAt < INTERSTITIAL_MIN_SESSION_MS) return { ok: false, reason: 'session-start' };
  /* ★날짜가 바뀌었으면 오늘 카운트는 0 이다 — 원장을 «쓰지 않고» 판정만 한다(순수) */
  const todayCount = led.dateKey === todayKey ? led.count : 0;
  if (todayCount >= INTERSTITIAL_MAX_PER_DAY) return { ok: false, reason: 'daily-cap' };
  /* ★시계를 되돌리면 (now - lastAt) 가 음수다. 음수는 「아주 오래됐다」가 아니라
     「믿을 수 없다」로 다룬다 — 막는 쪽으로 기운다(광고는 덜 나오는 편이 안전하다). */
  if (led.lastAt > 0 && now - led.lastAt < INTERSTITIAL_MIN_GAP_MS) return { ok: false, reason: 'too-soon' };
  if (led.lastRewardAt > 0 && now - led.lastRewardAt < INTERSTITIAL_AFTER_REWARD_MS)
    return { ok: false, reason: 'after-reward' };
  return { ok: true };
}

/** 전면을 돌릴 수 있는가 (토스 앱 안 + SDK 지원). 리워드와 «같은» SDK 쌍을 쓴다 */
export function interstitialSupported(): boolean {
  return rewardedSupported();
}

/** 지금 이 자리에서 전면이 나갈 수 있는가 — 화면이 «미리» 물어볼 때 쓴다(버튼 문구 등) */
export function interstitialGate(slot: InterstitialSlotId, now: number = nowMs()): InterstitialGate {
  return interstitialGateOn(
    readInterstitialLedger(),
    {
      hasId: hasPlacement(slot),
      supported: interstitialSupported(),
      sessionStartedAt: SESSION_STARTED_AT,
      rewardActive: rewardedInFlight,
      ledgerOk: ledgerPersistOk,
    },
    now,
    kstDateKey(now)
  );
}

/**
 * ★리워드 광고 시각을 남긴다. `runRewardedAd` 가 «두 번» 부른다 — show 직전과 «닫힘» 때.
 *   · show 직전: 앱이 그대로 죽어 닫힘 이벤트가 안 와도 최소한 「봤다」는 남는다.
 *   · 닫힘: ★60초를 «닫힌 시각»부터 세게 한다. 61초짜리 광고를 보는 동안 60초가 다 지나버리는
 *     문제(Codex 리뷰 2번)는 이 두 번째 호출이 없으면 못 고친다. 나중 값이 이긴다(덮어쓴다).
 * ⛔로드 실패에서는 부르지 않는다 — 안 본 광고를 「봤다」로 세면 전면이 부당하게 막힌다.
 */
export function markRewardedShown(now: number = nowMs()): void {
  const led = readInterstitialLedger();
  writeInterstitialLedger({ ...led, lastRewardAt: Math.max(led.lastRewardAt, now) });
}

/** 전면이 «실제로 노출»됐을 때만 센다. 로드 실패는 세지 않는다 */
function markInterstitialShown(now: number = nowMs()): void {
  const led = readInterstitialLedger();
  const today = kstDateKey(now);
  writeInterstitialLedger({
    dateKey: today,
    count: (led.dateKey === today ? led.count : 0) + 1,
    lastAt: now,
    lastRewardAt: led.lastRewardAt,
  });
}

export type InterstitialResult =
  /** 끝까지 노출되고 닫혔다 */
  | { ok: true }
  /** 가드에 걸렸거나(호출 자체를 안 했다) 로드·노출에 실패했다 — ★어느 쪽이든 «조용히» 진행한다 */
  | { ok: false; reason: InterstitialBlock | 'load-failed' | 'show-failed' };

/**
 * 전면 광고 1회 실행. `load → show → dismissed` 로 끝난다.
 *
 * ★★계약: ⛔절대 throw 하지 않고, ⛔절대 흐름을 막지 않는다.
 *   호출부는 결과를 «보지 않아도» 된다 — `await` 한 뒤 하던 일을 그냥 계속하면 된다.
 *   가드에 걸리면 즉시(동기적으로) 실패를 돌려주므로 화면이 멈추는 시간도 0 이다.
 * ★포맷(전면/보상형 전면 등)은 ★콘솔 지면 그룹이 정한다. 코드는 ID 만 안다.
 */
/**
 * ★전면은 «한 번에 하나»다 — 모듈 수준 잠금.
 *
 * ⛔없으면 두 호출부가 «동시에» 부를 때 둘 다 게이트를 통과한다: 원장(`markInterstitialShown`)은
 *   show 시점에야 써지므로, 그 전에 들어온 두 번째 호출은 옛 원장을 읽고 「아직 안 나갔다」로 판정한다.
 *   [2026-09-10 Codex 리뷰 시뮬레이션 SIMULTANEOUS_INTERSTITIAL: loads 2 · shows 2 · 원장 count 2]
 *   ⇒ 하루 3회·10분 간격이 «한 번에» 뚫린다(정책 위반). 호출부는 3곳(충전 완료·시즌 마감·N번째 거래)이다.
 */
let interstitialInFlight = false;

export function runInterstitialAd(
  slot: InterstitialSlotId,
  opts: {
    /**
     * ★요청 «직전»과 노출 «직전»에 호출부에게 다시 묻는다. 문자열을 돌려주면 그 사유로 중단한다.
     *   [2026-09-12 Codex 리뷰 1번] 「세 번째 거래 전면」이 «다른 거래»의 되돌리기 5초를 가렸다 —
     *   로드가 6초 걸리는 사이에 네 번째 주문이 들어오면 그 되돌리기 창 위로 광고가 덮인다.
     *   ⇒ 되돌리기 창이 하나라도 열려 있거나 화면을 떠났으면 «취소»한다. 판단은 호출부가 한다.
     */
    canShow?: () => string | null;
  } = {}
): Promise<InterstitialResult> {
  if (interstitialInFlight) {
    noteAd('interstitial', slot, 'guard', { reason: 'in-flight' });
    return Promise.resolve({ ok: false, reason: 'too-soon' });
  }
  const g = interstitialGate(slot);
  if (!g.ok) {
    /* ★계측: «정책 가드»에 막힌 것만 센다(요청 «전» 차단). 토스 밖·미발급은 환경이라 세지 않는다 */
    if (g.reason !== 'unsupported' && g.reason !== 'no-placement') noteAd('interstitial', slot, 'guard', { reason: g.reason });
    return Promise.resolve({ ok: false, reason: g.reason });
  }
  /* ★요청 «전»에 호출부에게 먼저 묻는다 — 막을 거면 SDK 를 부르지도 않는다(헛요청 0) */
  const veto0 = opts.canShow?.() ?? null;
  if (veto0) {
    noteAd('interstitial', slot, 'guard', { reason: veto0 });
    return Promise.resolve({ ok: false, reason: 'too-soon' });
  }

  const adGroupId = AD_IDS[slot];
  interstitialInFlight = true;
  noteAd('interstitial', slot, 'req');
  return new Promise<InterstitialResult>((resolve) => {
    let settled = false;
    let shown = false;
    let cleanupLoad: (() => void) | undefined;
    let cleanupShow: (() => void) | undefined;

    const finish = (r: InterstitialResult, why?: string) => {
      if (settled) return;
      settled = true;
      interstitialInFlight = false;
      window.clearTimeout(timer);
      try {
        cleanupLoad?.();
      } catch {
        /* ignore */
      }
      try {
        cleanupShow?.();
      } catch {
        /* ignore */
      }
      if (r.ok) noteAd('interstitial', slot, 'dismiss');
      else noteAd('interstitial', slot, 'fail', { reason: why ?? r.reason });
      resolve(r);
    };

    const timer = window.setTimeout(() => finish({ ok: false, reason: 'load-failed' }, 'timeout'), INTERSTITIAL_LOAD_TIMEOUT_MS);

    const show = () => {
      /*
       * ★★로드를 «시작할 때» 통과한 가드를 여기서 «다시» 본다.
       *   로드는 최대 6초 걸린다. 그 사이에 (a) 리워드 광고가 노출되거나(연속 광고 금지 60초)
       *   (b) 다른 전면이 나갔거나 (c) 유저가 앱을 백그라운드로 보낼 수 있다.
       *   [2026-09-10 Codex 리뷰 시뮬레이션 LOAD_THEN_REWARD_AND_HIDDEN: 리워드 + hidden 인데도 show 가 나갔다]
       *   ⇒ 안 보이는 화면에 띄우면 유저는 못 보는데 노출로 세어져 «시청률도 UX 도» 나빠진다.
       */
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        noteAd('interstitial', slot, 'guard', { reason: 'hidden-at-show' });
        finish({ ok: false, reason: 'show-failed' }, 'hidden-at-show');
        return;
      }
      const g2 = interstitialGate(slot);
      if (!g2.ok) {
        noteAd('interstitial', slot, 'guard', { reason: g2.reason });
        finish({ ok: false, reason: g2.reason });
        return;
      }
      /* ★호출부 조건(되돌리기 창·화면·새 주문)을 «노출 직전»에 한 번 더 — 로드 6초 사이에 다 바뀔 수 있다 */
      const veto = opts.canShow?.() ?? null;
      if (veto) {
        noteAd('interstitial', slot, 'guard', { reason: veto });
        finish({ ok: false, reason: 'show-failed' }, veto);
        return;
      }
      /* ★여기서 «먼저» 센다. show 를 부른 뒤 유저가 앱을 죽이면 dismissed 가 안 온다 —
         그때 안 세면 「광고는 봤는데 카운트는 0」이 되어 상한이 무력화된다.
         ⚠이 원장(ml.ads.interstitial)은 «가드용»이다. 시청률 계측의 shown 은 아래 impression 콜백이다(Codex 관찰 1) */
      shown = true;
      markInterstitialShown();
      noteAd('interstitial', slot, 'showReq');
      try {
        cleanupShow = GoogleAdMob.showAppsInTossAdMob({
          options: { adGroupId },
          onEvent: (e) => {
            /* ★전면에는 `userEarnedReward` 가 없다. 닫힘(dismissed)이 곧 성공이다 */
            if ((e as { type: string }).type === 'impression') noteAd('interstitial', slot, 'shown');
            else if (e.type === 'dismissed') finish({ ok: true });
            else if (e.type === 'failedToShow') finish({ ok: false, reason: 'show-failed' }, 'failedToShow');
          },
          onError: () => finish({ ok: false, reason: 'show-failed' }, 'show-error'),
        });
      } catch {
        finish({ ok: false, reason: 'show-failed' }, 'show-threw');
      }
    };

    try {
      cleanupLoad = GoogleAdMob.loadAppsInTossAdMob({
        options: { adGroupId },
        onEvent: (e) => {
          if (e.type === 'loaded' && !shown) {
            window.clearTimeout(timer);
            noteAd('interstitial', slot, 'load');
            show();
          }
        },
        onError: () => finish({ ok: false, reason: 'load-failed' }, 'network'),
      });
    } catch {
      finish({ ok: false, reason: 'load-failed' }, 'load-threw');
    }
  });
}
