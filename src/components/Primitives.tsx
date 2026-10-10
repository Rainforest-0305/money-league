import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FLASH_MS } from '../lib/constants';
import { dir as dirOf } from '../lib/format';
import type { TickerMeta } from '../data/types';

/* ── 아이콘 ───────────────────────────────────────────────────────────
   ★[2026-08-21] back·close·search·bell·info·arrow 6종에 ★fill/stroke 를 «인라인»으로 넣었다.
     ★예전엔 `.iconbtn svg { fill:none; stroke:currentColor }` CSS 에만 의존했다.
       ⇒ ★«버튼 밖»에 쓰면 ★검은 덩어리로 찍힌다. 실제로 그랬다 —
         선도 주문폼의 「제안은 바뀌지 않아요」 앞 정보 아이콘이 ●(검은 원)으로 나왔다.
     ★아이콘이 «어디에 놓이든» 같게 보이는 게 맞다. 값은 .iconbtn 규칙과 동일하므로
       기존 화면은 «픽셀 하나도» 바뀌지 않는다.
     ⛔chevron 은 제외했다 — `.chev` 클래스가 다른 굵기(2.4)·색(--t3)을 쓰고 있고,
       CSS 가 프레젠테이션 속성을 이기므로 건드릴 이유가 없다. */
/**
 * 작은 체크의 «렌더 픽셀» 획 두께. ★1.7px 은 12~16px 아이콘에서
 * 세트 표준(1.9 @ 22px = 1.74px)과 «같은 무게»로 보이는 값이다.
 */
const CHECK_STROKE_PX = 1.7;

