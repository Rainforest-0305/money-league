# -*- coding: utf-8 -*-
"""
대비 · 터치타깃 «측정» — ★headless 전용. (Partner 지시 2026-08-23)

  ML_DIST=dist python scripts/verify_a11y.py [ko|en]

★기준 (외우지 말고 이대로 쓴다)
  본문 4.5:1 · 큰 글씨(>=18px 또는 bold >=14px) 3:1 · placeholder 도 4.5:1
  터치타깃 ★Web = WCAG 2.2 AA «24 CSS px»
  ⛔「44 로 통일」은 틀렸다 — 그건 iOS 44pt · Android 48dp 이고 Web 기준이 아니다.

★배경은 «조상까지 거슬러» 찾는다 — 대부분의 요소가 transparent 라
  자기 배경만 보면 전부 rgba(0,0,0,0) 이 나와 «측정이 안 된다».
★반투명 전경은 배경과 «합성»해서 실제로 보이는 색으로 만든 뒤 잰다.
⛔「고칠 게 없었다」도 산출물이다. 반드시 «값»과 함께 보고한다.
"""
import http.server
import json
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

INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'light',updown:'kr'}));"
        "})()")

SCREENS = [('home', '#/home'), ('stocks', '#/stocks'), ('rank', '#/rank'),
           ('deriv', '#/derivatives'), ('me', '#/me'), ('journal', '#/journal'),
           ('stock', '#/stock/VZ'), ('recharge', '#/recharge')]

PROBE = r"""() => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.95) return c;
      n = n.parentElement;
    }
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return b && b.a > 0.95 ? b : { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (f, b) => {
    const a = f.a === undefined ? 1 : f.a;
    const mix = { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) };
    const l1 = lum(mix.r, mix.g, mix.b);
    const l2 = lum(b.r, b.g, b.b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };

  const text = [];
  const seen = new Set();
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim();
    if (!own) return;
    const fg = parse(cs.color);
    if (!fg) return;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize);
    const w = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 18 || (w >= 700 && size >= 14);
    const need = large ? 3.0 : 4.5;
    const cr = ratio(fg, bg);
    const key = own.slice(0, 14) + '|' + cs.color + '|' + Math.round(size);
    if (seen.has(key)) return;
    seen.add(key);
    text.push({ t: own.slice(0, 18), size: Math.round(size), w: w, large: large, need: need,
                cr: Math.round(cr * 100) / 100, cls: (el.className || '').toString().slice(0, 22) });
  });

  document.querySelectorAll('input[placeholder]').forEach((el) => {
    const ph = getComputedStyle(el, '::placeholder');
    const fg = parse(ph.color) || parse(getComputedStyle(el).color);
    if (!fg) return;
    const bg = bgOf(el);
    text.push({ t: '[placeholder]', size: Math.round(parseFloat(getComputedStyle(el).fontSize)),
                w: 400, large: false, need: 4.5,
                cr: Math.round(ratio(fg, bg) * 100) / 100, cls: 'placeholder' });
  });

  const hits = [];
  document.querySelectorAll('button, a[href], input, select, [role="button"], [role="tab"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none') return;
    hits.push({ t: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 16),
                w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
                cls: (el.className || '').toString().slice(0, 22) });
  });
  return { text: text, hits: hits };
}"""

CTL_ADD = """() => {
  const d = document.createElement('div');
  d.id = 'zzctrl';
  d.style.cssText = 'background:#fff;color:#777;font-size:13px;position:fixed;top:0;left:0;z-index:99999';
  d.textContent = 'ZZCTRLZZ';
  document.body.appendChild(d);
}"""
CTL_DEL = """() => { const d = document.getElementById('zzctrl'); if (d) d.remove(); }"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def main():
    lang = sys.argv[1] if len(sys.argv) > 1 else 'ko'
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    bad_c = []
    bad_t = []
    n_c = 0
    n_t = 0
    min_cr = 99.0
    min_hit = 9999.0
    ctl_ok = False
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844},
                                     locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx.add_init_script(INIT % lang)
                p = ctx.new_page()
                p.goto(base + '#/home', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=120000)
                p.wait_for_selector('.boot', state='detached', timeout=180000)
                p.wait_for_timeout(2200)

                # ★양성대조 — 계산기가 «맞는지» 먼저 증명한다(#777 on #fff = 4.48)
                p.evaluate(CTL_ADD)
                p.wait_for_timeout(200)
                got = [x for x in p.evaluate(PROBE)['text'] if 'ZZCTRLZZ' in x['t']]
                ctl_ok = bool(got) and abs(got[0]['cr'] - 4.48) < 0.05
                print('  %s  ★양성대조: #777 on #fff = %s (기대 4.48)'
                      % ('PASS' if ctl_ok else '★FAIL', got[0]['cr'] if got else '(못읽음)'))
                p.evaluate(CTL_DEL)
                p.wait_for_timeout(200)
                left = [x for x in p.evaluate(PROBE)['text'] if 'ZZCTRLZZ' in x['t']]
                print('  %s  ★양성대조 흔적 제거(오염 방지)  잔존 %d건'
                      % ('PASS' if not left else '★FAIL', len(left)))

                for name, route in SCREENS:
                    p.goto(base + ('?%s%s' % (name, route)), wait_until='domcontentloaded')
                    p.wait_for_selector('.screen', timeout=120000)
                    p.wait_for_selector('.boot', state='detached', timeout=180000)
                    p.wait_for_timeout(1600)
                    r = p.evaluate(PROBE)
                    for x in r['text']:
                        if 'ZZCTRL' in x['t']:
                            continue
                        n_c += 1
                        min_cr = min(min_cr, x['cr'])
                        if x['cr'] < x['need'] - 0.005:
                            bad_c.append((name, x))
                    for x in r['hits']:
                        n_t += 1
                        m = min(x['w'], x['h'])
                        min_hit = min(min_hit, m)
                        if m < 24:
                            bad_t.append((name, x))
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print('')
    print('=== ②대비 (%s) · 검사 %d개 · 화면 %d ===' % (lang, n_c, len(SCREENS)))
    print('   ★전체 최소 대비: %.2f:1' % min_cr)
    print('   ★기준 미달: %d건' % len(bad_c))
    for nm, x in bad_c[:16]:
        print('     %-9s %-19s %2dpx w%-3d %-4s  %5.2f:1 < %.1f  [%s]'
              % (nm, x['t'], x['size'], x['w'], '큰글씨' if x['large'] else '본문',
                 x['cr'], x['need'], x['cls']))
    print('')
    print('=== ③터치타깃 (Web WCAG 2.2 AA = ★24 CSS px) · 검사 %d개 ===' % n_t)
    print('   ★전체 최소 타깃: %.1f px' % min_hit)
    print('   ★기준 미달: %d건' % len(bad_t))
    for nm, x in bad_t[:16]:
        print('     %-9s %-17s %5.1f x %5.1f  [%s]' % (nm, x['t'], x['w'], x['h'], x['cls']))

    (ROOT / '_shots' / ('a11y_%s.json' % lang)).write_text(
        json.dumps({'ctl_ok': ctl_ok, 'contrast_bad': bad_c, 'hit_bad': bad_t,
                    'min_cr': min_cr, 'min_hit': min_hit, 'n_c': n_c, 'n_t': n_t},
                   ensure_ascii=False, indent=1), encoding='utf-8')
    print('')
    print('⇒ %s' % ('★양성대조 실패 — 위 숫자를 믿지 마라' if not ctl_ok else
                    '측정 완료. ⛔「고칠 게 없었다」도 값과 함께 보고한다'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
