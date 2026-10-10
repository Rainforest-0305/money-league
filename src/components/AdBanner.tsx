import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AD_RESERVED_H,
  adPreviewMode,
  bannerSupported,
  hasPlacement,
  mountBannerSlot,
  type BannerSlotId,
  type BannerSlotState,
} from '../lib/ads';

/**
 * 앱인토스 배너 지면 — 게임 화면에 광고를 «안전하게» 끼우는 유일한 통로.
 *
 * ── 게임 UI 제약(일반 웹과 다르다) ──────────────────────────────────────
 * 1) ★높이를 «미리» 잡는다. 100종목·100명 리스트 한가운데에 들어가는데
 *    광고가 늦게 뜨면서 높이가 생기면 스크롤이 통째로 점프한다(CLS).
 *    그래서 지원 여부와 무관하게 컨테이너는 항상 `AD_RESERVED_H` 를 차지한다.
 * 2) ★리스트 항목처럼 보이면 «오탭»이 난다 — 이 앱에서 오탭은 곧 (가상)돈이
 *    나가는 조작이다. 그래서 배경을 --bg 로 깔고 좌우 여백을 줄여 리스트 카드와
 *    «다른 재질»로 보이게 하고, 「광고」 라벨을 항상 붙인다(네이티브 위장 금지).
 * 3) ★blur·backdrop-filter·그림자를 쓰지 않는다. 광고가 게임 루프와 GPU 를
 *    공유한다. 60fps 가 절대조건이다.
 *
 * ── ★[2026-09-10 · -33] 「요청은 보일 때 1회」 ─────────────────────────────
 * 예전에는 마운트 useEffect 에서 «곧바로» attach 했다. SDK 는 attach 즉시 광고를 «요청»하고
 * 노출은 1px 이상 «보인» 뒤에만 세므로, 첫 화면 밖에 있는 이 앱의 배너는 «요청 1 · 노출 0»이
 * 기본 경로였다(콘솔 시청률 10.5%). 이제 attach 는 `lib/ads.mountBannerSlot` 컨트롤러가
 * «뷰포트 교차 + 문서 visible + SDK init 완료» 세 조건이 모두 맞는 순간 «한 번»만 한다.
 * 규율(숨김 0·리렌더 잠금·이탈 취소·재진입 1·no-fill 재시도 없음·오류 백오프)은 그 파일 머리 주석.
 * ★이 컴포넌트는 «전 지면 공통»이다 — 홈·종목 상세만 아니라 랭킹·설정·프로필·목록·충전완료·일지가 같이 따른다.
 *
 * ── 미지원 환경 ─────────────────────────────────────────────────────────
 * 토스 밖(itch.io·GitHub Pages·MS Store 래핑·로컬 브라우저)은 이 앱의 «정상 경로»다.
 * 그때는 «아무것도 그리지 않는다» — 빈 광고 상자를 남기면 그게 더 나쁜 UX 다.
 * 레이아웃 검증이 필요하면 sessionStorage['ads.preview']='1' 로 자리만 그린다.
 */
export function AdBanner({ slot, style }: { slot: BannerSlotId; style?: React.CSSProperties }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('common');
  /* ★지면 ID 가 «없으면»(미발급) 지원 여부와 무관하게 live 가 아니다 */
  const [live] = useState(() => bannerSupported() && hasPlacement(slot));
  /* ★하네스·디버깅용 상태. `data-ad-state` 속성으로만 쓰이고 레이아웃엔 영향이 없다 */
  const [state, setState] = useState<BannerSlotState | 'idle'>('idle');
  const preview = adPreviewMode();
  const h = AD_RESERVED_H[slot];

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !live) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    /* ★attach 시점·횟수는 컨트롤러가 정한다. 언마운트 = dispose(IO 해제·대기 취소·slot destroy) */
    const ctl = mountBannerSlot(slot, el, dark ? 'dark' : 'light', setState);
    return ctl.dispose;
  }, [slot, live]);

  if (!live && !preview) return null;

  return (
    <div className="adslot" style={{ ...style, minHeight: h }} aria-label={t('adLabel')} data-ad-slot={slot} data-ad-state={state}>
      <span className="adslot__tag">{t('adLabel')}</span>
      <div ref={hostRef} className="adslot__host" style={{ minHeight: h - 18 }}>
        {preview && !live && <span className="adslot__ph">{t('adPreview')}</span>}
      </div>
    </div>
  );
}
