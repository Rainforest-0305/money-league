# -*- coding: utf-8 -*-
"""
-33 광고 규율 실동작 검증 — ★headless 전용 (2026-09-10 신설). ⛔창을 띄우지 않는다(President 화면 점유 금지).

  ML_DIST=dist/web python scripts/verify_ads33.py <출력폴더>

★무엇을 증명하나
  (0) 대조 — 감청기·요청 계수기·상태 속성이 «살아 있는지» 먼저(니들 주입).
  (A) 배너 「보일 때 1회」(홈·종목상세·설정·랭킹·종목목록): 진입 3초 요청 0(첫 화면 밖) → 배너로 스크롤 → 요청 «정확히 1»
      → 100회 리렌더 → 1 → 스크롤 왕복 → 1 → 화면 이탈 뒤 재진입 → 보이면 +1.
      숨김 컨텍스트: hidden 상태에서 배너를 보이게 해도 요청 0 → visible 복귀 → 1.
  (B) 오류 백오프: 첫 요청이 실패(FAIL)면 30초 뒤 재시도 1 · 숨김 중이면 재시도 0 → 복귀 때 1.
  (C) 출석 «추가 지급(광고)»: 토스 밖 0 · 해제 전 힌트만 · 첫 체결 뒤 버튼 → 리워드 성공 흉내 → 지급(+오늘 출석분) · 재탭 불가(하루 1회)
      · 거래 일지 확인만으로도 해제 · 리워드 요청 지면 = rewardAttendance.
  (D) 전면 «세션 3번째 완료 거래»: 1·2번째 0 · 3번째 되돌리기 창 만료 뒤 load 1(interstitialMain) · 4번째 0(세션당 1회)
      · 되돌린 거래는 세지 않음 · 진입 60초 이내 0(가드 계측 session-start) · 일 3회 상한 0(daily-cap).
  (E) 파생 탭 .adslot 0 · 유령 여백 0.   (F) 번들 grep.   (G) ko/en × 375/390/430 출석 시트(버튼 상태) 넘침·raw 키·보간·이모지·pageerror 0.

★어떻게 «실광고 없이» (postMessage 감청 · 운영 ID 실렌더 ⛔ · verify_push/verify_share 와 같은 구조)
  브릿지 메시지를 전부 기록하고 광고 요청(fetchAppsInTossAd)엔 NO_AD(또는 FAIL) 로, AdMob(load/show)엔 loaded/dismissed(+userEarnedReward) 로 답한다.
  SpaceKit 스크립트는 scripts/_vendor 로컬 사본으로 route 하고 그 밖 외부 요청은 «전부 abort» — 광고 서버 접촉 0.
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
VENDOR_SDK = ROOT / 'scripts' / '_vendor' / 'toss-ads-space-kit-3.1.0.js'
ADS_TS = (ROOT / 'src' / 'lib' / 'ads.ts').read_text(encoding='utf-8')
_blk = ADS_TS[ADS_TS.index('export const AD_IDS'):]
_blk = _blk[:_blk.index('} as const')]
SLOT_IDS = dict(re.findall(r"(\w+):\s*'(ait\.v2\.live\.[0-9a-f]+)'", _blk))
ID2SLOT = {v: k for k, v in SLOT_IDS.items()}
REMOVED_DERIV_ID = 'ait.v2.live.XXXXXXXXXXXXXXXX'
PUSH_CODE = re.search(r"export const PUSH_TEMPLATE_CODE = '([^']+)';", (ROOT / 'src' / 'toss' / 'pushAgreement.ts').read_text(encoding='utf-8')).group(1)
ATT_SRC = (ROOT / 'src' / 'lib' / 'attendance.ts').read_text(encoding='utf-8')
REWARDS = [int(x.replace('_', '').strip()) for x in re.search(r'ATTENDANCE_REWARDS = \[([^\]]*)\]', ATT_SRC).group(1).split(',') if x.strip()]
NTH = int(re.search(r'export const INTERSTITIAL_TRADE_NTH = (\d+);', ADS_TS).group(1))
UNDO_MS = int(re.search(r'export const UNDO_WINDOW_MS = (\d+);', (ROOT / 'src' / 'lib' / 'constants.ts').read_text(encoding='utf-8')).group(1))
RETRY0_MS = int(re.search(r'BANNER_RETRY_DELAYS_MS = \[(\d[\d_]*)', ADS_TS).group(1).replace('_', ''))

VIEW = {'width': 390, 'height': 844}
HOLD = ['VZ', 'NVDA', 'KO']
KST = timezone(timedelta(hours=9))
RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
RAW_KEY_ALLOW = re.compile(r'\d|\.(com|io|co|kr|js|css|png|json)$')


def kst_key(days_ago=0):
    return (datetime.now(KST) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


# ★가짜 네이티브 브릿지 — 광고 SDK 경로를 열고, 요청은 기록 + 모드대로 답한다. 크리에이티브는 «그리지 않는다».
FAKE_BRIDGE_JS = r"""(() => {
  window.__ML_SENT = [];
  window.__ML_STORE = {};
  window.__ML_ADREQ = [];
  window.__ML_ADMOB = [];
  window.__ML_MODE = { banner: 'noad', admobLoad: 'loaded', admobShow: 'dismissed', reward: true };
  window.__CONSTANT_HANDLER_MAP = Object.assign(window.__CONSTANT_HANDLER_MAP || {}, {
    fetchTossAd_isSupported: true, fetchAppsInTossAd_isSupported: true,
    loadAppsInTossAdMob_isSupported: true, showAppsInTossAdMob_isSupported: true, isAppsInTossAdMobLoaded_isSupported: true,
    getPlatformOS: 'android', getTossAppVersion: '5.230.0',
  });
  const snap = () => [...document.querySelectorAll('.adslot')].map((e) => {
    const r = e.getBoundingClientRect();
    return { slot: e.getAttribute('data-ad-slot'), top: Math.round(r.top), h: Math.round(r.height), vis: r.bottom > 0 && r.top < window.innerHeight };
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
      if (m.type !== 'addEventListener') return;
      const fn = m.functionName;
      if (fn === 'fetchAppsInTossAd' || fn === 'fetchTossAd') {
        const body = m.args || {};
        const id = body.spaceUnitId || body.adGroupId || '';
        window.__ML_ADREQ.push({ at: m.at, id, hash: location.hash, hidden: document.visibilityState !== 'visible', slots: snap() });
        const mode = window.__ML_MODE.banner;
        setTimeout(() => {
          if (mode === 'error') em()?.emit(fn + '/onEvent/' + m.eventId, { resultType: 'FAIL', error: { reason: 'harness: network down' } });
          else em()?.emit(fn + '/onEvent/' + m.eventId, { resultType: 'SUCCESS', success: { requestId: 'h-' + m.eventId, status: 'NO_AD', ads: [] } });
        }, 30);
        return;
      }
      if (fn === 'loadAppsInTossAdMob') {
        const id = (m.args || {}).adGroupId || '';
        window.__ML_ADMOB.push({ at: m.at, kind: 'load', id, hash: location.hash });
        const b = window.__ML_MODE.admobLoad;
        /* ★'manual' — 응답을 «보류»한다. 테스트가 __ML_FIRE_LOAD() 로 원하는 순간에 흘린다(로드 대기 중 상태 변화 재현) */
        if (b === 'manual') { window.__ML_PENDING_LOAD = { fn, eventId: m.eventId }; return; }
        setTimeout(() => {
          if (b === 'loaded') em()?.emit(fn + '/onEvent/' + m.eventId, { type: 'loaded' });
          else if (b === 'error') em()?.emit(fn + '/onError/' + m.eventId, { __isError: true, message: 'harness nofill' });
        }, 40);
        return;
      }
      if (fn === 'showAppsInTossAdMob') {
        const id = (m.args || {}).adGroupId || '';
        window.__ML_ADMOB.push({ at: m.at, kind: 'show', id, hash: location.hash });
        const b = window.__ML_MODE.admobShow;
        setTimeout(() => {
          em()?.emit(fn + '/onEvent/' + m.eventId, { type: 'impression' });
          if (window.__ML_MODE.reward) em()?.emit(fn + '/onEvent/' + m.eventId, { type: 'userEarnedReward', data: { unitType: 'unit', unitAmount: 1 } });
          em()?.emit(fn + '/onEvent/' + m.eventId, { type: b });
        }, 60);
        return;
      }
      /* requestNotificationAgreement 등 그 밖의 이벤트 브릿지는 답하지 않는다(이 하네스의 관심 밖) */
    },
  };
  /** 보류해 둔 전면/리워드 로드 응답을 «지금» 흘린다 */
  window.__ML_FIRE_LOAD = () => {
    const p = window.__ML_PENDING_LOAD;
    if (!p) return { ok: false, reason: 'no-pending' };
    window.__ML_PENDING_LOAD = null;
    window.__GRANITE_NATIVE_EMITTER.emit(p.fn + '/onEvent/' + p.eventId, { type: 'loaded' });
    return { ok: true };
  };
})()"""

# ★가짜 시계(verify_attendance 와 같은 방식) — 값만 옮긴다. 타이머는 정상 속도로 돈다.
FAKE_CLOCK_JS = r"""(() => {
  const real = Date.now.bind(Date);
  window.__ML_SKEW = 0;
  Date.now = () => real() + window.__ML_SKEW;
  const RealDate = Date;
  const P = new Proxy(RealDate, { construct(t, args) { return args.length === 0 ? new t(real() + window.__ML_SKEW) : new t(...args); } });
  P.now = Date.now; P.parse = RealDate.parse; P.UTC = RealDate.UTC;
  window.Date = P;
  window.__ML_ADVANCE_MS = (ms) => { window.__ML_SKEW += ms; return window.__ML_SKEW; };
})()"""

VIS_JS = r"""(state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state !== 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
}"""

SLOTS_JS = r"""() => [...document.querySelectorAll('.adslot')].map((e) => { const r = e.getBoundingClientRect();
  return { slot: e.getAttribute('data-ad-slot'), state: e.getAttribute('data-ad-state'), top: Math.round(r.top), h: Math.round(r.height), vis: r.bottom > 0 && r.top < innerHeight }; })"""
STATS_JS = r"""(slot) => { try { const l = JSON.parse(localStorage.getItem('ml.ads.stats') || 'null'); if (!l) return null;
  const days = Object.keys(l.days || {}).sort(); const d = days[days.length - 1]; const c = (l.days[d] || {})[slot] || null;
  return { day: d, counters: c, recent: (l.recent || []).filter((e) => e.slot === slot).slice(-12) }; } catch (e) { return { err: String(e) }; } }"""
SHEET_JS = r"""() => { const sh = document.querySelector('.sheet'); if (!sh) return null;
  const btns = [...sh.querySelectorAll('button')].map((b) => ({ t: (b.textContent || '').trim(), dis: b.disabled, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }));
  const lines = [...sh.querySelectorAll('.attline')].map((e) => (e.textContent || '').trim());
  return { btns, lines, bonus: btns.filter((b) => /2배|double/i.test(b.t)).length, hint: lines.filter((x) => /한 번 더|one more/i.test(x)).length,
           done: lines.filter((x) => /오늘 몫|Today's reward/i.test(x)).length }; }"""
LEDGER_JS = r"""() => { const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const g = j('ml.game'); const a = j('ml.attendance');
  return { cash: g && g.account ? g.account.cash : null, totalUsd: a ? a.totalUsd : null,
           lastDoubled: a ? a.lastDoubledDate : null, streak: a ? a.streak : null, lastClaimed: a ? a.lastClaimedDate : null }; }"""
TOASTS_JS = r"""() => [...document.querySelectorAll('.toast')].map((e) => (e.textContent || '').trim())"""
OVERFLOW_JS = r"""(sel) => { const out=[]; for (const root of document.querySelectorAll(sel)) {
  for (const e of root.querySelectorAll('*')) { if (e.children.length) continue; if (!(e.textContent||'').trim()) continue;
    const cs=getComputedStyle(e); if (cs.overflow==='hidden'||cs.textOverflow==='ellipsis') continue;
    if (e.scrollWidth > e.clientWidth + 1 && cs.whiteSpace==='nowrap') out.push({t:(e.textContent||'').trim().slice(0,30), sw:e.scrollWidth, cw:e.clientWidth}); } }
  return out; }"""
INTERP_JS = r"""() => { const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const t=n.textContent||''; if (t.includes('{{')||t.includes('}}')) out.push(t.trim().slice(0,60)); } return out; }"""
EMOJI_JS = r"""() => { const RE=/(\p{Extended_Pictographic}|️|⃣|✓|✗)/gu; const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const p=n.parentElement; if(!p) continue; if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(p.tagName)) continue;
    const cs=getComputedStyle(p); if(cs.display==='none'||cs.visibility==='hidden') continue; const m=(n.textContent||'').match(RE); if(m) out.push((n.textContent||'').trim().slice(0,30)); } return out; }"""
GHOST_DERIV_JS = r"""() => { const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0; const sc = document.querySelector('.scroll'); const ghosts = [];
  if (sc) for (const c of sc.children) { const r = c.getBoundingClientRect(); const pad = px(c,'paddingTop')+px(c,'paddingBottom'); const mar = px(c,'marginTop')+px(c,'marginBottom');
    if (Math.round(r.height) === 0 && (pad + mar) > 0 && !c.classList.contains('scroll-pad')) ghosts.push(c.className || c.tagName); }
  return { adslots: document.querySelectorAll('.adslot').length, ghosts, cta: !!document.querySelector('.derivcta') }; }"""


def scan_raw_keys(page):
    texts = page.eval_on_selector_all('body *', """els => els.filter(e => e.children.length === 0)
        .filter(e => !['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))
        .map(e => (e.textContent||'').trim()).filter(Boolean)""")
    hits = []
    for tx in texts:
        for m in RAW_KEY_RE.finditer(' ' + tx + ' '):
            if RAW_KEY_ALLOW.search(m.group(1)):
                continue
            hits.append((m.group(1), tx[:60]))
    return hits


def app_init_js(lang='ko', theme='light', interstitial_ledger=None):
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    att = {'streak': 3, 'lastClaimedDate': kst_key(0), 'lastDoubledDate': None, 'totalUsd': 0}
    led = "localStorage.removeItem('ml.ads.interstitial');" if interstitial_ledger is None else \
        "localStorage.setItem('ml.ads.interstitial', %s);" % json.dumps(json.dumps(interstitial_ledger))
    return (
        "(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260910');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
        "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
        "localStorage.setItem('ml.game', %s);"
        "localStorage.setItem('ml.attendance', %s);"
        "localStorage.removeItem('ml.journal'); localStorage.removeItem('ml.ads.stats'); localStorage.removeItem('ml.push'); %s"
        "})()" % (lang, theme, json.dumps(json.dumps(save)), json.dumps(json.dumps(att)), led)
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


# 화면별: (라우트, 준비 셀렉터, 배너 슬롯, 배너를 «보이게» 하는 스크롤 y, 100회 리렌더 유발 클릭 셀렉터 목록)
SCREENS = [
    ('home', '#/home', '.tabbar', 'bannerHome', 20000, ['.pillrow .pill']),
    ('stock', '#/stock/NVDA', '.orderbar', 'bannerStockDetail', 20000, ['.chartctl .pill']),
    ('settings', '#/settings', '.li', 'bannerSettings', 20000, None),
    ('rank', '#/rank', '.tabbar', 'bannerLeaderboard', 20000, ['.seg button']),
    ('stocks', '#/stocks', '.tabbar', 'bannerStocks', 63 * 9, ['.pillrow .pill']),
]


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_20260910_ads')
    out.mkdir(parents=True, exist_ok=True)
    if not VENDOR_SDK.exists():
        print('FAILED: SpaceKit 로컬 사본이 없다:', VENDOR_SDK); return 1
    sdk_js = VENDOR_SDK.read_bytes()
    rep = {'dist': str(DIST), 'nth': NTH, 'controls': [], 'checks': [], 'shots': [], 'fail': [], 'facts': {}}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)[:300]])
        if not ok:
            rep['fail'].append([name, str(detail)[:300]])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {str(detail)[:160]}")

    def control(name, caught):
        rep['controls'].append([name, bool(caught)]); print(f"  {'CAUGHT' if caught else 'MISSED'}  {name}"); return bool(caught)

    # ── (F) 번들 grep — 브라우저 없이 먼저 ─────────────────────────────
    print('\n(F) 번들 grep')
    js = ' '.join(p.read_text(encoding='utf-8', errors='ignore') for p in (DIST / 'assets').glob('*.js'))
    check('번들: 제거한 파생 배너 ID «없음»', REMOVED_DERIV_ID not in js, REMOVED_DERIV_ID)
    check('번들: 출석 리워드 지면 «있음»', SLOT_IDS['rewardAttendance'] in js, SLOT_IDS['rewardAttendance'])
    check('번들: 전면 지면 «있음»', SLOT_IDS['interstitialMain'] in js, SLOT_IDS['interstitialMain'])
    check('번들: 푸시 templateCode 유지(-32)', PUSH_CODE in js, PUSH_CODE)
    check('번들: TEST_/TESTONLY/ads.preview 개발 표식 «없음»(ads.preview 는 sessionStorage 검증 플래그 — 코드에 문자열만 있다)', 'TESTONLY' not in js and 'TEST_01M' not in js)
    check('번들: 계측 키 ml.ads.stats «있음»', 'ml.ads.stats' in js)
    control('[음성대조] 가짜 지면 ID 는 번들에 «없다»', 'ait.v2.live.XXXXXXXXXXXXXXXX' not in js)

    httpd, port = serve(DIST)
    base = f'http://127.0.0.1:{port}/'

    def new_ctx(browser, in_toss=True, lang='ko', theme='light', width=390, clock=False, interstitial_ledger=None):
        ctx = browser.new_context(viewport={'width': width, 'height': 844}, device_scale_factor=2, locale='ko-KR' if lang == 'ko' else 'en-US')
        blocked = []

        def route_all(route, request):
            url = request.url
            if url.startswith(base):
                return route.continue_()
            if 'toss-ads-space-kit' in url:
                return route.fulfill(status=200, content_type='application/javascript', body=sdk_js)
            blocked.append(url[:100])
            return route.abort()
        ctx.route('**/*', route_all)
        if clock:
            ctx.add_init_script(FAKE_CLOCK_JS)
        if in_toss:
            ctx.add_init_script(FAKE_BRIDGE_JS)
        ctx.add_init_script(app_init_js(lang, theme, interstitial_ledger))
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        return ctx, page, errs, blocked

    def boot(page, route, sel):
        page.goto(base + route, wait_until='domcontentloaded')
        page.wait_for_selector(sel, timeout=60000)
        try:
            page.wait_for_selector('.boot', state='detached', timeout=90000)
        except Exception:
            pass
        page.wait_for_timeout(1200)

    def reqs(page, slot=None):
        r = page.evaluate('() => window.__ML_ADREQ')
        return [x for x in r if slot is None or ID2SLOT.get(x['id']) == slot]

    def admob(page, kind=None, slot=None):
        r = page.evaluate('() => window.__ML_ADMOB')
        return [x for x in r if (kind is None or x['kind'] == kind) and (slot is None or ID2SLOT.get(x['id']) == slot)]

    def scroll(page, y):
        page.evaluate("(y) => { const sc = document.querySelector('.vlist') || document.querySelector('.scroll'); if (sc) sc.scrollTop = y; }", y)
        page.wait_for_timeout(500)

    def scroll_to_banner(page):
        """배너 «호스트»(.adslot__host)가 스크롤 컨테이너 «안»에 오게 단계 스크롤한다.
        ⛔`scrollTop = 20000` 한 방 점프는 배너가 뷰포트를 «거치지 않고» 지나가서 IO 가 옳게 「안 보였다」고 판정한다
        (첫 판 [rank] 거짓 FAIL 의 원인). 실사용 스크롤은 연속적이라 단계로 내린다."""
        return page.evaluate("""async () => {
          const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
          if (!sc) return { found: false, reason: 'no-scroller' };
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 80; i++) {
            const ad = document.querySelector('.adslot__host');
            if (ad) {
              const sr = sc.getBoundingClientRect();
              let r = ad.getBoundingClientRect();
              if (!(r.top >= sr.top && r.bottom <= sr.bottom)) {
                sc.scrollTop += (r.top - sr.top) - Math.max(40, sr.height / 3);
                await sleep(150);
                r = ad.getBoundingClientRect();
              }
              return { found: true, top: Math.round(r.top), scTop: Math.round(sr.top), scBottom: Math.round(sr.bottom) };
            }
            const before = sc.scrollTop;
            sc.scrollTop += 300;
            await sleep(80);
            if (sc.scrollTop === before) return { found: false, reason: 'end' };
          }
          return { found: false, reason: 'steps' };
        }""")

    def rerender(page, sels, n=100):
        """화면 «자체»를 n 번 리렌더시킨다 — 상태를 바꾸는 클릭을 번갈아 누른다"""
        if sels is None:
            # 설정: 「오를 때 색」 시트를 열고 옵션을 바꿔 store 를 bump → 전체 트리 리렌더(n/2 왕복)
            for i in range(n // 2):
                page.evaluate("() => { const li=[...document.querySelectorAll('.li')].find(b=>/오를 때|Rising|Up color/.test(b.textContent||'')); li && li.click(); }")
                page.wait_for_timeout(30)
                page.evaluate("(i) => { const o=[...document.querySelectorAll('.sheet .opt')]; if (o.length) o[i % o.length].click(); }", i)
                page.wait_for_timeout(30)
            return
        for i in range(n):
            page.evaluate("([sel, i]) => { const b=[...document.querySelectorAll(sel)]; if (b.length) b[i % b.length].click(); }", [sels[0], i])
            page.wait_for_timeout(15)
        page.wait_for_timeout(300)

    def trade(page, wait_expire=True):
        """현물 매수 1건: 종목 상세 → 사기 → 시트 CTA. 되돌리기 창(UNDO_MS)이 지나가길 기다린다"""
        if '#/stock/NVDA' not in page.url:
            boot(page, '#/stock/NVDA', '.orderbar')
        page.locator('.orderbar .btn--lg').nth(1).click()
        page.wait_for_selector('.ordersheet__big', timeout=10000)
        page.locator('.btn--lg.btn--up').first.click()
        page.wait_for_selector('.toast--act', timeout=10000)
        if wait_expire:
            page.wait_for_timeout(UNDO_MS + 900)

    try:
        with open_browser() as (_pw, browser):
            # ── (0) 대조 ────────────────────────────────────────────────
            print('\n(0) 대조 — 검사기가 살아 있는가')
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/settings', '.li')
            ok = True
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)"); page.wait_for_timeout(200)
            ok &= control('pageerror 감시기', any('NEEDLE_PAGE' in e for e in errs))
            n0 = len(reqs(page))
            page.evaluate("() => window.ReactNativeWebView.postMessage(JSON.stringify({type:'addEventListener',functionName:'fetchAppsInTossAd',eventId:'needle',args:{spaceUnitId:'ait.v2.live.needle0000000000'}}))")
            ok &= control('광고 요청 계수기(브릿지 감청)', len(reqs(page)) == n0 + 1)
            page.evaluate("() => { window.__ML_ADREQ = window.__ML_ADREQ.filter(r => r.id !== 'ait.v2.live.needle0000000000'); }")
            sl = page.evaluate(SLOTS_JS)
            ok &= control('배너 상자가 data-ad-slot/data-ad-state 를 «갖고 있다»', len(sl) >= 1 and all(s['slot'] and s['state'] for s in sl))
            ok &= control('SpaceKit 이 «로컬 사본»으로 초기화됐다(외부 요청 0)', page.evaluate("() => !!(window.TossAdsSpaceKit && window.TossAdsSpaceKit.isInitialized && window.TossAdsSpaceKit.isInitialized())") and not any('toss.im' in b and 'space-kit' not in b for b in blocked))
            base_ov = len(page.evaluate(OVERFLOW_JS, '.grp'))
            page.evaluate("() => { const d=document.createElement('div'); d.id='nov'; d.style.cssText='width:40px;white-space:nowrap'; d.textContent='overflow needle long text'; document.querySelector('.grp').appendChild(d); }")
            ok &= control('넘침 탐지기', len(page.evaluate(OVERFLOW_JS, '.grp')) > base_ov)
            page.evaluate("() => document.getElementById('nov')?.remove()")
            rep['facts']['blockedExternal'] = blocked[:8]
            ctx.close()
            if not ok:
                print('FAILED: 대조 실패 — 결과 무효'); return 1

            # ── (A) 배너 「보일 때 1회」 ─────────────────────────────────
            print('\n(A) 배너 — 보일 때 1회 · 리렌더 100회 · 왕복 · 숨김 · 재진입')
            for name, route, sel, slot, y, resel in SCREENS:
                ctx, page, errs, blocked = new_ctx(browser)
                boot(page, '#/journal' if name != 'stock' else '#/rank', '.screen')  # SDK 워밍(다른 화면)
                page.wait_for_timeout(800)
                boot(page, route, sel)
                page.wait_for_timeout(2000)
                r0 = reqs(page, slot)
                st0 = page.evaluate(SLOTS_JS)
                check(f'[{name}] 진입 3초: 배너가 첫 화면 밖이면 요청 0', len(r0) == 0 and st0 and not st0[0]['vis'], f'req={len(r0)} slots={st0}')
                sb = scroll_to_banner(page)
                page.wait_for_timeout(1500)
                r1 = reqs(page, slot)
                st1 = page.evaluate(SLOTS_JS)
                check(f'[{name}] 배너를 «보이게» 스크롤 → 요청 정확히 1 · 요청 시점에 보였다', len(r1) == 1 and any(s['vis'] for s in r1[0]['slots']), f'req={len(r1)} scroll={sb} slots={st1}')
                check(f'[{name}] 상태 속성 → nofill(NO_AD 응답을 받아 «끝»)', st1 and st1[0]['state'] in ('nofill', 'requested'), st1)
                rerender(page, resel, 100)
                scroll_to_banner(page); page.wait_for_timeout(800)
                check(f'[{name}] 100회 리렌더(필터·정렬·탭 클릭 = 재마운트 포함) 뒤에도 요청 1', len(reqs(page, slot)) == 1, len(reqs(page, slot)))
                for _ in range(5):
                    scroll(page, 0); scroll_to_banner(page)
                page.wait_for_timeout(800)
                check(f'[{name}] 스크롤 왕복 5회 뒤에도 요청 1', len(reqs(page, slot)) == 1, len(reqs(page, slot)))
                page.evaluate(VIS_JS, 'hidden'); scroll(page, 0); scroll_to_banner(page); page.wait_for_timeout(800); page.evaluate(VIS_JS, 'visible'); page.wait_for_timeout(800)
                check(f'[{name}] 숨김→복귀 뒤에도 요청 1(자동 새로고침 0)', len(reqs(page, slot)) == 1, len(reqs(page, slot)))
                stats = page.evaluate(STATS_JS, slot)
                check(f'[{name}] 계측 ml.ads.stats: req 1 · nofill 1 · shown 0', bool(stats and stats['counters']) and stats['counters']['req'] == 1 and stats['counters']['nofill'] == 1 and stats['counters']['shown'] == 0, stats and stats['counters'])
                rep['facts'][f'A_{name}_reuse'] = stats and stats['counters'] and stats['counters'].get('reuse')
                # 이탈 → 재진입: 배너가 다시 «보일 때» +1
                boot(page, '#/settings' if name != 'settings' else '#/rank', '.screen'); page.wait_for_timeout(2200)
                boot(page, route, sel); page.wait_for_timeout(1500)
                check(f'[{name}] 재진입 직후(첫 화면 밖) 요청 그대로 1', len(reqs(page, slot)) == 1, len(reqs(page, slot)))
                scroll_to_banner(page); page.wait_for_timeout(1500)
                check(f'[{name}] 재진입 뒤 배너가 보이면 «+1» = 2', len(reqs(page, slot)) == 2, len(reqs(page, slot)))
                check(f'[{name}] pageerror 0', not any('PAGEERROR' in e for e in errs), [e for e in errs if 'PAGEERROR' in e][:2])
                page.screenshot(path=str(out / f'A_{name}_banner_visible.png')); rep['shots'].append(f'A_{name}_banner_visible.png')
                rep['facts'][f'A_{name}'] = {'enter': st0, 'afterScroll': st1, 'requests': reqs(page, slot)}
                ctx.close()
                # 숨김 컨텍스트: hidden 상태에서 배너를 보이게 해도 0 → visible 복귀 → 1
                ctx, page, errs, blocked = new_ctx(browser)
                boot(page, '#/journal' if name != 'stock' else '#/rank', '.screen'); page.wait_for_timeout(800)
                boot(page, route, sel)
                page.evaluate(VIS_JS, 'hidden'); scroll_to_banner(page); page.wait_for_timeout(2000)
                check(f'[{name}] 문서 hidden 중 배너가 보여도 요청 0', len(reqs(page, slot)) == 0, len(reqs(page, slot)))
                page.evaluate(VIS_JS, 'visible'); page.wait_for_timeout(1500)
                check(f'[{name}] visible 복귀 → 요청 1', len(reqs(page, slot)) == 1, len(reqs(page, slot)))
                ctx.close()

            # ── (B) 오류 백오프 ─────────────────────────────────────────
            print('\n(B) 오류 백오프 — 30초 뒤 재시도 1 · 숨김 중 재시도 0')
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/journal', '.screen'); page.wait_for_timeout(800)
            page.evaluate("() => { window.__ML_MODE.banner = 'error'; }")
            boot(page, '#/home', '.tabbar')
            scroll(page, 20000); page.wait_for_timeout(1500)
            t0 = time.time()
            check('[backoff] 첫 요청 1 · 상태 retry-wait(실패 → 백오프 대기)', len(reqs(page, 'bannerHome')) == 1 and page.evaluate(SLOTS_JS)[0]['state'] in ('retry-wait', 'failed'), page.evaluate(SLOTS_JS))
            while time.time() - t0 < RETRY0_MS / 1000 - 3:
                page.wait_for_timeout(500)
            check('[backoff] 30초 «전»에는 재시도 없음(요청 1)', len(reqs(page, 'bannerHome')) == 1, len(reqs(page, 'bannerHome')))
            while time.time() - t0 < RETRY0_MS / 1000 + 4:
                page.wait_for_timeout(500)
            check('[backoff] 30초 뒤 «보이는 상태»에서 재시도 1 → 요청 2', len(reqs(page, 'bannerHome')) == 2, len(reqs(page, 'bannerHome')))
            st = page.evaluate(STATS_JS, 'bannerHome')
            check('[backoff] 계측: req 2 · fail ≥ 1 · 사유 기록', bool(st and st['counters']) and st['counters']['req'] == 2 and st['counters']['fail'] >= 1 and any(e.get('reason') for e in st['recent'] if e['ev'] == 'fail'), st)
            ctx.close()
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/journal', '.screen'); page.wait_for_timeout(800)
            page.evaluate("() => { window.__ML_MODE.banner = 'error'; }")
            boot(page, '#/home', '.tabbar')
            scroll(page, 20000); page.wait_for_timeout(1500)
            t0 = time.time()
            page.wait_for_timeout(3000); page.evaluate(VIS_JS, 'hidden')
            while time.time() - t0 < RETRY0_MS / 1000 + 6:
                page.wait_for_timeout(500)
            check('[backoff] 백오프 시각이 지나도 «숨김 중»이면 재시도 0(요청 1)', len(reqs(page, 'bannerHome')) == 1, len(reqs(page, 'bannerHome')))
            page.evaluate(VIS_JS, 'visible'); page.wait_for_timeout(1500)
            check('[backoff] visible 복귀 → 그때 재시도 1(요청 2)', len(reqs(page, 'bannerHome')) == 2, len(reqs(page, 'bannerHome')))
            ctx.close()

            # ── (C) 출석 추가지급 ──────────────────────────────────────
            print('\n(C) 출석 «추가 지급(광고)» — 도달 · 해제 · 지급 · 하루 1회')
            ctx, page, errs, blocked = new_ctx(browser, in_toss=False)
            boot(page, '#/home', '.tabbar')
            page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(300)
            sh = page.evaluate(SHEET_JS)
            check('[토스밖] 출석 시트: 광고 버튼 0 · 힌트 0(빈 래퍼 0)', sh and sh['bonus'] == 0 and sh['hint'] == 0, sh)
            ctx.close()

            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/home', '.tabbar')
            page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(300)
            sh = page.evaluate(SHEET_JS)
            check('[토스안·해제 전] 시트: 버튼 0 · 해제 힌트 1', sh and sh['bonus'] == 0 and sh['hint'] == 1, sh)
            check('[토스안·해제 전] 홈 진입만으로 리워드 SDK 호출 0(자동 재생 ⛔)', len(admob(page, 'load')) == 0, len(admob(page, 'load')))
            page.screenshot(path=str(out / 'C_sheet_locked_ko.png')); rep['shots'].append('C_sheet_locked_ko.png')
            page.locator('.scrim').click(); page.wait_for_timeout(300)
            trade(page, wait_expire=True)
            toasts = page.evaluate(TOASTS_JS)
            rep['facts']['C_toastsAfterFirstTrade'] = toasts
            boot(page, '#/home', '.tabbar')
            page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(300)
            sh = page.evaluate(SHEET_JS)
            check('[토스안·첫 체결 뒤] 시트: 광고 버튼 1 · 힌트 0', sh and sh['bonus'] == 1 and sh['hint'] == 0, sh)
            btn = sh['btns'][[i for i, b in enumerate(sh['btns']) if re.search(r'2배|double', b['t'], re.I)][0]] if sh and sh['bonus'] else None
            check('[토스안] 버튼 터치 타깃 ≥ 24px · 활성', bool(btn) and btn['h'] >= 24 and not btn['dis'], btn)
            check('[토스안] 위계: 광고 버튼이 있을 때 「닫기」는 ghost(같은 회색 둘로 읽히지 않게)', bool(sh) and page.evaluate("() => { const b=[...document.querySelectorAll('.sheet button')].find(x=>/닫기|Close/.test(x.textContent||'')); return b ? b.className : ''; }") == 'btn btn--ghost')
            page.screenshot(path=str(out / 'C_sheet_button_ko.png')); rep['shots'].append('C_sheet_button_ko.png')
            # ★기준 잔고는 «버튼을 누르기 직전»에 잡는다 — 거래 전 값으로 잡으면 체결액·수수료가 섞여 거짓 FAIL 이 난다(첫 판 실수)
            led0 = page.evaluate(LEDGER_JS)
            page.evaluate("() => { const b=[...document.querySelectorAll('.sheet button')].find(x=>/2배|double/i.test(x.textContent||'')); b && b.click(); }")
            page.wait_for_timeout(1200)
            loads = admob(page, 'load'); shows = admob(page, 'show')
            check('[토스안] 버튼 → 리워드 load 1 · show 1 · 지면 = rewardAttendance', len(loads) == 1 and len(shows) == 1 and loads[0]['id'] == SLOT_IDS['rewardAttendance'], (loads, shows))
            led1 = page.evaluate(LEDGER_JS)
            expect = REWARDS[(led0['streak'] - 1) % len(REWARDS)]
            # ★지급액은 «출석 원장»(ml.attendance.totalUsd)으로 잰다 — 엔진이 실제로 준 금액만 더하는 값이다.
            #   ⛔현금 차이로 재면 «그 사이에 게임이 도는 것»(배당·가격틱)이 섞인다. 첫 판이 정확히 그 이유로 거짓 FAIL 이었다
            #     (실측: 차이 15,003.58 = 출석 15,000 + KO 배당 3.58 — 토스트에도 그 배당이 찍혀 있었다).
            #   ★현금도 «최소한 지급액만큼은» 늘었는지 같이 본다(원장만 오르고 돈이 안 들어오는 사고를 막는다).
            gotLedger = (led1['totalUsd'] or 0) - (led0['totalUsd'] or 0)
            gotCash = led1['cash'] - led0['cash']
            check(f'[토스안] 지급: 출석 원장 +{expect} · 현금도 그만큼 이상 · lastDoubledDate = 오늘',
                  abs(gotLedger - expect) < 0.01 and gotCash >= expect - 0.01 and led1['lastDoubled'] == kst_key(),
                  f'원장 +{gotLedger} · 현금 +{round(gotCash, 2)} · {led1["lastDoubled"]}')
            sh2 = page.evaluate(SHEET_JS)
            check('[토스안] 지급 뒤 시트: 버튼 0(하루 1회) · 「오늘 몫은 받았어요」', sh2 and sh2['bonus'] == 0 and sh2['done'] == 1, sh2)
            st = page.evaluate(STATS_JS, 'rewardAttendance')
            check('[토스안] 계측: rewardAttendance req 1 · load 1 · showReq 1 · shown 1 · reward 1', bool(st and st['counters']) and all(st['counters'][k] == 1 for k in ('req', 'load', 'showReq', 'shown', 'reward')), st and st['counters'])
            page.locator('.scrim').click(); page.wait_for_timeout(200)
            boot(page, '#/home', '.tabbar')
            page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(300)
            check('[토스안] 재진입 뒤에도 버튼 0(재탭 불가 · 원장 기준)', page.evaluate(SHEET_JS)['bonus'] == 0)
            check('[토스안] 첫 완료 거래 뒤 «안내 토스트» 1회(광고를 틀지 않는다)', any('한 번 더' in t for t in toasts), toasts)
            check('[토스안] pageerror 0', not any('PAGEERROR' in e for e in errs), [e for e in errs if 'PAGEERROR' in e][:2])
            ctx.close()

            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/journal', '.screen'); page.wait_for_timeout(600)
            boot(page, '#/home', '.tabbar')
            page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(300)
            sh = page.evaluate(SHEET_JS)
            check('[토스안·거래 없이 일지 확인] 시트: 버튼 1(포트폴리오 확인으로도 해제)', sh and sh['bonus'] == 1 and sh['hint'] == 0, sh)
            ctx.close()

            # ── (D) 전면 — 세션 N번째 완료 거래 ────────────────────────
            print(f'\n(D) 전면 — 세션 {NTH}번째 «완료» 거래')
            ctx, page, errs, blocked = new_ctx(browser, clock=True)
            boot(page, '#/home', '.tabbar')
            page.evaluate('() => window.__ML_ADVANCE_MS(61000)'); page.wait_for_timeout(600)   # 진입 60초 가드를 «지나간» 세션
            for k in range(1, NTH):
                trade(page)
                check(f'[전면] {k}번째 완료 거래 뒤 전면 load 0', len(admob(page, 'load', 'interstitialMain')) == 0, len(admob(page, 'load', 'interstitialMain')))
            trade(page)
            page.wait_for_timeout(800)
            il = admob(page, 'load', 'interstitialMain'); ish = admob(page, 'show', 'interstitialMain')
            check(f'[전면] ★{NTH}번째 완료 거래(되돌리기 창 만료 뒤) → load 1 · show 1 · 지면 interstitialMain', len(il) == 1 and len(ish) == 1, (il, ish))
            st = page.evaluate(STATS_JS, 'interstitialMain')
            check('[전면] 계측: req 1 · load 1 · showReq 1 · shown 1 · dismiss 1', bool(st and st['counters']) and all(st['counters'][k] == 1 for k in ('req', 'load', 'showReq', 'shown', 'dismiss')), st and st['counters'])
            ledger = page.evaluate("() => JSON.parse(localStorage.getItem('ml.ads.interstitial') || 'null')")
            check('[전면] 기존 원장 ml.ads.interstitial count 1(기존 가드 «재사용»)', bool(ledger) and ledger.get('count') == 1, ledger)
            trade(page)
            check(f'[전면] {NTH + 1}번째 → 여전히 1(세션당 한 번)', len(admob(page, 'load', 'interstitialMain')) == 1, len(admob(page, 'load', 'interstitialMain')))
            check('[전면] pageerror 0', not any('PAGEERROR' in e for e in errs), [e for e in errs if 'PAGEERROR' in e][:2])
            ctx.close()

            # 되돌린 거래는 «완료»가 아니다
            ctx, page, errs, blocked = new_ctx(browser, clock=True)
            boot(page, '#/home', '.tabbar')
            page.evaluate('() => window.__ML_ADVANCE_MS(61000)'); page.wait_for_timeout(600)
            trade(page)
            trade(page, wait_expire=False)
            page.locator('.toast__act').first.click(); page.wait_for_timeout(UNDO_MS + 900)   # 2번째를 되돌린다
            trade(page)
            check(f'[전면·되돌리기] 체결 3(완료 2) → load 0', len(admob(page, 'load', 'interstitialMain')) == 0, len(admob(page, 'load', 'interstitialMain')))
            trade(page)
            check(f'[전면·되돌리기] 체결 4(완료 3) → load 1', len(admob(page, 'load', 'interstitialMain')) == 1, len(admob(page, 'load', 'interstitialMain')))
            ctx.close()

            # ── (D-3) ★다른 거래의 «되돌리기 창»을 광고가 덮지 않는다 (2026-09-12 Codex 리뷰 1번 · P1)
            #   원문: 「세 번째 거래 후 4초에 네 번째 거래를 체결하면, 1초 뒤 네 번째 되돌리기가 4초 남았는데 전면 show 1회」.
            #   ⇒ 확인창을 없앤 대가인 5초 되돌리기를 광고가 가리면 안 된다. «미뤘다가» 창이 다 닫힌 뒤에 띄운다.
            print('\n(D-3) 전면 — 열린 되돌리기 창이 있으면 «미룬다»(가리지 않는다)')
            ctx, page, errs, blocked = new_ctx(browser, clock=True)
            boot(page, '#/home', '.tabbar')
            page.evaluate('() => window.__ML_ADVANCE_MS(61000)'); page.wait_for_timeout(600)
            trade(page)
            trade(page)
            trade(page, wait_expire=False)          # 3번째 — 창이 «열린 채»로 둔다
            # ★두 창을 «충분히 벌린다»(1.5초). 붙여 두면 둘이 거의 같이 닫혀 판정 지점이 사라진다
            #   (실측: 간격 0.4초일 때 3번째 만료를 본 순간 4번째도 이미 닫혀 거짓 FAIL 이 났다)
            page.wait_for_timeout(1500)
            trade(page, wait_expire=False)          # 4번째 — 3번째 창이 닫히기 «전»에 새 창을 연다
            # ★시각을 «세지 말고» 화면을 본다 — 되돌리기 창 수가 2 → 1 로 줄어드는 «그 순간»이 판정 지점이다.
            #   (첫 판은 고정 대기 5.7초를 썼다가 4번째 창까지 닫힌 뒤에 재서 거짓 FAIL 이 났다)
            UNDO_N = "() => document.querySelectorAll('.toast--act').length"
            n0 = page.evaluate(UNDO_N)
            check('[전면·되돌리기 보호] 준비: 되돌리기 창이 «둘» 열렸다(대조군)', n0 == 2, n0)
            t_end = time.time() + (UNDO_MS + 4000) / 1000
            while time.time() < t_end and page.evaluate(UNDO_N) > 1:
                page.wait_for_timeout(120)
            page.wait_for_timeout(150)              # N번째 판정이 돌 시간만 준다(⛔길게 주면 4번째 창까지 닫힌다)
            left = page.evaluate(UNDO_N)
            il = admob(page, 'load', 'interstitialMain'); ish = admob(page, 'show', 'interstitialMain')
            st = page.evaluate(STATS_JS, 'interstitialMain')
            check('[전면·되돌리기 보호] ★다른 거래의 창이 «아직 열려 있는» 동안 load 0 · show 0',
                  left == 1 and len(il) == 0 and len(ish) == 0, (left, il, ish))
            check('[전면·되돌리기 보호] 계측 guard 사유 undo-open(왜 안 떴는지가 기록된다)',
                  bool(st) and any(e.get('reason') == 'undo-open' for e in (st or {}).get('recent', [])), (st or {}).get('counters'))
            t_end = time.time() + (UNDO_MS + 5000) / 1000
            while time.time() < t_end and page.evaluate(UNDO_N) > 0:
                page.wait_for_timeout(150)
            page.wait_for_timeout(900)              # 4번째 창도 닫힌다 → 그때 비로소 나간다
            il2 = admob(page, 'load', 'interstitialMain')
            check('[전면·되돌리기 보호] ★창이 «다» 닫히면 그때 1회 나간다(미뤘을 뿐 잃어버리지 않는다)',
                  len(il2) == 1, len(il2))
            check('[전면·되돌리기 보호] pageerror 0', not any('PAGEERROR' in e for e in errs), [e for e in errs if 'PAGEERROR' in e][:2])
            ctx.close()

            # 진입 60초 이내 = 정책 가드 → 0, 계측 guard(session-start)
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/home', '.tabbar')
            for _ in range(NTH):
                trade(page)
            check('[전면·60초 이내] 세션 시작 60초 안의 3번째 완료 → load 0(정책 가드)', len(admob(page, 'load', 'interstitialMain')) == 0, len(admob(page, 'load', 'interstitialMain')))
            st = page.evaluate(STATS_JS, 'interstitialMain')
            check('[전면·60초 이내] 계측 guard 1 · 사유 session-start', bool(st and st['counters']) and st['counters']['guard'] == 1 and any(e.get('reason') == 'session-start' for e in st['recent']), st)
            ctx.close()

            # 오늘 3회 상한 → 0, 계측 guard(daily-cap)
            ctx, page, errs, blocked = new_ctx(browser, clock=True, interstitial_ledger={'dateKey': kst_key(), 'count': 3, 'lastAt': 0, 'lastRewardAt': 0})
            boot(page, '#/home', '.tabbar')
            page.evaluate('() => window.__ML_ADVANCE_MS(61000)'); page.wait_for_timeout(600)
            for _ in range(NTH):
                trade(page)
            check('[전면·일 3회] 오늘 3회 찼으면 load 0', len(admob(page, 'load', 'interstitialMain')) == 0, len(admob(page, 'load', 'interstitialMain')))
            st = page.evaluate(STATS_JS, 'interstitialMain')
            check('[전면·일 3회] 계측 guard 사유 daily-cap', bool(st) and any(e.get('reason') == 'daily-cap' for e in (st or {}).get('recent', [])), st)
            ctx.close()

            # ── (D-2) ★로드 대기 중 화면이 숨겨지면 show 하지 않는다 (Codex 리뷰 LOAD_THEN_REWARD_AND_HIDDEN)
            print('\n(D-2) 전면 — 로드 대기 중 숨겨지면 show 0 · 복귀해도 「안 보이는 노출」을 만들지 않는다')
            ctx, page, errs, blocked = new_ctx(browser, clock=True)
            boot(page, '#/home', '.tabbar')
            page.evaluate('() => window.__ML_ADVANCE_MS(61000)'); page.wait_for_timeout(600)
            page.evaluate("() => { window.__ML_MODE.admobLoad = 'manual'; }")
            for _ in range(NTH):
                trade(page)
            page.wait_for_timeout(600)
            check('[전면·hidden] 3번째 완료 → load 요청 1(응답 보류 중)', len(admob(page, 'load', 'interstitialMain')) == 1, len(admob(page, 'load', 'interstitialMain')))
            page.evaluate(VIS_JS, 'hidden'); page.wait_for_timeout(300)
            fired = page.evaluate('() => window.__ML_FIRE_LOAD()')
            page.wait_for_timeout(900)
            check('[전면·hidden] 로드 응답이 «숨김 중»에 오면 show 0(안 보이는 노출을 만들지 않는다)',
                  fired.get('ok') is True and len(admob(page, 'show', 'interstitialMain')) == 0, (fired, len(admob(page, 'show', 'interstitialMain'))))
            st = page.evaluate(STATS_JS, 'interstitialMain')
            check('[전면·hidden] 계측 guard 사유 hidden-at-show · 원장 count 0(상한을 헛되이 쓰지 않는다)',
                  bool(st) and any(e.get('reason') == 'hidden-at-show' for e in (st or {}).get('recent', [])) and
                  (page.evaluate("() => JSON.parse(localStorage.getItem('ml.ads.interstitial') || '{}').count") or 0) == 0, st and st['counters'])
            page.evaluate(VIS_JS, 'visible'); page.wait_for_timeout(800)
            check('[전면·hidden] 복귀해도 그 광고가 «뒤늦게» 뜨지 않는다', len(admob(page, 'show', 'interstitialMain')) == 0, len(admob(page, 'show', 'interstitialMain')))
            ctx.close()

            # ── (B-2) ★실패 백오프가 화면 이탈·재진입에도 «유지»된다 (Codex 리뷰 RECLAIM_RETRY_WAIT)
            print('\n(B-2) 배너 실패 쿨다운 — 화면을 나갔다 와도 30초 안에는 재요청 0')
            ctx, page, errs, blocked = new_ctx(browser)
            boot(page, '#/journal', '.screen'); page.wait_for_timeout(800)
            page.evaluate("() => { window.__ML_MODE.banner = 'error'; }")
            boot(page, '#/home', '.tabbar')
            scroll_to_banner(page); page.wait_for_timeout(1500)
            t0 = time.time()
            check('[cooldown] 첫 요청 1 · 실패', len(reqs(page, 'bannerHome')) == 1, len(reqs(page, 'bannerHome')))
            boot(page, '#/settings', '.li'); page.wait_for_timeout(2200)   # 주차 유예(1.5s)를 넘겨 완전히 떠난다
            boot(page, '#/home', '.tabbar')
            scroll_to_banner(page); page.wait_for_timeout(1500)
            check('[cooldown] ★재진입해도 쿨다운(30초) 안에는 요청 그대로 1', len(reqs(page, 'bannerHome')) == 1, len(reqs(page, 'bannerHome')))
            check('[cooldown] 상태가 retry-wait 로 «남아 있다»(요청했다고 굳지 않는다)',
                  page.evaluate(SLOTS_JS) and page.evaluate(SLOTS_JS)[0]['state'] in ('retry-wait', 'failed'), page.evaluate(SLOTS_JS))
            while time.time() - t0 < RETRY0_MS / 1000 + 5:
                page.wait_for_timeout(500)
            check('[cooldown] 30초가 지나면 «그때» 재시도 1 → 요청 2', len(reqs(page, 'bannerHome')) == 2, len(reqs(page, 'bannerHome')))
            ctx.close()

            # ── (E) 파생 탭 ──────────────────────────────────────────────
            print('\n(E) 파생 탭 — 배너 제거')
            for in_toss in (True, False):
                ctx, page, errs, blocked = new_ctx(browser, in_toss=in_toss)
                boot(page, '#/derivatives', '.derivcta'); page.wait_for_timeout(800)
                g = page.evaluate(GHOST_DERIV_JS)
                check(f"[파생·{'토스안' if in_toss else '토스밖'}] .adslot 0 · 유령 여백 0 · CTA 유지", g['adslots'] == 0 and not g['ghosts'] and g['cta'], g)
                if in_toss:
                    check('[파생·토스안] 배너 요청 0', len(reqs(page)) == 0, len(reqs(page)))
                    page.screenshot(path=str(out / 'E_derivatives_no_banner.png')); rep['shots'].append('E_derivatives_no_banner.png')
                ctx.close()

            # ── (G) 폭·로케일 — 출석 시트(버튼 상태) ─────────────────────
            print('\n(G) ko/en × 375/390/430 — 출석 시트 버튼 상태 넘침·raw 키·보간·이모지 0')
            for lang in ('ko', 'en'):
                for w in (375, 390, 430):
                    ctx, page, errs, blocked = new_ctx(browser, lang=lang, width=w)
                    boot(page, '#/journal', '.screen'); page.wait_for_timeout(500)   # 해제(포트폴리오 확인)
                    boot(page, '#/home', '.tabbar')
                    page.locator('.attchip').click(); page.wait_for_selector('.sheet .attstrip', timeout=10000); page.wait_for_timeout(400)
                    sh = page.evaluate(SHEET_JS)
                    ov = page.evaluate(OVERFLOW_JS, '.sheet')
                    raw = scan_raw_keys(page)
                    check(f'[{lang}·{w}] 시트 버튼 1 · 넘침 0 · raw 키 0 · 보간 0 · 이모지 0 · pageerror 0',
                          sh and sh['bonus'] == 1 and not ov and not raw and not page.evaluate(INTERP_JS) and not page.evaluate(EMOJI_JS) and not any('PAGEERROR' in e for e in errs),
                          (sh and sh['btns'], ov[:2], raw[:2]))
                    page.screenshot(path=str(out / f'G_sheet_{lang}_{w}.png')); rep['shots'].append(f'G_sheet_{lang}_{w}.png')
                    ctx.close()
    finally:
        httpd.shutdown()

    (out / 'verify_ads33_report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    passed = sum(1 for _, ok, _ in rep['checks'] if ok)
    print(f"\n대조 {sum(1 for _, c in rep['controls'] if c)}/{len(rep['controls'])} · 검사 {passed}/{len(rep['checks'])} · 스크린샷 {len(rep['shots'])}장 → {out}")
    if rep['fail']:
        print('FAILED:')
        for n, d in rep['fail']:
            print('  -', n, d)
        return 1
    print('OK'); return 0


if __name__ == '__main__':
    sys.exit(main())
