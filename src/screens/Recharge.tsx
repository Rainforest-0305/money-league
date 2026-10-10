import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Confetti, CountUp, Icon, RechargeDots, TickerTile } from '../components/Primitives';
import { AttendanceSummary } from '../components/AttendanceStrip';
import { AttendanceBonus } from '../components/AttendanceBonus';
import { EquityBar, RingCountdown } from '../components/Charts';
import { AdBanner } from '../components/AdBanner';
import { metaOf, useStore, useTick } from '../store/hooks';
import { useRewardAd } from '../components/RewardAd';
import { runInterstitialAd } from '../lib/ads';
import { useShareReward } from '../components/ShareReward';
import { mmss, money, msUntilKstMidnight, signedMoney, signedPct } from '../lib/format';
import { BANKRUPT_EQUITY_THRESHOLD, SEED_CASH, TOPUP_AMOUNT, TOPUP_COOLDOWN_MS, TOPUP_DAILY_LIMIT } from '../lib/constants';
import { TICKERS } from '../data/tickers.generated';

type Phase = 'bankrupt' | 'done' | 'cooldown' | 'ad' | 'exhausted';

/**
 * 파산 & 무료 충전 — 목업 07. 4단계 상태 기계.
 * 잔여 횟수·쿨다운은 전부 서버 값(store.topup). 로컬 타이머는 표시용이며
 * 0이 되어도 버튼 활성화는 서버 응답(eligible)을 받고 나서다.
 */