export const Icon = {
  back: (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  close: (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  chevron: (
    <svg className="chev" viewBox="0 0 24 24" aria-hidden>
      <path d="m9 5 7 7-7 7" />
    </svg>
  ),
  search: (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  ),
  bell: (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  ),
  info: (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8.5v.01" />
    </svg>
  ),
  arrow: (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 5 7 7-7 7" />
    </svg>
  ),
  check: (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  /**
   * ★[2026-08-21] 작은 체크 — `Icon.check`(34px 히어로)와 «같은 획»을 작은 자리에 쓴다.
   *   쓰는 곳: 닉네임 통과 표시(12px 글자 옆) · 종목 선택 배지(20px 원 안).
   *   ⛔둘 다 원래 이모지 `✓`(U+2713)였다. 플랫폼마다 모양·기준선이 달라지고
   *     폰트에 종속돼 브랜드 색·굵기를 맞출 수 없다(President 「AI 티 제거」).
   *
   * ★굵기를 «렌더 픽셀» 기준으로 고정한다(`STROKE_PX`).
   *   viewBox 24 를 12px 로 줄이면 세트 표준 stroke 1.9 가 ★0.95px 로 그려져
   *   브랜드 원 안에서 «흐릿한 흰 실선»이 된다. 반대로 큰 자리에서 같은 값을 쓰면 덩어리가 된다.
   *   ⇒ 크기가 아니라 «획의 두께»가 세트를 하나로 보이게 한다.
   * ★path 는 `Icon.check` 와 «문자 그대로 같다» — 같은 표시가 두 모양이면 안 된다.
   */
  checkSm: (size = 14) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={(CHECK_STROKE_PX * 24) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  /*
   * ★2026-08-20 추가 — 이모지를 걷어내기 위해 «같은 문법»으로 그린 4종.
   *   ★왜 라이브러리를 안 쓰나: 이 앱은 아이콘 의존성이 «0»이고 위 세트가 이미 자체 SVG 다.
   *     여기에 아이콘 패키지를 넣으면 번들이 커지고 «두 가지 아이콘 문법»이 공존한다 —
   *     화면마다 다른 문법이 제품 UI 에서 가장 흔한 실패다(impeccable product 레지스터).
   *   ★규격은 위 세트와 동일: viewBox 24, fill none, stroke currentColor(부모가 색을 정한다),
   *     stroke-width 1.9, round cap/join. 그래야 «한 세트»로 보인다.
   */
  /** 레버리지 — 배율로 증폭되는 방향성 */
  leverage: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 17.5 9.5 11l4 4L21 7.5" />
      <path d="M15.5 7.5H21v5.5" />
    </svg>
  ),
  /** 옵션 — 「정해진 가격에 살/팔 권리」 = 계약서 */
  option: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3.5h8.5L19 8v12.5H6z" />
      <path d="M14 3.5V8h5" />
      <path d="M9 13h6M9 16.5h4" />
    </svg>
  ),
  /** 경고 — 청산 임박 등 */
  warn: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4.2 2.6 20h18.8z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.3h.01" />
    </svg>
  ),
  /** 체결 — 주고받음 */
  swap: (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 8.5h13l-3.5-3.5" />
      <path d="M20 15.5H7l3.5 3.5" />
    </svg>
  ),
  globe: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5z" />
    </svg>
  ),
  moon: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 13.4A8.2 8.2 0 0 1 10.6 4a8.5 8.5 0 1 0 9.4 9.4z" />
    </svg>
  ),
  palette: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.6a8.4 8.4 0 0 0 0 16.8c1.3 0 1.9-.9 1.9-1.8 0-1.2-1-1.6-1-2.6 0-.8.6-1.4 1.5-1.4h1.4a4.6 4.6 0 0 0 4.6-4.6c0-3.6-3.6-6.4-8.4-6.4z" /><circle cx="8.4" cy="10.4" r="1" /><circle cx="12" cy="7.8" r="1" /><circle cx="15.6" cy="10.2" r="1" />
    </svg>
  ),
  trophy: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 4.5h8v4.2a4 4 0 0 1-8 0z" /><path d="M8 5.8H5.4v1.3a3 3 0 0 0 2.9 3" /><path d="M16 5.8h2.6v1.3a3 3 0 0 1-2.9 3" /><path d="M12 12.9v3.4M9 19.5h6" />
    </svg>
  ),
  sound: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 9.5h3l4-3.4v11.8l-4-3.4H5z" /><path d="M16 9.4a3.6 3.6 0 0 1 0 5.2" />
    </svg>
  ),
  battery: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="7.5" width="15" height="9" rx="2.4" /><path d="M20.5 10.6v2.8" /><path d="M6.2 10.6v2.8" />
    </svg>
  ),
  receipt: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3.6h12v16.8l-2.4-1.6-2.4 1.6-2.4-1.6-2.4 1.6L6 20.4z" /><path d="M9.2 8.4h5.6M9.2 12h5.6" />
    </svg>
  ),
  /**
   * 퍼센트 — 「금리」를 뜻한다 (2026-08-20 거시 이벤트 카드).
   * ★위 세트와 «같은 규격»: viewBox 24 · fill none · stroke currentColor · width 1.9 · round.
   *   화폐·달러 기호를 쓰지 않은 이유: 이 앱의 통화는 달러라 $ 는 「돈」이 아니라
   *   「가격」으로 읽힌다. 금리는 비율이다.
   */
  percent: (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18.5 5.5 5.5 18.5" /><circle cx="7.6" cy="7.6" r="2.6" /><circle cx="16.4" cy="16.4" r="2.6" />
    </svg>
  ),
  book: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 5.2A2.6 2.6 0 0 1 7.1 3.6H19v13.6H7.1a2.6 2.6 0 0 0-2.6 2.6z" /><path d="M4.5 5.2v14.6" />
    </svg>
  ),
  exit: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.4 4.5H6.6v15h7.8" /><path d="M12 12h8.2M17.4 8.8 20.6 12l-3.2 3.2" />
    </svg>
  ),
  star: (filled: boolean) => (
    <svg width="21" height="21" viewBox="0 0 24 24" style={{ fill: filled ? 'var(--gold)' : 'none', stroke: filled ? 'var(--gold)' : 'currentColor' }} aria-hidden>
      <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9L12 3.6z" />
    </svg>
  ),

  /* ── ★[2026-08-21] 이모지 걷어내기 2차 — «크기를 받는» 아이콘 ─────────
   * ★왜 «함수»인가: 남아 있던 이모지 중 4곳이 fontSize 46~52px 짜리 «히어로»였다.
   *   고정 크기 아이콘으로는 그 자리를 채울 수 없다. `Icon.star` 가 이미 함수라
   *   이 문법은 «새로 만든 것»이 아니다.
   * ★굵기는 크기에 따라 «얇게» 간다 — viewBox 24 를 52px 로 키우면 stroke 1.9 가
   *   4.1px 로 그려져 덩어리가 된다. 40px 이상은 1.4 로 낮춘다.
   * ★색은 «부모»가 정한다(stroke: currentColor). 아이콘이 색을 갖지 않는다.
   */
  crown: (size = 22) => G2(size, <><path d="M3.6 17.4h16.8" /><path d="M3.6 17.4 2.2 7.6l5.5 3.7L12 4.4l4.3 6.9 5.5-3.7-1.4 9.8" /></>),
  timer: (size = 22) => G2(size, <><circle cx="12" cy="13.6" r="7.6" /><path d="M12 9.6v4l2.6 1.9" /><path d="M9.2 2.4h5.6" /></>),
  coins: (size = 22) => G2(size, <><ellipse cx="12" cy="6.6" rx="7.6" ry="3.1" /><path d="M4.4 6.6v5.1c0 1.7 3.4 3.1 7.6 3.1s7.6-1.4 7.6-3.1V6.6" /><path d="M4.4 11.7v5.1c0 1.7 3.4 3.1 7.6 3.1s7.6-1.4 7.6-3.1v-5.1" /></>),
  bolt: (size = 22) => G2(size, <path d="M13.6 2.6 5.4 13.6h5.1L10.4 21.4l8.2-11h-5.1z" />),
  trend: (size = 22) => G2(size, <><path d="M3.2 17.4 9 11l3.8 3.6 8-8.4" /><path d="M15.4 6.2h5.4v5.4" /></>),
  gear: (size = 22) => G2(size, <><circle cx="12" cy="12" r="3.3" /><path d="M12 2.4v3.1M12 18.5v3.1M21.6 12h-3.1M5.5 12H2.4M18.8 5.2l-2.2 2.2M7.4 16.6l-2.2 2.2M18.8 18.8l-2.2-2.2M7.4 7.4 5.2 5.2" /></>),
  sun: (size = 22) => G2(size, <><circle cx="12" cy="12" r="4.1" /><path d="M12 2.4v2.6M12 19v2.6M21.6 12H19M5 12H2.4M18.8 5.2l-1.8 1.8M7 17l-1.8 1.8M18.8 18.8 17 17M7 7 5.2 5.2" /></>),
  /** 눈 — 「열람권」(다른 참가자를 «본다»)의 뜻 그대로 */
  eye: (size = 22) => G2(size, <><path d="M2.4 12S6.1 5.6 12 5.6 21.6 12 21.6 12 17.9 18.4 12 18.4 2.4 12 2.4 12z" /><circle cx="12" cy="12" r="3.1" /></>),
  /** 빈 지갑 — 파산 화면. ⛔「돈 없음」을 글자로 다시 말하지 않는다(카피가 이미 말한다) */
  wallet: (size = 22) => G2(size, <><path d="M3.4 8.4A2.6 2.6 0 0 1 6 5.8h11.4A1.6 1.6 0 0 1 19 7.4v1" /><rect x="3.4" y="8.4" width="17.2" height="10.6" rx="2.6" /><path d="M16.4 13.7h1.6" /></>),
  /**
   * 공유 — 세 점을 «잇는» 그래프. 「친구에게 공유하고 받기」의 표식이다.
   * ★사람 실루엣이 아니라 «연결»을 그린다: 이 기능의 뜻이 «내 계정 → 친구»의 전달이고,
   *   12~22px 에서 사람 실루엣은 덩어리로 뭉친다(획 1.9 기준).
   * ⛔이모지(공유·손·사람)를 쓰지 않는다 — 이 앱은 표식이 «전부 SVG» 다.
   */
  share: (size = 22) => G2(size, <><circle cx="17.6" cy="5.6" r="2.8" /><circle cx="6.4" cy="12" r="2.8" /><circle cx="17.6" cy="18.4" r="2.8" /><path d="M8.9 10.6 15.1 7M8.9 13.4l6.2 3.6" /></>),
  /** 물방울 — 강제 «청산». 이 앱에서 청산 화면의 표식이다 */
  drop: (size = 22) => G2(size, <path d="M12 3.2s6.2 6.7 6.2 10.5A6.2 6.2 0 0 1 5.8 13.7C5.8 9.9 12 3.2 12 3.2z" />),
  /** 중앙은행 — 기둥이 있는 «기관» 건물. 같은 규격(획 1.9 · round) */
  bank: (size = 22) => G2(size, <><path d="M3.6 9.6 12 4.4l8.4 5.2" /><path d="M5.6 9.6v7.6M10 9.6v7.6M14 9.6v7.6M18.4 9.6v7.6" /><path d="M3.6 19.6h16.8" /></>),
  /**
   * 메달 — 홈 탑3. ★숫자를 «안에» 넣는다: 색만으로 1·2·3 을 구분하면
   * 색맹 사용자에게는 세 개가 같은 모양이 된다.
   */
  medal: (place: 1 | 2 | 3, size = 20) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.4 2.6 12 9.2M15.6 2.6 12 9.2" />
      <circle cx="12" cy="15.2" r="6.2" />
      <text x="12" y="18.1" textAnchor="middle" fontSize="8" fontWeight="800" fill="currentColor" stroke="none">
        {place}
      </text>
    </svg>
  ),
};

