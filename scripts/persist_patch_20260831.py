# -*- coding: utf-8 -*-
"""
[1회성 · 2026-08-31 · -23] 세션을 넘는 기록 — ① 프라이밍 키 확장 ② 자산 흐름 영속 ③ 중앙은행 체결 원장 ④ 경계 마커.
  ⛔엔진(lib/engine/*)·프로모션 훅·광고 지면 무접촉. 각 치환은 정확히 1건 매치를 강제한다.
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


# ── ① toss/storage.ts 프라이밍 키 ─────────────────────────────────────────────
p = 'src/toss/storage.ts'
s = rd(p)
s = sub1(
    s,
    "export const APP_STORAGE_KEYS = [\n  'ml.session',\n  'ml.settings',\n  'ml.watchlist',\n  'ml.onboarded',\n  'ml.game',\n] as const;\n",
    "export const APP_STORAGE_KEYS = [\n"
    "  'ml.session',\n  'ml.settings',\n  'ml.watchlist',\n  'ml.onboarded',\n  'ml.game',\n"
    "  /*\n"
    "   * ★[2026-08-31 · -23] 미러는 쓰면서 «되살리지는 않던» 키들 — iOS ITP 7일/웹뷰 데이터 초기화 뒤 현금은 돌아오는데\n"
    "   *   일지·출석·시즌·관심·호가세션은 «빈 상태»로 시작하던 갭(L6 진단). 전부 lsSet 으로 미러에 쓰이던 키다.\n"
    "   *   원칙은 그대로 «없는 키만» 역주입 — 정상 재진입(localStorage 살아 있음)에는 아무 영향이 없다.\n"
    "   * ※ 'ml.firstSeen'(엔진 roster.ts 가 raw localStorage 로 씀 · 미러 없음)과 'ml.promo.*'(프로모션 훅 · 무접촉)는 제외.\n"
    "   */\n"
    "  'ml.journal',\n  'ml.attendance',\n  'ml.season',\n  'ml.traderwatch',\n  'ml.quotesession',\n  'ml.equity',\n  'ml.cbfills',\n"
    "] as const;\n",
    'storage keys',
)
wr(p, s)

# ── types.ts: 체결 보기에 세션 필드(선택) ───────────────────────────────────────
p = 'src/lib/types.ts'
s = rd(p)
s = sub1(
    s,
    "  /** 개입 «직전» 괴리(비율, + 프리미엄 / − 디스카운트) */\n  basisBefore: number;\n}\n\nexport interface CentralBankSpreadView {",
    "  /** 개입 «직전» 괴리(비율, + 프리미엄 / − 디스카운트) */\n  basisBefore: number;\n"
    "  /** ★[-23] 스토어 원장이 붙이는 세션 정보(엔진 값에는 없다) — 체결 벽시계(ms) · 세션 id(부팅 시각) */\n"
    "  at?: number;\n  sid?: number;\n}\n\nexport interface CentralBankSpreadView {",
    'types fill view',
)
wr(p, s)

# ── store.ts ─────────────────────────────────────────────────────────────────
p = 'src/store/store.ts'
s = rd(p)
s = sub1(s, "import { lsSet, lsRemove } from '../toss/storage';\n", "import { lsSet, lsRemove } from '../toss/storage';\nimport { CbLedger, EquityHistory } from './history';\n", 'store import')
s = sub1(
    s,
    "  portfolio: Portfolio | null = null;\n  equityHistory: number[] = [];\n",
    "  portfolio: Portfolio | null = null;\n"
    "  /*\n"
    "   * ★[-23 2026-08-31] 자산 흐름·중앙은행 체결은 «세션을 넘어» 이어진다(store/history.ts).\n"
    "   *   `equityHistory`/`equityMarks` 는 화면 호환용 getter — 배열 참조는 push 마다 같은 객체다(차트 memo 는 길이·값으로 판단).\n"
    "   */\n"
    "  readonly equity = new EquityHistory();\n"
    "  readonly cbLedger = new CbLedger();\n"
    "  get equityHistory(): number[] {\n    return this.equity.pts;\n  }\n"
    "  get equityMarks(): number[] {\n    return this.equity.marks;\n  }\n",
    'store fields',
)
s = sub1(
    s,
    "    this.booting = false;\n    this.emitBoot();\n    this.syncFromWorld(true);\n    this.startLoop();\n",
    "    this.booting = false;\n    this.emitBoot();\n"
    "    /* ★[-23] 저장된 자산 흐름이 있으면 «여기부터 새 세션» — 첫 syncFromWorld 의 push 가 새 세션의 첫 점이 된다 */\n"
    "    this.equity.startSession();\n"
    "    this.syncFromWorld(true);\n    this.startLoop();\n",
    'store boot',
)
s = sub1(
    s,
    "    } else {\n      this.world.save();\n      /* ★모아 쓰기(setTimeout 0)가 밀린 채로 탭을 내리면 그대로 유실이다 */\n      this.journal.flush();\n    }\n  };\n\n  private onPageHide = (): void => {\n    this.world.save();\n    this.journal.flush();\n  };\n",
    "    } else {\n      this.world.save();\n      /* ★모아 쓰기(setTimeout 0)가 밀린 채로 탭을 내리면 그대로 유실이다 */\n      this.journal.flush();\n      this.equity.flush(this.tick);\n    }\n  };\n\n  private onPageHide = (): void => {\n    this.world.save();\n    this.journal.flush();\n    this.equity.flush(this.tick);\n  };\n",
    'store hidden flush',
)
s = sub1(
    s,
    "    this.portfolio = this.world.portfolio();\n    this.pushEquity(this.portfolio.equity);\n",
    "    this.portfolio = this.world.portfolio();\n    this.pushEquity(this.portfolio.equity);\n"
    "    /* ★[-23] 세이브 블롭과 같은 박자(15틱)로 자산 흐름을 쓴다 · 중앙은행 세션 링버퍼에서 새 체결을 흡수한다(엔진 무접촉) */\n"
    "    if (this.tick % SNAPSHOT_EVERY_TICKS === 0) this.equity.flush(this.tick);\n"
    "    this.cbLedger.absorb(this.world.world.centralBank.fills);\n",
    'store sync',
)
s = sub1(
    s,
    "  private pushEquity(v: number): void {\n    this.equityHistory.push(v);\n    if (this.equityHistory.length > EQUITY_HISTORY_LEN) this.equityHistory.shift();\n  }\n",
    "  private pushEquity(v: number): void {\n    this.equity.push(v);\n  }\n",
    'store pushEquity',
)
s = sub1(
    s,
    "  /** ★중앙은행 보기(순위표 시트). 엔진 값을 그대로 흘린다 */\n  centralBankView(): CentralBankView {\n    return this.world.centralBankView();\n  }\n",
    "  /**\n"
    "   * ★중앙은행 보기(순위표 시트). 괴리·포지션은 엔진 값 그대로, ★체결·개입 횟수는 «세션을 넘는 원장»(store/history.ts) 이다 —\n"
    "   *   엔진 링버퍼는 세션마다 비지만 원장은 최근 100건과 누적 횟수를 들고 있다(President 08-30 「중앙은행 거래 기록 초기화」 대응).\n"
    "   */\n"
    "  centralBankView(): CentralBankView {\n"
    "    const v = this.world.centralBankView();\n"
    "    return { ...v, fills: this.cbLedger.fills.slice(0, 20), interventions: this.cbLedger.total };\n  }\n",
    'store cb view',
)
# 시즌 초기화·로그아웃: 그래프·원장도 처음부터
s = sub1(
    s,
    "    this.journal.clear();\n    this.equityHistory = [];\n    this.season = newSeasonState(this.season);\n",
    "    this.journal.clear();\n    this.equity.reset();\n    this.cbLedger.reset();\n    this.season = newSeasonState(this.season);\n",
    'store season reset',
)
s = sub1(
    s,
    "    this.world.resetPlayer();\n    this.equityHistory = [];\n    this.syncFromWorld(true);\n",
    "    this.world.resetPlayer();\n    this.equity.reset();\n    this.cbLedger.reset();\n    this.syncFromWorld(true);\n",
    'store logout reset',
)
wr(p, s)

# ── Charts.tsx AreaChart: marks(세션 경계 점선) ──────────────────────────────────
p = 'src/components/Charts.tsx'
s = rd(p)
s = sub1(
    s,
    "  maShort?: (number | null)[];\n  maLong?: (number | null)[];\n}) {\n  const gid = useId().replace(/:/g, '');\n",
    "  maShort?: (number | null)[];\n  maLong?: (number | null)[];\n"
    "  /**\n"
    "   * ★[-23] «세션 경계» — 이 인덱스의 점부터 새 접속이다. 그 «앞» 틈에 세로 점선을 세운다.\n"
    "   *   이어붙인 그래프의 점프/평평 구간을 버그로 안 보이게 하는 표지. 값 자체는 손대지 않는다.\n"
    "   */\n"
    "  marks?: number[];\n"
    "}) {\n  const gid = useId().replace(/:/g, '');\n",
    'chart prop',
)
s = sub1(
    s,
    "      {showBaseline && (\n        <line x1=\"0\" y1={baseY} x2={W} y2={baseY} stroke=\"var(--t3)\" strokeDasharray=\"3 5\" opacity=\"0.35\" />\n      )}\n      <path d={area} fill={`url(#${gid})`} />\n",
    "      {showBaseline && (\n        <line x1=\"0\" y1={baseY} x2={W} y2={baseY} stroke=\"var(--t3)\" strokeDasharray=\"3 5\" opacity=\"0.35\" />\n      )}\n"
    "      {marks &&\n"
    "        marks.map((m) =>\n"
    "          m > 0 && m < data.length ? (\n"
    "            <line\n"
    "              key={m}\n"
    "              x1={((m - 0.5) * W) / (data.length - 1)}\n"
    "              y1=\"0\"\n"
    "              x2={((m - 0.5) * W) / (data.length - 1)}\n"
    "              y2={height}\n"
    "              stroke=\"var(--t3)\"\n"
    "              strokeWidth=\"1.2\"\n"
    "              strokeDasharray=\"3 4\"\n"
    "              opacity=\"0.6\"\n"
    "              vectorEffect=\"non-scaling-stroke\"\n"
    "            />\n"
    "          ) : null\n"
    "        )}\n"
    "      <path d={area} fill={`url(#${gid})`} />\n",
    'chart marks',
)
wr(p, s)

# ── Home.tsx: 마커 전달 + 캡션 ───────────────────────────────────────────────────
p = 'src/screens/Home.tsx'
s = rd(p)
s = sub1(
    s,
    "            <AreaChart data={s.equityHistory.length > 1 ? s.equityHistory : [base, equity]} height={96} showBaseline={false} />\n          </div>\n",
    "            <AreaChart data={s.equityHistory.length > 1 ? s.equityHistory : [base, equity]} height={96} showBaseline={false} marks={s.equityMarks} />\n"
    "            {/* ★[-23] 세션을 넘어 이어진 그래프 — 점선이 뜬 뒤에만 그 뜻을 한 줄 말한다(없으면 소음) */}\n"
    "            {s.equityMarks.length > 0 && s.equityHistory.length > 1 && (\n"
    "              <p className=\"hint\" style={{ margin: '8px 18px 0', fontSize: 11, color: 'var(--t3)' }}>\n"
    "                {t('assetFlowSeam')}\n"
    "              </p>\n"
    "            )}\n"
    "          </div>\n",
    'home chart',
)
wr(p, s)

# ── Leaderboard.tsx: 중앙은행 시트 세션 헤더 ───────────────────────────────────────
p = 'src/screens/Leaderboard.tsx'
s = rd(p)
s = sub1(
    s,
    "        <div className=\"card card--sub\" style={{ padding: '2px 16px' }}>\n          {v.fills.slice(0, 8).map((f, i) => (\n            <div key={f.id}>\n              {i > 0 && <div className=\"divider\" />}\n",
    "        <div className=\"card card--sub\" style={{ padding: '2px 16px' }}>\n"
    "          {v.fills.slice(0, 8).map((f, i, arr) => (\n"
    "            <div key={`${f.sid ?? 0}-${f.id}`}>\n"
    "              {/* ★[-23] 세션이 바뀌는 자리에 «접속 시각» 헤더 — 세션을 넘어 이어진 기록임을 화면이 말한다 */}\n"
    "              {f.sid !== undefined && (i === 0 || arr[i - 1].sid !== f.sid) && (\n"
    "                <div className=\"cbsession num\">{t('cbSession', { d: fmtSession(f.sid, ko) })}</div>\n"
    "              )}\n"
    "              {i > 0 && arr[i - 1].sid === f.sid && <div className=\"divider\" />}\n",
    'lb cb session header',
)
s = sub1(
    s,
    "/** 중앙은행 시트 — 소개 3문장 · 지수 괴리 · 포지션 · 최근 체결. ⛔자산 총액·순위 없음 */\nfunction CentralBankSheet(",
    "/** 세션 헤더용 «날짜·시각» — 로케일 규칙(Intl)로만 만든다. 문자열에 숫자를 박지 않는다 */\n"
    "function fmtSession(ms: number, ko: boolean): string {\n"
    "  return new Intl.DateTimeFormat(ko ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));\n"
    "}\n\n"
    "/** 중앙은행 시트 — 소개 3문장 · 지수 괴리 · 포지션 · 최근 체결(세션을 넘어 · 접속 시각 헤더). ⛔자산 총액·순위 없음 */\nfunction CentralBankSheet(",
    'lb fmtSession',
)
wr(p, s)

# ── CSS: 세션 헤더 ────────────────────────────────────────────────────────────────
p = 'src/styles/app.css'
s = rd(p)
s = sub1(
    s,
    ".cbcard {\n",
    "/* ★[-23] 중앙은행 시트 «접속 시각» 헤더 — 체결 행 사이의 세션 경계. 메타 위계(11px 600 --t3), 대비는 --t3 on --surface-2(기존 힌트와 동일) */\n"
    ".cbsession {\n  padding: 10px 0 4px;\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--t3);\n  letter-spacing: 0.02em;\n}\n"
    ".cbsession + .kv {\n  border-top: 0;\n}\n\n.cbcard {\n",
    'css cbsession',
)
wr(p, s)

# ── locales ──────────────────────────────────────────────────────────────────────
p = 'src/locales/ko.json'
s = rd(p)
s = sub1(s, '    "assetFlowSub": "게임 {{d}}일치 · {{s}}초마다 갱신",\n', '    "assetFlowSub": "게임 {{d}}일치 · {{s}}초마다 갱신",\n    "assetFlowSeam": "점선은 이전 접속과의 경계예요. 나갔다 들어와도 흐름이 이어져요",\n', 'ko home')
s = sub1(s, '    "cbFills": "최근 체결",\n', '    "cbFills": "최근 체결",\n    "cbSession": "{{d}} 접속",\n', 'ko rank')
wr(p, s)
p = 'src/locales/en.json'
s = rd(p)
s = sub1(s, '    "assetFlowSub": "{{d}} game days · updates every {{s}}s",\n', '    "assetFlowSub": "{{d}} game days · updates every {{s}}s",\n    "assetFlowSeam": "Dotted lines mark earlier visits. Your history carries over when you come back",\n', 'en home')
s = sub1(s, '    "cbFills": "Recent fills",\n', '    "cbFills": "Recent fills",\n    "cbSession": "Session {{d}}",\n', 'en rank')
wr(p, s)
print('persist patch applied')
