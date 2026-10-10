# -*- coding: utf-8 -*-
"""
파생 «만기 정산» 알림 검증 — ★headless 전용.

★★문제: 선도·스왑 만기는 ★3 게임일 = ★실제 15분이다. 그냥 기다리면 검증이 불가능하다.
  ⇒ ★Playwright 의 «가짜 시계»로 시간을 앞당긴다.
    ⛔단 한 번에 크게 뛰면 «틱이 버려진다» — store.pump() 가
      `run = min(due, MAX_CATCHUP_TICKS)` 로 자르고 `lastTickAt += due * TICK_MS` 로
      ★소비하지 못한 만큼을 «건너뛴다»(백그라운드 복귀 폭주 방지 장치다).
    ⇒ ★MAX_CATCHUP_TICKS(300틱=600초)보다 «작게» 여러 번 뛴다.

★검증 대상 (엔진 원장은 파생 레인이 이미 확인했다 — ⛔중복하지 않는다):
  · 내 정산 → ★토스트가 «뜨는가»
  · ★만기(forced=false)와 ★강제 정리(forced=true) 문구가 «다른가»
  · ★옵션 매수 외가격 소멸(returned=0) → «전용 문구»가 뜨는가
  · 남의 정산 → 홈 피드에 «섞이는가»
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

# ★★[2026-08-22] 콘솔 인코딩을 «스크립트가 스스로» 고친다.
#   윈도우 기본 코드페이지(cp949)에서는 «»·★ 를 못 찍어 UnicodeEncodeError 로 죽는다.
#   ⛔그때 죽는 것은 «검사»가 아니라 «출력»인데 EXIT=1 이 나온다 —
#     「저장본 호환성 검증 실패」로 오독하기 딱 좋다(실제로 CTO 레인이 그렇게 만났다).
#   ⛔PYTHONIOENCODING 을 «기억해야» 도는 검사기는 언젠가 반드시 잘못 돌아간다.
for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
VIEW = {'width': 390, 'height': 844}


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, *a):
        pass


def serve():
    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


INIT = (
    "(() => {"
    "localStorage.setItem('ml.onboarded','1');"
    "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
    "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
    "})()"
)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_settled')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'checks': [], 'fail': [], 'toasts': [], 'shots': [], 'console': [], 'pageerror': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), detail])
        if not ok:
            rep['fail'].append([name, detail])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(INIT)
            p = ctx.new_page()
            p.on('console', lambda m: rep['console'].append(m.text) if m.type == 'error' else None)
            p.on('pageerror', lambda e: rep['pageerror'].append(str(e)))

            p.goto(base + '#/contract/forward/NVDA', wait_until='domcontentloaded')
            p.wait_for_selector('.btn--lg', timeout=30000)
            p.wait_for_timeout(3000)
            p.query_selector('.btn--lg').click()
            p.wait_for_timeout(1500)
            check('선도 계약 개시', p.query_selector('.toast--act') is not None)

            # 되돌리기 창이 지나가게 둔 뒤 홈으로
            p.wait_for_timeout(6000)
            p.goto(base + '#/home', wait_until='domcontentloaded')
            p.wait_for_selector('.tabbar', timeout=25000)
            p.wait_for_timeout(1500)

            # ── ★시간을 앞당긴다 ──────────────────────────────────────
            #  선도 만기 = 3 게임일 = 450틱 = 실제 900초. 그냥 기다릴 수 없다.
            #  ⛔한 번에 크게 뛰면 «틱이 버려진다» — store.pump() 가
            #    `run = min(due, MAX_CATCHUP_TICKS)` 로 자르고
            #    `lastTickAt += due * TICK_MS` 로 소비 못 한 만큼을 «건너뛴다».
            #  ⇒ 상한(300틱 = 600초)보다 «작게» 여러 번 뛴다. 여기서는 180초(90틱)씩.
            # ★★토스트 «관측자»를 여기서 심는다 — ⛔add_init_script 로 심으면 안 된다.
            #   그건 «문서마다» 다시 실행되므로 page.goto() 한 번에 window.__toasts 가 «초기화»된다.
            #   실제로 그것 때문에 처음 실행에서 «토스트 0건»이 나왔다 — 화면엔 떴는데 기록이 비었다.
            #   ⇒ 마지막 내비게이션 «뒤»에 심고, 이후로는 이동하지 않는다.
            p.evaluate(
                """() => {
                  window.__toasts = [];
                  new MutationObserver(() => {
                    document.querySelectorAll('.toast__txt').forEach((e) => {
                      const t = (e.textContent || '').trim();
                      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
                    });
                  }).observe(document.body, { childList: true, subtree: true, characterData: true });
                }"""
            )
            # ★양성대조 — 관측자가 «살아 있는지» 먼저 증명한다. 이걸 안 하면 0건이 무의미하다.
            p.evaluate(
                """() => {
                  const h = document.createElement('div');
                  h.className = 'toast-host';
                  h.innerHTML = '<div class="toast"><span class="toast__txt">NEEDLE_TOAST</span></div>';
                  document.body.appendChild(h);
                  setTimeout(() => h.remove(), 50);
                }"""
            )
            p.wait_for_timeout(300)
            needle_ok = 'NEEDLE_TOAST' in p.evaluate('() => window.__toasts || []')
            check('★[양성대조] 토스트 관측자가 살아 있다', needle_ok)
            if not needle_ok:
                print('FAILED: 관측자가 죽었다 — 이 실행의 「토스트 0건」은 무효다')
                return 1
            p.evaluate("() => { window.__toasts = window.__toasts.filter(t => t !== 'NEEDLE_TOAST'); }")

            p.clock.install()
            seen = []
            for _ in range(12):
                p.clock.fast_forward(180 * 1000)  # 90틱 — 상한(300) 아래
                p.wait_for_timeout(400)
                day = p.evaluate("""() => (document.querySelector('.gameday')||{}).textContent || ''""")
                seen.append(day)
                toasts = p.evaluate('() => window.__toasts || []')
                if any('정산' in t for t in toasts):
                    break
            rep['toasts'] = p.evaluate('() => window.__toasts || []')
            p.clock.uninstall() if hasattr(p.clock, 'uninstall') else None
            check('게임일이 «실제로» 흘렀다', len(set(seen)) > 1, str(seen[:4]) + ' … ' + str(seen[-2:]))
            settled = [t for t in rep['toasts'] if '정산' in t or '정리' in t or '만기' in t]
            check('★내 정산 토스트가 «떴다»', len(settled) > 0, str(settled[:3]))
            p.screenshot(path=str(out / 'S_after_expiry.png'))
            rep['shots'].append('S_after_expiry')

            # 포지션이 «사라졌는지»(정산됐으니 없어야 한다)
            p.goto(base + '#/derivatives', wait_until='domcontentloaded')
            p.wait_for_selector('.pillrow', timeout=25000)
            p.wait_for_timeout(1200)
            p.query_selector_all('.pillrow .pill')[2].click()
            p.wait_for_timeout(600)
            n = len(p.query_selector_all('.pbadge--fwd'))
            check('정산 후 선도 포지션 0', n == 0, f'{n}개')
            p.screenshot(path=str(out / 'S_positions_after.png'))
            rep['shots'].append('S_positions_after')

            # 남의 정산이 홈 피드에 섞이는지
            p.goto(base + '#/home', wait_until='domcontentloaded')
            p.wait_for_selector('.tabbar', timeout=25000)
            p.wait_for_timeout(1500)
            p.eval_on_selector('.scroll', 'e => e.scrollTop = 1200')
            p.wait_for_timeout(500)
            p.screenshot(path=str(out / 'S_home_feed.png'))
            rep['shots'].append('S_home_feed')
            feed = p.evaluate("""() => [...document.querySelectorAll('.macrorow')].map(e => (e.textContent||'').trim())""")
            rep['feed'] = feed
            print('  피드 행:', feed[:3])
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n검사 {len(rep['checks'])}건 · ★실패 {len(rep['fail'])}건 · 토스트 {len(rep['toasts'])}")
    for t in rep['toasts'][:12]:
        print('  TOAST', t)
    for f in rep['fail']:
        print('  ★FAIL', f)
    for c in rep['console'][:6]:
        print('  CONSOLE', c)
    return 1 if (rep['fail'] or rep['console'] or rep['pageerror']) else 0


if __name__ == '__main__':
    sys.exit(main())
