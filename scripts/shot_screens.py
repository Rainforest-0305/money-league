# -*- coding: utf-8 -*-
"""
화면 스크린샷 캡처 — ★headless 전용. 전/후 대조용.

  ML_DIST=dist/web python scripts/shot_screens.py <출력폴더> <라벨> [ko|en]

⛔President 화면을 점유하지 않는다: headless 만 쓴다. 창을 띄우지 않는다.
★「적용했다」가 아니라 «전후 실렌더»가 산출물이다(Partner 지시).
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
VIEW = {'width': 390, 'height': 844}

# 보유가 있어야 「보유」 칩·포트폴리오 화면이 정상 상태로 뜬다
HOLD = ['VZ', 'NVDA', 'KO']


def init(lang):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {
            'cash': 250000.0,
            'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
            'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
            'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0,
            'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0,
        },
        'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0},
        'prices': {},
    }
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
        "localStorage.setItem('ml.game', %s);"
        "})()" % (lang, json.dumps(json.dumps(save)))
    )


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


SHOTS = [
    ('home', '#/home', None),
    ('stocks_top', '#/stocks', None),
    ('stocks_bottom', '#/stocks', 'bottom'),
    ('rank', '#/rank', None),
    ('deriv', '#/derivatives', None),
    ('me', '#/me', None),
]


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_shots')
    label = sys.argv[2] if len(sys.argv) > 2 else 'x'
    lang = sys.argv[3] if len(sys.argv) > 3 else 'ko'
    out.mkdir(parents=True, exist_ok=True)

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    errs = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport=VIEW, device_scale_factor=2,
                                     locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx.add_init_script(init(lang))
                p = ctx.new_page()
                p.on('pageerror', lambda e: errs.append(str(e)))
                p.goto(base + '#/home', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=120000)
                p.wait_for_selector('.boot', state='detached', timeout=180000)
                p.wait_for_timeout(2500)
                for name, route, mode in SHOTS:
                    p.goto(base + ('?%s%s' % (name, route)), wait_until='domcontentloaded')
                    p.wait_for_selector('.tabbar, .screen', timeout=120000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(2200)
                    if mode == 'bottom':
                        # ★맨 아래로 — 「주요 자산이 하단에 깔려 있다」를 보이게
                        p.evaluate("""() => { const e = document.querySelector('.scroll');
                                              if (e) e.scrollTop = e.scrollHeight; }""")
                        p.wait_for_timeout(1200)
                    f = out / ('%s_%s_%s.png' % (label, lang, name))
                    p.screenshot(path=str(f))
                    print('  %s' % f.name)
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    print('pageerror %d건 %s' % (len(errs), errs[:2] if errs else ''))
    return 1 if errs else 0


if __name__ == '__main__':
    sys.exit(main())
