# -*- coding: utf-8 -*-
"""
어포던스 감사 — 「눌릴 것 같은데 안 눌리는」 · 「눌리는데 안 눌려 보이는」. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_affordance.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_affordance.py <출력폴더>

★★어떻게 «실제로» 재는가 (⛔소스 grep 이 아니다)
  React 18 은 이벤트를 «루트 하나»에 붙인다. 그래서 `el.onclick` 도 없고
  `getEventListeners` 도 비어 있다 — 「핸들러가 있는가」를 DOM 으로는 못 본다.
  ⇒ ★React 가 DOM 노드에 남기는 `__reactProps$…` 를 «직접 읽는다».
    거기에 실제 `onClick` 이 들어 있다. 개발·운영 빌드 모두에서 존재한다
    (아래 대조 ①·② 가 이 «판독기 자체»가 살아 있는지 먼저 증명한다).

★판정 (양방향)
  A) ★죽은 어포던스  — «눌려 보이는데» onClick 이 없고, 눌리는 조상도 없다
       근거: cursor:pointer · 셰브런(.chev) · role="button" · aria-pressed ·
             버튼처럼 생긴 클래스(.card .li .row .chip .pill .jrow …)
  B) ★숨은 동작      — onClick 은 있는데 «눌려 보이지 않는다»
       근거: div/span 인데 cursor 가 pointer 가 아니고 role 도 없다
  C) ★작은 탭 타깃   — onClick 이 있는데 «24 CSS px» 미만
       ★Web 기준은 WCAG 2.2 AA 의 24px 다(iOS 44pt · Android 48dp 와 «다르다»)
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
from pathlib import Path


for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ★★조직 표준 headless 런처를 «경유»한다 (2026-08-22 Chief 지시).
sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}
MIN_TAP = 24  # ★WCAG 2.2 AA (Web). ⛔44 는 iOS 기준이다 — 웹에 그대로 쓰지 않는다


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve(d):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(d), **kw)

        def log_message(self, *a):
            pass

    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def init_js(theme='light'):
    return (
        "(() => {"
        "localStorage.setItem('ml.seed','20260822');"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'%s',updown:'kr'}));"
        "localStorage.setItem('ml.watchlist', JSON.stringify(['NVDA','AAPL','MSFT']));"
        "localStorage.setItem('ml.traderwatch', JSON.stringify(['BOT001','BOT002']));"
        "localStorage.setItem('ml.game', JSON.stringify(%s));"
        "})()" % (theme, json.dumps(SAVE))
    )


# ★포지션·보유·일지가 «있는» 상태로 본다 — 빈 화면에는 어포던스도 없다
SAVE = {
    'v': 1, 'savedAt': 1700000000000, 'tick': 4200,
    'account': {
        'cash': 42000,
        'holdings': [['NVDA', {'qty': 12, 'avgCost': 300}], ['AAPL', {'qty': 30, 'avgCost': 180}]],
        'levPositions': [{
            'id': 'lp1', 'ticker': 'NVDA', 'side': 'long', 'leverage': 5, 'margin': 2000,
            'notional': 10000, 'entryPrice': 330, 'qty': 30.3, 'openedTick': 4000, 'feePaid': 5,
        }],
        'optPositions': [], 'realizedPnl': -320.5, 'feesPaid': 88.2,
        'tradeCount': 11, 'liquidationCount': 1, 'topupCount': 1,
    },
    'topup': {'dateKey': '', 'usedToday': 1, 'lastTopupAt': 0},
    'prices': {'NVDA': 351.2, 'AAPL': 191.4},
}

ROUTES = [
    ('home', '#/home', '.tabbar'),
    ('stocks', '#/stocks', '.screen'),
    ('stockDetail', '#/stock/NVDA', '.orderbar'),
    ('rank', '#/rank', '.screen'),
    ('derivatives', '#/derivatives', '.screen'),
    ('journal', '#/journal', '.screen'),
    ('settings', '#/settings', '.li'),
    ('recharge', '#/recharge', '.screen'),
    ('trader', '#/trader/BOT001', '.screen'),
    ('leverage', '#/leverage/NVDA', '.screen'),
    ('option', '#/option/NVDA', '.screen'),
    ('forward', '#/contract/forward/NVDA', '.screen'),
    ('swap', '#/contract/swap/NVDA', '.screen'),
]

# ★React fiber 에서 onClick 을 «직접» 읽는다.
SCAN_JS = r"""(minTap) => {
  const propsOf = (el) => {
    for (const k in el) {
      if (k.startsWith('__reactProps$')) return el[k];
    }
    return null;
  };
  const hasClick = (el) => {
    const p = propsOf(el);
    return !!(p && (typeof p.onClick === 'function' || typeof p.onPointerDown === 'function'));
  };
  /*
   * ★★<button> 이라고 «눌리는» 게 아니다.
   *   onClick 이 없는 버튼은 ★그 자체가 「죽은 어포던스」다 — 그리고 이 앱에 실제로 있다.
   *   ⛔태그만 보고 통과시키면 이 감사가 «찾으려는 것»을 정확히 놓친다.
   */
  const clickableSelf = (el) => {
    if (hasClick(el)) return true;
    const t = el.tagName;
    if (t === 'A') return el.hasAttribute('href');
    if (t === 'BUTTON') return el.type === 'submit' && !!el.closest('form');
    return t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'LABEL';
  };
  const clickableAncestor = (el) => {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (clickableSelf(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  /*
   * ★「눌려 보이는」 근거 — 모양 규칙이 아니라 «명단»이다. 세어볼 수 있게.
   *
   * ⛔`card` 와 `seg` 는 «뺐다». [실측 2026-08-22] 이 디자인시스템에서 둘은
   *   «담는 상자»다 — 랭킹 카드·요약 카드·세그먼트 틀이 전부 card/seg 이고
   *   그 안에 진짜 버튼이 들어 있다. 명단에 두면 오탐이 ★61건 중 44건이었다.
   *   ★오탐을 남겨 두면 진짜 2건이 그 속에 묻힌다 — 그게 이 감사의 실패다.
   */
  /*
   * ⛔`jrow` 를 «뺐다» (2026-08-22). 출석이 부팅 시 일지 한 줄을 만들면서 «드러난» 오탐이다.
   *   `.jrow` 는 은행 거래내역처럼 ★«기록 줄»이다 — 셰브런도 없고 cursor:pointer 도 아니며,
   *   ★열 «상세 화면»이 존재하지 않는다. 어포던스가 «없는» 것이 맞는 상태다.
   *   ⇒ `card`·`seg` 를 뺀 것과 «같은 계열»의 오탐이다. 세 번째다.
   *   ★그전에는 하네스가 일지를 «비워» 놓고 돌아서 이 오탐이 안 보였다 —
   *     0건이 「없다」가 아니라 「그 상태를 안 만들었다」였던 것이다.
   */
  const LOOKS = ['li', 'row', 'chip', 'pill', 'iconbtn', 'btn'];
  const looksTappable = (el, cs) => {
    if (cs.cursor === 'pointer') return 'cursor:pointer';
    if (el.getAttribute('role') === 'button' || el.hasAttribute('aria-pressed')) return 'role/aria';
    if (el.querySelector(':scope > .chev')) return 'chevron';
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/);
    for (const c of cls) {
      if (LOOKS.includes(c)) return 'class:' + c;
    }
    return null;
  };
  /** ★자식 중에 «진짜 눌리는 것»이 있으면 이건 «감싸는 상자»다 — 어포던스가 아니다 */
  const wrapsClickable = (el) => {
    for (const c of el.querySelectorAll('*')) {
      if (clickableSelf(c)) return true;
    }
    return false;
  };
  /*
   * ★★의도된 예외 «명단». ⛔모양 규칙으로 봐주지 않는다 — 이유를 적어야만 들어간다.
   *   `.scrim` : 시트 뒤 배경. 누르면 닫히는 것이 «표준»이고, ⛔눌려 보이면 «안 된다»
   *              (배경이 버튼처럼 보이면 시트가 무엇인지 헷갈린다).
   */
  const HIDDEN_OK = ['scrim'];

  const deadAffordance = [], hiddenAction = [], smallTap = [], clickable = [];
  for (const el of document.querySelectorAll('.screen *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const tag = el.tagName;
    const cls = (typeof el.className === 'string' ? el.className : '');
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44);
    const self = clickableSelf(el);
    const look = looksTappable(el, cs);

    if (self) {
      clickable.push({ tag, cls, txt, w: Math.round(r.width), h: Math.round(r.height) });
      /* C) 작은 탭 타깃 — ★조상이 더 큰 눌림 영역을 가지면 «그 조상이» 타깃이다 */
      if ((r.width < minTap || r.height < minTap) && !clickableAncestor(el)) {
        smallTap.push({ tag, cls, txt, w: Math.round(r.width), h: Math.round(r.height) });
      }
      /* B) 숨은 동작 — 눌리는데 «눌려 보이지 않는다» */
      const exempt = HIDDEN_OK.some((c) => cls.split(/\s+/).includes(c));
      /* ★`cursor: text` 는 «숨은 동작»이 아니다 — 「여기 글을 쓴다」는 정확한 어포던스다.
         검색 상자가 그렇다: 눌리지만 «버튼처럼» 보이면 안 된다. */
      if (!exempt && cs.cursor !== 'text'
          && (tag === 'DIV' || tag === 'SPAN' || tag === 'LI') && cs.cursor !== 'pointer'
          && el.getAttribute('role') !== 'button' && !el.hasAttribute('aria-pressed')) {
        hiddenAction.push({ tag, cls, txt, cursor: cs.cursor });
      }
      continue;
    }
    /* A) 죽은 어포던스 — 눌려 보이는데 «자기도 조상도» 안 눌린다 */
    if (!look) continue;
    if (clickableAncestor(el)) continue;
    /* ⛔버튼·링크 «안»의 아이콘은 장식이다. 바깥 버튼 하나만 보고한다.
       ★`el.closest` 를 «자기 자신»부터 보면 ★찾으려는 그 버튼이 스스로 걸러진다 —
         실제로 그렇게 짜서 진짜 결함 2건이 «0건»으로 사라졌다. 부모부터 본다. */
    if (el.parentElement && el.parentElement.closest('button, a, label')) continue;
    /* ⛔`disabled` 는 «의도된 비활성»이다 — 어포던스가 죽은 게 아니라 «지금 못 쓰는» 것이다 */
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    /* ⛔안에 진짜 버튼을 품은 상자는 «감싸개»다 */
    if (wrapsClickable(el)) continue;
    deadAffordance.push({ tag, cls, txt, why: look, w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { deadAffordance, hiddenAction, smallTap, clickableCount: clickable.length };
}"""


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_affordance')
    out.mkdir(parents=True, exist_ok=True)
    rep = {'dist': str(DIST), 'controls': [], 'routes': {}, 'shots': []}

    def control(name, caught):
        rep['controls'].append([name, bool(caught)])
        print(f"  {'CAUGHT' if caught else 'MISSED'}  {name}")
        return bool(caught)

    if not (DIST / 'index.html').exists():
        print('FAILED: 빌드가 없다 —', DIST)
        return 1

    httpd, port = serve(DIST)
    base = f'http://127.0.0.1:{port}/'
    try:
        with open_browser() as (_pw, browser):
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(init_js('light'))
            page = ctx.new_page()
            perr = []
            page.on('pageerror', lambda e: perr.append(str(e)))
            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=40000)
            page.wait_for_timeout(3200)
            if '#/start' in page.url:
                print('FAILED: 온보딩에 머물러 있다 — 세션 주입 실패. 이 실행은 무효다.')
                return 1

            # ── 대조: «판독기»가 살아 있는가 ────────────────────────────
            print('\n대조 (판독기 생존 증명)')
            ok = True
            # ★①-a 판독기가 React props 를 «읽을 수 있는가»
            #   ⛔「탭바 버튼」으로 검사하지 마라 — 탭바는 NavLink(<a>) 라 button 이 «없다».
            #     그 오판으로 실제로 한 번 MISSED 가 났다(검사기가 아니라 «검사 대상»이 틀렸다).
            readable = page.evaluate(
                """() => {
                    let seen = 0, withClick = 0;
                    for (const el of document.querySelectorAll('*')) {
                        for (const k in el) {
                            if (!k.startsWith('__reactProps$')) continue;
                            seen++;
                            if (typeof el[k].onClick === 'function') withClick++;
                            break;
                        }
                    }
                    return { seen, withClick };
                }""")
            rep['controls'].append(['①판독 대상 노드 수', readable['seen']])
            ok &= control(f"①-a★React props 를 읽는다(노드 {readable['seen']}개)", readable['seen'] > 20)
            ok &= control(f"①-b★onClick 을 실제로 찾아낸다({readable['withClick']}개)", readable['withClick'] > 3)
            base_scan = page.evaluate(SCAN_JS, MIN_TAP)
            # 니들 A: 눌려 보이는데 안 눌리는 상자
            page.evaluate("""() => {
                const s = document.querySelector('.screen');
                const d = document.createElement('div');
                d.id = 'needleDead'; d.className = 'card'; d.textContent = 'NEEDLE DEAD';
                d.style.cursor = 'pointer'; d.style.width = '100px'; d.style.height = '40px';
                s.appendChild(d);
            }""")
            n1 = page.evaluate(SCAN_JS, MIN_TAP)
            ok &= control('②★죽은 어포던스 탐지기', len(n1['deadAffordance']) > len(base_scan['deadAffordance']))
            page.evaluate("() => document.getElementById('needleDead')?.remove()")
            # 니들 C: 작은 탭 타깃
            # ★니들은 «내 판정 기준으로 눌리는» 것이어야 한다.
            #   ⛔onClick 없는 <button> 을 심으면 «죽은 어포던스»로 잡히지 smallTap 이 안 된다
            #     (실제로 그렇게 짜서 한 번 MISSED 가 났다 — 니들이 틀렸던 것이다).
            page.evaluate("""() => {
                const s = document.querySelector('.screen');
                const a = document.createElement('a');
                a.id = 'needleSmall'; a.textContent = 'x'; a.setAttribute('href', '#needle');
                a.style.display = 'inline-block';
                a.style.width = '12px'; a.style.height = '12px'; a.style.padding = '0';
                s.appendChild(a);
            }""")
            n2 = page.evaluate(SCAN_JS, MIN_TAP)
            ok &= control('③★작은 탭 타깃 탐지기(24px 미만)', len(n2['smallTap']) > len(base_scan['smallTap']))
            page.evaluate("() => document.getElementById('needleSmall')?.remove()")
            ok &= control('④음성대조 — 니들을 빼면 원래대로',
                          page.evaluate(SCAN_JS, MIN_TAP)['deadAffordance'].__len__() == len(base_scan['deadAffordance']))
            if not ok:
                print('FAILED: 대조 실패 — 이 실행의 「0건」은 무효다.')
                return 1

            # ── 전 화면 순회 ───────────────────────────────────────────
            print('\n전 화면 순회')
            for name, route, sel in ROUTES:
                page.goto(base + route, wait_until='domcontentloaded')
                try:
                    page.wait_for_selector(sel, timeout=25000)
                except Exception:
                    pass
                page.wait_for_timeout(2200)
                r = page.evaluate(SCAN_JS, MIN_TAP)
                rep['routes'][name] = r
                page.screenshot(path=str(out / f'{name}.png'), full_page=True)
                rep['shots'].append(name)
                print(f"  {name:<12} 눌림 {r['clickableCount']:>3} · 죽은어포던스 {len(r['deadAffordance']):>2}"
                      f" · 숨은동작 {len(r['hiddenAction']):>2} · 작은탭 {len(r['smallTap']):>2}")

            # ── 설정 시트 4종도 연다(시트 안에도 어포던스가 있다) ────────
            page.goto(base + '#/settings', wait_until='domcontentloaded')
            page.wait_for_selector('.li', timeout=25000)
            page.wait_for_timeout(2000)
            for label in ['언어', '테마', '오를 때 색', '게임 규칙과 수수료']:
                page.eval_on_selector_all(
                    '.li',
                    'els => { const b = els.find(e => (e.textContent||"").includes(%s)); b && b.click(); }' % json.dumps(label),
                )
                page.wait_for_timeout(900)
                r = page.evaluate(SCAN_JS, MIN_TAP)
                key = 'sheet_' + label.replace(' ', '')
                rep['routes'][key] = r
                page.screenshot(path=str(out / f'{key}.png'))
                rep['shots'].append(key)
                print(f"  {key:<16} 눌림 {r['clickableCount']:>3} · 죽은어포던스 {len(r['deadAffordance']):>2}"
                      f" · 숨은동작 {len(r['hiddenAction']):>2} · 작은탭 {len(r['smallTap']):>2}")
                page.keyboard.press('Escape')
                page.wait_for_timeout(400)
                page.goto(base + '#/settings', wait_until='domcontentloaded')
                page.wait_for_timeout(1200)

            rep['pageerrors'] = perr
            ctx.close()
    finally:
        httpd.shutdown()

    # ── 표 ────────────────────────────────────────────────────────────
    tot = {'deadAffordance': 0, 'hiddenAction': 0, 'smallTap': 0}
    print('\n★찾은 것 전량')
    for name, r in rep['routes'].items():
        for kind in tot:
            for it in r[kind]:
                tot[kind] += 1
                print(f'  [{kind}] {name}: <{it["tag"]}> "{it.get("cls","")}" '
                      f'{it.get("why","")} {it.get("cursor","")} '
                      f'{it.get("w","")}x{it.get("h","")}  «{it["txt"]}»')
    print('\n합계  죽은 어포던스 %d · 숨은 동작 %d · 작은 탭 타깃 %d · pageerror %d'
          % (tot['deadAffordance'], tot['hiddenAction'], tot['smallTap'], len(rep.get('pageerrors', []))))
    rep['total'] = tot
    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"스크린샷 {len(rep['shots'])}장 → {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
