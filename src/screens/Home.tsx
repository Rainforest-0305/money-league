import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { BrandMark, Icon, PriceText, Sheet } from '../components/Primitives';
import { AttendanceSummary } from '../components/AttendanceStrip';
import { AttendanceBonus, useAttendanceBonusState } from '../components/AttendanceBonus';
import { ATTENDANCE_CYCLE_DAYS, cyclePosition } from '../lib/attendance';
import { AreaChart, LiquidationGauge } from '../components/Charts';
import { StockRow } from '../components/StockRow';
import { MacroCard, MacroFeedRow } from '../components/MacroCard';
import { AdBanner } from '../components/AdBanner';
import { useRewardAd } from '../components/RewardAd';
import { adPreviewMode } from '../lib/ads';
import { dismissPushNudge, enablePush, usePushState } from '../toss/pushAgreement';
import { metaOf, useStore, useTick } from '../store/hooks';
import { bigMoney, compactMoney, money, pct, signedBigMoney, signedMoney, signedPct, sumCell } from '../lib/format';
import {
  EQUITY_HISTORY_LEN,
  GAME_DAY_REAL_SECONDS,
  LEADERBOARD_SIZE,
  SEED_CASH,
  TICKS_PER_GAME_DAY,
  TICK_MS,
  TOPUP_AMOUNT,
} from '../lib/constants';
import { TICKERS } from '../data/tickers.generated';

/**
 * 홈 「내 종목」에 인라인으로 그리는 최대 개수.
 * 이 수 이하면 «전부 보이므로» 「모두 보기」 링크를 띄우지 않는다 —
 * 1개뿐인데 「1개 전체 보기」가 있는 게 President 가 지적한 그 위화감이다.
 */
const HOME_HOLDINGS_SHOWN = 5;

type Filter = 'up' | 'down' | 'vol';

