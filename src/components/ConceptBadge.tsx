/**
 * 참가자 «콘셉트 배지» — 랭킹 목록 · 트레이더 프로필 «공용».
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★왜 만들었나 1: ★표가 «두 벌»이었다.
 *   Leaderboard.tsx 와 TraderProfile.tsx 가 각자 같은 표를 들고 있었고,
 *   그 파일 주석에 「한쪽만 고치면 같은 참가자가 두 화면에서 다르게 보인다」고
 *   ★위험이 «적혀 있었다». 적어 두는 것으로는 안 막힌다 — 한 벌로 만든다.
 *
 * ★★왜 만들었나 2: ★이모지를 걷어낸다(🐳⚡📈🔄💧🏛️🪣🎯🧺🔁🧊🐻🛡️).
 *   ① 이모지는 기기·OS 마다 «다르게 그려진다». 같은 화면의 탭바·앱바가 선 아이콘인데
 *      배지만 컬러 이모지면 그 줄이 「다른 앱에서 붙여넣은 것」처럼 읽힌다.
 *   ② ★이 배지는 ★랭킹 첫 화면에 «가장 많이» 보이는 요소다(행마다 하나).
 *      앞 레인이 피드·경고의 이모지를 SVG 로 걷었을 때 여기만 남아 있었다.
 *   ③ 🏛️·🛡️ 는 «이모지 프레젠테이션 셀렉터»가 붙은 문자라 플랫폼에 따라
 *      흑백 글리프로 떨어지기도 한다 — 같은 앱에서 어떤 배지는 컬러, 어떤 배지는
 *      흑백으로 나오는 상태였다.
 *
 * ★규격은 앞 레인이 만든 SVG 세트와 «동일»하다:
 *   viewBox 24 · fill none · stroke currentColor · stroke-width 1.9 · round cap/join.
 *   ⇒ 색은 «부모 배지»가 정한다(--up-ink / --down-ink / ...). 아이콘이 색을 갖지 않는다.
 * ★14종 = engine/types.ts 의 BotStrategy 유니언과 «같은 집합»이다.
 *   빠진 게 있으면 화면에 배지가 «안 뜬다» — check_i18n_usage.mjs 가 i18n 쪽을 지키고,
 *   이 파일은 아래 CONCEPT_IDS 로 «타입 수준»에서 지킨다.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const P = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function G(children: ReactNode) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden {...P}>
      {children}
    </svg>
  );
}

/**
 * 콘셉트 배지 표 — ★이 앱에 «하나뿐»이다.
 * `cls` 는 색조(기존 값 그대로 유지 — 쓰던 유저에게 같은 색이어야 한다),
 * `icon` 은 뜻을 그린 선 아이콘이다.
 */
