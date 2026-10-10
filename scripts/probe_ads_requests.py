# -*- coding: utf-8 -*-
"""
배너 «광고 요청» 실측 프로브 — 화면별 60초 체류 시 요청 수 (2026-09-10, -33 광고 시청률 작업).
★headless 전용. ⛔창을 띄우지 않는다(President 화면 점유 금지).

  ML_DIST=dist/web python scripts/probe_ads_requests.py <라벨> [출력폴더] [--dwell 60]

★무엇을 재나
  토스 «안»을 흉내낸 상태에서 각 화면에 들어가 «가만히 + 스크롤 왕복 + 숨김/복귀»로 체류하며
  SDK 가 네이티브 브릿지로 보내는 광고 요청(fetchAppsInTossAd addEventListener) 수를 «세고»,
  각 요청 «시점»에 배너(.adslot)가 뷰포트 «안»이었는지를 함께 기록한다.
  = 「요청은 나갔는데 보이지 않은」 헛요청이 얼마나 되는지의 코드 층 실측이다.
  화면을 나갔다 돌아오면 요청이 «다시 1회» 나는지도 잰다.

★어떻게 «실광고 없이» 재나 (postMessage 감청 · 운영 ID 실렌더 ⛔)
  · window.ReactNativeWebView.postMessage 를 가로채 브릿지 메시지를 전부 기록한다.
  · __CONSTANT_HANDLER_MAP 에 광고 SDK 의 isSupported 상수를 심어 «토스 안» 경로를 연다.
  · SpaceKit(static.toss.im/ads/sdk/toss-ads-space-kit-3.1.0.js) 은 scripts/_vendor 의 로컬 사본으로
    route 한다 — 그 밖의 외부 요청은 «전부 abort». 광고 요청(fetchAppsInTossAd)에는 NO_AD 로 답한다
    ⇒ 크리에이티브 렌더 0 · 실광고 서버 접촉 0. 우리가 세는 것은 «요청이 나갔다는 사실»이다.
  · 이 방식은 verify_push.py / verify_share.py 와 같은 감청 구조다.

★한계
  · 요청 → 노출 전환 «자체»는 못 잰다(NO_AD 로 답하므로). 노출 조건(1px 가시성)은 SpaceKit 소스 실측으로
    확정했다(BaseAdType.onVisibilityRatioChange). 이 프로브는 «요청 시점의 가시성»을 그 대리로 쓴다.
  · 콜드 스타트 첫 화면: SDK 스크립트 비동기 로드 전에 attach 하면 web-bridge 가 throw 해 요청 0 이 «나온다».
    그래서 각 화면은 «SDK 를 먼저 워밍»(설정 화면 1회 방문)한 뒤 잰다. 콜드 스타트는 별도 항목으로 잰다.
"""
import http.server
import json
import os
import re
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
VENDOR_SDK = ROOT / 'scripts' / '_vendor' / 'toss-ads-space-kit-3.1.0.js'
ADS_TS = (ROOT / 'src' / 'lib' / 'ads.ts').read_text(encoding='utf-8')
# ★지면 ID → 슬롯명. 소스에서 «읽는다»(손으로 적지 않는다)
_blk = ADS_TS[ADS_TS.index('export const AD_IDS'):]
_blk = _blk[:_blk.index('} as const')]
ID2SLOT = {v: k for k, v in re.findall(r"(\w+):\s*'(ait\.v2\.live\.[0-9a-f]+)'", _blk)}

VIEW = {'width': 390, 'height': 844}
HOLD = ['VZ', 'NVDA', 'KO']

# ★가짜 네이티브 브릿지 — 광고 SDK 경로를 «열고», 요청은 기록만 하고 NO_AD 로 답한다.
FAKE_BRIDGE_JS = r"""(() => {
  window.__ML_SENT = [];
  window.__ML_STORE = {};
  window.__ML_ADREQ = [];
  window.__CONSTANT_HANDLER_MAP = Object.assign(window.__CONSTANT_HANDLER_MAP || {}, {
    fetchTossAd_isSupported: true,
    fetchAppsInTossAd_isSupported: true,
    loadAppsInTossAdMob_isSupported: true,
    showAppsInTossAdMob_isSupported: true,
    isAppsInTossAdMobLoaded_isSupported: true,
    getPlatformOS: 'android',
    getTossAppVersion: '5.230.0',
  });
  const snapSlots = () => [...document.querySelectorAll('.adslot')].map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vis: r.bottom > 0 && r.top < window.innerHeight };
  });
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch { m = { raw }; }
      m = Object.assign({ at: Date.now() }, m);
      window.__ML_SENT.push(m);
      if (!m || !m.eventId || !m.functionName) return;
      const em = () => window.__GRANITE_NATIVE_EMITTER;
      const a = Array.isArray(m.args) ? m.args : [];
      if (m.type === 'method') {
        let reply = null;
        if (m.functionName === 'getStorageItem') reply = (a[0] in window.__ML_STORE) ? window.__ML_STORE[a[0]] : null;
        else if (m.functionName === 'setStorageItem') { window.__ML_STORE[a[0]] = String(a[1]); }
        else if (m.functionName === 'removeStorageItem') { delete window.__ML_STORE[a[0]]; }
        setTimeout(() => { em()?.emit(m.functionName + '/resolve/' + m.eventId, reply); }, 0);
        return;
      }
      if (m.type === 'addEventListener') {
        if (m.functionName === 'fetchAppsInTossAd' || m.functionName === 'fetchTossAd') {
          const body = m.args || {};
          const id = body.spaceUnitId || body.adGroupId || '';
          window.__ML_ADREQ.push({ at: m.at, id, fn: m.functionName, hash: location.hash,
            hidden: document.visibilityState !== 'visible', slots: snapSlots() });
          /* ★NO_AD — 크리에이티브를 «그리지 않는다». 우리가 세는 것은 요청 사실이다 */
          setTimeout(() => { em()?.emit(m.functionName + '/onEvent/' + m.eventId,
            { resultType: 'SUCCESS', success: { requestId: 'probe-' + m.eventId, status: 'NO_AD', ads: [] } }); }, 30);
        }
      }
    },
  };
})()"""