export function Recharge() {
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('recharge');
  const ko = i18n.language !== 'en';
  const [justToppedUp, setJustToppedUp] = useState(false);
  /**
   * ★완료 화면이 «무엇으로» 왔는가. 전면 광고를 붙일지 말지가 여기서 갈린다.
   * ⛔`'ad'` (광고 보고 충전) 직후에는 전면을 ★붙이지 않는다 — 광고 → 광고는 연속 광고다.
   *   `ads.ts` 의 60초 가드가 한 번 더 막지만, ★의도를 코드에 «먼저» 적는다.
   *   가드에만 기대면 60초가 지난 뒤 같은 자리에서 연속 광고가 살아난다.
   */
  const [topupVia, setTopupVia] = useState<'free' | 'ad' | null>(null);
  /** 완료 화면에서 전면을 기다리는 중 — 버튼을 잠가 중복 탭을 막는다 */
  const [leavingDone, setLeavingDone] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 남은 건 쿨다운 카운트다운용 1초 타이머뿐이다.
    // 잔여 횟수·쿨다운(store.topup)은 매 틱과 주문 직후 store 가 직접 갱신하므로
    // 예전의 10초 폴링(store.refreshTopup)은 사라졌다 — 서버가 없으니 재확인할 원본도 없다.
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const st = s.topup;
  const p = s.portfolio;
  const equity = st?.equity ?? p?.equity ?? 0;
  const cooldown = st?.cooldownRemainMs ?? 0;
  const bankrupt = st?.bankrupt ?? (p?.bankrupt ?? false);
  /*
   * ★무료와 광고는 «다른 자원»이다 (2026-08-20 President 지시 · Partner 승인).
   *   무료 3회  = 파산(총자산 < $200) «구제» 전용 · 10분 쿨다운 유지
   *   광고 10회 = 파산과 «무관» · 언제든 · 쿨다운 없음
   *   ★그래서 화면 단계도 둘을 섞지 않는다. 섞으면 「무료가 없는데 광고도 막힌」
   *   상태가 생긴다(예전 'locked' 화면이 정확히 그것이었다).
   */
  /* ★연체(마이너스 계좌) — «엔진이 답한» 값을 쓴다. 충전은 엔진에서 이미 잠겨 있고,
     화면은 그 이유를 «말하는» 역할만 한다(President 2026-09-05 「연체되면 무료충전 없애」). */
  const overdrawn = (st?.overdrawn ?? (p?.overdraft ?? 0) > 0) === true;
  const freeLeft = st?.freeRemaining ?? TOPUP_DAILY_LIMIT;
  const adPending = st?.adPending ?? 0;
  const adLeft = st?.adRemaining ?? 0;

  // 저변동성 종목 2개 추천 (sigma 하위)
  const calm = useMemo(() => [...TICKERS].sort((a, b) => a.sigma - b.sigma).slice(0, 2), []);
  // 급등 종목 2개 (쿨다운 화면)
  const hot = useMemo(
    () =>
      [...TICKERS]
        .sort((a, b) => (s.getQuote(b.ticker)?.totalChangePct ?? 0) - (s.getQuote(a.ticker)?.totalChangePct ?? 0))
        .slice(0, 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.tickVersion]
  );

  const doTopup = async (kind?: 'free' | 'ad') => {
    setBusy(true);
    try {
      const amount = await s.doTopup(kind);
      setJustToppedUp(true);
      /* ★`kind` 가 없으면 엔진이 무료를 고른다(doTopup 기본값) — 화면도 «같게» 읽는다 */
      setTopupVia(kind ?? 'free');
      s.pushToast(t('toppedUp', { v: money(amount, 0) }) as string);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      s.pushToast((t([`common:err.${code}`, 'common:err.GENERIC']) as string) ?? '', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 완료 화면을 나간다. 무료 충전이었을 때만 전면 광고를 한 번 끼운다.
   *
   * ⛔`await` 이 실패하든 가드에 걸리든 ★홈으로는 «항상» 간다 — `finally` 가 그 계약이다.
   *   (가드에 걸리면 `runInterstitialAd` 가 «동기적으로» 실패를 돌려주므로 멈춤 시간은 0 이다)
   * ★`leavingDone` 을 되돌리지 않는다: 이 함수가 끝나면 화면이 언마운트된다.
   *   되돌리면 광고가 닫히는 찰나에 버튼이 다시 눌려 «두 번» 나갈 수 있다.
   */
  const leaveDone = async () => {
    if (leavingDone) return;
    setLeavingDone(true);
    try {
      if (topupVia === 'free') await runInterstitialAd('interstitialMain');
    } finally {
      nav('/home');
    }
  };

  /**
   * 리워드 광고 — 소진 화면에서만 쓴다. 광고는 «선택»이고 강제가 아니다.
   *
   * ★★「광고 보고 $10,000 받기」를 «말 그대로» 되게 만든다.
   *   광고 보상은 구조상 «충전 횟수 +1»이다(현금을 직접 주면 수익률 분모
   *   seedCash*(1+topupCount) 가 어긋나 랭킹이 +1000% 로 붕괴한다 — constants.ts 주석).
   *   그런데 유저 입장에서 「1회 더」는 «아무것도 못 받은 것»처럼 보인다.
   *   ⇒ 받은 즉시 «받을 수 있으면 그 자리에서 받아 준다». 지급은 그대로
   *     world.topup() 경로라 topupCount 는 «반드시» 오른다. 새 지급 경로를 파지 않는다.
   *   ⇒ 쿨다운 중이라 지금 못 받으면 솔직히 그렇게 말한다(조용히 넘기지 않는다).
   */
  const ad = useRewardAd('topup', async () => {
    /* ★광고분은 쿨다운·파산과 무관하므로 적립 즉시 받아 준다 —
       「광고 보고 $10,000 받기」가 두 단계로 쪼개지면 유저는 받은 줄 모른다. */
    await doTopup('ad');
  });

  /**
   * 공유 리워드 — ★리워드 ID 미발급·토스 밖·구버전이면 `available` 이 false 다.
   *   그때는 ★아무것도 그리지 않는다(빈 자리·유령 여백 0). 지급 금액은 콘솔이 정하므로
   *   ⛔버튼 문구에 금액을 박지 않는다 — 받은 «뒤»에 토스트가 실제 금액을 말한다.
   */
  const share = useShareReward();
  const shareLeft = s.daily?.shareLeft ?? 0;
  const canShare = share.available && shareLeft > 0;

  /*
   * ★출석 — 화면은 «판정»만 읽는다. 규칙(곡선·streak)은 `lib/attendance.ts` 한 벌이다.
   *   ⛔화면에서 곡선을 다시 적거나 streak 을 계산하지 마라.
   */
  const attendState = s.attendance.state;
  const attendStreak = Math.max(1, attendState.streak);
  const attendClaimedToday = !s.attendanceToday().claimable && attendState.lastClaimedDate !== null;
  /*
   * ★출석 «추가 지급(광고)» 버튼은 [2026-09-10 · -33] `components/AttendanceBonus.tsx` 한 벌로 옮겼다.
   *   ★★[2026-09-05 수정 이력] 여기 `useRewardAd('attendance')` 가 있었다(그 전엔 'topup' 으로 잘못 나갔다).
   *   ★[2026-09-10 실측] 배선을 고친 뒤에도 출석 지면 노출이 0 이었다 — 이 버튼이 «소진(exhausted) 단계»에만 있고,
   *     토스 안에서는 광고 충전 여유가 남아 있는 한 phase 가 'ad' 로 빠져 그 단계에 «도달 자체가 안 됐기» 때문이다.
   *   ⇒ 홈 출석 시트와 «같은 컴포넌트·같은 규칙»(첫 체결 또는 포트폴리오 확인 뒤 · 하루 1회 · 자동 재생 0)으로 둔다.
   */

  /** 지금 광고 경로로 받을 수 있는가 — 적립분은 SDK 지원 없이도 받는다(이미 본 몫이다) */
  const canAd = adPending > 0 || (ad.supported && adLeft > 0);

  const phase: Phase = justToppedUp
    ? 'done'
    : bankrupt && freeLeft > 0 && cooldown > 0
      ? 'cooldown'
      : bankrupt && freeLeft > 0
        ? 'bankrupt'
        : canAd
          ? 'ad'
          : 'exhausted';

  /* ── 1. 파산 감지 ────────────────────────────────────────────────── */
  if (phase === 'bankrupt') {
    /* ★분모는 엔진이 준다(`world.investedBase`). ⛔`SEED_CASH * (1 + topupCount)` 로
       다시 만들면 공유 리워드(bonusSeed)가 빠져 랭킹 수익률과 «다른 값»이 된다. */
    const base = p?.investedBase ?? SEED_CASH;
    const lost = equity - base;
    const lostPct = base > 0 ? (equity / base - 1) * 100 : 0;
    const worst = worstTrade(s);
    return (
      <div className="screen" style={{ background: 'var(--bg)' }}>
        <div className="appbar">
          <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('common:close')}>
            {Icon.close}
          </button>
        </div>
        <div className="scroll" style={{ padding: '4px var(--gutter) 0' }}>
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <div style={{ display: 'grid', placeItems: 'center', color: 'var(--t3)' }} aria-hidden>
              {Icon.wallet(52)}
            </div>
            <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 14, lineHeight: 1.3, whiteSpace: 'pre-line' }}>
              {t('bankruptTitle')}
            </h2>
            <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10, lineHeight: 1.55, whiteSpace: 'pre-line' }}>
              {t('bankruptSub')}
            </p>
          </div>

          <div className="card" style={{ marginTop: 24, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('nowTotal')}</span>
              <span className="num" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em' }}>
                {money(equity)}
              </span>
            </div>
            <EquityBar
              equity={equity}
              seed={SEED_CASH}
              threshold={BANKRUPT_EQUITY_THRESHOLD}
              midLabel={t('bankruptMark', { v: money(BANKRUPT_EQUITY_THRESHOLD, 0) })}
              endLabel={t('startMark', { v: money(SEED_CASH, 0) })}
            />
            <div className="divider" style={{ margin: '16px 0 4px' }} />
            <div className="kv">
              <span className="kv__k">{t('seedRow')}</span>
              <span className="kv__v num">{money(SEED_CASH)}</span>
            </div>
            <div className="divider" />
            <div className="kv">
              <span className="kv__k">{t('resultRow')}</span>
              <span className="kv__v num down">
                {signedMoney(lost)} ({signedPct(lostPct, 1)})
              </span>
            </div>
            <div className="divider" />
            <div className="kv">
              <span className="kv__k">{t('worstRow')}</span>
              <span className="kv__v" style={{ fontSize: 12 }}>
                {worst ?? t('worstNone')}
              </span>
            </div>
          </div>

          <div className="note note--brand" style={{ marginTop: 14 }}>
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.info}</span>
            <span>
              <Trans i18nKey={`recharge:${diagnosisKey(s)}`} values={{ v: money(p?.feesPaid ?? 0) }} components={{ b: <b /> }} />
            </span>
          </div>
          <div className="scroll-pad" />
        </div>

        <div className="cta">
          <div className="dots" style={{ marginBottom: 12 }}>
            <RechargeDots left={freeLeft} total={TOPUP_DAILY_LIMIT} />
            <span className="num" style={{ fontSize: 12, fontWeight: 800, color: 'var(--gold-ink)', marginLeft: 6 }}>
              {t('leftDots', { n: freeLeft })}
            </span>
          </div>
          {/* ★「충전」 옆에 「대출」 — 같은 행·같은 높이(President 2026-09-05) */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <button
              className="btn btn--gold"
              style={{ flex: 1, marginTop: 0 }}
              disabled={busy || !(st?.freeEligible ?? bankrupt)}
              onClick={() => void doTopup('free')}
            >
              {t('getFree', { v: money(TOPUP_AMOUNT, 0) })}
            </button>
            <LoanCta overdrawn={overdrawn} ko={ko} />
          </div>
          <button className="btn btn--ghost" onClick={() => nav('/home')}>
            {t('justLook')}
          </button>
        </div>
      </div>
    );
  }

  /* ── 2. 충전 완료 ────────────────────────────────────────────────── */
  if (phase === 'done') {
    return (
      <div className="screen" style={{ background: 'var(--surface)', position: 'relative' }}>
        <Confetti />
        <div className="scroll" style={{ padding: '40px var(--gutter) 0' }}>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                width: 150,
                height: 150,
                borderRadius: '50%',
                margin: '0 auto',
                display: 'grid',
                placeItems: 'center',
                background: 'radial-gradient(circle at 50% 42%, var(--gold-weak), transparent 70%)',
                color: 'var(--gold-ink)',
              }}
              aria-hidden
            >
              {Icon.coins(52)}
            </div>
            <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: '-0.04em', marginTop: 6, color: 'var(--gold-ink)' }}>
              +<CountUp to={TOPUP_AMOUNT} render={(v) => money(v, 0).replace('$', '$')} />
            </div>
            <h2 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 12 }}>{t('doneTitle')}</h2>
            <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 8 }}>{t('doneSub')}</p>
          </div>

          <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 26 }}>
            <div className="kv">
              <span className="kv__k">{t('afterTotal')}</span>
              <span className="kv__v num">{money(p?.equity ?? equity)}</span>
            </div>
            <div className="divider" />
            <div className="kv">
              <span className="kv__k">{t('leftCount')}</span>
              <span className="kv__v num" style={{ color: 'var(--gold-ink)' }}>
                {t('leftDots', { n: freeLeft })}
              </span>
            </div>
            <div className="divider" />
            <div className="kv">
              <span className="kv__k">{t('nextIn')}</span>
              <span className="kv__v num">{t('inMinutes', { n: Math.ceil(TOPUP_COOLDOWN_MS / 60000) })}</span>
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <RechargeDots left={freeLeft} total={TOPUP_DAILY_LIMIT} />
          </div>
          <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 9 }}>{t('resetNote', { n: TOPUP_DAILY_LIMIT })}</p>

          <div style={{ background: 'var(--brand-weak)', borderRadius: 16, padding: '15px 16px', marginTop: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand-ink)' }}>{t('recTitle')}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
              {calm.map((m) => (
                <button
                  key={m.ticker}
                  onClick={() => nav(`/stock/${m.ticker}`)}
                  style={{ flex: 1, background: 'var(--surface)', borderRadius: 12, padding: 10, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}
                >
                  <TickerTile meta={m} size="sm" />
                  <span>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 800 }}>{m.nameKo}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--t3)' }}>{t('lowVol')}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {/*
            ★B1 — 충전 «완료» 화면 배너 (지면 XXXXXXXXXXXXXXXX · NORMAL).
              ★유저가 기분 좋고 다음 행동 전에 머무는 자리다. 이 화면엔 주문 버튼이 없어
                오탭이 «돈»으로 이어지지 않는다.
              ⛔아래 CTA 와 24px 이상 띄운다(margin 20 + .adslot 자체 padding 8 = 28px).
          */}
          {/* ★여백 56 → 72: 실측 top=753 · 보이는 높이 751 로 «2px» 차이였다.
                    2px 는 여유가 아니다 — 폰트 메트릭이 조금만 달라도 첫 화면 안으로 들어온다. */}
          <AdBanner slot="bannerRechargeDone" style={{ marginTop: 72 }} />
          <div className="scroll-pad" />
        </div>
        {/*
          ★★전면 광고 삽입 지점 (a) — 「무료 충전 완료 → 홈」 전환 사이.
            여기를 고른 이유: 이 화면에는 ★주문 버튼이 없고(오탭이 (가상)돈으로 안 간다),
            유저가 «받은 뒤 기분 좋게 나가는» 끝 화면이라 흐름을 끊지 않는다.
          ⛔광고 충전(`topupVia === 'ad'`) 직후에는 붙이지 않는다 — 연속 광고다.
          ★성패와 무관하게 «반드시» 홈으로 간다. 광고가 게임을 막아서는 안 된다.
        */}
        <div className="cta cta--surface">
          <button className="btn btn--primary" disabled={leavingDone} onClick={() => void leaveDone()}>
            {t('restart')}
            {leavingDone && <span className="btn__sub">{t('common:loading')}</span>}
          </button>
        </div>
      </div>
    );
  }

  /* ── 3. 쿨다운 ───────────────────────────────────────────────────── */
  if (phase === 'cooldown') {
    // 서버가 준 cooldownRemainMs 를 받은 시점(topupFetchedAt)부터 로컬로 감산해 표시한다.
    // 버튼 활성화는 로컬 타이머가 0이 되어도 하지 않는다 — 서버 eligible 만 신뢰.
    const remainMs = Math.max(0, cooldown - (now - s.topupFetchedAt));
    return (
      <div className="screen" style={{ background: 'var(--bg)' }}>
        <div className="appbar">
          <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('common:close')}>
            {Icon.close}
          </button>
        </div>
        <div className="scroll" style={{ padding: '18px var(--gutter) 0' }}>
          <div style={{ textAlign: 'center' }}>
            <RingCountdown ratio={remainMs / TOPUP_COOLDOWN_MS} big={mmss(remainMs)} small={t('remainLabel')} />
            <h2 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 20, lineHeight: 1.35, whiteSpace: 'pre-line' }}>
              {t('cooldownTitle')}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10, lineHeight: 1.55, whiteSpace: 'pre-line' }}>
              {t('cooldownSub', { m: TOPUP_COOLDOWN_MS / 60000 })}
            </p>
          </div>

          <div className="dots" style={{ marginTop: 22 }}>
            <RechargeDots left={freeLeft} total={TOPUP_DAILY_LIMIT} />
            <span className="num" style={{ fontSize: 12, fontWeight: 800, color: 'var(--gold-ink)', marginLeft: 6 }}>
              {t('leftDots', { n: freeLeft })}
            </span>
          </div>

          <div className="card card--list" style={{ marginTop: 24 }}>
            {hot.map((m, i) => (
              <div key={m.ticker}>
                {i > 0 && <div className="divider" style={{ marginLeft: 62 }} />}
                <button className="row" onClick={() => nav(`/stock/${m.ticker}`)}>
                  <TickerTile meta={m} size="sm" />
                  <span>
                    <span className="row__nm" style={{ display: 'block' }}>
                      {m.nameKo}
                    </span>
                    <span className="row__sub" style={{ display: 'block' }}>
                      {i === 0 ? t('hotNow') : t('volumeSpike')}
                    </span>
                  </span>
                  <span className="row__rt">
                    <span className="row__p num" style={{ display: 'block' }}>
                      {money(s.priceOf(m.ticker))}
                    </span>
                    <span className={`row__c num ${(s.getQuote(m.ticker)?.totalChangePct ?? 0) >= 0 ? 'up' : 'down'}`} style={{ display: 'block' }}>
                      {signedPct(s.getQuote(m.ticker)?.totalChangePct ?? 0)}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>

          {/* ★[제거 2026-08-20] 「충전되면 알림 받기」 — 알림 채널이 «없다». 켜도 아무 일이 없었다 */}
          <div className="scroll-pad" />
        </div>
        <div className="cta">
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <button className="btn btn--off" style={{ flex: 1, marginTop: 0 }} disabled>
              {t('waitBtn', { time: mmss(remainMs) })}
            </button>
            <LoanCta overdrawn={overdrawn} ko={ko} />
          </div>
          <button className="btn btn--ghost" style={{ color: 'var(--t2)', fontWeight: 700, fontSize: 15 }} onClick={() => nav('/stocks')}>
            {t('browseMarket')}
          </button>
        </div>
      </div>
    );
  }

  /* ── 4. 소진 (무료 한도 + 광고 보너스까지 다 씀) ─────────────────── */
  if (phase === 'exhausted') {
    /*
     * 광고로 더 받을 수 있는가 = (SDK 지원) AND (오늘 광고 보너스 상한 여유).
     * ★ 미지원(웹 브라우저·구버전 토스)일 때 이 분기가 false 가 되고,
     *   아래 CTA 는 「내일 다시」 + «홈으로» 로 떨어진다. 막다른 골목이 아니다.
     */
    /* exhausted 는 「무료도 없고 광고도 없다」는 뜻이므로 여기서 광고 CTA 는 뜨지 않는다.
       (광고가 가능하면 phase 가 'ad' 로 갔다) — 그래도 조건을 남겨 둔다: 지원 여부가
       렌더 도중 바뀌는 환경(웹뷰 승격)에서 «막다른 골목»이 되지 않게. */
    const adRoom = adLeft;
    const canWatchAd = ad.supported && adRoom > 0;
    const untilReset = msUntilKstMidnight(now);
    const h = Math.floor(untilReset / 3600000);
    const mn = Math.floor((untilReset % 3600000) / 60000);
    const progress = 1 - untilReset / 86400000;
    const leader = s.ranks[0];
    return (
      <div className="screen" style={{ background: 'var(--bg)' }}>
        <div className="appbar">
          <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('common:close')}>
            {Icon.close}
          </button>
        </div>
        <div className="scroll" style={{ padding: '18px var(--gutter) 0' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'grid', placeItems: 'center', color: 'var(--t2)' }} aria-hidden>
              {Icon.moon}
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 14, lineHeight: 1.32, whiteSpace: 'pre-line' }}>
              {t('exhaustedTitle')}
            </h2>
            <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10, lineHeight: 1.55, whiteSpace: 'pre-line' }}>
              {t('exhaustedSub', { n: TOPUP_DAILY_LIMIT })}
            </p>
          </div>

          <div style={{ marginTop: 20 }}>
            {/*
              ★점은 «무료 3회»를 그린다. 광고로 늘어난 몫까지 점으로 그리면 13개가 깔린다.
                그래서 광고 보너스를 «한 번이라도» 받은 날에는 점을 감추고 숫자로만 말한다 —
                점 3개 밑에 「13회 모두 사용」이 붙으면 둘 중 뭐가 맞는지 알 수 없다(실렌더에서 잡음).
            */}
            {(s.daily?.topupBonus ?? 0) === 0 && <RechargeDots left={0} total={TOPUP_DAILY_LIMIT} />}
          </div>
          {/* ★실제로 오늘 쓸 수 있었던 총량(무료 + 광고분)을 그대로 말한다. 3 을 다시 박지 않는다. */}
          <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 9 }}>
            {t('allUsed', { n: st?.dailyLimit ?? TOPUP_DAILY_LIMIT })}
          </p>

          <div className="card" style={{ marginTop: 22, padding: 18, textAlign: 'center' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}>{t('untilReset')}</div>
            <div className="num" style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 4 }}>
              {t('hoursMinutes', { h, m: String(mn).padStart(2, '0') })}
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', marginTop: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress * 100}%`, background: 'var(--brand)', borderRadius: 4 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', marginTop: 7 }}>
              <span>{t('todayMidnight')}</span>
              <span>{t('tomorrowMidnight')}</span>
            </div>
          </div>

          {/*
            ★출석 카드 — «정보»다. 보상은 홈에 들어오는 순간 이미 지급됐다.
              여기서는 「지금 며칠째인가 · 내일 오면 얼마인가 · 7일까지 얼마씩 느는가」를 말한다.
            ★2026-08-30 President 「출석표 같은 걸로 플레이어들이 날마다 보상이 는다는 걸 알게 해야지」
              ⇒ 점 7개(RechargeDots) 를 «금액이 보이는» 7칸 출석표(AttendanceSummary)로 바꿨다.
              같은 몸통을 홈 칩이 여는 시트도 쓴다. 「추가 지급(광고)」 버튼도 두 자리가 «같은 컴포넌트»(AttendanceBonus)다.
            ★숫자는 전부 `lib/attendance.ts` 에서 «유도»된다. 화면이 곡선을 다시 적지 않는다.
          */}
          <div className="card" style={{ marginTop: 22, padding: 18 }}>
            <AttendanceSummary
              streak={attendStreak}
              claimedToday={attendClaimedToday}
              nextUsd={s.attendanceNextReward()}
            />
            <AttendanceBonus />
          </div>

          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--t2)', marginBottom: 10 }}>{t('meanwhile')}</div>
            <div className="card card--list">
              <button className="row" onClick={() => nav('/rank')}>
                <span style={{ width: 32, height: 32, borderRadius: 11, background: 'var(--gold-weak)', display: 'grid', placeItems: 'center', color: 'var(--gold-ink)' }} aria-hidden>
                  {Icon.trophy}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{t('altRank')}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)' }}>
                    {t('altRankSub', { name: leader?.nickname ?? '' })}
                  </span>
                </span>
                {Icon.chevron}
              </button>
              <div className="divider" style={{ marginLeft: 60 }} />
              <button className="row" onClick={() => nav('/settings')}>
                <span style={{ width: 32, height: 32, borderRadius: 11, background: 'var(--brand-weak)', display: 'grid', placeItems: 'center', color: 'var(--brand-ink)' }} aria-hidden>
                  {Icon.receipt}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{t('altHistory')}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)' }}>{t('altHistorySub')}</span>
                </span>
                {Icon.chevron}
              </button>
              {/* ★[제거 2026-08-20] 「내일 충전되면 알림 받기」 — 같은 이유(알림 채널 부재) */}
            </div>
          </div>
          <div className="scroll-pad" />
        </div>
        {/*
          ★예전에는 여기가 «비활성 버튼 하나»뿐이었다 = 막다른 골목.
            (a) 광고를 보면 지금 더 받을 수 있고,
            (b) 광고가 안 되는 환경(웹·구버전)에서도 «나갈 문»이 항상 있다.
        */}
        <div className="cta">
          {canWatchAd ? (
            <>
              {/* ★금액을 «앞»에 둔다. 「1회 더 받기」는 얼마를 받는지 안 적혀 있어
                  광고를 볼 이유가 화면에 없었다(President 지적 「충전이 아니라 금액」). */}
              <button className="btn btn--gold" disabled={ad.busy} onClick={() => void ad.run()}>
                {t('adCta', { v: money(TOPUP_AMOUNT, 0) })}
                <span className="btn__sub">{ad.busy ? t('common:loading') : t('adCtaSub')}</span>
              </button>
              <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>
                {t('adLeft', { n: adRoom, v: money(TOPUP_AMOUNT, 0) })}
              </p>
            </>
          ) : canShare ? (
            /*
             * ★여기가 «막다른 골목»이었다 — 광고도 없고 무료도 없으면 비활성 버튼 하나였다.
             *   공유 리워드가 그 자리를 «실제로 할 수 있는 일»로 바꾼다.
             * ⛔금액을 문구에 박지 않는다: 지급 수량은 앱인토스 «콘솔» 설정값이고
             *   이벤트로 내려온다. 박으면 콘솔에서 조절할 수 없고, 어긋나면 거짓말이 된다.
             */
            <button className="btn btn--gold" disabled={share.busy} onClick={share.run}>
              {t('shareCta')}
              {/* ★남은 횟수를 «보간»한다. ⛔인자 없이 부르면 화면에 「{{n}}」 이 그대로 찍힌다
                  (i18n 키 검사기는 ko/en 보간 «일치»만 보지 호출부 인자는 못 본다). */}
              <span className="btn__sub">{share.busy ? t('common:loading') : t('shareCtaSub', { n: shareLeft })}</span>
            </button>
          ) : (
            <button className="btn btn--off" disabled>
              {t('tomorrowBtn')}
            </button>
          )}
          {/* ★대출은 «홈으로» 위에 둔다 — 나가는 문보다 «할 수 있는 일»이 먼저다.
              ★★이 phase(소진)에서 특히 중요하다: 충전이 전부 막힌 자리라 대출이 유일한 길이다. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <LoanCta overdrawn={overdrawn} ko={ko} />
            <button className="btn btn--ghost" style={{ flex: 1, marginTop: 0 }} onClick={() => nav('/home')}>
              {t('backToHome')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── 5. 광고로 받기 ──────────────────────────────────────────────
     ★예전 'locked'(「아직 충전할 수 없어요 · 총 자산이 $200 밑으로…」) 화면을 대체한다.
       그 화면은 «할 수 있는 게 하나도 없는» 막다른 골목이었다. 이제는 광고 경로가
       파산과 무관하게 열려 있으므로, 같은 자리에서 실제로 받아갈 수 있다.
     ★무료(파산 구제)는 여전히 별개다 — 그 규칙을 화면에 그대로 적어 둔다. */
  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar">
        <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('common:close')}>
          {Icon.close}
        </button>
      </div>
      <div className="scroll" style={{ padding: '18px var(--gutter) 0' }}>
        <div style={{ textAlign: 'center', paddingTop: 10 }}>
          <div style={{ display: 'grid', placeItems: 'center', color: 'var(--gold-ink)' }} aria-hidden>
            {Icon.coins(48)}
          </div>
          <h2 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 14 }}>
            {t('adTitle', { v: money(TOPUP_AMOUNT, 0) })}
          </h2>
          <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10, lineHeight: 1.55 }}>
            {t('adSub', { n: adLeft, v: money(TOPUP_AMOUNT, 0) })}
          </p>
        </div>
        <div className="card" style={{ marginTop: 22, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('nowTotal')}</span>
            <span className="num" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em' }}>
              {money(equity)}
            </span>
          </div>
          <EquityBar
            equity={equity}
            seed={SEED_CASH}
            threshold={BANKRUPT_EQUITY_THRESHOLD}
            midLabel={t('bankruptMark', { v: money(BANKRUPT_EQUITY_THRESHOLD, 0) })}
            endLabel={t('startMark', { v: money(SEED_CASH, 0) })}
          />
        </div>
        {/* ★무료 3회의 «역할»을 분명히 적는다 — 안 적으면 「무료는 왜 안 되지?」가 남는다 */}
        <p className="hint" style={{ marginTop: 14 }}>
          {t('freeRuleNote', { n: freeLeft, v: money(BANKRUPT_EQUITY_THRESHOLD, 0) })}
        </p>
        <div className="scroll-pad" />
      </div>
      <div className="cta">
        {adPending > 0 ? (
          <button className="btn btn--gold" disabled={busy} onClick={() => void doTopup('ad')}>
            {t('claimEarned', { v: money(TOPUP_AMOUNT, 0) })}
            <span className="btn__sub">{t('claimEarnedSub')}</span>
          </button>
        ) : (
          <button className="btn btn--gold" disabled={ad.busy} onClick={() => void ad.run()}>
            {t('adCta', { v: money(TOPUP_AMOUNT, 0) })}
            <span className="btn__sub">{ad.busy ? t('common:loading') : t('adCtaSub')}</span>
          </button>
        )}
        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>
          {t('adLeft', { n: adLeft, v: money(TOPUP_AMOUNT, 0) })}
        </p>
        {/* ★대출은 «홈으로» 위에 둔다 — 나가는 문보다 할 수 있는 일이 먼저다 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <LoanCta overdrawn={overdrawn} ko={ko} />
          <button className="btn btn--ghost" style={{ flex: 1, marginTop: 0 }} onClick={() => nav('/home')}>
            {t('backToHome')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ★「충전」 버튼 «옆»의 「대출」 버튼 — 2026-09-05 President 지시
 *   「대출 버튼은 충전 버튼 옆에 만들어.」
 *
 * ★같은 행·같은 높이로 둔다(flex 1:1). 충전이 «주»이므로 색(gold)은 충전이 갖고
 *   대출은 보조(ghost) 다 — 나란히 두되 무게는 다르다.
 * ★★연체 중(cash<0)이면 «죽이고 이유를 적는다». 회색 버튼만 남기지 않는다.
 *   ⛔화면이 `portfolio.cash < 0` 으로 다시 판정하지 «마라» — 엔진이 답한 값을 쓴다.
 */
function LoanCta({ overdrawn, ko }: { overdrawn: boolean; ko: boolean }) {
  const nav = useNavigate();
  return (
    <button
      type="button"
      className="btn btn--ghost"
      /*
       * ★★폭을 «고정»한다(flex 0 0). ⛔`flex: 1` 로 반씩 나누면 안 된다 —
       *   실렌더에서 「무료로 $10,000 받기」가 166px 안에서 두 줄로 접혀
       *   ★두 버튼의 «높이»가 달라졌다(President 「같은 행, 같은 높이」 위반).
       *   [실측 2026-09-06 · 390x844] 112px 를 떼어 주면 주 버튼이 230px 를 갖고 한 줄로 들어간다.
       * ★`alignItems: stretch` 인 행 안이라 높이는 «자동으로» 주 버튼과 같아진다.
       */
      style={{ flex: '0 0 112px', marginTop: 0, fontWeight: 800, whiteSpace: 'nowrap' }}
      disabled={overdrawn}
      onClick={() => nav('/loan')}
      title={overdrawn ? (ko ? '연체 잔액을 먼저 갚아야 해요' : 'Repay your overdue balance first') : undefined}
    >
      {ko ? '대출' : 'Borrow'}
      {overdrawn && (
        /* ★죽은 이유는 «버튼 안»에 적는다 — 회색 버튼만 남기지 않는다는 이 앱의 규율 */
        <span className="btn__sub" style={{ whiteSpace: 'normal', fontSize: 10.5, lineHeight: 1.3 }}>
          {ko ? '연체부터 갚기' : 'Repay overdue'}
        </span>
      )}
    </button>
  );
}

/** 실패 원인 1줄 진단 — 실제 포트폴리오 구성으로 판정 */
function diagnosisKey(s: ReturnType<typeof useStore>): string {
  const p = s.portfolio;
  if (!p) return 'diagGeneric';
  const base = p.investedBase;
  if (p.liquidationCount > 0) return 'diagLeverage';
  if (p.feesPaid > base * 0.02) return 'diagChurn';
  const top = p.holdings.reduce((a, b) => Math.max(a, b.value), 0);
  if (top > p.equity * 0.8 && p.holdings.length <= 1) return 'diagConcentration';
  return 'diagGeneric';
}

/** 가장 크게 잃은 거래 — 현재 보유/포지션 중 최대 손실 항목 */
function worstTrade(s: ReturnType<typeof useStore>): string | null {
  const p = s.portfolio;
  if (!p) return null;
  let worst: { label: string; pnl: number } | null = null;
  for (const h of p.holdings) {
    if (!worst || h.pnl < worst.pnl) worst = { label: `${metaOf(h.ticker).ticker}`, pnl: h.pnl };
  }
  for (const lv of p.leverage) {
    if (!worst || lv.pnl < worst.pnl)
      worst = { label: `${metaOf(lv.ticker).ticker} ${lv.leverage}x ${lv.side}`, pnl: lv.pnl };
  }
  return worst && worst.pnl < 0 ? `${worst.label} ${signedMoney(worst.pnl, 0)}` : null;
}