export function Home() {
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('home');
  /* ★총자산 숫자를 «남은 폭»에 맞춘다 (President 2026-09-06 「대출」 알약 추가 후 실측 넘침 — verify_eqplus).
     글자수 단계(--long/--xlong)는 첫 추정일 뿐, 알약 개수·로케일 폭을 모른다. 실제 폭으로 재측정해 줄인다. */
  const eqRowRef = useRef<HTMLDivElement>(null);
  const ko = i18n.language !== 'en';
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<Filter>('up');
  const [attendOpen, setAttendOpen] = useState(false);

  const p = s.portfolio;
  const equity = p?.equity ?? 0;
  const eqFit = useFitFontSize(eqRowRef, bigMoney(equity), 16);
  /* ★수익률 분모는 ★엔진이 준다(`world.investedBase`) — 랭킹이 쓰는 «바로 그 값»이다.
     ⛔`SEED_CASH * (1 + topupCount)` 로 다시 만들지 마라: 공유 리워드(bonusSeed)가 빠져
       홈 수익률과 랭킹 수익률이 «다른 숫자»가 된다(에러는 안 난다). */
  const base = p?.investedBase ?? SEED_CASH;
  const pnl = equity - base;
  const pnlPct = base > 0 ? (equity / base - 1) * 100 : 0;
  const myRank = s.myRank;

  const movers = useMemo(() => {
    const rows = TICKERS.map((m) => {
      const q = s.getQuote(m.ticker);
      return { m, chg: q?.totalChangePct ?? 0, sigma: m.sigma };
    });
    if (filter === 'up') rows.sort((a, b) => b.chg - a.chg);
    else if (filter === 'down') rows.sort((a, b) => a.chg - b.chg);
    else rows.sort((a, b) => b.sigma - a.sigma);
    return rows.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, s.tickVersion]);

  /*
   * ⛔★출석 지급을 «여기서» 하지 마라 (2026-08-22 실측으로 잡은 결함).
   *   화면 마운트는 ★부팅(워밍업 + 저장본 복원)보다 «먼저» 일어난다.
   *   그 시점에 현금을 더하면 뒤이어 `restore()` 의 `deserialize` 가
   *   ★`acc.cash` 를 저장값으로 «덮어써» 지급분이 통째로 사라진다.
   *   ⇒ 증상: ★일지에는 7건이 쌓였는데 잔고는 그대로. 에러는 «안» 난다.
   *   ⇒ 지급은 `store.boot()` 가 끝난 «뒤»와 «앱 복귀» 시점에 한다(store.ts 참조).
   */

  const top3 = s.ranks.slice(0, 3);
  /* ★토스 푸시 동의 안내(2026-09-10). 토스 안 + 미동의 + 안 닫음일 때만 `push.nudge` 가 true */
  const push = usePushState();
  /* ★[-33] 출석 시트 「추가 지급(광고)」 버튼 상태 — 닫기 버튼의 위계를 정하는 데만 쓴다 */
  const bonusState = useAttendanceBonusState();

  return (
    <div className="screen">
      {collapsed ? (
        <div className="appbar appbar--bordered">
          <span style={{ fontSize: 16, fontWeight: 800 }}>
            {t('common:totalValue')} <PriceText value={equity} render={(v) => bigMoney(v)} />
          </span>
          <span className={`num ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 12, fontWeight: 700, marginLeft: 6 }}>
            {signedPct(pnlPct)}
          </span>
          <ConnBadge />
        </div>
      ) : (
        <div className="appbar">
          <span className="logo">
            <BrandMark />
            {t('common:appName')}
          </span>
          {/*
            ★게임 시간 상시 표시 (President 지시 2026-08-19: 「실제 시간과 게임 내
              시간이 다르다는 걸 공지해야 한다」).
            ★모달·경고문으로 «말하지» 않고, 날짜가 실제로 «흘러가는 걸 보여준다».
              온보딩에서 한 번 읽고 마는 안내보다 이게 오래 간다.
            ★애니메이션 없음 = 프레임 비용 0. 값이 바뀔 때만 텍스트가 바뀐다.
          */}
          <span className="gameday num" title={t('gameDayTip', { m: GAME_DAY_REAL_SECONDS / 60 })}>
            {t('gameDayN', { n: s.gameDay + 1 })}
          </span>
          <ConnBadge />
          {/*
            ★[제거 2026-08-22, 어포던스 감사] 「알림」 종 버튼.
              ★실측: 44x44 짜리 «눌려 보이는» 버튼인데 ★onClick 이 없었다.
                게다가 이 앱에는 알림 채널 배선이 0 건이다
                (2026-08-20 에 같은 이유로 설정의 알림 스위치 3종을 이미 걷어냈다).
              ⇒ 어포던스와 동작을 «일치»시킨다: 열 게 없으면 눌려 보이지 않아야 한다.
              ★되살리려면 «알림이 실제로 가는 것»을 먼저 만들고 그 다음에 버튼을 붙여라.
                순서가 반대면 또 거짓말이다.
          */}
          <button
            className="iconbtn"
            style={{ marginLeft: 'auto' }}
            onClick={() => nav('/stocks')}
            aria-label={t('common:search')}
          >
            {Icon.search}
          </button>
        </div>
      )}

      <div className="scroll" onScroll={(e) => setCollapsed(e.currentTarget.scrollTop > 110)}>
        {/* ① 총자산 → ② 오늘 손익 → ③ 현금·평가금액·순위 */}
        <div style={{ padding: '6px 20px 0' }}>
          {/*
            ★인사말 줄 오른쪽 «출석 칩» (2026-08-30 President 「출석표 같은 걸로 날마다 보상이 는다는 걸 알게 해야지」).
              출석 보상은 부팅 때 토스트 한 번으로 끝나서, 닫히고 나면 「오늘이 며칠째인지」를 볼 곳이 없었다.
              ⇒ 칩 한 줄(「출석 4/7 · 내일 $30K」)이 «상시» 남고, 누르면 7칸 출석표 시트를 «다시 열기만» 한다.
            ⛔여기서 지급하지 않는다(아래 ⛔주석 그대로). 칩은 `s.attendance.state` 를 «읽기만» 한다.
            ★히어로 높이는 안 바뀐다 — 칩이 인사말과 «같은 줄»이라 광고 배너 위치·총자산 줄 실측(verify_eqplus)이 그대로다.
          */}
          <div className="herotop">
            <div className="herotop__greet">{t('greeting', { name: s.session?.nickname ?? '' })}</div>
            <AttendChip onOpen={() => setAttendOpen(true)} />
          </div>
          {/*
            ★④ 「광고 보고 충전」 진입점 = 총자산 숫자 «오른쪽» 「+ 충전」 알약 하나.
              (2026-08-29 President 지시 「광고 보고 충전을 자산액 밑으로 빼지 말고 자산액 오른쪽에 + 느낌으로 넣으면 안 돼?」
               → 재작업 「+만 하면 어떡해 간략한 설명이라도 있어야지」 ⇒ 「+」 SVG 선 + 두 글자 라벨(chargeShort))
              ★직전 판의 손익 «아래» 알약(.chargechip)은 폐기했다. 「오늘 손익」은 총자산 바로 아래로 돌아왔다.
              ★홈 줄의 라벨은 «상태와 무관하게» 「충전」/「Top up」으로 고정한다 — 길이가 흔들리면 숫자 폭 계산이 흔들린다.
                무료·적립·광고 구분은 접근성 라벨(상태별)과 누른 «뒤» 토스트가 맡는다.
            ★한 줄 규율: 숫자는 nowrap + min-width 0, 알약은 flex 0 0 auto + nowrap ⇒ 알약은 «절대 두 번째 줄로 안 내려간다».
              알약이 넓어진 만큼(en 「+ Top up」≈85px) 13자(「$1,234,567.89」)부터 «숫자 폰트만» clamp 로 내린다(.eqnum--long),
              15자(「$123,456,789.01」)부터 한 단계 더(.eqnum--xlong). 11자(「$139,640.53」)는 36px 그대로 — 실측 scripts/verify_eqplus.py.
            ★규칙은 «하나도 새로 만들지 않았다» — 지면·보상·상한·지급 경로 전부 충전 화면(Recharge)과 같다:
                파산이면 → 무료 충전(/recharge)   ·   광고 몫이 적립돼 있으면 → 바로 받기(doTopup('ad'))
                아니면   → 리워드 광고(useRewardAd('topup') → doTopup('ad'))
              광고 상한(하루 10회)·현금 액수(TOPUP_AMOUNT)·수익률 분모(topupCount)는 엔진이 그대로 센다.
            ★광고 라벨은 버튼 «옆»이 아니라 «누른 뒤» 토스트로 준다(chargeAd 「광고 보고 $10,000 충전」). 접근성 라벨도 같은 문구.
            ★광고가 안 되는 환경(웹·구버전)에서 «광고 몫이 없으면» 버튼이 «아예 안 그려진다» — 죽은 버튼 0.
          */}
          <div className="eqrow" ref={eqRowRef}>
            {/* ★10억 이상은 bigMoney 가 「$1.00B」·「$1.00T」로 축약 — 글자 수 단계(13/15자)는 그 아래에서만 돈다 */}
            <PriceText
              value={equity}
              render={(v) => bigMoney(v)}
              className={`eqnum${bigMoney(equity).length >= 15 ? ' eqnum--xlong' : bigMoney(equity).length >= 13 ? ' eqnum--long' : ''}`}
              style={eqFit ? { fontSize: eqFit } : undefined}
            />
            <ChargePlus />
            <LoanPill />
          </div>
          <div className="eqpnl" style={{ marginTop: 6 }}>
            <span className={`num ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15, fontWeight: 700 }}>
              {t('todayPnl', { v: signedBigMoney(pnl), p: signedPct(pnlPct) })}
            </span>
          </div>
          {/*
            ★부채·순자산 — 2026-09-05 대출 도입(President 지시).
            ⛔부채가 «0 이면 아무것도 그리지 않는다». 대출을 안 쓰는 유저의 화면은 «완전히 그대로»다
              (라이브 유저 전원이 그 상태다 — 새 줄이 이유 없이 생기면 그 자체가 회귀다).
            ★큰 숫자(총자산)는 위에 그대로 두고, 여기서는 «작게» 두 값만 덧붙인다 —
              화면의 주인공은 여전히 총자산이다.
            ★문구는 대출 화면과 같은 임시 로컬 표 방식이다(locales 는 광고 레인 소유).
          */}
          {(p?.debt ?? 0) + (p?.overdraft ?? 0) > 0 && (
            <div
              className="eqpnl num"
              style={{ marginTop: 4, display: 'flex', gap: 12, fontSize: 12.5, fontWeight: 700 }}
            >
              <span style={{ color: 'var(--down)' }}>
                {ko ? '부채' : 'Debt'} {bigMoney((p?.debt ?? 0) + (p?.overdraft ?? 0))}
              </span>
              <span style={{ color: 'var(--t2)' }}>
                {ko ? '순자산' : 'Net'} {bigMoney(p?.netWorth ?? 0)}
              </span>
              {(p?.overdraft ?? 0) > 0 && (
                <span style={{ color: 'var(--down)' }}>
                  {ko ? '연체' : 'Overdue'} {pct((p?.overdraftRate ?? 0) * 100, 1)}
                </span>
              )}
            </div>
          )}

          {/* ★[□8] 카드 3장 → 한 카드 3열. 근거는 app.css 의 .sumrow 주석 참조 */}
          <div className="sumrow">
            <div>
              <div className="sumrow__k">{t('common:cash')}</div>
              {/* ★6자리($270,000.00)부터 옆 칸을 침범하던 결함(라이브 -20 부터) → sumCell: 11자부터 폰트 단계, 7자리부터 축약. app.css .sumrow 주석 */}
              <SumValue v={p?.cash ?? 0} />
            </div>
            <div>
              <div className="sumrow__k">{t('common:positions')}</div>
              <SumValue v={(p?.holdingsValue ?? 0) + derivValue(s)} />
            </div>
            <button className="sumrow__link" onClick={() => nav('/rank')}>
              <div className="sumrow__k" style={{ color: 'var(--brand-ink)' }}>
                {t('common:myRank')}
              </div>
              <div className="sumrow__v num" style={{ color: 'var(--brand-ink)' }}>
                {myRank ? t('common:rankUnit', { n: myRank.rank }) : t('common:rankUnit', { n: '100+' })}
                {myRank && myRank.delta ? (
                  <span className={myRank.delta > 0 ? 'up' : 'down'} style={{ fontSize: 11, marginLeft: 4 }}>
                    {myRank.delta > 0 ? '▲' : '▼'}
                    {Math.abs(myRank.delta)}
                  </span>
                ) : null}
              </div>
            </button>
          </div>
        </div>

        {/* ④ 자산 흐름 */}
        <div className="sec" style={{ marginTop: 20 }}>
          <div className="card card--lg" style={{ padding: '16px 0 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 18px 10px' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{t('assetFlow')}</span>
              <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>
                {t('assetFlowSub', { d: (EQUITY_HISTORY_LEN / TICKS_PER_GAME_DAY).toFixed(1), s: TICK_MS / 1000 })}
              </span>
            </div>
            <AreaChart data={s.equityHistory.length > 1 ? s.equityHistory : [base, equity]} height={96} showBaseline={false} marks={s.equityMarks} />
            {/* ★[-23] 세션을 넘어 이어진 그래프 — 점선이 뜬 뒤에만 그 뜻을 한 줄 말한다(없으면 소음) */}
            {s.equityMarks.length > 0 && s.equityHistory.length > 1 && (
              <p className="hint" style={{ margin: '8px 18px 0', fontSize: 11, color: 'var(--t3)' }}>
                {t('assetFlowSeam')}
              </p>
            )}
          </div>
        </div>

        {/*
          ★④-B 「지금 일어나는 일」 — 진행 중인 거시 이벤트 (2026-08-20 신설)

          ★★왜 «여기»인가 [배치 근거]:
            ① 이벤트를 «알아채는 것»이 이 게임의 실력이다(인계문서 §6: 읽고 20배 +24.3% vs 랜덤 20배 -70.2%).
               ⇒ 피드(⑧, offset ≈1,088)에만 두면 «끝까지 내리는 사람»만 본다 = 사실상 노출 0.
                 그건 앞 레인이 홈 배너를 위로 올린 것과 «똑같은 이유»다.
            ② 그렇다고 최상단(자산·손익)을 밀어내지 않는다 — 홈의 주인공은 «내 돈»이다.
               ⇒ 자산 흐름 «바로 아래», 내 종목 «바로 위». 「시장이 지금 이렇다 → 그래서 내 종목은」의 순서다.
          ★★그리고 ★진행 중이 아니면 «아무것도 그리지 않는다» — 빈 껍데기를 남기면
            그 자리가 「가끔 뭔가 뜨는 죽은 칸」이 된다. 있을 때만 있는 게 맞다.
          ★배너 위치 영향: 이 카드는 «가끔만» 뜨고 높이 ≈120px 이라, 홈 배너의
            「첫 화면(710) 밖 · 바닥에서 멀리」 조건을 양쪽 다 유지한다.
        */}
        {s.macro && (
          <div className="sec">
            <div className="sec__h">{t('macroNow')}</div>
            <MacroCard view={s.macro} />
          </div>
        )}

        {/* ⑤ 내 종목 */}
        <div className="sec">
          {/*
            ★[버그 수정 2026-08-20, President 실기기 지적]
              예전: 보유가 «1개여도» 「1개 전체 보기 ›」가 뜨고, 누르면 /stocks
                    (= 전체 100종목 화면)로 갔다. 「내 종목 보기」 기대와 완전히 다른 곳이다.
                    게다가 바로 아래 「지금 많이 오른 종목」의 「전체 ›」와 «같은 목적지»였다 —
                    라벨이 둘인데 가는 곳이 하나면 그 자체가 버그다.
              고침: ① 홈은 보유를 «5개까지» 인라인으로 다 보여준다 → 그 이하면 링크가 «필요 없다»
                    ② 6개 이상일 때만 링크를 띄우고, 목적지를 ★종목 탭의 «보유» 필터로 보낸다
                       (/stocks?own=1). 실제로 «내 종목만» 나오는 화면이다
                    ③ 문구도 「전체 보기」 → 「N개 모두 보기」
          */}
          <div className="sechead">
            <h3>{t('myStocks')}</h3>
            {(p?.holdings.length ?? 0) > HOME_HOLDINGS_SHOWN && (
              <button className="sechead__more" onClick={() => nav('/stocks?own=1')}>
                {t('seeAllN', { n: p?.holdings.length ?? 0 })} ›
              </button>
            )}
          </div>
          {p?.holdings.length ? (
            <div className="card card--lg card--list">
              {p.holdings.slice(0, HOME_HOLDINGS_SHOWN).map((h, i) => (
                <div key={h.ticker}>
                  {i > 0 && <div className="divider divider--inset" />}
                  <StockRow
                    ticker={h.ticker}
                    holdingQty={h.qty}
                    holdingAvg={h.avgCost}
                    sparkline={s.series(h.ticker, 24)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="card card--lg" style={{ padding: 22, textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{t('emptyStocks')}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{t('emptyStocksSub')}</div>
              <button className="btn btn--sub" style={{ marginTop: 14 }} onClick={() => nav('/stocks')}>
                {t('emptyStocksCta')}
              </button>
            </div>
          )}
        </div>

        {/* ⑥ 파생 포지션 */}
        {Boolean((p?.leverage.length ?? 0) + (p?.options.length ?? 0) + s.forwards.length + s.swaps.length) && (
          <div className="sec">
            <div className="sechead">
              <h3>{t('derivPositions')}</h3>
              <button className="sechead__more" onClick={() => nav('/derivatives')}>
                {t('common:manage')} ›
              </button>
            </div>
            <div className="card card--lg" style={{ padding: 0, overflow: 'hidden' }}>
              {p?.leverage.map((lv, i) => {
                const buffer = Math.abs(lv.price - lv.liquidationPrice) / lv.price * 100;
                return (
                  <div key={lv.id}>
                    {i > 0 && <div className="divider" />}
                    <div style={{ padding: '15px 16px 13px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 800,
                            color: '#fff',
                            background: lv.side === 'long' ? 'var(--up)' : 'var(--down)',
                            padding: '3px 8px',
                            borderRadius: 7,
                          }}
                        >
                          {lv.side === 'long'
                            ? t('derivatives:longX', { x: lv.leverage })
                            : t('derivatives:shortX', { x: lv.leverage })}
                        </span>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>
                          {ko ? metaOf(lv.ticker).nameKo : metaOf(lv.ticker).nameEn}
                        </span>
                        <span className={`num ${lv.pnl >= 0 ? 'up' : 'down'}`} style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 800 }}>
                          {signedMoney(lv.pnl)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
                        <span>{t('derivatives:marginLabel', { v: money(lv.margin, 0) })}</span>
                        <span>{t('derivatives:entryLabel', { v: money(lv.entryPrice) })}</span>
                        <span>
                          {t('derivatives:liqLabel', { v: '' })}
                          <b className="num" style={{ color: 'var(--down)' }}>{money(lv.liquidationPrice)}</b>
                        </span>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <LiquidationGauge bufferPct={buffer} side={lv.side} />
                        <div className="gauge__legend">
                          <span>{t('derivatives:forcedLiq', { v: money(lv.liquidationPrice) })}</span>
                          <span style={{ color: 'var(--t1)', fontWeight: 700 }}>
                            {t('derivatives:safeDistance', { v: money(lv.price), p: `${buffer.toFixed(1)}%` })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* ★선도·스왑도 «같은 섹션»에 둔다 — 사양서 §5 「새 섹션을 만들지 마라」 */}
              {p?.options.map((op, i) => (
                <div key={op.id}>
                  {(i > 0 || (p?.leverage.length ?? 0) > 0) && <div className="divider" />}
                  <div style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: '#fff',
                          background: 'var(--brand)',
                          padding: '3px 8px',
                          borderRadius: 7,
                        }}
                      >
                        {t(op.kind === 'call' ? 'derivatives:call' : 'derivatives:put')}
                      </span>
                      {op.side === 'sell' && (
                        <span className="badge badge--weak">{t('derivatives:pos.sideSell')}</span>
                      )}
                      <span style={{ fontSize: 15, fontWeight: 700 }}>
                        {t('derivatives:strikeAt', {
                          name: ko ? metaOf(op.ticker).nameKo : metaOf(op.ticker).nameEn,
                          v: money(op.strike, 0),
                        })}
                      </span>
                      <span className={`num ${op.pnl >= 0 ? 'up' : 'down'}`} style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 800 }}>
                        {signedMoney(op.pnl)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--t3)' }}>
                      <span>{t('derivatives:optMeta', { n: op.contracts, d: op.remainGameDays.toFixed(1) })}</span>
                      {/*
                        ★★매도 포지션에서 「지금 팔면 {{v}}」는 «거짓»이다 — 파는 게 아니라 «되사는» 것이고,
                          돈이 «들어오는» 게 아니라 «나간다». 문구를 갈라 쓴다.
                        ★그리고 값도 `value`(=증거금−되사기값)가 아니라 ★`mark`(되사기 비용)다.
                      */}
                      <span>
                        {op.side === 'sell'
                          ? t('derivatives:pos.buyback', { v: money(op.mark) })
                          : t('derivatives:sellNow', { v: money(op.mark) })}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {[...s.forwards.map((f) => ({ kind: 'forward' as const, f })), ...s.swaps.map((w) => ({ kind: 'swap' as const, w }))].map(
                (row, i) => {
                  const isFwd = row.kind === 'forward';
                  const v = isFwd ? row.f : row.w;
                  const nameA = ko ? metaOf(isFwd ? row.f.ticker : row.w.tickerA).nameKo : metaOf(isFwd ? row.f.ticker : row.w.tickerA).nameEn;
                  const label = isFwd ? nameA : t('derivatives:pos.swapPair', { a: metaOf(row.w.tickerA).ticker, b: metaOf(row.w.tickerB).ticker });
                  return (
                    <div key={v.id}>
                      {(i > 0 || (p?.options.length ?? 0) > 0 || (p?.leverage.length ?? 0) > 0) && <div className="divider" />}
                      <div style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`pbadge ${isFwd ? 'pbadge--fwd' : 'pbadge--swp'}`}>
                            {t(isFwd ? 'derivatives:pos.badgeForward' : 'derivatives:pos.badgeSwap')}
                          </span>
                          <span style={{ fontSize: 15, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {label}
                          </span>
                          <span className={`num ${v.pnl >= 0 ? 'up' : 'down'}`} style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 800 }}>
                            {signedMoney(v.pnl)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--t3)' }}>
                          <span>{t('derivatives:marginLabel', { v: money(v.margin, 0) })}</span>
                          <span>{t('derivatives:pos.remain', { n: v.remainGameDays.toFixed(1) })}</span>
                        </div>
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          </div>
        )}

        {/*
          ⑥-b 「리그 순위 알림 받기」 안내 (2026-09-10 · President 「푸시 개통」).
            ★한 번만 묻는다: 「받기」→ 토스 동의창, 「닫기」→ 다시 안 뜬다(설정 > 알림에서 언제든 켤 수 있다).
            ★토스 밖·이미 동의·거부·닫음이면 «통째로» 안 그려진다 — 빈 래퍼 0(공유 리워드 행 규칙).
            ★자리: ⑤ 내 종목 «아래», ⑦ 많이 오른 종목 «위». 히어로(총자산 줄·verify_eqplus)는 «위»라 무접촉이고,
              광고 배너는 이 카드 «아래»라 더 내려갈 뿐 첫 화면 안으로 «들어오지 않는다»(verify_push 가 배너 top ≥ 710 을 센다).
              ⚠보유 종목이 0 인 빈 상태에서는 카드 top ≈ 673 으로 첫 화면 «안»에 걸린다 — 광고가 아니라 «우리 안내»라 정책 문제는 아니고,
              첫 방문자가 볼 자리로는 오히려 맞다. 홈 스크롤 길이는 카드 높이(≈87)만큼 는다.
            ★모달이 아니다 — 끼어들 이유가 없는 요청은 흐름 속 한 줄로 둔다(craft-floor: 보호할 포커스가 없으면 모달 금지).
        */}
        {push.nudge && (
          <div className="sec">
            <div
              className="card card--lg"
              style={{ padding: '14px 14px 14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}
              role="group"
              aria-labelledby="pushnudge-title"
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--brand-weak)',
                  color: 'var(--brand-ink)',
                  display: 'grid',
                  placeItems: 'center',
                  flex: '0 0 auto',
                }}
                aria-hidden
              >
                {Icon.bell}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span id="pushnudge-title" style={{ display: 'block', fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>
                  {t('pushNudgeTitle')}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{t('pushNudgeSub')}</span>
              </span>
              <button
                className="btn btn--primary"
                style={{ width: 'auto', minHeight: 36, padding: '0 14px', fontSize: 13, borderRadius: 10, flex: '0 0 auto' }}
                disabled={push.busy}
                onClick={() => void enablePush()}
              >
                {push.busy ? t('pushNudgeBusy') : t('pushNudgeCta')}
              </button>
              <button className="iconbtn" style={{ flex: '0 0 auto', marginRight: -6 }} onClick={dismissPushNudge} aria-label={t('pushNudgeClose')}>
                {Icon.close}
              </button>
            </div>
          </div>
        )}

        {/* ⑦ 지금 많이 오른 종목 */}
        <div className="sec">
          <div className="sechead">
            <h3>{t('topGainers')}</h3>
            <button className="sechead__more" onClick={() => nav('/stocks')}>
              {t('common:seeAll')} ›
            </button>
          </div>
          <div className="pillrow" style={{ padding: '0 0 12px' }}>
            {(['up', 'down', 'vol'] as Filter[]).map((f) => (
              <button
                key={f}
                className={`pill pill--ink ${filter === f ? 'pill--on' : ''}`}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                {f === 'up' ? t('filterUp') : f === 'down' ? t('filterDown') : t('filterVolatility')}
              </button>
            ))}
          </div>
          <div className="card card--lg card--list">
            {movers.map((row, i) => (
              <div key={row.m.ticker}>
                {i > 0 && <div className="divider" style={{ marginLeft: 64 }} />}
                <StockRow ticker={row.m.ticker} rankNo={i + 1} compactTile />
              </div>
            ))}
          </div>
        </div>

        {/*
          ★홈 배너 — 「스크롤 맨 끝」에서 «여기»로 올렸다 (⑦ 많이 오른 종목 ↔ ⑧ 체결 피드 사이).

          ★왜 올렸나 [실측]: 예전 자리는 offsetTop ★1,583 이었고 홈 전체 스크롤이 1,699 다.
            = 바닥에서 116px. 끝까지 내리는 사람만 보는 자리 = 사실상 노출 0.
          ★왜 «하필» 여기인가 [실측, 390x844 · 보이는 높이 710]:
              ① 상단 자산 0~212 · ④ 자산흐름 212~368 · ⑤ 내 종목 391~609
              ⑦ 많이 오른 종목 633~1,064 · ⑧ 체결 피드 1,088~ · ⑨ 탑100 1,259~
            - ⑤↔⑦ 사이(≈609)는 ⛔«첫 화면 안»이다(710 미만). 규칙 위반이라 뺐다.
            - ⑦↔⑧ 사이(≈1,064)는 첫 화면 «밖»이면서(354px 스크롤) 바닥에서 한참 위다. ✅
          ★오탭 방지: 바로 위가 «탭되는» 종목 행이다. 그래서 위 여백을 넉넉히 주고
            (.sec 여백 + 아래 margin + .adslot 자체 padding), 「광고」 라벨이 카드와 재질을 가른다.
          ★CLS: AdBanner 가 AD_RESERVED_H(72px)를 «미리» 차지한다 — 광고가 늦게 떠도 밀리지 않는다.
          ★홈에는 배너가 «이것 하나»다. 한 화면에 두 개가 겹칠 일이 없다.

          ⚠★[2026-08-21 실렌더로 잡은 결함] 여백이 `'6px 20px 2px'` 이었다. 실측 결과
            ★위 6px / 아래 30px 로 «완전히 비대칭»이었고, 이 화면의 리듬(.sec 간격 = 30)에서
            혼자 벗어나 있었다. 그림으로 보면 광고가 «위 카드에 붙은 부속»처럼 읽힌다.
            ⇒ 위 여백이 바로 위 「많이 오른 종목」 카드(★행이 탭된다)와의 거리이기도 하다:
              6 + .adslot 패딩 8 = ★14px 뿐이었다. 위 주석은 「위 여백을 넉넉히 주고」라고
              적혀 있었는데 코드가 그 반대였다 — 주석은 막지 못한다(U-4).
          ⇒ `'30px 20px 0'`. 위 30(=화면 리듬) · 아래는 다음 `.sec` 의 margin-top 30 과
            상쇄돼 그대로 30. 탭되는 행과의 거리는 14 → ★38px.
        */}
        <AdBanner slot="bannerHome" style={{ margin: '30px 20px 0' }} />

        {/* ⑧ 실시간 체결 피드 */}
        <div className="sec">
          <div className="sechead">
            <h3>{t('feedTitle')}</h3>
            <ConnBadge />
          </div>
          <div className="card card--lg" style={{ padding: '6px 0' }}>
            {s.feed.length === 0 && s.macroLog.length === 0 && s.settledLog.length === 0 && (
              <div style={{ padding: '16px', fontSize: 12, color: 'var(--t3)', textAlign: 'center' }}>{t('feedEmpty')}</div>
            )}
            {/*
              ★소식(거시 이벤트)을 «피드에 섞는다». 다만 «시간순으로 섞지» 않는다.
              ★왜: 이벤트는 게임 2~5일에 한 번이고 봇 체결은 «틱마다» 흐른다.
                시간순으로 꽂으면 소식이 몇 초 만에 아래로 밀려 «없는 것과 같아진다»
                (피드는 홈에서 4행만 보인다).
              ⇒ ★가장 최근 소식 1건을 «맨 위에» 두고 나머지 자리를 체결이 채운다.
                섞되 «묻히지 않게» 하는 것 — 그게 요구의 실제 내용이다.
            */}
            {s.macroLog[0] && <MacroFeedRow item={s.macroLog[0]} />}
            {s.macroLog[0] && <div className="divider divider--inset-sm" />}
            {/*
              ★★파생 «정산» 소식 (2026-08-21).
              ★왜 피드에 넣나: 정산은 「누가 파생으로 얼마를 벌었나/잃었나」가 «확정»되는 순간이다.
                체결 피드는 「샀다/팔았다」뿐이라 «결과»가 없다 — 시장이 살아 있다는 신호로는 약하다.
              ★내 정산은 여기 «오지 않는다» — 토스트로 간다(store.onSettled).
                같은 일을 두 곳에서 알리면 유저는 두 번 일어난 줄 안다.
            */}
            {s.settledLog[0] && <SettledFeedRow item={s.settledLog[0]} />}
            {s.settledLog[0] && <div className="divider divider--inset-sm" />}
            {s.feed.slice(0, Math.max(1, 4 - (s.macroLog[0] ? 1 : 0) - (s.settledLog[0] ? 1 : 0))).map((f) => (
              <FeedRow key={f.id} item={f} />
            ))}
          </div>
        </div>

        {/* ⑨ 탑100 위젯 */}
        <div className="sec">
          <div className="sechead">
            <h3>{t('top100', { n: LEADERBOARD_SIZE })}</h3>
            <button className="sechead__more" onClick={() => nav('/rank')}>
              {t('allRanks')} ›
            </button>
          </div>
          <div className="card card--lg card--list">
            {top3.map((r, i) => (
              <div key={r.accountId}>
                {i > 0 && <div className="divider divider--inset-sm" />}
                <button className="row" style={{ padding: '11px 16px' }} onClick={() => nav(`/trader/${r.accountId}`)}>
                  {/* ★메달 — 색 «그리고» 숫자로 구분한다(색만 쓰면 색맹 사용자에게 셋이 같다) */}
                  <span
                    style={{ width: 24, display: 'grid', placeItems: 'center', color: ['var(--gold)', 'var(--silver)', 'var(--bronze)'][i] }}
                    aria-hidden
                  >
                    {Icon.medal((i + 1) as 1 | 2 | 3, 19)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="row__nm" style={{ display: 'block' }}>
                      {r.nickname}
                    </span>
                    <span className="row__sub" style={{ display: 'block' }}>
                      {/* 「🤖 봇」 표시 제거 — President 지시 2026-08-18(랭킹 화면과 같은 토큰이라
                          여기만 남기면 홈 탑100 위젯에서 그대로 다시 보인다). 부제 줄이 비면
                          행 높이가 무너지므로 «참가자»로 채운다. */}
                      {t('rank:profileTitle')}
                    </span>
                  </span>
                  <span className="row__rt">
                    <span className="row__p num" style={{ display: 'block' }}>
                      {money(r.equity, 0)}
                    </span>
                    <span className={`row__c num ${r.pnlPct >= 0 ? 'up' : 'down'}`} style={{ display: 'block' }}>
                      {signedPct(r.pnlPct, 0)}
                    </span>
                  </span>
                </button>
              </div>
            ))}
            {myRank && (
              <button
                onClick={() => nav('/rank')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: 'calc(100% - 24px)',
                  margin: '6px 12px 10px',
                  background: 'var(--brand-weak)',
                  borderRadius: 14,
                  padding: '12px 14px',
                  textAlign: 'left',
                }}
              >
                {/*
                  ★[버그 수정 2026-08-21, 실렌더로 발견] width: 40 고정 → 「949위」가 «두 줄로 쪼개졌다».
                    ★참가자가 210명일 때는 최대 「211위」(3자리)였고 40px 에 겨우 들어갔다.
                      ★1,000명(30게임일차 3,310명)이 되면서 4자리가 «정상»이 됐다.
                    ★영어는 「#949」로 더 짧지만 로케일 가정을 하면 안 된다 — 최소폭 + 줄바꿈 금지로 푼다.
                */}
                <span
                  className="num"
                  style={{ minWidth: 40, flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: 15, fontWeight: 800, color: 'var(--brand-ink)' }}
                >
                  {t('common:rankUnit', { n: myRank.rank })}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="row__nm" style={{ display: 'block', color: 'var(--brand-ink)' }}>
                    {myRank.nickname} <span className="badge badge--brand">{t('rank:meBadge')}</span>
                  </span>
                  <span className="row__sub" style={{ display: 'block', color: 'var(--brand-ink)', opacity: 0.7 }}>
                    {/*
                      ★[버그 수정 2026-08-21, 실렌더로 발견] 「★3계단 오르면 940위권 진입」이 떴다.
                        ★949위에서 940위까지는 ★9계단이다. n 이 «상수 3» 으로 박혀 있어 문장이 틀렸다.
                        (목표 순위는 rank 에서 «유도»하는데 계단 수만 하드코딩이라 둘이 어긋났다)
                      ★고침: 목표(다음 10위권 경계)와 계단 수를 «같은 식»에서 유도한다.
                        target = 나보다 «한 구간 위»의 10 단위 경계 · n = rank − target
                        ⇒ 두 숫자가 한 소스에서 나오므로 서로 어긋날 수 없다.
                    */}
                    {myRank.rank > 3 ? t('myRankSub', rankStepHint(myRank.rank)) : t('myRankTop')}
                  </span>
                </span>
                <span className="row__rt">
                  <span className="row__p num" style={{ display: 'block', color: 'var(--brand-ink)' }}>
                    {money(myRank.equity, 0)}
                  </span>
                  <span className={`row__c num ${myRank.pnlPct >= 0 ? 'up' : 'down'}`} style={{ display: 'block' }}>
                    {signedPct(myRank.pnlPct, 1)}
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>

        {/* ★배너는 더 이상 여기(스크롤 끝)에 없다 — 아래 ⑦↔⑧ 사이로 «올렸다».
            실측 근거는 그 자리의 주석에 적어 뒀다. */}
        <div className="scroll-pad" />
      </div>

      {/*
        ★출석표 시트 — 기본 보상 «지급»은 여기서 하지 않는다(부팅 때 이미 끝났다).
          ⛔여기서 지급하면 위 ⛔주석의 그 결함(부팅 전 지급 → 복원이 덮어씀)이 재현된다.
        ★[2026-09-10 · -33] 「추가 지급(광고)」 «선택» 버튼이 여기 들어왔다(AttendanceBonus · 전략 2-2).
          예전엔 충전 화면 소진 단계에만 있어 토스 안에서는 사실상 «도달 불가»였다(출석 지면 노출 0의 원인).
          자동 재생 없음 · 첫 체결 또는 포트폴리오 확인 뒤에만 버튼 · 하루 1회 — 규칙은 그 컴포넌트 머리 주석.
      */}
      {attendOpen && (
        <Sheet onClose={() => setAttendOpen(false)} labelledBy="attend-sheet-title">
          <AttendanceSummary
            streak={s.attendance.state.streak}
            claimedToday={!s.attendanceToday().claimable && s.attendance.state.lastClaimedDate !== null}
            nextUsd={s.attendanceNextReward()}
            titleId="attend-sheet-title"
          />
          <AttendanceBonus />
          {/*
            ★위계: 광고 버튼(btn--sub)이 있을 때 「닫기」까지 같은 회색이면 «동급 선택 둘»로 읽힌다(실렌더로 확인).
              앱의 기존 문법(SeasonGate·청산 시트 = 행동 버튼 + ghost 닫기)대로 그때만 ghost 로 내린다.
              버튼이 없을 때(해제 전·토스 밖)는 전처럼 «유일한 조작»이라 btn--sub 그대로 — 기존 실렌더(verify_attend_ui) 무변경.
          */}
          <button
            className={bonusState === 'ready' ? 'btn btn--ghost' : 'btn btn--sub'}
            style={{ marginTop: bonusState === 'ready' ? 6 : 18 }}
            onClick={() => setAttendOpen(false)}
          >
            {t('common:close')}
          </button>
        </Sheet>
      )}
    </div>
  );
}

/**
 * 홈 인사말 줄 오른쪽 «출석 칩» — 「출석 4/7 · 내일 $30K」.
 *   ★`s.attendance.state` 를 «읽기만» 한다. 한 번도 받은 적이 없으면(부팅 전·손상값) 안 그린다 — 빈 칩을 남기지 않는다.
 *   ★n/7 은 «주기 안 위치»(cyclePosition)다. streak 11 이면 4/7. 하루 걸러 반토막 나면 위치도 뒤로 간다(거짓 표시 없음).
 */
function AttendChip({ onOpen }: { onOpen: () => void }) {
  const s = useStore();
  const { t } = useTranslation('home');
  const a = s.attendance.state;
  if (a.streak < 1 || a.lastClaimedDate === null) return null;
  const pos = cyclePosition(a.streak);
  const next = compactMoney(s.attendanceNextReward());
  return (
    <button
      type="button"
      className="attchip"
      onClick={onOpen}
      aria-label={t('attendChipLabel', { n: a.streak, v: money(s.attendanceNextReward(), 0) })}
    >
      <span className="attchip__i" aria-hidden="true">
        {Icon.checkSm(9)}
      </span>
      <span className="num" aria-hidden="true">
        {t('attendChip', { n: pos, total: ATTENDANCE_CYCLE_DAYS, v: next })}
      </span>
    </button>
  );
}

/**
 * 홈 총자산 옆 «+ 충전» 알약 — 충전 규칙의 «진입점»일 뿐이다. 판단은 전부 엔진(topupStatus)이 한다.
 * ★글리프는 폰트 「+」가 아니라 SVG 선이다(로케일·폰트에 따라 굵기·위치가 흔들리지 않는다).
 * ★보이는 라벨은 상태와 무관하게 chargeShort(「충전」/「Top up」) 하나로 «고정». 상태 설명은 접근성 라벨이 맡는다
 *   — chargeFree / chargeClaim / chargeAd.
 * ★광고 라벨(「광고 보고 …」)은 누른 «뒤» 토스트로 알린다. 금액은 상수에서 «유도»한다.
 */
/**
 * ★「대출」 알약 — 「+ 충전」 «옆»(President 2026-09-06: 「대출 버튼이 어딨어?」).
 *   대출 레인은 충전 «화면» 안에만 넣었다 — 지시는 홈의 충전 버튼 옆이었다. 여기 추가.
 *   ChargePlus 가 상태에 따라 null 을 돌려도 이 알약은 «항상» 보인다(대출은 상태 무관 진입점).
 *   연체(cash<0)면 disabled + 이유 — 규칙은 Recharge 의 대출 버튼과 «같다».
 *   같은 .eqplus 재질 — 재질을 새로 만들지 않는다(같은 일에 다른 문법 금지).
 */
/**
 * 첫 자식(.eqnum)이 형제 알약들 옆에서 «넘치지 않는» 최대 글자 크기를 돌려준다.
 *   측정: 행 폭 − (알약 폭 합 + gap) = 숫자에 허용된 폭. 숫자의 scrollWidth 가 그 안에 들도록
 *   현재 폰트에서 비례 축소. 하한 minPx. 폭·문자열이 바뀔 때만 다시 잰다(ResizeObserver + deps).
 *   ⛔글자수 단계 clamp 를 지우지 않는다 — SSR/첫 프레임의 추정치로 여전히 쓰인다.
 */
function useFitFontSize(rowRef: React.RefObject<HTMLDivElement | null>, text: string, minPx: number): number | undefined {
  const [fit, setFit] = useState<number | undefined>(undefined);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const num = row.querySelector<HTMLElement>('.eqnum');
      if (!num) return;
      const cs = getComputedStyle(row);
      const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
      let sib = 0;
      let count = 0;
      for (const el of Array.from(row.children)) {
        if (el === num) continue;
        sib += (el as HTMLElement).getBoundingClientRect().width;
        count++;
      }
      const avail = row.clientWidth - sib - gap * count - 10;   // 10 = 최소 여백(검사기 기준 gap≥10)
      // 현재 폰트로 잰 «내용» 폭. inline style 을 잠시 지우고 기준값을 얻는다.
      const prevInline = num.style.fontSize;
      num.style.fontSize = '';
      const basePx = parseFloat(getComputedStyle(num).fontSize) || 36;
      const need = num.scrollWidth;
      num.style.fontSize = prevInline;
      if (avail <= 0 || need <= 0) return;
      const next = need > avail ? Math.max(minPx, Math.floor(basePx * (avail / need) * 100) / 100) : undefined;
      setFit((cur) => (cur === next ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    return () => ro.disconnect();
  }, [rowRef, text, minPx]);
  return fit;
}

function LoanPill() {
  const s = useStore();
  const nav = useNavigate();
  const { i18n } = useTranslation('home');
  const ko = i18n.language !== 'en';
  const p = s.portfolio;
  const overdrawn = (s.topup?.overdrawn ?? (p?.overdraft ?? 0) > 0) === true;
  const label = overdrawn
    ? (ko ? '대출 — 연체 잔액을 먼저 갚아야 해요' : 'Loan — repay overdue balance first')
    : (ko ? '대출' : 'Loan');
  return (
    <button
      type="button"
      className="eqplus"
      aria-label={label}
      disabled={overdrawn}
      title={overdrawn ? label : undefined}
      onClick={() => nav('/loan')}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M3.5 9h11M10 4.5 14.5 9 10 13.5" />
      </svg>
      <span className="eqplus__t" aria-hidden="true">
        {ko ? '대출' : 'Loan'}
      </span>
    </button>
  );
}

function ChargePlus() {
  const s = useStore();
  const nav = useNavigate();
  const { t } = useTranslation('home');
  const st = s.topup;
  const ad = useRewardAd('topup', async () => {
    try {
      const amount = await s.doTopup('ad');
      s.pushToast(t('recharge:toppedUp', { v: money(amount, 0) }) as string);
    } catch {
      s.pushToast(t('common:err.GENERIC') as string, 'error');
    }
  });
  const [busy, setBusy] = useState(false);
  if (!st) return null;

  let label: string;
  let disabled = false;
  let onClick: () => void;
  if (st.freeEligible) {
    /* ① 파산 구제 — 기존 충전 화면으로 «보낸다»(규칙·문구 그대로) */
    label = t('chargeFree') as string;
    onClick = () => nav('/recharge');
  } else if (st.adPending > 0) {
    /* ② 이미 본 광고의 몫이 남아 있다 — 광고를 다시 틀지 않고 «그 자리에서» 받는다 */
    label = t('chargeClaim', { v: money(TOPUP_AMOUNT, 0) }) as string;
    disabled = busy;
    onClick = async () => {
      setBusy(true);
      try {
        const amount = await s.doTopup('ad');
        s.pushToast(t('recharge:toppedUp', { v: money(amount, 0) }) as string);
      } catch {
        s.pushToast(t('common:err.GENERIC') as string, 'error');
      } finally {
        setBusy(false);
      }
    };
  } else if ((ad.supported || adPreviewMode()) && st.adRemaining > 0) {
    /* ③ 광고 보고 받기 — 지원 환경 + 오늘 몫이 남았을 때만. (ads.preview 는 로컬 레이아웃 검증용)
       ★누르는 순간 「광고 보고 $10,000 충전」 토스트 = 광고 라벨. 지면·판정은 useRewardAd 그대로. */
    label = t('chargeAd', { v: money(TOPUP_AMOUNT, 0) }) as string;
    disabled = ad.busy;
    onClick = () => {
      s.pushToast(label);
      void ad.run();
    };
  } else {
    return null;
  }

  return (
    <button
      type="button"
      className="eqplus"
      aria-label={label}
      aria-busy={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M9 3.5v11M3.5 9h11" />
      </svg>
      <span className="eqplus__t" aria-hidden="true">
        {t('chargeShort')}
      </span>
    </button>
  );
}

/** 홈 요약 칸 값 — 표기·폰트 단계는 `lib/format.sumCell` 한 곳에서 «유도»한다(칸이 둘이라 여기서 다시 적지 않는다) */
function SumValue({ v }: { v: number }) {
  const c = sumCell(v);
  return (
    <div className={`sumrow__v num${c.cls}`} title={Math.abs(v) >= 1_000_000 ? money(v) : undefined}>
      {c.text}
    </div>
  );
}

/**
 * 「몇 계단 오르면 어느 구간」 — ★두 숫자를 «한 식»에서 유도한다.
 * ⛔계단 수를 상수로 박지 마라. 목표만 유도하고 계단 수를 고정하면 문장이 틀린다(실사고).
 */
export function rankStepHint(rank: number): { n: number; rank: number } {
  const target = Math.max(1, Math.floor((rank - 1) / 10) * 10);
  return { n: Math.max(1, rank - target), rank: target };
}

/**
 * 홈 「평가금액」에 더할 파생 가치.
 * ★★엔진 `world.equity()` 의 «합산 규칙과 같아야» 한다 — 다르면 총자산과 항목이 안 맞는다.
 *   equity(): cash + 보유 + Σmax(0, 레버리지) + Σ옵션가치 + Σmax(0, 선도) + Σmax(0, 스왑)
 * ★[2026-08-20] 선도·스왑이 «빠져 있었다» — 그 상품이 없던 시절 코드다.
 *   두 상품이 생긴 지금 그대로 두면 계약을 열자마자 「평가금액」만 줄어든 것처럼 보인다.
 */
function derivValue(s: ReturnType<typeof useStore>): number {
  const p = s.portfolio;
  if (!p) return 0;
  return (
    p.leverage.reduce((a, b) => a + Math.max(0, b.equity), 0) +
    p.options.reduce((a, b) => a + b.value, 0) +
    s.forwards.reduce((a, b) => a + Math.max(0, b.equity), 0) +
    s.swaps.reduce((a, b) => a + Math.max(0, b.equity), 0)
  );
}

/**
 * 실시간 배지 — 목업 mockup_home.html:117 의 `<span class="live"><i></i>실시간</span>`.
 *
 * 예전에는 live/delayed/mock 3상태였고 mock 이면 "오프라인 연습"으로 바뀌었다.
 * 정적 단독 빌드에는 서버가 없어 store 의 dataSource 자체가 사라졌고(연결이라는
 * 개념이 없다), 가격은 기기 안에서 2초마다 실제로 갱신된다. 그래서 상태 분기 없이
 * 항상 "실시간"이다. 되살리지 마라 — 없는 서버의 연결 끊김을 알리면 유저는
 * 게임이 고장난 줄 안다(멀티플레이 포기 = President 승인 사항).
 */
export function ConnBadge() {
  const { t } = useTranslation('common');
  const label = t('live');
  return (
    <span className="live" style={{ marginLeft: 4 }} title={label}>
      <i />
      {label}
    </span>
  );
}

/**
 * 파생 «정산» 피드 행.
 * ★거래 행과 구분: 상품 배지(선물/옵션/선도/스왑) + 게임일 표기.
 * ★강제 정리와 만기는 «다른 일»이라 문장을 가른다 — 같은 문장을 쓰면 거짓이 된다.
 */
function SettledFeedRow({ item }: { item: import('../lib/types').SettledLogItem }) {
  const { t } = useTranslation('home');
  const BADGE: Record<string, string> = {
    futures: 'pbadge--fut',
    option: 'pbadge--opt',
    forward: 'pbadge--fwd',
    swap: 'pbadge--swp',
  };
  const KEY: Record<string, string> = {
    futures: 'derivatives:pos.badgeFutures',
    option: 'derivatives:pos.badgeOption',
    forward: 'derivatives:pos.badgeForward',
    swap: 'derivatives:pos.badgeSwap',
  };
  return (
    <div className="macrorow">
      <span className={`pbadge ${BADGE[item.kind]}`} style={{ marginTop: 1, flex: '0 0 auto' }}>
        {t(KEY[item.kind])}
      </span>
      <span className="macrorow__text">
        <Trans
          i18nKey={item.forced ? 'home:feedSettledForced' : 'home:feedSettled'}
          values={{
            nickname: item.nickname,
            ticker: item.tickerB ? `${item.ticker} vs ${item.tickerB}` : item.ticker,
            v: signedMoney(item.pnl, 0),
          }}
          components={{ b: <b className={item.pnl >= 0 ? 'up' : 'down'} /> }}
        />
      </span>
      <span className="macrorow__when num">{t('macroFeedDay', { n: item.gameDay + 1 })}</span>
    </div>
  );
}

function FeedRow({ item }: { item: import('../lib/types').FeedItem }) {
  const { t } = useTranslation('home');
  const age = Math.max(0, Math.round((Date.now() - item.at) / 1000));
  /*
   * ★[□8 2026-08-20] 💥 📈 🐳 이모지 → 앱 자체 아이콘.
   *   ★이모지는 기기·OS 마다 다르게 그려진다. 같은 화면의 탭바·앱바가 «선 아이콘»인데
   *     피드만 이모지면 그 줄이 «다른 앱에서 붙여넣은 것»처럼 읽힌다.
   * ★색 의미도 바로잡았다: 청산은 «가격 방향»이 아니라 «경고»다.
   *   예전엔 --up-weak(국내 관례에서 «상승» 색)을 깔아 놓고 청산을 알리고 있었다.
   */
  const icon = item.kind === 'liquidation' ? Icon.warn : item.kind === 'gain' ? Icon.leverage : Icon.swap;
  const bg =
    item.kind === 'liquidation' ? 'var(--warn-weak)' : item.kind === 'gain' ? 'var(--up-weak)' : 'var(--surface-2)';
  const fg =
    item.kind === 'liquidation' ? 'var(--warn-ink)' : item.kind === 'gain' ? 'var(--up-ink)' : 'var(--t2)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
      <span
        style={{ width: 28, height: 28, borderRadius: '50%', background: bg, color: fg, display: 'grid', placeItems: 'center', flex: '0 0 auto' }}
        aria-hidden
      >
        {icon}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.4 }}>
        {item.kind === 'trade' && (
          <Trans
            i18nKey={item.side === 'buy' ? 'home:feedBought' : 'home:feedSold'}
            values={{ nickname: item.nickname, ticker: item.ticker, qty: item.qty }}
            components={{ b: <b /> }}
          />
        )}
        {item.kind === 'liquidation' && (
          <Trans
            i18nKey="home:feedLiquidated"
            values={{
              nickname: item.nickname,
              ticker: item.ticker,
              x: item.leverage,
              side: t(item.side === 'long' ? 'sideLong' : 'sideShort'),
            }}
            components={{ b: <b className="down" /> }}
          />
        )}
        {item.kind === 'gain' && (
          <Trans
            i18nKey="home:feedGain"
            values={{ nickname: item.nickname, ticker: item.ticker, pct: signedPct(item.pnlPct, 1) }}
            components={{ b: <b className="up" /> }}
          />
        )}
      </span>
      <span className="num" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', flex: '0 0 auto' }}>
        {age < 2 ? t('justNow') : t('secondsAgo', { n: age })}
      </span>
    </div>
  );
}
