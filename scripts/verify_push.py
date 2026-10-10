# -*- coding: utf-8 -*-
"""
토스 푸시 알림 동의 배선 검증 — ★headless 전용 (2026-09-10 신설).
⛔창을 띄우지 않는다(President 화면 점유 금지).

  ML_DIST=dist/web python scripts/verify_push.py <출력폴더>

★무엇을 증명하나
  (A) 토스 «밖»: 설정 「알림」 그룹·홈 안내 카드가 «통째로» 없다(빈 래퍼 0).
  (B) 토스 «안»: 둘 다 보인다. 「받기」→ 브릿지에 requestNotificationAgreement 구독이 «정확히 1건»,
      args.templateCode 가 소스 상수와 «글자 그대로» 같다. newAgreement → 「켜짐」· 홈 안내 사라짐 ·
      네이티브 Storage(흉내)에 ml.push 기록 → 재시작 뒤에도 「켜짐」.
  (C) agreementRejected → 「다시 켜기」, 홈 안내 없음. onError → 안내 문구가 오류 문구로 바뀌고 앱은 안 죽는다.
  (D) 홈 「닫기」→ 안내 사라짐, 재시작 뒤에도 안 뜸, 설정 행은 남는다.
  (E) 연속 3탭 → 구독 1건(busy 가드).
  (F) ko/en × 375/390/430 폭 넘침·raw 키·보간 누락·이모지 0.

★네이티브 브릿지 «흉내» (verify_share.py 와 같은 방법 · SDK 코드는 진짜가 돈다)
  postMessage 가로채기 + __GRANITE_NATIVE_EMITTER 로 응답. Storage 3종(getStorageItem/setStorageItem/
  removeStorageItem · args 배열 [key] / [key,value])은 «작동하는 미니 저장소»로 답해 재시작 영속을 실측한다.
"""
import http.server
import json
import os
import re
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
DIST = ROOT / os.environ.get('ML_DIST', 'dist/web')
PUSH_SRC = ROOT / 'src' / 'toss' / 'pushAgreement.ts'
CODE_RE = re.compile(r"export const PUSH_TEMPLATE_CODE = '([^']+)';")
WIDTHS = [375, 390, 430]

RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
RAW_KEY_ALLOW = re.compile(r'\d|\.(com|io|co|kr|js|css|png|json)$')

FAKE_BRIDGE_JS = r"""(() => {
  window.__ML_SENT = [];
  window.__ML_STORE = {};
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch { m = { raw }; }
      window.__ML_SENT.push(m);
      if (!m || !m.eventId || !m.functionName) return;
      if (m.type === 'addEventListener' || m.type === 'removeEventListener') return; // 이벤트는 테스트가 흘린다
      const em = () => window.__GRANITE_NATIVE_EMITTER;
      const a = Array.isArray(m.args) ? m.args : [];
      let reply = null;
      if (m.functionName === 'getStorageItem') reply = (a[0] in window.__ML_STORE) ? window.__ML_STORE[a[0]] : null;
      else if (m.functionName === 'setStorageItem') { window.__ML_STORE[a[0]] = String(a[1]); reply = null; }
      else if (m.functionName === 'removeStorageItem') { delete window.__ML_STORE[a[0]]; reply = null; }
      setTimeout(() => { em()?.emit(m.functionName + '/resolve/' + m.eventId, reply); }, 0);
    },
  };
  const subs = () => window.__ML_SENT.filter((m) => m.functionName === 'requestNotificationAgreement' && m.type === 'addEventListener');
  window.__ML_PUSH_SUBS = () => subs();
  window.__ML_PUSH_FIRE = (type) => {
    const s = subs(); if (!s.length) return { ok: false, reason: 'no-subscription' };
    const last = s[s.length - 1];
    window.__GRANITE_NATIVE_EMITTER.emit('requestNotificationAgreement/onEvent/' + last.eventId, { type });
    return { ok: true, eventId: last.eventId, args: last.args };
  };
  window.__ML_PUSH_ERROR = (msg) => {
    const s = subs(); if (!s.length) return { ok: false, reason: 'no-subscription' };
    const last = s[s.length - 1];
    window.__GRANITE_NATIVE_EMITTER.emit('requestNotificationAgreement/onError/' + last.eventId, { __isError: true, message: msg || 'UNSUPPORTED_APP_VERSION' });
    return { ok: true, eventId: last.eventId };
  };
})()"""

