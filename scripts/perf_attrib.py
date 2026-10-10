# -*- coding: utf-8 -*-
"""
함수 단위 시간 귀속 — ★headless 전용. V8 샘플링 프로파일러(CDP Profiler) 로 self-time 상위 함수를 뽑는다.
  ML_DIST=dist_prof python scripts/perf_attrib.py <라벨> <화면 route> [초=30] [출력폴더]
★압축 안 한 빌드(`AIT_BUILD=1 npx vite build --minify false --outDir dist_prof`)에 붙여야 함수 이름이 남는다.
★CPU 4× 스로틀 · 390×844 · 5초마다 스크롤 — perf_profile.py 와 같은 조건.
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
from collections import defaultdict
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
WANT = ['advance', 'computeLeaderboard', 'syncFromWorld', 'pump', 'flushRanks', 'leaderboard', 'renderRootSync',
        'performWorkOnRoot', 'commitRoot', 'performConcurrentWorkOnRoot', 'workLoopSync', 'PriceText', 'StockRow',
        'Home', 'Stocks', 'Leaderboard', 'RankRow', 'Sparkline', 'AreaChart', 'equity', 'quote', 'series', 'bumpPrice',
        'bump', 'bumpTick', 'flushSync', 'flushPassiveEffects', 'step', 'PositionCard', 'Derivatives', 'VirtualList',
        'commitRootImpl', 'beginWork', 'completeWork', 'updateFunctionComponent', 'renderWithHooks', 'publicPortfolio',
        'rotateSnapshots', 'investedBase', 'portfolio', 'dailyStatus', 'feed', 'macro', 'bots', 'Bot']


def init_save():
    save = {'v': 1, 'savedAt': 0, 'tick': 0,
            'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                        'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                        'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
            'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {}}
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
            "localStorage.setItem('ml.game', %s);sessionStorage.setItem('ads.preview','1');})()" % json.dumps(json.dumps(save)))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def key_of(cf):
    return '%s (%s:%s)' % (cf['functionName'] or '(anon)', Path(cf['url']).name, cf['lineNumber'])


def main():
    label = sys.argv[1]
    route = sys.argv[2]
    secs = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
    out = Path(sys.argv[4]) if len(sys.argv) > 4 else ROOT / '_verify_20260830_perf'
    out.mkdir(parents=True, exist_ok=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, locale='ko-KR')
            ctx.add_init_script(init_save())
            p = ctx.new_page()
            cdp = ctx.new_cdp_session(p)
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
            p.goto(base + route, wait_until='domcontentloaded')
            p.wait_for_selector('.screen', timeout=120000)
            p.wait_for_selector('.boot', state='detached', timeout=180000)
            p.wait_for_timeout(2500)
            cdp.send('Profiler.enable')
            cdp.send('Profiler.setSamplingInterval', {'interval': 500})
            cdp.send('Profiler.start')
            el = 0.0
            down = True
            while el < secs:
                p.wait_for_timeout(5000)
                el += 5
                try:
                    p.mouse.move(195, 500)
                    p.mouse.wheel(0, 300 if down else -300)
                except Exception:
                    pass
                down = not down
            prof = cdp.send('Profiler.stop')['profile']
            br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    nodes = {n['id']: n for n in prof['nodes']}
    parent = {}
    for n in prof['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    deltas = prof.get('timeDeltas', [])
    selfus = defaultdict(int)
    for i, sid in enumerate(prof['samples']):
        selfus[sid] += deltas[i] if i < len(deltas) else 0
    total = sum(selfus.values()) or 1
    by_self = defaultdict(int)
    by_total = defaultdict(int)
    for sid, us in selfus.items():
        by_self[key_of(nodes[sid]['callFrame'])] += us
        seen = set()
        cur = sid
        while cur is not None:
            k2 = key_of(nodes[cur]['callFrame'])
            if k2 not in seen:
                by_total[k2] += us
                seen.add(k2)
            cur = parent.get(cur)
    lines = ['== %s %s %ss  total sampled %.1fs' % (label, route, secs, total / 1e6), '-- SELF time top 28 --']
    for k, us in sorted(by_self.items(), key=lambda kv: -kv[1])[:28]:
        lines.append('  %6.1f%%  %7.0fms  %s' % (100 * us / total, us / 1000, k))
    lines.append('-- TOTAL(inclusive) time: 관심 함수 (>0.3%) --')
    for k, us in sorted(by_total.items(), key=lambda kv: -kv[1]):
        fn = k.split(' (')[0]
        if any(fn == w or fn.startswith(w) for w in WANT) and us / total > 0.003:
            lines.append('  %6.1f%%  %7.0fms  %s' % (100 * us / total, us / 1000, k))
    txt = '\n'.join(lines)
    print(txt)
    name = route.strip('#?/').replace('/', '_').replace('#', '') or 'home'
    (out / ('%s_attrib_%s.txt' % (label, name))).write_text(txt, encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
