import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Icon, Sheet } from '../components/Primitives';
import { useStore } from '../store/hooks';
import { AdBanner } from '../components/AdBanner';
import { useShareReward } from '../components/ShareReward';
import { setLanguage } from '../i18n';
import { enablePush, usePushState } from '../toss/pushAgreement';
import { money, pct } from '../lib/format';
import { myRankAxes } from '../lib/rank';
import {
  APP_VERSION,
  BANKRUPT_EQUITY_THRESHOLD,
  FEE_LEVERAGE_BP,
  ORDER_FLOW_WEIGHT,
  FEE_OPTION_BP,
  FEE_SPOT_BP,
  FUNDING_BP_PER_GAME_DAY,
  SEED_CASH,
  TOPUP_COOLDOWN_MS,
  TOPUP_DAILY_LIMIT,
} from '../lib/constants';

type SheetKind = 'lang' | 'theme' | 'updown' | 'rules' | null;

export function Settings() {
  const s = useStore();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('settings');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const lang = i18n.language === 'en' ? 'en' : 'ko';

  const meId = s.myAccountId;
  /*
   * 프로필 한 줄도 «자산 / 수익률» 두 축이다(Partner 판정 2026-08-05).
   * 이전에는 "전체 N위 · 사람 중 M위" 였는데, 싱글 빌드에서 사람은 나 하나라
   * 뒤쪽이 항상 "1위" 로 고정된 무의미한 값이었다 — 실유저 랭킹 별도 노출 제거분.
   */
  const axes = myRankAxes(s.ranks, meId);
  const topupLeft = s.topup?.remainingToday ?? TOPUP_DAILY_LIMIT;
  /* ★공유 리워드. `available` 이 false 면 아래 행이 통째로 안 그려진다(빈 자리 0) */
  const share = useShareReward();
  const shareLeft = s.daily?.shareLeft ?? 0;
  /* ★토스 푸시 동의(2026-09-10). `available` 이 false(토스 밖)면 「알림」 그룹이 통째로 안 그려진다 */
  const push = usePushState();

  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar">
        <span className="appbar__big">{t('title')}</span>
      </div>

      <div className="scroll">
        {/* 프로필 */}
        <div style={{ padding: '0 20px 18px' }}>
          <button
            className="card"
            style={{ width: '100%', padding: 18, display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left' }}
            onClick={() => meId && nav(`/trader/${meId}`)}
          >
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'var(--brand)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 20,
                fontWeight: 800,
                flex: '0 0 auto',
              }}
              aria-hidden
            >
              {(s.session?.nickname ?? '?').slice(0, 1)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}>
                {s.session?.nickname}
              </span>
              <span className="num" style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                {axes
                  ? t('rankLine', { all: axes.equityRank, ret: axes.returnRank })
                  : t('rankLineUnranked')}
              </span>
            </span>
            {Icon.chevron}
          </button>
          {/* 정적 단독 빌드에는 서버가 없다 — 연결 상태 분기도 없다(store.dataSource 삭제됨) */}
          <p className="hint" style={{ marginTop: 8, paddingLeft: 4 }}>
            {t('connMock')}
          </p>
        </div>

        {/* 화면 — 언어가 최상단 첫 행 */}
        <div className="grp">
          <div className="grp__t">{t('grpDisplay')}</div>
          <div className="card" style={{ padding: '2px 0' }}>
            <button className="li" onClick={() => setSheet('lang')}>
              <span className="li__ic" style={{ background: 'var(--brand-weak)', color: 'var(--brand-ink)' }} aria-hidden>
                {Icon.globe}
              </span>
              {t('language')}{' '}
              <span style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 600, marginLeft: 4 }}>{t('languageAlt')}</span>
              <span className="li__val">
                {lang === 'ko' ? t('langKoName') : t('langEnName')} {Icon.chevron}
              </span>
            </button>
            <div className="divider" style={{ marginLeft: 58 }} />
            <button className="li" onClick={() => setSheet('theme')}>
              <span className="li__ic" style={{ background: 'var(--surface-2)', color: 'var(--t2)' }} aria-hidden>
                {Icon.moon}
              </span>
              {t('theme')}
              <span className="li__val">
                {t(s.settings.theme === 'system' ? 'themeSystem' : s.settings.theme === 'dark' ? 'themeDark' : 'themeLight')}{' '}
                {Icon.chevron}
              </span>
            </button>
            <div className="divider" style={{ marginLeft: 58 }} />
            <button className="li" onClick={() => setSheet('updown')}>
              <span className="li__ic" style={{ background: 'var(--up-weak)', color: 'var(--up-ink)' }} aria-hidden>
                {Icon.palette}
              </span>
              {t('upColor')}
              <span className="li__val">
                {t(s.settings.updown === 'us' ? 'upColorUs' : 'upColorKr')} {Icon.chevron}
              </span>
            </button>
          </div>
        </div>

        {/*
          ★알림 (2026-09-10 신설 · President 「푸시 개통」).
            2026-08-20 에 걷어낸 옛 스위치 3종과 «다르다»: 이건 실제로 알림이 가는 배선이다
            (토스 콘솔 기능성 정기 발송 ↔ requestNotificationAgreement · toss/pushAgreement.ts).
          ★행은 «켜기» 하나다. 끄기 스위치를 두지 않는 이유는 pushAgreement.ts 하단 주석(철회 API 부재).
          ★토스 밖(`push.available` false)이면 그룹이 «통째로» 사라진다 — 빈 래퍼를 남기지 않는다(공유 리워드 행과 같은 규칙).
        */}
        {push.available && (
          <div className="grp">
            <div className="grp__t">{t('grpNotify')}</div>
            <div className="card" style={{ padding: '2px 0' }}>
              <button className="li" disabled={push.busy} onClick={() => void enablePush()} aria-busy={push.busy}>
                <span className="li__ic" style={{ background: 'var(--brand-weak)', color: 'var(--brand-ink)' }} aria-hidden>
                  {Icon.bell}
                </span>
                {t('notifyRank')}
                <span className="li__val">
                  <span
                    style={{
                      color: push.enabled ? 'var(--up-ink)' : 'var(--brand)',
                      fontWeight: 800,
                    }}
                  >
                    {push.busy
                      ? t('notifyBusy')
                      : push.enabled
                        ? t('notifyOn')
                        : push.availability === 'rejected'
                          ? t('notifyRetry')
                          : t('notifyGet')}
                  </span>{' '}
                  {Icon.chevron}
                </span>
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8, paddingLeft: 4 }}>
              {push.error ? t('notifyError') : t('notifyHint')}
            </p>
          </div>
        )}

        {/*
          ★[제거 2026-08-20] 「알림」 그룹(청산 위험 알림 · 순위가 바뀔 때 · 소리와 진동) 3종.

          ★사유: ★셋 다 «동작하지 않았다». 전수 확인 결과 이 앱에는
            new Audio 0 · AudioContext 0 · navigator.vibrate 0 · Notification API 0 ·
            토스 알림 배선 0 건이다. 스위치는 값을 «저장만» 하고 아무도 그 값을 읽지 않았다
            (실측: notifyLiquidation/notifyRank/sound 의 참조처는 스위치 자기 자신뿐).
          ★왜 «숨기는» 쪽인가: 실제로 동작하게 만들려면 알림 채널이 필요하고 그건 이번 범위 밖이다.
            그동안 「켰는데 안 온다」를 두는 것이 더 나쁘다 — 유저는 «앱이 약속을 안 지킨다»고 배운다.
          ★되살리려면 «알림이 실제로 가는 것»을 먼저 만들고 그 다음에 스위치를 붙여라. 순서가 반대면 또 거짓말이다.
          ★설정값(ml.settings)의 옛 키는 그대로 남아 있어도 무해하다 — 아무도 안 읽는다.
        */}

        {/* 게임 */}
        <div className="grp">
          <div className="grp__t">{t('grpGame')}</div>
          <div className="card" style={{ padding: '2px 0' }}>
            <button className="li" onClick={() => nav('/recharge')}>
              <span className="li__ic" style={{ background: 'var(--brand-weak)', color: 'var(--brand-ink)' }} aria-hidden>
                {Icon.battery}
              </span>
              {t('freeTopup')}
              <span className="li__val">
                <span className="num" style={{ color: 'var(--brand)', fontWeight: 800 }}>
                  {t('leftToday', { n: topupLeft })}
                </span>{' '}
                {Icon.chevron}
              </span>
            </button>
            {/*
              ★공유 리워드 — ★«행 자체»가 조건부다. 리워드 ID 미발급·토스 밖·구버전이면
                divider 까지 «통째로» 사라진다.
              ⛔여백을 가진 래퍼로 감싸지 마라: 안이 null 이어도 «래퍼는 남아»
                설정 카드 한가운데에 빈 상자가 생긴다(인계문서 X-2 ⛔7 의 실측 결함).
              ⛔금액을 문구에 박지 않는다 — 지급 수량은 앱인토스 콘솔 설정값이다.
            */}
            {share.available && (
              <>
                <div className="divider" style={{ marginLeft: 58 }} />
                <button className="li" disabled={share.busy} onClick={share.run}>
                  <span className="li__ic" style={{ background: 'var(--brand-weak)', color: 'var(--brand-ink)' }} aria-hidden>
                    {Icon.share(20)}
                  </span>
                  {t('shareReward')}
                  <span className="li__val">
                    <span className="num" style={{ color: 'var(--brand)', fontWeight: 800 }}>
                      {t('leftToday', { n: shareLeft })}
                    </span>{' '}
                    {Icon.chevron}
                  </span>
                </button>
              </>
            )}
            <div className="divider" style={{ marginLeft: 58 }} />
            {/* ★[2026-08-21] «정보 행» → «여는 행». 열 화면(/journal)이 생겼으므로
                셰브런을 단다 — 어포던스와 동작이 일치해야 한다(그 반대도 마찬가지다). */}
            <button className="li" onClick={() => nav('/journal')}>
              <span className="li__ic" style={{ background: 'var(--surface-2)', color: 'var(--t2)' }} aria-hidden>
                {Icon.receipt}
              </span>
              {t('history')}
              <span className="li__val">
                <span className="num">{t('historyCount', { n: s.portfolio?.tradeCount ?? 0 })}</span> {Icon.chevron}
              </span>
            </button>
            <div className="divider" style={{ marginLeft: 58 }} />
            <button className="li" onClick={() => setSheet('rules')}>
              <span className="li__ic" style={{ background: 'var(--surface-2)', color: 'var(--t2)' }} aria-hidden>
                {Icon.book}
              </span>
              {t('rules')}
              <span className="li__val">{Icon.chevron}</span>
            </button>
          </div>
        </div>

        {/*
          ★[이동 2026-08-21, President 지시] 「내정보 배너를 계정 카드 «위»에 배치」.
            이전 자리는 화면 «최하단»(버전 표기 아래)이라 끝까지 내려야 보였다.
          ⛔바로 아래가 「로그아웃」이라 ★간격을 넉넉히 둔다 — 오탭이 «계정 초기화»로
            이어지는 자리다(구글 AdMob: 배너를 상호작용 버튼 옆에 두지 말 것).
        */}
        <AdBanner slot="bannerSettings" style={{ margin: '4px 20px 40px' }} />

        {/* 계정 */}
        <div className="grp">
          <div className="grp__t">{t('grpAccount')}</div>
          <div className="card" style={{ padding: '2px 0' }}>
            <button
              className="li"
              onClick={() => {
                s.signOut();
                nav('/start', { replace: true });
              }}
            >
              <span className="li__ic" style={{ background: 'var(--surface-2)', color: 'var(--t2)' }} aria-hidden>
                {Icon.exit}
              </span>
              {t('signOut')}
              <span className="li__val">{Icon.chevron}</span>
            </button>
          </div>
        </div>

        <div style={{ padding: '0 24px 8px' }}>
          <p className="hint">
            <Trans i18nKey="settings:disclaimer" components={{ b: <b /> }} />
          </p>
          {/*
            ★개인정보처리방침 링크 (2026-08-22 신설).
            ★«상대경로»다 — privacy.html 은 모든 배포본에 동봉된다
              (vite.config.ts 의 AIT_PUBLIC_ALLOWLIST 에 넣었다).
              ⇒ 오프라인에서도 열리고, GH Pages 업로드에 종속되지 않는다.
            ⛔target="_blank" 를 쓰지 않는다 — 토스 웹뷰에서는 팝업이 막혀
              «아무 일도 안 일어나는» 죽은 링크가 될 수 있다. 같은 탭 이동이
              어느 채널에서든 확실하고, 뒤로가기로 돌아온다.
              (진행 상황은 pagehide 에서 저장된다 — 나갔다 와도 안 날아간다)
            ★탭 타겟 24 CSS px 보장(WCAG 2.2 AA · ⛔44은 iOS 기준이라 안 쓴다).
            ⛔광고(bannerSettings)와 떨어뜨려 둔다 — 사이에 계정 카드 전체가 있다.
          */}
          <a
            className="hint"
            href="./privacy.html"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 24,
              marginTop: 6,
              color: 'var(--t2)',
              textDecoration: 'underline',
            }}
          >
            {t('privacyPolicy')}
          </a>
          <p className="num hint" style={{ marginTop: 10 }}>
            {t('version', { v: APP_VERSION })}
          </p>
        </div>

        {/*
          설정 화면 배너 — ★[이동 2026-08-20] 「계정」 카드 «바로 밑」 → ★고지문 «아래».
          ★사유 2건(실측):
            ① 「알림」 그룹 3종을 걷어내면서 화면이 ~180px 짧아졌고, 그 결과 배너가
               top=700 (보이는 높이 710)으로 ★«첫 화면 안»에 들어왔다. 내가 만든 회귀다.
            ② 바로 위가 ★「로그아웃」 버튼이었고 간격이 ★19px 뿐이었다 —
               오탭이 «계정 초기화»로 이어질 수 있는 자리라 가장 나쁜 조합이다.
          ⇒ 고지문 아래로 내리면 위쪽 탭 요소와 «문단 하나» 이상 떨어지고, 스크롤도 더 필요해진다.
        */}
        <div className="scroll-pad" />
      </div>

      {/* ── 언어 선택 시트 ─────────────────────────────────────────── */}
      {sheet === 'lang' && (
        <Sheet onClose={() => setSheet(null)} labelledBy="lang-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
            <span style={{ display: 'grid', placeItems: 'center', color: 'var(--brand-ink)' }} aria-hidden>
              {Icon.globe}
            </span>
            <h2 id="lang-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {t('langSheetTitle')}
            </h2>
          </div>
          <p style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 20 }}>{t('langSheetSub')}</p>

          <button className={`opt ${lang === 'ko' ? 'is-on' : ''}`} onClick={() => setLanguage('ko')}>
            {/*
              ★국기 이모지를 «언어» 표시로 쓰지 않는다 — 언어와 국가는 같지 않고
                (영어는 미국만 쓰지 않는다), 이모지는 기기마다 다르게 그려진다.
              ⇒ 그 언어의 «글자»로 쓴다. 아무 데서나 같게 보이고 뜻도 더 정확하다.
            */}
            <span className="langmark" aria-hidden>
              가
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 800 }}>{t('langKoName')}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)' }}>{t('langKoSub')}</span>
            </span>
            <span className={`radio ${lang === 'ko' ? 'is-on' : ''}`} />
          </button>
          <button className={`opt ${lang === 'en' ? 'is-on' : ''}`} onClick={() => setLanguage('en')}>
            <span className="langmark" aria-hidden>
              A
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 800 }}>{t('langEnName')}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)' }}>{t('langEnSub')}</span>
            </span>
            <span className={`radio ${lang === 'en' ? 'is-on' : ''}`} />
          </button>

          {/* 양쪽 미리보기 카드 */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 16, padding: '14px 16px', marginTop: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', marginBottom: 9 }}>{t('preview')}</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <PreviewCard active={lang === 'ko'} title="총 자산" today="오늘 +2.57%" cta="사기" ctaOn={lang === 'ko'} />
              <PreviewCard active={lang === 'en'} title="Total value" today="Today +2.57%" cta="Buy" ctaOn={lang === 'en'} />
            </div>
          </div>

          <button className="btn btn--primary" style={{ marginTop: 18 }} onClick={() => setSheet(null)}>
            {t('applyLang')}
          </button>
        </Sheet>
      )}

      {/* ── 테마 시트 ─────────────────────────────────────────────── */}
      {sheet === 'theme' && (
        <Sheet onClose={() => setSheet(null)} labelledBy="theme-title">
          <h2 id="theme-title" style={{ fontSize: 20, fontWeight: 800, marginBottom: 18 }}>
            {t('theme')}
          </h2>
          {(['system', 'light', 'dark'] as const).map((k) => (
            <button
              key={k}
              className={`opt ${s.settings.theme === k ? 'is-on' : ''}`}
              onClick={() => {
                s.setSettings({ theme: k });
                setSheet(null);
              }}
            >
              <span style={{ display: 'grid', placeItems: 'center', color: 'var(--t2)' }} aria-hidden>
                {k === 'system' ? Icon.gear(20) : k === 'light' ? Icon.sun(20) : Icon.moon}
              </span>
              <span style={{ fontSize: 16, fontWeight: 800 }}>
                {t(k === 'system' ? 'themeSystem' : k === 'light' ? 'themeLight' : 'themeDark')}
              </span>
              <span className={`radio ${s.settings.theme === k ? 'is-on' : ''}`} />
            </button>
          ))}
        </Sheet>
      )}

      {/* ── 오를 때 색 시트 ───────────────────────────────────────── */}
      {sheet === 'updown' && (
        <Sheet onClose={() => setSheet(null)} labelledBy="ud-title">
          <h2 id="ud-title" style={{ fontSize: 20, fontWeight: 800, marginBottom: 18 }}>
            {t('upColor')}
          </h2>
          {(['kr', 'us'] as const).map((k) => (
            <button
              key={k}
              className={`opt ${s.settings.updown === k ? 'is-on' : ''}`}
              onClick={() => {
                s.setSettings({ updown: k });
                setSheet(null);
              }}
            >
              <span
                style={{ width: 22, height: 22, borderRadius: 6, background: k === 'kr' ? '#F5334F' : '#00B26B' }}
                aria-hidden
              />
              <span style={{ fontSize: 16, fontWeight: 800 }}>{t(k === 'kr' ? 'upColorKr' : 'upColorUs')}</span>
              <span className={`radio ${s.settings.updown === k ? 'is-on' : ''}`} />
            </button>
          ))}
        </Sheet>
      )}

      {/* ── 규칙·수수료 시트 ─────────────────────────────────────── */}
      {sheet === 'rules' && (
        <Sheet onClose={() => setSheet(null)} labelledBy="rules-title">
          <h2 id="rules-title" style={{ fontSize: 20, fontWeight: 800, marginBottom: 14 }}>
            {t('rulesTitle')}
          </h2>
          <div className="card card--sub" style={{ padding: '6px 16px' }}>
            <Row k={t('ruleFeeSpot')} v={t('perSide', { p: pct(FEE_SPOT_BP / 100, 2) })} />
            <div className="divider" />
            <Row k={t('ruleFeeLev')} v={t('perSide', { p: pct(FEE_LEVERAGE_BP / 100, 2) })} />
            <div className="divider" />
            <Row k={t('ruleFeeFunding')} v={t('perGameDay', { p: pct(FUNDING_BP_PER_GAME_DAY / 100, 2) })} />
            <div className="divider" />
            <Row k={t('ruleFeeOption')} v={pct(FEE_OPTION_BP / 100, 2)} />
          </div>
          <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 12 }}>
            <Row k={t('ruleSeed')} v={money(SEED_CASH, 0)} />
            <div className="divider" />
            <Row k={t('ruleBankrupt')} v={money(BANKRUPT_EQUITY_THRESHOLD, 0)} />
            <div className="divider" />
            <Row k={t('ruleTopup')} v={t('ruleTopupValue', { n: TOPUP_DAILY_LIMIT, m: TOPUP_COOLDOWN_MS / 60000 })} />
            <div className="divider" />
            <Row k={t('ruleTick')} v={t('ruleTickValue')} />
            <div className="divider" />
            <Row k={t('ruleGameDay')} v={t('ruleGameDayValue')} />
            <div className="divider" />
            {/* ★「최대 30%」를 박아 두면 ORDER_FLOW_WEIGHT 를 올리는 날 «규칙 화면»이 거짓말을 한다.
                이 화면은 «게임 규칙»을 적는 곳이라 다른 어떤 라벨보다 틀리면 안 된다. */}
            <Row k={t('ruleImpact')} v={t('ruleImpactValue', { p: pct(ORDER_FLOW_WEIGHT * 100, 0) })} />
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            <Trans i18nKey="settings:disclaimer" components={{ b: <b /> }} />
          </p>
        </Sheet>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="kv__k">{k}</span>
      <span className="kv__v num">{v}</span>
    </div>
  );
}

function PreviewCard({
  active,
  title,
  today,
  cta,
  ctaOn,
}: {
  active: boolean;
  title: string;
  today: string;
  cta: string;
  ctaOn: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: 'var(--surface)',
        border: `1.5px solid ${active ? 'var(--brand)' : 'var(--line)'}`,
        borderRadius: 12,
        padding: 11,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{title}</div>
      <div className="num" style={{ fontSize: 15, fontWeight: 800 }}>
        $12,483.40
      </div>
      <div className="num up" style={{ fontSize: 11, fontWeight: 700 }}>
        {today}
      </div>
      <div
        style={{
          marginTop: 8,
          background: ctaOn ? 'var(--up)' : 'var(--surface-2)',
          color: ctaOn ? '#fff' : 'var(--t2)',
          borderRadius: 8,
          textAlign: 'center',
          fontSize: 11,
          fontWeight: 800,
          padding: 6,
        }}
      >
        {cta}
      </div>
    </div>
  );
}
