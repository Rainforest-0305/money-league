import { useTranslation } from 'react-i18next';
import { useRewardAd } from './RewardAd';
import { hasPlacement, rewardedSupported } from '../lib/ads';
import { useStore } from '../store/hooks';

/**
 * 출석 보상 «추가 지급(광고)» — 선택형 버튼 한 개 (2026-09-10 · -33 · President 승인 전략 2-2).
 *
 * ── 왜 이 컴포넌트가 생겼나 [실측] ────────────────────────────────────────────
 *   출석 전용 지면(rewardAttendance · 콘솔 2026-08-22 생성)이 «노출 0» 이었다. 배선은 09-05(-31)에 고쳐졌는데
 *   ★버튼이 «충전 화면의 소진(exhausted) 단계»에만 있었고, 토스 안에서는 광고 충전 여유(하루 10회)가 남아 있는 한
 *   phase 가 'ad' 로 빠져 그 단계에 «도달 자체가 안 됐다». 홈 출석 시트는 재열람 전용이라 버튼이 없었다.
 *   ⇒ 「버튼이 있는 자리에 유저가 못 간다」가 0노출의 원인이다. 이제 버튼은 «출석표가 보이는 두 자리»(홈 시트·충전 카드)에
 *     같은 규칙으로 놓인다.
 *
 * ── 규칙 (전략 원문 「홈 진입 즉시 자동 재생하지 말고, 첫 거래 또는 첫 포트폴리오 확인 뒤 사용자가 선택」) ──
 *   · 기본 출석 보상은 지금처럼 부팅 때 «광고 없이» 자동 지급된다(store.claimAttendance). 이 버튼은 그 «위에 얹는» 것이다.
 *   · 그린다 = 토스 안 ∧ 지면 있음 ∧ 오늘 기본 보상 지급됨 ∧ 오늘 아직 안 받음.
 *   · 그중 「이 세션에서 첫 체결 또는 포트폴리오 화면 확인」(store.attendBonusUnlocked) 전이면 버튼 대신 «한 줄 힌트».
 *   · 하루 1회 = 기존 원장 `ml.attendance.lastDoubledDate`(store.grantAttendanceDouble) — 새 키·새 규칙 없음.
 *   · 토스 밖·지면 없음·이미 받음 → «아무것도 그리지 않는다»(빈 래퍼 0).
 *   · 광고를 «틀지» 않는다. 누른 뒤에만 로드→재생(useRewardAd → runRewardedAd) = 프리로드 0.
 */
export type AttendanceBonusState =
  /** 그리지 않는다 — 토스 밖 · 지면 없음 · 오늘 기본 보상 미지급 · 이미 받음 */
  | 'hidden'
  /** 해제 전 — 힌트 한 줄만 */
  | 'locked'
  /** 버튼을 그린다 */
  | 'ready';

/**
 * 버튼 «상태»만 읽는 훅 — 부모(홈 시트)가 버튼 «옆» 요소의 위계를 정하는 데 쓴다.
 * ★판정은 컴포넌트와 «같은 식»이어야 한다 — 그래서 컴포넌트가 이 훅을 그대로 쓴다(두 벌 금지).
 * ⛔`useRewardAd` 를 여기서 부르지 않는다(훅이 광고 훅을 두 번 만들면 busy 상태가 갈린다). supported 판정만 같은 함수로.
 */
export function useAttendanceBonusState(): AttendanceBonusState {
  const s = useStore();
  const supported = rewardedSupported() && hasPlacement('rewardAttendance');
  const claimedToday = !s.attendanceToday().claimable && s.attendance.state.lastClaimedDate !== null;
  if (!supported || !claimedToday || s.attendanceDoubledToday()) return 'hidden';
  return s.attendBonusUnlocked ? 'ready' : 'locked';
}

export function AttendanceBonus() {
  const s = useStore();
  const { t } = useTranslation('recharge');
  const state = useAttendanceBonusState();
  const ad = useRewardAd('attendance', async () => {
    /* ⛔0 이면 «조용히» 끝내지 마라 — 광고를 끝까지 본 유저가 아무 반응도 못 받는다.
       (렌더와 클릭 사이에 자정이 지나 «오늘 기본 보상»이 없어졌을 수 있다 — 그 창을 있는 그대로 다룬다) */
    if (s.grantAttendanceDouble() <= 0) s.pushToast(t('common:adRewardCapped') as string, 'error');
  });
  /* ★`ad.supported` 는 훅의 supported 와 같은 함수(rewardedSupported·hasPlacement)에서 나온다 — 둘이 갈릴 수 없다 */
  if (state === 'hidden' || !ad.supported) return null;
  if (state === 'locked') {
    /* ★해제 전 — 광고 얘기를 «강권»하지 않는다. 무엇을 하면 열리는지 한 줄만 */
    return (
      <p className="hint attline" style={{ marginTop: 12 }}>
        {t('attendBonusLocked')}
      </p>
    );
  }
  return (
    <button type="button" className="btn btn--sub" style={{ marginTop: 14 }} disabled={ad.busy} onClick={() => void ad.run()}>
      {t('attendDouble')}
      <span className="btn__sub">{ad.busy ? t('common:loading') : t('attendDoubleSub')}</span>
    </button>
  );
}
