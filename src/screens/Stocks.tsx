import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Primitives';
import { StockRow } from '../components/StockRow';
import { VirtualList } from '../components/VirtualList';
import { AdBanner } from '../components/AdBanner';
import { STOCKS_AD_EVERY, STOCKS_BANNER_SLOTS, adBlockH, adSlotVisible, stocksAdReservedH } from '../lib/ads';
import { ConnBadge } from './Home';
import { useLocation } from 'react-router-dom';
import { useStore, useTick } from '../store/hooks';
import { TICKERS } from '../data/tickers.generated';
/* ★배당수익률은 «엔진 함수»를 그대로 쓴다. ⛔화면이 자산군 규칙을 다시 구현하면
   오늘 겪은 「지수 깊이 16배」와 같은 형태의 결함이 재발한다. */
import { annualYieldOf } from '../lib/engine/dividends';
import { TICKS_PER_GAME_DAY } from '../lib/constants';
import { normalizeNeedle, sortTickers } from '../lib/tickerSort';

/** 섹터 필터 칩 — 티어 + 대표 섹터 */
const TIERS = ['빅테크', '성장주', '우량배당'] as const;
const SECTORS = ['반도체', '소프트웨어', '제약', '은행', '에너지'] as const;

/**
 * ★주요 자산 칩 (President 지적 2026-08-23: 「주요자산들이 너무 하단에 있다」).
 *
 * ⛔이 값들은 «업종명»이 아니라 자산군이지만, 데이터에서 `sectorKo` 가 실제로
 *   「지수」·「원자재」·「가상자산」이다 ⇒ 기존 필터 판정(`m.sectorKo === chip`)이
 *   ★그대로 작동한다. 새 분기를 만들지 않았다(분기를 늘리면 갈라질 자리가 는다).
 * ★칩을 «맨 앞»에 두는 이유: 재배열만으로는 「전체」 밖에서 도달 경로가 없다.
 *   정렬을 바꿔도 이 칩으로는 «항상» 닿는다.
 */
const ASSET_CHIPS = ['지수', '원자재', '가상자산'] as const;

/*
 * ★[2026-08-29] 기본 정렬 규칙(주요 자산 먼저 → 순위)은 `lib/tickerSort.ts` «한 벌»로 옮겼다.
 *   파생 종목 피커가 같은 함수를 쓴다 — President 「기초자산 구매랑 정렬 순서를 맞춰줘」.
 *   ⛔여기 MAJOR_FIRST 를 되살리지 마라. 두 벌이 되는 순간 다시 갈린다.
 */

/** 정렬 축. ★`default` = 주요자산 먼저 + 그 다음 순위 */
type SortKey = 'default' | 'change' | 'price' | 'volume' | 'yield' | 'cap' | 'name';
const SORT_KEYS: readonly SortKey[] = ['default', 'change', 'price', 'volume', 'yield', 'cap', 'name'];
/**
 * 축마다 «자연스러운 첫 방향». 등락률·가격·거래량·배당은 «높은 쪽»이,
 * 시총은 «큰 쪽»(=순위 1위)이, 이름은 «가나다순»이 기본이다.
 * ⛔전부 같은 방향으로 통일하지 마라 — 「이름 내림차순」이 첫 화면이면 그냥 이상하다.
 */
const SORT_DEFAULT_DESC: Record<SortKey, boolean> = {
  default: true, change: true, price: true, volume: true, yield: true, cap: true, name: false,
};
/** 거래량 집계 창 — 1 게임일. ⛔틱 하나만 보면 «그 틱에 안 거래된 종목»이 전부 0 이다 */
const VOL_WINDOW = TICKS_PER_GAME_DAY;

