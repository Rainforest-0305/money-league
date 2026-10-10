import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CONCEPT_BADGE, ConceptBadge } from '../components/ConceptBadge';
import { ConnBadge } from './Home';
import { AdBanner } from '../components/AdBanner';
import { Icon, Segment, Sheet } from '../components/Primitives';
import { useRewardAd } from '../components/RewardAd';
import { metaOf, useStore } from '../store/hooks';
import { bigMoney, money, msUntilKstMidnight, signedMoney, signedPct } from '../lib/format';
import { myRankAxes, type MyRankAxes } from '../lib/rank';
import {
  LEADERBOARD_SIZE,
  SEED_CASH,
  TRADER_VIEW_DAILY_LIMIT,
  TRADER_VIEW_WARN_AT,
  WATCHED_TRADERS_MAX,
} from '../lib/constants';
import { botMeta } from '../lib/engine/roster';
import type { RankEntry } from '../lib/types';

type Sort = 'equity' | 'return';
/** 목록 범위 — 전체 랭킹 / 내가 관심 준 참가자만 */
type Scope = 'all' | 'watch';

/** 광고를 끼우는 위치(4위부터 세어 N행 뒤). 첫 화면 844px 밖에 놓기 위한 값 */
const AD_AFTER_ROWS = 8;

/**
 * 시즌 — ★[2026-08-29] «표시 전용 카운트다운»에서 «실제 마감»으로 바뀌었다.
 *   마감 시각은 store.season(lib/season.ts · 저장키 ml.season)이 정본이다. 여기서는 «읽기만» 한다.
 *   옛 7일 경계식은 season.ts 로 옮겨졌고 키가 없을 때의 기본값이라 카운트다운은 «그대로» 이어진다.
 * ★시즌 «번호»는 여전히 화면에 없다(2026-08-21 판단 유지) — 「이번 시즌」이라는 «기간»만 말한다.
 * ★1일 미만이면 「N일 M시간」이 아니라 「M시간 K분」으로 말한다 — 「0일 2시간」은 문장이 아니다.
 */
function seasonRemain(remainMs: number) {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  return {
    d: Math.floor(remainMs / day),
    h: Math.floor((remainMs % day) / hour),
    m: Math.floor((remainMs % hour) / 60000),
  };
}

/*
 * [2026-08-20] static Map -> botMeta() 조회로 교체.
 *
 * ★예전: `new Map(BOTS.map(...))` — «빌드 시점에 고정된 210명»만 들어 있었다.
 *   명부가 런타임에 늘어나는 지금(신규 참가자 합류) 그 Map 에 없는 계정은
 *   배지가 통째로 사라진다. 그래서 조회는 반드시 roster 의 botMeta() 를 거친다.
 * ★기존 교훈은 그대로 유효하다 — 조회 키는 «닉네임이 아니라 accountId(=botId)» 다.
 *   닉네임 키였을 때, 온보딩 추천 닉 12개 중 5개가 봇 닉과 완전히 같아서
 *   유저가 앱이 추천한 이름을 고르면 «자기 자신»에게 전략 배지가 붙었다.
 * ★botMeta() 가 undefined 를 돌려줄 수 있다(로스터에 없는 계정·플레이어).
 *   그때는 배지를 그리지 않고 부제를 「참가자」로 폴백한다 — 행 높이가 무너지지 않게.
 */

