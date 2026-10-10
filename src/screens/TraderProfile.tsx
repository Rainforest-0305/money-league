import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CONCEPT_BADGE, ConceptBadge } from '../components/ConceptBadge';
import { Icon, TickerTile } from '../components/Primitives';
import { CopyPortfolioSheet } from '../components/CopyPortfolioSheet';
import { AreaChart } from '../components/Charts';
import { AdBanner } from '../components/AdBanner';
import { useRewardAd } from '../components/RewardAd';
import { metaOf, useStore, useTick } from '../store/hooks';
import { bigMoney, money, msUntilKstMidnight, num, signedBigMoney, signedMoney, signedPct } from '../lib/format';
import { pnlFromEntry } from '../lib/rank';
import { TRADER_VIEW_DAILY_LIMIT, WATCHED_TRADERS_MAX } from '../lib/constants';
import type { PublicPortfolio } from '../lib/types';

/** 프로필에 그리는 보유 종목 상한 — 봇은 최대 69종목까지 들고 있다(실측) */
const TOP_HOLDINGS_SHOWN = 10;
import { botMeta } from '../lib/engine/roster';


/*
 * [2026-08-20] static Map -> botMeta() 교체 (Leaderboard 와 같은 이유).
 * 빌드 시점 210명 Map 으로는 런타임 합류 참가자의 배지·소개가 안 나온다.
 */

/**
 * 다른 참가자 프로필 — 목업 05-C.
 *
 * ── 2026-08-19 변경 (President 결정) ────────────────────────────────────
 * 예전에는 남의 포지션을 «아예 안 보여줬다»(`p = isMe ? portfolio : null`).
 * 그래서 「아직 공개 전」 문구만 있고 볼 게 없었다. 이제는 실제로 보여준다.
 *
 * ★단 «10분 이상 지연»된 스냅샷이다(gameWorld.publicPortfolio).
 *   1등 포지션을 실시간으로 베끼면 랭킹 경쟁이 무너지기 때문이다.
 *   총자산·수익률·자산곡선은 «지연하지 않는다» — 랭킹 화면에 이미 실시간으로
 *   떠 있는 값이라 여기서만 늦추면 두 화면이 서로 모순된다.
 *
 * ★열람은 하루 한도가 있다(TRADER_VIEW_DAILY_LIMIT). 같은 사람 재열람은
 *   세지 않는다 — 뒤로 갔다 다시 여는 건 유저 잘못이 아니다.
 */
