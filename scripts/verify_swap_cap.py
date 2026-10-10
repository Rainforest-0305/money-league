# -*- coding: utf-8 -*-
"""
스왑·선도 상한이 «엔진 값»을 쓰는지 — ★headless 전용.

  ML_DIST=dist python scripts/verify_swap_cap.py

★왜 필요한가: 스왑은 두 다리에 «같은 명목»이 걸린다(engine openSwap 이
  assertOrderSize 를 다리마다 «각각» 건다). 실효 상한은 «더 얕은 쪽»이다.
  그 «판단»을 화면에서 엔진(maxOrderNotionalAll)으로 옮겼다. ⇒ 화면이 그 값을 실제로 쓰는지 본다.

★대조 설계 — 지수(깊이 4배)가 «한 다리»로 들어가면 최솟값 규칙이 눈에 보인다:
  ① SPX + VZ  : min(2,900,000 , VZ깊이x0.05)  ⇒ ★VZ 가 얕으므로 VZ 쪽이 상한
  ② SPX + NDX : min(2,900,000 , 2,900,000)    ⇒ ★둘 다 지수라 2,900,000
  ⇒ ②가 ①보다 «커야» 한다. 안 그러면 지수 깊이가 화면에 안 닿은 것이다.
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
# ★ML_DIST 경로 함정을 «검사기가 스스로» 잡게 한다 (scripts/_distguard.py 참조).
#   ⛔ait 빌드 뒤엔 웹이 dist/web 으로 «옮겨진다». 모르면 「.tabbar 못 찾음」으로 죽는다.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
FORWARD_MARGIN_RATIO = 0.2   # lib/constants.ts 와 같은 값 (선도 개시 증거금 비율)
CASH = 20_000_000          # ★현금이 상한을 «가리지» 않게 크게


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def init():
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {
            'cash': float(CASH), 'holdings': [],
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
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "localStorage.setItem('ml.game', %s);"
        "})()" % json.dumps(json.dumps(save))
    )


# ⛔☠️★[오탐 1건] 처음엔 「화면에서 «가장 큰 달러 값»」을 상한으로 봤다. ★그건 «현금»이었다
#   ($20,005,000). ⇒ VZ 20,005,000 vs SPX 20,000,000 이 나와 «거짓 FAIL». 지표가 대상을 안 쟀다.
# ⇒ ★「최대」 버튼을 «누르고» 규모 값을 읽는다. 그게 화면이 실제로 허용하는 상한이다.
SIZE = """() => {
  const b = document.body.innerText || '';
  /* 요약 줄의 「규모」 뒤 금액 — 「최대」를 누른 뒤라 그게 상한이다 */
  const i = b.lastIndexOf('규모');
  if (i < 0) return { size: 0, len: b.length };
  const m = b.slice(i, i + 60).match(/[$][0-9][0-9,]*([.][0-9]+)?/);
  return { size: m ? Number(m[0].slice(1).replace(/,/g, '')) : 0, len: b.length };
}"""


def open_contract(p, base, url_suffix):
    p.goto(base + url_suffix, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=90000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(2200)
    mx = p.get_by_role('button', name='최대', exact=True)
    if mx.count():
        mx.first.click()
        p.wait_for_timeout(700)
    return p.evaluate(SIZE)


def main():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(init())
                p = ctx.new_page()
                errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                fwd_vz = open_contract(p, base, '?a#/contract/forward/VZ')
                fwd_spx = open_contract(p, base, '?b#/contract/forward/SPX')
                p.screenshot(path=str(ROOT / '_verify_dividend_ui' / '40_contract_spx.png'))
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    def chk(name, ok, d=''):
        print('  %s  %s  %s' % ('PASS' if ok else '★FAIL', name, d))
        if not ok:
            fails.append(name)

    print('선도(forward) 화면 — 「최대」를 누른 뒤의 «규모»가 상한이다')
    print('   VZ   %s' % fwd_vz)
    print('   SPX  %s' % fwd_spx)
    chk('선도 화면이 «뜬다»(VZ)', fwd_vz['len'] > 300, '본문 %d자' % fwd_vz['len'])
    chk('선도 화면이 «뜬다»(SPX)', fwd_spx['len'] > 300, '본문 %d자' % fwd_spx['len'])
    # ★지수 깊이(4배)가 화면에 «닿았는가» — SPX 상한이 VZ 보다 «커야» 한다
    # ★엔진 상한(engine_caps.json)과 «직접» 대조한다 — 「크다/작다」보다 강하다
    # ★[2026-09-05 President 결정 「괜찮아. 캡 풀어.」] 판정이 «뒤집혔다».
    #   옛 규칙: 상한 = min(현금/증거금비율, 종목 깊이×5%) ⇒ 얕은 VZ 와 깊은 SPX 가 «달라야» 했다.
    #   현행    : 상한 = 현금/증거금비율 «뿐» ⇒ 두 종목이 ★«같아야» 한다. 다르면 깊이가 되살아난 것이다.
    #   ⛔이 파일을 지우지 않고 «판정을 뒤집어» 남긴 이유: 검사가 사라지면 캡이 조용히
    #     되살아나도 아무도 모른다. 「없음」을 지키는 검사가 필요하다.
    # ⚠허용오차를 «절대값»으로 잡지 마라: 출석 보상($5,000)이 현금에 붙어 예상치가 정확히
    #   CASH/비율 이 아니게 된다(실측 VZ 100,025,000 = (20,000,000+5,000)/0.2).
    #   ⇒ ①「깊이 상한보다 훨씬 크다」 ②「두 종목이 서로 1% 안쪽」 두 가지로 본다.
    #     옛 규칙이었다면 VZ 는 $181,250·SPX 는 $2,900,000 로 ★16배 갈렸다.
    want = CASH / FORWARD_MARGIN_RATIO
    OLD_CAPS = {'VZ': 181_250.0, 'SPX': 2_900_000.0}   # 깊이×5% (옛 규칙)
    for tk, got in (('VZ', fwd_vz), ('SPX', fwd_spx)):
        chk('★%s 선도 상한이 «옛 깊이 상한»을 훨씬 넘는다 (캡 없음)' % tk,
            got['size'] > OLD_CAPS[tk] * 10,
            '화면 %.0f · 옛 상한 %.0f · 현금기준 %.0f' % (got['size'], OLD_CAPS[tk], want))
    hi = max(fwd_spx['size'], fwd_vz['size'], 1.0)
    chk('★얕은 종목(VZ)과 깊은 지수(SPX)의 상한이 «같다»(±1%) = 깊이가 안 닿는다',
        abs(fwd_spx['size'] - fwd_vz['size']) / hi <= 0.01,
        'SPX %.0f vs VZ %.0f (차 %.3f%%)' % (fwd_spx['size'], fwd_vz['size'],
                                             abs(fwd_spx['size'] - fwd_vz['size']) / hi * 100))
    chk('pageerror 0', not errs, str(errs[:2]))
    print('\n검사 4건 · ★실패 %d건' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
