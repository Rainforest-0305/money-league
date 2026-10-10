# -*- coding: utf-8 -*-
"""
주문 시트 «최대 주문금액 · 표시 임팩트%» 기준선 캡처 — ★headless 전용.

  python scripts/capture_ordersheet_baseline.py <출력.json> [라벨]
  (ML_DIST=dist/web 로 «실제 출하 번들»을 가리켜라)

══════════════════════════════════════════════════════════════════════════
★왜 «지금» 떠야 하나 — 사후에는 만들 수 없다
══════════════════════════════════════════════════════════════════════════
지수 깊이 불일치(화면 0.25배 vs 엔진 4배)를 고치자는 안이 올라가 있다.
그 수정의 ★핵심 조건은 Chief 가 말한 «음성대조»다:
    「2종목(SPX·NDX) 고치려다 998종목을 바꾸면 그게 더 큰 사고다」
⇒ 그걸 증명하려면 ★**«수정 전» 숫자가 있어야 한다.** 고치고 나면 영원히 못 뜬다.
⇒ 그래서 ⛔코드를 «건드리지 않은» 지금 상태에서 먼저 뜬다.

★대상 선정: 랭크 분포 + ★경계(100/101 — depthFactorForRank 의 클램프 지점)
  + 비주식 4종(GOLD commodity · BTC crypto · SPX·NDX index).
  ⛔지수만 넣지 마라. «안 변해야 하는 쪽»이 훨씬 중요하다.
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
CASH = 5_000_000          # ★현금이 «상한을 가리지» 않도록 크게. 그래야 cap 자체를 잰다
TICKERS = ['NVDA', 'AAPL', 'CVX', 'LIN', 'GLW', 'ACN', 'ASML', 'DAL', 'YUMC',
           'GOLD', 'BTC', 'SPX', 'NDX']

INIT = None


def make_init():
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


# ★임팩트 % 는 「이만큼 사면」 문장에서만 뽑는다.
#   ⛔'밀려' 로 찾지 «마라» — 종목 상세의 호가 설명 「팔려는 힘이 세면 가격이 밀려 내려가요」에
#     걸린다(시트 «뒤»에 있다). 실제로 거짓 PASS 4건을 만든 오탐이다.
READ = """() => {
  const b = document.body.innerText || '';
  const grab = (k, n) => { const i = b.indexOf(k); return i < 0 ? '' :
    b.slice(i, i + n).split(String.fromCharCode(10)).join(' ').trim(); };
  const i = b.indexOf('이만큼 사면');
  let pct = '';
  if (i >= 0) {
    const seg = b.slice(i, i + 40);
    const m = seg.match(/[+-][0-9]+[.][0-9]+%/);
    pct = m ? m[0] : '(문장은 있으나 % 못뽑음)';
  }
  return { total: grab('주문 금액', 26), qtyLine: grab('최대', 0), impactPct: pct };
}"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    out_path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_baseline' / 'ordersheet_before.json')
    label = sys.argv[2] if len(sys.argv) > 2 else 'before'
    out_path.parent.mkdir(parents=True, exist_ok=True)

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    rows = {}
    errs = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(make_init())
                p = ctx.new_page()
                p.on('pageerror', lambda e: errs.append(str(e)))
                for i, tk in enumerate(TICKERS):
                    # ⛔해시만 바꾸면 «시트가 열린 채로 남는다» — 다음 종목의 「사기」 버튼을
                    #   시트가 가로막아 pointer interception 으로 죽는다(실측).
                    #   Escape 로도 안 닫혔다. ⇒ ★쿼리를 바꿔 «완전 재로드»한다. 가장 튼튼하다.
                    p.goto(base + ('?k=%d#/stock/%s' % (i, tk)), wait_until='domcontentloaded')
                    p.wait_for_selector('.screen', timeout=90000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(1200)
                    btn = p.get_by_role('button', name='사기')
                    if btn.count() == 0:
                        rows[tk] = {'err': '사기 버튼 없음'}
                        continue
                    btn.first.click()
                    p.wait_for_timeout(900)
                    mx = p.get_by_role('button', name='최대', exact=True)
                    if mx.count() == 0:
                        rows[tk] = {'err': '최대 버튼 없음'}
                        continue
                    mx.first.click()
                    p.wait_for_timeout(700)
                    rows[tk] = p.evaluate(READ)
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    rep = {'label': label, 'cash': CASH, 'dist': str(DIST), 'rows': rows, 'pageerrors': errs}
    out_path.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')

    print('기준선 [%s] · 현금 $%s · 번들 %s' % (label, format(CASH, ','), DIST))
    print('  종목    최대 주문금액                        표시 임팩트')
    bad = 0
    for tk in TICKERS:
        r = rows.get(tk, {})
        if r.get('err'):
            bad += 1
            print('  %-5s  ★%s' % (tk, r['err']))
        else:
            print('  %-5s  %-36s %s' % (tk, r.get('total', ''), r.get('impactPct', '') or '(노트 없음)'))
    print('  pageerror %d건 · 실패 %d건 -> %s' % (len(errs), bad, out_path))
    print('⛔이 파일을 «지우지 마라». 수정 후 같은 스크립트로 after 를 떠서 대조한다.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