# ★문서 가시성을 «흉내»낸다 — Playwright 는 탭 숨김을 직접 못 만든다.
#   앱과 SDK 는 document.visibilityState / document.hidden 을 읽고 visibilitychange 를 듣는다.
VIS_JS = r"""(state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state !== 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
}"""


def kst_key(days_ago=0):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone(timedelta(hours=9))) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def seed_journal(n):
    rows = []
    for i in range(n):
        rows.append({'id': 'j%d' % (n - i), 'at': 1700000000000 + i * 1000, 'tick': 100 + i, 'gameDay': 1 + i // 4,
                     'product': 'spot' if i % 2 == 0 else 'leverage', 'action': 'buy' if i % 3 else 'sell',
                     'ticker': ['NVDA', 'MSFT', 'TSLA', 'AAPL'][i % 4], 'fee': 1.25, 'qty': 3, 'price': 100 + i,
                     'notional': 300 + i, 'realized': (i - 5) * 12.5})
    return rows


def app_init_js(lang='ko', theme='light'):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    att = {'streak': 3, 'lastClaimedDate': kst_key(0), 'lastDoubledDate': None, 'totalUsd': 0}
    return (
        "(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260910');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
        "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
        "localStorage.setItem('ml.game', %s);"
        "localStorage.setItem('ml.attendance', %s);"
        "localStorage.setItem('ml.journal', %s);"
        "})()" % (lang, theme, json.dumps(json.dumps(save)), json.dumps(json.dumps(att)), json.dumps(json.dumps(seed_journal(20))))
    )


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def serve(directory):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(directory), **kw)

        def log_message(self, *a):
            pass
    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


