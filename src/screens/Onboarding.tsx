import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BrandMark,
  Confetti,
  CountUp,
  Icon,
  TickerTile,
} from '../components/Primitives';
import { AreaChart } from '../components/Charts';
import { metaOf, useQuote, useStore } from '../store/hooks';
import { setLanguage } from '../i18n';
import { money, num, pct, signedMoney, signedPct } from '../lib/format';
import { FEE_SPOT_BP, BP, GAME_DAY_REAL_SECONDS, SEED_CASH, TOPUP_DAILY_LIMIT } from '../lib/constants';
import { TICKERS } from '../data/tickers.generated';

/**
 * 추천 닉네임 — bot_roster.csv 와 같은 어휘군(랭킹에 섞였을 때 이질감 없음).
 *
 * ★ 언어별로 갈라야 한다. 예전에는 한국어 12개 고정이라 영어 UI 에서도 한글 후보만 떴다.
 *   목업 i18n 규칙의 "닉네임은 번역하지 않는다"는 **남의 닉네임 표시**에 대한 규칙이고,
 *   여기는 내가 쓸 이름의 **입력 후보**라 별개다(영어권 유저는 읽지도 입력하지도 못한다).
 *   입력 상한 12자(아래 slice(0,12))에 맞춰 en 후보도 전부 12자 이하로 맞췄다.
 */
const NICK_POOL_KO = [
  '커피값투자',
  '티끌모아태산',
  '주린이탈출중',
  '오늘도불장',
  '조용한거물',
  '존버중입니다',
  '배당이좋아',
  '월급루팡재테크',
  '점심값벌기',
  '차트보는고양이',
  '느긋한투자자',
  '한강뷰가는길',
];

const NICK_POOL_EN = [
  'CoffeeMoney',
  'PennyStacker',
  'RookieNoMore',
  'BullRunDaily',
  'QuietWhale',
  'StillHolding',
  'DividendFan',
  'PaycheckPlus',
  'LunchMoney',
  'ChartCat',
  'SlowSteady',
  'AllInAgain',
];

/** 추천 7개 뽑기. seed 0 은 원래 순서(첫 진입), 이후는 seed 로 결정되는 셔플 */
function pickNickIdeas(pool: string[], seed: number): string[] {
  if (seed === 0) return pool.slice(0, 7);
  const a = [...pool];
  let r = seed * 9301 + 49297;
  for (let i = a.length - 1; i > 0; i--) {
    r = (r * 9301 + 49297) % 233280;
    const j = r % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 7);
}

/** 온보딩 4단계에 노출할 대표 종목 10개 (목업 01-4 와 동일 구성) */
const PICKABLE = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'NFLX', 'KO', 'PLTR', 'JPM'];