/** 새 아이콘 공통 틀 — 규격은 위 세트와 «같다». 크기만 인자로 받는다 */
function G2(size: number, children: ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={size >= 40 ? 1.4 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const TabIcons = {
  home: (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden>
      <path d="M3 10.6 12 3l9 7.6V21h-6.2v-6.1H9.2V21H3z" />
    </svg>
  ),
  stocks: (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 20V10h4v10H4zm6 0V4h4v16h-4zm6 0v-7h4v7h-4z" />
    </svg>
  ),
  derivatives: (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden>
      <path d="M13.4 2 4 14.2h5.6L8.6 22 18 9.8h-5.6L13.4 2z" />
    </svg>
  ),
  rank: (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 3h10v3.6a5 5 0 0 1-10 0V3zM3.4 4.2H6v2.5a2.6 2.6 0 0 1-2.6-2.5zM18 4.2h2.6A2.6 2.6 0 0 1 18 6.7V4.2zM11 12.2h2V16h3.2v2.2H7.8V16H11v-3.8z" />
    </svg>
  ),
  me: (
    <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M12 14c-4.4 0-8 2.3-8 5.2V21h16v-1.8c0-2.9-3.6-5.2-8-5.2z" />
    </svg>
  ),
};

export const BrandMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden>
    <rect width="26" height="26" rx="8" fill="var(--brand)" />
    <path d="M6 17.5 10.5 12l3.5 3.4L20 8" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ── 티커 타일 (상표 회피: 이니셜 2글자 + 기업 연상색) ──────────────── */
export function TickerTile({
  meta,
  size = 'md',
  style,
}: {
  meta: Pick<TickerMeta, 'initials' | 'color' | 'ticker'>;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  style?: CSSProperties;
}) {
  const cls = size === 'lg' ? 'tile' : size === 'md' ? 'tile tile--md' : size === 'sm' ? 'tile tile--sm' : 'tile tile--xs';
  return (
    <span className={cls} style={{ background: meta.color, ...style }} aria-hidden>
      {meta.initials}
    </span>
  );
}

/* ── 틱 플래시 숫자 ─────────────────────────────────────────────────── */
export function PriceText({
  value,
  render,
  className = '',
  style,
}: {
  value: number;
  render: (v: number) => string;
  className?: string;
  style?: CSSProperties;
}) {
  const prev = useRef(value);
  const ref = useRef<HTMLSpanElement>(null);

  /*
   * ★[성능 2026-08-30 · iOS 프레임 저하 대응] 예전엔 flash 가 «state»였다 — 값 변경 렌더 + setFlash 렌더 + 220ms 뒤
   *   setFlash(null) 렌더 = 인스턴스당 «틱마다 3회 렌더 + 타이머 1개». 종목 화면은 화면 안 행 ≈26개라 2초마다
   *   78회 렌더 + 26개 타이머였다. 지금은 «값 변경 렌더 1회»뿐이고, 플래시는 React 밖에서 WAAPI 로 돈다:
   *     의사요소(::after, 합성 가능한 opacity 1→0) 를 애니메이션 — 레이아웃·리플로우 0, background-color 페인트 0.
   *   ⛔`el.offsetWidth` 로 애니메이션을 재시작하지 않는다 — 행마다 강제 리플로우가 난다. WAAPI 는 재시작이 공짜다.
   *   `pseudoElement` 미지원 웹뷰면 요소 자체 background-color 로 폴백(예전과 같은 모양, 렌더 수는 그대로 1회).
   */
  useEffect(() => {
    const el = ref.current;
    const d = value > prev.current ? 'up' : value < prev.current ? 'down' : null;
    prev.current = value;
    if (!el || !d || typeof el.animate !== 'function') return;
    el.dataset.dir = d;
    try {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out', pseudoElement: '::after' });
    } catch {
      el.animate(
        [{ backgroundColor: d === 'up' ? 'var(--up-weak)' : 'var(--down-weak)' }, { backgroundColor: 'transparent' }],
        { duration: FLASH_MS, easing: 'ease-out' }
      );
    }
  }, [value]);

  return (
    <span ref={ref} className={`num tick-flash ${className}`} style={style}>
      {render(value)}
    </span>
  );
}

/** 손익 텍스트 — 색 + 부호 동시 표기 (색각 이상 대응) */
export function Delta({ value, text, className = '' }: { value: number; text: string; className?: string }) {
  const d = dirOf(value);
  return <span className={`num ${d === 'up' ? 'up' : d === 'down' ? 'down' : 'flat'} ${className}`}>{text}</span>;
}

/* ── 바텀시트 ───────────────────────────────────────────────────────── */
export function Sheet({
  onClose,
  children,
  labelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="grab" />
        {children}
      </div>
    </>
  );
}

/* ── 슬라이더 ───────────────────────────────────────────────────────── */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  tone = 'up',
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  tone?: 'up' | 'down' | 'brand';
  label: string;
}) {
  const ratio = max > min ? (value - min) / (max - min) : 0;
  const pct = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  const color = tone === 'down' ? 'var(--down)' : tone === 'brand' ? 'var(--brand)' : 'var(--up)';
  return (
    <div className="slider" style={{ ['--dir' as string]: color }}>
      <div className="slider__track">
        <div className="slider__fill" style={{ width: pct }} />
        <div className="slider__thumb" style={{ left: pct }} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/* ── [제거] 밀어서 확정(SwipeConfirm) ────────────────────────────────
   President 지시 2026-08-19: 「구매할 때마다 진짜 구매할 거냐고 안 물었으면
   좋겠다」. 스와이프 확정은 «매 주문마다» 걸리는 마찰이라 통째로 걷어냈다.

   ★안전장치를 «없앤» 게 아니라 «자리를 옮겼다» — 주문 직후 5초짜리
     「되돌리기」 토스트(store.showToast 의 action · UNDO_WINDOW_MS)로 대체했다.
     되돌리기는 반대매매가 아니라 원장 복원이다(world.cancelSpot/cancelOption/
     cancelLeverage). 되살리지 마라.
*/

/* ── 스위치 ─────────────────────────────────────────────────────────── */
export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'is-on' : ''}`}
      onClick={onToggle}
    />
  );
}

/* ── 충전 잔여 도트 ─────────────────────────────────────────────────── */
/**
 * 충전 잔여 도트.
 * ★ total 에 기본값을 두지 않는다. 예전 `total = 5` 는 TOPUP_DAILY_LIMIT 을 3으로
 *   내려도 «점 5개»를 그대로 그리는 잠재 하드코딩이었다(호출부가 하나라도 인자를
 *   빼먹으면 그 화면만 조용히 어긋난다). 상수에서 «유도»하도록 필수 인자로 바꾼다.
 */
export function RechargeDots({ left, total }: { left: number; total: number }) {
  return (
    <div className="dots" aria-label={`${left}/${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < left ? 'is-left' : ''} />
      ))}
    </div>
  );
}

