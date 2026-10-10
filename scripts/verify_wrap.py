# -*- coding: utf-8 -*-
"""
«불필요한 줄바꿈» 전수 검사 + 랭킹 토글 «위아래 간격» 실측 — ★headless 전용.

  ML_DIST=dist python scripts/verify_wrap.py

★무엇을 잡나: 한 줄이어야 하는 «짧은 요소»(알약·버튼 라벨·배지·숫자 열·행 이름·요약 값·앱바 로고)가
  «두 줄 이상»으로 접힌 경우. 로케일 2종(ko/en) × 뷰포트 3종(375/390/430) 전수.
★판정: 요소 높이 / 줄높이 >= 1.6 → 2줄 이상. 줄높이가 normal 이면 font-size × 1.25 로 본다.
⛔양성대조 먼저: 일부러 좁힌 요소(폭 40px 로 강제한 알약)가 «잡히는지» 확인하고 본검사로 간다.
★랭킹 토글 간격: rkbar 하단 → 토글 상단 · 토글 하단 → 다음 블록(중앙은행 카드) 상단 · 카드 → 포디움.
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
HOLD = ['VZ', 'NVDA', 'KO']


def init(lang, season_end=None):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    js = ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
          "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
          "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
          "localStorage.setItem('ml.game', %s);sessionStorage.setItem('ads.preview','1');") % (lang, json.dumps(json.dumps(save)))
    if season_end is not None:
        js += "localStorage.setItem('ml.season', JSON.stringify(%s));" % json.dumps(season_end)
    return js + "})()"


SEL = ('.pill, .btn, .badge, .chargechip, .eqnum, .cbcard__nm, .cbcard__sub, .kv__v, .sumrow__v, .sumrow__k, .row__nm, .rk__nm, '
       '.viewchip, .seg button, .appbar__big, .logo, .gameday, .pod__nm, .rk__a, .rk__p, .row__p, .row__c, .li, '
       '.seasongate__title, .btn__sub, .sechead h3, .sec__h, .cbsheet__h, '
       '.attchip, .attstrip__v, .attsum__t, .attsum__next, .herotop__greet, '
       '.cpsheet__h, .opt__t, .opt__s, .cprow__nm, .cprow__v, .cprow__q, .cprow__skip, .cpbtn, '
       '.sumrow__v--long, .sumrow__v--xlong, .eqpnl .num, .eqnum--long, .eqnum--xlong, .cbleg, .cbsession')

WRAPS = """(sel) => {
  const out = [];
  document.querySelectorAll(sel).forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.height === 0 || r.width === 0) return;
    /* 두 줄이 «설계»인 것은 뺀다: 부제(.btn__sub)를 «품은» 버튼 · 보유 행의 「금액 (수익률)」 두 줄 열 */
    if (e.querySelector('.btn__sub')) return;
    if (e.classList.contains('row__c') && /\\(/.test(e.textContent || '')) return;
    const cs = getComputedStyle(e);
    const fs = parseFloat(cs.fontSize) || 14;
    let lh = parseFloat(cs.lineHeight);
    if (!lh || Number.isNaN(lh)) lh = fs * 1.25;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const inner = r.height - pad;
    const lines = inner / lh;
    if (lines >= 1.6) out.push({ cls: (e.className || e.tagName).toString().slice(0, 40), text: (e.textContent || '').trim().slice(0, 40), h: Math.round(inner), lh: Math.round(lh), lines: Math.round(lines * 10) / 10 });
  });
  return out;
}"""

RANKGAPS = """() => {
  /* ★«보이는 것» 사이 거리 — 상자가 아니라 알약·카드·아바타의 실제 경계로 잰다 */
  const q = (s) => document.querySelector(s);
  const bar = q('.rkbar');
  const panelCard = bar && bar.nextElementSibling && bar.nextElementSibling.querySelector('.card') ? bar.nextElementSibling.querySelector('.card') : null;
  const pill = q('.rkbar ~ .pillrow .pill');
  const cb = q('.cbcard');
  const pod = q('.podium');
  const firstAv = pod ? pod.querySelector('.pod .av') : null;
  const b = (e) => e ? e.getBoundingClientRect() : null;
  const g = (a, c) => (a && c) ? Math.round((c.top - a.bottom) * 10) / 10 : null;
  const above = panelCard ? b(panelCard) : b(bar);
  return {
    aboveIs: panelCard ? 'panelCard' : 'rkbar',
    aboveToPill: g(above, b(pill)),
    pillToCb: g(b(pill), b(cb)),
    cbToPodiumBox: g(b(cb), b(pod)),
    cbToPodiumAvatar: g(b(cb), b(firstAv)),
    pillToPodiumBox: g(b(pill), b(pod)),
    pillToPodiumAvatar: g(b(pill), b(firstAv)),
  };
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
    p.wait_for_timeout(1800)


def main():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    report = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # ── 양성대조: 알약을 40px 로 강제해 «잡히는지» ─────────────────
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(init('ko'))
                p = ctx.new_page()
                boot(p, base, '#/rank')
                p.evaluate("""() => { const e = document.querySelector('.pill'); e.style.whiteSpace = 'normal'; e.style.width = '40px'; e.style.display = 'block'; }""")
                p.wait_for_timeout(200)
                hits = p.evaluate(WRAPS, SEL)
                fired = any(h['cls'].startswith('pill') for h in hits)
                print('  %s  양성대조: 폭 40px 로 강제한 알약이 «잡힌다» (%d건)' % ('PASS' if fired else '★FAIL', len(hits)))
                if not fired:
                    fails.append('positive-control')
                ctx.close()

                for lang in ('ko', 'en'):
                    for width in (375, 390, 430):
                        ctx = br.new_context(viewport={'width': width, 'height': 844}, locale='ko-KR' if lang == 'ko' else 'en-US')
                        ctx.add_init_script(init(lang))
                        p = ctx.new_page()
                        errs = []
                        p.on('pageerror', lambda e: errs.append(str(e)))
                        key = '%s_%d' % (lang, width)
                        report[key] = {}
                        for name, route in (('home', '#/home'), ('stocks', '?s#/stocks'), ('rank', '?r#/rank'), ('deriv', '?d#/derivatives'), ('me', '?m#/settings')):
                            boot(p, base, route)
                            if name == 'rank':
                                report[key]['rankGaps'] = p.evaluate(RANKGAPS)
                                if p.locator('.cbcard').count() > 0:
                                    p.locator('.cbcard').first.click()
                                    p.wait_for_timeout(500)
                                    report[key]['rank_cbsheet'] = p.evaluate(WRAPS, SEL)
                                    p.keyboard.press('Escape')
                                    p.wait_for_timeout(200)
                            if name == 'deriv':
                                p.locator('.derivcta button').first.click()
                                p.wait_for_timeout(500)
                                report[key]['deriv_picker'] = p.evaluate(WRAPS, SEL)
                                p.keyboard.press('Escape')
                                p.wait_for_timeout(200)
                            report[key][name] = p.evaluate(WRAPS, SEL)
                        ctx.close()
                        # 시즌 게이트
                        ctx2 = br.new_context(viewport={'width': width, 'height': 844}, locale='ko-KR' if lang == 'ko' else 'en-US')
                        ctx2.add_init_script(init(lang, {'endAt': 1000, 'n': 1, 'extended': 0}))
                        p2 = ctx2.new_page()
                        boot(p2, base, '?g#/home')
                        report[key]['seasongate'] = p2.evaluate(WRAPS, SEL) if p2.locator('.seasongate').count() else []
                        ctx2.close()
                        total = sum(len(v) for k, v in report[key].items() if k != 'rankGaps')
                        print('  %-7s 줄바꿈 %d건  랭킹간격 %s' % (key, total, json.dumps(report[key]['rankGaps'])))
                        for k, v in report[key].items():
                            if k == 'rankGaps':
                                continue
                            for h in v:
                                print('      [%s] %s  "%s"  h=%d lh=%d lines=%.1f' % (k, h['cls'], h['text'], h['h'], h['lh'], h['lines']))
                                fails.append('%s/%s/%s' % (key, k, h['cls']))
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    out = Path(os.environ['ML_WRAP_OUT']) if os.environ.get('ML_WRAP_OUT') else ROOT / '_verify_20260829_cbank' / 'wrap_report.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n줄바꿈 결함 %d건' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
