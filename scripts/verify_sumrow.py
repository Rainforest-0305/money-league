# -*- coding: utf-8 -*-
"""
홈 요약 3칸(.sumrow 현금·평가금액·내 순위) «한 줄·넘침 0» 실측 — ★headless 전용.

  ML_DIST=dist/web [ML_THEME=dark] python scripts/verify_sumrow.py <라벨> [출력폴더]

★무엇을 재나 (ko/en × 375/390/430 × 현금 6종 = 36 케이스 × light/dark):
  ① 값(.sumrow__v)이 «한 줄»(높이/줄높이 < 1.6) · ② 넘침 0(scrollWidth ≤ clientWidth+1) · ③ 값 오른끝 ≤ 칸 오른끝(옆 칸 침범 0)
  ④ 표기: 7자리 미만은 소수점 그대로(「$270,000.00」) · 7자리부터 축약(「$1.23M」·「$12.35M」·「$1.00B」·「$1.00T」)
  ⑤ 순위 칸(.sumrow__link)도 한 줄·넘침 0 · 라벨(.sumrow__k) 넘침 0
⛔양성대조 먼저: 값 폰트를 40px 로 강제해 ②③이 «잡히는지».
★현금은 저장본으로 심는다. 출석 보너스(+$5,000)가 값을 흔들지 않게 «오늘 이미 받은» 원장을 같이 심는다.
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
from datetime import datetime, timedelta, timezone
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
THEME = os.environ.get('ML_THEME', 'light')
KST = timezone(timedelta(hours=9))
AMOUNTS = [4627.57, 270000.00, 1234567.89, 12345678.90, 1000039640.53, 1000000039640.53]
EXPECT = {4627.57: '$4,627.57', 270000.00: '$270,000.00', 1234567.89: '$1.23M', 12345678.90: '$12.35M', 1000039640.53: '$1.00B', 1000000039640.53: '$1.00T'}


def kst_key():
    return datetime.now(KST).strftime('%Y-%m-%d')


def init(lang, cash, holdings=()):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': cash, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in holdings],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    att = {'streak': 1, 'lastClaimedDate': kst_key(), 'lastDoubledDate': None, 'totalUsd': 0}
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "localStorage.setItem('ml.game', %s);localStorage.setItem('ml.attendance', %s);sessionStorage.setItem('ads.preview','1');})()"
            % (lang, THEME, json.dumps(json.dumps(save)), json.dumps(json.dumps(att))))


MEASURE = """() => {
  const cells = [...document.querySelectorAll('.sumrow > *')];
  if (cells.length !== 3) return { present: false, n: cells.length };
  const one = (cell) => {
    const v = cell.querySelector('.sumrow__v');
    const k = cell.querySelector('.sumrow__k');
    const cr = cell.getBoundingClientRect();
    const r = v.getBoundingClientRect();
    const cs = getComputedStyle(v);
    const fs = parseFloat(cs.fontSize) || 15;
    let lh = parseFloat(cs.lineHeight); if (!lh || Number.isNaN(lh)) lh = fs * 1.25;
    const range = document.createRange(); range.selectNodeContents(v);
    const tr = range.getBoundingClientRect();
    return {
      text: (v.textContent || '').trim(), fontSize: fs, lines: Math.round((r.height / lh) * 10) / 10,
      overflow: v.scrollWidth > v.clientWidth + 1,
      textRight: tr.right, cellRight: cr.right - (parseFloat(getComputedStyle(cell).paddingRight) || 0),
      invade: tr.right > cr.right + 0.5,
      cellW: Math.round(cr.width * 10) / 10,
      kOverflow: k ? k.scrollWidth > k.clientWidth + 1 : false,
    };
  };
  return { present: true, cash: one(cells[0]), pos: one(cells[1]), rank: one(cells[2]) };
}"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(1500)


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260830_sumrow'
    out.mkdir(parents=True, exist_ok=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    facts = {}

    def check(name, cond, detail=''):
        print('  %s  %s  %s' % ('PASS' if cond else '★FAIL', name, detail))
        if not cond:
            fails.append(name)

    def good(c):
        return c['lines'] < 1.6 and not c['overflow'] and not c['invade'] and not c['kOverflow']

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # 양성대조
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 270000.0))
                p = ctx.new_page()
                boot(p, base, '#/home')
                m0 = p.evaluate(MEASURE)
                if not m0.get('present'):
                    check('.sumrow 3칸 존재', False, str(m0))
                    return 1
                p.evaluate("() => { const v = document.querySelector('.sumrow__v'); v.style.fontSize = '40px'; v.style.overflow = 'visible'; }")
                p.wait_for_timeout(100)
                pc = p.evaluate(MEASURE)['cash']
                check('양성대조: 값 40px 강제 → 넘침·침범 «잡힘»', pc['overflow'] or pc['invade'], 'overflow=%s invade=%s' % (pc['overflow'], pc['invade']))
                ctx.close()

                for lang in ('ko', 'en'):
                    for width in (375, 390, 430):
                        for cash in AMOUNTS:
                            key = '%s_%s_%d_%s' % (THEME, lang, width, str(cash).replace('.', '_'))
                            ctx = br.new_context(viewport={'width': width, 'height': 812}, locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, cash))
                            p = ctx.new_page()
                            errs = []
                            p.on('pageerror', lambda e: errs.append(str(e)))
                            boot(p, base, '#/home')
                            m = p.evaluate(MEASURE)
                            c, ps, rk = m['cash'], m['pos'], m['rank']
                            check('[%s] 현금 칸 한 줄·넘침 0·침범 0 · 표기 «%s»' % (key, EXPECT[cash]),
                                  m['present'] and good(c) and c['text'] == EXPECT[cash],
                                  'text="%s" fs=%.1f lines=%s overflow=%s invade=%s cellW=%s' % (c['text'], c['fontSize'], c['lines'], c['overflow'], c['invade'], c['cellW']))
                            check('[%s] 평가금액·순위 칸 한 줄·넘침 0' % key, good(ps) and good(rk), 'pos="%s" rank="%s" rankW=%s' % (ps['text'], rk['text'], rk['cellW']))
                            if errs:
                                check('[%s] 페이지 에러 0' % key, False, errs[0][:100])
                            facts[key] = m
                            if width == 375 or cash >= 12345678.90:
                                p.screenshot(path=str(out / ('%s_%s_home.png' % (label, key))), clip={'x': 0, 'y': 0, 'width': width, 'height': 300})
                            ctx.close()
                # 평가금액 칸도 큰 값으로 한 번(보유 3종 × 40주) — 표기만 확인
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 270000.0, ['VZ', 'NVDA', 'KO']))
                p = ctx.new_page()
                boot(p, base, '#/home')
                m = p.evaluate(MEASURE)
                check('[%s_ko_375_holdings] 평가금액 칸(보유 있음) 한 줄·넘침 0' % THEME, good(m['pos']) and good(m['cash']), 'pos="%s"' % m['pos']['text'])
                p.screenshot(path=str(out / ('%s_%s_ko_375_holdings_home.png' % (label, THEME))), clip={'x': 0, 'y': 0, 'width': 375, 'height': 300})
                facts['holdings'] = m
                ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_%s_facts.json' % (label, THEME))).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n[%s/%s] 요약 칸 결함 %d건' % (label, THEME, len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