SCREENS = [
    ('home', '#/home', '.tabbar'),
    ('stock', '#/stock/NVDA', '.orderbar'),
    ('settings', '#/settings', '.li'),
    ('rank', '#/rank', '.tabbar'),
    ('stocks', '#/stocks', '.tabbar'),
    ('journal', '#/journal', '.jrow'),
    ('derivatives', '#/derivatives', '.derivcta'),
]


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    label = argv[0] if argv else 'x'
    out = Path(argv[1]) if len(argv) > 1 else ROOT / '_verify_20260910_ads'
    out.mkdir(parents=True, exist_ok=True)
    dwell = 60
    if '--dwell' in sys.argv:
        dwell = int(sys.argv[sys.argv.index('--dwell') + 1])
    if not VENDOR_SDK.exists():
        print('FAILED: SpaceKit 로컬 사본이 없다:', VENDOR_SDK); return 1
    sdk_js = VENDOR_SDK.read_bytes()

    httpd, port = serve(DIST)
    base = 'http://127.0.0.1:%d/' % port
    rep = {'label': label, 'dist': str(DIST), 'dwell': dwell, 'screens': {}, 'cold': None, 'blocked': []}

    def new_ctx(browser):
        ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
        blocked = []

        def route_all(route, request):
            url = request.url
            if url.startswith(base):
                return route.continue_()
            if 'toss-ads-space-kit' in url:
                return route.fulfill(status=200, content_type='application/javascript', body=sdk_js)
            blocked.append(url[:120])
            return route.abort()
        ctx.route('**/*', route_all)
        ctx.add_init_script(FAKE_BRIDGE_JS)
        ctx.add_init_script(app_init_js())
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        return ctx, page, errs, blocked

    def boot(page, route, sel):
        page.goto(base + route, wait_until='domcontentloaded')
        page.wait_for_selector(sel, timeout=60000)
        try:
            page.wait_for_selector('.boot', state='detached', timeout=90000)
        except Exception:
            pass
        page.wait_for_timeout(1500)

    def reqs(page):
        return page.evaluate('() => window.__ML_ADREQ')

    def scroll(page, y):
        """★«단계» 스크롤(300px/80ms) — 실사용 스크롤은 연속적이라 배너가 뷰포트를 «거쳐» 간다.
        ⛔한 방 점프(scrollTop=20000)는 배너를 건너뛰어 IO 가 옳게 「안 보였다」고 판정한다(첫 판 AFTER33 의 rank/stocks 0 은 그 산물)."""
        page.evaluate("""async (y) => {
          const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
          if (!sc) return;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const dir = y > sc.scrollTop ? 1 : -1;
          for (let i = 0; i < 120; i++) {
            const before = sc.scrollTop;
            const next = dir > 0 ? Math.min(y, before + 300) : Math.max(y, before - 300);
            sc.scrollTop = next;
            await sleep(80);
            if (sc.scrollTop === before || sc.scrollTop === y) break;
          }
        }""", y)

    try:
        with open_browser() as (_pw, browser):
            # ── 0) 콜드 스타트: SDK 워밍 «없이» 홈 진입 ─────────────────────
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/home', '.tabbar')
            page.wait_for_timeout(3000)
            cold = reqs(page)
            sdk_loaded = page.evaluate("() => !!(window.TossAdsSpaceKit && window.TossAdsSpaceKit.isInitialized && window.TossAdsSpaceKit.isInitialized())")
            rep['cold'] = {'requests': len(cold), 'sdkInitializedAfter': sdk_loaded, 'detail': cold}
            print('콜드 스타트 홈: 요청 %d · SDK initialized=%s' % (len(cold), sdk_loaded))
            ctx.close()

            # ── 1) 화면별 체류 ─────────────────────────────────────────────
            for name, route, sel in SCREENS:
                ctx, page, errs, blocked = new_ctx(browser)
                # SDK 워밍: 설정 화면을 먼저 한 번 방문(배너가 있어 initialize 가 돈다)
                boot(page, '#/settings' if name != 'settings' else '#/rank', '.tabbar')
                page.wait_for_timeout(1200)
                warm_n = len(reqs(page))
                boot(page, route, sel)
                t0 = time.time()
                timeline = []

                def mark(tag):
                    r = reqs(page)
                    timeline.append({'t': round(time.time() - t0, 1), 'tag': tag, 'n': len(r) - warm_n})

                mark('enter')
                slots0 = page.evaluate("() => [...document.querySelectorAll('.adslot')].map(e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), vis: r.bottom > 0 && r.top < innerHeight }; })")
                # 체류 패턴: 10s 바닥·15s 상단·25s 바닥·30s 상단·40s 숨김·45s 복귀·50s 바닥·60s 끝 (dwell 에 비례)
                plan = [(10, 'bottom'), (15, 'top'), (25, 'bottom'), (30, 'top'), (40, 'hide'), (45, 'show'), (50, 'bottom')]
                for at, act in plan:
                    target = at * dwell / 60.0
                    while time.time() - t0 < target:
                        page.wait_for_timeout(200)
                    if act == 'bottom':
                        scroll(page, 20000)
                    elif act == 'top':
                        scroll(page, 0)
                    elif act == 'hide':
                        page.evaluate(VIS_JS, 'hidden')
                    elif act == 'show':
                        page.evaluate(VIS_JS, 'visible')
                    page.wait_for_timeout(400)
                    mark(act)
                while time.time() - t0 < dwell:
                    page.wait_for_timeout(200)
                mark('end')
                during = [r for r in reqs(page)][warm_n:]
                # 화면을 나갔다 돌아온다
                page.goto(base + ('#/rank' if name != 'rank' else '#/settings'), wait_until='domcontentloaded')
                page.wait_for_timeout(1500)
                left_n = len(reqs(page))
                boot(page, route, sel)
                page.wait_for_timeout(2500)
                back = reqs(page)[left_n:]
                rec = {
                    'route': route, 'slotsAtEnter': slots0,
                    'requestsDuringDwell': len(during),
                    'requestsVisibleAtRequest': sum(1 for r in during if any(s['vis'] for s in r['slots'])),
                    'requestsWhileHidden': sum(1 for r in during if r['hidden']),
                    'bySlot': {},
                    'timeline': timeline,
                    'afterLeaveAndReturn': len(back),
                    'returnDetail': [{'id': ID2SLOT.get(r['id'], r['id']), 'vis': any(s['vis'] for s in r['slots'])} for r in back],
                    'pageerrors': errs[:3],
                    'blockedExternal': blocked[:5],
                }
                for r in during:
                    k = ID2SLOT.get(r['id'], r['id'])
                    rec['bySlot'][k] = rec['bySlot'].get(k, 0) + 1
                rep['screens'][name] = rec
                print('%-12s 체류 %ds 요청 %d (보일 때 %d · 숨김 중 %d) · 나갔다 오면 %d · 진입 시 배너 %s · 슬롯 %s' % (
                    name, dwell, rec['requestsDuringDwell'], rec['requestsVisibleAtRequest'], rec['requestsWhileHidden'],
                    rec['afterLeaveAndReturn'], slots0, rec['bySlot']))
                page.screenshot(path=str(out / ('%s_%s.png' % (label, name))), full_page=False)
                ctx.close()
    finally:
        httpd.shutdown()

    (out / ('%s_ads_requests.json' % label)).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n산출: %s' % (out / ('%s_ads_requests.json' % label)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
