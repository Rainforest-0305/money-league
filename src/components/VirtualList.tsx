import { useMemo, useState, type ReactNode, type UIEvent } from 'react';

/**
 * 고정 행 높이 가상 스크롤.
 * 종목 100개 / 랭킹 211행을 전부 DOM 에 올리지 않는다(ui_spec 6장).
 * 위·아래 스페이서 divs 로 스크롤 길이를 유지해 스크롤바가 튀지 않는다.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 6,
  height,
  renderItem,
  className,
  style,
  onScroll,
  insert,
  insertAt,
  insertHeight,
  insertEvery,
  insertMax = 1,
}: {
  items: T[];
  itemHeight: number;
  overscan?: number;
  /** 뷰포트 높이를 모를 때는 생략 — 기본 800px 기준으로 계산 */
  height?: number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  /**
   * 리스트 «중간»에 끼울 블록(광고 지면).
   * ★함수를 주면 «몇 번째 삽입인지»(0부터)를 받는다 — 반복 삽입에서 지면 ID 를 갈아 끼우는 데 쓴다.
   * ★ 높이(insertHeight)를 «반드시» 함께 준다 — 가상 스크롤은 좌표를 계산으로
   *   구하므로, 높이를 모르는 요소가 끼면 스크롤 위치가 통째로 어긋난다.
   *   이게 광고에서 흔한 「스크롤 점프」의 정체다.
   */
  insert?: ReactNode | ((n: number) => ReactNode);
  insertAt?: number;
  insertHeight?: number;
  /**
   * ★반복 간격(행 수). 미지정/0 이면 `insertAt` 한 곳에만 넣는다(기존 동작).
   * ⛔간격을 «추측»으로 정하지 마라 — 호출부가 「한 화면 높이 이상」에서 «계산»해 넘긴다.
   */
  insertEvery?: number;
  /**
   * ★반복 «최대 개수». 기본 1.
   *
   * ★★왜 무한 반복이 아닌가 [2026-08-21 문서 조회]: 앱인토스 광고 정책이
   *   「동일 화면에 동일 포맷 광고를 2개 이상 배치하는 행위는 금지」이고,
   *   구글 AdMob 도 「지면마다 «고유한» 광고 단위 ID 를 만들라」고 안내한다.
   *   ⇒ 반복 횟수는 «가진 지면 ID 수»에 묶여야 한다. 이 인자가 그 묶는 자리다.
   *   ⛔여기 큰 수를 박고 같은 지면 ID 를 재사용하지 마라.
   */
  insertMax?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(height ?? 800);

  const base = insert != null && insertAt != null ? Math.max(0, insertAt) : -1;
  const insH = base >= 0 ? (insertHeight ?? 0) : 0;

  /** 삽입이 들어가는 행 인덱스 목록(오름차순). ★개수는 insertMax 로 «닫혀 있다» */
  const spots = useMemo(() => {
    if (base < 0) return [];
    const every = insertEvery && insertEvery > 0 ? insertEvery : 0;
    const max = Math.max(1, insertMax);
    const out: number[] = [base];
    if (every > 0) {
      for (let k = 1; k < max; k++) {
        const p = base + k * every;
        /* 목록보다 뒤면 그릴 자리가 없다 — 꼬리 하나만 남기고 멈춘다 */
        if (p > items.length) break;
        out.push(p);
      }
    }
    return out;
  }, [base, insertEvery, insertMax, items.length]);

  /** 인덱스 i «앞»까지 들어간 삽입 개수 */
  const shift = (i: number) => {
    let n = 0;
    for (const p of spots) if (p <= i) n++;
    return n;
  };
  /** 인덱스 i 행의 상단 y */
  const yOf = (i: number) => i * itemHeight + shift(i) * insH;
  /**
   * y 좌표에 놓인 행 인덱스. ★이분탐색이다 —
   * 삽입이 여러 개면 «닫힌 식»이 없다(구간마다 오프셋이 다르다).
   * ⛔예전의 단일 삽입용 산식을 그대로 두면 두 번째 삽입부터 좌표가 어긋난다.
   */
  const idxAt = (y: number) => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (yOf(mid) <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  };

  const start = Math.max(0, idxAt(scrollTop) - overscan);
  const end = Math.min(items.length, idxAt(scrollTop + viewport) + 1 + overscan);
  const padTop = yOf(start);
  const padBottom = Math.max(0, yOf(items.length) - yOf(end));

  const renderInsert = (n: number) => (typeof insert === 'function' ? (insert as (n: number) => ReactNode)(n) : insert);

  return (
    <div
      className={className}
      style={style}
      ref={(el) => {
        if (el && el.clientHeight && el.clientHeight !== viewport) setViewport(el.clientHeight);
      }}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop);
        onScroll?.(e);
      }}
    >
      <div style={{ height: padTop }} />
      {items.slice(start, end).map((it, i) => {
        const idx = start + i;
        const spot = spots.indexOf(idx);
        return (
          <div key={idx} style={{ display: 'contents' }}>
            {spot >= 0 && renderInsert(spot)}
            {renderItem(it, idx)}
          </div>
        );
      })}
      {/* 목록 끝을 넘어선 삽입 자리는 «맨 뒤»에 그린다(항목이 적을 때) */}
      {spots.map((p, n) => (p >= items.length ? <div key={`tail${n}`}>{renderInsert(n)}</div> : null))}
      <div style={{ height: padBottom }} />
    </div>
  );
}