/* ── 수량 스테퍼 ─────────────────────────────────────────────────────
   ★ 「1계약씩 99번 누르기」를 없애는 컨트롤 (President 지적 2026-08-19).
     세 경로를 한 «컨트롤» 안에 둔다 — 화면을 늘리지 않는 게 핵심이다:
       1) 프리셋 칩 : 목표 수량까지 «1탭»
       2) 직접 입력 : 큰 숫자를 탭하면 그 자리에서 숫자 키패드(임의값 37 등)
       3) ± 롱프레스: 꾹 누르면 연속 증가, 오래 누를수록 «간격↓ 보폭↑»

   ★ 터치 타깃: ±는 44px, 프리셋 칩은 40px 높이, 인접 간격 8px 이상.
     (WCAG 2.2 AA 웹 기준은 24 CSS px 이다. 44 는 iOS 기준이라 웹의 «요건»이
      아니지만, 이 컨트롤은 반복 조작용이라 여유를 둔다.)
   ★ 모션은 transform/opacity 만. 레이아웃 속성은 애니메이션하지 않는다(60fps 조건).
*/
const REPEAT_DELAY_MS = 380;
const REPEAT_FAST_MS = 55;
const REPEAT_SLOW_MS = 170;

export function QuantityStepper({
  value,
  min,
  max,
  onChange,
  presets,
  maxLabel,
  unit,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** 「최대」 앞에 놓을 프리셋 값들. max 이상인 값은 자동으로 접힌다 */
  presets: number[];
  maxLabel: string;
  /** 숫자 옆 단위(예: 「계약」). 로케일마다 길이가 달라 고정폭을 쓰지 않는다 */
  unit?: string;
  label: string;
  /**
   * ★표시 형식. 기본은 «세 자리 구분 없는 정수»(계약 수처럼 «개수»일 때 맞다).
   * ★★금액을 다룰 때는 반드시 넘겨라 — 실렌더에서 선도 「규모」가 `12500` 으로 떴다.
   *   달러 금액인데 «$ 도 콤마도» 없어서 «수량»으로 읽혔다. 이 앱의 다른 모든 금액은
   *   money() 로 그려지는데 여기만 벌거벗은 정수였다.
   */
  format?: (v: number) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const timer = useRef<number | null>(null);
  const held = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, Math.round(v))), [min, max]);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    held.current = 0;
  }, []);

  // 포인터를 컨트롤 «밖»에서 떼도 반드시 멈춘다.
  // (놓친 pointerup 으로 손을 뗐는데도 계속 올라가는 사고를 막는 안전망)
  useEffect(() => {
    const off = () => stop();
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
    return () => {
      window.removeEventListener('pointerup', off);
      window.removeEventListener('pointercancel', off);
      stop();
    };
  }, [stop]);

  const startRepeat = (dir: 1 | -1) => {
    stop();
    const apply = () => {
      const n = held.current;
      const stride = n > 26 ? 10 : n > 14 ? 5 : 1;
      onChange(clamp(valueRef.current + dir * stride));
    };
    apply();
    const step = () => {
      held.current += 1;
      apply();
      timer.current = window.setTimeout(step, Math.max(REPEAT_FAST_MS, REPEAT_SLOW_MS - held.current * 9));
    };
    timer.current = window.setTimeout(step, REPEAT_DELAY_MS);
  };

  const commitDraft = () => {
    const n = Number(draft.replace(/[^0-9]/g, ''));
    setEditing(false);
    if (Number.isFinite(n) && n > 0) onChange(clamp(n));
  };

  const chips = [...presets.filter((v) => v >= min && v < max), max].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="qty">
      <div className="qty__row">
        <button
          type="button"
          className="qty__pm"
          aria-label={label + ' −'}
          disabled={value <= min}
          onPointerDown={() => startRepeat(-1)}
          onPointerUp={stop}
          onPointerLeave={stop}
          onContextMenu={(e) => e.preventDefault()}
        >
          −
        </button>

        {editing ? (
          <input
            className="qty__input num"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            aria-label={label}
            value={draft}
            /*
             * ★자릿수 상한을 «max 에서 유도»한다. 예전엔 4자리 «고정»이었다 —
             *   계약 수(최대 99)에는 넉넉했지만, ★금액(최대 5만 달러)에서는
             *   ★직접 입력으로 최대치에 «도달할 수 없었다». 상수가 용도를 따라오지 못한 경우다.
             */
            onChange={(e) =>
              setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, Math.max(2, String(Math.floor(max)).length)))
            }
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="qty__val"
            aria-label={label}
            role="spinbutton"
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            onClick={() => {
              setDraft(String(value));
              setEditing(true);
            }}
          >
            <span className="num qty__num">{format ? format(value) : value}</span>
            {unit ? <span className="qty__unit">{unit}</span> : null}
          </button>
        )}

        <button
          type="button"
          className="qty__pm"
          aria-label={label + ' +'}
          disabled={value >= max}
          onPointerDown={() => startRepeat(1)}
          onPointerUp={stop}
          onPointerLeave={stop}
          onContextMenu={(e) => e.preventDefault()}
        >
          +
        </button>
      </div>

      <div className="qty__presets">
        {chips.map((v) => (
          <button
            key={v}
            type="button"
            className={'qty__chip ' + (value === v ? 'is-on' : '')}
            aria-pressed={value === v}
            onClick={() => onChange(clamp(v))}
          >
            {v === max ? maxLabel : format ? format(v) : v}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── 세그먼트 ───────────────────────────────────────────────────────── */
export function Segment<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  toneOf,
  className,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'lg';
  toneOf?: (v: T) => 'long' | 'short' | undefined;
  /** 추가 클래스(예: 차트 컨트롤 줄의 `seg--sm`). ⛔세그를 또 손으로 짜지 말고 여기로 붙여라 */
  className?: string;
  /** 라벨이 «무엇의» 선택지인지 화면 밖에서도 말한다. 시각 라벨이 따로 없을 때 준다 */
  ariaLabel?: string;
}) {
  return (
    <div
      className={`seg ${size === 'lg' ? 'seg--lg' : ''} ${className ?? ''}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((o) => {
        const tone = toneOf?.(o.value);
        return (
          <button
            key={o.value}
            role="tab"
            type="button"
            aria-selected={value === o.value}
            className={tone === 'long' ? 'is-long' : tone === 'short' ? 'is-short' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── 콘페티 ─────────────────────────────────────────────────────────── */
export function Confetti({ seed = 0 }: { seed?: number }) {
  const pieces = [
    { c: 'var(--up)', l: 12, t: 10, r: 24 },
    { c: 'var(--brand)', l: 30, t: -4, r: -14 },
    { c: 'var(--gold)', l: 63, t: 6, r: 38 },
    { c: 'var(--down)', l: 80, t: 22, r: -30 },
    { c: 'var(--brand)', l: 8, t: 40, r: 12 },
    { c: 'var(--gold)', l: 88, t: 46, r: -42 },
    { c: 'var(--up)', l: 46, t: 30, r: 8 },
    { c: 'var(--brand)', l: 70, t: 54, r: -20 },
  ];
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p, i) => (
        <i
          key={`${seed}-${i}`}
          style={{
            background: p.c,
            left: `${p.l}%`,
            top: p.t,
            transform: `rotate(${p.r}deg)`,
            animationDelay: `${i * 60}ms`,
          }}
        />
      ))}
    </div>
  );
}

/* ── 숫자 카운트업 ──────────────────────────────────────────────────── */
export function CountUp({ to, duration = 900, render }: { to: number; duration?: number; render: (v: number) => string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const loop = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  return <span className="num">{render(v)}</span>;
}
