# -*- coding: utf-8 -*-
"""
광고 지면 «눈으로 보기» — 배너를 화면 «가운데»로 끌어와 찍는다. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_adlook.py <출력폴더> [--slot NAME]

`verify_adgaps.py` 가 «숫자»를 재고, 이 파일이 «그림»을 남긴다.
숫자만 보면 「0px 간격」이 나쁜지 좋은지 모른다 — 이 프로젝트가 반복해서 데인 형태가
「코드만 읽고 판단」이라 ★실렌더 그림이 산출물이다.
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
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
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


def seed_journal(n):
    return json.dumps([{
        'id': 'j%d' % (n - i), 'at': 1700000000000 + i * 1000, 'tick': 100 + i,
        'gameDay': 1 + i // 4, 'product': 'spot' if i % 2 == 0 else 'leverage',
        'action': 'buy' if i % 3 else 'sell', 'ticker': ['NVDA', 'MSFT', 'TSLA', 'AAPL'][i % 4],
        'fee': 1.25, 'qty': 3, 'price': 100 + i, 'notional': 300 + i, 'realized': (i - 5) * 12.5,
    } for i in range(n)], ensure_ascii=False)


def seed_save(cash):
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {'cash': cash, 'holdings': [], 'levPositions': [], 'optPositions': [],
                    'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 4,
                    'liquidationCount': 0, 'topupCount': 0},
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    })


def init_js(theme, ads, watch=(), save=None):
    parts = [
        "localStorage.setItem('ml.onboarded','1');",
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));",
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'%s',updown:'kr'}));" % theme,
        "localStorage.setItem('ml.journal', %s);" % json.dumps(seed_journal(20)),
    ]
    if watch:
        parts.append("localStorage.setItem('ml.traderwatch', %s);" % json.dumps(json.dumps(list(watch))))
    if save is not None:
        parts.append("localStorage.setItem('ml.game', %s);" % json.dumps(save))
    parts.append("sessionStorage.setItem('ads.preview','1');" if ads else "sessionStorage.removeItem('ads.preview');")
    return '(() => {' + ''.join(parts) + '})()'


# 배너를 화면 «가운데»로 끌어온다. 없으면 그 자리(anchor)를 대신 끌어온다.
CENTER_JS = r"""(anchorSel) => {
  const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
  const el = document.querySelector('.adslot') || (anchorSel ? document.querySelector(anchorSel) : null);
  if (!sc || !el) return null;
  const er = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  sc.scrollTop += (er.top - sr.top) - (sr.height / 2 - er.height / 2);
  return true;
}"""

MEAS_JS = r"""() => {
  const el = document.querySelector('.adslot');
  if (!el) return null;
  let blk = el;
  while (blk.parentElement && blk.parentElement.children.length === 1
         && !blk.parentElement.classList.contains('scroll')) blk = blk.parentElement;
  const r = blk.getBoundingClientRect();
  const p = blk.previousElementSibling, n = blk.nextElementSibling;
  return {
    top: Math.round(r.top), h: Math.round(r.height),
    up: p ? Math.round(r.top - p.getBoundingClientRect().bottom) : null,
    dn: n ? Math.round(n.getBoundingClientRect().top - r.bottom) : null,
  };
}"""

CASES = [
    ('bannerHome', '#/home', None, '.sec', {}),
    ('bannerStocks', '#/stocks', 'scroll', '.vrow', {}),
    ('bannerLeaderboard_all', '#/rank', None, '.card', {}),
    ('bannerLeaderboard_watch', '#/rank', 'watch_tab', '.card',
     {'watch': ['BOT001', 'BOT002', 'BOT003', 'BOT004', 'BOT005', 'BOT006', 'BOT007', 'BOT008', 'BOT009']}),
    ('bannerTraderProfile', '#/rank', 'open_trader', '.card', {}),
    ('bannerSettings', '#/settings', None, '.grp', {}),
    ('bannerRechargeDone', '#/recharge', 'topup', '.screen', {'save': seed_save(80)}),
    # ★[2026-09-10 · -33] bannerDerivatives 케이스 제거 — 지면 자체를 코드에서 뺐다
    ('bannerJournal', '#/journal', 'scroll', '.jrow', {}),
    ('bannerStockDetail', '#/stock/NVDA', None, '.sec', {}),
]


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_adlook')
    out.mkdir(parents=True, exist_ok=True)
    only = None
    if '--slot' in sys.argv:
        only = sys.argv[sys.argv.index('--slot') + 1]
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            for slot, route, prep, anchor, extra in CASES:
                if only and only not in slot:
                    continue
                for theme in ('light', 'dark'):
                    for ads in (True, False):
                        if theme == 'dark' and not ads:
                            continue
                        ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                        ctx.add_init_script(init_js(theme, ads, **extra))
                        page = ctx.new_page()
                        tag = f'{slot}__{theme}__{"ads" if ads else "noads"}'
                        try:
                            page.goto(base + route, wait_until='domcontentloaded')
                            page.wait_for_selector('.screen', timeout=25000)
                            page.wait_for_timeout(1700)
                            if prep == 'watch_tab':
                                page.get_by_role('tab').nth(1).click(timeout=5000)
                                page.wait_for_timeout(1000)
                            elif prep == 'open_trader':
                                # ★상위 랭커부터 눌러 「표시 행 4개 이상」 게이트를 통과하는 참가자를 찾는다
                                for i in range(8):
                                    page.goto(base + route, wait_until='domcontentloaded')
                                    page.wait_for_selector('button.rk', timeout=20000)
                                    page.wait_for_timeout(1200)
                                    page.locator('button.rk').nth(i).click(timeout=6000)
                                    page.wait_for_timeout(1600)
                                    if page.locator('.adslot').count() or not ads:
                                        break
                            elif prep == 'topup':
                                page.locator('button.btn').first.click(timeout=6000)
                                page.wait_for_timeout(1400)
                            elif prep == 'scroll':
                                page.evaluate("""() => {
                                    const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
                                    if (sc) sc.scrollTop = 500;
                                }""")
                                page.wait_for_timeout(700)
                            page.evaluate(CENTER_JS, anchor)
                            page.wait_for_timeout(800)
                            m = page.evaluate(MEAS_JS)
                            page.screenshot(path=str(out / f'{tag}.png'))
                            rep.append({'tag': tag, 'm': m})
                            print(f'  {tag:52s} {m}')
                        except Exception as e:  # noqa: BLE001
                            print(f'  ERR {tag}: {str(e)[:120]}')
                            rep.append({'tag': tag, 'error': str(e)[:200]})
                        finally:
                            ctx.close()
        finally:
            browser.close()
            httpd.shutdown()
    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n산출: {out}')


if __name__ == '__main__':
    main()