export const CONCEPT_BADGE: Record<string, { cls: string; icon: ReactNode }> = {
  // ── 원년 5종 ─────────────────────────────────────────────────────────
  /** 큰손 — 한 번에 «아주 큰» 금액. 크기 대비로 그린다 */
  whale: { cls: 'badge--gold', icon: G(<><circle cx="9" cy="12" r="6" /><circle cx="19" cy="12" r="2.4" /></>) },
  /** 레버리지 — 증폭. 번개(앱의 파생 탭 아이콘과 같은 뜻) */
  derivatives_heavy: { cls: 'badge--purple', icon: G(<path d="M13.6 3 6 13.4h4.6L10.4 21 18 10.6h-4.6z" />) },
  /** 추세추종 — 오르는 선을 따라간다 */
  momentum: { cls: 'badge--up', icon: G(<><path d="M3.5 17.5 9 11l3.6 3.4L20.5 6" /><path d="M15.6 6h4.9v4.9" /></>) },
  /** 역추세 — 되돌아온다. 순환 화살표 */
  mean_reversion: { cls: 'badge--down', icon: G(<><path d="M4 12a8 8 0 0 1 13.7-5.6" /><path d="M20 12a8 8 0 0 1-13.7 5.6" /><path d="M18 3v3.6h-3.6" /><path d="M6 21v-3.6h3.6" /></>) },
  /** 소액다건 — 작은 거래가 아주 많다. 흩어진 점 */
  noise: { cls: 'badge--weak', icon: G(<><path d="M6 8h.01M12 5h.01M18 9h.01M5 15h.01M11 12h.01M17 16h.01M8 19h.01M15 20h.01" /></>) },

  // ── 신규 9종 ─────────────────────────────────────────────────────────
  /** 우량주만 — 큰 회사. 기둥 있는 건물 */
  blue_chip: { cls: 'badge--brand', icon: G(<><path d="M3.5 9.5 12 4.5l8.5 5" /><path d="M6 10v8M10 10v8M14 10v8M18 10v8" /><path d="M4 20h16" /></>) },
  /** 줍줍 — 떨어지면 산다. 내려가는 선 + 아래 화살표 */
  dip_buyer: { cls: 'badge--down', icon: G(<><path d="M3.5 7 9 13l3.5-2.6L20.5 18" /><path d="M20.5 13.4V18h-4.6" /></>) },
  /** 몰빵 — 딱 한 곳에 전부. 과녁 */
  all_in: { cls: 'badge--up', icon: G(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" /><path d="M12 12h.01" /></>) },
  /** 분산투자 — 한 곳에서 여러 갈래로 */
  diversifier: { cls: 'badge--weak', icon: G(<><path d="M12 4v6" /><path d="M12 10 5.5 15" /><path d="M12 10h0" /><path d="M12 10l6.5 5" /><circle cx="5" cy="18" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="M12 10v6" /></>) },
  /** 단타 — 하루 안에 사고 되판다. 빠른 왕복 */
  day_trader: { cls: 'badge--up', icon: G(<><path d="M4 8.5h13l-3.4-3.4" /><path d="M20 15.5H7l3.4 3.4" /></>) },
  /** 존버 — 사면 안 판다. 잠금 */
  hodler: { cls: 'badge--weak', icon: G(<><rect x="4.6" y="10.5" width="14.8" height="9.4" rx="2.4" /><path d="M8.4 10.5V7.8a3.6 3.6 0 0 1 7.2 0v2.7" /></>) },
  /** 공매도 — 내리는 쪽에 건다 */
  short_seller: { cls: 'badge--down', icon: G(<><path d="M3.5 6.5 9 13l3.6-3.4L20.5 18" /><path d="M15.6 18h4.9v-4.9" /></>) },
  /** 저변동 — 안 흔들리는 것만. 방패 */
  low_vol: { cls: 'badge--weak', icon: G(<path d="M12 3.4 19.5 6v6.2c0 4-3.1 7-7.5 8.4-4.4-1.4-7.5-4.4-7.5-8.4V6z" />) },
  /** ★청산 사냥꾼 — 위험한 포지션을 «노린다». 조준 */
  liquidation_hunter: { cls: 'badge--warnish', icon: G(<><circle cx="12" cy="12" r="7.2" /><path d="M12 2.6v3.4M12 18v3.4M2.6 12H6M18 12h3.4" /><path d="M12 12h.01" /></>) },
};

/** ★엔진 BotStrategy 14종과 같은 집합인지 눈으로 세지 않게 — 개수를 노출한다 */
export const CONCEPT_IDS = Object.keys(CONCEPT_BADGE);

/**
 * 배지 한 장. `i18nKey` 는 로스터가 준 `traders.concept.<id>` 다.
 * ★글자는 «항상» i18n 이다 — 여기에 한글을 박으면 en 로케일이 그 순간 죽는다.
 */
export function ConceptBadge({
  strategy,
  i18nKey,
  size = 'sm',
}: {
  strategy: string;
  i18nKey: string;
  size?: 'sm' | 'lg';
}) {
  const { t } = useTranslation();
  const b = CONCEPT_BADGE[strategy];
  if (!b) return null;
  return (
    <span
      className={`badge cbadge ${b.cls}`}
      style={size === 'lg' ? { fontSize: 11, padding: '4px 9px' } : undefined}
    >
      {b.icon}
      {t(`common:${i18nKey}.name`)}
    </span>
  );
}
