# -*- coding: utf-8 -*-
"""
큰 금액(십억·조) 저장본에서 «넘침 0» 실측 — ★headless 전용. ⛔창을 띄우지 않는다.

  ML_DIST=dist/web [ML_THEME=dark] python scripts/verify_bigmoney.py <라벨> [출력폴더]

★무엇을 재나 (ko/en × 375/390/430 × 현금 2종 = $1,000,039,640.53 · $1,000,000,039,640.53):
  홈·순위·일지·설정·프로필(나) 의 모든 .num/.eqnum/.sumrow__v/.rk__a/.kv__v 요소가
    ① 넘침 0(scrollWidth ≤ clientWidth+1) ② 오른끝 ≤ 화면 ③ 홈 총자산 표기 「$1.00B」/「$1.00T」(bigMoney) ④ 페이지 에러 0
★현금은 저장본(ml.game)으로 «심는다» — 앱에 지급 경로가 없다(있으면 안 된다). 출석 보너스가 값을 흔들지 않게 «오늘 이미 받은» 원장을 같이 심는다.
⛔양성대조 먼저: .num 하나를 폭 20px 로 강제해 검사기가 «잡히는지».
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
CASES = [(1000039640.53, '$1.00B'), (1000000039640.53, '$1.00T')]


def kst_key():
    return datetime.now(KST).strftime('%Y-%m-%d')


def init(lang, cash):
    save = {
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {'cash': cash, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in ('VZ', 'NVDA', 'KO')],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    att = {'streak': 1, 'lastClaimedDate': kst_key(), 'lastDoubledDate': None, 'totalUsd': 0}
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
            "localStorage.setItem('ml.game', %s);localStorage.setItem('ml.attendance', %s);sessionStorage.setItem('ads.preview','1');})()"
            % (lang, THEME, json.dumps(json.dumps(save)), json.dumps(json.dumps(att))))


NUMSCAN = """() => {
  const bad = [];
  document.querySelectorAll('.num, .eqnum, .sumrow__v, .rk__a, .kv__v').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const over = e.scrollWidth > e.clientWidth + 1;
    const out = r.right > window.innerWidth + 0.5;
    if (over || out) bad.push({ cls: (e.className || '').toString().slice(0, 30), text: (e.textContent || '').trim().slice(0, 30), over, out });
  });
  return bad;
}"""
EQ = "() => ((document.querySelector('.eqnum') || {}).textContent || '').trim()"


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
    fails = []
    facts = {}

    def check(name, cond, detail=''):
        print('  %s  %s  %s' % ('PASS' if cond else '★FAIL', name, detail))
        if not cond:
            fails.append(name)

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # 양성대조
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', CASES[1][0]))
                p = ctx.new_page()
                boot(p, base, '#/home')
                p.evaluate("() => { const e = document.querySelector('.num'); if (e) { e.style.display = 'inline-block'; e.style.width = '20px'; e.style.overflow = 'hidden'; e.style.whiteSpace = 'nowrap'; } }")
                pc = p.evaluate(NUMSCAN)
                check('양성대조: .num 폭 20px 강제 → 넘침 «잡힘»', len(pc) >= 1, str(pc[:1]))
                ctx.close()

                for cash, want in CASES:
                    for lang in ('ko', 'en'):
                        for width in (375, 390, 430):
                            key = '%s_%s_%d_%s' % (THEME, lang, width, want.replace('$', '').replace('.', '_'))
                            ctx = br.new_context(viewport={'width': width, 'height': 812}, locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, cash))
                            p = ctx.new_page()
                            errs = []
                            p.on('pageerror', lambda e: errs.append(str(e)))
                            bad_all = {}
                            for name, route in (('home', '#/home'), ('rank', '#/rank'), ('journal', '#/journal'), ('settings', '#/settings')):
                                boot(p, base, route)
                                if name == 'rank':
                                    p.wait_for_timeout(800)
                                bad = p.evaluate(NUMSCAN)
                                if bad:
                                    bad_all[name] = bad
                                if width == 375:
                                    p.screenshot(path=str(out / ('%s_%s_%s.png' % (label, key, name))))
                            # 프로필(나) — 설정 화면 첫 카드(계정) 탭
                            boot(p, base, '#/settings')
                            p.locator('.scroll .card').first.click()
                            p.wait_for_timeout(1200)
                            bad = p.evaluate(NUMSCAN)
                            if bad:
                                bad_all['profile'] = bad
                            if width == 375:
                                p.screenshot(path=str(out / ('%s_%s_profile.png' % (label, key))))
                            boot(p, base, '#/home')
                            eq = p.evaluate(EQ)
                            check('[%s] 홈·순위·일지·설정·프로필 .num 넘침 0 · 총자산 «%s»' % (key, want), not bad_all and eq == want and not errs,
                                  'eq=%s bad=%s err=%s' % (eq, json.dumps(bad_all, ensure_ascii=False)[:160], (errs or [''])[0][:80]))
                            facts[key] = {'bad': bad_all, 'eq': eq, 'errs': errs[:2]}
                            ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_%s_bigmoney_facts.json' % (label, THEME))).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n[%s/%s] 큰 금액 넘침 결함 %d건' % (label, THEME, len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
