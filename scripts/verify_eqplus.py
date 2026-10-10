# -*- coding: utf-8 -*-
"""
홈 총자산 줄 «+» 버튼(.eqplus) 실측 + 긴 금액 줄바꿈 0 검사 — ★headless 전용.

  ML_DIST=dist/web python scripts/verify_eqplus.py <라벨> [출력폴더]

★무엇을 재나 (ko/en × 375/390/430 × 금액 2종 = 12 케이스):
  ① 숫자(.eqnum)가 «한 줄»인가  — 높이/줄높이 < 1.6
  ② 숫자가 상자를 «넘치지» 않는가 — scrollWidth ≤ clientWidth+1 (넘치면 버튼 밑으로 파고든다)
  ③ 버튼(.eqplus)이 «같은 줄»인가 — 버튼 세로중심 − 숫자 세로중심 ≤ 3px
  ④ 버튼 크기 36~40 · 숫자 오른끝↔버튼 간격 10~12 이상 · 버튼 오른끝이 화면 안
  ⑤ 「오늘 손익」(.eqpnl)이 숫자 «바로 아래»인가 — pnl.top ≥ num.bottom
  ⑥ 접근성 라벨(aria-label)이 비어 있지 않은가
⛔양성대조 먼저: 숫자를 폭 120px·normal 로 강제해 ①이 «잡히는지», 폰트 72px 로 강제해 ②가 «잡히는지».
★BEFORE 라벨(옛 빌드 · .eqplus 없음)은 스크린샷만 남기고 측정은 「없음」으로 적는다.
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
AMOUNTS = [1234567.89, 139640.53, 12345678.90, 123456789.01]   # 13자·11자·14자·15자 — --long/--xlong 이 «실제로» 발동하는지
THEME = os.environ.get('ML_THEME', 'light')
# ★실측: 첫 부팅에 엔진이 +$5,000 을 얹는다(0일차 보너스). 화면 문자열을 spec 금액과 «같게» 만들려고 그만큼 뺀다.
BOOT_BONUS = 5000.0


def init(lang, cash):
    # 보유 0 → 총자산 == 현금 + 부팅 보너스 «정확히». 검사 금액을 그대로 화면에 띄우기 위해서다.
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': cash - BOOT_BONUS, 'holdings': [],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "localStorage.setItem('ml.game', %s);sessionStorage.setItem('ads.preview','1');})()"
            % (lang, THEME, json.dumps(json.dumps(save))))


MEASURE = """() => {
  const num = document.querySelector('.eqnum');
  const btn = document.querySelector('.eqplus');
  const pnl = document.querySelector('.eqpnl');
  const chip = document.querySelector('.chargechip');
  if (!num) return { present: false, chip: !!chip };
  const r = num.getBoundingClientRect();
  const cs = getComputedStyle(num);
  const fs = parseFloat(cs.fontSize) || 36;
  let lh = parseFloat(cs.lineHeight); if (!lh || Number.isNaN(lh)) lh = fs * 1.25;
  const range = document.createRange(); range.selectNodeContents(num);
  const tr = range.getBoundingClientRect();
  const out = {
    present: true, chip: !!chip, text: (num.textContent || '').trim(), fontSize: fs, lineHeight: lh,
    lines: Math.round((r.height / lh) * 10) / 10,
    overflow: num.scrollWidth > num.clientWidth + 1,
    numRect: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height },
    textRight: tr.right,
  };
  if (btn) {
    const b = btn.getBoundingClientRect();
    out.btn = { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
                label: btn.getAttribute('aria-label') || '', disabled: btn.disabled,
                svg: !!btn.querySelector('svg'), text: (btn.textContent || '').trim() };
    out.sameLine = Math.abs((b.top + b.bottom) / 2 - (r.top + r.bottom) / 2) <= 3;
    out.gap = Math.round((b.left - tr.right) * 10) / 10;
    out.btnInside = b.right <= window.innerWidth - 20 + 1;
  }
  if (pnl) { const p = pnl.getBoundingClientRect(); out.pnlBelow = p.top >= r.bottom - 1; out.pnlTop = p.top; }
  return out;
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
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260829_eqplus'
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
    errs = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # ── 양성대조 ─────────────────────────────────────────────
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(init('ko', AMOUNTS[0]))
                p = ctx.new_page()
                boot(p, base, '#/home')
                if p.locator('.eqnum').count():
                    # ★숫자엔 공백이 없어 word-break 없이는 «절대» 안 접힌다(넘칠 뿐) — 그래서 break-all 까지 강제해야 ①이 잡힌다
                    p.evaluate("() => { const e = document.querySelector('.eqnum'); e.style.whiteSpace='normal'; e.style.wordBreak='break-all'; e.style.width='120px'; e.style.display='block'; }")
                    p.wait_for_timeout(150)
                    m1 = p.evaluate(MEASURE)
                    p.evaluate("() => { const e = document.querySelector('.eqnum'); e.style.whiteSpace=''; e.style.wordBreak=''; e.style.width=''; e.style.display=''; e.style.fontSize='72px'; }")
                    p.wait_for_timeout(150)
                    m2 = p.evaluate(MEASURE)
                    ok1 = m1.get('lines', 0) >= 1.6
                    ok2 = bool(m2.get('overflow'))
                    print('  %s  양성대조① 폭 120px 강제 → 줄수 %.1f (잡힌다=PASS)' % ('PASS' if ok1 else '★FAIL', m1.get('lines', 0)))
                    print('  %s  양성대조② 72px 강제 → overflow %s (잡힌다=PASS)' % ('PASS' if ok2 else '★FAIL', m2.get('overflow')))
                    if not (ok1 and ok2):
                        fails.append('positive-control')
                else:
                    print('  (양성대조 생략 — .eqnum 없음 · %s 빌드)' % label)
                ctx.close()

                for lang in ('ko', 'en'):
                    for width in (375, 390, 430):
                        for cash in AMOUNTS:
                            key = '%s_%d_%s' % (lang, width, ('%.2f' % cash).replace('.', '_'))
                            ctx = br.new_context(viewport={'width': width, 'height': 844}, device_scale_factor=2,
                                                 locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, cash))
                            p = ctx.new_page()
                            p.on('pageerror', lambda e: errs.append(str(e)))
                            boot(p, base, '#/home')
                            m = p.evaluate(MEASURE)
                            facts[key] = m
                            shot = out / ('%s_%s_home.png' % (label, key))
                            p.screenshot(path=str(shot), clip={'x': 0, 'y': 0, 'width': width, 'height': 300})
                            if not m.get('present'):
                                print('  %-22s .eqnum 없음 (chip=%s) → %s' % (key, m.get('chip'), shot.name))
                                ctx.close()
                                continue
                            bad = []
                            if m['lines'] >= 1.6:
                                bad.append('two-lines')
                            if m['overflow']:
                                bad.append('overflow')
                            b = m.get('btn')
                            if not b:
                                bad.append('no-button')
                            else:
                                if not m['sameLine']:
                                    bad.append('not-same-line')
                                if not (30 <= b['h'] <= 34):
                                    bad.append('btn-size')
                                if b['text'] != ('충전' if lang == 'ko' else 'Top up'):
                                    bad.append('label-text')
                                if m['gap'] < 10:
                                    bad.append('gap<10')
                                if not m['btnInside']:
                                    bad.append('btn-offscreen')
                                if not b['label']:
                                    bad.append('no-aria-label')
                                if not b['svg']:
                                    bad.append('glyph-not-svg')
                            if m.get('pnlBelow') is False:
                                bad.append('pnl-not-below')
                            print('  %-22s %-15s fs=%4.1f lines=%.1f ovf=%-5s pill=%sx%s "%s" gap=%s same=%s aria="%s" %s'
                                  % (key, m['text'], m['fontSize'], m['lines'], m['overflow'],
                                     b and round(b['w']), b and round(b['h']), b and b['text'], m.get('gap'), m.get('sameLine'),
                                     b and b['label'], ('★' + ','.join(bad)) if bad else 'OK'))
                            for x in bad:
                                fails.append('%s/%s' % (key, x))
                            ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_facts.json' % label)).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n[%s] 결함 %d건 · pageerror %d건 %s' % (label, len(fails), len(errs), errs[:2] if errs else ''))
    for f in fails:
        print('   ★ ' + f)
    return 1 if (fails or errs) else 0


if __name__ == '__main__':
    sys.exit(main())