GHOST_JS = r"""() => {
  const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
  const roots = [...document.querySelectorAll('.scroll, .screen')];
  const seen = new Set(); const out = [];
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const c of el.children) {
      if (seen.has(c)) continue; seen.add(c);
      const r = c.getBoundingClientRect();
      const pad = px(c, 'paddingTop') + px(c, 'paddingBottom');
      const mar = px(c, 'marginTop') + px(c, 'marginBottom');
      if (Math.round(r.height) === 0 && (pad + mar) > 0) out.push({ cls: c.className || c.tagName, pad, mar });
      else if (Math.round(r.height) <= pad && pad > 0 && c.children.length === 0) out.push({ cls: c.className || c.tagName, pad, empty: true });
      walk(c, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}"""
INTERP_JS = r"""() => { const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const t=n.textContent||''; if (t.includes('{{')||t.includes('}}')) out.push(t.trim().slice(0,60)); } return out; }"""
EMOJI_JS = r"""() => { const RE=/(\p{Extended_Pictographic}|️|⃣|✓|✗)/gu; const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const p=n.parentElement; if(!p) continue; if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(p.tagName)) continue;
    const cs=getComputedStyle(p); if(cs.display==='none'||cs.visibility==='hidden') continue; const m=(n.textContent||'').match(RE); if(m) out.push((n.textContent||'').trim().slice(0,30)); } return out; }"""
# 넘침: 텍스트가 자기 상자를 «가로로» 넘는 leaf
OVERFLOW_JS = r"""(sel) => { const out=[]; for (const root of document.querySelectorAll(sel)) {
  for (const e of root.querySelectorAll('*')) { if (e.children.length) continue; if (!(e.textContent||'').trim()) continue;
    const cs=getComputedStyle(e); if (cs.overflow==='hidden'||cs.textOverflow==='ellipsis') continue;
    if (e.scrollWidth > e.clientWidth + 1 && cs.whiteSpace==='nowrap') out.push({t:(e.textContent||'').trim().slice(0,30), sw:e.scrollWidth, cw:e.clientWidth}); } }
  return out; }"""
NOTIFY_ROW_JS = r"""() => { const g=[...document.querySelectorAll('.grp')].find(x=>((x.querySelector('.grp__t')||{}).textContent||'').trim()==='알림'||((x.querySelector('.grp__t')||{}).textContent||'').trim()==='Notifications');
  if (!g) return null; const li=g.querySelector('.li'); const v=li && li.querySelector('.li__val');
  return { rows: g.querySelectorAll('.li').length, label:(li&&li.textContent||'').trim().slice(0,40), value:(v&&v.textContent||'').trim(), hint:((g.querySelector('.hint')||{}).textContent||'').trim(), disabled: !!(li&&li.disabled), h: g.getBoundingClientRect().height }; }"""
NUDGE_JS = r"""() => { const t=document.getElementById('pushnudge-title'); if (!t) return null; const card=t.closest('.card');
  const r=card.getBoundingClientRect(); const btns=[...card.querySelectorAll('button')].map(b=>({t:(b.textContent||'').trim()||b.getAttribute('aria-label'), w:Math.round(b.getBoundingClientRect().width), h:Math.round(b.getBoundingClientRect().height), dis:b.disabled}));
  return { title:t.textContent.trim(), top:Math.round(r.top), h:Math.round(r.height), btns }; }"""


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


