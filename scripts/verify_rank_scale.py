# -*- coding: utf-8 -*-
"""
랭킹 화면이 «명부 10,000명»에서 버티는가 — ★headless + 폰 대용 스로틀.

  python scripts/verify_rank_scale.py [cpu_rate]

★코드 실측으로 먼저 좁힌 것 (그래서 이 검사가 «작다»):
  Leaderboard.tsx 는 `rows.slice(3, LEADERBOARD_SIZE)` 로 **4~100위만** 그리고,
  「내 주변」은 `rows.slice(meIdx-2, meIdx+3)` 로 **5행**이다.
  ⇒ ★그리는 행 수가 명부 크기와 «무관»하다. 10,000행 스크롤 같은 건 «없다».
  ⇒ 명부에 비례하는 비용은 «엔진» 쪽 `computeLeaderboard` 뿐이고
    그건 rankbench 로 따로 쟀다(10,001계정 4.49ms · 4초마다).

⇒ 그래서 여기서는 «화면이 실제로 뜨고 · 만져지고 · 안 죽는가»만 본다.
  ⛔「빠르다」를 화면으로 증명하려 하지 마라 — 그건 위 두 실측이 할 일이다.
"""
import http.server
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
# ★ML_DIST 경로 함정을 «검사기가 스스로» 잡게 한다 (scripts/_distguard.py 참조).
#   ⛔ait 빌드 뒤엔 웹이 dist/web 으로 «옮겨진다». 모르면 「.tabbar 못 찾음」으로 죽는다.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "})()")


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    cpu = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []

    def check(name, ok, detail=''):
        print('  %s  %s  %s' % ('PASS' if ok else '★FAIL', name, detail))
        if not ok:
            fails.append(name)

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
            ctx.add_init_script(INIT)
            p = ctx.new_page()
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            cdp = ctx.new_cdp_session(p)
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': cpu})

            p.goto(base + '#/home', wait_until='domcontentloaded')
            p.wait_for_selector('.tabbar', timeout=180000)
            p.wait_for_selector('.boot', state='detached', timeout=180000)
            p.wait_for_timeout(2500)

            t0 = time.perf_counter()
            p.goto(base + '#/rank', wait_until='domcontentloaded')
            p.wait_for_timeout(2500)
            open_ms = (time.perf_counter() - t0) * 1000

            rows = p.evaluate("""() => document.querySelectorAll('.lbrow, .lrow, [class*="row"]').length""")
            body = p.evaluate("""() => document.body.innerText || ''""")
            p.screenshot(path=str(ROOT / '_verify_dividend_ui' / ('20_rank_cpu%d.png' % cpu)))
            check('랭킹 화면이 «뜬다»', len(body) > 200, '본문 %d자 · 행 유사요소 %d개 · 여는 데 %.0fms' % (len(body), rows, open_ms))

            # ★스크롤 반응 — 프레임을 먹으면 여기서 스크롤 위치가 «안 변한다»
            sc = p.evaluate("""() => {
              const el = document.querySelector('.scroll') || document.scrollingElement;
              if (!el) return null;
              const before = el.scrollTop;
              el.scrollTop = before + 1200;
              return { before, after: el.scrollTop, max: el.scrollHeight - el.clientHeight };
            }""")
            p.wait_for_timeout(900)
            check('스크롤이 «움직인다»', bool(sc) and sc['after'] > sc['before'],
                  '%s' % sc)

            # ★「내 주변」 — 내 순위가 100위 밖이면 near 는 «빈 배열»이 정상이다(코드 실측).
            #   ⇒ 그 사실을 «확인»만 한다. 없다고 실패로 세지 않는다.
            has_me = ('리미' in body)
            print('  (참고) 「내 주변」 구간: 내 닉네임 노출 %s — 100위 밖이면 안 뜨는 것이 정상' % has_me)

            check('pageerror 0', len(errs) == 0, str(errs[:2]))
            br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print('\n⇒ %s (CPU 스로틀 x%d · 명부 10,000)' % ('★랭킹 화면 이상 없음' if not fails else '★실패 %d건' % len(fails), cpu))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
