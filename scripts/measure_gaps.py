# -*- coding: utf-8 -*-
"""
화면 «수직 간격»을 실렌더에서 «잰다» — ★headless 전용. 일관성 작업의 증거표.

  ML_DIST=dist python scripts/measure_gaps.py [ko|en]

⛔⛔★이 도구의 «한계» — 다음 사람이 이 표를 «전수»로 믿지 않게 (규율 Y)
  ★이 도구는 `.scroll` 의 «직계 자식 사이» 간격만 잰다 = ★margin 기반 간격만 보인다.
  ⛔대부분의 간격은 자식 «안쪽» padding 이라 여기서 ★0 으로 나온다.
    [실측] 5개 화면에서 0px 이 7회 나왔는데 그건 «간격이 없다»가 아니라 «내가 못 본다»다.
  ⇒ ★「0px」을 「붙어 있다」로 읽지 마라. «미측정»이다.

  ★전수 표를 만들려면 무엇이 필요한가 (담당자에게):
    ① 모든 요소의 getComputedStyle 로 padding/margin 을 훑고
    ② 「블록 경계」를 무엇으로 볼지 정의해야 한다(카드? 섹션? 텍스트 그룹?)
       — ★이 정의가 어려운 지점이다. 정의 없이 훑으면 3,000개 값이 쏟아지고 판단이 안 된다
    ③ 그리고 «시각적으로 인접한» 쌍만 남기는 필터가 필요하다(형제이면서 세로로 겹치지 않는 쌍)
  ⇒ 현재는 ①만 있고 ②③이 없다. 그래서 이 도구는 «리듬 확인»에만 쓴다.

⛔소스의 px 값을 «읽어서» 표를 만들지 마라 — 실제 화면 간격은 margin 상쇄·border·
  sticky 때문에 소스 값과 «다르다». 브라우저에게 «그려진 좌표»를 물어야 한다.
★블록 사이 간격 = 다음 블록 top − 이전 블록 bottom (getBoundingClientRect).
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

INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
        "})()")

# ★화면의 «최상위 블록»들을 훑어 사이 간격을 잰다
GAPS = """() => {
  const sc = document.querySelector('.scroll') || document.body;
  const kids = [...sc.children].filter((e) => e.getBoundingClientRect().height > 0);
  const out = [];
  for (let i = 0; i < kids.length - 1; i++) {
    const a = kids[i].getBoundingClientRect();
    const b = kids[i + 1].getBoundingClientRect();
    out.push({
      from: (kids[i].className || kids[i].tagName).toString().slice(0, 28),
      to: (kids[i + 1].className || kids[i + 1].tagName).toString().slice(0, 28),
      gap: Math.round((b.top - a.bottom) * 10) / 10,
    });
  }
  return out;
}"""

# ★카드 «내부 패딩» — 근접성 사다리(위 < 내부 < 아래)를 판정하려면 필요하다
CARDPAD = """() => {
  const out = [];
  document.querySelectorAll('.card').forEach((c) => {
    const cs = getComputedStyle(c);
    out.push({ cls: c.className.slice(0, 24), pt: cs.paddingTop, pb: cs.paddingBottom, pl: cs.paddingLeft });
  });
  return out.slice(0, 6);
}"""

SCREENS = [('home', '#/home'), ('stocks', '#/stocks'), ('rank', '#/rank'),
           ('deriv', '#/derivatives'), ('me', '#/me')]


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    lang = sys.argv[1] if len(sys.argv) > 1 else 'ko'
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    rep = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844},
                                     locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx.add_init_script(INIT % lang)
                p = ctx.new_page()
                p.goto(base + '#/home', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=120000)
                p.wait_for_selector('.boot', state='detached', timeout=180000)
                p.wait_for_timeout(2200)
                for name, route in SCREENS:
                    p.goto(base + ('?%s%s' % (name, route)), wait_until='domcontentloaded')
                    p.wait_for_selector('.screen', timeout=120000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(1800)
                    rep[name] = {'gaps': p.evaluate(GAPS), 'cards': p.evaluate(CARDPAD)}
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    allg = []
    print('=== 화면별 «블록 사이» 실측 간격 (px, 실렌더) ===')
    for name, d in rep.items():
        gs = [g['gap'] for g in d['gaps'] if g['gap'] >= 0]
        allg += gs
        print('  %-7s %s' % (name, gs))
    uniq = {}
    for g in allg:
        uniq[g] = uniq.get(g, 0) + 1
    print('')
    print('=== 전 화면 간격 «값 분포» ===')
    for k in sorted(uniq):
        print('   %6.1fpx -> %d회' % (k, uniq[k]))
    off = [k for k in uniq if abs(k - round(k / 4) * 4) > 0.6 and k > 0]
    print('   ★4배수 이탈: %s (총 %d종 중)' % (sorted(off), len(uniq)))
    out = ROOT / '_shots' / ('gaps_%s.json' % lang)
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print('   -> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
