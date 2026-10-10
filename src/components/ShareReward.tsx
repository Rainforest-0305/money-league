import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runShareReward, shareRewardAvailable, shareRewardUsd } from '../lib/share';
import { useStore } from '../store/hooks';

/**
 * 공유 리워드 «단일» 진입점 — 화면은 이 훅만 쓴다.
 *
 * ★ 왜 한 곳인가 (useRewardAd 와 같은 이유):
 *   「어떤 이벤트에서 지급하는가」를 화면마다 복붙하면 한쪽에서만 어긋나
 *   「공유 안 해도 받는」 버그가 화면 수만큼 난다. 지급 판정은 `lib/share.ts` 하나,
 *   상한·중복방지는 엔진(`gameWorld.grantShareReward`) 하나다.
 *
 * ★ `available` 이 false 면 화면은 ★«아무것도 렌더하지 않는다» —
 *   버튼도, 여백을 가진 래퍼도 두지 않는다(인계문서 X-2 ⛔7 「래퍼는 남는다」).
 *   리워드 ID 미발급·토스 밖·구버전이 전부 여기로 모인다.
 *
 * ⛔`useEffect` 안에서 `run()` 을 부르지 마라 — StrictMode 가 두 번 실행한다.
 *   반드시 «사용자 탭»에서만 부른다.
 */
export function useShareReward() {
  const s = useStore();
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  /** 열려 있는 모듈의 cleanup. 화면을 떠나면 반드시 해제한다(공식 문서 명시 요건) */
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      releaseRef.current?.();
      releaseRef.current = null;
    },
    []
  );

  const run = useCallback(() => {
    if (busy) return;
    setBusy(true);
    releaseRef.current = runShareReward({
      /*
       * ★공유 «1건»마다 온다. ⛔한 번만 온다고 가정하지 마라 —
       *   SDK 타입이 `sendableRewardsCount`(아직 공유할 수 있는 친구 수)를 들고 있다.
       *   상한은 엔진이 하루 단위로 잡는다. 여기서 세지 않는다.
       */
      onReward: (e) => {
        /*
         * ★★수량을 «그대로» 달러로 더하지 않는다. 단위를 먼저 «해석»한다.
         *   콘솔 단위는 자유 문자열이라 「충전권 10」·「보석 500만」도 올 수 있고,
         *   그걸 그대로 더하면 ★조용히 틀린 금액이 잔고에 들어간다.
         * ★모르는 단위면 `shareRewardUsd` 가 null 을 준다 = ⛔지급하지 않는다.
         *   그리고 «사실대로» 말한다 — 토스는 이미 유저에게 리워드를 보여 줬으므로
         *   아무 말 없이 넘어가면 유저는 「받았는데 안 늘었다」만 겪는다.
         */
        const usd = shareRewardUsd(e);
        if (usd === null) {
          s.pushToast(t('toast.shareRewardUnknown') as string, 'error');
          return;
        }
        s.grantShareReward(usd);
      },
      onClose: () => {
        setBusy(false);
        releaseRef.current = null;
      },
      onError: () => {
        /*
         * ★여기로 오는 대표 경우가 ★「리워드 ID 가 틀렸거나 미등록」이다
         *   (공식 문서: 미승인 미니앱에서 호출하면 Internal Server Error).
         *   ⇒ 앱은 죽지 않고, 잔고는 건드려지지 않으며, 화면은 그대로다.
         *   ⛔경고창을 새로 만들지 않는다 — 기존 공용 문구 하나로 끝낸다.
         */
        s.pushToast(t('err.GENERIC') as string, 'error');
        setBusy(false);
        releaseRef.current = null;
      },
    });
  }, [busy, s, t]);

  return { available: shareRewardAvailable(), busy, run };
}
