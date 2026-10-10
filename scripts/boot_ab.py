# -*- coding: utf-8 -*-
"""
부팅 시간 A/B — `STARTING_EXTRA_BOTS` 790 vs 9790 (B안). ★headless 전용.

  python scripts/boot_ab.py <A_dist> <B_dist> [pairs]

══════════════════════════════════════════════════════════════════════════
★측정 설계 — 왜 이렇게 하나
══════════════════════════════════════════════════════════════════════════
⛔①**이전 세션의 절대값과 비교하지 마라**(규율 L). 기계 상태가 다르면 절대값이 통째로 movable 하다.
  ⇒ ★같은 실행 안에서 A 와 B 를 «둘 다» 잰다.
⛔②**한쪽을 몰아서 재지 마라**(규율 J). 브라우저·OS 가 시간에 따라 더워지고 느려진다.
  ⇒ ★**ABBA 교대**로 짠다. 선형 드리프트가 A 와 B 에 «같은 양»으로 실려 상쇄된다.
    (단순 ABAB 는 A 가 항상 «앞»이라 드리프트가 A 쪽으로 치우친다)
⛔③**저장본이 있는 상태로 재지 마라.** President 가 말한 건 「처음 들어온 유저」다.
  ⇒ ★매 회 «새 컨텍스트»를 만든다. localStorage 가 비어 있다 = ml.game 없음 = 명부를
    처음부터 만드는 «가장 비싼» 경로다.
  ★단 `ml.onboarded` 만 심는다 — 온보딩 화면에서 멈추면 두 빌드 «둘 다» 못 재기 때문이다.
    이건 A·B 에 «똑같이» 적용되므로 비교를 왜곡하지 않는다.

★「부팅 완료」의 정의 = `.boot` 오버레이가 «DOM 에서 사라지는» 순간.
  BootOverlay 는 `store.booting` 이 false 가 되면 `return null` 이다(BootOverlay.tsx:27).
  ⇒ 워밍업이 실제로 끝난 시점이고, ★유저가 기다림을 «끝냈다»고 느끼는 바로 그 시점이다.
"""
import http.server
import socket
import socketserver
import statistics
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

INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "})()")

# ══════════════════════════════════════════════════════════════════════════
# ⛔☠️★[2026-08-23 무효 측정 1건 — 기록해 둔다]
#   처음엔 `wait_for_selector('.boot', state='detached')` 로 쟀다. ★그건 «즉시 참»이다.
#   `wait_until='commit'` 직후엔 문서가 비어 있어서 `.boot` 가 «존재한 적이 없고»,
#   detached 는 「없음」도 만족시킨다. ⇒ 0.2초라는 «가짜 부팅시간»이 나왔다(실제는 초 단위).
#   ★내가 주석에 「너무 빨리 끝나면 못 볼 수도 있다」고 «위험을 적어 놓고» 그냥 넘어갔다.
#   ⇒ 교훈: **「기다림」이 «아무것도 안 기다리고» 통과할 수 있는지 먼저 물어라.**
#     그리고 ★「봤다」를 «별도 플래그»로 남겨 검사하라(아래 __bootSeen).
# ⇒ 페이지 «안»에 관측자를 심어 «떴다»와 «사라졌다»를 둘 다 기록한다.
#   init script 는 문서 스크립트보다 «먼저» 돌므로 첫 페인트를 놓치지 않는다.
#   `performance.now()` 는 그 문서의 «내비게이션 시작» 기준이라 그대로 부팅시간이다.
# ══════════════════════════════════════════════════════════════════════════
#   ⛔☠️★[무효 측정 2건째] 다음엔 `MutationObserver(...).observe(document.documentElement, …)`
#     로 고쳤는데 ★그것도 안 됐다(180초 타임아웃). init script 는 document_start 에 도는데
#     그 시점 `document.documentElement` 가 없으면 observe 가 «던지고», 그러면 PROBE 전체가
#     죽어 `__bootGoneAt` 이 영원히 -1 이다. ★스크립트가 죽은 걸 「앱이 안 끝났다」로 읽었다.
#   ⇒ ★**DOM 참조를 «잡지 않는» 인터벌 폴링**으로 간다. 던질 데가 없다.
#     [실측 진단] `.boot` 은 198ms 에 뜨고 1,248ms 에 사라진다. `.tabbar` 는 198ms 에 이미 있다
#     ⇒ ★그래서 «`.tabbar` 를 기다리는 건 부팅 측정이 아니다»(첫 측정 0.2s 의 정체가 이것).
PROBE = """(() => {
  window.__bootSeen = false;
  window.__bootSeenAt = -1;
  window.__bootGoneAt = -1;
  const id = setInterval(() => {
    if (document.querySelector('.boot')) {
      if (!window.__bootSeen) { window.__bootSeen = true; window.__bootSeenAt = performance.now(); }
      return;
    }
    if (window.__bootSeen && window.__bootGoneAt < 0) {
      window.__bootGoneAt = performance.now();
      clearInterval(id);
    }
  }, 8);
})()"""


