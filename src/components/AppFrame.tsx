import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Sheet } from './Primitives';
import { TabBar } from './TabBar';
import { SeasonGate } from './SeasonGate';
import { useRewardAd } from './RewardAd';
import { metaOf, useStore } from '../store/hooks';
import { money, signedMoney } from '../lib/format';
import { TOPUP_AMOUNT } from '../lib/constants';

/** 화면 전역 껍데기 — 탭바 + 토스트 + 강제청산 시트 */
export function AppFrame({ withTabs = true }: { withTabs?: boolean }) {
  const s = useStore();
  // 토스트가 번역된 문자열을 그대로 받으므로 여기서는 t() 가 필요 없다.

  return (
    <div className="app-shell">
      <Outlet />
      {withTabs && <TabBar />}
      {/* ★시즌 마감 게이트 — 어느 화면에 있든 덮는다(선택 전까지 거래 잠금). 토스트(z 90)보다 아래 */}
      {s.seasonLocked && s.session && s.onboarded && <SeasonGate />}
      <LiquidationSheet />
      {s.toasts.length > 0 && (
        <div className="toast-host" role="status" aria-live="polite">
          {/*
            토스트 text 는 **이미 번역된 문자열**이다(store.pushToast 계약).
            예전엔 `text.includes('.') ? t(text) : text` 로 키/문자열을 둘 다 받았는데,
            마침표가 들어간 카피가 들어오면 키로 오인해 깨지는 구조라 걷어냈다.
          */}
          {s.toasts.map((x) => (
            <div key={x.id} className={`toast ${x.tone === 'error' ? 'toast--err' : ''} ${x.action ? 'toast--act' : ''}`}>
              <span className="toast__txt">{x.text}</span>
              {/*
                되돌리기 버튼. toast-host 는 pointer-events:none 이라 버튼에서만
                다시 켠다 — 토스트가 화면 전체의 탭을 먹으면 그게 더 큰 방해다.
              */}
              {x.action && (
                <button
                  type="button"
                  className="toast__act"
                  onClick={() => {
                    x.action?.run();
                    s.dismissToast(x.id);
                  }}
                >
                  {x.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/*
 * [P1 제거 2026-08-05] ConnBanner 삭제.
 *
 * "연결이 끊겼어요 / 지금 보이는 값은 연습용 가짜 데이터입니다 / 지금 다시 연결"
 * 배너였다. 정적 단독 빌드에는 서버도 연결 상태도 없다 — 이 배너가 남아 있으면
 * 유저는 멀쩡한 게임을 고장으로 오해한다. 목업 7종 어디에도 없던 UI 이기도 하다.
 * (G2 확정) 되살리지 마라.
 */

/** 강제청산 시트 — 목업 04-D. 손실 금액을 첫 줄에 그대로 노출한다. */
function LiquidationSheet() {
  const s = useStore();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('derivatives');
  const ev = s.liquidation;

  /*
   * ★A1 — 「원하는 걸 못 가진 순간」의 정점에 «선택»을 둔다 (2026-08-20 Partner 승인).
   *   증거금이 방금 날아간 화면이다. 지금까지 여기엔 «닫기»밖에 없었다.
   * ★규율 (Partner 단서 그대로):
   *   ⛔「다시 도전!」 류 부추김 금지 — 청산은 «내 잘못»으로 읽힌다. 사실만 적는다.
   *   ⛔강권 톤 금지 — 「그냥 닫기」를 «같은 크기»로 둔다. 광고는 언제나 선택이다.
   *   ★광고가 안 되는 환경(웹·구버전)에서는 «버튼 자체가 안 뜬다» — 죽은 버튼을 남기지 않는다.
   * ★지급은 기존 doTopup('ad') 경로 — topupCount 가 반드시 오른다(새 지급로 없음).
   */
  const ad = useRewardAd('topup', async () => {
    try {
      const amount = await s.doTopup('ad');
      s.pushToast(t('recharge:toppedUp', { v: money(amount, 0) }) as string);
    } catch {
      s.pushToast(t('common:err.GENERIC') as string, 'error');
    }
  });
  const adRemaining = s.topup?.adRemaining ?? 0;
  const canAd = ad.supported && adRemaining > 0;

  if (!ev) return null;

  const m = metaOf(ev.ticker);
  const name = i18n.language === 'en' ? m.nameEn : m.nameKo;
  const sideWord =
    ev.side === 'long' ? t('longX', { x: ev.leverage }) : t('shortX', { x: ev.leverage });

  return (
    <Sheet onClose={() => s.dismissLiquidation()} labelledBy="liq-title">
      <div
        style={{
          width: 78,
          height: 78,
          borderRadius: '50%',
          background: 'var(--down-weak)',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto',
          color: 'var(--down-ink)',
        }}
        aria-hidden
      >
        {Icon.drop(36)}
      </div>
      <h2
        id="liq-title"
        style={{ fontSize: 24, fontWeight: 800, textAlign: 'center', marginTop: 18, letterSpacing: '-0.03em', whiteSpace: 'pre-line' }}
      >
        {t('liqTitle', { name, side: sideWord })}
      </h2>
      <p style={{ fontSize: 15, color: 'var(--t3)', textAlign: 'center', marginTop: 10, lineHeight: 1.55, whiteSpace: 'pre-line' }}>
        {t('liqSub', { v: money(s.priceOf(ev.ticker)) })}
      </p>

      <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 22 }}>
        <div className="kv">
          <span className="kv__k">{t('lostMargin')}</span>
          <span className="kv__v num down">{signedMoney(-Math.abs(ev.loss))}</span>
        </div>
        <div className="divider" />
        <div className="kv">
          <span className="kv__k">{t('liqPriceRow')}</span>
          <span className="kv__v num">{money(s.priceOf(ev.ticker))}</span>
        </div>
        <div className="divider" />
        <div className="kv kv--strong">
          <span className="kv__k">{t('leftTotal')}</span>
          <span className="kv__v num">{money(s.portfolio?.equity ?? ev.equityAfter)}</span>
        </div>
      </div>

      {/*
        ★[제거 2026-08-20] 청산 직후 「💡 배율이 높을수록 조금만 움직여도 청산돼요…」 훈계 문단.
          이미 잃은 사람에게 «왜 잃었는지 강의»하는 자리였다. 같은 화면의 위쪽이
          손실 금액·청산가·남은 자산을 «숫자»로 이미 말하고 있다 — 그게 정보고, 이건 잔소리였다.
          설명 카드 전수 정리(President 4번)에 함께 포함.
      */}

      {canAd && (
        <button
          className="btn btn--gold"
          style={{ marginTop: 18 }}
          disabled={ad.busy}
          onClick={() => void ad.run()}
        >
          {t('recharge:adCta', { v: money(TOPUP_AMOUNT, 0) })}
          <span className="btn__sub">
            {ad.busy ? t('common:loading') : t('recharge:adLeft', { n: adRemaining, v: money(TOPUP_AMOUNT, 0) })}
          </span>
        </button>
      )}
      <button className="btn btn--ink" style={{ marginTop: canAd ? 8 : 18 }} onClick={() => s.dismissLiquidation()}>
        {t('liqOk')}
      </button>
      <button
        className="btn btn--ghost"
        onClick={() => {
          s.dismissLiquidation();
          nav('/derivatives');
        }}
      >
        {t('liqHistory')}
      </button>
    </Sheet>
  );
}
