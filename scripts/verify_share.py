# -*- coding: utf-8 -*-
"""
공유 리워드(contactsViral) 실동작 검증 — ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_share.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_share.py <출력폴더>   # 출하물 기준

★★이 하네스가 «두 개의 빌드»를 보는 이유
  A) 출하 빌드(`dist` 또는 ML_DIST) — 리워드 ID 가 «들어 있는» 진짜 빌드다.
     토스 «밖»(itch.io·GitHub Pages·MS Store·로컬)과 토스 «안» 두 경우를 모두 본다.
  B) OFF 빌드 — 이 스크립트가 «임시로» ID 를 빈 값으로 만들어 한 번 빌드한다.
     ⇒ 「ID 가 없으면 기능이 조용히 꺼지고, 화면에 빈 구멍·유령 여백이 없다」를 증명한다.
     ⇒ 소스는 빌드 직후 ★즉시 되돌리고, 되돌아갔는지 «다시 읽어» 확인한다.

★★네이티브 브릿지는 «흉내»낸다
  `contactsViral` 은 웹 경로에서 `createEventBridge('contactsViral')` 이고
  [실측: node_modules/@apps-in-toss/web-bridge/dist/bridge.js],
  그 브릿지는 ★`window.ReactNativeWebView.postMessage` 로 나가고
  ★`window.__GRANITE_NATIVE_EMITTER` 로 들어온다. 둘 다 «평범한 window 속성»이다.
  ⇒ postMessage 만 가로채면 «진짜 SDK 코드»가 그대로 돌고, 토스가 보낼 이벤트를
    그 자리에 넣어 줄 수 있다. ⛔앱 코드에 테스트 훅을 넣지 않는다.
  ★emitter 는 SDK 가 import 시점에 «스스로» 심는다 — 우리가 만들지 않는다.
"""
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
from pathlib import Path


# ★윈도우 콘솔 기본 코드페이지(cp949)에서는 «»·★ 가 그대로 죽는다.
#   ⛔출력이 죽으면 «결과를 못 읽는» 것이지 검사가 통과한 게 아니다.
for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ★★조직 표준 headless 런처를 «경유»한다 (2026-08-22 Chief 지시).
#   ⛔`pw.chromium.launch()` 를 직접 부르지 않는다 — headless 를 «변수로 받는» 구멍이
#     President 화면 점유 사고를 두 번 냈다. 이 런처는 headless=True 를 하드코딩하고
#     channel·devtools·slowMo 를 «시그니처에서 아예 안 받는다».
sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SHIP_DIST = ROOT / os.environ.get('ML_DIST', 'dist')
SHARE_SRC = ROOT / 'src' / 'lib' / 'share.ts'
VIEW = {'width': 390, 'height': 844}

ID_RE = re.compile(r"export const SHARE_REWARD_ID = '([^']*)';")
OFF_LINE = "export const SHARE_REWARD_ID = '';"

RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
RAW_KEY_ALLOW = re.compile(r'\d|\.(com|io|co|kr|js|css|png|json)$')


def ship_id():
    """출하 소스에 «지금» 박혀 있는 리워드 ID.
    ⛔여기에 값을 다시 적지 않는다 — 두 벌이 되면 소스를 바꿔도 검사기가 옛 값을
      계속 맞다고 말한다(`ait_header.py` stale 기대값 사고와 같은 형태)."""
    m = ID_RE.search(SHARE_SRC.read_text(encoding='utf-8'))
    if not m:
        raise SystemExit('FAILED: share.ts 에서 SHARE_REWARD_ID 줄을 못 찾았다.')
    return m.group(1)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


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


# ★토스 «안»인 척한다. isInToss() 가 요구하는 것은 정확히 두 가지다
#   [실측: src/toss/env.ts] (1) ReactNativeWebView.postMessage 가 함수
#                           (2) __GRANITE_NATIVE_EMITTER 존재
#   (2)는 SDK 가 스스로 심으므로 (1)만 우리가 준다.
# ⛔__CONSTANT_HANDLER_MAP 은 «일부러» 안 심는다 — 광고 SDK(constant bridge)가
#   지원 안 함으로 떨어져야 충전 화면이 「소진」 단계로 가서 공유 CTA 자리를 실제로 볼 수 있다.
FAKE_BRIDGE_JS = r"""(() => {
  window.__ML_SENT = [];
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch { m = { raw }; }
      window.__ML_SENT.push(m);
      /* 비동기 브릿지(identity·storage 등)는 «즉시» null 로 답해 부팅을 막지 않는다.
         ⛔공유 모듈은 여기서 답하지 않는다 — 이벤트는 테스트가 «직접» 흘린다. */
      if (m && m.eventId && m.functionName && m.functionName !== 'contactsViral'
          && m.type !== 'addEventListener' && m.type !== 'removeEventListener') {
        setTimeout(() => {
          window.__GRANITE_NATIVE_EMITTER?.emit(m.functionName + '/resolve/' + m.eventId, null);
        }, 0);
      }
    },
  };
  const lastSub = () => {
    const subs = window.__ML_SENT.filter((m) => m.functionName === 'contactsViral' && m.type === 'addEventListener');
    return subs.length ? subs[subs.length - 1] : null;
  };
  /** 공유 모듈에 붙은 eventId 를 찾아 이벤트 한 건을 흘린다 */
  window.__ML_FIRE = (payload) => {
    const s = lastSub();
    if (!s) return { ok: false, reason: 'no-subscription' };
    window.__GRANITE_NATIVE_EMITTER.emit('contactsViral/onEvent/' + s.eventId, payload);
    return { ok: true, eventId: s.eventId, moduleId: s.args && s.args.moduleId };
  };
  /** ★네이티브 에러(미등록·틀린 리워드 ID 의 실제 증상)를 흘린다 */
  window.__ML_FIRE_ERROR = (msg) => {
    const s = lastSub();
    if (!s) return { ok: false, reason: 'no-subscription' };
    window.__GRANITE_NATIVE_EMITTER.emit('contactsViral/onError/' + s.eventId,
      { __isError: true, message: msg || 'Internal Server Error' });
    return { ok: true, eventId: s.eventId };
  };
})()"""