def serve(root):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, 'http://127.0.0.1:%d/' % port


def boot_once(browser, url, cpu=1):
    """★새 컨텍스트 = 빈 localStorage = «신규 유저 첫 실행».
    cpu>1 이면 ★폰 대용 CPU 스로틀(CDP). ⛔실기기가 아니다 — «대용»이라고 말하라."""
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    ctx.add_init_script(INIT)
    ctx.add_init_script(PROBE)
    p = ctx.new_page()
    try:
        if cpu > 1:
            cdp = ctx.new_cdp_session(p)
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': cpu})
        t0 = time.perf_counter()
        p.goto(url + '#/home', wait_until='commit')
        p.wait_for_function('() => window.__bootGoneAt >= 0', timeout=180000)
        p.wait_for_selector('.tabbar', timeout=180000)
        wall = time.perf_counter() - t0
        r = p.evaluate('() => ({ seen: window.__bootSeen, at: window.__bootSeenAt, gone: window.__bootGoneAt })')
        # ★「봤다」가 «아니면» 그 회차는 측정이 «아니다». 조용히 0 을 섞지 마라.
        if not r['seen']:
            raise RuntimeError('.boot 을 «한 번도 못 봤다» — 측정 무효')
        return r['gone'] / 1000.0, wall
    finally:
        ctx.close()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
    pairs = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    cpu = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    for d in (a_dir, b_dir):
        if not (d / 'index.html').exists():
            print('[FAIL] dist 가 없다: %s' % d)
            return 1

    sa, ua = serve(a_dir)
    sb, ub = serve(b_dir)
    A, B = [], []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # 예열 1회 — ⛔첫 회차는 «브라우저·서버·JIT» 비용이 섞인다. 버린다.
                boot_once(br, ua, cpu)
                boot_once(br, ub, cpu)
                print('  (예열 2회 폐기)')
                for i in range(pairs):
                    # ★ABBA — 짝마다 순서를 뒤집어 선형 드리프트를 상쇄한다
                    order = ('A', 'B', 'B', 'A') if i % 2 == 0 else ('B', 'A', 'A', 'B')
                    for who in order:
                        t, wall = boot_once(br, ua if who == 'A' else ub, cpu)
                        (A if who == 'A' else B).append(t)
                        print('    %d %s  부팅 %.3fs  (벽시계 %.3fs)' % (i + 1, who, t, wall))
            finally:
                br.close()
    finally:
        for s in (sa, sb):
            s.shutdown()
            s.server_close()

    n = min(len(A), len(B))
    d = [B[i] - A[i] for i in range(n)]          # 짝지음 차이
    md = statistics.mean(d)
    sd = statistics.stdev(d) if n > 1 else 0.0
    se = (sd / (n ** 0.5)) if n > 1 else 0.0
    t = (md / se) if se > 0 else float('inf')
    print('\n════════ 결과 (%d회씩 · ABBA 교대 · 신규 유저 경로) ════════' % n)
    print('  A  790  평균 %.3fs  (min %.3f / max %.3f)' % (statistics.mean(A), min(A), max(A)))
    print('  B 9790  평균 %.3fs  (min %.3f / max %.3f)' % (statistics.mean(B), min(B), max(B)))
    print('  ★짝지음 차이 B−A = %+.3fs ± %.3f (표준오차) · t = %.2f' % (md, se, t))
    print('  ⇒ %s' % ('★차이가 «잡음에 묻힌다»(|t| < 2) — 유의한 지연 없음' if abs(t) < 2
                      else '★차이가 «실재»한다(|t| >= 2)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