export function TraderProfile() {
  const { id = '' } = useParams();
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { t, i18n } = useTranslation('rank');
  const ko = i18n.language !== 'en';

  const meId = s.myAccountId;
  const isMe = id === meId;
  // s.ranks 는 상위 컷이 아니라 전량(봇 210 + 나 1 = 211행)이라 여기서만 찾으면 된다.
  const entry = s.ranks.find((r) => r.accountId === id);
  const meta = entry?.isBot ? botMeta(entry.accountId) : undefined;
  const conceptBadge = meta ? CONCEPT_BADGE[meta.concept] : undefined;
  const curve = s.equityByAccount.get(id) ?? [];

  /*
   * 열람권 판정.
   * ★렌더 «중»에 소비하지 않는다(렌더 도중 store.bump() 를 부르면 React 가
   *   경고를 내고 리렌더 루프가 될 수 있다). 판정은 순수 조회로 하고,
   *   실제 차감은 아래 useEffect 에서 한 번만 한다.
   */
  const watched = s.isWatchedTrader(id);
  const alreadyViewed = s.hasViewedTrader(id);
  const viewsLeft = s.daily?.viewsLeft ?? TRADER_VIEW_DAILY_LIMIT;
  const allowed = isMe || alreadyViewed || viewsLeft > 0;

  /*
   * ★탑100 «밖» 참가자도 자산 곡선을 볼 수 있게 «이 계정만» 추적 대상에 넣는다.
   *   store 는 명부 전원이 아니라 (탑100 + 나 + 이 계정)만 곡선을 유지한다 —
   *   1,000~3,310명 명부에서 곡선 유지 비용을 «명부 크기와 무관»하게 만드는 장치다.
   */
  useEffect(() => {
    s.watchAccount(id);
    return () => s.watchAccount(null);
  }, [id, s]);

  const consumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!allowed || isMe) return;
    if (consumedFor.current === id) return;
    consumedFor.current = id;
    s.openTraderView(id);
  }, [allowed, id, isMe, s]);

  const ad = useRewardAd('view');
  const adRoom = Math.max(0, (s.daily?.viewBonusMax ?? 0) - (s.daily?.viewBonus ?? 0));
  const canWatchAd = ad.supported && adRoom > 0;
  const [copyOpen, setCopyOpen] = useState(false);

  /** 남의 것은 지연 스냅샷, 내 것은 실데이터 */
  const pub = useMemo(() => (isMe ? null : s.publicPortfolioOf(id)), [isMe, id, s]);
  const mine = isMe ? s.portfolio : null;
  const agoMin = pub ? Math.max(10, Math.round((Date.now() - pub.asOf) / 60000)) : 0;

  if (!entry) {
    return (
      <div className="screen" style={{ background: 'var(--bg)' }}>
        <div className="appbar">
          <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:back')}>
            {Icon.back}
          </button>
          <span className="appbar__title">{t('profileTitle')}</span>
        </div>
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--t3)' }}>{t('common:empty')}</div>
      </div>
    );
  }

  /* ── 열람권 소진 ──────────────────────────────────────────────────
     ★막다른 골목을 만들지 않는다: 광고(선택) + 리셋까지 남은 시간 + 돌아가기.
        광고가 «안 되는» 환경(웹 브라우저·구버전)에서도 나갈 문이 항상 있다. */
  if (!allowed) {
    const untilReset = msUntilKstMidnight();
    const h = Math.floor(untilReset / 3600000);
    const mn = Math.floor((untilReset % 3600000) / 60000);
    return (
      <div className="screen" style={{ background: 'var(--bg)' }}>
        <div className="appbar">
          <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:back')}>
            {Icon.back}
          </button>
          <span className="appbar__title">{t('profileTitle')}</span>
        </div>
        <div className="scroll" style={{ padding: '18px var(--gutter) 0' }}>
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <div style={{ display: 'grid', placeItems: 'center', color: 'var(--brand)' }} aria-hidden>
              {Icon.eye(46)}
            </div>
            <h2 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 14, lineHeight: 1.32, whiteSpace: 'pre-line' }}>
              {t('viewsTitle')}
            </h2>
            <p style={{ fontSize: 15, color: 'var(--t3)', marginTop: 10, lineHeight: 1.55, whiteSpace: 'pre-line' }}>
              {t('viewsSub', { n: TRADER_VIEW_DAILY_LIMIT })}
            </p>
          </div>
          <div className="card" style={{ marginTop: 22, padding: 18, textAlign: 'center' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}>{t('recharge:untilReset')}</div>
            <div className="num" style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 4 }}>
              {t('recharge:hoursMinutes', { h, m: String(mn).padStart(2, '0') })}
            </div>
          </div>
        </div>
        <div className="cta">
          {canWatchAd ? (
            <button className="btn btn--gold" disabled={ad.busy} onClick={() => void ad.run()}>
              {t('viewsAdCta', { n: adRoom })}
              <span className="btn__sub">{ad.busy ? t('common:loading') : t('recharge:adCtaSub')}</span>
            </button>
          ) : (
            <button className="btn btn--off" disabled>
              {t('viewsAdNone')}
            </button>
          )}
          <button className="btn btn--ghost" onClick={() => nav('/rank')}>
            {t('viewsBack')}
          </button>
        </div>
      </div>
    );
  }

  /*
   * 손익금액은 «그 계정의 시드» 기준이다. `equity - SEED_CASH`(1만 고정) 로 하면
   * 시드 200만인 웨일이 "+$2,149,276 (+8.0%)" 처럼 금액과 퍼센트가 서로 모순됐다.
   * pnlFromEntry 는 pnlPct 의 분모(계정별 시드)를 역산해 맞춘다 — 실측으로 seedCash 와 일치.
   */
  const pnl = pnlFromEntry(entry);
  const allHoldings = isMe ? (mine?.holdings ?? []) : (pub?.holdings ?? []);
  const levs = isMe ? (mine?.leverage ?? []) : (pub?.leverage ?? []);
  /*
   * ★상위 N개만 그린다. 봇은 종목을 69개까지 들고 있다(실측) — 전부 그리면
   *   프로필 한 장에 70행이 깔려 스크롤이 5,000px 를 넘고 그만큼 DOM·페인트가 는다.
   *   「누가 무엇을 크게 들고 있나」가 이 화면의 목적이라 평가금액 상위만 보이면 된다.
   */
  const holdings = [...allHoldings]
    .sort((a, b) => b.qty * s.priceOf(b.ticker) - a.qty * s.priceOf(a.ticker))
    .slice(0, TOP_HOLDINGS_SHOWN);
  const restCount = Math.max(0, allHoldings.length - holdings.length);
  const tradeCount = isMe ? mine?.tradeCount : pub?.tradeCount;
  const liqCount = isMe ? mine?.liquidationCount : pub?.liquidationCount;

  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('common:back')}>
          {Icon.back}
        </button>
        <span className="appbar__title">{t('profileTitle')}</span>
        {/* ★잔여 열람권은 «열기 전»에도 보여야 하지만, 열고 나서도 계속 보인다.
            9명째에 갑자기 막히는 일이 없게 하는 게 목적이다. */}
        {!isMe && (
          <span
            className="num"
            style={{
              marginLeft: 'auto',
              flex: '0 0 auto',
              fontSize: 12,
              color: 'var(--t3)',
              whiteSpace: 'nowrap',
            }}
          >
            {/* ★랭킹 탭 칩과 «같은 문구»를 쓴다. 화면마다 다른 이름으로 부르면
                유저는 그게 같은 자원인지 모른다(「재열람 무료」만 뜨던 예전 상태의 문제). */}
            {t('viewsChip', { n: viewsLeft })}
          </span>
        )}
      </div>

      <div className="scroll">
        <div style={{ textAlign: 'center', padding: '8px 20px 0' }}>
          <span
            className="av"
            style={{
              width: 70,
              height: 70,
              margin: '0 auto',
              fontSize: 24,
              background: entry.rank === 1 ? 'linear-gradient(140deg, var(--gold), var(--gold-2))' : 'var(--brand)',
              /* 여기 있던 금색 글로우는 Leaderboard 와 같은 이유로 이미 제거돼 있다 */
            }}
            aria-hidden
          >
            {entry.nickname.slice(0, 1)}
          </span>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 12, letterSpacing: '-0.02em' }}>{entry.nickname}</div>
          {/*
            [「봇」 배지 제거 — President 지시 2026-08-18]
            ★ 배지가 하나도 없을 때는 컨테이너 자체를 «렌더하지 않는다» — 빈 flex 박스만
              남기면 marginTop:8 만큼 간격이 벌어져 화면마다 정렬이 달라진다.
          */}
          {/*
            ★예전에는 whale·derivatives_heavy «두 종만» 배지가 있었다(나머지 3종은 랭킹 행에만).
              콘셉트가 13종이 된 지금은 «있는 콘셉트를 그대로» 보여준다.
            ★배지가 하나도 없을 때는 컨테이너 자체를 렌더하지 않는다 — 빈 flex 박스만 남기면
              marginTop:8 만큼 간격이 벌어져 화면마다 정렬이 달라진다.
          */}
          {(entry.rank === 1 || conceptBadge || isMe) && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              {entry.rank === 1 && (
                <span className="badge badge--gold" style={{ fontSize: 11, padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {Icon.crown(12)} {t('rank1')}
                </span>
              )}
              {conceptBadge && meta && <ConceptBadge strategy={meta.concept} i18nKey={meta.i18nKey} size="lg" />}
              {isMe && <span className="badge badge--brand" style={{ fontSize: 11, padding: '4px 9px' }}>{t('meBadge')}</span>}
            </div>
          )}
          {/* ★한 줄 소개 — 「이 사람이 어떻게 굴리는지」를 열람권 값어치로 만드는 문장이다 */}
          {meta && (
            <p style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>
              {t(`common:${meta.i18nKey}.oneLiner`)}
            </p>
          )}
          <div className="num" style={{ fontSize: 32, fontWeight: 800, marginTop: 16, letterSpacing: '-0.04em' }}>
            {bigMoney(entry.equity)}
          </div>
          <div className={`num ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15, fontWeight: 800 }}>
            {signedBigMoney(pnl)} ({signedPct(entry.pnlPct)})
          </div>
        </div>

        {/* 자산 곡선 — 지연 대상이 아니다(랭킹과 같은 실시간 값) */}
        <div style={{ padding: '18px 20px 0' }}>
          <div className="card" style={{ padding: '14px 0 8px' }}>
            {curve.length > 1 ? (
              <AreaChart data={curve} height={90} showDot={false} />
            ) : (
              <div style={{ height: 90, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--t3)' }}>
                {t('common:loading')}…
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 16px 0', fontSize: 11, color: 'var(--t3)' }}>
              <span>{t('observed')}</span>
              <span className="num">{t('nowValue', { v: bigMoney(entry.equity, 0) })}</span>
            </div>
          </div>
        </div>

        {/* 3분할 스탯 — 남의 것은 지연 스냅샷 값이다 */}
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <StatCard label={t('statTrades')} value={tradeCount !== undefined ? t('countTimes', { n: num(tradeCount) }) : t('unknown')} />
            {/* ★ 가운데 칸은 예전에 「승률」이었는데 계산식이
                `(realizedPnl > 0 ? 1 : 0) * 100` 이라 항상 0% 아니면 100% 였다.
                실제 승률 데이터가 없으므로 «있는 값»인 보유 종목 수로 바꾼다.
                없는 지표를 만들어 내지 않는다. */}
            <StatCard label={t('statHoldings')} value={t('countItems', { n: num(allHoldings.length + levs.length) })} />
            <StatCard label={t('statLiq')} value={liqCount !== undefined ? t('countTimes', { n: num(liqCount) }) : t('unknown')} />
          </div>
        </div>

        {/* 보유 종목 — ★남의 것은 10분 이상 지연 */}
        <div style={{ padding: '20px 20px 0' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
            <span style={{ fontSize: 17, fontWeight: 800 }}>{t('holdingNow')}</span>
            {!isMe && pub && (
              <span className="badge badge--weak" style={{ flex: '0 0 auto' }}>
                {t('asOfAgo', { n: agoMin })}
              </span>
            )}
          </div>
          {holdings.length > 0 || levs.length > 0 ? (
            <div className="card card--list">
              {holdings.map((h, i) => {
                const m = metaOf(h.ticker);
                const price = s.priceOf(h.ticker);
                const gain = (price - h.avgCost) * h.qty;
                return (
                  <div key={h.ticker}>
                    {i > 0 && <div className="divider" style={{ marginLeft: 53 }} />}
                    <div className="rk" style={{ padding: '12px 16px' }}>
                      <TickerTile meta={m} size="sm" />
                      <span>
                        <span className="rk__nm" style={{ display: 'block' }}>
                          {ko ? m.nameKo : m.nameEn}
                        </span>
                        <span className="rk__bd">{t('common:shares', { count: Math.round(h.qty) })}</span>
                      </span>
                      <span className="rk__rt">
                        <span className={`rk__a num ${gain >= 0 ? 'up' : 'down'}`}>{signedMoney(gain)}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
              {levs.map((lv, i) => {
                const m = metaOf(lv.ticker);
                return (
                  <div key={`lev-${lv.ticker}-${i}`}>
                    <div className="divider" style={{ marginLeft: 53 }} />
                    <div className="rk" style={{ padding: '12px 16px' }}>
                      <TickerTile meta={m} size="sm" />
                      <span>
                        <span className="rk__nm" style={{ display: 'block' }}>
                          {ko ? m.nameKo : m.nameEn}
                        </span>
                        <span className="rk__bd">
                          <span className={`badge ${lv.side === 'long' ? 'badge--up' : 'badge--down'}`}>
                            {lv.side === 'long'
                              ? t('derivatives:longX', { x: lv.leverage })
                              : t('derivatives:shortX', { x: lv.leverage })}
                          </span>
                          {t('derivatives:marginLabel', { v: money(lv.margin, 0) })}
                        </span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="card card--pad" style={{ fontSize: 12, color: 'var(--t3)' }}>{t('common:empty')}</div>
          )}
          {restCount > 0 && (
            <p className="hint" style={{ marginTop: 8, textAlign: 'center' }}>
              {t('holdingsMore', { n: restCount })}
            </p>
          )}
          {!isMe && (
            <p className="hint" style={{ marginTop: 10 }}>
              {t('delayNote')}
            </p>
          )}
          {/*
            ★「포트폴리오 복사하기」 (President 지시 2026-08-30) — 타인 프로필 · 열람이 «이미 된» 상태에서만(여기까지 왔으면 된 것이다).
              주행동이라 .btn--primary. 누르면 시트(방식 2택 → 미리보기 → 실행 → 결과).
              ★계산·실행은 lib/copyPortfolio + store.copyPortfolio — 화면은 열고 닫기만.
              ★현금이 0 이고 정리해서 만들 돈도 없으면 «죽은 버튼»을 두지 않고 사유를 적는다.
          */}
          {!isMe && pub && (
            <CopyButton pub={pub} via={entry.nickname} onOpen={() => setCopyOpen(true)} />
          )}
        </div>

        {/*
          광고 — ★탭 가능한 게임 요소(보유 종목 카드)와 «떨어뜨려» 배치한다.
            주문 버튼이 없는 화면이라 오탭이 돈으로 이어지지 않는 자리다.
          ★[게이트 추가 2026-08-20] 보유가 적은 참가자는 이 화면이 «짧다» —
            실측: 표시 행이 적을 때 배너 top=676 · 보이는 높이 790 ⇒ ★첫 화면 안이었다.
            그래서 «표시 행 4개 이상»일 때만 그린다. 적은 참가자에겐 아예 안 뜬다.
        */}
        {/*
          ⚠★[2026-08-21 실렌더로 잡은 결함] 예전에는 `<div style={{ padding: '18px 20px 0' }}>` 로
            «감싸고» 있었다. `AdBanner` 는 토스 밖에서 null 을 돌려주는데 ★래퍼는 남는다 —
            그리고 padding 은 마진 상쇄로 사라지지도 않는다. 실측: 광고 없음 상태에서
            높이 18px 짜리 «빈 상자»가 그대로 남아 있었다(유령 여백).
          ⇒ 래퍼를 없애고 여백을 `AdBanner` 자신에게 준다. 광고가 없으면 여백도 «같이» 사라진다.
            (좌우 20 = `.sec` 의 --gutter 와 같은 값이라 보이는 결과는 그대로다)
        */}
        {holdings.length + levs.length >= 4 && (
          <AdBanner slot="bannerTraderProfile" style={{ margin: '18px 20px 0' }} />
        )}

        {/*
          ★[가짜 버튼 수정 2026-08-20] 「관심 참가자로 등록」이 실제로는 `nav('/rank')` 였다.
            누르면 관심에 담기는 게 «아니라» 그냥 랭킹으로 돌아갔다 — 라벨이 약속한 일을
            아무것도 하지 않는 버튼이었다. 이제 진짜로 담고/빼고, 담은 뒤엔 어디서 보는지 알려준다.
          ★열람권과의 관계: 담는 것도, 관심 목록을 «보는» 것도 무료다.
            열람권은 포트폴리오를 «여는» 순간에만 나간다(지금 이 화면에 들어올 때 이미 나갔다).
        */}
        {!isMe && (
          <div style={{ padding: '10px 20px 26px' }}>
            {/*
              ★담기 «전»과 «후»의 다음 행동이 다르다. 그래서 위계도 바뀐다:
                - 담기 전: 주행동 = 담기.               보조 = 어디서 보는지 알려주는 한 줄
                - 담은 후: 주행동 = 관심 목록 가서 보기. 보조 = 빼기
              ⛔둘 다 같은 회색 버튼으로 쌓아 두면 「무엇을 눌러야 하나」가 사라진다.
            */}
            {watched ? (
              <>
                <button
                  type="button"
                  className="btn btn--sub"
                  style={{ padding: 13, fontSize: 15 }}
                  onClick={() => nav('/rank?scope=watch')}
                >
                  {t('watchGoList')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ marginTop: 4, padding: 12, fontSize: 12 }}
                  aria-pressed
                  onClick={() => {
                    s.toggleWatchedTrader(id);
                    s.pushToast(t('watchRemoved'));
                  }}
                >
                  {t('watchRemove')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--sub"
                  style={{ padding: 13, fontSize: 15 }}
                  aria-pressed={false}
                  onClick={() => {
                    const r = s.toggleWatchedTrader(id);
                    if (r === 'full') s.pushToast(t('watchFull', { n: WATCHED_TRADERS_MAX }), 'error');
                    else s.pushToast(t('watchAdded'));
                  }}
                >
                  {t('watchAdd')}
                </button>
                <p className="hint" style={{ marginTop: 8, textAlign: 'center' }}>
                  {t('watchAddSub')}
                </p>
              </>
            )}
          </div>
        )}
      </div>
      {copyOpen && pub && <CopyPortfolioSheet via={entry.nickname} pub={pub} onClose={() => setCopyOpen(false)} />}
    </div>
  );
}

/** 복사 버튼 — 현금 0 + 정리할 것 0 이면 비활성 + 사유 */
function CopyButton({ pub, via, onOpen }: { pub: PublicPortfolio; via: string; onOpen: () => void }) {
  const s = useStore();
  const { t } = useTranslation('rank');
  const p = s.portfolio;
  const cash = p?.cash ?? 0;
  const haveSomething =
    (p?.holdings.length ?? 0) + (p?.leverage.length ?? 0) + (p?.options.length ?? 0) + s.forwards.length + s.swaps.length > 0;
  const nothingToCopy = pub.holdings.length + pub.leverage.length === 0;
  const disabled = nothingToCopy || (cash < 1 && !haveSomething);
  return (
    <div style={{ marginTop: 14 }}>
      <button type="button" className="btn btn--primary cpbtn" disabled={disabled} onClick={onOpen}>
        {t('copyBtn')}
      </button>
      <p className="hint" style={{ marginTop: 6, textAlign: 'center' }}>
        {nothingToCopy ? t('copyEmpty') : cash < 1 && !haveSomething ? t('copyBtnNoCash') : t('copyBtnSub', { name: via })}
      </p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ flex: 1, padding: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{label}</div>
      <div className="num" style={{ fontSize: 17, fontWeight: 800, marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}
