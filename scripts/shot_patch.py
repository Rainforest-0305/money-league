# -*- coding: utf-8 -*-
"""
대형 패치(정렬·중앙은행·시즌·홈 충전·간격) 전/후 실렌더 — ★headless 전용.

  ML_DIST=dist/web python scripts/shot_patch.py <출력폴더> <라벨> [ko|en] [폭]

★같은 시드(ml.seed=20260829)·393x852·dpr2 로 찍는다. 전후를 «같은 조건»에서 대조하려는 것이다.
★찍는 화면: 홈 · 랭킹 · 파생 피커(열린 상태) · 피커 검색 "S&P" · 시즌 마감 게이트(AFTER 만) ·
  중앙은행 시트(AFTER 만). BEFORE 빌드에는 없는 화면은 «건너뛴다»(없는 걸 실패로 세지 않는다).
⛔President 화면을 점유하지 않는다: headless 만 쓴다.
"""
import http.server
import json
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
HOLD = ['VZ', 'NVDA', 'KO']


def init(lang, season_end=None):
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
    js = (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.seed','20260829');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
        "localStorage.setItem('ml.game', %s);"
        "sessionStorage.setItem('ads.preview','1');"
    ) % (lang, json.dumps(json.dumps(save)))
    if season_end is not None:
        js += "localStorage.setItem('ml.season', JSON.stringify(%s));" % json.dumps(season_end)
    return js + "})()"


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(2200)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_shots')
    label = sys.argv[2] if len(sys.argv) > 2 else 'x'
    lang = sys.argv[3] if len(sys.argv) > 3 else 'ko'
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 393
    out.mkdir(parents=True, exist_ok=True)

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    errs = []
    facts = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': width, 'height': 852}, device_scale_factor=2,
                                     locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx.add_init_script(init(lang))
                p = ctx.new_page()
                p.on('pageerror', lambda e: errs.append(str(e)))

                def shot(name):
                    f = out / ('%s_%s_%d_%s.png' % (label, lang, width, name))
                    p.screenshot(path=str(f))
                    print('  %s' % f.name)

                boot(p, base, '#/home')
                shot('home')

                boot(p, base, '?r#/rank')
                shot('rank')
                # 중앙은행 카드가 있으면 연다(AFTER 전용)
                cb = p.locator('.cbcard')
                if cb.count() > 0:
                    cb.first.click()
                    p.wait_for_timeout(600)
                    shot('rank_cbsheet')
                    facts['cbsheet'] = p.locator('.sheet').inner_text()
                    p.keyboard.press('Escape')
                    p.wait_for_timeout(300)

                boot(p, base, '?d#/derivatives')
                p.locator('.derivcta button').first.click()
                p.wait_for_timeout(700)
                shot('deriv_picker')
                rows = p.evaluate("""() => [...document.querySelectorAll('.sheet .row .row__sub')].map(e => e.textContent.trim().split('·')[0].trim())""")
                facts['picker_top'] = rows[:8]
                p.locator('.sheet input').fill('S&P')
                p.wait_for_timeout(500)
                shot('deriv_picker_search')
                rows = p.evaluate("""() => [...document.querySelectorAll('.sheet .row .row__sub')].map(e => e.textContent.trim().split('·')[0].trim())""")
                facts['picker_search_SP'] = rows[:6]

                # 시즌 마감 게이트 (AFTER 전용): endAt 을 과거로 심고 다시 부팅
                ctx2 = br.new_context(viewport={'width': width, 'height': 852}, device_scale_factor=2,
                                      locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx2.add_init_script(init(lang, {'endAt': 1000, 'n': 1, 'extended': 0}))
                p2 = ctx2.new_page()
                p2.on('pageerror', lambda e: errs.append(str(e)))
                p2.goto(base + '?g#/home', wait_until='domcontentloaded')
                p2.wait_for_selector('.screen', timeout=120000)
                p2.wait_for_selector('.boot', state='detached', timeout=180000)
                p2.wait_for_timeout(2200)
                if p2.locator('.seasongate').count() > 0:
                    f = out / ('%s_%s_%d_seasongate.png' % (label, lang, width))
                    p2.screenshot(path=str(f))
                    print('  %s' % f.name)
                    facts['seasongate'] = p2.locator('.seasongate').inner_text()
                ctx2.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_%s_%d_facts.json' % (label, lang, width))).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('  facts: %s' % json.dumps(facts, ensure_ascii=False)[:600])
    print('pageerror %d건 %s' % (len(errs), errs[:2] if errs else ''))
    return 1 if errs else 0


if __name__ == '__main__':
    sys.exit(main())
