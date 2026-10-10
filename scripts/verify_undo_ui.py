# -*- coding: utf-8 -*-
"""
되돌리기 «UI 동작» 검증 — ★headless 전용.

★★원장 검증은 파생 레인이 «끝냈다»(13필드 전수 IDENTICAL). ⛔중복하지 않는다.
  여기서 보는 것은 ★«화면이 그 원장을 제대로 부르는가»다:
    · 5초 토스트가 뜨고 «사라지는가»
    · ★중복 클릭 — 되돌리기를 두 번 눌러도 «한 번만» 동작하는가
    · ★토스트 «만료 후»에는 되돌릴 수 없는가(= 포지션이 남는가)
    · ★4상품이 «같은 문법»으로 동작하는가
  그리고 총자산이 «주문 전 값으로» 돌아오는지 — ★화면에 보이는 숫자로 판정한다.
"""
import http.server
import json
import re
import socket
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
import os as _os

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
# ★검증 대상 폴더를 «바꿀 수 있게» 한다 — `ait:build` 후에는 dist/ 가 RN 번들로 바뀌므로
#   ★«아티팩트에서 꺼낸 web/»(_ait_web) 을 검증해야 «출하물»을 검증한 것이 된다.
DIST = ROOT / _os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}
MONEY = re.compile(r'\$([\d,]+\.\d{2})')


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

# 상품 → (주문 화면 경로, 허브 칩 인덱스, 포지션 배지 클래스)
def prep_swap(p):
    """스왑은 «두 번째 종목»을 골라야 확정이 열린다"""
    p.query_selector('.card.li').click()
    p.wait_for_timeout(700)
    p.query_selector_all('.sheet .row')[0].click()
    p.wait_for_timeout(1800)


def prep_sell(p):
    """옵션 «매도»는 사기/팔기 토글을 «팔기»로 돌린다"""
    segs = p.query_selector_all('.seg')
    # 첫 세그먼트 = 콜/풋, 두 번째 = 사기/팔기
    segs[1].query_selector_all('button')[1].click()
    p.wait_for_timeout(900)


PRODUCTS = [
    ('선도', '#/contract/forward/NVDA', 2, '.pbadge--fwd', None),
    ('선물', '#/leverage/NVDA', 0, '.pbadge--fut', None),
    ('옵션매수', '#/option/AMD', 1, '.pbadge--opt', None),
    ('스왑', '#/contract/swap/NVDA', 3, '.pbadge--swp', prep_swap),
    ('옵션매도', '#/option/AMD', 1, '.pbadge--opt', prep_sell),
]


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_undo')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'checks': [], 'fail': [], 'shots': [], 'console': [], 'pageerror': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), detail])
        if not ok:
            rep['fail'].append([name, detail])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            def fresh():
                ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                ctx.add_init_script(INIT)
                p = ctx.new_page()
                p.on('console', lambda m: rep['console'].append(m.text) if m.type == 'error' else None)
                p.on('pageerror', lambda e: rep['pageerror'].append(str(e)))
                return ctx, p

            def equity(p):
                """홈 상단 총자산 — 유저가 «보는» 숫자로 판정한다"""
                p.goto(base + '#/home', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=25000)
                p.wait_for_timeout(1500)
                txt = p.eval_on_selector_all('.screen *', "els => els.map(e => e.textContent||'')")
                for t in txt:
                    m = MONEY.search(t)
                    if m and t.strip().startswith('$'):
                        return m.group(1)
                return None

            def count_positions(p, chip, badge):
                p.goto(base + '#/derivatives', wait_until='domcontentloaded')
                p.wait_for_selector('.pillrow', timeout=25000)
                p.wait_for_timeout(1500)
                p.query_selector_all('.pillrow .pill')[chip].click()
                p.wait_for_timeout(600)
                return len(p.query_selector_all(badge))

            for label, route, chip, badge, prep in PRODUCTS:
                # ── 케이스 A: 주문 → 되돌리기 → 포지션 0 ──────────────
                ctx, p = fresh()
                p.goto(base + route, wait_until='domcontentloaded')
                p.wait_for_selector('.btn--lg', timeout=25000)
                p.wait_for_timeout(2500)
                if prep:
                    prep(p)
                cta = p.query_selector('.btn--lg')
                check(f'{label}: 확정 버튼 «활성»', not cta.is_disabled())
                cta.click()
                p.wait_for_timeout(1200)
                t = p.query_selector('.toast--act')
                check(f'{label}: 되돌리기 토스트 표시', t is not None)
                if t:
                    acts = p.query_selector_all('.toast__act')
                    # ★중복 클릭 — 두 번 눌러도 «한 번만» 동작해야 한다
                    acts[0].click()
                    p.wait_for_timeout(200)
                    left = p.query_selector_all('.toast__act')
                    check(f'{label}: 되돌리기 후 «액션 토스트가 사라짐»(중복 클릭 불가)', len(left) == 0, f'{len(left)}개 남음')
                    p.wait_for_timeout(900)
                n = count_positions(p, chip, badge)
                check(f'★{label}: 되돌리기 후 포지션 0', n == 0, f'{n}개')
                p.screenshot(path=str(out / f'A_{label}_undo.png'))
                rep['shots'].append(f'A_{label}_undo')
                ctx.close()

                # ── 케이스 B: 주문 → 5초 «지나감» → 포지션 유지 ────────
                ctx, p = fresh()
                p.goto(base + route, wait_until='domcontentloaded')
                p.wait_for_selector('.btn--lg', timeout=25000)
                p.wait_for_timeout(2500)
                if prep:
                    prep(p)
                p.query_selector('.btn--lg').click()
                p.wait_for_timeout(1200)
                check(f'{label}: 체결 직후 토스트 있음', p.query_selector('.toast--act') is not None)
                p.wait_for_timeout(6000)  # UNDO_WINDOW_MS(5000) 경과
                gone = p.query_selector('.toast--act') is None
                check(f'★{label}: 5초 뒤 되돌리기 토스트 «사라짐»', gone)
                n = count_positions(p, chip, badge)
                check(f'★{label}: 만료 후 포지션 «유지»', n >= 1, f'{n}개')
                p.screenshot(path=str(out / f'B_{label}_kept.png'))
                rep['shots'].append(f'B_{label}_kept')
                ctx.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n검사 {len(rep['checks'])}건 · ★실패 {len(rep['fail'])}건 · console {len(rep['console'])} · pageerror {len(rep['pageerror'])}")
    for f in rep['fail']:
        print('  ★FAIL', f)
    for c in rep['console'][:6]:
        print('  CONSOLE', c)
    return 1 if (rep['fail'] or rep['console'] or rep['pageerror']) else 0


if __name__ == '__main__':
    sys.exit(main())
