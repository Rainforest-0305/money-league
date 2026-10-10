# -*- coding: utf-8 -*-
"""
[1회성 · 2026-08-30] iOS 프레임 저하 대응 — UI 쪽 «렌더 팬아웃·10k 객체 복사·PriceText 3중 렌더·비합성 페인트» 수정.
  엔진(lib/engine/*)·규칙(constants/promoRules)·프로모션 훅·광고 지면 «무접촉». 각 치환은 정확히 1건 매치를 강제한다.
  근거: _verify_20260830_perf/BEFORE_live21_perf.json · BEFORE_attrib_*.txt (JS 4% · 랭킹 Long Task 9건/분 · 리렌더/커밋 170).
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent


def rd(p):
    return (ROOT / p).read_text(encoding='utf-8')


def wr(p, s):
    (ROOT / p).write_text(s, encoding='utf-8', newline='')


def sub1(s, a, b, label):
    n = s.count(a)
    if n != 1:
        raise SystemExit('FAIL %s: expected 1 match got %d for %r' % (label, n, a[:70]))
    return s.replace(a, b)


# ── R2 store.ts flushRanks: 10,000행 spread 복사 → in-place delta ─────────────────
p = 'src/store/store.ts'
s = rd(p)
s = sub1(
    s,
    "    this.ranks = all.map((r) => {\n"
    "      const prev = this.prevRankById.get(r.accountId);\n"
    "      return { ...r, delta: prev === undefined ? 0 : prev - r.rank };\n"
    "    });\n",
    "    /*\n"
    "     * ★[성능 2026-08-30 · iOS 프레임 저하 대응] 10,000행을 spread 로 «복사»하던 것을 in-place 로 바꿨다.\n"
    "     *   `all` 은 엔진이 «이 호출을 위해 새로 만든» 배열·객체다(world.computeLeaderboard 가 매번 rows 를 새로 push)\n"
    "     *   → 여기서 delta 를 써 넣어도 다른 참조가 없다. 4초마다 10k 객체 할당 + GC 압박이 사라진다.\n"
    "     *   ⛔prevRankById 갱신은 «아래» 루프다 — delta 는 갱신 «전» 값으로 계산해야 한다(순서 유지).\n"
    "     */\n"
    "    for (const r of all) {\n"
    "      const prev = this.prevRankById.get(r.accountId);\n"
    "      r.delta = prev === undefined ? 0 : prev - r.rank;\n"
    "    }\n"
    "    this.ranks = all;\n",
    'store flushRanks',
)
wr(p, s)

# ── R1 Leaderboard.tsx: rows 10k 복사 제거 · me/near memo ────────────────────────
p = 'src/screens/Leaderboard.tsx'
s = rd(p)
s = sub1(
    s,
    "  const rows = useMemo(() => {\n"
    "    const sorted = [...s.ranks];\n"
    "    if (sort === 'return') sorted.sort((a, b) => b.pnlPct - a.pnlPct);\n"
    "    return sorted.map((r, i) => ({ ...r, rank: sort === 'equity' ? r.rank : i + 1 }));\n"
    "  }, [s.ranks, sort]);\n",
    "  const rows = useMemo(() => {\n"
    "    /* ★[성능 2026-08-30] 자산순은 스토어 배열 «그대로» 쓴다(rank 가 이미 맞다) — 10,000행 복사 + spread 를 없앤다.\n"
    "       수익률순만 정렬본을 만든다(순위 번호 = 정렬 뒤 자리). ⛔rows 를 어디서도 «변형»하지 않는다(읽기 전용). */\n"
    "    if (sort === 'equity') return s.ranks;\n"
    "    const sorted = [...s.ranks].sort((a, b) => b.pnlPct - a.pnlPct);\n"
    "    return sorted.map((r, i) => ({ ...r, rank: i + 1 }));\n"
    "  }, [s.ranks, sort]);\n",
    'lb rows',
)
s = sub1(
    s,
    "  const me = rows.find((r) => r.accountId === meId) ?? null;\n"
    "  const meIdx = me ? rows.findIndex((r) => r.accountId === meId) : -1;\n"
    "  const near = meIdx >= 0 ? rows.slice(Math.max(0, meIdx - 2), meIdx + 3) : [];\n",
    "  /* ★[성능 2026-08-30] 스토어는 매 틱 bump 하므로 이 화면은 2초마다 렌더된다 — 10,000행 find/findIndex 2회를\n"
    "     «틱마다» 돌리지 않고 rows 가 바뀔 때(≈4초)만 돈다. */\n"
    "  const { me, meIdx, near } = useMemo(() => {\n"
    "    const i = rows.findIndex((r) => r.accountId === meId);\n"
    "    return { me: i >= 0 ? rows[i] : null, meIdx: i, near: i >= 0 ? rows.slice(Math.max(0, i - 2), i + 3) : [] };\n"
    "  }, [rows, meId]);\n",
    'lb me/near',
)
wr(p, s)

# ── R4 PriceText: 렌더 3→1 · 타이머 0 · 플래시는 의사요소 opacity(WAAPI) ─────────
p = 'src/components/Primitives.tsx'
s = rd(p)
s = sub1(
    s,
    "  const prev = useRef(value);\n"
    "  const [flash, setFlash] = useState<'up' | 'down' | null>(null);\n"
    "\n"
    "  useEffect(() => {\n"
    "    if (value > prev.current) setFlash('up');\n"
    "    else if (value < prev.current) setFlash('down');\n"
    "    prev.current = value;\n"
    "    const id = window.setTimeout(() => setFlash(null), FLASH_MS);\n"
    "    return () => window.clearTimeout(id);\n"
    "  }, [value]);\n"
    "\n"
    "  return (\n"
    "    <span\n"
    "      className={`num tick-flash ${flash === 'up' ? 'is-up' : flash === 'down' ? 'is-down' : ''} ${className}`}\n"
    "      style={style}\n"
    "    >\n"
    "      {render(value)}\n"
    "    </span>\n"
    "  );\n",
    "  const prev = useRef(value);\n"
    "  const ref = useRef<HTMLSpanElement>(null);\n"
    "\n"
    "  /*\n"
    "   * ★[성능 2026-08-30 · iOS 프레임 저하 대응] 예전엔 flash 가 «state»였다 — 값 변경 렌더 + setFlash 렌더 + 220ms 뒤\n"
    "   *   setFlash(null) 렌더 = 인스턴스당 «틱마다 3회 렌더 + 타이머 1개». 종목 화면은 화면 안 행 ≈26개라 2초마다\n"
    "   *   78회 렌더 + 26개 타이머였다. 지금은 «값 변경 렌더 1회»뿐이고, 플래시는 React 밖에서 WAAPI 로 돈다:\n"
    "   *     의사요소(::after, 합성 가능한 opacity 1→0) 를 애니메이션 — 레이아웃·리플로우 0, background-color 페인트 0.\n"
    "   *   ⛔`el.offsetWidth` 로 애니메이션을 재시작하지 않는다 — 행마다 강제 리플로우가 난다. WAAPI 는 재시작이 공짜다.\n"
    "   *   `pseudoElement` 미지원 웹뷰면 요소 자체 background-color 로 폴백(예전과 같은 모양, 렌더 수는 그대로 1회).\n"
    "   */\n"
    "  useEffect(() => {\n"
    "    const el = ref.current;\n"
    "    const d = value > prev.current ? 'up' : value < prev.current ? 'down' : null;\n"
    "    prev.current = value;\n"
    "    if (!el || !d || typeof el.animate !== 'function') return;\n"
    "    el.dataset.dir = d;\n"
    "    try {\n"
    "      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out', pseudoElement: '::after' });\n"
    "    } catch {\n"
    "      el.animate(\n"
    "        [{ backgroundColor: d === 'up' ? 'var(--up-weak)' : 'var(--down-weak)' }, { backgroundColor: 'transparent' }],\n"
    "        { duration: FLASH_MS, easing: 'ease-out' }\n"
    "      );\n"
    "    }\n"
    "  }, [value]);\n"
    "\n"
    "  return (\n"
    "    <span ref={ref} className={`num tick-flash ${className}`} style={style}>\n"
    "      {render(value)}\n"
    "    </span>\n"
    "  );\n",
    'PriceText',
)
wr(p, s)

# ── R5 StockRow memo ─────────────────────────────────────────────────────────────
p = 'src/components/StockRow.tsx'
s = rd(p)
s = sub1(s, "import { useNavigate } from 'react-router-dom';\n", "import { memo } from 'react';\nimport { useNavigate } from 'react-router-dom';\n", 'row import')
s = sub1(
    s,
    " * useQuote 로 해당 종목만 구독하므로 100행 리스트에서 행 하나만 리렌더된다.\n */\nexport function StockRow({\n",
    " * useQuote 로 해당 종목만 구독하므로 100행 리스트에서 행 하나만 리렌더된다.\n"
    " * ★[성능 2026-08-30] memo — 부모(종목 화면·홈)가 매 틱 리렌더돼도 props 가 같으면 행은 «자기 시세 구독»으로만 다시 그린다.\n"
    " *   ⛔props 에 매 렌더 새 객체(inline 화살표·새 배열)를 주면 memo 가 무력화된다 — 홈 보유 행의 sparkline 은 틱마다 새 값이라 그 행만 예외.\n"
    " */\n"
    "export const StockRow = memo(function StockRow({\n",
    'row memo head',
)
s = sub1(
    s,
    "    </button>\n  );\n}\n\nexport function sharesLabel",
    "    </button>\n  );\n});\n\nexport function sharesLabel",
    'row memo tail',
)
wr(p, s)

# ── CSS: tick-flash 의사요소 · 랭킹 행 content-visibility ──────────────────────────
p = 'src/styles/app.css'
s = rd(p)
s = sub1(
    s,
    "/* 가격 틱 플래시 — 숫자 위치 이동 없음(ui_spec 1.5) */\n"
    ".tick-flash {\n"
    "  border-radius: 6px;\n"
    "  padding: 0 3px;\n"
    "  margin: 0 -3px;\n"
    "  transition: background-color 220ms ease-out;\n"
    "  background: transparent;\n"
    "}\n"
    ".tick-flash.is-up {\n"
    "  background: var(--up-weak);\n"
    "}\n"
    ".tick-flash.is-down {\n"
    "  background: var(--down-weak);\n"
    "}\n",
    "/* 가격 틱 플래시 — 숫자 위치 이동 없음(ui_spec 1.5)\n"
    "   ★[성능 2026-08-30] background-color 트랜지션(페인트) → 의사요소 opacity(합성). 색은 data-dir 로 고르고\n"
    "     opacity 애니메이션은 PriceText 가 WAAPI 로 돌린다(React 렌더·타이머 0). 텍스트 «뒤»에 깔리도록\n"
    "     isolation 으로 스택 컨텍스트를 만들고 z-index:-1 — 모양은 예전 background 과 같다. */\n"
    ".tick-flash {\n"
    "  position: relative;\n"
    "  isolation: isolate;\n"
    "  border-radius: 6px;\n"
    "  padding: 0 3px;\n"
    "  margin: 0 -3px;\n"
    "  background: transparent;\n"
    "}\n"
    ".tick-flash::after {\n"
    "  content: '';\n"
    "  position: absolute;\n"
    "  inset: 0;\n"
    "  z-index: -1;\n"
    "  border-radius: 6px;\n"
    "  opacity: 0;\n"
    "  pointer-events: none;\n"
    "}\n"
    ".tick-flash[data-dir='up']::after {\n"
    "  background: var(--up-weak);\n"
    "}\n"
    ".tick-flash[data-dir='down']::after {\n"
    "  background: var(--down-weak);\n"
    "}\n",
    'css tick-flash',
)
s = sub1(
    s,
    ".rkwrap {\n  display: flex;\n  align-items: center;\n}\n",
    ".rkwrap {\n"
    "  display: flex;\n"
    "  align-items: center;\n"
    "  /* ★[성능 2026-08-30] 탑100 행 97개가 «전부» DOM 에 있다(가상화 없음). 화면 밖 행은 렌더를 건너뛰게 한다 —\n"
    "     iOS 18+/Chrome 지원, 미지원이면 무시된다. 크기는 실측 행 높이(≈66px)로 예약해 스크롤바가 튀지 않게 한다. */\n"
    "  content-visibility: auto;\n"
    "  contain-intrinsic-size: auto 66px;\n"
    "}\n",
    'css rkwrap',
)
wr(p, s)
print('perf patch applied')