def kst_date_key_js():
    """gameWorld.kstDateKey 와 «같은 식». 날짜키가 어긋나면 카운터가 리셋돼 검사가 공허해진다"""
    return ("(() => { const k = new Date(Date.now() + 9*3600*1000);"
            " return k.getUTCFullYear() + '-' + String(k.getUTCMonth()+1).padStart(2,'0')"
            " + '-' + String(k.getUTCDate()).padStart(2,'0'); })()")


def app_init_js(save_js='null'):
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "localStorage.removeItem('ml.journal');"
        "const kd = %s;"
        "const sv = %s;"
        "if (sv) { sv.topup.dateKey = kd; if (sv.daily) sv.daily.dateKey = kd;"
        " localStorage.setItem('ml.game', JSON.stringify(sv)); }"
        "else { localStorage.removeItem('ml.game'); }"
        "})()" % (kst_date_key_js(), save_js)
    )


def exhausted_save():
    """무료 충전 3회를 «다 쓴» 상태. 광고 지원도 없으므로 충전 화면이 '소진' 단계가 된다."""
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {
            'cash': 10000, 'holdings': [], 'levPositions': [], 'optPositions': [],
            # ★tradeCount 4 = 「합계에만 있는 옛 거래 4건」 상태를 만든다.
            #   리워드 줄이 그 4를 3으로 깎으면 «요약과 행이 어긋난» 것이다.
            'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 4, 'liquidationCount': 0, 'topupCount': 0,
        },
        'topup': {'dateKey': '', 'usedToday': 3, 'lastTopupAt': 0},
        'prices': {},
    })


# 유령 여백 · 빈 상자 (verify_adgaps.py 와 «같은 모양 규칙». 화면이 달라도 잡힌다)
GHOST_JS = r"""() => {
  const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
  const roots = [...document.querySelectorAll('.scroll, .vlist, .screen, .cta')];
  const seen = new Set();
  const out = [];
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const c of el.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      const r = c.getBoundingClientRect();
      const pad = px(c, 'paddingTop') + px(c, 'paddingBottom');
      const mar = px(c, 'marginTop') + px(c, 'marginBottom');
      if (Math.round(r.height) === 0 && (pad + mar) > 0) {
        out.push({ cls: c.className || c.tagName, pad, mar, top: Math.round(r.top) });
      } else if (Math.round(r.height) <= pad && pad > 0 && c.children.length === 0) {
        out.push({ cls: c.className || c.tagName, pad, mar, top: Math.round(r.top), empty: true });
      }
      walk(c, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}"""

EMOJI_JS = r"""() => {
  const RE = /(\p{Extended_Pictographic}|️|⃣|✓|✗)/gu;
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const p = n.parentElement;
    if (!p) continue;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(p.tagName)) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const m = (n.textContent || '').match(RE);
    if (m) out.push({ chars: [...new Set(m)].join(''), text: (n.textContent||'').trim().slice(0,30) });
  }
  return out;
}"""

# ★i18n «보간 누락» — 화면에 `{{n}}` 이 그대로 찍히는 결함.
#   ⛔`check_i18n_keys.mjs` 는 ko/en «일치»만 본다. 호출부가 인자를 안 넘긴 것은 못 잡는다.
#   실제로 이번 트랙에서 `t('shareCtaSub')` 를 인자 없이 부른 채로 지나갈 뻔했다.
INTERP_JS = r"""() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.textContent || '';
    if (t.includes('{{') || t.includes('}}')) out.push(t.trim().slice(0, 60));
  }
  return out;
}"""

BOT_JS = r"""() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.textContent || '';
    if (t.includes('봇')) out.push(t.trim().slice(0, 40));
  }
  return out;
}"""

# ★잔고·일지는 ★«저장본»에서 읽는다 — 화면 표기가 아니라 «엔진이 장부에 적은 값»이다.
LEDGER_JS = r"""() => {
  let g = null, j = [];
  try { g = JSON.parse(localStorage.getItem('ml.game') || 'null'); } catch {}
  try { j = JSON.parse(localStorage.getItem('ml.journal') || '[]'); } catch {}
  return {
    cash: g && g.account ? g.account.cash : null,
    bonusSeed: g && g.account ? (g.account.bonusSeed ?? null) : null,
    topupCount: g && g.account ? g.account.topupCount : null,
    tradeCount: g && g.account ? g.account.tradeCount : null,
    realizedPnl: g && g.account ? g.account.realizedPnl : null,
    shareGrants: g && g.daily ? (g.daily.shareGrants ?? null) : null,
    shareUsd: g && g.daily ? (g.daily.shareUsd ?? null) : null,
    saveVersion: g ? g.v : null,
    journalTotal: j.length,
    /* ★출석도 product='reward' 라 ★side 로 갈라야 «공유»만 세어진다.
       ⛔안 가르면 출석이 붙는 순간 공유 검사가 통째로 어긋난다(실제로 그렇게 났다). */
    journalReward: j.filter((e) => e.product === 'reward' && e.side === 'share').length,
    journalRewardNotional: j.filter((e) => e.product === 'reward' && e.side === 'share').map((e) => e.notional),
    journalHasRealizedOnReward: j.some((e) => e.product === 'reward' && e.side === 'share' && e.realized != null),
  };
}"""


