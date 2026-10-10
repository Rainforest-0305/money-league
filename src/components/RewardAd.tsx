import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasPlacement, rewardedSupported, runRewardedAd, type RewardSlotId } from '../lib/ads';
import { useStore } from '../store/hooks';

/**
 * 리워드 광고 «단일» 진입점 — 충전(4번)과 트레이더 열람(6번)이 이걸 같이 쓴다.
 *
 * ★ 왜 한 곳인가: 「끝까지 봤을 때만 보상」 조건을 화면마다 복붙하면 한쪽에서만
 *   어긋나 「안 보고도 받는」 버그가 두 배로 난다. 지급 판정은 lib/ads.ts 의
 *   runRewardedAd 하나, 상한 클램프는 엔진(gameWorld.grantAdReward) 하나다.
 *
 * ★ 광고는 «선택»이다. 이 훅은 버튼 하나만 제공하고, 안 보고 나갈 길은
 *   화면이 항상 따로 갖고 있어야 한다(막다른 골목 금지).
 */
/**
 * 리워드 «용도» → 지면 ID. ★매핑을 여기 «한 곳»에만 둔다.
 *
 * ★★[2026-09-05 실사고] 예전에는 호출부에서 `kind === 'topup' ? rewardTopup : rewardTraderView` 로
 *   «삼항»이 갈랐다. 그래서 새 용도(출석 2배)가 들어왔을 때 ★조용히 `rewardTopup` 으로 떨어졌다 —
 *   타입 에러도, 런타임 에러도 없었다. 출석 지면은 14일 내내 호출 0건이었고 아무도 몰랐다.
 *   ⇒ ★`Record` 로 바꾼다. 이제 kind 를 늘리면 ★여기서 컴파일이 깨진다. 그게 목적이다.
 */
const REWARD_SLOT: Record<RewardKind, RewardSlotId> = {
  topup: 'rewardTopup',
  view: 'rewardTraderView',
  attendance: 'rewardAttendance',
};

/**
 * 리워드 «경제». 보상이 어느 원장으로 들어가는가.
 *   'ad'     — 광고 경제(`grantAdReward`). 상한은 엔진이 씌운다(오늘 충전/열람 여유)
 *   'extern' — 광고 경제 «밖». 상한은 호출부 콜백이 스스로 씌운다
 *
 * ★출석 2배가 'extern' 인 이유: 보상이 「충전 1회」가 아니라 「오늘 출석분만큼 한 번 더」다.
 *   `grantAdReward('topup')` 을 타면 ⛔충전 광고 여유를 갉아먹고, 그게 차면 2배가 «아예 안 된다».
 *   상한은 `store.grantAttendanceDouble`(하루 1회 · lastDoubledDate)이 이미 갖고 있다.
 *   시즌 연장이 충전 경제를 안 타는 것과 같은 구조다.
 */
const REWARD_ECONOMY: Record<RewardKind, 'ad' | 'extern'> = {
  topup: 'ad',
  view: 'ad',
  attendance: 'extern',
};

export type RewardKind = 'topup' | 'view' | 'attendance';

export function useRewardAd(
  kind: RewardKind,
  /**
   * 보상이 «실제로 지급된 뒤» 할 일. 주면 성공 토스트를 이 훅이 «띄우지 않는다» —
   * 후속 동작(예: 충전 즉시 실행 → 완료 화면)이 자기 문구를 갖기 때문이다.
   * ★지급 판정(끝까지 봤는가)은 여전히 lib/ads.ts 한 곳뿐이다. 여기서 분기하지 않는다.
   */
  onGranted?: (given: number) => void | Promise<void>
) {
  const s = useStore();
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  /* ★지면 ID 가 «없으면»(미발급) 지원 여부와 무관하게 버튼을 그리지 않는다 — AdBanner 와 같은 규율.
     ⛔빈 ID 로 SDK 를 부르면 조용히 실패한다. 「죽은 버튼」을 남기지 않는 것이 이 한 줄의 값이다. */
  const supported = rewardedSupported() && hasPlacement(REWARD_SLOT[kind]);

  /*
   * ★[2026-09-12 · -34] «취소 신호» (Codex 리뷰 6번).
   *   [확인·SDK 모사] 로드는 최대 12초다. 그 사이에 유저가 출석 시트를 닫거나 다른 화면으로 가도
   *   옛 판은 그대로 광고를 띄웠다 — 「부르지도 않은 광고가 갑자기 뜬다」가 된다.
   *   ⇒ ① 이 훅이 «언마운트»되면(시트를 닫았다 = 버튼이 사라졌다) 취소한다.
   *      ② 요청할 때의 화면을 기억해 두고 «떠났으면» 취소한다.
   *   가시성(hidden) 재확인은 `runRewardedAd` 안에 있다 — 모든 호출부가 공짜로 얻는다.
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const screenAtRequest = typeof window === 'undefined' ? '' : (window.location.hash || '').split('?')[0];
    try {
      const r = await runRewardedAd(REWARD_SLOT[kind], {
        canShow: () => {
          if (!aliveRef.current) return 'left-screen';
          const now = typeof window === 'undefined' ? '' : (window.location.hash || '').split('?')[0];
          return now === screenAtRequest ? null : 'left-screen';
        },
      });
      if (r.ok) {
        /* ★광고 경제(충전·열람)만 엔진 상한을 지난다. 그 밖(출석 2배)은 콜백이 자기 상한을 갖는다.
           ⛔여기서 `grantAdReward` 를 무조건 부르면 출석이 충전 여유를 소비한다(그게 이번 배선 오류다). */
        const given =
          REWARD_ECONOMY[kind] === 'ad'
            ? s.grantAdReward(kind as 'topup' | 'view', r.unitAmount)
            : Math.max(1, Math.floor(r.unitAmount || 1));
        if (given > 0 && onGranted) {
          await onGranted(given);
        } else {
          s.pushToast(
            given > 0 ? (t('adRewardGot', { n: given }) as string) : (t('adRewardCapped') as string),
            given > 0 ? 'default' : 'error'
          );
        }
      } else if (r.reason === 'abandoned') {
        // 중도 이탈 — 보상 없음이 «정상»이다. 실패로 몰아붙이지 않는다.
        s.pushToast(t('adRewardAbandoned') as string, 'error');
      } else {
        s.pushToast(t('adRewardFailed') as string, 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [busy, kind, onGranted, s, t]);

  return { supported, busy, run };
}
