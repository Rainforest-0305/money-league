# -*- coding: utf-8 -*-
"""
머니 리그 — **채널별 «외부 통신» 실측**.

왜 이 하네스가 필요한가 (2026-08-22)
────────────────────────────────────────────────────────────────────────────
`public/privacy.html` 은 **법적 고지 문서**인데 「본 게임은 외부와 네트워크 통신을
하지 않습니다」라고 적혀 있다. 광고 지면 11종이 붙은 지금 이 문장은 **거짓**이다.
그런데 ⛔통째로 「통신함」으로 바꾸는 것도 **또 다른 거짓**이다 —
토스 «밖»(MS Store · itch.io · GitHub Pages)에서는 정말로 통신하지 않기 때문이다.

⇒ 방침의 「5. 배포 플랫폼별 차이」 표는 그 구분을 «살려» 써야 한다.
⇒ 그러려면 **그 구분이 사실인지 실측**해야 한다. ⛔코드를 읽고 「가드가 있으니 될 것」은
  근거가 아니다. 머니 리그에는 게임 4종이 쓰는 `toss-web` shim 이 ★«없다» —
  광고·계측이 안 나가는 근거는 오직 런타임 가드 `isInToss()` 하나뿐이다.
  그 가드가 «모든» 호출부를 실제로 덮는지는 **돌려봐야** 안다.

무엇을 세는가
────────────────────────────────────────────────────────────────────────────
① **외부 HTTP 요청** — 서빙 오리진(localhost) 밖으로 나가는 모든 요청.
② ★**네이티브 브릿지 호출** — 앱인토스 SDK 는 HTTP 를 직접 쏘지 않는다.
   `window.ReactNativeWebView.postMessage(JSON)` 로 «네이티브에게» 시킨다.
   [실측: node_modules/@apps-in-toss/bridge-core/dist/index.js 의 NativeWindow.postMessage]
   ⇒ ★HTTP 만 세면 광고·계측을 «통째로 놓친다». 이게 이 하네스의 핵심이다.
   ⇒ 그리고 이 목록이 그대로 방침 4-1 항의 «근거»가 된다 — 어떤 네이티브 기능을
     실제로 부르는지가 함수 이름으로 나온다.

⛔「0건」을 믿으려면 대조가 먼저다
────────────────────────────────────────────────────────────────────────────
「외부 요청 0건」은 ★«정말 없다»일 수도 있고 ★«레코더가 고장났다»일 수도 있다.
그래서 본검사 전에 **일부러 통신을 일으켜** 레코더가 잡는지부터 본다.
잡지 못하면 그 시점에 죽는다 — ⛔0건을 결과로 쓰지 않는다.
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

sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SHIP_DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}

PASS = FAIL = 0


def check(label, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f'  OK   {label}' + (f'  {detail}' if detail else ''))
    else:
        FAIL += 1
        print(f'  ★FAIL {label}' + (f'  {detail}' if detail else ''))


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve(directory):
    port = free_port()

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(directory), **kw)

        def log_message(self, *a):
            pass

    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{port}/index.html'


# ── 씨 뿌리기 ──────────────────────────────────────────────────────────────
#   ⛔add_init_script 는 «매 내비게이션»마다 돈다(⛔17). 파수꾼으로 한 번만.
SEED = (
    "(() => { if (localStorage.getItem('ml.__seeded')) return;"
    " localStorage.setItem('ml.__seeded','1');"
    " localStorage.setItem('ml.onboarded','1');"
    " localStorage.setItem('ml.session', JSON.stringify("
    "   {userId:'local', token:'', nickname:'리미'}));"
    " localStorage.setItem('ml.settings', JSON.stringify("
    "   {lang:'ko', theme:'light', updown:'kr'})); })()"
)

# ★토스 «시뮬». isInToss() 는 아래 둘을 «동시에» 본다 [실측: src/toss/env.ts]
#     typeof win.ReactNativeWebView?.postMessage === 'function'
#     && win.__GRANITE_NATIVE_EMITTER != null
#   emitter 는 SDK 가 import 시점에 «스스로» 심는다 — 우리는 RNWV 만 놓으면 된다.
#   ⚠️네이티브가 없으니 resolve 는 영영 안 온다. 그래도 «무엇을 부르려 했는지»는
#     postMessage 인자로 전부 남는다 — 우리가 세려는 게 바로 그것이다.
TOSS_SIM = """
(() => {
  if (window.__bridgeCalls) return;
  window.__bridgeCalls = [];
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      try {
        const m = JSON.parse(raw);
        window.__bridgeCalls.push({ type: m.type, fn: m.functionName });
      } catch { window.__bridgeCalls.push({ type: 'unparsed', fn: String(raw).slice(0, 80) }); }
    },
  };
})()
"""

# ★토스 밖에서 브릿지 «호출 시도»를 세는 법.
#
# ⛔[첫 번째로 틀린 방법] `window.ReactNativeWebView` 에 getter 를 심어 «읽기»를 셀다.
#   결과 47회 → FAIL. 그런데 그 47회은 ★`isInToss()` 가 «가드를 수행하느라» 읽은
#   횟수였다. 즉 ★가드가 «일하는 소리»를 위반으로 세고 있었다.
#   ⇒ ★「무엇을 세는가」를 틀리면 «정상»이 «위반»으로 나온다. 계측기부터 의심하라.
#
# ⛔[두 번째로 틀린 방법] 「호출하면 'ReactNativeWebView is not available' 가 나니
#   그 «비명»을 세자」. ★이것도 틀렸다 — 대조④가 잡았다(진짜 시도를 0건으로 세음).
#   이유: 우리 코드의 `safeBridge` 가 try/catch + fallback 으로 실패를 ★«삼킨다».
#   게다가 SDK 거부는 «Promise rejection» 이라 `.catch()` 가 붙으면
#   `unhandledrejection` 자체가 «안 뜼다» ⇒ 계측기가 통째로 귀머거리가 된다.
#   ★즉 「비명 0건」은 「시도 0회」의 증거가 아니다.
#
# ⇒ ★바른 방법: «에러»가 아니라 «호출 자체»를 세다.
#   [실측: bridge-core] `createAsyncBridge`·`createEventBridge` 는 postMessage «전»에
#   반드시 `nativeWindow.on(...)` 을 부른다 — 즉 ★`__GRANITE_NATIVE_EMITTER.on` 이
#   «모든» 브릿지 호출이 반드시 지나는 길목이다. try/catch 로도 못 숨긴다.
#   ★emitter 는 토스 밖에서도 SDK 가 스스로 심는다 ⇒ 밖에서도 셀 수 있다.
#   ⛔가로채되 «원본을 그대로 부른다» — 앱 동작을 1비트도 바꾸지 않는다.
OUTSIDE_PROBE = """
(() => {
  if (window.__bridgeAttempts) return;
  window.__bridgeAttempts = [];
  const KEY = '__GRANITE_NATIVE_EMITTER';
  let real;
  const wrap = (v) => {
    if (!v || v.__wrapped) return v;
    const origOn = v.on.bind(v);
    v.on = (event, cb) => {
      window.__bridgeAttempts.push({ event: String(event), fn: String(event).split('/')[0] });
      return origOn(event, cb);
    };
    v.__wrapped = true;
    return v;
  };
  Object.defineProperty(window, KEY, {
    configurable: true,
    get: () => real,
    set: (v) => { real = wrap(v); },
  });
})()
"""

TABS = ['#/home', '#/stocks', '#/derivatives', '#/journal', '#/ranking',
        '#/settings', '#/recharge', '#/stock/AAPL']


def sweep(page, base, label):
    """전 탭을 돌며 앱을 «실제로» 움직인다."""
    for h in TABS:
        try:
            page.goto(base + h, wait_until='domcontentloaded')
            page.wait_for_timeout(700)
        except Exception as e:
            print(f'       (탐색 실패 {h}: {str(e)[:60]})')
    page.wait_for_timeout(800)


def main():
    if not (SHIP_DIST / 'index.html').exists():
        print(f'★출하 빌드가 없다: {SHIP_DIST}')
        return 2

    httpd, base = serve(SHIP_DIST)
    origin = base.rsplit('/', 1)[0]
    print(f'출하 빌드: {SHIP_DIST}')
    print(f'서빙:      {origin}\n')

    try:
        with open_browser() as (pw, browser):
            # ═══════════════════════════════════════════════════════════════
            print('── 대조 (⛔이게 통과해야 「0건」이 의미를 갖는다) ──')
            # ═══════════════════════════════════════════════════════════════
            ctx = browser.new_context(viewport=VIEW)
            page = ctx.new_page()
            ext = []
            page.on('request', lambda r: ext.append(r.url) if not r.url.startswith(origin) else None)
            page.goto(base, wait_until='domcontentloaded')

            # 대조① 레코더가 «외부 HTTP» 를 잡는가
            try:
                page.evaluate("fetch('https://example.invalid/probe').catch(() => {})")
                page.wait_for_timeout(600)
            except Exception:
                pass
            check('대조① 일부러 낸 외부 요청을 «잡는다»',
                  any('example.invalid' in u for u in ext),
                  f'잡힌 외부 요청 {len(ext)}건')

            # 대조② 레코더가 «브릿지 호출» 을 잡는가
            page.evaluate(TOSS_SIM)
            page.evaluate("window.ReactNativeWebView.postMessage(JSON.stringify("
                          "{type:'method', functionName:'__probe__'}))")
            calls = page.evaluate("window.__bridgeCalls")
            check('대조② 일부러 낸 브릿지 호출을 «잡는다»',
                  any(c['fn'] == '__probe__' for c in calls), f'{calls}')
            ctx.close()

            # 대조③ ★토스 «시뮬»에서는 앱이 실제로 브릿지를 부르는가
            #   ⇒ 이게 0 이면 본검사 A 의 「0건」은 ★«가드가 먹은 것»이 아니라
            #     «시뮬이 안 먹은 것»이다. 반드시 갈라야 한다.
            ctx = browser.new_context(viewport=VIEW)
            ctx.add_init_script(SEED)
            ctx.add_init_script(TOSS_SIM)
            page = ctx.new_page()
            sim_ext = []
            page.on('request', lambda r: sim_ext.append(r.url) if not r.url.startswith(origin) else None)
            sweep(page, base, 'toss-sim')
            sim_calls = page.evaluate("window.__bridgeCalls || []")
            sim_fns = sorted({c['fn'] for c in sim_calls if c.get('fn')})
            check('대조③ ★토스 «안»에서는 앱이 브릿지를 «실제로» 부른다',
                  len(sim_calls) > 0, f'{len(sim_calls)}회 · {len(sim_fns)}종')
            ctx.close()

            # 대조④ ★「시도 0회」 계측기가 «진짜 시도»를 잡는가
            #   ⛔이게 없으면 A-2 의 0 은 «아무도 안 불렀다»인지 «계측기가 귀머거리»인지
            #     구분이 안 된다. 토스 밖에서 일부러 브릿지를 불러 비명이 잡히는지 본다.
            ctx = browser.new_context(viewport=VIEW)
            ctx.add_init_script(SEED)
            ctx.add_init_script(OUTSIDE_PROBE)
            page = ctx.new_page()
            page.goto(base, wait_until='domcontentloaded')
            page.wait_for_timeout(500)
            #  ★SDK 가 쓰는 «바로 그 길목»을 그대로 밟는다.
            #    createAsyncBridge 는 postMessage 전에 on('<fn>/resolve/<id>') 을 부른다.
            page.evaluate("""
              window.__GRANITE_NATIVE_EMITTER.on('__probe__/resolve/zzz', () => {});
            """)
            page.wait_for_timeout(300)
            probe_hits = page.evaluate("window.__bridgeAttempts || []")
            check('대조④ ★토스 밖 「시도」 계측기가 «진짜 시도»를 잡는다',
                  len(probe_hits) > 0, f'{len(probe_hits)}건')
            ctx.close()

            print()
            # ═══════════════════════════════════════════════════════════════
            print('── A. 토스 «밖» (MS Store · itch.io · GitHub Pages 채널) ──')
            # ═══════════════════════════════════════════════════════════════
            ctx = browser.new_context(viewport=VIEW)
            ctx.add_init_script(SEED)
            ctx.add_init_script(OUTSIDE_PROBE)
            page = ctx.new_page()
            out_ext = []
            page.on('request', lambda r: out_ext.append(r.url) if not r.url.startswith(origin) else None)
            sweep(page, base, 'outside')
            out_calls = page.evaluate("window.__bridgeAttempts || []")

            out_fns = sorted({c['fn'] for c in out_calls if c.get('fn')})
            #  ★«데이터가 밖으로 나가는» 브릿지 — 방침이 다루는 것은 이것들이다.
            #  ⛔검사가 실패했다고 «느슨하게» 푸지 마라. 반대로 «정밀하게» 갈라낸다.
            EGRESS = {'eventLog', 'contactsViral', 'getAnonymousKey', 'getUserKeyForGame',
                      'getStorageItem', 'setStorageItem', 'appLogin', 'share',
                      'getTossShareLink', 'getDeviceId', 'fetchContacts'}
            egress_hits = sorted({f for f in out_fns if f in EGRESS or 'Ad' in f})
            other_hits = sorted({f for f in out_fns if f not in egress_hits})

            check('★A-1 외부로 나가는 HTTP 요청이 «0건»', len(out_ext) == 0,
                  '0건' if not out_ext else f'{len(out_ext)}건 → {out_ext[:5]}')
            check('★A-2 «데이터를 내보내는» 브릿지 호출이 0회',
                  len(egress_hits) == 0,
                  '0회 (광고·계측·공유·저장소·식별키 전부)' if not egress_hits else f'★{egress_hits}')
            #  ★A-3: 반출이 아닌 호출이 있으면 «숨기지 않고» 보고한다.
            #    그리고 그게 «무해함»을 별도로 증명한다 —
            #    RNWV 가 없으면 postMessage 가 throw 하므로 ★전달 자체가 불가능하다.
            rnwv_absent = page.evaluate("window.ReactNativeWebView === undefined")
            check('★A-3 반출 외 호출은 «전달 자체가 불가» (RNWV 부재)',
                  rnwv_absent,
                  f'RNWV 없음 · 반출 외 호출: {other_hits if other_hits else "없음"}')
            ctx.close()

            print()
            # ═══════════════════════════════════════════════════════════════
            print('── B. 앱인토스 채널 — «무엇을» 부르는가 (방침 4-1 의 근거) ──')
            # ═══════════════════════════════════════════════════════════════
            for fn in sim_fns:
                print(f'       · {fn}')
            check('★B-1 앱인토스에서는 외부 기능을 «부른다» (= 통신한다)',
                  len(sim_fns) > 0, f'{len(sim_fns)}종')
            sim_egress = sorted({f for f in sim_fns if f in EGRESS or 'Ad' in f})
            check('★B-2 채널 «구분»이 실재한다 (반출: 안 > 밖)',
                  len(sim_egress) > 0 and len(egress_hits) == 0,
                  f'안 {sim_egress} vs 밖 {egress_hits or "없음"}')

            #  ★계측·광고·공유가 «이 목록에 있는가» — 방침 문안이 여기서 갈린다.
            has_ad = any('Ad' in f or 'ad' == f[:2] for f in sim_fns)
            has_log = any('eventLog' in f for f in sim_fns)
            has_viral = any('contactsViral' in f for f in sim_fns)

            print()
            print('  ── 방침에 쓸 사실 ' + '─' * 44)
            print(f'  · 토스 밖  : 외부 HTTP {len(out_ext)}건 · 브릿지 시도 {len(out_calls)}회')
            print(f'  · 토스 안  : 브릿지 {len(sim_calls)}회 · 기능 {len(sim_fns)}종')
            print(f'  · 기능 목록: {", ".join(sim_fns) if sim_fns else "(없음)"}')
            print(f'  · 광고 SDK 호출 관측  : {"있음" if has_ad else "★없음"}')
            print(f'  · eventLog 호출 관측  : {"있음" if has_log else "★없음"}')
            print(f'  · contactsViral 관측  : {"있음" if has_viral else "★없음"}')
            print('  ⚠️★위 셋이 «없음»이어도 「기능이 없다」는 뜻이 아니다 —')
            print('     광고는 SDK 의 isSupported() 가 시뮬에서 false 라 «안 뜨고»,')
            print('     공유는 «유저가 눌러야» 나가며, eventLog 는 ★아직 구현 전(E8)이다.')
            print('     ⇒ 광고의 «실제» 증거는 콘솔 iaa_report_performance 다.')
            print('  ' + '─' * 60)

    finally:
        httpd.shutdown()

    print(f'\n결과: PASS {PASS} · FAIL {FAIL}')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