export function Onboarding() {
  const s = useStore();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('onboarding');
  /** 지금 명부에 있는 «나 말고» 참가자 수 — 랭킹 배열에서 «유도»한다(상수를 박지 않는다).
      명부는 런타임에 늘어난다(1,000 시작 → 상한 3,310). 숫자를 박으면 내일 거짓이 된다. */
  const rivals = Math.max(0, s.ranks.length - 1);
  const ko = i18n.language !== 'en';

  const [step, setStep] = useState(0);
  const [nick, setNick] = useState('');
  const [nickErr, setNickErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>(['NVDA', 'AAPL', 'TSLA']);
  const [busy, setBusy] = useState(false);
  const [fill, setFill] = useState<{ ticker: string; price: number; fee: number; cash: number } | null>(null);
  /** 추천 닉네임 셔플 횟수. 언어가 바뀌면 pool 도 같이 갈아끼운다 */
  const [nickSeed, setNickSeed] = useState(0);
  const pool = useMemo(() => pickNickIdeas(ko ? NICK_POOL_KO : NICK_POOL_EN, nickSeed), [ko, nickSeed]);

  const leader = s.ranks[0];
  const firstPick = picks[0] ?? 'NVDA';

  const submitNick = async () => {
    const v = nick.trim();
    if (v.length < 1) {
      setNickErr(t('nickTooShort'));
      return;
    }
    setBusy(true);
    try {
      await s.register(v);
      setStep(2);
    } catch (e) {
      // 서버가 준 사유를 그대로 보여준다. 예전에는 store.register 가 모든 실패를
      // 삼키고 오프라인 게스트로 내려앉아, 사용자는 이유도 모른 채 mock 화면을 봤다.
      const code = (e as { code?: string }).code;
      setNickErr(
        code === 'NICKNAME_TAKEN' || !code
          ? t('nickTaken')
          : ((t([`common:err.${code}`, 'common:err.GENERIC']) as string) ?? t('nickTaken'))
      );
    } finally {
      setBusy(false);
    }
  };

  const doFirstBuy = async () => {
    setBusy(true);
    try {
      const price = s.priceOf(firstPick);
      await s.orderSpot(firstPick, 'buy', 1);
      const fee = price * FEE_SPOT_BP * BP;
      setFill({ ticker: firstPick, price, fee, cash: s.portfolio?.cash ?? SEED_CASH - price - fee });
      setStep(5);
    } catch {
      setStep(5);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    s.setWatchlist(picks);
    s.finishOnboarding();
    nav('/home', { replace: true });
  };

  /* ── 1. 히어로 ───────────────────────────────────────────────────── */
  if (step === 0) {
    return (
      <div className="screen">
        <div className="hero">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 'max(24px, var(--sa-top, env(safe-area-inset-top)))' }}>
            <BrandMark size={26} />
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {t('common:appName')}
            </span>
            <button
              type="button"
              onClick={() => setLanguage(ko ? 'en' : 'ko')}
              style={{
                marginLeft: 'auto',
                border: '1px solid rgba(255,255,255,.35)',
                borderRadius: 999,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {Icon.globe}
                {ko ? 'English' : '한국어'}
              </span>
            </button>
          </div>

          <h2 style={{ whiteSpace: 'pre-line' }}>{t('heroTitle')}</h2>
          <p className="lede" style={{ whiteSpace: 'pre-line' }}>
            {/* ★참가자 수를 «문자열에 박지 않는다». 명부는 런타임에 늘어난다(1,000 시작 → 상한 3,310).
                박아 두면 어제는 참이고 오늘은 거짓인 문장이 된다 — 오늘의 「3배예요」와 같은 계열이다. */}
            {t('heroSub', { n: num(rivals) })}
          </p>

          {/*
            ★[2026-08-21] 카드 2장 → 4장.
              ★실렌더로 본 문제: 카드가 끝난 뒤 CTA 까지 ★약 285px 가 «통째로 비어» 있었다.
                히어로 한가운데가 죽어 있으면 「덜 만든 화면」으로 읽힌다.
              ⛔여백을 «장식»으로 채우지 않는다 — 채운 것은 ★«실제로 움직이는 시세»다.
                이 화면의 주장이 「1,000명과 같은 시장에서 겨룬다」이므로, 그 증거가
                바로 이 카드들이다(엔진이 돌고 있어 숫자가 실시간으로 바뀐다).
              ★들여쓰기를 0/22/8/30 으로 «어긋나게» 둔다 — 같은 크기 카드를 반듯하게
                쌓는 것이 taste §9.C 가 지목하는 형태다. 흐트러뜨려 리듬을 만든다.
          */}
          <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 11 }}>
            {(['NVDA', 'TSLA', 'AAPL', 'MSFT'] as const).map((tk, i) => (
              <div key={tk} style={{ marginLeft: [0, 22, 8, 30][i] }}>
                <HeroCard ticker={tk} />
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minHeight: 16 }} />
          <button className="btn btn--primary" onClick={() => setStep(1)}>
            {t('heroCta')}
          </button>
          <button
            className="btn btn--ghost"
            style={{ color: 'rgba(255,255,255,.72)', marginBottom: 20 }}
            onClick={() => setStep(1)}
          >
            {t('heroSecondary')}
          </button>
        </div>
      </div>
    );
  }

  /* ── 2. 닉네임 ───────────────────────────────────────────────────── */
  if (step === 1) {
    return (
      <div className="screen" style={{ background: 'var(--surface)' }}>
        <div className="appbar appbar--surface">
          <button className="iconbtn" onClick={() => setStep(0)} aria-label={t('common:back')}>
            {Icon.back}
          </button>
          <div className="progress">
            <i className="is-on" />
            <i />
            <i />
          </div>
        </div>
        <div className="scroll" style={{ padding: '14px var(--gutter) 0' }}>
          <h2 style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.34, whiteSpace: 'pre-line' }}>
            {t('nickTitle')}
          </h2>
          <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10 }}>{t('nickSub')}</p>

          <div
            style={{
              marginTop: 30,
              borderBottom: `2px solid ${nickErr ? 'var(--down)' : 'var(--brand)'}`,
              paddingBottom: 10,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <input
              value={nick}
              onChange={(e) => {
                setNick(e.target.value.slice(0, 12));
                setNickErr(null);
              }}
              placeholder={t('nickPlaceholder')}
              aria-label={t('nickTitle')}
              autoFocus
              style={{
                flex: 1,
                border: 0,
                outline: 'none',
                background: 'transparent',
                fontSize: 23,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--t1)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNick();
              }}
            />
            <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
              {nick.length}/12
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 10,
              fontSize: 12,
              fontWeight: 600,
              color: nickErr ? 'var(--down)' : nick.trim() ? 'var(--brand)' : 'var(--t3)',
              minHeight: 20,
            }}
          >
            {/*
              ★[2026-08-21] 통과 표시를 이모지 `✓ ` → SVG 로 바꿨다.
              ⛔문자열 결합(`✓ ${...}`)으로 되돌리지 마라:
                · 「✓」 뒤 공백은 폰트가 정하는 간격이라 로케일·플랫폼마다 다르게 벌어진다.
                  지금은 이 컨테이너의 `gap: 6` «하나»가 간격을 정한다 — 값이 코드에 보인다.
                · 스크린리더가 「체크 표시」를 «읽는다». 아이콘은 aria-hidden 이고
                  통과 여부는 뒤따르는 문장이 말한다(중복 낭독 제거).
            */}
            {nickErr ?? (nick.trim() ? <>{Icon.checkSm(14)}<span>{t('nickOk')}</span></> : null)}
          </div>

          <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('nickIdeas')}</span>
            <button
              style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}
              onClick={() => setNickSeed((n) => n + 1)}
            >
              {t('nickReroll')}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {pool.map((n) => (
              <button
                key={n}
                className={`chip ${nick === n ? 'chip--on' : ''}`}
                onClick={() => {
                  setNick(n);
                  setNickErr(null);
                }}
              >
                {n}
              </button>
            ))}
          </div>

          {leader && (
            <div
              style={{
                marginTop: 30,
                background: 'var(--surface-2)',
                borderRadius: 16,
                padding: '15px 16px',
                display: 'flex',
                gap: 11,
              }}
            >
              <span style={{ display: 'grid', placeItems: 'center', color: 'var(--gold-ink)', flex: '0 0 auto' }} aria-hidden>
                {Icon.trophy}
              </span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {t('nickBait', { name: '' })}
                  <span style={{ color: 'var(--brand)' }}> {leader.nickname}</span>
                </div>
                <div className="num" style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                  {t('nickBaitStats', { equity: money(leader.equity, 0), pct: signedPct(leader.pnlPct, 0) })}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="cta cta--surface">
          <button className="btn btn--primary" disabled={busy || !nick.trim()} onClick={() => void submitNick()}>
            {t('common:next')}
          </button>
        </div>
      </div>
    );
  }

  /* ── 3. 시드 지급 ────────────────────────────────────────────────── */
  if (step === 2) {
    return (
      <div className="screen" style={{ background: 'var(--surface)', position: 'relative' }}>
        <Confetti />
        <div className="appbar appbar--surface">
          <div className="progress" style={{ margin: '0 auto' }}>
            <i className="is-on" />
            <i className="is-on" />
            <i />
          </div>
        </div>
        <div className="scroll" style={{ padding: '18px var(--gutter) 0' }}>
          <div className="seedring">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{t('seedKicker')}</div>
              <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.04em', marginTop: 2 }}>
                <CountUp to={SEED_CASH} render={(v) => money(v, 0)} />
              </div>
            </div>
          </div>
          <h2
            style={{
              fontSize: 25,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              textAlign: 'center',
              marginTop: 22,
              lineHeight: 1.34,
              whiteSpace: 'pre-line',
            }}
          >
            {t('seedTitle', { name: s.session?.nickname ?? nick })}
          </h2>
          <p style={{ fontSize: 15, color: 'var(--t3)', textAlign: 'center', marginTop: 10 }}>{t('seedSub')}</p>

          <div className="card" style={{ marginTop: 26, padding: '6px 18px' }}>
            {/*
              ★「게임 시간은 실제 시간과 다르다」를 규칙 «맨 앞»에 둔다.
                예전에는 이 내용이 설정 > 게임 규칙 시트 안(ruleGameDayValue)에만
                있어서 사실상 아무도 못 봤다. 여기가 첫 화면이다.
              ★경고가 아니라 «규칙»으로 적는다 — 모달·동의 절차를 만들지 않는다.
            */}
            <Rule
              icon={Icon.timer(19)}
              bg="var(--surface-2)"
              title={t('rule0')}
              sub={t('rule0Sub', { m: GAME_DAY_REAL_SECONDS / 60 })}
            />
            <div className="divider" />
            {/* ★「수수료 0.05% · 1만 달러어치 사면 5달러」를 문자열에 박지 않는다.
                요율(FEE_SPOT_BP)과 예시 금액(SEED_CASH) 양쪽에서 «계산»해 넣는다. */}
            <Rule
              icon={Icon.coins(19)}
              bg="var(--brand-weak)"
              title={t('rule1', { p: pct(FEE_SPOT_BP / 100, 2) })}
              sub={t('rule1Sub', { v: money(SEED_CASH, 0), f: money(SEED_CASH * FEE_SPOT_BP * BP, 0) })}
            />
            <div className="divider" />
            <Rule icon={Icon.battery} bg="var(--gold-weak)" title={t('rule2')} sub={t('rule2Sub', { n: TOPUP_DAILY_LIMIT })} />
            <div className="divider" />
            <Rule icon={Icon.trend(19)} bg="var(--up-weak)" title={t('rule3')} sub={t('rule3Sub', { n: num(rivals) })} />
          </div>
          <div className="scroll-pad" />
        </div>
        <div className="cta cta--surface">
          <button className="btn btn--primary" onClick={() => setStep(3)}>
            {t('seedCta')}
          </button>
        </div>
      </div>
    );
  }

  /* ── 4. 관심 종목 ────────────────────────────────────────────────── */
  if (step === 3) {
    const toggle = (tk: string) =>
      setPicks((p) => (p.includes(tk) ? p.filter((x) => x !== tk) : p.length >= 3 ? p : [...p, tk]));
    return (
      <div className="screen" style={{ background: 'var(--surface)' }}>
        <div className="appbar appbar--surface">
          <button className="iconbtn" onClick={() => setStep(2)} aria-label={t('common:back')}>
            {Icon.back}
          </button>
          <div className="progress">
            <i className="is-on" />
            <i className="is-on" />
            <i className="is-on" />
          </div>
        </div>
        <div className="scroll" style={{ padding: '14px var(--gutter) 0' }}>
          <h2 style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.34, whiteSpace: 'pre-line' }}>
            {t('pickTitle')}
          </h2>
          <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10 }}>{t('pickSub')}</p>
          <div className="pickgrid" style={{ marginTop: 22 }}>
            {PICKABLE.map((tk) => {
              const m = metaOf(tk);
              const sel = picks.includes(tk);
              return (
                <button key={tk} type="button" className={`pick ${sel ? 'is-sel' : ''}`} onClick={() => toggle(tk)} aria-pressed={sel}>
                  {/* ★선택 표식 — 이모지 `✓` → SVG(위 닉네임 통과 표시와 «같은 획»).
                      선택 상태는 `aria-pressed` 가 이미 말한다 ⇒ 배지는 aria-hidden. */}
                  {sel && (
                    <span className="pick__ck" aria-hidden>
                      {Icon.checkSm(12)}
                    </span>
                  )}
                  <TickerTile meta={m} size="sm" />
                  <span>
                    <span className="pick__nm" style={{ display: 'block' }}>
                      {ko ? m.nameKo : m.nameEn}
                    </span>
                    <span className="pick__sc" style={{ display: 'block' }}>
                      {m.ticker} · {ko ? m.sectorKo : m.sectorEn}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="scroll-pad" />
        </div>
        <div className="cta cta--surface">
          <button className="btn btn--primary" disabled={picks.length !== 3} onClick={() => setStep(4)}>
            {picks.length === 3 ? t('pickCta') : t('pickMore', { n: 3 - picks.length })}
          </button>
        </div>
      </div>
    );
  }

  /* ── 5. 첫 매수 코치마크 ─────────────────────────────────────────── */
  if (step === 4) {
    return <CoachStep ticker={firstPick} busy={busy} onBuy={() => void doFirstBuy()} />;
  }

  /* ── 6. 체결 축하 ────────────────────────────────────────────────── */
  const m = metaOf(fill?.ticker ?? firstPick);
  const myRank = s.myRank?.rank ?? 187;
  return (
    <div className="screen" style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <TickerTile meta={m} size="xs" />
        <span className="appbar__title">{ko ? m.nameKo : m.nameEn}</span>
      </div>
      <div style={{ flex: 1, opacity: 0.32 }}>
        <AreaChart data={s.series(m.ticker, 90)} height={170} />
      </div>
      <div className="scrim" />
      <div className="sheet">
        <Confetti seed={1} />
        <div
          style={{
            width: 66,
            height: 66,
            borderRadius: '50%',
            background: 'var(--up-weak)',
            display: 'grid',
            placeItems: 'center',
            margin: '6px auto 0',
            color: 'var(--up)',
          }}
        >
          {Icon.check}
        </div>
        <h2 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.03em', textAlign: 'center', marginTop: 16 }}>
          {t('filledTitle', { name: ko ? m.nameKo : m.nameEn })}
        </h2>
        <p style={{ fontSize: 15, color: 'var(--t3)', textAlign: 'center', marginTop: 8 }}>{t('filledSub')}</p>

        <div className="card card--sub" style={{ padding: '6px 16px', marginTop: 20 }}>
          <div className="kv">
            <span className="kv__k">{t('fillPrice')}</span>
            <span className="kv__v num">{money(fill?.price ?? s.priceOf(m.ticker))}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('feeWithPct', { p: pct(FEE_SPOT_BP / 100, 2) })}</span>
            <span className="kv__v num">{money(fill?.fee ?? 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{t('cashLeft')}</span>
            <span className="kv__v num">{money(s.portfolio?.cash ?? fill?.cash ?? 0)}</span>
          </div>
        </div>

        <div className="note note--brand" style={{ marginTop: 16 }}>
          <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{Icon.info}</span>
          <span>{t('filledTip', { rank: myRank })}</span>
        </div>

        <button className="btn btn--primary" style={{ marginTop: 18 }} onClick={finish}>
          {t('filledCta')}
        </button>
      </div>
    </div>
  );
}

function Rule({ icon, bg, title, sub }: { icon: ReactNode; bg: string; title: string; sub: string }) {
  return (
    <div className="rule">
      <div className="rule__ic" style={{ background: bg }} aria-hidden>
        {icon}
      </div>
      <div>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
    </div>
  );
}

function HeroCard({ ticker }: { ticker: string }) {
  const q = useQuote(ticker);
  const m = metaOf(ticker);
  const chg = q?.totalChangePct ?? 0;
  return (
    <div className="floatcard">
      <TickerTile meta={m} size="sm" />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{m.nameEn}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)' }}>
          {m.ticker} · {m.sectorEn}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="num" style={{ fontSize: 15, fontWeight: 800 }}>
          {money(q?.price ?? m.initialPrice)}
        </div>
        <div className="num" style={{ fontSize: 12, fontWeight: 700, color: chg >= 0 ? '#FFC7CF' : '#BBD6FF' }}>
          {signedPct(chg)}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   코치마크 기하 상수 (CoachStep 전용)
   ══════════════════════════════════════════════════════════════════════════ */
/** 말풍선 좌우 여백 (.screen 기준) */
const COACH_INSET = 32;
/** 말풍선 아래 꼬리 정사각형 한 변 (.coach::after 와 «반드시» 같아야 한다) */
const COACH_TAIL = 16;
/** 꼬리가 말풍선 라운드(16px)를 넘어 삐져나오지 않게 하는 좌우 최소 여백 */
const COACH_TAIL_EDGE = 18;
/** 말풍선 아랫변 ~ 대상 버튼 윗변 사이 간격 */
const COACH_GAP = 20;

/**
 * 실화면 위 스포트라이트 코치마크 — 별도 튜토리얼 페이지를 만들지 않는다.
 *
 * ══ 2026-08-18 재구성 (President 실기기 지적 2건) ══════════════════════════
 * 【이전 구조의 결함 — 390x844 실측】
 *   (1) 말풍선 꼬리가 «하드코딩» 이었다: `.coach::after { left: 44px }`.
 *       말풍선은 left:32 라 꼬리 중심이 x=84. 대상 「사기」 버튼 중심은 x=287.4.
 *       ★203.4px 어긋났고, 꼬리는 하필 옆의 「팔기」 버튼(x 18~167.6)을 가리켰다.
 *       — 「사보라」고 말하면서 화살표는 「팔기」를 찍고 있었다.
 *   (2) 강조용 `.spot` 은 실제 버튼 위에 얹은 «복제 버튼» 이었고 좌표도
 *       하드코딩(left:52% -> x 202.8~372)이었다. 진짜 버튼은 flex 1.3 이라
 *       x 177.6~372. ★왼쪽 25.2px 이 덮이지 않아 어두운 빨간 띠가 삐져나왔고,
 *       그 위에 보라색 링까지 겹쳐 「테두리가 이상한」 이중 테두리로 보였다.
 *
 * 【지금 구조】 좌표를 다시 박지 않는다.
 *   · 복제 버튼을 «없앴다». 진짜 「사기」 버튼 자체를 z-index 로 dim 위에 올린다
 *     -> 어긋날 두 번째 사각형이 아예 존재하지 않는다.
 *   · 말풍선은 그 버튼의 실측 rect 를 따라간다(ResizeObserver + resize).
 *     화면폭·로케일·글자길이·폰트로딩이 뭘 바꾸든 꼬리는 버튼 중심을 가리킨다.
 */
function CoachStep({ ticker, busy, onBuy }: { ticker: string; busy: boolean; onBuy: () => void }) {
  const { t, i18n } = useTranslation('onboarding');
  const ko = i18n.language !== 'en';
  const s = useStore();
  const q = useQuote(ticker);
  const m = metaOf(ticker);
  const price = q?.price ?? m.initialPrice;
  const chg = q?.totalChangePct ?? 0;
  const chgAbs = (price * chg) / 100;
  const series = useMemo(() => s.series(ticker, 90), [s, ticker]);

  const screenRef = useRef<HTMLDivElement>(null);
  const buyRef = useRef<HTMLButtonElement>(null);
  /** 대상 버튼 실측에서 «유도»한 말풍선 좌표. null = 아직 측정 전(첫 레이아웃 직전) */
  const [anchor, setAnchor] = useState<{ bottom: number; tailX: number } | null>(null);

  /*
   * useEffect 가 아니라 useLayoutEffect 다 — 페인트 «전»에 측정+재렌더가 끝나야
   * 사용자가 어긋난 말풍선을 한 프레임도 보지 않는다.
   * 관측 대상 2개: 버튼(폰트 로딩·로케일로 높이/폭이 바뀐다) + 화면(회전·리사이즈).
   * 말풍선은 position:absolute 라 둘 중 어느 크기에도 영향을 주지 않는다 -> 관측 루프 없음.
   */
  useLayoutEffect(() => {
    const screen = screenRef.current;
    const buy = buyRef.current;
    if (!screen || !buy) return;

    const measure = () => {
      const sr = screen.getBoundingClientRect();
      const br = buy.getBoundingClientRect();
      if (sr.width === 0 || br.width === 0) return;
      const bubbleW = sr.width - COACH_INSET * 2;
      // 버튼 중심 (.screen 좌상단 기준) -> 말풍선 좌상단 기준 꼬리 left
      const raw = br.left + br.width / 2 - sr.left - COACH_INSET - COACH_TAIL / 2;
      const tailX = Math.min(
        Math.max(raw, COACH_TAIL_EDGE),
        Math.max(COACH_TAIL_EDGE, bubbleW - COACH_TAIL_EDGE - COACH_TAIL)
      );
      const bottom = sr.height - (br.top - sr.top) + COACH_GAP;
      setAnchor((prev) =>
        prev && Math.abs(prev.bottom - bottom) < 0.5 && Math.abs(prev.tailX - tailX) < 0.5
          ? prev // 값이 같으면 새 객체를 만들지 않는다(리렌더 억제)
          : { bottom, tailX }
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(screen);
    ro.observe(buy);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div className="screen" ref={screenRef} style={{ background: 'var(--surface)' }}>
      <div className="appbar appbar--surface">
        <TickerTile meta={m} size="xs" />
        <span className="appbar__title">{ko ? m.nameKo : m.nameEn}</span>
      </div>
      <div style={{ padding: '2px 20px 0' }}>
        <div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 600 }}>
          {m.ticker} · {ko ? m.sectorKo : m.sectorEn}
        </div>
        <div className="num" style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 4 }}>
          {money(price)}
        </div>
        <div className={`num ${chg >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
          {signedMoney(chgAbs)} ({signedPct(chg)}){' '}
          <span style={{ color: 'var(--t3)', fontWeight: 500 }}>{t('common:today')}</span>
        </div>
      </div>
      <AreaChart data={series} height={190} />
      <div style={{ flex: 1 }} />
      <div className="orderbar">
        {/* 「팔기」는 코치 단계에서 비활성이다 — dim(z:60)이 덮고 있어 이미 누를 수 없다 */}
        <button className="btn btn--lg btn--sub" style={{ flex: 1 }}>
          {t('common:sell')}
        </button>
        {/*
          ★대상은 «이 버튼 하나»다. 예전처럼 위에 복제 버튼을 얹지 않는다.
            .coach-target 이 z-index 로 dim 위에 올려 스포트라이트를 만든다.
        */}
        <button
          ref={buyRef}
          type="button"
          className="btn btn--lg coach-target"
          onClick={onBuy}
          disabled={busy}
          style={{ flex: 1.3, background: 'var(--up)', color: '#fff' }}
        >
          {t('common:buy')}
        </button>
      </div>

      {/* 코치마크 오버레이 */}
      <div className="coach-dim" />
      <div
        className="coach"
        style={
          {
            left: COACH_INSET,
            right: COACH_INSET,
            // 측정 전 1프레임용 폴백. useLayoutEffect 가 페인트 전에 실측값으로 덮는다.
            bottom: anchor ? anchor.bottom : 'calc(var(--safe-bottom) + 76px)',
            '--coach-tail-x': anchor ? `${anchor.tailX}px` : `calc(50% - ${COACH_TAIL / 2}px)`,
          } as CSSProperties
        }
      >
        {t('coachBubble')}
        <br />
        <span style={{ fontWeight: 400, opacity: 0.85, fontSize: 12 }}>{t('coachBubbleSub')}</span>
      </div>
      <div style={{ position: 'absolute', zIndex: 62, left: 0, right: 0, top: 120, textAlign: 'center', color: '#fff' }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', opacity: 0.6 }}>{t('coachStep')}</div>
        <div style={{ fontSize: 23, fontWeight: 800, marginTop: 8, letterSpacing: '-0.02em' }}>{t('coachTitle')}</div>
      </div>
    </div>
  );
}

/** 온보딩에서 쓰는 대표 종목 메타(테스트/스토리북용 export) */
export const ONBOARDING_PICKS = PICKABLE.map((tk) => TICKERS.find((x) => x.ticker === tk)!);
