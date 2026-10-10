# -*- coding: utf-8 -*-
"""
프로모션 신설 2종 «실행» 검증 — ★headless 전용(창 0). 2026-09-01

    ML_DIST=dist/web python scripts/verify_promo2.py [출력폴더]

★무엇을 «실제로» 태우는가
  가짜 네이티브 브릿지를 심어 `isInToss()` 를 true 로 만들고,
  `grantPromotionReward` 만 «성공»으로 응답한다(나머지 브릿지는 즉시 reject →
  safeBridge 폴백이 localStorage 를 쓰게 둔다 = 평소 웹 경로와 같은 저장 동작).
  ⇒ 「조건 충족 → 지급 API 호출」이 «정말로» 일어나는지, 호출 «횟수·코드·금액»을 센다.

★TESTONLY 빌드 전용이다(문턱 완화: ★equity 1 USD · play 60,000 ms).
  정본(1,000,000 USD · 1시간)은 당일 검증이 불가능하다.

══════════════════════════════════════════════════════════════════════════
★★2026-09-01 개정 — TESTONLY 는 이제 «기준선 게이트를 우회»한다
══════════════════════════════════════════════════════════════════════════
  사고: 옛 TESTONLY(문턱 10,500)는 「시드 10,000 에서 시작하는 새 기기」를 전제했다.
        President 는 앱을 계속 써 온 «기존 유저»라 저장된 총자산이 10,500 을 한참 넘어
        TESTONLY 빌드가 처음 도는 순간 base.had=true 로 박히고 → 영구 미지급이 됐다.
        (= 버그가 아니라 소급 차단이 설계대로 작동한 결과. TESTONLY 에 해제가 빠져 있었다)
  조치: promo_testonly_patch.mjs 가 promoCore 에 PROMO_IGNORE_BASELINE 을 «심는다».
        equity1m 만 기준선을 읽지도 쓰지도 않고 곧장 claim 으로 간다.
  ⇒ 그래서 «기대값이 뒤집힌다»: S3 는 0회가 아니라 ★1회여야 한다.
    ⛔정본에서 0회인지는 `check_promo_hooks`(정본 소스) 가 본다 — 두 방향을 나눠서 본다.
══════════════════════════════════════════════════════════════════════════

★시나리오 (각각 «새 브라우저 컨텍스트» = 새 기기)
  S1  총자산 «새로 달성»      새 기기 부팅 → 총자산 ≥ 1 ⇒ 지급 1회
  S1b 총자산 기준선 «안 박는다» TESTONLY 는 base 레코드를 남기지 않는다
  S2  총자산 «중복 방지»      같은 저장으로 재부팅 → 0회 (already) ★우회해도 중복은 막힌다
  S3  총자산 «이미 달성한 기기» 지급기록만 지우고 재부팅 → ★1회 (기준선 우회)
  S3c ★★총자산 «had=true 레코드가 이미 있는 기기» = President 실기기 → ★1회
      (스위치만 켜고 이 레코드를 그대로 읽으면 여전히 안 나간다 — 1순위 항목)
  S4  총자산 «옛 코드 기록»    다른 코드의 지급기록을 심은 새 기기 → 새 코드로 ★1회
  S5  플레이 «새로 달성»       새 기기 포그라운드 방치 → 60초 넘기면 지급 1회
  S6  플레이 «백그라운드 제외» visible/hidden 을 번갈아 → hidden 구간은 누적이 «안 는다»
  S7  플레이 «이미 논 기기»    지급기록만 지우고 재부팅 → 기준선 from = 이미 논 시간 ⇒ ★0회
      (★play1h 는 «손대지 않았다». 여기가 0회여야 회귀가 없는 것이다)

⛔양성/음성을 «둘 다» 본다. 한쪽만 보면 「아무에게도 안 나감」·「전원에게 나감」을 둘 다 놓친다.
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time
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
OUT = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_20260901_promo2')
OUT.mkdir(parents=True, exist_ok=True)

EQ_CODE = 'TEST___PROMOTION_CODE__'
PL_CODE = 'TEST___PROMOTION_CODE__'
EQ_KEY = 'ml.promo.equity1m'
PL_KEY = 'ml.promo.play1h'
PT_KEY = 'ml.promo.playtime'

# ── 가짜 네이티브 브릿지 + 가시성 제어 ────────────────────────────────────
INIT = r"""
(() => {
  /* ★visibilityState 를 우리가 제어한다 — 「백그라운드는 안 센다」를 실제로 태우기 위해 */
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVis = (v) => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };

  /* ★가짜 네이티브 브릿지: isInToss() 를 true 로 만든다.
     ⛔이미터를 «우리 것으로 심으면 안 된다» — 앱 번들이 부팅 때
       `window.__GRANITE_NATIVE_EMITTER = Ee()` 로 덮어쓴다(실측: 우리 on() 이 한 번도 안 불렸다).
     ⇒ 응답은 «앱의 이미터 레지스트리»(em.events['<method>/resolve/<eventId>'])를 직접 부른다. */
  window.__CONSTANT_HANDLER_MAP = window.__CONSTANT_HANDLER_MAP || {};
  window.__PROMO_CALLS = [];
  window.__BRIDGE_LOG = [];
  let seq = 0;
  const reply = (eventId, kind, data) => {
    const em = window.__GRANITE_NATIVE_EMITTER;
    if (!em || !em.events) return false;
    const ev = Object.keys(em.events).find(
      (k) => k.indexOf(eventId) >= 0 && k.indexOf('/' + kind + '/') >= 0
    );
    if (!ev) return false;
    (em.events[ev] || []).slice().forEach((f) => f(data));
    return true;
  };
  window.ReactNativeWebView = {
    postMessage(raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== 'method') return;
      const fn = m.functionName;
      window.__BRIDGE_LOG.push(fn);
      const isPromo = fn === 'grantPromotionReward' || fn === 'grantPromotionRewardForGame';
      if (isPromo) {
        const p = ((m.args || [])[0] || {}).params || {};
        window.__PROMO_CALLS.push({ fn: fn, code: p.promotionCode, amount: p.amount, at: Date.now() });
      }
      setTimeout(() => {
        const ok = isPromo
          ? reply(m.eventId, 'resolve', { key: 'TESTKEY-' + (++seq) })
          /* ⛔나머지 브릿지는 «즉시 거절» — safeBridge 가 localStorage 폴백을 «바로» 쓰게 한다.
             무응답으로 두면 호출마다 3초 타임아웃이 붙어 부팅이 늘어지고 판정 시점이 어긋난다. */
          : reply(m.eventId, 'reject', { __isError: true, message: fn + ' not stubbed (harness)' });
        if (isPromo) window.__BRIDGE_LOG.push('RESOLVED=' + ok);
      }, 0);
    },
  };
  localStorage.setItem('ml.onboarded', '1');
  localStorage.setItem('ml.settings', JSON.stringify({ lang: 'ko', theme: 'light', updown: 'kr' }));
  sessionStorage.setItem('ads.preview', '1');
})()
"""

SNAP = """() => {
  const g = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  return {
    calls: window.__PROMO_CALLS || [],
    equityRec: g('ml.promo.equity1m'),
    playRec: g('ml.promo.play1h'),
    playtime: g('ml.promo.playtime'),
    cashRec: g('ml.promo.cash100k'),
    streakRec: g('ml.promo.streak3'),
    holdRec: g('ml.promo.hold10'),
  };
}"""

EQUITY = """() => {
  const el = document.querySelector('.eqnum') || document.querySelector('[class*=eqnum]');
  return el ? el.textContent : null;
}"""


def serve(root: Path):
    free = socket.socket()
    free.bind(('127.0.0.1', 0))
    port = free.getsockname()[1]
    free.close()

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        def log_message(self, *a):
            pass

    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, 'http://127.0.0.1:%d/' % port


def boot(page, base):
    page.goto(base, wait_until='domcontentloaded')
    page.wait_for_selector('.screen', timeout=120000)
    page.wait_for_selector('.boot', state='detached', timeout=180000)
    page.wait_for_timeout(1500)  # 부팅 직후 비동기(기준선·출석·afterOrder) 정착


def calls_for(snap, code):
    return [c for c in snap['calls'] if c['code'] == code]


def main():
    httpd, base = serve(DIST)
    results = []
    fails = []

    def rec(name, ok, detail):
        results.append({'case': name, 'ok': bool(ok), 'detail': detail})
        print(('  PASS  ' if ok else '  ★FAIL ') + name + ' — ' + detail)
        if not ok:
            fails.append(name)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ★headless 고정. 창 금지
        try:
            # ═══ S1~S3 : 총자산 ═════════════════════════════════════════
            ctx = browser.new_context()
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            boot(pg, base)
            s1 = pg.evaluate(SNAP)
            eq_calls = calls_for(s1, EQ_CODE)
            rec('S1 총자산 «새로 달성» → 지급 1회',
                len(eq_calls) == 1 and eq_calls[0]['amount'] == 200,
                'calls=%d amount=%s base=%s grantedAt=%s'
                % (len(eq_calls), eq_calls[0]['amount'] if eq_calls else None,
                   (s1['equityRec'] or {}).get('base'), bool((s1['equityRec'] or {}).get('grantedAt'))))
            rec('S1-b ★TESTONLY 는 기준선을 «안 박는다»(base 없음)',
                (s1['equityRec'] or {}).get('base') is None,
                'base=%s' % json.dumps((s1['equityRec'] or {}).get('base'), ensure_ascii=False))
            state = ctx.storage_state()
            ctx.close()

            # S2 — 같은 저장으로 재부팅 (중복 지급 방지)
            ctx = browser.new_context(storage_state=state)
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            boot(pg, base)
            s2 = pg.evaluate(SNAP)
            rec('S2 총자산 «중복 방지»(같은 코드 재부팅) → 0회',
                len(calls_for(s2, EQ_CODE)) == 0,
                'calls=%d (기록 grantedAt=%s)' % (len(calls_for(s2, EQ_CODE)),
                                                  bool((s2['equityRec'] or {}).get('grantedAt'))))
            ctx.close()

            # S3 — 지급기록만 삭제 = 「이 프로모션을 처음 보는데 이미 달성한 기기」
            ctx = browser.new_context(storage_state=state)
            ctx.add_init_script(INIT)
            ctx.add_init_script("(() => { localStorage.removeItem('%s'); })()" % EQ_KEY)
            pg = ctx.new_page()
            boot(pg, base)
            pg.wait_for_timeout(4000)  # 매 틱 판정이 여러 번 돌 시간을 준다
            s3 = pg.evaluate(SNAP)
            eqtxt = pg.evaluate(EQUITY)
            rec('S3 ★총자산 «이미 달성한 기기» → 1회(TESTONLY 기준선 우회)',
                len(calls_for(s3, EQ_CODE)) == 1
                and (s3['equityRec'] or {}).get('base') is None
                and bool((s3['equityRec'] or {}).get('grantedAt')),
                'calls=%d base=%s grantedAt=%s 화면총자산=%s'
                % (len(calls_for(s3, EQ_CODE)),
                   json.dumps((s3['equityRec'] or {}).get('base'), ensure_ascii=False),
                   bool((s3['equityRec'] or {}).get('grantedAt')), eqtxt))
            ctx.close()

            # ═══ S3c ★★1순위 — 「had=true 레코드가 이미 박힌 기기」= President 실기기 ═══
            #   옛 TESTONLY 빌드가 그 기기에 남긴 «바로 그 레코드»를 그대로 심고 부팅한다.
            #   ⛔이걸 놓치면 스위치를 켜도 President 기기에서는 또 안 나간다.
            ctx = browser.new_context(storage_state=state)
            ctx.add_init_script(INIT)
            ctx.add_init_script(
                "(() => { localStorage.setItem('%s', JSON.stringify("
                "{code: '%s', base: {at: 1756000000000, had: true}})); })()" % (EQ_KEY, EQ_CODE))
            pg = ctx.new_page()
            boot(pg, base)
            pg.wait_for_timeout(4000)
            s3c = pg.evaluate(SNAP)
            eqtxt3c = pg.evaluate(EQUITY)
            rec('S3c ★★«had=true 레코드가 이미 있는 기기»(President 실기기) → 1회',
                len(calls_for(s3c, EQ_CODE)) == 1
                and calls_for(s3c, EQ_CODE)[0]['amount'] == 200
                and bool((s3c['equityRec'] or {}).get('grantedAt')),
                'calls=%d amount=%s 남은base=%s grantedAt=%s 화면총자산=%s'
                % (len(calls_for(s3c, EQ_CODE)),
                   calls_for(s3c, EQ_CODE)[0]['amount'] if calls_for(s3c, EQ_CODE) else None,
                   json.dumps((s3c['equityRec'] or {}).get('base'), ensure_ascii=False),
                   bool((s3c['equityRec'] or {}).get('grantedAt')), eqtxt3c))
            state3c = ctx.storage_state()
            ctx.close()

            # S3d — 그 기기를 «재부팅» — 우회해도 중복 지급은 없어야 한다
            ctx = browser.new_context(storage_state=state3c)
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            boot(pg, base)
            pg.wait_for_timeout(3000)
            s3d = pg.evaluate(SNAP)
            rec('S3d ★우회해도 «중복 지급»은 없다(재부팅 → 0회)',
                len(calls_for(s3d, EQ_CODE)) == 0,
                'calls=%d (기록 grantedAt=%s)'
                % (len(calls_for(s3d, EQ_CODE)), bool((s3d['equityRec'] or {}).get('grantedAt'))))
            ctx.close()

            # S4 — 옛 «다른 코드» 지급기록이 새 프로모션을 막지 않는다
            ctx = browser.new_context()
            ctx.add_init_script(INIT)
            ctx.add_init_script(
                "(() => { localStorage.setItem('%s', JSON.stringify("
                "{grantedAt: 1756000000000, key:'OLDKEY', code:'01M0OLDPROMOCODE0000000000'})); })()" % EQ_KEY)
            pg = ctx.new_page()
            boot(pg, base)
            s4 = pg.evaluate(SNAP)
            rec('S4 총자산 «옛 코드 기록»은 새 프로모션을 안 막는다 → 1회',
                len(calls_for(s4, EQ_CODE)) == 1
                and (s4['equityRec'] or {}).get('code') == EQ_CODE,
                'calls=%d 기록코드=%s' % (len(calls_for(s4, EQ_CODE)), (s4['equityRec'] or {}).get('code')))
            ctx.close()

            # ═══ S5~S6 : 플레이 시간 ════════════════════════════════════
            ctx = browser.new_context()
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            boot(pg, base)
            t0 = time.time()
            # S6 — 포그라운드 35초 → hidden 25초 → 다시 visible 35초
            pg.wait_for_timeout(35000)
            pg.evaluate("() => window.__setVis('hidden')")
            pg.wait_for_timeout(600)
            a = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('%s')); } catch(e){ return null; } }" % PT_KEY)
            pg.wait_for_timeout(25000)          # ★백그라운드 구간 — 누적이 늘면 안 된다
            b = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('%s')); } catch(e){ return null; } }" % PT_KEY)
            pg.evaluate("() => window.__setVis('visible')")
            pg.wait_for_timeout(35000)
            pg.evaluate("() => window.__setVis('hidden')")
            pg.wait_for_timeout(800)
            c = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('%s')); } catch(e){ return null; } }" % PT_KEY)
            am = (a or {}).get('totalMs', -1)
            bm = (b or {}).get('totalMs', -1)
            cm = (c or {}).get('totalMs', -1)
            rec('S6 ★백그라운드 25초는 «안 센다»', bm == am,
                '포그35초후=%sms · 백그25초후=%sms(같아야) · 다시포그35초후=%sms' % (am, bm, cm))
            rec('S6-b 포그라운드는 «실시간»으로 는다', 30000 <= am <= 40000 and (cm - bm) >= 30000,
                'A=%sms(30k~40k) · C-B=%sms(>=30k)' % (am, cm - bm))
            pg.evaluate("() => window.__setVis('visible')")
            # 문턱(60초)까지 마저 채운다
            deadline = time.time() + 90
            while time.time() < deadline:
                pg.wait_for_timeout(5000)
                if calls_for(pg.evaluate(SNAP), PL_CODE):
                    break
            s5 = pg.evaluate(SNAP)
            pl_calls = calls_for(s5, PL_CODE)
            rec('S5 플레이 «새로 달성» → 지급 1회',
                len(pl_calls) == 1 and pl_calls[0]['amount'] == 200,
                'calls=%d amount=%s 누적=%sms 경과=%.0fs base=%s'
                % (len(pl_calls), pl_calls[0]['amount'] if pl_calls else None,
                   (s5['playtime'] or {}).get('totalMs'), time.time() - t0,
                   json.dumps((s5['playRec'] or {}).get('base'), ensure_ascii=False)))
            pg.evaluate("() => window.__setVis('hidden')")
            pg.wait_for_timeout(800)
            state2 = ctx.storage_state()
            ctx.close()

            # S7 — 지급기록만 삭제 = 「이미 1시간 넘게 논 기기」
            ctx = browser.new_context(storage_state=state2)
            ctx.add_init_script(INIT)
            ctx.add_init_script("(() => { localStorage.removeItem('%s'); })()" % PL_KEY)
            pg = ctx.new_page()
            boot(pg, base)
            pg.wait_for_timeout(45000)  # 문턱(60초) 미만으로만 더 논다
            s7 = pg.evaluate(SNAP)
            rec('S7 ★플레이 «이미 논 기기» → 0회(기준선 이후분만 센다)',
                len(calls_for(s7, PL_CODE)) == 0
                and (s7['playRec'] or {}).get('base', {}).get('from', -1) > 60000,
                'calls=%d base=%s 현재누적=%sms'
                % (len(calls_for(s7, PL_CODE)),
                   json.dumps((s7['playRec'] or {}).get('base'), ensure_ascii=False),
                   (s7['playtime'] or {}).get('totalMs')))
            pg.screenshot(path=str(OUT / 'promo2_S7.png'), full_page=False)
            ctx.close()
        finally:
            browser.close()
            httpd.shutdown()

    (OUT / 'promo2_results.json').write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\n판정: %s  (%d/%d)' % ('PASS' if not fails else '★FAIL',
                                   sum(1 for r in results if r['ok']), len(results)))
    if fails:
        for f in fails:
            print('  - ' + f)
    sys.exit(0 if not fails else 1)


if __name__ == '__main__':
    main()
