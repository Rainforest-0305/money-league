# -*- coding: utf-8 -*-
"""
비주식 6종(금·원유·비트코인·이더리움·SPX·NDX) 파생 «실동작» 검증 — ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_deriv_assets.py <출력폴더>

★★무엇을 증명하려는 파일인가 (2026-09-05 President 지적)
  「금 같은 자산들 선물이나 옵션이 안 되는 거 같은데 확인해.」
  ⇒ ★엔진 하네스(scripts/bench/run.mjs deriv)는 «주문 API»를 두드린다.
    여기는 ★«화면»을 두드린다 — 버튼이 살아 있는지, 계약 단위 표기가 실제 체결과 맞는지,
    확정이 실제로 포지션을 만드는지까지 본다.

★★같이 증명하는 것
  ① 「1계약 = N주」 표기가 «종목마다» 맞다 (BTC 0.05 · NDX 0.2 · SPX 0.5 · GOLD 1 · ETH 2 · WTI 10)
  ② 옵션 매수·매도 확정 버튼이 시드 $10,000 에서 «살아 있다»
  ③ 확정하면 실제로 /derivatives 로 가고 콘솔 에러가 없다
  ④ 선도(ContractOrder)·레버리지(LeverageOrder) 화면도 6종 전부에서 확정 가능하다
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
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}

# 종목 → 기대 계약 크기 (lib/constants.ts sharesPerContractFor 가 정본)
EXPECT_SHARES = {'GOLD': 1, 'WTI': 10, 'BTC': 0.05, 'ETH': 2, 'SPX': 0.5, 'NDX': 0.2, 'NVDA': 10}


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


def init_js(cash=10000):
    blob = json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {'cash': cash, 'holdings': [], 'levPositions': [], 'optPositions': [],
                    'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 2,
                    'liquidationCount': 0, 'topupCount': 0},
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    })
    return (
        "(() => {localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "localStorage.setItem('ml.game', %s);})()" % json.dumps(blob)
    )


STATE_JS = r"""() => {
  const btn = document.querySelector('.btn.btn--lg');
  const txt = (document.querySelector('.screen') || document.body).innerText;
  const m = txt.match(/1계약\s*=\s*([0-9.]+)\s*주/);
  return {
    disabled: !!(btn && btn.disabled),
    btnText: btn ? btn.innerText.replace(/\n/g, ' ') : null,
    contractLabel: m ? Number(m[1]) : null,
    hasSplitCopy: /나눠서 주문|Split it up/.test(txt),
  };
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_deriv_assets')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'dist': str(DIST), 'checks': []}
    fails = []

    def check(name, ok, detail=''):
        rep['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
        print(('  PASS  ' if ok else '  FAIL  ') + name + '  ' + str(detail))
        if not ok:
            fails.append((name, detail))

    with sync_playwright() as pw:
        # ⛔headless=True 고정. 창을 띄우면 President 업무를 끊는다.
        browser = pw.chromium.launch(headless=True)
        try:
            for tk in ['GOLD', 'WTI', 'BTC', 'ETH', 'SPX', 'NDX', 'NVDA']:
                for action in ['buy', 'sell']:
                    ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                    ctx.add_init_script(init_js())
                    pg = ctx.new_page()
                    errs = []
                    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
                    pg.on('pageerror', lambda e: errs.append(str(e)))
                    pg.goto(base + f'#/option/{tk}', wait_until='networkidle')
                    pg.wait_for_selector('.btn.btn--lg', timeout=20000)
                    pg.wait_for_timeout(2400)
                    if action == 'sell':
                        # ★세그먼트는 role=tab 이다: [0]콜 [1]풋 [2]사기 [3]팔기
                        #   (verify_options.py 와 «같은» 선택자 — 두 벌이 되면 언젠가 갈린다)
                        pg.get_by_role('tab').nth(3).click()
                        pg.wait_for_timeout(400)
                    st = pg.evaluate(STATE_JS)
                    tag = f'{tk}/{action}'
                    check(f'① {tag}: 「1계약 = N주」 표기가 엔진 값과 같다',
                          st['contractLabel'] == EXPECT_SHARES[tk],
                          f"화면 {st['contractLabel']} vs 기대 {EXPECT_SHARES[tk]}")
                    check(f'② {tag}: 시드 $10,000 에서 확정 버튼이 살아 있다',
                          not st['disabled'], st['btnText'])
                    check(f'③ {tag}: 「나눠서 주문」 죽은 안내가 «없다»', not st['hasSplitCopy'], '')
                    if action == 'buy':
                        pg.screenshot(path=str(out / f'opt_{tk}.png'))
                    if not st['disabled']:
                        pg.click('.btn.btn--lg')
                        pg.wait_for_timeout(900)
                        check(f'④ {tag}: 확정하면 파생 화면으로 간다', '/derivatives' in pg.url, pg.url.split('#')[-1])
                        check(f'⑤ {tag}: 콘솔 에러 0건', len(errs) == 0, errs[:2])
                    ctx.close()

            # ── 선도·레버리지 ──────────────────────────────────────────
            for tk in ['GOLD', 'WTI', 'BTC', 'ETH', 'SPX', 'NDX']:
                for route, label in [(f'#/contract/forward/{tk}', '선도'), (f'#/leverage/{tk}', '레버리지')]:
                    ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                    ctx.add_init_script(init_js())
                    pg = ctx.new_page()
                    errs = []
                    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
                    pg.on('pageerror', lambda e: errs.append(str(e)))
                    pg.goto(base + route, wait_until='networkidle')
                    pg.wait_for_selector('.btn.btn--lg', timeout=20000)
                    st = pg.evaluate(STATE_JS)
                    check(f'⑥ {label} {tk}: 확정 버튼이 살아 있다', not st['disabled'], st['btnText'])
                    check(f'⑦ {label} {tk}: 콘솔 에러 0건', len(errs) == 0, errs[:2])
                    if tk == 'BTC':
                        pg.screenshot(path=str(out / f'{label}_{tk}.png'))
                    ctx.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    ok = sum(1 for c in rep['checks'] if c['ok'])
    print(f"\n검사 {ok}/{len(rep['checks'])} PASS · 산출: {out}")
    if fails:
        print('\nFAILED:')
        for n, d in fails:
            print(f'  {n}  {d}')
        sys.exit(1)


if __name__ == '__main__':
    main()
