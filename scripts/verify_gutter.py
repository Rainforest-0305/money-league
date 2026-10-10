# -*- coding: utf-8 -*-
"""
거터 정합 — 본문과 하단 CTA 의 «좌우 끝이 맞는가». ★headless 전용.

  ML_DIST=dist python scripts/verify_gutter.py [라벨]

★President 지적(「간격·UI 일관성」)의 측정 가능한 조각 중 하나.
  Recharge·Onboarding 은 본문 .scroll 이 22px, 하단 .cta 는 --gutter(20px) 였다
  ⇒ ★전폭 버튼이 본문 카드보다 «2px 씩» 삐져나왔다.
⛔소스의 px 를 읽어 판정하지 «마라» — 실제 좌표를 브라우저에게 물어야 한다.
"""
import http.server
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
INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "})()")

EDGES = """() => {
  const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect(); return { l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; };
  /* .cta 안의 «실제 버튼» 이 본문 카드와 맞아야 한다 */
  const cta = document.querySelector('.cta button, .cta .btn, .cta > *');
  const card = document.querySelector('.scroll .card, .scroll > div');
  const g = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
    return { l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; };
  return { appbar: pick('.appbar'), scroll: pick('.scroll'), card: g(card), cta: g(cta) };
}"""

SCREENS = [('recharge', '#/recharge'), ('home', '#/home'), ('stocks', '#/stocks')]


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
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
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(INIT)
                p = ctx.new_page()
                p.goto(base + '#/home', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=120000)
                p.wait_for_selector('.boot', state='detached', timeout=180000)
                p.wait_for_timeout(2200)
                print('[%s] 화면별 좌우 끝(px) — 본문 vs 하단 CTA' % label)
                for name, route in SCREENS:
                    p.goto(base + ('?%s%s' % (name, route)), wait_until='domcontentloaded')
                    p.wait_for_selector('.screen', timeout=120000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(1600)
                    e = p.evaluate(EDGES)
                    ab = e.get('appbar')
                    cd = e.get('card')
                    ct = e.get('cta')
                    line = '  %-9s' % name
                    if ab:
                        line += ' 앱바 L%.0f' % ab['l']
                    if cd:
                        line += ' · 본문 L%.0f R%.0f' % (cd['l'], cd['r'])
                    if ct:
                        line += ' · CTA L%.0f R%.0f' % (ct['l'], ct['r'])
                    if cd and ct:
                        dl = ct['l'] - cd['l']
                        dr = cd['r'] - ct['r']
                        line += '  ⇒ ★어긋남 L%+.0f R%+.0f' % (dl, dr)
                    print(line)
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
