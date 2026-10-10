# -*- coding: utf-8 -*-
"""
배당이 «화면에 보이는가» — ★headless 전용. (2026-08-23)

══════════════════════════════════════════════════════════════════════════
★이 파일의 이력 — 판정은 두 번 났고, 두 번째는 «처방»이 뒤집혔다
══════════════════════════════════════════════════════════════════════════
1차(배선 전): ①토스트 0건 ②일지 0회 ④상세 0회 ⇒ 「배당이 화면에 도달하지 않는다」
   ⇒ 그때 내 처방은 「출시노트에서 배당 줄을 빼라」였고 ★그게 틀렸다.
   President 가 «지시한 기능»이었다. 「기능이 안 보인다」의 처방은 «삭제»가 아니라 «구현»이다.
2차(이 파일): 배선을 «만든 뒤» 같은 검사를 다시 돌려 «보이는가»를 증명한다.

══════════════════════════════════════════════════════════════════════════
⛔★1차에서 «내가 만든» 오탐 3건 — 다시 밟지 마라
══════════════════════════════════════════════════════════════════════════
① 셀렉터 무효를 FAIL 로 셌다. 총자산은 PriceText 라 «안정적인 클래스가 없다».
   `''` 반환은 앱의 실패가 «아니라» 검사기의 실패다. ⇒ 라벨 뒤 본문을 뜬다.
② 부분일치가 «티어 라벨»에 걸렸다. VZ 의 tierKo 가 「우량배당」이다(StockDetail.tsx).
   ⇒ ★그래서 이 파일은 「배당」이 아니라 ★「배당수익률」/「Dividend yield」로 «좁혀서» 센다.
     그 문자열은 새 줄에만 있고 티어 라벨엔 없다.
③ ☠️★양성대조가 «측정을 오염»시켰다. `.toast-host` 는 AppFrame 소속이라
   해시 라우팅으로 내비게이션해도 «안 죽는다». 심어 둔 문자열이 이후 본문에 섞여
   ②④⑤ 가 «전부 거짓 PASS» 로 뒤집혔다.
   ⇒ ★규율 V: 양성대조는 ①본검사 «전»에 끝내고 ②반드시 «되돌리고»
     ③되돌아갔음을 «별도 검사 항목»으로 검사하라. (아래 ⓪b 가 그것이다)

══════════════════════════════════════════════════════════════════════════
★시간 문제 — 두 단계로 나눈 이유
══════════════════════════════════════════════════════════════════════════
배당은 종목마다 750틱(=실제 25분) 주기다. 가짜 시계로 앞당긴다.
⛔①한 번에 크게 뛰면 «틱이 버려진다» — store.pump() 가 `min(due, MAX_CATCHUP_TICKS=300)`
  으로 자르고 `lastTickAt += due * TICK_MS` 로 소비 못 한 만큼을 건너뛴다.
⛔②★그리고 크게 뛰면 «토스트가 같이 사라진다» — showToast 의 소멸 타이머가
  `window.setTimeout(..., 2600)` 인데 가짜 시계가 그것도 «만료»시킨다.
  ⇒ 그래서 토스트를 잡는 구간은 ★1틱(2,400ms)씩 «미세 스텝»으로 간다.
    2,400 < 2,600 이라 토스트가 «만들어진 스텝의 끝»에서 아직 살아 있다.
    ⇒ 이건 «운»이 아니라 두 상수의 대소 관계다. TICK_MS 나 2600 이 바뀌면 여기가 깨진다.

★보유는 «저장본»으로 심는다 — 매수 UI 를 몰아 조작하는 것보다 견고하다.
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
VIEW = {'width': 390, 'height': 844}

# ★배당수익률이 높은 종목 위주 — 효과가 가장 «잘 보이는» 자리에서 본다
HOLDINGS = ['VZ', 'T', 'XOM', 'CVX', 'KO', 'PG', 'JNJ', 'PM', 'ABBV', 'MRK']

# ★1틱(ms). store 의 TICK_MS 와 «같아야» 한다. 실측으로 맞췄다(180s -> 75틱).
TICK_MS = 2400
# 토스트 소멸(ms) — store.showToast 의 상수. ⛔TICK_MS 보다 «커야» 토스트를 잡는다
TOAST_MS = 2600

# ★음성대조 — 배당이 «없어야» 하는 종목. 두 갈래를 «둘 다» 넣는다:
#   ⓐ assetClass 로 걸리는 것 (President: 「금이나 가상자산은 당연히 아니겠지만」)
#   ⓑ ★NO_DIVIDEND «명단»으로 걸리는 것 — TSLA 는 섹터(자동차)가 0.9% 라
#      명단이 «작동하지 않으면» 줄이 뜬다. 즉 ⓑ 가 없으면 명단은 검사되지 않는다.
NEG = [('BTC', 'assetClass=crypto'), ('GOLD', 'assetClass=commodity'),
       ('SPX', 'assetClass=index'), ('TSLA', 'NO_DIVIDEND 명단(섹터는 0.9%)')]

# 로케일별 «찾을 문자열». ⛔「배당」 같은 넓은 말을 쓰지 마라 — 티어 라벨에 걸린다
L = {
    'ko': {'yield': '배당수익률', 'toast': '배당', 'ex': '주가도', 'equity': '총 자산'},
    'en': {'yield': 'Dividend yield', 'toast': 'dividend', 'ex': 'adjusted', 'equity': 'Total value'},
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_init(lang):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {
            'cash': 50000.0,
            'holdings': [[t, {'qty': 500.0, 'avgCost': 100.0}] for t in HOLDINGS],
            'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
            'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0,
            'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0,
        },
        'topup': {'dateKey': '2026-08-23', 'usedToday': 0, 'lastTopupAt': 0},
        'prices': {},
    }
    settings = {'lang': lang, 'theme': 'light', 'updown': 'kr'}
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', %s);"
        "localStorage.setItem('ml.game', %s);"
        "})()" % (json.dumps(json.dumps(settings)), json.dumps(json.dumps(save)))
    )


OBSERVER = """() => {
  window.__toasts = [];
  new MutationObserver(() => {
    document.querySelectorAll('.toast__txt').forEach((e) => {
      const t = (e.textContent || '').trim();
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}"""

LIVE_TOAST = """() => {
  const e = document.querySelector('.toast__txt');
  return e ? (e.textContent || '').trim() : '';
}"""


def run_lang(pw, base, out, lang, check):
    """한 로케일 전체 패스. 결과 dict 를 돌려준다."""
    w = L[lang]
    tag = lang.upper()
    info = {}
    browser = pw.chromium.launch(headless=True)
    try:
        ctx = browser.new_context(viewport=VIEW, device_scale_factor=2,
                                  locale='ko-KR' if lang == 'ko' else 'en-US')
        ctx.add_init_script(make_init(lang))
        p = ctx.new_page()
        errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))

        p.goto(base + '#/home', wait_until='domcontentloaded')
        p.wait_for_selector('.tabbar', timeout=60000)
        # ★워밍업(1,500틱)은 «첫 페인트 뒤» 청크로 돈다. 가짜 시계를 심기 «전»에 끝나야 한다
        p.wait_for_timeout(5000)
        p.evaluate(OBSERVER)

        day0 = p.evaluate("""() => (document.querySelector('.gameday')||{}).textContent || ''""")
        p.clock.install()

        # ── ⓪ 양성대조 → ⓪b 되돌림 «검사» (규율 V) ─────────────────────
        p.evaluate("""() => {
          const host = document.querySelector('.toast-host') || document.body;
          const el = document.createElement('span');
          el.className = 'toast__txt'; el.id = '__ctl_probe';
          el.textContent = 'ZZCONTROLZZ';
          host.appendChild(el);
        }""")
        p.wait_for_timeout(300)
        ctl_ok = 'ZZCONTROLZZ' in p.evaluate('() => window.__toasts || []')
        p.evaluate("""() => {
          const e = document.getElementById('__ctl_probe');
          if (e && e.parentNode) e.parentNode.removeChild(e);
          window.__toasts = (window.__toasts || []).filter((t) => t.indexOf('ZZCONTROLZZ') < 0);
        }""")
        p.wait_for_timeout(300)
        clean = p.evaluate("""() => !(document.body.innerText||'').includes('ZZCONTROLZZ')
                                  && !(window.__toasts||[]).some((t)=>t.indexOf('ZZCONTROLZZ')>=0)""")
        check(tag, '⓪ 양성대조: 관측자가 토스트를 «잡는다»', ctl_ok, '심으니 잡혔다')
        check(tag, '⓪b ★양성대조 흔적을 «지웠다»(오염 방지)', clean, '본문·버퍼 모두 잔존 0')

        # ── ① 배당 토스트를 «살아 있는 채로» 잡는다 ────────────────────
        # ⛔크게 뛰면 소멸 타이머(2,600ms)까지 만료된다 ⇒ 1틱씩 «미세 스텝»
        live, steps = '', 0
        for i in range(900):          # 750틱 = 한 주기 ⇒ 900이면 «반드시» 한 번은 지난다
            p.clock.fast_forward(TICK_MS)
            steps = i + 1
            live = p.evaluate(LIVE_TOAST)
            if live:
                break
        day1 = p.evaluate("""() => (document.querySelector('.gameday')||{}).textContent || ''""")
        info.update(day0=day0, day1=day1, steps=steps, live_toast=live)
        if live:
            p.screenshot(path=str(out / ('10_%s_toast.png' % lang)))
        check(tag, '① 배당 토스트가 «화면에 떠 있다»',
              bool(live) and w['toast'].lower() in live.lower(),
              '%d틱 만에 포착: %r' % (steps, live))
        # ★②배당락 «설명»이 그 토스트 안에 있는가 — Partner 가 「제일 중요하다」고 한 항목
        check(tag, '② ★배당락 설명이 토스트에 «같이» 있다',
              bool(live) and w['ex'].lower() in live.lower(),
              '「%s」 포함 여부' % w['ex'])

        toasts = p.evaluate('() => window.__toasts || []')
        info['toasts'] = toasts

        # ── ③ 거래 일지 ────────────────────────────────────────────────
        p.goto(base + '#/journal', wait_until='domcontentloaded')
        p.wait_for_timeout(2500)
        # ★구조로 센다 — 배지 클래스는 «배당 줄에만» 붙는다(문자열 부분일치보다 날카롭다)
        jbadge = p.evaluate("""() => document.querySelectorAll('.pbadge--div').length""")
        jtext = p.evaluate("""() => document.body.innerText || ''""")
        p.screenshot(path=str(out / ('11_%s_journal.png' % lang)))
        info['journal_badges'] = jbadge
        check(tag, '③ 거래 일지에 배당 줄이 «보인다»', jbadge > 0,
              '.pbadge--div %d개 · 배당락 설명 %s'
              % (jbadge, '있음' if w['ex'].lower() in jtext.lower() else '없음'))
        check(tag, '③b 일지 줄에 배당락 설명이 «남아 있다»', w['ex'].lower() in jtext.lower(),
              '토스트는 사라지지만 이 줄은 남는다')

        # ── ③c ☠️★잘림 검사 — `innerText` 가 «못 보는» 사각지대 ──────────
        #   `.jrow__d` 는 white-space:nowrap + text-overflow:ellipsis 다(app.css:2385).
        #   ⇒ CSS 로 잘려도 innerText 는 «전문»을 돌려준다 ⇒ 위 ③b 는 «잘려도 PASS» 다.
        #   ★실제로 1차 실렌더에서 「배당을 준 만큼 주가도 조…」로 잘려 있었고,
        #     ③b 는 그때도 PASS 였다. 텍스트 검사로는 영원히 못 잡는다.
        #   ⇒ 브라우저에게 «넘쳤는지»를 직접 묻는다.
        #   ★배당 «줄에만» 묻는다 — 다른 상품 줄이 길어서 나는 실패와 섞이면 판정이 흐려진다.
        #   ★그리고 이 검사 «자체»의 양성대조를 붙인다(규율 V):
        #     긴 문자열을 넣어 «검출되는지» 보고 → 되돌리고 → 되돌아갔는지 «검사»한다.
        clip = p.evaluate("""() => {
          const row = [...document.querySelectorAll('.jrow')]
            .find((r) => r.querySelector('.pbadge--div'));
          if (!row) return { found: false };
          const e = row.querySelector('.jrow__d');
          if (!e) return { found: false };
          /* ⛔★[내가 한 번 틀린 자리 — 기록해 둔다]
             처음엔 `scrollWidth > clientWidth - 8` 로 «여유 마진»을 재려 했다. ★그건 불가능하다.
             `scrollWidth` 는 넘치지 «않는» 한 언제나 `clientWidth` 와 «똑같다».
             그래서 226/226 을 보고 「여유 0 인 한계」로 읽었는데 ★그냥 「들어간다」였다.
             ⇒ 실제 «글자 폭»은 Range 로 재야 한다. 그래야 여유를 «숫자로» 말할 수 있다. */
          const textW = (el) => {
            const r = document.createRange();
            r.selectNodeContents(el);
            return Math.ceil(r.getBoundingClientRect().width);
          };
          const over = (el) => textW(el) > el.clientWidth;
          const real = {
            t: (e.textContent || '').trim(),
            textW: textW(e), boxW: e.clientWidth, spare: e.clientWidth - textW(e),
          };
          const clipped = over(e);
          // ★양성대조 — 일부러 넘치게 해 본다
          const keep = e.textContent;
          e.textContent = keep + ' ZZLONGZZ'.repeat(20);
          const ctlDetected = over(e);
          e.textContent = keep;                       // ⛔반드시 되돌린다
          const restored = e.textContent === keep && !over(e) === !clipped;
          return { found: true, clipped, real, ctlDetected, restored };
        }""")
        info['clip'] = clip
        check(tag, '③c-대조 ★잘림 검사가 «잘림을 잡는다»',
              bool(clip.get('found')) and bool(clip.get('ctlDetected')),
              '일부러 넘치게 하니 검출됨 · 되돌림 %s' % ('OK' if clip.get('restored') else '★실패'))
        check(tag, '③c ☠️일지 배당 줄이 «잘리지 않는다»(CSS 말줄임)',
              bool(clip.get('found')) and not clip.get('clipped'),
              '%s  ⛔innerText 로는 «못 잡는» 결함이다' % (clip.get('real') or clip))

        # ── ④ 종목 상세 배당수익률 (양성) ──────────────────────────────
        p.goto(base + '#/stock/VZ', wait_until='domcontentloaded')
        p.wait_for_timeout(2000)
        vz = p.evaluate("""() => document.body.innerText || ''""")
        p.screenshot(path=str(out / ('12_%s_stock_VZ.png' % lang)))
        info['vz_has_yield'] = w['yield'] in vz
        check(tag, '④ 종목 상세에 «배당수익률»이 보인다 (VZ)', w['yield'] in vz,
              '「%s」 %d회  ⛔티어라벨「우량배당」과 «다른 문자열»로 셌다'
              % (w['yield'], vz.count(w['yield'])))

        # ── ④b ★음성대조 — 배당 없는 자산에는 «줄이 없어야» 한다 ───────
        negbad = []
        for tk, why in NEG:
            p.goto(base + '#/stock/%s' % tk, wait_until='domcontentloaded')
            p.wait_for_timeout(1400)
            txt = p.evaluate("""() => document.body.innerText || ''""")
            if w['yield'] in txt:
                negbad.append('%s(%s)' % (tk, why))
            if tk in ('BTC', 'TSLA'):
                p.screenshot(path=str(out / ('13_%s_neg_%s.png' % (lang, tk))))
        info['neg_bad'] = negbad
        check(tag, '④b ★음성대조: 배당 없는 자산엔 «줄이 안 뜬다»', not negbad,
              '검사 %d종(%s) · 새어나온 것: %s'
              % (len(NEG), ' · '.join(t for t, _ in NEG), negbad or '없음'))

        check(tag, 'pageerror 0', len(errs) == 0, str(errs[:2]))
        info['errs'] = errs
    finally:
        browser.close()
    return info


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_dividend_ui')
    out.mkdir(parents=True, exist_ok=True)
    if not TICK_MS < TOAST_MS:
        print('[FAIL] TICK_MS(%d) < TOAST_MS(%d) 여야 토스트를 잡는다' % (TICK_MS, TOAST_MS))
        return 1

    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    rep = {'checks': [], 'fail': [], 'lang': {}}

    def check(tag, name, ok, detail=''):
        rep['checks'].append([tag, name, bool(ok), detail])
        if not ok:
            rep['fail'].append(['%s %s' % (tag, name), detail])
        print('  [%s] %s  %s  %s' % (tag, 'PASS' if ok else '★FAIL', name, detail))

    try:
        with sync_playwright() as pw:
            for lang in ('ko', 'en'):
                print('── %s ──────────────────────────────' % lang.upper())
                rep['lang'][lang] = run_lang(pw, base, out, lang, check)
    finally:
        httpd.shutdown()
        httpd.server_close()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    n = len(rep['fail'])
    print('\n검사 %d건 · ★실패 %d건 -> %s' % (len(rep['checks']), n, out))
    for lang, i in rep['lang'].items():
        print('  %s  %s -> %s (%d틱) · 토스트 %r' %
              (lang, i.get('day0'), i.get('day1'), i.get('steps', 0), i.get('live_toast')))
    print('⇒ %s' % ('★배당이 «화면에 보인다». ko/en 양쪽 · 음성대조 통과'
                    if n == 0 else '★아직 안 보이는 자리가 있다 — 위 FAIL 을 봐라'))
    return 1 if n else 0


if __name__ == '__main__':
    sys.exit(main())
