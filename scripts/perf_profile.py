# -*- coding: utf-8 -*-
"""
렌더 성능 프로파일 — ★headless 전용(창 0). President 실기기 판정 「iOS 프레임 수 떨어짐」(08-30 03:10) 대리 계측.

  ML_DIST=dist/web python scripts/perf_profile.py <라벨> [출력폴더] [초=60]

★대리 조건: Chromium headless · CPU 4× 스로틀(CDP Emulation.setCPUThrottlingRate) · 뷰포트 390×844 · DPR 3 · 모바일 터치.
★화면 4종(홈·종목·파생·랭킹) 각 N초. 그 사이 5초마다 한 번 스크롤(300px 아래↔위) — 실사용의 «틱 + 스크롤» 조합.
★재는 것
  ① 프레임타임: requestAnimationFrame 간격(ms) p50/p95/p99 · 33ms 초과(=30fps 미만) 비율 · 100ms 초과 수
  ② Long Task(>50ms): PerformanceObserver('longtask') 수·합·최대
  ③ React 커밋 수: __REACT_DEVTOOLS_GLOBAL_HOOK__ 을 «페이지 로드 전에» 심어 onCommitFiberRoot 를 센다(번들 무접촉).
  ④ (짧은 2차 패스) 커밋당 «실제로 다시 그린 함수 컴포넌트 수»: 파이버 트리를 걸어 alternate 와 props/state 가 다른 것만 센다.
     ⛔이 걷기는 비싸서 ①②와 «분리»해 15초만 돈다 — 같은 패스에 섞으면 프레임타임을 스스로 오염시킨다.
★BEFORE 는 라이브(-21) 산출물(dist/web 그대로)로, AFTER 는 새 빌드로 «같은 스크립트»를 돌린다. 숫자는 «상대 비교»용이다(실기기 절대값이 아니다).
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
HOLD = ['VZ', 'NVDA', 'KO', 'AAPL', 'MSFT']
SCREENS = [('home', '#/home'), ('stocks', '?s#/stocks'), ('deriv', '?d#/derivatives'), ('rank', '?r#/rank')]
# ★ML_PERF_SCREENS=home,rank 처럼 일부만 — A/B 를 화면 단위로 «교대» 실행할 때(환경 부하 드리프트 상쇄)
if os.environ.get('ML_PERF_SCREENS'):
    _want = set(os.environ['ML_PERF_SCREENS'].split(','))
    SCREENS = [x for x in SCREENS if x[0] in _want]


def init_save():
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
            "localStorage.setItem('ml.game', %s);sessionStorage.setItem('ads.preview','1');})()" % json.dumps(json.dumps(save)))


HOOK = """(() => {
  const perf = { on: false, walk: false, commits: 0, rerenders: 0, frames: [], long: [], _raf: 0, _last: 0 };
  window.__perf = perf;
  const hook = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(id, root) {
      if (!perf.on) return;
      perf.commits++;
      if (!perf.walk || !root || !root.current) return;
      let n = 0, seen = 0; const stack = []; let f = root.current.child;
      while (f && seen < 60000) {
        seen++;
        const a = f.alternate;
        if (typeof f.type === 'function' && (!a || a.memoizedProps !== f.memoizedProps || a.memoizedState !== f.memoizedState)) n++;
        if (f.child) { stack.push(f); f = f.child; continue; }
        while (f && !f.sibling) f = stack.pop();
        if (f) f = f.sibling;
      }
      perf.rerenders += n;
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: false, writable: false });
  try {
    new PerformanceObserver((l) => { if (perf.on) for (const e of l.getEntries()) perf.long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false });
  } catch (e) {}
  perf.start = (walk) => {
    perf.on = true; perf.walk = !!walk; perf.commits = 0; perf.rerenders = 0; perf.frames = []; perf.long = []; perf._last = performance.now();
    const tick = (t) => { perf.frames.push(t - perf._last); perf._last = t; perf._raf = requestAnimationFrame(tick); };
    perf._raf = requestAnimationFrame(tick);
  };
  perf.stop = () => {
    perf.on = false; cancelAnimationFrame(perf._raf);
    const fr = perf.frames.slice(1).sort((a, b) => a - b);
    const q = (p) => fr.length ? Math.round(fr[Math.min(fr.length - 1, Math.floor(fr.length * p))] * 10) / 10 : null;
    return {
      frames: fr.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: fr.length ? Math.round(fr[fr.length - 1]) : null,
      over33: fr.filter((x) => x > 33.4).length, over100: fr.filter((x) => x > 100).length,
      longN: perf.long.length, longSum: perf.long.reduce((a, b) => a + b, 0), longMax: perf.long.length ? Math.max(...perf.long) : 0,
      commits: perf.commits, rerenders: perf.rerenders,
    };
  };
})()"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(2500)


def run_pass(p, secs, walk):
    p.evaluate('() => window.__perf.start(%s)' % ('true' if walk else 'false'))
    elapsed = 0.0
    down = True
    while elapsed < secs:
        p.wait_for_timeout(5000)
        elapsed += 5.0
        try:
            p.mouse.move(195, 500)
            p.mouse.wheel(0, 300 if down else -300)
        except Exception:
            pass
        down = not down
    return p.evaluate('() => window.__perf.stop()')


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260830_perf'
    secs = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
    out.mkdir(parents=True, exist_ok=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    res = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                for name, route in SCREENS:
                    ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=float(os.environ.get('ML_PERF_DPR', '3')), is_mobile=True, has_touch=True, locale='ko-KR')
                    ctx.add_init_script(init_save())
                    ctx.add_init_script(HOOK)
                    p = ctx.new_page()
                    cdp = ctx.new_cdp_session(p)
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
                    errs = []
                    p.on('pageerror', lambda e: errs.append(str(e)))
                    boot(p, base, route)
                    hooked = p.evaluate('() => window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size')
                    r1 = run_pass(p, secs, False)
                    r2 = run_pass(p, 15, True)
                    r1['walk15s_commits'] = r2['commits']
                    r1['walk15s_rerenders'] = r2['rerenders']
                    r1['rerendersPerCommit'] = round(r2['rerenders'] / r2['commits'], 1) if r2['commits'] else None
                    r1['reactHooked'] = hooked
                    r1['errors'] = errs[:3]
                    res[name] = r1
                    print('  %-6s frames=%d p50=%s p95=%s p99=%s max=%s >33ms=%d >100ms=%d | long n=%d sum=%dms max=%dms | commits/%.0fs=%d | rerender/commit=%s (15s: %d/%d) hooked=%s err=%d'
                          % (name, r1['frames'], r1['p50'], r1['p95'], r1['p99'], r1['max'], r1['over33'], r1['over100'], r1['longN'], r1['longSum'], r1['longMax'], secs, r1['commits'], r1['rerendersPerCommit'], r2['rerenders'], r2['commits'], hooked, len(errs)))
                    ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_perf.json' % label)).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    print('saved', out / ('%s_perf.json' % label))
    return 0


if __name__ == '__main__':
    sys.exit(main())
