import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from './Primitives';
import { store } from '../store/store';

/**
 * 부팅(시장 워밍업) 화면.
 *
 * ── 왜 «필요»한가 (2026-08-20) ─────────────────────────────────────────
 * 워밍업 3,000틱을 «프레임 사이»로 나눠 돌리게 되면서 생긴 짝이다.
 *  · 예전: 한 루프로 돌려 그 시간(210명 1.8초 → 3,310명 3.5초) 동안 앱이 «멈췄다».
 *  · 나누면 앱은 살아 있다 — 그런데 그동안 «저장본이 아직 복원되기 전»이라
 *    화면은 시드 $10,000 을 보여 준다. 멈춰 있을 땐 못 만지던 것을 이제 만질 수 있다.
 *    ⇒ 유저는 「내 돈이 날아갔다」로 읽고, 그 상태에서 주문까지 낼 수 있다
 *      (그 주문은 복원이 덮어써서 «조용히 사라진다»).
 * ⇒ 그래서 부팅 동안은 «덮는다». 그리고 덮은 화면에서 «자산은 그대로»라고 먼저 말한다.
 *
 * ── 규율 ───────────────────────────────────────────────────────────────
 * ★store.bump() 를 타지 않는다 — 전용 구독(subscribeBoot)만 쓴다. 앱 전체 리렌더 0.
 * ⛔blur·backdrop-filter 없음. 진행바는 «transform: scaleX» 로만 움직인다(레이아웃 0).
 * ★prefers-reduced-motion 에서는 전환을 끈다(app.css).
 */
export function BootOverlay() {
  const { t } = useTranslation('common');
  const [, setV] = useState(0);
  useEffect(() => store.subscribeBoot(() => setV((x) => x + 1)), []);
  if (!store.booting) return null;
  const p = Math.max(0.02, Math.min(1, store.bootProgress));
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot__mark">
        <BrandMark />
        <span>{t('appName')}</span>
      </div>
      <div className="boot__bar" aria-hidden>
        <i style={{ transform: `scaleX(${p})` }} />
      </div>
      <div className="boot__t">{t('bootTitle')}</div>
      <div className="boot__s">{t('bootSub')}</div>
    </div>
  );
}