def app_init_js(lang='ko', theme='light'):
    return ("(() => {"
            "localStorage.setItem('ml.onboarded','1');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "localStorage.removeItem('ml.game');"
            "})()" % (lang, theme))


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_push')
    out.mkdir(parents=True, exist_ok=True)
    m = CODE_RE.search(PUSH_SRC.read_text(encoding='utf-8'))
    if not m:
        print('FAILED: pushAgreement.ts 에서 PUSH_TEMPLATE_CODE 를 못 찾았다'); return 1
    CODE = m.group(1)
    rep = {'dist': str(DIST), 'templateCode': CODE, 'controls': [], 'checks': [], 'shots': [], 'fail': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    def control(name, caught):
        rep['controls'].append([name, bool(caught)]); print(f"  {'CAUGHT' if caught else 'MISSED'}  {name}"); return bool(caught)

    def health(page, tag, shot=None, full=False, errs=None):
        check(f'{tag}: 유령 여백/빈 상자 0', len(page.evaluate(GHOST_JS)) == 0, page.evaluate(GHOST_JS)[:3])
        check(f'{tag}: raw 키 0', len(scan_raw_keys(page)) == 0, scan_raw_keys(page)[:2])
        check(f'{tag}: 보간 누락 0', len(page.evaluate(INTERP_JS)) == 0, page.evaluate(INTERP_JS)[:2])
        check(f'{tag}: 이모지 0', len(page.evaluate(EMOJI_JS)) == 0, page.evaluate(EMOJI_JS)[:2])
        if errs is not None:
            check(f'{tag}: pageerror 0', not any('PAGEERROR' in x for x in errs), [x for x in errs if 'PAGEERROR' in x][:2])
        if shot:
            page.screenshot(path=str(out / shot), full_page=full); rep['shots'].append(shot)

    if not (DIST / 'index.html').exists():
        print('FAILED: 빌드가 없다 —', DIST); return 1
    js = ' '.join(p.read_text(encoding='utf-8', errors='ignore') for p in (DIST / 'assets').glob('*.js'))
    if not control('번들에 templateCode 가 «있다»(양성대조)', CODE in js):
        print('FAILED'); return 1
    check('번들에 requestNotificationAgreement 브릿지 이름이 있다', 'requestNotificationAgreement' in js)

    httpd, port = serve(DIST)
    base = f'http://127.0.0.1:{port}/'

    def new_page(browser, in_toss, lang='ko', theme='light', width=390):
        ctx = browser.new_context(viewport={'width': width, 'height': 844}, device_scale_factor=2, locale='ko-KR' if lang == 'ko' else 'en-US')
        if in_toss:
            ctx.add_init_script(FAKE_BRIDGE_JS)
        ctx.add_init_script(app_init_js(lang, theme))
        page = ctx.new_page(); errs = []
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        return ctx, page, errs

    def goto(page, route, sel):
        page.goto(base + route, wait_until='domcontentloaded'); page.wait_for_selector(sel, timeout=40000); page.wait_for_timeout(2400)

    with open_browser() as (_pw, browser):
        try:
            print('\n(1) 대조 — 검사기가 살아 있는가')
            ctx, page, errs = new_page(browser, True)
            goto(page, '#/settings', '.li')
            ok = True
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)"); page.wait_for_timeout(200)
            ok &= control('pageerror 감시기', any('NEEDLE_PAGE' in e for e in errs))
            page.evaluate("() => { const d=document.createElement('div'); d.id='nk'; d.textContent='push.needle.key'; document.body.appendChild(d); }")
            ok &= control('raw 키 스캐너', any(k.startswith('push.needle') for k, _ in scan_raw_keys(page)))
            page.evaluate("() => document.getElementById('nk')?.remove()")
            base_ghost = len(page.evaluate(GHOST_JS))
            page.evaluate("() => { const s=document.querySelector('.scroll'); const d=document.createElement('div'); d.id='ng'; d.style.padding='22px 0'; s.appendChild(d); }")
            ok &= control('유령 여백 탐지기', len(page.evaluate(GHOST_JS)) > base_ghost)
            page.evaluate("() => document.getElementById('ng')?.remove()")
            page.evaluate("() => window.ReactNativeWebView.postMessage(JSON.stringify({type:'needle',functionName:'__needle__'}))")
            ok &= control('브릿지 감청기', any(x.get('functionName') == '__needle__' for x in page.evaluate('() => window.__ML_SENT')))
            st = page.evaluate("() => window.__ML_STORE")
            ok &= control('Storage 흉내가 «실제로 쓰인다»(부팅 self-test 키가 들어왔다)', any(k.startswith('ml:') for k in st.keys()))
            if not ok:
                print('FAILED: 대조 실패 — 결과 무효'); return 1
            ctx.close()

            print('\n(2) 토스 «밖» — 알림 그룹·홈 안내가 통째로 없다')
            ctx, page, errs = new_page(browser, False)
            goto(page, '#/settings', '.li')
            check('[토스밖] 설정 「알림」 그룹 없음', page.evaluate(NOTIFY_ROW_JS) is None, page.evaluate(NOTIFY_ROW_JS))
            grps = page.eval_on_selector_all('.grp__t', 'els => els.map(e => e.textContent.trim())')
            check('[토스밖] 설정 그룹 = 화면·게임·계정 그대로', grps == ['화면', '게임', '계정'], grps)
            health(page, '[토스밖] 설정', shot='A_outside_settings.png', full=True, errs=errs)
            goto(page, '#/home', '.tabbar')
            check('[토스밖] 홈 안내 카드 없음', page.evaluate(NUDGE_JS) is None)
            health(page, '[토스밖] 홈', errs=errs)
            ctx.close()

            print('\n(3) 토스 «안» — 받기 → 동의 → 켜짐 → 재시작 유지')
            ctx, page, errs = new_page(browser, True)
            goto(page, '#/settings', '.li')
            row = page.evaluate(NOTIFY_ROW_JS)
            check('[토스안] 「알림」 그룹이 있다 · 행 1', bool(row) and row['rows'] == 1, row)
            check('[토스안] 행 값 = 「받기」', bool(row) and row['value'].startswith('받기'), row and row['value'])
            check('[토스안] 힌트에 「저녁 8시」·「토스 앱」 끄기 경로', bool(row) and '8시' in row['hint'] and '토스 앱' in row['hint'], row and row['hint'])
            grps = page.eval_on_selector_all('.grp__t', 'els => els.map(e => e.textContent.trim())')
            check('[토스안] 그룹 순서 = 화면·알림·게임·계정', grps == ['화면', '알림', '게임', '계정'], grps)
            health(page, '[토스안] 설정(받기 전)', shot='B_in_settings_before.png', full=True, errs=errs)

            tap = "() => { const g=[...document.querySelectorAll('.grp')].find(x=>x.querySelector('.grp__t').textContent.trim()==='알림'); g.querySelector('.li').click(); }"
            page.evaluate(tap); page.wait_for_timeout(500)
            subs = page.evaluate('() => window.__ML_PUSH_SUBS()')
            check('★구독 1건이 나갔다', len(subs) == 1, subs)
            check('★args.templateCode 가 소스 상수와 «글자 그대로» 같다', bool(subs) and (subs[-1].get('args') or {}).get('templateCode') == CODE, subs and subs[-1].get('args'))
            row = page.evaluate(NOTIFY_ROW_JS)
            check('동의창 대기 중 행 = 「확인 중」· disabled', row['value'].startswith('확인 중') and row['disabled'], row)
            # 연속 탭 — busy 가드
            page.evaluate(tap); page.evaluate(tap); page.wait_for_timeout(300)
            check('★대기 중 연속 탭 → 구독 «1건» 그대로', len(page.evaluate('() => window.__ML_PUSH_SUBS()')) == 1)
            r = page.evaluate("() => window.__ML_PUSH_FIRE('newAgreement')"); page.wait_for_timeout(700)
            check('이벤트 전달됨(테스트 유효)', r.get('ok') is True, r)
            removed = page.evaluate("() => window.__ML_SENT.filter(m => m.functionName==='requestNotificationAgreement' && m.type==='removeEventListener').length")
            check('★결과 뒤 브릿지 콜백을 «해제»했다(removeEventListener 1)', removed == 1, removed)
            row = page.evaluate(NOTIFY_ROW_JS)
            check('★행 값 = 「켜짐」', row['value'].startswith('켜짐'), row['value'])
            stored = page.evaluate("() => window.__ML_STORE['ml.push'] || null")
            check('★네이티브 Storage 에 ml.push 기록(agreedAt)', bool(stored) and 'agreedAt' in json.loads(stored), stored)
            health(page, '[토스안] 설정(켜짐)', shot='C_in_settings_on.png', full=True, errs=errs)
            goto(page, '#/home', '.tabbar')
            check('[동의 후] 홈 안내 카드 없음', page.evaluate(NUDGE_JS) is None)
            # 재시작(같은 컨텍스트 = 같은 흉내 저장소 · localStorage 의 ml.push 는 없다 → 네이티브에서 읽어야 한다)
            page.evaluate("() => localStorage.removeItem('ml.push')")
            goto(page, '#/settings', '.li')
            row = page.evaluate(NOTIFY_ROW_JS)
            check('★[재시작] 「켜짐」 유지(네이티브 Storage 에서 복원)', bool(row) and row['value'].startswith('켜짐'), row and row['value'])
            # 켜진 뒤 다시 누르면 alreadyAgreed → 그대로 켜짐
            page.evaluate(tap); page.wait_for_timeout(400)
            page.evaluate("() => window.__ML_PUSH_FIRE('alreadyAgreed')"); page.wait_for_timeout(500)
            check('[켜짐 상태 재탭] alreadyAgreed → 「켜짐」 유지', page.evaluate(NOTIFY_ROW_JS)['value'].startswith('켜짐'))
            ctx.close()

            print('\n(4) 거부 · 오류 경로')
            ctx, page, errs = new_page(browser, True)
            goto(page, '#/settings', '.li')
            page.evaluate(tap); page.wait_for_timeout(400)
            page.evaluate("() => window.__ML_PUSH_FIRE('agreementRejected')"); page.wait_for_timeout(600)
            row = page.evaluate(NOTIFY_ROW_JS)
            check('★거부 → 행 값 「다시 켜기」', row['value'].startswith('다시 켜기'), row['value'])
            health(page, '[거부]', shot='D_rejected.png', full=True, errs=errs)
            goto(page, '#/home', '.tabbar')
            check('[거부 후] 홈 안내 카드 없음(귀찮게 하지 않는다)', page.evaluate(NUDGE_JS) is None)
            goto(page, '#/settings', '.li')
            page.evaluate(tap); page.wait_for_timeout(400)
            page.evaluate("() => window.__ML_PUSH_ERROR('UNSUPPORTED_APP_VERSION')"); page.wait_for_timeout(600)
            row = page.evaluate(NOTIFY_ROW_JS)
            check('★오류 → 힌트가 오류 문구(업데이트 안내)로 바뀐다', '업데이트' in row['hint'], row['hint'])
            check('오류 뒤 행은 다시 누를 수 있다(disabled 아님)', not row['disabled'])
            check('[오류] pageerror 0 — 앱이 죽지 않는다', not any('PAGEERROR' in x for x in errs), [x for x in errs if 'PAGEERROR' in x][:2])
            health(page, '[오류]', shot='E_error.png', full=True)
            ctx.close()

            print('\n(5) 홈 안내 카드 — 보임 · 받기 · 닫기 · 재시작')
            ctx, page, errs = new_page(browser, True)
            goto(page, '#/home', '.tabbar')
            nd = page.evaluate(NUDGE_JS)
            check('[토스안] 홈 안내 카드가 있다', bool(nd), nd)
            # ★카드 자체는 빈 상태(보유 0)에서 첫 화면 안에 걸릴 수 있다(우리 안내라 허용).
            # ⚠광고 배너는 이 하네스에서 «안 그려진다»(광고 SDK constant bridge 부재 → AdBanner 가 null) — 배너 위치는 verify_adgaps 몫이다.
            #   여기서는 「카드 → ⑦ 많이 오른 종목 → (배너)」 순서와 간격만 센다: 카드가 배너 «옆»이 아니라 한 섹션 «위»임을 보인다.
            sec7 = page.evaluate("() => { const h=[...document.querySelectorAll('.sechead h3')].find(x=>/많이 오른|Moving up/.test(x.textContent)); return h ? Math.round(h.closest('.sec').getBoundingClientRect().top) : null; }")
            check('★카드 바로 아래가 ⑦ 많이 오른 종목 섹션이고 간격 ≥ 24px(광고 옆 자리가 아니다)', bool(nd) and sec7 is not None and sec7 - (nd['top'] + nd['h']) >= 24, (nd and nd['top'] + nd['h'], sec7))
            check('버튼 2개(받기·닫기) 터치 타깃 ≥ 24px', bool(nd) and len(nd['btns']) == 2 and all(b['w'] >= 24 and b['h'] >= 24 for b in nd['btns']), nd and nd['btns'])
            page.evaluate("() => document.getElementById('pushnudge-title').scrollIntoView({block:'center'})"); page.wait_for_timeout(400)
            health(page, '[토스안] 홈(안내)', shot='F_home_nudge.png', errs=errs)
            page.evaluate("() => { const c=document.getElementById('pushnudge-title').closest('.card'); [...c.querySelectorAll('button')].find(b=>b.textContent.trim()==='받기').click(); }")
            page.wait_for_timeout(400)
            subs = page.evaluate('() => window.__ML_PUSH_SUBS()')
            check('★홈 「받기」 → 구독 1건 · 같은 templateCode', len(subs) == 1 and subs[0]['args']['templateCode'] == CODE, subs)
            nd = page.evaluate(NUDGE_JS)
            check('대기 중 버튼 = 「확인 중」· disabled', bool(nd) and any(b['t'] == '확인 중' and b['dis'] for b in nd['btns']), nd and nd['btns'])
            page.evaluate("() => window.__ML_PUSH_FIRE('newAgreement')"); page.wait_for_timeout(600)
            check('★홈에서 동의 → 카드 사라짐', page.evaluate(NUDGE_JS) is None)
            health(page, '[토스안] 홈(동의 후)', shot='G_home_after.png', errs=errs)
            ctx.close()

            ctx, page, errs = new_page(browser, True)
            goto(page, '#/home', '.tabbar')
            page.evaluate("() => { const c=document.getElementById('pushnudge-title').closest('.card'); c.querySelector('button[aria-label]').click(); }")
            page.wait_for_timeout(400)
            check('★「닫기」 → 카드 사라짐', page.evaluate(NUDGE_JS) is None)
            check('닫기는 브릿지를 부르지 않는다(구독 0)', len(page.evaluate('() => window.__ML_PUSH_SUBS()')) == 0)
            page.evaluate("() => localStorage.removeItem('ml.push')")
            goto(page, '#/home', '.tabbar')
            check('★[재시작] 닫은 카드는 다시 안 뜬다', page.evaluate(NUDGE_JS) is None)
            goto(page, '#/settings', '.li')
            row = page.evaluate(NOTIFY_ROW_JS)
            check('★닫아도 설정 행은 남고 「받기」다', bool(row) and row['value'].startswith('받기'), row and row['value'])
            ctx.close()

            print('\n(6) 폭·로케일·테마 — 넘침 0')
            for lang in ('ko', 'en'):
                for w in WIDTHS:
                    for theme in (('light', 'dark') if w == 390 else ('light',)):
                        ctx, page, errs = new_page(browser, True, lang=lang, theme=theme, width=w)
                        goto(page, '#/settings', '.li')
                        ov = page.evaluate(OVERFLOW_JS, '.grp')
                        row = page.evaluate(NOTIFY_ROW_JS)
                        check(f'[{lang}·{w}·{theme}] 설정 알림 행 넘침 0 · 그룹 있음', len(ov) == 0 and bool(row), ov[:2] or row)
                        if w == 390:
                            page.screenshot(path=str(out / f'H_settings_{lang}_{theme}.png'), full_page=False); rep['shots'].append(f'H_settings_{lang}_{theme}.png')
                        goto(page, '#/home', '.tabbar')
                        page.evaluate("() => document.getElementById('pushnudge-title')?.scrollIntoView({block:'center'})"); page.wait_for_timeout(300)
                        ov = page.evaluate(OVERFLOW_JS, '.card')
                        nd = page.evaluate(NUDGE_JS)
                        check(f'[{lang}·{w}·{theme}] 홈 안내 넘침 0 · 카드 있음 · 높이 ≤ 92', len(ov) == 0 and bool(nd) and nd['h'] <= 92, ov[:2] or (nd and nd['h']))
                        if w in (375, 430) or theme == 'dark':
                            page.screenshot(path=str(out / f'I_home_{lang}_{w}_{theme}.png')); rep['shots'].append(f'I_home_{lang}_{w}_{theme}.png')
                        ctx.close()
        finally:
            httpd.shutdown()

    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    passed = sum(1 for _, ok, _ in rep['checks'] if ok)
    print(f"\n대조 {sum(1 for _, c in rep['controls'] if c)}/{len(rep['controls'])} · 검사 {passed}/{len(rep['checks'])} · 스크린샷 {len(rep['shots'])}장")
    if rep['fail']:
        print('FAILED:')
        for n, d in rep['fail']:
            print('  -', n, d)
        return 1
    print('OK'); return 0


if __name__ == '__main__':
    sys.exit(main())