def scan_raw_keys(page):
    texts = page.eval_on_selector_all(
        'body *',
        """els => els.filter(e => e.children.length === 0)
            .filter(e => !['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))
            .map(e => (e.textContent||'').trim()).filter(Boolean)""",
    )
    hits = []
    for tx in texts:
        for m in RAW_KEY_RE.finditer(' ' + tx + ' '):
            k = m.group(1)
            if RAW_KEY_ALLOW.search(k):
                continue
            hits.append((k, tx[:60]))
    return hits


def build_disabled(out_dir):
    """리워드 ID 를 «빈 값»으로 한 번 빌드한다 — 기능이 꺼진 화면이 깨지지 않는지 보려고.
    ⛔소스 되돌리기를 finally 로 «반드시» 보장하고, 되돌아간 것을 «다시 읽어» 확인한다."""
    original = SHARE_SRC.read_text(encoding='utf-8')
    try:
        SHARE_SRC.write_text(ID_RE.sub(OFF_LINE, original, count=1), encoding='utf-8', newline='')
        cmd = ['npx', 'vite', 'build', '--outDir', str(out_dir), '--emptyOutDir']
        r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                           encoding='utf-8', errors='replace', shell=(os.name == 'nt'))
        if r.returncode != 0:
            raise SystemExit('FAILED: OFF 빌드 실패\n' + (r.stdout or '') + (r.stderr or ''))
    finally:
        SHARE_SRC.write_text(original, encoding='utf-8', newline='')
    if SHARE_SRC.read_text(encoding='utf-8') != original:
        raise SystemExit('FAILED: 소스 복원 실패 — 손으로 확인해라: %s' % SHARE_SRC)
    return out_dir


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_share')
    out.mkdir(parents=True, exist_ok=True)
    SHIP_ID = ship_id()
    rep = {'shipDist': str(SHIP_DIST), 'shipId': SHIP_ID, 'controls': [], 'checks': [],
           'shots': [], 'fail': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    def control(name, caught):
        rep['controls'].append([name, bool(caught)])
        print(f"  {'CAUGHT' if caught else 'MISSED'}  {name}")
        return bool(caught)

    def screen_health(page, tag, shot=None, full=False, errs=None):
        check(f'{tag}: 유령 여백/빈 상자 0건', len(page.evaluate(GHOST_JS)) == 0, page.evaluate(GHOST_JS)[:3])
        check(f'{tag}: raw 키 0건', len(scan_raw_keys(page)) == 0, scan_raw_keys(page)[:2])
        check(f'{tag}: 이모지 0건', len(page.evaluate(EMOJI_JS)) == 0, page.evaluate(EMOJI_JS)[:2])
        check(f'{tag}: 「봇」 0건', len(page.evaluate(BOT_JS)) == 0, page.evaluate(BOT_JS)[:2])
        check(f'{tag}: ★i18n 보간 누락 0건', len(page.evaluate(INTERP_JS)) == 0, page.evaluate(INTERP_JS)[:2])
        if errs is not None:
            check(f'{tag}: 콘솔·페이지 에러 0건', len(errs) == 0, errs[:2])
        if shot:
            page.screenshot(path=str(out / shot), full_page=full)

    if not (SHIP_DIST / 'index.html').exists():
        print('FAILED: 출하 빌드가 없다 —', SHIP_DIST)
        return 1
    if not SHIP_ID:
        print('FAILED: 출하 소스의 리워드 ID 가 «빈 값»이다 — 지급 검사를 할 수 없다.')
        return 1

    CAP = int(re.search(r'SHARE_REWARD_DAILY_MAX = (\d+)',
                       (ROOT / 'src' / 'lib' / 'constants.ts').read_text(encoding='utf-8')).group(1))
    rep['dailyCap'] = CAP
    print(f'\n(1) 빌드 준비 (출하 ID = {SHIP_ID} · 하루 상한 = {CAP})')
    off_dist = build_disabled((out / '_off_dist').resolve())
    off_js = ' '.join(p.read_text(encoding='utf-8', errors='ignore') for p in (off_dist / 'assets').glob('*.js'))
    ship_js = ' '.join(p.read_text(encoding='utf-8', errors='ignore') for p in (SHIP_DIST / 'assets').glob('*.js'))
    ok = True
    ok &= control('출하 번들에 리워드 ID 가 «있다»(양성대조)', SHIP_ID in ship_js)
    ok &= control('OFF 번들에 리워드 ID 가 «없다»(음성대조)', SHIP_ID not in off_js)
    if not ok:
        print('FAILED: 빌드 대조 실패 — 아래 결과는 무효다.')
        return 1

    ship_httpd, ship_port = serve(SHIP_DIST)
    off_httpd, off_port = serve(off_dist)
    ship_base = f'http://127.0.0.1:{ship_port}/'
    off_base = f'http://127.0.0.1:{off_port}/'

    with open_browser() as (_pw, browser):
        try:
            print('\n(2) ★양성/음성 대조 — 이 실행의 「0건」이 유효한지 먼저 증명한다')
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(FAKE_BRIDGE_JS)
            ctx.add_init_script(app_init_js())
            page = ctx.new_page()
            errs, perrs = [], []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: perrs.append(str(e)))
            page.goto(ship_base + '#/home', wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=40000)
            page.wait_for_timeout(3200)
            if '#/start' in page.url or page.query_selector('.hero') is not None:
                print('FAILED: 온보딩에 머물러 있다 — 세션 주입 실패. 이 실행은 무효다.', page.url)
                return 1

            ok = True
            page.evaluate("() => console.error('NEEDLE_CONSOLE')")
            page.wait_for_timeout(120)
            ok &= control('콘솔 에러 감시기', any('NEEDLE_CONSOLE' in c for c in errs))
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)")
            page.wait_for_timeout(200)
            ok &= control('pageerror 감시기', any('NEEDLE_PAGE' in e for e in perrs))
            page.evaluate("() => { const d=document.createElement('div'); d.id='nk'; d.textContent='share.needle.key'; document.body.appendChild(d); }")
            ok &= control('raw 키 스캐너', any(k.startswith('share.needle') for k, _ in scan_raw_keys(page)))
            page.evaluate("() => document.getElementById('nk')?.remove()")
            page.evaluate("() => { const d=document.createElement('div'); d.id='ne'; d.textContent='NEEDLE \U0001F953'; document.body.appendChild(d); }")
            ok &= control('이모지 스캐너', any('\U0001F953' in h['chars'] for h in page.evaluate(EMOJI_JS)))
            page.evaluate("() => document.getElementById('ne')?.remove()")
            page.evaluate("() => { const d=document.createElement('div'); d.id='nc'; d.textContent='NEEDLE ' + String.fromCharCode(0x2713); document.body.appendChild(d); }")
            ok &= control('✓(U+2713) 스캐너', any('✓' in h['chars'] for h in page.evaluate(EMOJI_JS)))
            page.evaluate("() => document.getElementById('nc')?.remove()")
            page.evaluate("() => { const d=document.createElement('div'); d.id='nw'; d.textContent='NEEDLE 봇'; document.body.appendChild(d); }")
            ok &= control('「봇」 스캐너', len(page.evaluate(BOT_JS)) > 0)
            page.evaluate("() => document.getElementById('nw')?.remove()")
            ghost_base = len(page.evaluate(GHOST_JS))
            page.evaluate("() => { const s=document.querySelector('.scroll')||document.querySelector('.screen');"
                          " const d=document.createElement('div'); d.id='ng'; d.style.padding='22px 0'; s.appendChild(d); }")
            ok &= control('유령 여백/빈 상자 탐지기', len(page.evaluate(GHOST_JS)) > ghost_base)
            page.evaluate("() => document.getElementById('ng')?.remove()")
            page.evaluate("() => window.ReactNativeWebView.postMessage(JSON.stringify({type:'needle',functionName:'__needle__'}))")
            ok &= control('토스 브릿지 감청기', any(m.get('functionName') == '__needle__' for m in page.evaluate('() => window.__ML_SENT')))
            page.evaluate("() => { const g = JSON.parse(localStorage.getItem('ml.game')||'{}');"
                          " g.__needle = 1; localStorage.setItem('ml.game', JSON.stringify(g)); }")
            ok &= control('저장본 판독기', page.evaluate("() => JSON.parse(localStorage.getItem('ml.game')).__needle === 1"))
            if not ok:
                print('FAILED: 대조 실패 — 이 실행의 결과는 무효다.')
                json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                return 1
            ctx.close()

            # ★기능이 «꺼진» 두 경우. 둘 다 이 앱의 정상 경로다.
            #   off     = 리워드 ID 가 빈 값(발급 전·기능 중단)
            #   outside = itch.io · GitHub Pages · MS Store 래핑 · 로컬 브라우저
            print('\n(3) 기능이 꺼진 상태 — 화면이 깨지지 않는가')
            for mode, base, tag in [('off', off_base, '[ID없음]'), ('outside', ship_base, '[토스밖]')]:
                for label, route, wait_sel in [('settings', '#/settings', '.li'), ('recharge', '#/recharge', '.screen')]:
                    c2 = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                    if mode == 'off':
                        c2.add_init_script(FAKE_BRIDGE_JS)  # 토스 «안»이지만 ID 가 없다
                    c2.add_init_script(app_init_js(exhausted_save() if label == 'recharge' else 'null'))
                    p2 = c2.new_page()
                    e2 = []
                    p2.on('console', lambda m: e2.append(m.text) if m.type == 'error' else None)
                    p2.on('pageerror', lambda e: e2.append('PAGEERROR ' + str(e)))
                    p2.goto(base + route, wait_until='domcontentloaded')
                    p2.wait_for_selector(wait_sel, timeout=40000)
                    p2.wait_for_timeout(2600)
                    screen_health(p2, f'{tag} {label}', shot=f'A_{mode}_{label}.png',
                                  full=(label == 'settings'), errs=e2)
                    rep['shots'].append(f'A_{mode}_{label}')
                    if label == 'settings':
                        txt = p2.eval_on_selector_all('.li', 'els => els.map(e => (e.textContent||"").trim())')
                        check(f'{tag} 설정: 공유 리워드 행이 «없다»', not any('공유' in t for t in txt), txt)
                        game = p2.evaluate("""() => {
                            const g=[...document.querySelectorAll('.grp')].find(x=>(x.querySelector('.grp__t')||{}).textContent==='게임');
                            if(!g) return null;
                            const card=g.querySelector('.card');
                            return { rows: card.querySelectorAll('.li').length,
                                     dividers: card.querySelectorAll('.divider').length };
                        }""")
                        check(f'{tag} 설정 「게임」 카드: 행 3 · 구분선 2 (선만 남지 않았다)',
                              bool(game) and game['rows'] == 3 and game['dividers'] == 2, game)
                    else:
                        cta = p2.eval_on_selector_all('.cta .btn', 'els => els.map(e => ({t:(e.textContent||"").trim().slice(0,20), off: e.disabled}))')
                        check(f'{tag} 충전 소진: CTA 가 «기존 폴백»으로 남는다', len(cta) >= 2, cta)
                    c2.close()

            print('\n(4) 출하 빌드 · 토스 «안» — 지급 · 중복 방지 · 일지')
            ctx3 = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx3.add_init_script(FAKE_BRIDGE_JS)
            ctx3.add_init_script(app_init_js(exhausted_save()))
            p3 = ctx3.new_page()
            e3 = []
            p3.on('console', lambda m: e3.append(m.text) if m.type == 'error' else None)
            p3.on('pageerror', lambda e: e3.append('PAGEERROR ' + str(e)))
            p3.goto(ship_base + '#/settings', wait_until='domcontentloaded')
            p3.wait_for_selector('.li', timeout=40000)
            p3.wait_for_timeout(3000)

            rows = p3.eval_on_selector_all('.li', 'els => els.map(e => (e.textContent||"").trim())')
            check('[출하·토스안] 설정: 공유 리워드 행이 «있다»', any('공유' in t for t in rows), rows)
            p3.screenshot(path=str(out / 'B_ship_settings.png'), full_page=True)
            rep['shots'].append('B_ship_settings')

            before = p3.evaluate(LEDGER_JS)
            rep['ledgerBefore'] = before
            check('저장본 버전이 1 그대로다', before['saveVersion'] == 1, before['saveVersion'])

            def tap_share():
                p3.eval_on_selector_all('.li', 'els => { const b = els.find(e => (e.textContent||"").includes("공유")); b && b.click(); }')
                p3.wait_for_timeout(600)

            tap_share()
            subs = p3.evaluate("() => window.__ML_SENT.filter(m => m.functionName === 'contactsViral')")
            check('contactsViral 구독 1건이 나갔다', len(subs) == 1, subs)
            check('★moduleId 가 출하 리워드 ID 와 «글자 그대로» 같다',
                  bool(subs) and (subs[-1].get('args') or {}).get('moduleId') == SHIP_ID,
                  (subs[-1].get('args') if subs else None))

            # (4-a) 모르는 단위 → ⛔지급하지 않는다
            r0 = p3.evaluate("() => window.__ML_FIRE({type:'sendViral', data:{rewardAmount:5000000, rewardUnit:'보석'}})")
            p3.wait_for_timeout(800)
            mid = p3.evaluate(LEDGER_JS)
            check('[모르는 단위] 이벤트 전달은 됐다(테스트가 유효하다)', r0.get('ok') is True, r0)
            check('★[모르는 단위] 잔고 «불변» — 조용히 이상한 금액이 안 들어간다',
                  mid['cash'] == before['cash'], f"{before['cash']} -> {mid['cash']}")
            check('★[모르는 단위] 일지에 줄이 «안» 생긴다', mid['journalReward'] == 0, mid['journalReward'])
            check('★[모르는 단위] 오늘 몫이 «안» 소진된다', (mid['shareGrants'] or 0) == 0, mid['shareGrants'])

            # (4-b) 정상 지급
            fire = "() => window.__ML_FIRE({type:'sendViral', data:{rewardAmount:100000, rewardUnit:'게임 머니'}})"
            r1 = p3.evaluate(fire)
            p3.wait_for_timeout(900)
            after1 = p3.evaluate(LEDGER_JS)
            rep['ledgerAfter1'] = after1
            check('이벤트가 실제로 전달됐다', r1.get('ok') is True, r1)
            check('★현금 +100,000', after1['cash'] - before['cash'] == 100000, f"{before['cash']} -> {after1['cash']}")
            check('bonusSeed +100,000 (수익률 분모가 같이 올랐다)',
                  (after1['bonusSeed'] or 0) - (before['bonusSeed'] or 0) == 100000,
                  f"{before['bonusSeed']} -> {after1['bonusSeed']}")
            check('topupCount 는 «안» 오른다(충전 경로가 아니다)',
                  after1['topupCount'] == before['topupCount'], after1['topupCount'])
            check('shareGrants = 1', after1['shareGrants'] == 1, after1['shareGrants'])
            check('shareUsd = 100,000', after1['shareUsd'] == 100000, after1['shareUsd'])
            check('일지에 리워드 1건', after1['journalReward'] == 1, after1['journalReward'])
            check('일지 리워드 금액 = 100,000', after1['journalRewardNotional'] == [100000], after1['journalRewardNotional'])
            check('리워드 행에 realized 가 «없다»(요약과 어긋나지 않게)', after1['journalHasRealizedOnReward'] is False)
            check('거래 횟수·실현손익은 그대로다',
                  after1['tradeCount'] == before['tradeCount'] and after1['realizedPnl'] == before['realizedPnl'],
                  f"trades {after1['tradeCount']} · realized {after1['realizedPnl']}")

            # (4-c) ★같은 이벤트를 한 번 더 — «상한»이 유일한 방어선인지 확인한다
            #
            # ★★정직하게 적는다: 토스는 `sendViral` 에 ★이벤트 식별자를 주지 않는다
            #   [실측: contactsViral.d.ts 의 data 는 rewardAmount·rewardUnit 둘뿐].
            #   ⇒ 「재전달된 같은 이벤트」와 「두 번째 친구에게 공유 성공」이 ★구별 불가능하다.
            #   ⇒ 따라서 상한이 1 이면 재전달이 «부수적으로» 막히고,
            #      상한이 2 이상이면 재전달은 «정상 지급»과 같은 취급을 받는다.
            #      ★이 하네스는 그 사실을 숨기지 않고 «상한에 맞춰» 판정한다.
            r2 = p3.evaluate(fire)
            p3.wait_for_timeout(900)
            after2 = p3.evaluate(LEDGER_JS)
            rep['ledgerAfter2'] = after2
            check('★재전달 이벤트 전달 자체는 성공했다(테스트가 유효하다)', r2.get('ok') is True, r2)
            expect2 = min(2, CAP)
            check(f'★상한({CAP}) 기준으로 정확히 {expect2}건까지만 지급된다',
                  after2['shareGrants'] == expect2, after2['shareGrants'])
            check(f'★현금 = 시작 + 100,000 × {expect2}',
                  after2['cash'] - before['cash'] == 100000 * expect2,
                  f"{before['cash']} -> {after2['cash']}")
            check(f'★일지 {expect2}건 (지급과 «같은 수»)', after2['journalReward'] == expect2, after2['journalReward'])

            # (4-d) ★틀린/미등록 ID 의 실제 증상(네이티브 에러)
            r_err = p3.evaluate("() => window.__ML_FIRE_ERROR('Internal Server Error')")
            p3.wait_for_timeout(900)
            after_err = p3.evaluate(LEDGER_JS)
            check('[에러] 네이티브 에러 전달은 됐다(테스트가 유효하다)', r_err.get('ok') is True, r_err)
            check('★[에러] 잔고 «불변»', after_err['cash'] == after2['cash'],
                  f"{after2['cash']} -> {after_err['cash']}")
            check('★[에러] pageerror 0 — 앱이 죽지 않는다',
                  not any('PAGEERROR' in x for x in e3), [x for x in e3 if 'PAGEERROR' in x][:2])
            screen_health(p3, '[에러 뒤] 설정', shot='B_ship_after_error.png', full=True)
            rep['shots'].append('B_ship_after_error')

            # 일지 화면: 요약과 행이 어긋나지 않는가
            p3.goto(ship_base + '#/journal', wait_until='domcontentloaded')
            p3.wait_for_timeout(1600)
            jrows = p3.eval_on_selector_all('.jrow', 'els => els.map(e => (e.textContent||"").replace(/\\s+/g," ").trim())')
            check('일지 화면에 리워드 줄이 보인다', any('공유' in t for t in jrows), jrows[:3])
            check('일지 리워드 줄 수 = 지급 건수', sum(1 for t in jrows if '공유' in t) == expect2,
                  sum(1 for t in jrows if '공유' in t))
            check('일지 줄에 +$100,000 이 있다', any('100,000' in t for t in jrows), jrows[:3])
            summ = p3.evaluate("""() => {
                const v=[...document.querySelectorAll('.sumrow__v')].map(e=>(e.textContent||'').trim());
                const hint=(document.querySelector('.hint')||{}).textContent||'';
                return {v, hint};
            }""")
            rep['journalSummary'] = summ
            check('요약 「거래 횟수」는 원장값 4회 그대로다(리워드는 거래가 아니다)',
                  any('4' in x for x in summ['v']), summ['v'])
            check('★옛 거래 4건이 3건으로 깎이지 않았다',
                  '4' in summ['hint'] and '3' not in summ['hint'], summ['hint'])
            p3.eval_on_selector_all('.seg [role="tab"]',
                                    'els => { const b = els.find(e => (e.textContent||"").trim()==="파생"); b && b.click(); }')
            p3.wait_for_timeout(700)
            drows = p3.eval_on_selector_all('.jrow', 'els => els.map(e => (e.textContent||"").trim())')
            check('「파생」 필터에 리워드가 «안» 섞인다', not any('공유' in t for t in drows), drows[:3])
            p3.screenshot(path=str(out / 'C_journal_deriv.png'))
            p3.eval_on_selector_all('.seg [role="tab"]',
                                    'els => { const b = els.find(e => (e.textContent||"").trim()==="전체"); b && b.click(); }')
            p3.wait_for_timeout(600)
            p3.screenshot(path=str(out / 'C_journal.png'), full_page=True)
            rep['shots'] += ['C_journal', 'C_journal_deriv']

            p3.goto(ship_base + '#/home', wait_until='domcontentloaded')
            p3.wait_for_timeout(2200)
            p3.screenshot(path=str(out / 'D_home.png'))
            rep['shots'].append('D_home')

            print('\n(5) 앱 재시작 — 잔고·일지·중복방지가 유지되는가')
            p3.goto(ship_base + '#/settings', wait_until='domcontentloaded')
            p3.wait_for_selector('.li', timeout=40000)
            p3.wait_for_timeout(3000)
            after3 = p3.evaluate(LEDGER_JS)
            rep['ledgerAfterReload'] = after3
            check('[재시작] 현금 유지', after3['cash'] == after2['cash'], f"{after2['cash']} -> {after3['cash']}")
            check('[재시작] bonusSeed 유지', after3['bonusSeed'] == after2['bonusSeed'], after3['bonusSeed'])
            check(f'[재시작] 일지 리워드 {expect2}건 유지', after3['journalReward'] == expect2, after3['journalReward'])
            check('[재시작] shareGrants 유지', after3['shareGrants'] == after2['shareGrants'], after3['shareGrants'])

            # ★재시작 «후»에도 오늘 몫이 이어진다 = 카운터가 저장본에서 살아 돌아왔다
            tap_share()
            r3 = p3.evaluate(fire)
            p3.wait_for_timeout(900)
            after4 = p3.evaluate(LEDGER_JS)
            rep['ledgerAfterReloadFire'] = after4
            expect3 = min(expect2 + 1, CAP)
            check('[재시작] 이벤트 전달은 됐다(테스트가 유효하다)', r3.get('ok') is True, r3)
            check(f'★[재시작] 오늘 몫이 «이어진다» — 카운터 {expect3}(0 부터 다시 세지 않는다)',
                  after4['shareGrants'] == expect3, f"{after3['shareGrants']} -> {after4['shareGrants']}")
            check('★[재시작] 일지도 이어진다', after4['journalReward'] == expect3, after4['journalReward'])
            check('[출하·토스안] pageerror 0', not any('PAGEERROR' in x for x in e3),
                  [x for x in e3 if 'PAGEERROR' in x][:2])
            p3.screenshot(path=str(out / 'E_after_reload.png'), full_page=True)
            rep['shots'].append('E_after_reload')

            # ══════════════════════════════════════════════════════════
            # ★상한이 1 이 아니다(President 결정 10). 「1회에서 됐으니 10회도 되겠지」는
            #   근거가 아니다 — 상한 «근처»는 다른 코드 경로다. 여기서 직접 센다.
            print('\n(6) 하루 상한 · 경계 · 동시 이벤트 · 날짜 롤오버')
            cap = CAP  # ★위에서 상수 파일을 «한 번만» 읽었다. 두 벌로 두지 않는다
            print(f'  상수에서 읽은 하루 상한 = {cap}  (⛔여기에 숫자를 다시 적지 않는다)')

            def reset_day():
                """오늘 몫을 0 으로 되돌리고 잔고를 기준값으로 맞춘다(리로드 포함)"""
                p3.evaluate("""() => {
                    const g = JSON.parse(localStorage.getItem('ml.game'));
                    g.daily = g.daily || {};
                    g.daily.shareGrants = 0; g.daily.shareUsd = 0;
                    g.account.cash = 10000; g.account.bonusSeed = 0;
                    localStorage.setItem('ml.game', JSON.stringify(g));
                    localStorage.removeItem('ml.journal');
                }""")
                p3.goto(ship_base + '#/settings', wait_until='domcontentloaded')
                p3.reload(wait_until='domcontentloaded')
                p3.wait_for_selector('.li', timeout=40000)
                p3.wait_for_timeout(3000)

            reset_day()
            start = p3.evaluate(LEDGER_JS)
            tap_share()
            per_step = []
            for i in range(cap):
                p3.evaluate(fire)
                p3.wait_for_timeout(260)
                st = p3.evaluate(LEDGER_JS)
                per_step.append({'i': i + 1, 'cash': st['cash'], 'grants': st['shareGrants'],
                                 'journal': st['journalReward']})
            rep['capSteps'] = per_step
            full = p3.evaluate(LEDGER_JS)
            check(f'★{cap}회까지 «매 회» 지급된다',
                  all(x['grants'] == x['i'] for x in per_step), per_step[-1])
            check(f'★현금 = 시작 + 100,000 × {cap}',
                  full['cash'] - start['cash'] == 100000 * cap, f"{start['cash']} -> {full['cash']}")
            check(f'★일지 {cap}건', full['journalReward'] == cap, full['journalReward'])
            check('★분모(bonusSeed)도 같은 금액만큼 올랐다',
                  (full['bonusSeed'] or 0) - (start['bonusSeed'] or 0) == 100000 * cap, full['bonusSeed'])

            p3.evaluate(fire)
            p3.wait_for_timeout(700)
            over = p3.evaluate(LEDGER_JS)
            check(f'★★{cap + 1}회째는 «막힌다» — 현금 불변', over['cash'] == full['cash'],
                  f"{full['cash']} -> {over['cash']}")
            check(f'★★{cap + 1}회째는 «막힌다» — 카운터 {cap} 고정', over['shareGrants'] == cap, over['shareGrants'])
            check(f'★★{cap + 1}회째는 «막힌다» — 일지 {cap}건 그대로', over['journalReward'] == cap, over['journalReward'])

            # ★수익률 오염 여부 — 분자·분모가 같이 커지면 수익률은 «안 움직인다»
            p3.goto(ship_base + '#/home', wait_until='domcontentloaded')
            p3.wait_for_timeout(2600)
            home = p3.evaluate("""() => {
                const t=[...document.querySelectorAll('.screen *')].filter(e=>e.children.length===0)
                    .map(e=>(e.textContent||'').trim()).filter(Boolean);
                return t.slice(0, 14);
            }""")
            rep['homeAfterCap'] = home
            pct = None
            for tx in home:
                mm = re.search(r'\(([+-]?[\d.]+)%\)', tx)
                if mm:
                    pct = float(mm.group(1))
                    break
            rep['homePnlPctAfterCap'] = pct
            check('★수익률이 리워드로 «오염되지 않는다»(±1%p 이내)',
                  pct is not None and abs(pct) <= 1.0, f'{pct}% · {home[:6]}')
            p3.screenshot(path=str(out / 'F_home_after_cap.png'))
            rep['shots'].append('F_home_after_cap')

            # ★동시(더블탭) — 한 프레임 안에서 3건이 연달아 와도 «정확히 3건»만 오른다
            reset_day()
            tap_share()
            base3 = p3.evaluate(LEDGER_JS)
            p3.evaluate("""() => {
                for (let i = 0; i < 3; i++)
                    window.__ML_FIRE({type:'sendViral', data:{rewardAmount:100000, rewardUnit:'게임 머니'}});
            }""")
            p3.wait_for_timeout(900)
            burst = p3.evaluate(LEDGER_JS)
            check('★동시 3건 → 정확히 3건만 지급(카운터 경합 없음)',
                  burst['shareGrants'] == 3 and burst['cash'] - base3['cash'] == 300000,
                  f"grants {burst['shareGrants']} · cash {base3['cash']} -> {burst['cash']}")

            # ★모듈이 «정상 종료»되면 세션이 풀린다 (토스가 실제로 보내는 close 이벤트)
            p3.evaluate("""() => window.__ML_FIRE({type:'close',
                data:{closeReason:'clickBackButton', sentRewardsCount:3}})""")
            p3.wait_for_timeout(500)

            # ★연속 3탭으로 모듈이 «여러 번» 열리지 않는가
            before_subs = len(p3.evaluate("() => window.__ML_SENT.filter(m => m.functionName === 'contactsViral' && m.type === 'addEventListener')"))
            p3.goto(ship_base + '#/settings', wait_until='domcontentloaded')
            p3.wait_for_selector('.li', timeout=40000)
            p3.wait_for_timeout(2600)
            p3.evaluate("""() => {
                const b=[...document.querySelectorAll('.li')].find(e=>(e.textContent||'').includes('공유'));
                if(b){ b.click(); b.click(); b.click(); }
            }""")
            p3.wait_for_timeout(800)
            after_subs = len(p3.evaluate("() => window.__ML_SENT.filter(m => m.functionName === 'contactsViral' && m.type === 'addEventListener')"))
            check('★연속 3탭 → 공유 모듈 구독은 «1건»만 는다(중복 세션 없음)',
                  after_subs - before_subs == 1, f'{before_subs} -> {after_subs}')
            # ★열려 있는 세션을 정리하고 다음 검사로 간다
            p3.evaluate("""() => window.__ML_FIRE({type:'close',
                data:{closeReason:'clickBackButton', sentRewardsCount:0}})""")
            p3.wait_for_timeout(400)

            # ★날짜 롤오버 — KST 자정에 리셋되는가 (dateKey 를 «어제»로 바꿔 재현)
            p3.evaluate("""() => {
                const g = JSON.parse(localStorage.getItem('ml.game'));
                const k = new Date(Date.now() + 9*3600*1000 - 86400000);
                g.daily.dateKey = k.getUTCFullYear() + '-' + String(k.getUTCMonth()+1).padStart(2,'0')
                                + '-' + String(k.getUTCDate()).padStart(2,'0');
                g.daily.shareGrants = 999;
                localStorage.setItem('ml.game', JSON.stringify(g));
            }""")
            p3.goto(ship_base + '#/settings', wait_until='domcontentloaded')
            p3.reload(wait_until='domcontentloaded')
            p3.wait_for_selector('.li', timeout=40000)
            p3.wait_for_timeout(3200)
            roll_before = p3.evaluate(LEDGER_JS)
            tap_share()
            p3.evaluate(fire)
            p3.wait_for_timeout(800)
            roll_after = p3.evaluate(LEDGER_JS)
            check('★날짜가 바뀌면 오늘 몫이 «리셋»된다(어제 999 → 오늘 1)',
                  roll_after['shareGrants'] == 1, f"{roll_before['shareGrants']} -> {roll_after['shareGrants']}")
            check('★리셋 뒤 지급이 «다시» 된다', roll_after['cash'] - roll_before['cash'] == 100000,
                  f"{roll_before['cash']} -> {roll_after['cash']}")

            # ★충전 화면의 공유 CTA — 보간 누락이 «화면에» 남지 않는가
            p3.goto(ship_base + '#/recharge', wait_until='domcontentloaded')
            p3.wait_for_selector('.screen', timeout=40000)
            p3.wait_for_timeout(2600)
            cta = p3.eval_on_selector_all('.cta .btn', 'els => els.map(e => (e.textContent||"").trim())')
            rep['rechargeCta'] = cta
            check('[출하·토스안] 충전 소진 화면에 공유 CTA 가 «있다»',
                  any('공유' in t for t in cta), cta)
            screen_health(p3, '[출하·토스안] 충전(공유 CTA)', shot='G_recharge_share_cta.png', full=True)
            rep['shots'].append('G_recharge_share_cta')

            ctx3.close()
        finally:
            # ★정적 서버는 «끝나면 끈다». 좀비 서버를 남기지 않는다(Chief 지시).
            #   브라우저 종료는 open_browser 의 with 가 보장한다.
            ship_httpd.shutdown()
            off_httpd.shutdown()

    shutil.rmtree(off_dist, ignore_errors=True)
    rep['offDistRemoved'] = not off_dist.exists()
    rep['shipSourceId'] = ship_id()
    rep['shipSourceUnchanged'] = rep['shipSourceId'] == SHIP_ID

    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    passed = sum(1 for _, ok, _ in rep['checks'] if ok)
    print(f"\n대조 {sum(1 for _, c in rep['controls'] if c)}/{len(rep['controls'])} · "
          f"검사 {passed}/{len(rep['checks'])} · 스크린샷 {len(rep['shots'])}장")
    print(f"OFF 산출물 삭제: {rep['offDistRemoved']} · 출하 소스 ID 그대로: {rep['shipSourceUnchanged']}")
    if rep['fail'] or not rep['shipSourceUnchanged']:
        print('FAILED:')
        for n, d in rep['fail']:
            print('  -', n, d)
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
