# -*- coding: utf-8 -*-
"""
출석 시트 «전/후» 실렌더 스크린샷 — 토스 «안» 흉내(가짜 브릿지) · headless 전용 (2026-09-10 · -33 증거용).

  python scripts/shot_attend_sheet.py <라벨> <웹 산출물 폴더> <출력폴더>

  · 홈 → 출석 칩 → 시트 (해제 «전» · 거래 일지 확인으로 해제 «후») × ko/en × 375/390 을 찍는다.
  · 광고 요청에는 NO_AD 로 답하고 SpaceKit 은 로컬 사본으로 route — 실광고 0.
  · 옛 빌드(-32)에는 버튼·힌트가 없으므로 «전» 스크린샷은 그 사실 자체가 증거다.
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
VENDOR_SDK = ROOT / 'scripts' / '_vendor' / 'toss-ads-space-kit-3.1.0.js'
HOLD = ['VZ', 'NVDA', 'KO']


def kst_key(days_ago=0):
    return (datetime.now(timezone(timedelta(hours=9))) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


FAKE_BRIDGE_JS = r"""(() => {
  window.__ML_SENT = []; window.__ML_STORE = {};
  window.__CONSTANT_HANDLER_MAP = Object.assign(window.__CONSTANT_HANDLER_MAP || {}, {
    fetchTossAd_isSupported: true, fetchAppsInTossAd_isSupported: true,
    loadAppsInTossAdMob_isSupported: true, showAppsInTossAdMob_isSupported: true, isAppsInTossAdMobLoaded_isSupported: true,
    getPlatformOS: 'android', getTossAppVersion: '5.230.0' });
  window.ReactNativeWebView = { postMessage: (raw) => {
    let m = null; try { m = JSON.parse(raw); } catch { m = { raw }; }
    window.__ML_SENT.push(m);
    if (!m || !m.eventId || !m.functionName) return;
    const em = () => window.__GRANITE_NATIVE_EMITTER; const a = Array.isArray(m.args) ? m.args : [];
    if (m.type === 'method') { let reply = null;
      if (m.functionName === 'getStorageItem') reply = (a[0] in window.__ML_STORE) ? window.__ML_STORE[a[0]] : null;
      else if (m.functionName === 'setStorageItem') window.__ML_STORE[a[0]] = String(a[1]);
      else if (m.functionName === 'removeStorageItem') delete window.__ML_STORE[a[0]];
      setTimeout(() => em()?.emit(m.functionName + '/resolve/' + m.eventId, reply), 0); return; }
    if (m.type === 'addEventListener' && (m.functionName === 'fetchAppsInTossAd' || m.functionName === 'fetchTossAd')) {
      setTimeout(() => em()?.emit(m.functionName + '/onEvent/' + m.eventId, { resultType: 'SUCCESS', success: { requestId: 'shot', status: 'NO_AD', ads: [] } }), 30); }
  } };
})()"""


def init_js(lang, theme):
    save = {'v': 1, 'savedAt': 0, 'tick': 0,
            'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                        'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                        'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
            'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {}}
    att = {'streak': 3, 'lastClaimedDate': kst_key(0), 'lastDoubledDate': None, 'totalUsd': 0}
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260910');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
            "localStorage.setItem('ml.game', %s); localStorage.setItem('ml.attendance', %s);"
            "localStorage.removeItem('ml.journal'); localStorage.removeItem('ml.push');})()"
            % (lang, theme, json.dumps(json.dumps(save)), json.dumps(json.dumps(att))))


def serve(directory):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(directory), **kw)

        def log_message(self, *a):
            pass
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def main():
    label, dist, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    sdk_js = VENDOR_SDK.read_bytes()
    httpd, port = serve(dist)
    base = 'http://127.0.0.1:%d/' % port
    facts = {}
    try:
        with open_browser() as (_pw, browser):
            for lang in ('ko', 'en'):
                for width in (375, 390):
                    for phase in ('locked', 'unlocked'):
                        ctx = browser.new_context(viewport={'width': width, 'height': 844}, device_scale_factor=2, locale='ko-KR' if lang == 'ko' else 'en-US')

                        def route_all(route, request):
                            url = request.url
                            if url.startswith(base):
                                return route.continue_()
                            if 'toss-ads-space-kit' in url:
                                return route.fulfill(status=200, content_type='application/javascript', body=sdk_js)
                            return route.abort()
                        ctx.route('**/*', route_all)
                        ctx.add_init_script(FAKE_BRIDGE_JS)
                        ctx.add_init_script(init_js(lang, 'light'))
                        page = ctx.new_page()
                        if phase == 'unlocked':
                            page.goto(base + '#/journal', wait_until='domcontentloaded'); page.wait_for_selector('.screen', timeout=60000)
                            try:
                                page.wait_for_selector('.boot', state='detached', timeout=90000)
                            except Exception:
                                pass
                            page.wait_for_timeout(800)
                        page.goto(base + '#/home', wait_until='domcontentloaded'); page.wait_for_selector('.tabbar', timeout=60000)
                        try:
                            page.wait_for_selector('.boot', state='detached', timeout=90000)
                        except Exception:
                            pass
                        page.wait_for_timeout(1200)
                        page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(500)
                        info = page.evaluate("""() => { const sh = document.querySelector('.sheet');
                          return { btns: [...sh.querySelectorAll('button')].map(b => (b.textContent||'').trim()), lines: [...sh.querySelectorAll('.attline')].map(e => (e.textContent||'').trim()) }; }""")
                        facts['%s_%s_%d' % (phase, lang, width)] = info
                        name = '%s_sheet_%s_%s_%d.png' % (label, phase, lang, width)
                        page.screenshot(path=str(out / name))
                        print('%-34s buttons=%s' % (name, info['btns']))
                        ctx.close()
    finally:
        httpd.shutdown()
    (out / ('%s_sheet_facts.json' % label)).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
