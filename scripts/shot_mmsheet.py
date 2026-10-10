# -*- coding: utf-8 -*-
"""마켓 메이커(LP) 카드·시트 실렌더 스크린샷 + 잘림/넘침 계측 — 375/430 × ko/en (headless 전용).
  ML_DIST=dist/web python scripts/shot_mmsheet.py <출력폴더>
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
FILLS = ("[{id:3,at:1756500000000,sid:1756499000000,tick:300,gameDay:2,ticker:'SPX',side:'sell',notional:1460000,price:5100,basisBefore:0.0122,basketSide:'buy',basketNotional:3500000,basketPrice:5094},"
         "{id:2,at:1756499900000,sid:1756499000000,tick:250,gameDay:1,ticker:'NDX',side:'buy',notional:800000,price:18000,basisBefore:-0.0011,basketSide:'sell',basketNotional:2430000,basketPrice:18020}]")


def init(lang):
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260830');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
            "localStorage.setItem('ml.cbfills', JSON.stringify({v:1,total:2,fills:%s}));sessionStorage.setItem('ads.preview','1');})()" % (lang, FILLS))


OVER = """() => {
  const bad = [];
  document.querySelectorAll('.cbcard__nm, .cbcard__sub, #cb-title, .cbleg, .cbsession, .sheet .num').forEach((e) => {
    const r = e.getBoundingClientRect(); if (!r.width) return;
    const cs = getComputedStyle(e); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); const lines = (r.height - pad) / lh; const over = e.scrollWidth > e.clientWidth + 1; const out = r.right > window.innerWidth + 0.5;
    if (lines >= 1.6 || over || out) bad.push({ cls: (e.className || e.id || '').toString().slice(0, 24), text: (e.textContent || '').trim().slice(0, 30), lines: Math.round(lines * 10) / 10, over, out });
  });
  return bad;
}"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_20260831_cbarb')
    out.mkdir(parents=True, exist_ok=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = 0
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            for lang in ('ko', 'en'):
                for w in (375, 430):
                    ctx = br.new_context(viewport={'width': w, 'height': 844}, locale='ko-KR' if lang == 'ko' else 'en-US')
                    ctx.add_init_script(init(lang))
                    p = ctx.new_page()
                    p.goto(base + '?r#/rank', wait_until='domcontentloaded')
                    p.wait_for_selector('.screen', timeout=120000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(1800)
                    card = p.locator('.cbcard').first
                    card.scroll_into_view_if_needed()
                    p.wait_for_timeout(300)
                    bad = p.evaluate(OVER)
                    p.screenshot(path=str(out / ('MM_%s_%d_card.png' % (lang, w))), clip={'x': 0, 'y': max(0, card.bounding_box()['y'] - 40), 'width': w, 'height': 160})
                    card.click()
                    p.wait_for_timeout(700)
                    bad += p.evaluate(OVER)
                    p.screenshot(path=str(out / ('MM_%s_%d_sheet.png' % (lang, w))))
                    title = p.locator('#cb-title').first.inner_text()
                    legs = p.locator('.sheet .cbleg').all_inner_texts()
                    print('  %s  %s/%d  제목=%r  다리=%s  넘침/줄바꿈=%s' % ('PASS' if not bad else '★FAIL', lang, w, title, legs[:4], json.dumps(bad, ensure_ascii=False)[:160]))
                    fails += 1 if bad else 0
                    ctx.close()
            br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    print('\n마켓 메이커 표기 결함 %d건' % fails)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