export function Stocks() {
  const s = useStore();
  useTick();
  const loc = useLocation();
  const { t, i18n } = useTranslation('home');
  const ko = i18n.language !== 'en';
  const [q, setQ] = useState('');
  /** ★검색 상자 «전체»를 눌러도 입력으로 들어가게 한다(탭 타깃 22px → 44px) */
  const searchRef = useRef<HTMLInputElement>(null);
  /*
   * ★홈의 「N개 모두 보기」가 /stocks?own=1 로 들어온다 — 그때는 «보유» 필터로 시작한다.
   *   HashRouter 라 쿼리는 해시 뒤에 붙고, useLocation().search 로 그대로 읽힌다.
   */
  /*
   * ★홈 「지금 일어나는 일」의 업종 칩이 /stocks?sector=<한국어 업종명> 으로 들어온다.
   *   ⇒ 「이벤트를 읽었다 → 그럼 어느 종목을?」의 «고리»가 여기서 닫힌다.
   * ★한국어 업종명을 키로 쓰는 이유: 필터 판정이 `m.sectorKo === chip` 이라
   *   데이터의 «식별자»가 sectorKo 다. 표시만 로케일로 바꾼다(sectorLabel).
   * ★알 수 없는 값이 오면 조용히 'all' 로 떨어진다 — 링크가 썩어도 빈 화면이 되지 않는다.
   */
  const [chip, setChip] = useState<string>(() => {
    const qs = new URLSearchParams(loc.search);
    if (qs.get('own') === '1') return 'own';
    const sector = qs.get('sector');
    if (sector && TICKERS.some((m) => m.sectorKo === sector)) return sector;
    return 'all';
  });
  /* ★[-33] 「보유」 필터(홈 「N개 모두 보기」 포함)를 본 것 = 포트폴리오 확인 → 홈 출석 시트의 「추가 지급(광고)」 버튼이 열린다 */
  useEffect(() => {
    if (chip === 'own') s.notePortfolioView();
  }, [chip, s]);
  const owned = useMemo(
    () => new Set((s.portfolio?.holdings ?? []).map((h) => h.ticker)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.portfolio?.holdings.length, s.tickVersion]
  );

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return TICKERS.filter((m) => {
      if (chip === 'own') {
        if (!owned.has(m.ticker)) return false;
      } else if (chip !== 'all' && m.tierKo !== chip && m.sectorKo !== chip) return false;
      if (!needle) return true;
      return (
        m.ticker.toLowerCase().includes(needle) ||
        m.nameKo.toLowerCase().includes(needle) ||
        m.nameEn.toLowerCase().includes(needle)
      );
    });
  }, [q, chip, owned]);

  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [desc, setDesc] = useState(true);

  /** 칩을 누르면 «정렬은 그대로» 둔다 — 필터와 정렬은 직교한다 */
  const pickSort = (k: SortKey) => {
    if (k === sortKey) setDesc((d) => !d);
    else {
      setSortKey(k);
      setDesc(SORT_DEFAULT_DESC[k]);
    }
  };

  /*
   * ★정렬은 «스냅샷»이다 — 의존성에 `tickVersion` 을 «넣지 않았다».
   *   넣으면 2.4초마다 1,000행이 통째로 재배열된다. 스크롤하는 손가락 밑에서
   *   행이 뒤바뀌는 것은 «정렬이 없는 것보다 나쁘다».
   * ⇒ 정렬·방향·필터·검색이 바뀔 때만 다시 센다. 가격 자체는 행(useQuote)이 계속 갱신한다.
   */
  const sorted = useMemo(() => {
    const arr = list.slice();
    if (sortKey === 'default') {
      /* ★주요 자산 먼저 → 순위. 검색 중이면 «매치 품질»이 앞선다(「S&P」 → SPX 가 SPGI 위).
         규칙은 lib/tickerSort.ts 한 벌 — 파생 피커와 «같은 순서»다. */
      return sortTickers(arr, normalizeNeedle(q));
    }
    if (sortKey === 'name') {
      const key = (m: (typeof TICKERS)[number]) => (ko ? m.nameKo : m.nameEn);
      arr.sort((a, b) => (desc ? -1 : 1) * key(a).localeCompare(key(b), ko ? 'ko' : 'en'));
      return arr;
    }
    /*
     * ★배당 정렬에서 «0» 은 «낮은 값»이 아니라 ★«없음»이다 —
     *   지수·원자재·가상자산은 배당 «개념»이 없고(annualYieldOf 가 0을 준다),
     *   TSLA 등은 무배당 정책이다. ⇒ 방향과 무관하게 «항상 뒤»로 보낸다.
     *   ⛔오름차순에서 0이 상단을 뒤덮으면 그 화면은 아무 정보도 주지 않는다.
     */
    const valOf = (m: (typeof TICKERS)[number]): number => {
      switch (sortKey) {
        case 'change': return s.getQuote(m.ticker)?.totalChangePct ?? 0;
        case 'price': return s.getQuote(m.ticker)?.price ?? m.initialPrice;
        case 'volume': return s.volumeOf(m.ticker, VOL_WINDOW);
        case 'yield': return annualYieldOf(m.ticker, m.sectorKo, m.assetClass);
        case 'cap': return -m.rank;      // 순위 1위가 «큰» 쪽이다
        default: return 0;
      }
    };
    const naLast = sortKey === 'yield';
    arr.sort((a, b) => {
      const va = valOf(a);
      const vb = valOf(b);
      if (naLast) {
        const az = va <= 0 ? 1 : 0;
        const bz = vb <= 0 ? 1 : 0;
        if (az !== bz) return az - bz;
      }
      if (va !== vb) return desc ? vb - va : va - vb;
      return a.rank - b.rank;            // 동점은 «순위»로 고정 — 순서가 흔들리지 않는다
    });
    return arr;
  }, [list, sortKey, desc, ko, s, q]);

  /* 광고가 «실제로 그려지는» 환경인가 — 아니면 자리도 잡지 않는다(빈 구멍 방지) */
  const adOn = adSlotVisible(STOCKS_BANNER_SLOTS[0]);

  const tierLabel = (k: string) => {
    const m = TICKERS.find((x) => x.tierKo === k);
    return ko ? k : m?.tierEn ?? k;
  };
  /*
   * ⛔★i18n 키를 «조립»하지 마라. 처음엔 접두사와 변수를 이어 붙여 썼는데
   *   `check_i18n_usage` 가 «정확히» 잡았다: 「코드가 쓰는 키가 locales 에 없다」.
   *   ⇒ 동적 조립은 검사기가 «볼 수 없다» — 죽은 검사기를 만드는 5형 중 하나다.
   *   ⇒ 리터럴로 적으면 키 7개가 «하나씩» 검사된다. 장황해도 그게 맞다.
   */
  const sortLabel = (k: SortKey) => {
    switch (k) {
      case 'change': return t('sort.change');
      case 'price': return t('sort.price');
      case 'volume': return t('sort.volume');
      case 'yield': return t('sort.yield');
      case 'cap': return t('sort.cap');
      case 'name': return t('sort.name');
      default: return t('sort.default');
    }
  };
  const sectorLabel = (k: string) => {
    const m = TICKERS.find((x) => x.sectorKo === k);
    return ko ? k : m?.sectorEn ?? k;
  };

  return (
    <div className="screen">
      <div className="appbar">
        {/* ★종목 수는 «데이터 길이»에서 센다. 상수보다도 정본에 가깝다 */}
        <span className="appbar__big">{t('stockCount', { n: TICKERS.length })}</span>
        <span style={{ marginLeft: 'auto' }}>
          <ConnBadge />
        </span>
      </div>

      <div style={{ padding: '0 20px 12px' }}>
        {/*
          ★[2026-08-22 어포던스 감사] 입력 «칸» 자체는 높이 22px 이었다 —
            WCAG 2.2 AA 의 웹 기준 24px 미만이고, 상자의 «패딩을 눌러도» 아무 일도 안 났다.
          ⇒ 상자를 누르면 입력으로 «들어가게» 한다. 그러면 탭 영역이 상자 전체(44px)가 된다.
          ⛔`cursor: pointer` 를 주지 마라 — 여기는 버튼이 아니라 «글 쓰는 자리»다.
            어포던스와 동작을 일치시키는 것이 이 감사의 목적이고, 그 답이 `text` 다.
        */}
        <div
          onClick={() => searchRef.current?.focus()}
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 14px',
            color: 'var(--t3)',
            cursor: 'text',
          }}
        >
          <span style={{ display: 'grid', placeItems: 'center' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
          </span>
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('common:search')}
            aria-label={t('common:search')}
            /* ★minHeight 24 — 입력 «칸» 자체도 웹 기준(24px)을 넘게 한다 */
            style={{ flex: 1, minHeight: 24, border: 0, outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--t1)' }}
          />
          {q && (
            <button className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => setQ('')} aria-label={t('common:close')}>
              {Icon.close}
            </button>
          )}
        </div>
      </div>

      <div className="pillrow" style={{ paddingBottom: 12 }}>
        <button className={`pill pill--ink ${chip === 'all' ? 'pill--on' : ''}`} onClick={() => setChip('all')}>
          {t('sectorAll')}
        </button>
        {/* ★보유가 있을 때만 뜬다. 0개일 때 뜨면 눌러도 빈 화면이라 그게 또 「이상한 탭」이 된다 */}
        {owned.size > 0 && (
          <button className={`pill pill--ink ${chip === 'own' ? 'pill--on' : ''}`} onClick={() => setChip('own')}>
            {t('sectorOwned', { n: owned.size })}
          </button>
        )}
        {/*
          ★주요 자산(지수·원자재·가상자산)을 «앞»에 둔다 — President 지적의 도달 경로다.
          ⛔새 분기를 만들지 않았다: 이 값들이 데이터의 `sectorKo` 그대로라 기존 판정이 통한다.
        */}
        {ASSET_CHIPS.map((k) => (
          <button key={k} className={`pill pill--ink ${chip === k ? 'pill--on' : ''}`} onClick={() => setChip(k)}>
            {sectorLabel(k)}
          </button>
        ))}
        {TIERS.map((k) => (
          <button key={k} className={`pill pill--ink ${chip === k ? 'pill--on' : ''}`} onClick={() => setChip(k)}>
            {tierLabel(k)}
          </button>
        ))}
        {/*
          ★시황에서 넘어온 업종이 «고정 칩 목록에 없을» 수 있다(고정 5개 · 실제 업종은 더 많다).
            그때 칩이 없으면 「필터가 걸렸는데 어디가 걸렸는지 안 보이는」 상태가 된다.
          ⇒ 그 업종 칩을 «맨 앞에» 임시로 하나 만들어 준다. 「· 시황」 꼬리표로 출처를 밝힌다.
        */}
        {chip !== 'all' && chip !== 'own' && !SECTORS.includes(chip as (typeof SECTORS)[number]) && !TIERS.includes(chip as (typeof TIERS)[number]) && (
          <button className="pill pill--ink pill--on" onClick={() => setChip('all')}>
            {t('sectorFromEvent', { s: sectorLabel(chip) })}
          </button>
        )}
        {SECTORS.map((k) => (
          <button key={k} className={`pill pill--ink ${chip === k ? 'pill--on' : ''}`} onClick={() => setChip(k)}>
            {sectorLabel(k)}
          </button>
        ))}
      </div>

      {/*
        ★정렬 줄 — 필터 칩과 «다른 줄»에 둔다. 둘은 직교하므로 같은 줄에 섞으면
          「무엇이 필터고 무엇이 정렬인지」가 사라진다.
        ★정렬 «상태»가 항상 보인다: 활성 칩이 채워지고 방향 삼각형이 붙는다.
          ⛔상태가 안 보이는 정렬은 정렬이 «없는 것»과 같다.
        ★방향 전환 = «활성 칩을 한 번 더» 누른다. 별도 버튼을 만들지 않았다
          (탭 타깃 하나로 끝나고, product 레지스터의 「표준 어포던스」에 맞는다).
        ⛔`기본`에는 방향이 없다 — 「주요자산 먼저 + 순위」라는 «하나의» 순서다.
        ★활성 표시를 필터 칩과 «같은» pill--ink 로 맞췄다.
          ⛔처음엔 pill--on 만 줘서 «분홍»으로 떴다 — 바로 윗줄 필터 칩의 활성(검정)과
            색이 달라, 같은 화면·같은 컴포넌트·같은 상태인데 다르게 보였다(실렌더로 발견).
          ★필터와 정렬의 구분은 «왼쪽 라벨」과 «방향 삼각형»이 이미 하고 있다. 색까지 갈라 놓을 이유가 없다.
      */}
      <div className="pillrow" style={{ paddingTop: 0, paddingBottom: 12 }}>
        <span
          style={{ flex: '0 0 auto', alignSelf: 'center', marginRight: 2, fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}
        >
          {t('sortLabel')}
        </span>
        {SORT_KEYS.map((k) => {
          const on = sortKey === k;
          return (
            <button
              key={k}
              className={`pill pill--ink ${on ? 'pill--on' : ''}`}
              onClick={() => pickSort(k)}
              aria-pressed={on}
            >
              {sortLabel(k)}
              {on && k !== 'default' && (
                <span aria-hidden style={{ marginLeft: 3, fontSize: 10 }}>{desc ? '▼' : '▲'}</span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        광고는 «첫 화면»이 아니라 12번째 종목 뒤에 들어가고, 그 뒤로 STOCKS_AD_EVERY 행마다
        ★«가진 지면 수만큼» 반복된다(President 2026-08-21 「스크롤 내릴 때마다 노출」).
        ★리스트 카드(--surface)와 달리 배경(--bg) 위에 점선으로 그려 «다른 재질»로
          보이게 한다 — 종목 행처럼 보이면 오탭이 곧 주문 화면 진입이 된다.
        ★높이를 미리 넘겨줘야 가상 스크롤 좌표가 안 어긋난다(스크롤 점프 방지).
        ★★그리고 «그려질 때만» 자리를 잡는다 — 토스 밖에서는 배너가 아예 안 그려지므로
          예전 코드는 목록 한가운데에 ★156px 짜리 빈 구멍을 남기고 있었다(실측으로 발견).
      */}
      <VirtualList
        className="scroll"
        style={{ padding: '0 20px' }}
        items={sorted}
        insert={adOn ? (n) => <AdBanner slot={STOCKS_BANNER_SLOTS[n]} style={{ margin: '10px 0' }} /> : undefined}
        insertAt={adOn ? STOCKS_AD_EVERY : undefined}
        insertEvery={STOCKS_AD_EVERY}
        insertMax={STOCKS_BANNER_SLOTS.length}
        /* ★위와 같다 — 실렌더 점유(159)를 유도한다. `stocksAdReservedH()` 는
           «지면마다 높이가 다르면 소리내어 알리는» 가드라 그대로 통과시킨다. */
        insertHeight={adBlockH(stocksAdReservedH(), 10)}
        itemHeight={63}
        renderItem={(m, i) => (
          <div key={m.ticker} style={{ background: 'var(--surface)', borderLeft: '1px solid var(--line)', borderRight: '1px solid var(--line)', ...(i === 0 ? { borderTop: '1px solid var(--line)', borderRadius: '18px 18px 0 0' } : {}), ...(i === sorted.length - 1 ? { borderBottom: '1px solid var(--line)', borderRadius: '0 0 18px 18px' } : {}) }}>
            {i > 0 && <div className="divider divider--inset" />}
            <StockRow ticker={m.ticker} />
          </div>
        )}
      />
      {sorted.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontSize: 15 }}>{t('common:empty')}</div>
      )}
    </div>
  );
}
