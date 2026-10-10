# -*- coding: utf-8 -*-
"""
⑨ 「내 주문이 가격을 민다」 표시가 ★«실제로 유저에게 도달하는가».

  python scripts/verify_price_impact.py

★먼저 확인한 것: 이 기능은 «이미 구현돼 있다». 만들 게 아니었다.
  OrderSheet.tsx:66   impactPct = (gross / depth) * ORDER_FLOW_WEIGHT * 100
  OrderSheet.tsx:260  impactPct >= 0.05 «일 때만» note 를 그린다 (stock:impactWarn)
⇒ ★그러니 질문은 「만들까」가 아니라 «닿는가»다.

[산술] depth $14,500,000 · ORDER_FLOW_WEIGHT 0.5
  시드 전액 $10,000 주문 -> 0.0345%   ⇒ 임계 0.05% «미만»
  임계 0.05% 에 닿으려면 -> $14,500   ⇒ ★시드 전액보다 «크다»
⛔산술만으로 판정하지 «않는다» — divcheck 가 「같은 틀린 모델」로 자문자답해
  OFFSET=1 을 정답이라 우긴 사고가 있다. 화면에서 «대조 쌍»으로 확인한다:
     ★양성 = 큰 잔고 전액   -> 노트가 «있어야» 한다 (없으면 검사기가 고장난 것)
     ☠️음성 = 시드 $10,000 -> 여기서 «없으면» 신규 유저는 이 기능을 못 본다
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
# ⛔☠️★[오탐 1건 — 기록해 둔다] 처음엔 NEEDLE = '밀려' 였다. ★그건 «다른 문장»에 걸린다:
#   종목 상세의 호가 설명 「팔려는 힘이 세면 가격이 밀려 내려가요」(시트 «뒤»에 있다).
#   ⇒ 4개 비율 전부 «거짓 PASS» 가 났다. 「우량배당」 티어라벨 오탐과 «같은 유형»이다.
#   ⇒ ★부분일치 needle 은 «그 화면에만 있는지»를 먼저 확인하라. 짧은 말일수록 위험하다.
TICKER = os.environ.get('ML_TICKER', 'VZ')
NEEDLE = '이만큼 사면'    # stock:impactWarn 의 «머리말». 이 화면에만 있다


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def init(cash):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {
            'cash': float(cash), 'holdings': [],
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


READ = """() => {
  const b = document.body.innerText || '';
  const g = (k) => {
    const i = b.indexOf(k);
    return i < 0 ? '' : b.slice(i, i + 34).split(String.fromCharCode(10)).join(' ').trim();
  };
  const i = b.indexOf('이만큼 사면');
  const note = i < 0 ? '' : b.slice(i, i + 46)
      .split(String.fromCharCode(10)).join(' ').trim();
  return { total: g('주문 금액'), note };
}"""

# ★잔고를 «화면에서» 읽는다 — 심은 값이 그대로일 거라 «가정하지 마라».
#   [실측] 시드 $10,000 을 심었는데 부팅 후 출석 보상 +$5,000 이 «자동 지급»돼 $15,000 이 됐다.
#   그걸 모르고 「시드 전액」이라고 부르면 음성대조가 통째로 «틀린 조건»이 된다.
CASH = """() => {
  const b = document.body.innerText || '';
  const i = b.indexOf('주문 가능');
  const j = b.indexOf('현금');
  const k = i >= 0 ? i : j;
  return k < 0 ? '' : b.slice(k, k + 40).split(String.fromCharCode(10)).join(' ').trim();
}"""


def run(pw, base, cash, out_png):
    br = pw.chromium.launch(headless=True)
    try:
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
        ctx.add_init_script(init(cash))
        p = ctx.new_page()
        errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.goto(base + '#/stock/' + TICKER, wait_until='domcontentloaded')
        p.wait_for_selector('.screen', timeout=90000)
        p.wait_for_selector('.boot', state='detached', timeout=120000)
        p.wait_for_timeout(1800)
        p.get_by_role('button', name='사기').first.click()
        p.wait_for_timeout(1200)
        # ⛔`.pill` 로 잡지 «마라» — 종목 상세의 기간 칩(0.5일·1일·…)까지 «11개»가 잡혀
        #   시트 뒤 요소를 누르려다 pointer interception 으로 죽는다(실측).
        #   ⇒ ★시트 안에만 있는 «라벨»로 고른다. 25%/50%/75%/최대 (OrderSheet.tsx:218)
        RATIOS = ['25%', '50%', '75%', '최대']
        sweep = []
        n = 0
        for label in RATIOS:
            btn = p.get_by_role('button', name=label, exact=True)
            if btn.count() == 0:
                sweep.append({'pill': label, 'total': '(버튼 없음)', 'note': ''})
                continue
            btn.first.click()
            n += 1
            p.wait_for_timeout(450)
            r = p.evaluate(READ)
            sweep.append({'pill': label, 'total': r['total'], 'note': r['note']})
        p.screenshot(path=str(out_png))
        body = p.evaluate('() => document.body.innerText || ""')
        return {'has': NEEDLE in body, 'errs': errs, 'sweep': sweep,
                'cash': p.evaluate(CASH), 'pills': n}
    finally:
        br.close()


def main():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    outdir = ROOT / '_verify_dividend_ui'
    outdir.mkdir(parents=True, exist_ok=True)
    fails = []
    try:
        with sync_playwright() as pw:
            neg = run(pw, base, 10_000, outdir / '30_impact_seed10k.png')
            pos = run(pw, base, 500_000, outdir / '31_impact_500k.png')
    finally:
        httpd.shutdown()
        httpd.server_close()

    def chk(name, ok, d=''):
        print('  %s  %s  %s' % ('PASS' if ok else '★FAIL', name, d))
        if not ok:
            fails.append(name)

    for tag, r in (('큰 잔고 $500,000', pos), ('★신규 유저(시드+출석보상)', neg)):
        print('')
        print('── %s ──  화면 잔고: %s' % (tag, r['cash'] or '(못읽음)'))
        for e in r['sweep']:
            print('   %-6s  %-42s  %s' % (e['pill'], e['total'], e['note'] or '(노트 없음)'))
    chk('★양성대조: 큰 잔고에서는 노트가 «뜬다»', pos['has'], 'pill %d개 전량 스윕' % pos['pills'])
    chk('☠️신규 유저에게 노트가 «뜨는가»', neg['has'],
        '⇒ ★몇 %% 부터 뜨는지는 위 스윕을 봐라')
    chk('pageerror 0', not neg['errs'] and not pos['errs'], str((neg['errs'] + pos['errs'])[:2]))
    print('\n검사 3건 · ★실패 %d건' % len(fails))
    print('★해석: ①이 PASS 이고 ②가 FAIL 이면 «기능은 살아 있는데 임계가 시드보다 높은» 것이다.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