const AVATAR_COLORS = ['#4E5968', '#6B4EFF', '#0F8A5F', '#C0392B', '#E67E22', '#2C3E50', '#16A085', '#8E44AD', '#2980B9', '#7F8C8D'];
function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Leaderboard() {
  const s = useStore();
  const nav = useNavigate();
  const { t } = useTranslation('rank');
  const [sort, setSort] = useState<Sort>('equity');
  /*
   * ★범위는 URL 로도 들어온다 — 프로필에서 「관심에 담김 · 목록 보기」로 넘어올 때
   *   `#/rank?scope=watch` 로 온다(홈 → `#/stocks?own=1` 과 같은 규칙).
   *   HashRouter 라 쿼리는 해시 뒤에 붙고 useLocation().search 로 그대로 읽힌다.
   */
  const loc = useLocation();
  const [scope, setScope] = useState<Scope>(() =>
    new URLSearchParams(loc.search).get('scope') === 'watch' ? 'watch' : 'all'
  );
  /*
   * ★useState 초기값만으로는 부족하다 — 이미 이 화면에 «있는 상태»에서 `/rank?scope=watch` 로
   *   오면 컴포넌트가 다시 마운트되지 않아 초기값이 «안 돌고» 탭이 안 바뀐다
   *   (실측: 같은 경로 + 쿼리만 다른 이동은 same-document navigation 이라 리마운트가 없다).
   * ★지금은 프로필(다른 라우트)에서만 들어오지만, 그 전제가 깨지면 «가짜 링크»가 하나 더 생긴다.
   *   전제에 기대지 말고 URL 을 정본으로 따라간다.
   */
  useEffect(() => {
    setScope(new URLSearchParams(loc.search).get('scope') === 'watch' ? 'watch' : 'all');
  }, [loc.search]);
  const viewsLeft = s.daily?.viewsLeft ?? TRADER_VIEW_DAILY_LIMIT;
  /*
   * ★열람권 설명 패널의 «기본 열림» 조건.
   *   President 가 새 빌드를 쓰면서도 「조회권 반영 왜 안 해?」라고 했다 =
   *   기능이 있는데 «안 보였다». 그래서 오늘 아직 한 명도 안 연 상태에서는
   *   설명을 펼쳐 둔다 — 한 명이라도 열면 스스로 접힌다(영구 노출은 소음이다).
   *   ⛔새 저장 키를 만들지 않는다. 판단 근거는 이미 저장되는 daily.viewsUsed 다.
   */
  const [infoOverride, setInfoOverride] = useState<boolean | null>(null);
  const infoOpen = infoOverride ?? (s.daily?.viewsUsed ?? 0) === 0;

  /* ★틱마다 갱신되는 스토어 버전을 타므로 «분» 단위 카운트다운이 저절로 산다 */
  const sn = seasonRemain(s.seasonRemainMs);
  const meId = s.myAccountId;
  const [cbOpen, setCbOpen] = useState(false);

  /*
   * [실유저 전용 탭 제거 — Partner 판정 2026-08-05]
   * 정적 단독 빌드에는 실유저가 나 하나뿐이라 «사람만» 탭은 항상 "1명 중 1위" 였다.
   * 멀티플레이 제거의 파생 손실로 기록하고 UI 를 뺀다(ARCHITECTURE 8장 「실유저 랭킹 별도 노출」).
   * 봇 포함 전체 랭킹은 요건 #15 그대로 유지한다.
   */
  const rows = useMemo(() => {
    /* ★[성능 2026-08-30] 자산순은 스토어 배열 «그대로» 쓴다(rank 가 이미 맞다) — 10,000행 복사 + spread 를 없앤다.
       수익률순만 정렬본을 만든다(순위 번호 = 정렬 뒤 자리). ⛔rows 를 어디서도 «변형»하지 않는다(읽기 전용). */
    if (sort === 'equity') return s.ranks;
    const sorted = [...s.ranks].sort((a, b) => b.pnlPct - a.pnlPct);
    return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [s.ranks, sort]);

  /*
   * 관심 참가자 — ★Set 으로 들고 다닌다.
   *   배열 includes 로 하면 (명부 3,310 × 관심 20) 회 비교를 4초마다 돈다.
   *   Set.has 면 명부 크기에 선형이고 관심 수와 무관해진다.
   */
  const watchSet = useMemo(() => new Set(s.watchedTraders), [s.watchedTraders]);
  const watchRows = useMemo(
    () => (watchSet.size === 0 ? [] : rows.filter((r) => watchSet.has(r.accountId))),
    [rows, watchSet]
  );

  /** 하단 «내 순위» 바 — 정렬 칩과 무관하게 항상 자산·수익률 두 축 (lib/rank.ts 주석 참조) */
  const axes = useMemo(() => myRankAxes(s.ranks, meId), [s.ranks, meId]);
  /** «얼마 더 벌면» 문구는 금액 차이라서 자산 기준 바로 위 계정으로 고정한다(수익률순 정렬과 섞지 않는다) */
  const above = useMemo(() => {
    const i = s.ranks.findIndex((r) => r.accountId === meId);
    return i > 0 ? s.ranks[i - 1] : null;
  }, [s.ranks, meId]);

  /* ★[성능 2026-08-30] 스토어는 매 틱 bump 하므로 이 화면은 2초마다 렌더된다 — 10,000행 find/findIndex 2회를
     «틱마다» 돌리지 않고 rows 가 바뀔 때(≈4초)만 돈다. */
  const { me, meIdx, near } = useMemo(() => {
    const i = rows.findIndex((r) => r.accountId === meId);
    return { me: i >= 0 ? rows[i] : null, meIdx: i, near: i >= 0 ? rows.slice(Math.max(0, i - 2), i + 3) : [] };
  }, [rows, meId]);
  const top3 = rows.slice(0, 3);
  /*
   * 요건 #15 «탑 100 플레이어 자산평가액 대시보드» — 포디움 3 + 이하 97 = 100행.
   * 이전 구현은 `rows.slice(3, 30)` 하드코딩이라 30행만 그렸다(서버는 100명을 주는데
   * 화면이 30행만 그린 요건 미준수). 숫자를 다시 박지 않고 constants 의
   * LEADERBOARD_SIZE(=100, 선언만 돼 있고 참조 0건이었다) 를 실제로 배선한다.
   * 정렬은 자산평가액 내림차순 그대로다.
   */
  const list = rows.slice(3, LEADERBOARD_SIZE);

  /** memo(RankRow) 가 실제로 먹히도록 콜백 아이덴티티를 고정한다(아래 RankRow 주석 참조) */
  const openTrader = useCallback((accountId: string) => nav(`/trader/${accountId}`), [nav]);
  /**
   * 관심 토글 — ★상한에 걸리면 «조용히» 넘기지 않는다.
   *   눌렀는데 아무 일도 안 일어나면 그건 유저에게 «고장난 버튼»이다.
   */
  const toggleWatch = useCallback(
    (accountId: string) => {
      const r = s.toggleWatchedTrader(accountId);
      if (r === 'full') s.pushToast(t('watchFull', { n: WATCHED_TRADERS_MAX }), 'error');
    },
    [s, t]
  );

  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar">
        <span className="appbar__big">{t('title')}</span>
        <ConnBadge />
      </div>

      <div className="scroll">
        {/*
          [교체 2026-08-20] 오른쪽 끝 회색 배지 → 아래 «상단 고정 바»(.rkbar).
          ★왜 바꿨나: 그 배지는 «있었지만 안 보였다». President 가 새 빌드를 쓰면서도
            「조회권 반영 왜 안 해?」라고 물었다 = 발견 실패다. 원인 3개를 전부 뒤집는다:
              (1) 스크롤과 함께 사라졌다 → 고정한다
              (2) 회색 --t3 10.5px 오른쪽 끝 = 「부가 정보」 위치와 색 → 눌리는 칩으로 올린다
              (3) 「오늘 8명 더 볼 수 있어요」는 «무엇을» 볼 수 있는지 안 적혀 있었다
                  → 「포트폴리오 열람권」이라는 이름을 화면에 띄운다
        */}

        {/*
          시즌 안내 — ★[팔레트 2026-08-20] 전폭 «포화 보라 블록» → 카드 + 아이콘 타일.

          ★왜: 이건 «알림»이지 «행동»이 아니다. impeccable product 레지스터는 액센트를
            «주요 행동 · 현재 선택 · 상태 표시»에만 쓰라고 못박는다 — 장식이 아니라.
            시즌 남은 시간은 그중 어디에도 해당하지 않는데 화면에서 가장 강한 색을 갖고 있었다.
          ★어떻게: 설정 화면이 이미 쓰는 «아이콘 타일 + 제목 + 부제» 문법을 그대로 재사용한다.
            새 문법을 만들지 않는다 — 화면마다 다른 문법이 «가장 흔한 제품 UI 실패»다.
          ★보라는 남는다: 타일 배경(--brand-weak)에. 면적만 22px 아이콘 칸으로 줄었다.
        */}
        {/* ★[간격 2026-08-29] 아래 여백 14 → --gap-block(16). 이 화면의 세로 리듬을 8pt 격자에 올린다 */}
        <div style={{ padding: '0 var(--gutter) var(--gap-block)' }}>
          <div className="card card--pad" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                flex: '0 0 auto',
                width: 36,
                height: 36,
                borderRadius: 12,
                background: 'var(--brand-weak)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--brand-ink)',
              }}
              aria-hidden
            >
              {Icon.trophy}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>
                {t('seasonBanner', {
                  time: sn.d > 0 ? t('seasonTime', { d: sn.d, h: sn.h }) : t('seasonTimeHours', { h: sn.h, m: sn.m }),
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, lineHeight: 1.5 }}>{t('seasonSub', { v: money(SEED_CASH, 0) })}</div>
            </div>
          </div>
        </div>

        {/*
          ★상단 고정 바 — 이 탭에서 «스크롤 중에도 계속 필요한» 두 가지만 담는다.
            (1) 목록 범위(전체 | 관심)  (2) 남은 포트폴리오 열람권
          ★왜 고정인가: 100행을 내리는 동안 아무 행이나 누르면 열람권이 1장 나간다.
            잔여가 화면 밖으로 사라지면 「9명째에 갑자기 막히는」 사고가 된다.
          ⛔blur·backdrop-filter 금지 — 단색 --bg 로 덮는다(광고·차트와 GPU 를 공유한다).
        */}
        <div className="rkbar">
          {/* ★세그먼트는 «내용 폭»만 차지한다. flex:1 로 늘리면 오른쪽 칩과 맞닿아
              「전체 | 관심 | 열람권」 3탭으로 읽힌다(실렌더에서 확인하고 되돌린 것). */}
          <div style={{ flex: '0 1 auto', minWidth: 0 }}>
            <Segment<Scope>
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: t('scopeAll') },
                { value: 'watch', label: watchSet.size > 0 ? t('scopeWatchN', { n: watchSet.size }) : t('scopeWatch') },
              ]}
            />
          </div>
          <button
            type="button"
            className={`viewchip ${viewsLeft <= TRADER_VIEW_WARN_AT ? 'is-low' : ''}`}
            aria-expanded={infoOpen}
            onClick={() => setInfoOverride(!infoOpen)}
          >
            {viewsLeft > 0 ? t('viewsChip', { n: viewsLeft }) : t('viewsChipNone')}
          </button>
        </div>

        {infoOpen && <ViewPassPanel onClose={() => setInfoOverride(false)} />}

        {/*
          ★[간격 2026-08-29 · President 지적] 「자산순/수익률순 토글이랑 위아래 사이 간격이 너무 좁지 않아?」
          [수정 전 실측 · 라이브 -16 · scripts/verify_wrap.py] 열람권 패널 카드 → 토글 24 · ★토글 → 포디움 상자 12
            (패널을 닫으면 rkbar 헤어라인 → 토글이 ★9px = 8 + 1). ⇒ 토글이 아래 포디움과 «같은 덩어리»로
            붙어 있고, 패널을 닫으면 위 바에도 붙는다 — 다른 컨트롤인데 어느 쪽에도 «자기 자리»가 없었다.
          [수정 후 실측] 패널 카드 → 토글 24(그대로) · 토글 → 중앙은행 카드 16 · 카드 → 포디움 상자 16
            (패널을 닫으면 헤어라인 → 토글 25). 위 16(--gap-block) · 아래 16 — 토글은 «아래 목록의 것»이고
            중앙은행 카드가 사이에서 «시장 배경»으로 읽힌다. 열람권 패널이 열렸을 때 패널 아래 8 + 16 = 24 =
            --gap-section 이라 «섹션 경계»가 그대로 선다.
        */}
        <div className="pillrow" style={{ paddingTop: 'var(--gap-block)', paddingBottom: 'var(--gap-block)' }}>
          <button
            className={`pill pill--ink ${sort === 'equity' ? 'pill--on' : ''}`}
            aria-pressed={sort === 'equity'}
            onClick={() => setSort('equity')}
          >
            {t('sortEquity')}
          </button>
          <button
            className={`pill pill--ink ${sort === 'return' ? 'pill--on' : ''}`}
            aria-pressed={sort === 'return'}
            onClick={() => setSort('return')}
          >
            {t('sortReturn')}
          </button>
        </div>

        {/*
          ★★중앙은행 카드 (2026-08-29 President 지시 「순위표에서 중앙은행의 포지션 및 거래 기록을 확인할 수 있게」).
          ★«순위 행»이 아니다 — 순번·자산·수익률이 «없다»(자산 무제한). 재질도 다르다(--surface-2 · 아이콘 타일).
            포디움 «위», 토글 «아래»에 둔 이유: 랭킹 맨 아래(100행 뒤)는 아무도 못 보고, 포디움 위에
            «행처럼» 두면 0위로 읽힌다. 기관 «띠» 하나가 정답이다 — 랭킹의 일부가 아니라 «시장의 배경»으로 읽힌다.
          ★「관심」 범위에서는 안 그린다 — 내가 고른 참가자 목록에 기관이 낄 이유가 없다.
          ★탭 → 시트: 역할 소개(3문장) · 지수 괴리 · 현재 포지션 · 최근 체결.
        */}
        {scope === 'all' && <CentralBankCard onOpen={() => setCbOpen(true)} />}

        {/*
          [봇 안내 카드 제거 — President 결정 2026-08-18]
          「전체 랭킹에는 봇 트레이더 210명이 함께 있어요…」 카드를 «DOM 에서» 뺐다.
          ★자리도 같이 뺐다: 카드가 갖고 있던 여백(margin: 0 20px 12px)은 «카드 자신의»
            인라인 스타일이라 요소를 지우면 12px 아래여백까지 함께 사라진다. 위쪽 간격은
            .pillrow 의 paddingBottom:12 가 그대로 담당하므로 새로 채울 여백이 없다.
            실측(390x844): 포디움 top 254.59 -> 181.09, 4위 행 top 506.97 -> 433.47 (ko)
                           포디움 top 273.34 -> 181.09, 4위 행 top 525.72 -> 433.47 (en)
          ⚠️이 카드는 「210명이 AI」임을 알리는 앱 내 «유일한» 고지였다. 이 빌드는
            로그인·서버가 없어 실제 사람과 겨룰 수 없는 오프라인 단독 실행이며,
            제거는 President 결정이다(venture-frontend 가 임의 판단한 것이 아니다).
        */}

        {/* 포디움 — ★「관심」 범위에는 포디움이 없다. 내가 고른 20명 안의 «1·2·3위»는
            전체 랭킹의 왕좌가 아니라서 시상대로 그리면 순위를 오해시킨다. */}
        {scope === 'all' && top3.length === 3 && (
          <div className="podium">
            <Pod entry={top3[1]} place={2} onClick={() => nav(`/trader/${top3[1].accountId}`)} />
            <Pod entry={top3[0]} place={1} onClick={() => nav(`/trader/${top3[0].accountId}`)} />
            <Pod entry={top3[2]} place={3} onClick={() => nav(`/trader/${top3[2].accountId}`)} />
          </div>
        )}

        {/* 4위 이하 */}
        {/* ★가로 여백을 --gutter(20px)로 통일 — 홈·종목·설정과 같은 그리드에 올린다.
            예전엔 이 화면만 14px 이라 탭 전환 때 콘텐츠가 옆으로 튀었다(실측). */}
        {scope === 'watch' ? (
          <WatchScope
            rows={watchRows}
            meId={meId}
            onSelect={openTrader}
            onToggleWatch={toggleWatch}
            onSeeAll={() => setScope('all')}
          />
        ) : (
        <div style={{ padding: '14px 20px 0' }}>
          {/*
            ★리스트를 «8행 / 광고 / 나머지» 로 끊는다.
              - 광고를 리스트 카드 «안»에 넣으면 랭킹 한 행처럼 보여 오탭을 부른다
                (이 앱에서 오탭 = 열람권 1장 소모다).
              - 통째로 뒤에 붙이면 97행 밑(스크롤 7000px)이라 아무도 못 본다(실측).
              - 8행은 첫 화면(844px) 밖이라 「첫 화면에 광고부터」가 되지 않는다.
          */}
          <div className="card card--list">
            {list.slice(0, AD_AFTER_ROWS).map((r, i) => (
              <div key={r.accountId}>
                {i > 0 && <div className="divider" style={{ marginLeft: 53 }} />}
                <RankRow entry={r} me={r.accountId === meId} watched={watchSet.has(r.accountId)} onSelect={openTrader} onToggleWatch={toggleWatch} />
              </div>
            ))}
          </div>

          <AdBanner slot="bannerLeaderboard" />

          <div className="card card--list">
            {list.slice(AD_AFTER_ROWS).map((r, i) => (
              <div key={r.accountId}>
                {i > 0 && <div className="divider" style={{ marginLeft: 53 }} />}
                <RankRow entry={r} me={r.accountId === meId} watched={watchSet.has(r.accountId)} onSelect={openTrader} onToggleWatch={toggleWatch} />
              </div>
            ))}
          </div>

          {/*
           * 내 주변 — **탑100 «밖»일 때만** 노출한다.
           * 이전 조건 `meIdx >= 3` 은 포디움(0~2)만 제외했기 때문에, 목록이
           * `slice(3, LEADERBOARD_SIZE)` 로 4~100위를 그리는 지금은 그 구간의
           * 플레이어가 «목록 + 내주변» 에 중복 표시된다.
           * 30행 시절엔 중복 구간이 rank 4~29 라 눈에 덜 띄었을 뿐 같은 결함이었고,
           * 100 으로 늘리면서 4~99 로 넓어져 훨씬 잘 드러난다.
           * 탑100 안에 있으면 이미 목록에 보이므로 내주변 섹션은 필요가 없다.
           * 숫자를 다시 박지 않고 constants 의 LEADERBOARD_SIZE 를 참조한다.
           */}
          {near.length > 0 && meIdx >= LEADERBOARD_SIZE && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 4px 10px' }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--t2)' }}>{t('nearMe')}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              </div>
              <div className="card card--list">
                {near.map((r, i) => (
                  <div key={`near-${r.accountId}`}>
                    {i > 0 && <div className="divider" style={{ marginLeft: 53 }} />}
                    <RankRow
                      entry={r}
                      me={r.accountId === meId}
                      relative={me ? r.equity - me.equity : 0}
                      watched={watchSet.has(r.accountId)}
                      onSelect={openTrader}
                      onToggleWatch={toggleWatch}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {!me && (
            <div className="card card--pad" style={{ marginTop: 14, textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{t('outOfTop')}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{t('outOfTopSub')}</div>
            </div>
          )}

          {/* 실유저 초대 카드는 제거 — 싱글 빌드에는 초대받아 들어올 «다른 사람»이 없다(Partner 판정) */}
          <div className="scroll-pad" />
        </div>
        )}
      </div>

      {/*
        하단 고정 «내 순위» — 두 축(Partner 판정 2026-08-05).
        자산 순위는 시드 차이 때문에 항상 꼴찌권이다. 사실이므로 숨기지 않고,
        의미 있는 축(시드 대비 수익률)을 나란히 둔다.
      */}
      {axes && <MyRankBar axes={axes} above={above} />}
      {cbOpen && <CentralBankSheet onClose={() => setCbOpen(false)} />}
    </div>
  );
}

/**
 * 괴리(비율) 표시 — ★소수 둘째 자리에서 0 이면 부호를 붙이지 않는다.
 *   [실렌더로 잡음] −0.003% 가 「-0.00%」로 찍혔다. 「마이너스 영」은 숫자가 아니라 오타로 읽힌다.
 */
function gapPct(basis: number): string {
  const p = basis * 100;
  return Math.abs(p) < 0.005 ? '0.00%' : signedPct(p, 2);
}

/**
 * 중앙은행 «띠» — 한 줄 상태 + 지금 괴리. 눌러서 시트를 연다.
 * ★상태 문구는 «사실»만: 개입 0회면 「관망 중」, 아니면 「N회 개입 · 최근 종목 매수/매도」.
 * ★괴리 숫자는 엔진 값(basis)을 «그대로» 보여 준다 — 화면이 가중합을 다시 계산하지 않는다.
 */
function CentralBankCard({ onOpen }: { onOpen: () => void }) {
  const s = useStore();
  const { t } = useTranslation('rank');
  const v = s.centralBankView();
  const worst = v.spreads.reduce<(typeof v.spreads)[number] | null>((a, b) => (!a || Math.abs(b.basis) > Math.abs(a.basis) ? b : a), null);
  const wide = !!worst && Math.abs(worst.basis) > v.threshold;
  /*
   * ★부제 한 줄 = «상태 · 괴리». 처음엔 괴리를 오른쪽 열에 따로 뒀는데 375px·영어에서 부제가
   *   말줄임됐다(실렌더). 값 하나를 부제로 «합치면» 어느 로케일·폭에서도 한 줄이다.
   * ★가장 벌어진 지수의 괴리를 보인다 — 「지금 시장이 얼마나 제자리인가」의 «한 숫자».
   */
  const status = v.interventions > 0 ? t('cbActive', { n: v.interventions }) : t('cbIdle');
  const sub = worst ? `${status} · ${t('cbSpread', { v: gapPct(worst.basis) })}` : status;
  return (
    <div style={{ padding: '0 var(--gutter) var(--gap-block)' }}>
      <button type="button" className="cbcard" onClick={onOpen} aria-haspopup="dialog">
        <span className="cbcard__ic" aria-hidden>
          {Icon.bank(20)}
        </span>
        <span className="cbcard__t">
          <span className="cbcard__nm">{t('cbName')}</span>
          <span className={`cbcard__sub num ${wide ? 'is-wide' : ''}`}>{sub}</span>
        </span>
        {Icon.chevron}
      </button>
    </div>
  );
}

/** 세션 헤더용 «날짜·시각» — 로케일 규칙(Intl)로만 만든다. 문자열에 숫자를 박지 않는다 */
function fmtSession(ms: number, ko: boolean): string {
  return new Intl.DateTimeFormat(ko ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** 중앙은행 시트 — 소개 3문장 · 지수 괴리 · 포지션 · 최근 체결(세션을 넘어 · 접속 시각 헤더). ⛔자산 총액·순위 없음 */
function CentralBankSheet({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const { t, i18n } = useTranslation('rank');
  const ko = i18n.language !== 'en';
  const v = s.centralBankView();
  const nameOf = (tk: string) => {
    /* ★[-24] 바스켓 다리 포지션 키 `${지수}:basket` — 「S&P 500 바스켓」 */
    const i = tk.indexOf(':basket');
    const base = i > 0 ? tk.slice(0, i) : tk;
    const nm = ko ? metaOf(base).nameKo : metaOf(base).nameEn;
    return i > 0 ? (t('cbBasketName', { name: nm }) as string) : nm;
  };
  return (
    <Sheet onClose={onClose} labelledBy="cb-title">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="cbcard__ic" aria-hidden>
          {Icon.bank(22)}
        </span>
        <h2 id="cb-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>
          {t('cbName')}
        </h2>
      </div>
      <p style={{ marginTop: 'var(--space-sm)', fontSize: 13, lineHeight: 1.6, color: 'var(--t2)' }}>
        {t('cbIntro', { p: `${(v.threshold * 100).toFixed(1)}%` })}
      </p>

      <div className="sec__h cbsheet__h">{t('cbSpreads')}</div>
      <div className="card card--sub" style={{ padding: '2px 16px' }}>
        {v.spreads.map((sp, i) => (
          <div key={sp.ticker}>
            {i > 0 && <div className="divider" />}
            <div className="kv" style={{ padding: '10px 0' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{nameOf(sp.ticker)}</span>
                <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                  {t('cbFair', { v: money(sp.fair) })}
                </span>
              </span>
              <span style={{ textAlign: 'right' }}>
                <span className="num" style={{ display: 'block', fontSize: 15, fontWeight: 800 }}>{money(sp.price)}</span>
                <span
                  className={`num ${Math.abs(sp.basis) > v.threshold ? 'is-wide' : ''}`}
                  style={{ display: 'block', fontSize: 11, fontWeight: 700, marginTop: 2, color: Math.abs(sp.basis) > v.threshold ? 'var(--warn-ink)' : 'var(--t3)' }}
                >
                  {t('cbSpread', { v: gapPct(sp.basis) })}
                </span>
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="sec__h cbsheet__h">{t('cbPositions')}</div>
      {v.positions.length === 0 ? (
        <p className="hint cbsheet__empty">{t('cbNoPositions')}</p>
      ) : (
        <div className="card card--sub" style={{ padding: '2px 16px' }}>
          {v.positions.map((p, i) => (
            <div key={p.ticker}>
              {i > 0 && <div className="divider" />}
              <div className="kv" style={{ padding: '10px 0' }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{nameOf(p.ticker)}</span>
                  <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                    {t(p.qty >= 0 ? 'cbLong' : 'cbShort', { n: Math.abs(p.qty).toFixed(1) })} · {t('cbAvg', { v: money(p.avgCost) })}
                  </span>
                </span>
                <span className={`num ${p.pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15, fontWeight: 800 }}>
                  {signedMoney(p.pnl, 0)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sec__h cbsheet__h">{t('cbFills')}</div>
      {v.fills.length === 0 ? (
        <p className="hint cbsheet__empty">{t('cbNoFills')}</p>
      ) : (
        <div className="card card--sub" style={{ padding: '2px 16px' }}>
          {v.fills.slice(0, 8).map((f, i, arr) => (
            <div key={`${f.sid ?? 0}-${f.id}`}>
              {/* ★[-23] 세션이 바뀌는 자리에 «접속 시각» 헤더 — 세션을 넘어 이어진 기록임을 화면이 말한다 */}
              {f.sid !== undefined && (i === 0 || arr[i - 1].sid !== f.sid) && (
                <div className="cbsession num">{t('cbSession', { d: fmtSession(f.sid, ko) })}</div>
              )}
              {i > 0 && arr[i - 1].sid === f.sid && <div className="divider" />}
              {/*
                ★[-24] 한 체결 = «두 다리» — 지수(선물) 한 방향 + 구성종목 가중합 바스켓 반대 방향(같은 틱).
                  두 줄을 한 카드 행에 쌓는다: 줄마다 [배지 매도/매수] 이름 · 오른쪽 명목. 옛 원장 체결(-23 이전, 바스켓 없음)은 한 줄만.
              */}
              <div className="kv" style={{ padding: '10px 0', alignItems: 'flex-start' }}>
                <span style={{ minWidth: 0 }}>
                  <span className="cbleg" style={{ display: 'block', fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>
                    <span className={`badge ${f.side === 'buy' ? 'badge--up' : 'badge--down'}`} style={{ marginRight: 6 }}>
                      {t(f.side === 'buy' ? 'cbBuy' : 'cbSell')}
                    </span>
                    {t('cbLegIndex', { name: nameOf(f.ticker) })}
                  </span>
                  {f.basketSide && (
                    <span className="cbleg" style={{ display: 'block', fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', marginTop: 4 }}>
                      <span className={`badge ${f.basketSide === 'buy' ? 'badge--up' : 'badge--down'}`} style={{ marginRight: 6 }}>
                        {t(f.basketSide === 'buy' ? 'cbBuy' : 'cbSell')}
                      </span>
                      {t('cbBasketName', { name: nameOf(f.ticker) })}
                    </span>
                  )}
                  <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                    {t('cbFillGap', { v: gapPct(f.basisBefore) })}
                  </span>
                </span>
                <span style={{ textAlign: 'right', flex: '0 0 auto' }}>
                  <span className="num" style={{ display: 'block', fontSize: 15, fontWeight: 800 }}>{money(f.notional, 0)}</span>
                  {f.basketNotional !== undefined && (
                    <span className="num" style={{ display: 'block', fontSize: 15, fontWeight: 800, marginTop: 4 }}>{money(f.basketNotional, 0)}</span>
                  )}
                  <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                    {t('home:macroFeedDay', { n: f.gameDay + 1 })} · {money(f.price)}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 'var(--space-xs)' }} />
    </Sheet>
  );
}

/**
 * MyRankBar — 화면 하단 고정 «내 순위».
 *
 * 표시: `자산 211위 · 수익률 34위`
 *  - 자산 순위: 대시보드(요건 #15) 와 같은 기준. 시드 1만으로 시작했으니 꼴찌인 게 맞다.
 *  - 수익률 순위: 시드 대비 수익률. 웨일이 200만으로 1.07배 만든 것보다
 *    1만으로 1.3배 만든 쪽이 위로 온다.
 * 목록 정렬(자산 내림차순)은 이 표시와 무관하게 그대로다.
 */
function MyRankBar({ axes, above }: { axes: MyRankAxes; above: RankEntry | null }) {
  const { t } = useTranslation('rank');
  const d = axes.entry.delta ?? 0;
  return (
    <div className="mysticky">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="num" style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
          {t('myTwoAxis', { equity: axes.equityRank, ret: axes.returnRank })}
        </div>
        {/* ★opacity 로 흐리게 하지 않는다 — 배경이 밝아졌으므로 «명시적인 색»을 준다.
            opacity 는 대비를 계산할 수 없게 만들어 접근성 검증을 못 하게 한다. */}
        <div
          style={{
            fontSize: 11,
            color: 'var(--t2)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {above
            ? t('toNext', { v: bigMoney(Math.max(0.01, above.equity - axes.entry.equity)), rank: above.rank })
            : t('toNextTop')}
        </div>
      </div>
      <span
        role="img"
        aria-label={d > 0 ? t('upSteps', { n: d }) : d < 0 ? t('downSteps', { n: -d }) : t('sameSteps')}
        style={{
          /* ★흰 반투명은 «어두운 면» 위에서만 성립한다. 면이 밝아졌으니 흰 면 + 잉크로 바꾼다 */
          fontSize: 12,
          fontWeight: 800,
          background: 'var(--surface)',
          color: 'var(--brand-ink)',
          padding: '6px 11px',
          borderRadius: 999,
          flex: '0 0 auto',
        }}
      >
        {d > 0 ? `▲${d}` : d < 0 ? `▼${Math.abs(d)}` : '—'}
      </span>
    </div>
  );
}

/**
 * 포트폴리오 열람권 설명 패널 — ★「기능이 안 보인다」에 대한 답이다.
 *
 * ★왜 모달이 아닌가: 모달은 게임 화면을 덮고 유저를 «막는다». 이건 막을 일이 아니라
 *   «알려줄» 일이다(impeccable product §Modal as first thought). 그래서 인라인 패널이다.
 * ★왜 여기 있나: 열람권을 쓰는 «장소»가 랭킹 목록이라, 설명도 목록 바로 위에 있어야 한다.
 *   설정 화면에 숨겨 두면 오늘과 같은 결과(발견 실패)가 반복된다.
 * ★리워드는 «선택»이다 — 광고가 없는 환경(웹·구버전)에서도 자정 리셋이라는 길이 항상 있다.
 */
function ViewPassPanel({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const { t } = useTranslation('rank');
  const ad = useRewardAd('view');
  const viewsLeft = s.daily?.viewsLeft ?? TRADER_VIEW_DAILY_LIMIT;
  const adRoom = Math.max(0, (s.daily?.viewBonusMax ?? 0) - (s.daily?.viewBonus ?? 0));
  const canWatchAd = ad.supported && adRoom > 0;

  /* 리셋까지 남은 시간 — 「내일 밤 12시」가 아니라 «몇 시간 뒤»가 유저에게 쓸모 있다 */
  const until = msUntilKstMidnight();
  const h = Math.floor(until / 3600000);
  const mn = Math.floor((until % 3600000) / 60000);

  return (
    /*
     * ★★[2026-08-23 President 지적] 「포트폴리오 열람권과 위아래 사이의 간격이 너무 좁아」
     *
     * [수정 전 실측] 위 11px(.rkbar 아래 10 + 헤어라인 1) · 아래 12px · ★카드 «안» 16px
     *   ⇒ ⛔내부 패딩(16) > 외부 간격(11/12) — «근접성이 뒤집혀» 있었다.
     *     카드 안 내용물이 카드 경계보다 «멀리» 있으니 카드가 독립 객체로 안 읽히고
     *     위아래에 «붙은 띠»로 보인다. President 가 본 게 정확히 이것이다.
     *   ⇒ ⛔그리고 위(11)와 아래(12)가 «사실상 같아서», 이 패널이 «위쪽 칩을 눌러 연»
     *     disclosure 라는 «소속»을 전달하지 못했다.
     *
     * [수정] 위 --space-xs(8) · 아래 --gap-section(24).
     *   ★위를 «좁히고» 아래를 «넓혔다» — 방향이 중요하다. 좁은 쪽이 «소속»을 만든다.
     *   ★이제 카드 내부(16) < 아래 간격(24) 이라 근접성이 «바로» 선다.
     * ★`Leaderboard.tsx` 의 infoOpen 은 «매일 첫 진입에 기본 열림»이다 —
     *   즉 예외 상태가 아니라 랭킹 화면에서 «가장 많이 보이는» 상태다.
     * ★[2026-08-29] 아래 24 → 8. 정렬 토글 줄이 «자기 위 여백 16»을 갖게 되어 합이 24 로 같다.
     *   (토글이 없는 「관심」 범위에서는 이 패널 뒤에 목록 패딩 14 가 오므로 22 — 리듬 안이다)
     */
    <div style={{ padding: '0 var(--gutter) var(--space-xs)', marginTop: 'var(--space-xs)' }}>
      <div className="card card--pad">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>{t('viewPassTitle')}</span>
          <button
            type="button"
            onClick={onClose}
            style={{ flex: '0 0 auto', padding: '4px 8px', margin: '-4px -8px', fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}
          >
            {t('common:close')}
          </button>
        </div>
        <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.55, color: 'var(--t2)' }}>
          {t('viewPassBody', { n: TRADER_VIEW_DAILY_LIMIT })}
        </p>
        <div className="kv" style={{ marginTop: 10 }}>
          <span className="kv__k">{t('viewPassLeft')}</span>
          <span className="kv__v num">{t('viewsCount', { n: viewsLeft })}</span>
        </div>
        <div className="kv">
          <span className="kv__k">{t('recharge:untilReset')}</span>
          <span className="kv__v num">{t('recharge:hoursMinutes', { h, m: String(mn).padStart(2, '0') })}</span>
        </div>
        {canWatchAd && (
          <button
            type="button"
            className="btn btn--sub"
            style={{ marginTop: 12, padding: 12, fontSize: 12 }}
            disabled={ad.busy}
            onClick={() => void ad.run()}
          >
            {ad.busy ? t('common:loading') : t('viewsAdCta', { n: adRoom })}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 「관심」 범위 — 내가 별을 준 참가자만 모아 본다.
 *
 * ★목록을 «보는 것»은 무료다(닉네임·자산·수익률). 열람권은 프로필을 «여는» 순간에만 나간다.
 *   그래서 여기엔 광고 배너를 넣지 않는다 — 최대 20행짜리 짧은 목록에 광고를 끼우면
 *   첫 화면에 광고가 들어오고(스크롤 0), 내가 고른 사람들 사이에 낀 광고는 오탭을 부른다.
 * ★빈 상태는 «가르치는» 빈 상태다. 「없어요」로 끝내지 않고 어디서 담는지 + 무료라는 사실을 적는다.
 */
function WatchScope({
  rows,
  meId,
  onSelect,
  onToggleWatch,
  onSeeAll,
}: {
  rows: RankEntry[];
  meId: string;
  onSelect: (accountId: string) => void;
  onToggleWatch: (accountId: string) => void;
  onSeeAll: () => void;
}) {
  const { t } = useTranslation('rank');
  return (
    <div style={{ padding: '14px 20px 0' }}>
      {rows.length === 0 ? (
        <div className="card card--pad" style={{ textAlign: 'center', padding: '28px 22px' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', color: 'var(--t3)' }} aria-hidden>
            {Icon.star(false)}
          </span>
          <div style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>{t('watchEmpty')}</div>
          <p style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, lineHeight: 1.55 }}>{t('watchEmptySub')}</p>
          <button type="button" className="btn btn--sub" style={{ marginTop: 14, padding: 12, fontSize: 12 }} onClick={onSeeAll}>
            {t('watchEmptyCta')}
          </button>
        </div>
      ) : (
        <>
          <div className="card card--list">
            {rows.map((r, i) => (
              <div key={`w-${r.accountId}`}>
                {i > 0 && <div className="divider" style={{ marginLeft: 53 }} />}
                <RankRow entry={r} me={r.accountId === meId} watched onSelect={onSelect} onToggleWatch={onToggleWatch} />
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 10 }}>{t('watchHint', { n: WATCHED_TRADERS_MAX })}</p>
          {/*
            ★A3 — 관심 목록 배너. ★AD_AFTER_ROWS(8) «이상»일 때만 그린다.
              그 미만이면 목록이 짧아 배너가 «첫 화면»에 들어온다 — 규칙 위반이다.
              지면은 랭킹과 «같은» 것을 재사용한다(신규 발급 0). 전체/관심 탭은 동시에 뜨지 않으므로
              한 화면에 배너가 2개가 될 일이 없다.
          */}
          {/*
            ⚠★[2026-08-21 실렌더로 잡은 결함] 여백이 «0/0» 이었다.
              · 위: 바로 위 `.hint` 와 붙어(10px) 「광고」 라벨이 그 문장의 꼬리처럼 읽혔다.
                «전체» 탭은 위아래가 카드 모서리라 경계가 생기지만 여기는 맨 텍스트다.
              · 아래: 이 배너가 목록의 «끝»이라 `.scroll-pad`(24) 뒤가 곧 `.mysticky` 다.
                실측 ★24px — 그 바는 ★접기 버튼이 있는 «상호작용 요소»다
                (구글 AdMob: 배너를 상호작용 버튼 옆에 두지 말 것).
            ⇒ 위 20 · 아래 16(+ scroll-pad 24 = ★40px)로 띄운다.
          */}
          {rows.length >= AD_AFTER_ROWS && (
            <AdBanner slot="bannerLeaderboard" style={{ margin: '20px 0 16px' }} />
          )}
        </>
      )}
      <div className="scroll-pad" />
    </div>
  );
}

function Pod({ entry, place, onClick }: { entry: RankEntry; place: 1 | 2 | 3; onClick: () => void }) {
  const size = place === 1 ? 58 : 46;
  const bg =
    place === 1
      ? 'linear-gradient(140deg, var(--gold), var(--gold-2))'
      : place === 2
        ? 'var(--silver)'
        : 'var(--bronze)';
  const baseBg =
    place === 1
      ? 'linear-gradient(180deg, var(--gold), var(--gold-2))'
      : place === 2
        ? 'linear-gradient(180deg, var(--silver), var(--silver-2))'
        : 'linear-gradient(180deg, var(--bronze), var(--bronze-2))';
  const h = place === 1 ? 74 : place === 2 ? 52 : 38;
  return (
    <button className="pod" onClick={onClick}>
      {place === 1 && (
        <div style={{ marginBottom: -2, color: 'var(--gold)', display: 'grid', placeItems: 'center' }} aria-hidden>
          {Icon.crown(20)}
        </div>
      )}
      <span
        className="av"
        style={{
          width: size,
          height: size,
          background: bg,
          margin: '0 auto 6px',
          fontSize: place === 1 ? 17 : 15,
          /* ★금색 글로우 제거. 메달 «금속» 그라디언트는 표상이라 남긴다(장식과 구분) */
        }}
        aria-hidden
      >
        {entry.nickname.slice(0, 1)}
      </span>
      <div className="pod__nm" style={{ fontSize: place === 1 ? 12 : 12 }}>
        {entry.nickname}
      </div>
      <div className={`num ${entry.pnlPct >= 0 ? 'up' : 'down'}`} style={{ fontSize: 11, fontWeight: 800, marginTop: 1 }}>
        {signedPct(entry.pnlPct, 0)}
      </div>
      <div className="num" style={{ fontSize: place === 1 ? 12 : 12, fontWeight: 800, marginTop: 3 }}>
        {/* ★[2026-08-30] 10억 이상은 bigMoney 축약 — 「$1,000,000,066,239」(18자)는 이 바에 안 들어간다(verify_bigmoney 실측) */}
        {bigMoney(entry.equity, 0)}
      </div>
      <div className="pod__base" style={{ height: h, background: baseBg }}>
        {place}
      </div>
    </button>
  );
}

/**
 * 랭킹 한 행.
 *
 * [탑100 배선 후 성능] 스토어는 매 틱(TICK_MS=2s) `bump()` 하므로 Leaderboard 는
 * 2초마다 리렌더된다. 반면 랭킹 배열(`s.ranks`)은 2틱 계산 + 3초 스로틀이라 ~4초마다
 * 새로 만들어진다. `rows` 는 `useMemo([s.ranks, sort])` 라 그 사이 틱에서는
 * **행 객체 아이덴티티가 그대로**다 -> memo 가 걸리면 100행이 통째로 건너뛰어진다.
 * 그래서 onClick 인라인 화살표(매 렌더 새 함수 = memo 무력화) 대신
 * 부모가 useCallback 으로 고정한 `onSelect(accountId)` 를 받는다.
 */
const RankRow = memo(function RankRow({
  entry,
  me,
  relative,
  watched,
  onSelect,
  onToggleWatch,
}: {
  entry: RankEntry;
  me: boolean;
  relative?: number;
  watched: boolean;
  onSelect: (accountId: string) => void;
  onToggleWatch: (accountId: string) => void;
}) {
  const { t } = useTranslation('rank');
  const meta = entry.isBot ? botMeta(entry.accountId) : undefined;
  const badge = meta ? CONCEPT_BADGE[meta.concept] : undefined;

  /*
   * [「봇」 배지 제거 — President 지시 2026-08-18]
   * 이전에는 봇 행 부제가 «전략 배지 + 🤖 봇» 두 개였다. 「봇」쪽을 «DOM 에서» 뺀다
   * (display:none 로 감추면 flex gap 5px 이 남아 배지 오른쪽에 빈 자리가 생긴다).
   *
   * ★ 부제 줄(.rk__bd)이 «비면» 안 된다 — 비면 그 행만 높이가 19.2px -> 0 으로
   *   줄어 목록 정렬이 무너진다. 그래서 다음 순서로 «항상 한 조각»을 보장한다:
   *     1) 내주변 섹션의 «나와의 차액» 문구가 있으면 그것
   *     2) 전략 배지가 있으면 배지만 (봇 210개 전원 해당 — 5전략 × 42, 실측)
   *     3) 둘 다 없으면 «참가자»
   *   3) 은 BOT_STRATEGY 조회가 미래에 어긋나도 행이 찌그러지지 않게 하는 안전망이다.
   */
  const relText =
    relative !== undefined && relative !== 0 && !me
      ? relative > 0
        ? t('aboveMe', { v: money(Math.abs(relative)) })
        : t('belowMe', { v: money(Math.abs(relative)) })
      : null;
  const subText = relText ?? (badge ? null : t('profileTitle'));

  /*
   * ★행 구조가 «버튼 하나»에서 «행 + 별 버튼»으로 바뀌었다.
   *   버튼 안에 버튼을 넣는 것은 HTML 상 무효고, 실제로도 별을 누를 때마다
   *   바깥 버튼까지 눌려 «프로필이 열리고 열람권이 1장 나간다».
   *   그래서 형제로 나란히 두고, 별 쪽 탭 타깃을 40x40 으로 넉넉히 잡아
   *   오탭(=열람권 소모)을 구조적으로 막는다.
   *   ⛔Web 접근성 기준은 44 가 아니라 WCAG 2.2 AA 의 «24 CSS px» 다 — 40 은 그 위다.
   * ★내 행 하이라이트(.is-me)는 «행 전체»가 대상이라 래퍼로 올렸다.
   */
  return (
    <div className={`rkwrap ${me ? 'is-me' : ''}`}>
    <button className="rk" onClick={() => onSelect(entry.accountId)}>
      <span className="rk__n">{entry.rank}</span>
      <span className="av" style={{ width: 34, height: 34, background: me ? 'var(--brand)' : avatarColor(entry.nickname), fontSize: 12 }} aria-hidden>
        {entry.nickname.slice(0, 1)}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="rk__nm" style={{ display: 'block' }}>
          {entry.nickname}
          {me && <span className="badge badge--brand" style={{ marginLeft: 6 }}>{t('meBadge')}</span>}
        </span>
        <span className="rk__bd">
          {badge && meta && <ConceptBadge strategy={meta.concept} i18nKey={meta.i18nKey} />}
          {subText}
        </span>
      </span>
      <span className="rk__rt">
        <span className="rk__a num" style={{ display: 'block' }}>
          {bigMoney(entry.equity, 0)}
        </span>
        <span className={`rk__p num ${entry.pnlPct >= 0 ? 'up' : 'down'}`} style={{ display: 'block' }}>
          {signedPct(entry.pnlPct, 1)}
        </span>
      </span>
    </button>
      {/* ★관심 토글 — 여기서는 «열람권을 쓰지 않는다». 목록에 담아 두는 것뿐이고,
          포트폴리오를 여는 순간(행 탭)에만 1장이 나간다. */}
      {me ? (
        /* ★내 행에는 별이 없다(나를 관심 등록할 이유가 없다). 대신 «같은 크기의 빈 자리»를
            둔다 — 안 두면 내 행만 자산 숫자가 48px 더 오른쪽으로 나가 열이 어긋난다. */
        <span className="rk__star" aria-hidden />
      ) : (
        <button
          type="button"
          className="rk__star"
          aria-pressed={watched}
          aria-label={watched ? t('watchOffAria', { name: entry.nickname }) : t('watchOnAria', { name: entry.nickname })}
          onClick={() => onToggleWatch(entry.accountId)}
        >
          {Icon.star(watched)}
        </button>
      )}
    </div>
  );
});
