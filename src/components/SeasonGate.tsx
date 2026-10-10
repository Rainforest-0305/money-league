import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Primitives';
import { useStore } from '../store/hooks';
import { adPreviewMode, hasPlacement, rewardedSupported, runInterstitialAd, runRewardedAd } from '../lib/ads';
import { bigMoney, money, signedPct } from '../lib/format';
import { myRankAxes } from '../lib/rank';
import { SEED_CASH } from '../lib/constants';

/**
 * 시즌 마감 «선택» 화면 — ★자동으로 아무것도 하지 않는다 (2026-08-29 President 지시).
 *
 *   「시즌 마감 때에는 자동으로 새 시즌 시작하지 말고 시즌을 연장할지 선택하도록 해.
 *    시즌 연장하려면 리워드형 광고 나오게 만들어.」
 *
 * ★두 선택지가 «같은 층»이다 — 광고는 «선택»이지 강권이 아니다(토스 정책 「과도한 시청 유도 금지」).
 *   (a) 광고 보고 1주 연장 — 끝까지 봤을 때만(`userEarnedReward`). 자산·포지션·순위 그대로
 *   (b) 새 시즌 시작       — $10,000 으로 다시. 시장·봇·닉네임은 그대로
 * ★광고가 «안 되는» 환경(웹·구버전·지면 미반영)에서는 (a)가 «아예 안 그려진다» — 죽은 버튼을 남기지 않는다.
 *   광고가 실패·중도 이탈하면 토스트로 말하고 «이 화면에 남는다»(다시 시도하거나 새 시즌으로).
 * ★선택 전까지 시장은 정지, 주문은 전부 거절(store.assertSeasonOpen). 이 화면이 그 사실을 «말한다».
 * ⛔blur·backdrop-filter 없음. 단색 --bg 로 덮는다(부팅 화면과 같은 재질).
 * ★`rewardTopup`·`grantAdReward`(충전 경제)를 «타지 않는다» — 보상은 「마감 +7일」이지 현금이 아니다.
 */
export function SeasonGate() {
  const s = useStore();
  const { t } = useTranslation('rank');
  const [busy, setBusy] = useState(false);
  /* ★로컬 실렌더(ads.preview)에서는 버튼을 «그려만» 준다 — 레이아웃 검증용. 실행하면 unsupported 토스트다 */
  const canAd = (rewardedSupported() && hasPlacement('rewardSeasonExtend')) || adPreviewMode();

  const p = s.portfolio;
  const equity = p?.equity ?? 0;
  const base = p?.investedBase ?? SEED_CASH;
  const pnlPct = base > 0 ? (equity / base - 1) * 100 : 0;
  const axes = myRankAxes(s.ranks, s.myAccountId);

  const extend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await runRewardedAd('rewardSeasonExtend');
      if (r.ok) {
        s.extendSeason();
        s.pushToast(t('seasonExtended'));
      } else if (r.reason === 'abandoned') {
        s.pushToast(t('common:adRewardAbandoned'), 'error');
      } else {
        /* 지원 안 함·로드 실패·노출 실패 — 조용히 폴백: 여기 남고 「새 시즌 시작」은 언제나 열려 있다 */
        s.pushToast(t('common:adRewardFailed'), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * ★★전면 광고 삽입 지점 (b) — 「새 시즌 시작」 탭 → 새 시즌 홈 진입 사이.
   *
   *   여기를 고른 이유: 시즌 «끝»이라 진행 중인 조작이 없고, 이 화면은 이미 게임이 멈춰 있다
   *   (`store.assertSeasonOpen` 이 주문을 전부 거절 중). 흐름을 끊을 흐름 자체가 없다.
   * ⛔「시즌 연장」(`extend`)에는 ★붙이지 않는다 — 거긴 이미 리워드 광고를 본 경로다.
   * ⛔광고 성패와 무관하게 ★반드시 새 시즌으로 간다. `finally` 가 그 계약이다.
   * ★순서가 중요하다: 광고 «먼저», `startNewSeason()` 은 그 다음.
   *   `startNewSeason()` 이 `seasonLocked` 를 풀면 이 컴포넌트가 곧바로 언마운트돼서
   *   그 뒤에 광고를 부르면 부를 주체가 사라진다.
   */
  const restart = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runInterstitialAd('interstitialMain');
    } finally {
      s.startNewSeason();
      s.pushToast(t('seasonRestarted', { v: money(SEED_CASH, 0) }));
      setBusy(false);
    }
  };

  return (
    <div className="seasongate" role="dialog" aria-modal="true" aria-labelledby="season-title">
      <div className="scroll seasongate__body">
        <span className="seasongate__ic" aria-hidden>
          {Icon.trophy}
        </span>
        <h2 id="season-title" className="seasongate__title">
          {t('seasonEndedTitle')}
        </h2>
        <p className="seasongate__sub">{t('seasonEndedSub')}</p>

        <div className="card card--sub seasongate__card">
          <div className="kv kv--strong">
            <span className="kv__k">{t('seasonFinalEquity')}</span>
            <span className="kv__v num">{bigMoney(equity)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('seasonFinalReturn')}</span>
            <span className={`kv__v num ${pnlPct >= 0 ? 'up' : 'down'}`}>{signedPct(pnlPct, 1)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('seasonFinalRank')}</span>
            <span className="kv__v num">
              {axes ? t('myTwoAxis', { equity: axes.equityRank, ret: axes.returnRank }) : t('unknown')}
            </span>
          </div>
        </div>
      </div>

      <div className="cta">
        {canAd && (
          <button type="button" className="btn btn--gold" disabled={busy} onClick={() => void extend()}>
            {t('seasonExtendCta')}
            <span className="btn__sub">{busy ? t('common:loading') : t('seasonExtendSub')}</span>
          </button>
        )}
        <button type="button" className={canAd ? 'btn btn--sub' : 'btn btn--primary'} disabled={busy} onClick={() => void restart()}>
          {t('seasonNewCta')}
          {/* ★기다리는 동안 «무엇이» 일어나는지 화면이 말한다. 빈 정지 화면이 가장 나쁜 상태다 */}
          <span className="btn__sub">{busy ? t('common:loading') : t('seasonNewSub', { v: money(SEED_CASH, 0) })}</span>
        </button>
      </div>
    </div>
  );
}
