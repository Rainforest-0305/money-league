# -*- coding: utf-8 -*-
"""
출석 이벤트 실동작 검증 — ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_attendance.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_attendance.py <출력폴더>

═══════════════════════════════════════════════════════════════════════
★★대상이 «아직 없을 때» (2026-08-22 현재)
═══════════════════════════════════════════════════════════════════════
  출석 기능은 아직 구현 전이다(무접촉 해제 대기).
  ⇒ 본검사는 ⛔조용한 0건을 내지 «않는다». `NOTE: 대상 부재` 를 소리내어 찍고 exit 0.
    ★「0건」과 「볼 게 없었다」는 다른 사실이다 — 이 프로젝트가 반복해서 데인 형태다.
  ⇒ ★그래도 `--selftest` 는 «지금» 돈다. 대조 6종이 ★현재 빌드에서 전부 증명 가능하다.
    구현이 들어오면 본검사가 «자동으로» 돌기 시작한다.

★★대상 판정은 «저장소 키»로 한다 — `ml.attendance`
  CTO 확정: 출석은 세이브 블롭 «밖» 별도 키다(손상돼도 게임이 죽지 않게).
  ⇒ 그래서 이 하네스는 store 내부를 훔쳐보지 않고 ★저장본만 읽는다.
    화면 구현이 어떻게 바뀌어도 «원장»은 그 키 하나다.

─────────────────────────────────────────────────────────────────────────
⚠️★이 하네스가 «못 보는» 것 — 「게이트 통과 ≠ 그 경로가 검증됐다」
  1. ⛔**실기기 시각을 못 본다.** 가짜 시계는 `Date.now` 를 덮어쓴 것이다.
     토스 `getServerTime` 보정이 실제로 먹는지는 ★실기기에서만 확인된다.
  2. ⛔**「하루가 실제로 지나는 것」을 못 본다.** 시계를 «점프»시킨다.
     백그라운드에서 자정을 넘기는 경로(앱이 떠 있는 채로 날짜가 바뀜)는 별도 확인이 필요하다.
  3. ⛔**광고 «실제 노출»을 못 본다.** 운영 ID 로컬 실렌더는 계정 중단 사유다.
     2배 버튼은 «지면 ID 유무»에 따른 렌더/미렌더만 본다.
  4. ⛔**streak 규칙의 «의도»는 안 본다.** 숫자가 규칙대로 움직이는지만 본다.
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

# ★★조직 표준 headless 런처를 «경유»한다.
sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}
SEED = 20260822

ATTEND_KEY = 'ml.attendance'


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


# ★★가짜 시계 — 앱이 로드되기 «전»에 Date.now 를 덮어쓴다.
#   ⛔`page.clock` 대신 이걸 쓰는 이유: 이 앱은 게임 루프를 setTimeout 으로 돌린다.
#     시계 API 로 시간을 얼리면 루프가 멈춰 워밍업이 끝나지 않는다.
#     여기서는 «값만» 옮긴다 — 타이머는 정상 속도로 계속 돈다.
FAKE_CLOCK_JS = r"""(() => {
  const real = Date.now.bind(Date);
  window.__ML_SKEW = 0;
  Date.now = () => real() + window.__ML_SKEW;
  /* new Date() 도 같은 기준을 쓰게 한다 — 날짜키가 Date 객체로 계산된다 */
  const RealDate = Date;
  const P = new Proxy(RealDate, {
    construct(t, args) {
      return args.length === 0 ? new t(real() + window.__ML_SKEW) : new t(...args);
    },
  });
  P.now = Date.now;
  P.parse = RealDate.parse;
  P.UTC = RealDate.UTC;
  window.Date = P;
  /** 하루(ms) 단위로 시계를 «민다» */
  window.__ML_ADVANCE_DAYS = (n) => { window.__ML_SKEW += n * 86400000; return window.__ML_SKEW; };
})()"""


def init_js(save_js='null', attendance_js='null'):
    """
    ★★[실측으로 잡은 하네스 결함] `add_init_script` 는 ★«매 내비게이션»마다 돈다.
      처음엔 여기서 `ml.game` 을 덮어쓰고 `ml.attendance` 를 «지웠다».
      ⇒ 화면을 옮길 때마다 상태가 초기화돼서
        ① 「어제로 바꿔 둔 날짜키」가 다시 «오늘»로 덮여 리셋 대조가 MISSED 였고
        ② 출석 원장이 매번 지워져 ★A~I 본검사가 «아무것도 측정하지 못할» 뻔했다.
      ★대조 ⑥ 이 MISSED 로 «먼저» 걸려서 ②를 찾았다 — 대조를 앞에 두는 이유가 이것이다.
    ⇒ 그래서 «씨 뿌리기»는 첫 로드에서 «한 번만» 한다(`ml.__seeded` 파수꾼).
      ⛔이 파수꾼은 하네스 전용 키다. 앱 소스에는 없다.
    """
    return (
        "(() => {"
        "localStorage.setItem('ml.seed','%d');"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "if (localStorage.getItem('ml.__seeded') === '1') return;"
        "localStorage.setItem('ml.__seeded','1');"
        "localStorage.removeItem('ml.journal');"
        "const kd = (() => { const k = new Date(Date.now() + 9*3600*1000);"
        " return k.getUTCFullYear() + '-' + String(k.getUTCMonth()+1).padStart(2,'0')"
        " + '-' + String(k.getUTCDate()).padStart(2,'0'); })();"
        "const sv = %s;"
        "if (sv) { sv.topup.dateKey = kd; if (sv.daily) sv.daily.dateKey = kd;"
        " localStorage.setItem('ml.game', JSON.stringify(sv)); }"
        "else { localStorage.removeItem('ml.game'); }"
        "const at = %s;"
        "if (at) localStorage.setItem('%s', JSON.stringify(at));"
        "else localStorage.removeItem('%s');"
        "})()" % (SEED, save_js, attendance_js, ATTEND_KEY, ATTEND_KEY)
    )


def exhausted_save():
    """무료 충전을 다 쓴 상태 — 충전 화면이 「소진」 단계가 되어 리셋 카운트다운이 보인다"""
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {
            'cash': 10000, 'holdings': [], 'levPositions': [], 'optPositions': [],
            'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 4, 'liquidationCount': 0, 'topupCount': 0,
        },
        'topup': {'dateKey': '', 'usedToday': 3, 'lastTopupAt': 0},
        'prices': {},
    })


LEDGER_JS = r"""(key) => {
  const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const g = j('ml.game');
  const a = j(key);
  const jr = j('ml.journal') || [];
  return {
    cash: g && g.account ? g.account.cash : null,
    bonusSeed: g && g.account ? (g.account.bonusSeed ?? null) : null,
    attendance: a,
    streak: a ? (a.streak ?? null) : null,
    lastClaimed: a ? (a.lastClaimedDate ?? null) : null,
    journalAttend: jr.filter((e) => e.product === 'reward' && e.side === 'attendance').length,
    journalShare: jr.filter((e) => e.product === 'reward' && e.side === 'share').length,
    alive: !!document.querySelector('.screen'),
  };
}"""

GHOST_JS = r"""() => {
  const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
  const out = [];
  const seen = new Set();
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const c of el.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      const r = c.getBoundingClientRect();
      const pad = px(c, 'paddingTop') + px(c, 'paddingBottom');
      const mar = px(c, 'marginTop') + px(c, 'marginBottom');
      if (Math.round(r.height) === 0 && (pad + mar) > 0) out.push({ cls: c.className || c.tagName, pad, mar });
      else if (Math.round(r.height) <= pad && pad > 0 && c.children.length === 0) out.push({ cls: c.className || c.tagName, pad, empty: true });
      walk(c, depth + 1);
    }
  };
  for (const r of document.querySelectorAll('.scroll, .vlist, .screen, .cta')) walk(r, 0);
  return out;
}"""

TOAST_JS = r"""() => [...document.querySelectorAll('.toast, [class*="toast"]')]
  .map((e) => (e.textContent || '').trim()).filter(Boolean)"""

RESET_TEXT_JS = r"""() => {
  const t = [...document.querySelectorAll('.screen *')].filter((e) => e.children.length === 0)
    .map((e) => (e.textContent || '').trim()).filter(Boolean);
  return t.filter((x) => /시간|분/.test(x)).slice(0, 6);
}"""


def target_present():
    """출석이 «구현됐는가» — 소스에서 판정한다. ⛔조용히 건너뛰지 않기 위한 근거다"""
    want = [
        (ROOT / 'src' / 'lib' / 'attendance.ts', 'decideAttendance'),
        (ROOT / 'src' / 'store' / 'attendance.ts', ATTEND_KEY),
        (ROOT / 'src' / 'store' / 'store.ts', 'claimAttendance'),
        (ROOT / 'src' / 'lib' / 'engine' / 'gameWorld.ts', 'grantBonusCash'),
    ]
    hits = []
    for path, needle in want:
        if path.exists() and needle in path.read_text(encoding='utf-8'):
            hits.append(path.name + ':' + needle)
    #  ★넷이 «전부» 있어야 본검사가 뜻이 있다. 하나라도 없으면 대상 부재다.
    return hits if len(hits) == len(want) else []


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_attendance')
    out.mkdir(parents=True, exist_ok=True)
    selftest = '--selftest' in sys.argv[1:]
    rep = {'dist': str(DIST), 'controls': [], 'checks': [], 'shots': [], 'fail': []}

    def control(name, caught):
        rep['controls'].append([name, bool(caught)])
        print('  ' + ('CAUGHT' if caught else 'MISSED') + '  ' + name)
        return bool(caught)

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print('  ' + ('PASS' if ok else '★FAIL') + '  ' + name + '  ' + str(detail))

    if not (DIST / 'index.html').exists():
        print('FAILED: 빌드가 없다 —', DIST)
        return 1

    present = target_present()
    if not selftest and not present:
        print('출석 이벤트 실동작 검증')
        print('  NOTE: ★대상 부재 — 출석 구현이 아직 없다(grantAttendance · %s 미검출).' % ATTEND_KEY)
        print('        ⛔이건 「0건」이 아니라 「검사할 것이 없었다」다.')
        print('        ★--selftest 는 «지금» 통과한다 — 대조 6종이 현재 빌드에서 증명된다.')
        return 0

    httpd, port = serve(DIST)
    base = 'http://127.0.0.1:%d/' % port
    try:
        with open_browser() as (_pw, browser):
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(FAKE_CLOCK_JS)
            ctx.add_init_script(init_js(exhausted_save()))
            page = ctx.new_page()
            perr = []
            page.on('pageerror', lambda e: perr.append(str(e)))
            page.goto(base + '#/recharge', wait_until='domcontentloaded')
            page.wait_for_selector('.screen', timeout=40000)
            page.wait_for_timeout(3200)

            print('\n대조 (측정기 생존 증명) — ★출석이 없어도 «지금» 증명된다')
            ok = True
            # ① 저장본 판독기
            page.evaluate("(k) => localStorage.setItem(k, JSON.stringify({ streak: 7, lastClaimedDate: '2026-01-01' }))", ATTEND_KEY)
            r = page.evaluate(LEDGER_JS, ATTEND_KEY)
            ok &= control('①저장본 판독기 — %s 를 읽는다' % ATTEND_KEY, r['streak'] == 7)
            page.evaluate("(k) => localStorage.removeItem(k)", ATTEND_KEY)
            ok &= control('①-b 음성대조 — 키를 지우면 null 이다',
                          page.evaluate(LEDGER_JS, ATTEND_KEY)['streak'] is None)

            # ② 토스트 계수기
            before_t = len(page.evaluate(TOAST_JS))
            page.evaluate("() => { const d=document.createElement('div'); d.id='nt'; d.className='toast'; d.textContent='NEEDLE 출석'; document.body.appendChild(d); }")
            ok &= control('②토스트 계수기', len(page.evaluate(TOAST_JS)) > before_t)
            page.evaluate("() => document.getElementById('nt')?.remove()")

            # ③ 유령 여백 탐지기
            g0 = len(page.evaluate(GHOST_JS))
            page.evaluate("() => { const s=document.querySelector('.scroll')||document.querySelector('.screen');"
                          " const d=document.createElement('div'); d.id='ng'; d.style.padding='22px 0'; s.appendChild(d); }")
            ok &= control('③유령 여백/빈 상자 탐지기', len(page.evaluate(GHOST_JS)) > g0)
            page.evaluate("() => document.getElementById('ng')?.remove()")

            # ④ 일지 계수기 (출석/공유를 «side» 로 가른다)
            page.evaluate("""() => localStorage.setItem('ml.journal', JSON.stringify([
                { id:'j1', product:'reward', side:'attendance', ticker:'', fee:0, notional:5000, at:0, tick:0, gameDay:0, action:'grant' },
                { id:'j2', product:'reward', side:'share',      ticker:'', fee:0, notional:100000, at:0, tick:0, gameDay:0, action:'grant' }
            ]))""")
            r = page.evaluate(LEDGER_JS, ATTEND_KEY)
            ok &= control('④일지 계수기 — 출석/공유를 side 로 «가른다»',
                          r['journalAttend'] == 1 and r['journalShare'] == 1)
            page.evaluate("() => localStorage.removeItem('ml.journal')")

            # ⑤ ★★가짜 시계 주입기 — «앱의 날짜 로직이 실제로 움직이는지»
            #    ⛔이게 MISSED 면 아래 streak 검사(C·D·E)가 «전부 공허하게 통과»한다.
            t0 = page.evaluate(RESET_TEXT_JS)
            page.evaluate("() => window.__ML_ADVANCE_DAYS(0.5)")   # 12시간 민다
            page.wait_for_timeout(1400)                             # 화면의 1초 타이머가 한 번 돌게
            t1 = page.evaluate(RESET_TEXT_JS)
            ok &= control('⑤★가짜 시계가 «앱의 날짜 로직»을 실제로 움직인다(리셋 카운트다운 변화)',
                          t0 != t1)
            print('       전: %s\n       후: %s' % (t0[:3], t1[:3]))
            page.evaluate("() => window.__ML_ADVANCE_DAYS(-0.5)")

            # ⑥ ★하루 카운터가 «날짜키»로 리셋된다 (출석이 탈 바로 그 경로)
            #  ⛔★`page.evaluate` 로 `ml.game` 을 고쳐도 «리로드 때 덮인다».
            #    리로드는 `pagehide` 를 쏘고, store 가 거기서 `world.save()` 를 한다
            #    [실측: store.ts onPageHide]. 즉 «메모리의 옛 상태»가 내 편집을 지운다.
            #    ⇒ 그래서 두 번이나 「기능이 안 된다」로 보였다. 원인은 «저장 순서»였다.
            #  ⇒ 편집을 ★«다음 로드의 init 스크립트»로 옮긴다 — pagehide 저장 «뒤»에 돈다.
            ctx.add_init_script("""(() => {
                if (localStorage.getItem('ml.__yesterday') === '1') return;
                localStorage.setItem('ml.__yesterday', '1');
                const raw = localStorage.getItem('ml.game');
                if (!raw) return;
                const g = JSON.parse(raw);
                const k = new Date(Date.now() + 9*3600*1000 - 86400000);
                g.topup.dateKey = k.getUTCFullYear()+'-'+String(k.getUTCMonth()+1).padStart(2,'0')
                                + '-' + String(k.getUTCDate()).padStart(2,'0');
                g.topup.usedToday = 3;
                localStorage.setItem('ml.game', JSON.stringify(g));
            })()""")
            #  ⛔저장본(`ml.game`)을 읽어 판정하지 «마라»: 리셋은 «메모리»에서 즉시 일어나지만
            #    디스크에는 `save()` 가 도는 시점(워밍업 완료 + 스냅샷 주기)에야 반영된다.
            #    ⇒ 처음에 저장본으로 봤다가 ★MISSED 가 났다 — 「리셋이 안 됐다」가 아니라
            #      「아직 안 쓰였다」였다. ★타이밍을 «기능 실패»로 오독하는 전형이다.
            #  ⇒ ★화면이 «말하는 값»으로 판정한다. 그게 유저가 실제로 보는 것이기도 하다.
            #  ⛔★해시 이동만으로는 «스토어가 다시 안 뜬다» — GameWorld 는 모듈 싱글턴이라
            #    localStorage 를 고쳐도 «진짜 리로드» 전에는 반영되지 않는다.
            #    실제로 그렇게 짜서 이 대조가 두 번 MISSED 였다(원인은 «기능»이 아니라 하네스였다).
            page.goto(base + '#/settings', wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.li', timeout=40000)
            page.wait_for_timeout(3200)
            rows = page.eval_on_selector_all('.li', 'els => els.map(e => (e.textContent||"").trim())')
            topup_row = next((t for t in rows if '충전' in t), '')
            ok &= control('⑥★날짜키가 어제면 하루 카운터가 «리셋»된다(출석이 탈 경로)',
                          '3회' in topup_row)
            print('       충전 행: %s' % topup_row)

            rep['controlsOk'] = ok
            if not ok:
                print('\nFAILED: 대조 실패 — 이 실행의 결과는 무효다.')
                json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                return 1
            print('\n대조 %d종 전부 통과 — 하네스가 살아 있다.' % len(rep['controls']))
            page.screenshot(path=str(out / 'control_recharge.png'), full_page=True)
            rep['shots'].append('control_recharge')

            if selftest:
                json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                print('\nOK: --selftest 는 여기까지다. 본검사는 출석 구현이 들어오면 돈다.')
                return 0

            # ═══════════════════════════════════════════════════════════
            # 본검사 — ★출석 구현이 들어온 «뒤»에만 도달한다
            # ═══════════════════════════════════════════════════════════
            print('\n본검사 (대상 검출: %s)' % ', '.join(present))

            #  ★곡선을 «소스에서» 읽는다. ⛔하네스에 금액을 다시 적지 마라 —
            #    그러면 상수를 바꿔도 검사기가 옛 값을 계속 맞다고 말한다.
            att_src = (ROOT / 'src' / 'lib' / 'attendance.ts').read_text(encoding='utf-8')
            m = re.search(r'ATTENDANCE_REWARDS = \[([^\]]*)\]', att_src)
            CURVE = [int(x.replace('_', '').strip()) for x in m.group(1).split(',') if x.strip()]
            CYCLE_TOTAL = sum(CURVE)
            print('  곡선(소스에서 읽음): %s · 누적 %d' % (CURVE, CYCLE_TOTAL))

            def goto_home(reload=True):
                """홈에 «새로 들어간다».
                ⛔`reload=True` 가 기본인 이유: 이 하네스는 `ml.attendance` 를 밖에서 고쳐 놓고
                  들어간다. 해시 이동만 하면 ★스토어(모듈 싱글턴)가 옛 값을 그대로 들고 있어
                  «고쳐 놓은 것이 반영되지 않는다». 실제로 그 때문에 대조가 두 번 죽었다."""
                page.goto(base + '#/home', wait_until='domcontentloaded')
                if reload:
                    page.reload(wait_until='domcontentloaded')
                page.wait_for_selector('.tabbar', timeout=40000)
                page.wait_for_timeout(2800)

            def set_last(days_ago, streak):
                """마지막 지급일을 «며칠 전»으로 놓는다 — 시계를 안 건드리고 규칙만 태운다"""
                page.evaluate(
                    """([k, d, st]) => {
                        const kst = new Date(Date.now() + 9*3600*1000 - d*86400000);
                        const key = kst.getUTCFullYear()+'-'+String(kst.getUTCMonth()+1).padStart(2,'0')
                                  +'-'+String(kst.getUTCDate()).padStart(2,'0');
                        localStorage.setItem(k, JSON.stringify(
                            { streak: st, lastClaimedDate: key, lastDoubledDate: null, totalUsd: 0 }));
                    }""",
                    [ATTEND_KEY, days_ago, streak],
                )

            #  ── A 자동 지급 ───────────────────────────────────────────
            page.evaluate("(k) => localStorage.removeItem(k)", ATTEND_KEY)
            page.evaluate("() => localStorage.removeItem('ml.journal')")
            before = page.evaluate(LEDGER_JS, ATTEND_KEY)
            goto_home()
            #  ★토스트는 2.6초 뒤 사라진다 [실측: store.showToast]. «먼저» 잡는다.
            #    ⛔늦게 보고 「안 떴다」로 읽으면 그건 결함이 아니라 «측정 시점»이 틀린 것이다.
            toast_seen = page.evaluate(TOAST_JS)
            a1 = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('A 자동 지급 — 진입만으로 «이미 받은 상태»다', a1['streak'] == 1, a1['streak'])
            check('A 현금 +%d' % CURVE[0], a1['cash'] - before['cash'] == CURVE[0],
                  '%s -> %s' % (before['cash'], a1['cash']))
            check('A ★bonusSeed 도 «같은 금액» 올랐다(수익률 분모)',
                  (a1['bonusSeed'] or 0) - (before['bonusSeed'] or 0) == CURVE[0], a1['bonusSeed'])
            check('A 일지 1건(side=attendance)', a1['journalAttend'] == 1, a1['journalAttend'])
            check('A 토스트가 떴다', any('출석' in t for t in toast_seen), toast_seen[:2])
            page.screenshot(path=str(out / 'A_home_claimed.png'))
            rep['shots'].append('A_home_claimed')

            #  ── B ★멱등 — 재진입해도 한 번만 ───────────────────────────
            for i in range(5):
                #  ★두 경로를 «둘 다» 본다: 탭 왕복(리로드 없음) · 앱 재시작(리로드)
                #    멱등이 한쪽에서만 성립하면 그건 멱등이 아니다.
                if i % 2 == 0:
                    page.goto(base + '#/stocks', wait_until='domcontentloaded')
                    page.wait_for_timeout(600)
                    goto_home(reload=False)
                else:
                    goto_home(reload=True)
            b = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('B ★재진입 5회 — 현금 불변', b['cash'] == a1['cash'], '%s -> %s' % (a1['cash'], b['cash']))
            check('B ★재진입 5회 — 일지 1건 그대로', b['journalAttend'] == 1, b['journalAttend'])
            check('B ★재진입 5회 — streak 1 고정', b['streak'] == 1, b['streak'])

            #  ── C ★7일 연속 — 곡선과 누적이 설계와 같은가 ────────────────
            page.evaluate("(k) => localStorage.removeItem(k)", ATTEND_KEY)
            page.evaluate("() => localStorage.removeItem('ml.journal')")
            c0 = page.evaluate(LEDGER_JS, ATTEND_KEY)
            goto_home()          # 1일차
            steps = [page.evaluate(LEDGER_JS, ATTEND_KEY)['cash'] - c0['cash']]
            for day in range(2, len(CURVE) + 1):
                set_last(1, day - 1)          # 「어제 받았고 streak = day-1」
                goto_home()
                steps.append(page.evaluate(LEDGER_JS, ATTEND_KEY)['cash'] - c0['cash'])
            gains = [steps[0]] + [steps[i] - steps[i - 1] for i in range(1, len(steps))]
            rep['curveMeasured'] = gains
            check('C ★7일 곡선이 설계와 «완전히» 같다', gains == CURVE, '측정 %s / 설계 %s' % (gains, CURVE))
            check('C ★7일 누적 = %d' % CYCLE_TOTAL, sum(gains) == CYCLE_TOTAL, sum(gains))
            cEnd = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('C 일지 %d건' % len(CURVE), cEnd['journalAttend'] == len(CURVE), cEnd['journalAttend'])

            #  ── D ★하루 유예 — 그제 받았으면 streak «유지» ──────────────
            set_last(2, 7)
            goto_home()
            d = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('D ★하루 유예 — streak 7 «유지»(리셋 아님)', d['streak'] == 7, d['streak'])

            #  ── E ★반감 — 사흘 이상 걸렀으면 절반(0 아님) ────────────────
            set_last(4, 7)
            goto_home()
            e = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('E ★반감 — streak 3 (floor(7/2)) · ⛔1일차 리셋이 «아니다»', e['streak'] == 3, e['streak'])
            set_last(9, 1)
            goto_home()
            e1 = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('E ★반감이 1 밑으로 안 간다', e1['streak'] == 1, e1['streak'])

            #  ── F 2배 버튼 — 지면/SDK 없으면 «안 그려진다» ───────────────
            page.goto(base + '#/recharge', wait_until='domcontentloaded')
            page.wait_for_selector('.screen', timeout=40000)
            page.wait_for_timeout(2400)
            btns = page.eval_on_selector_all('.card .btn', 'els => els.map(e => (e.textContent||"").trim())')
            check('F [토스 밖] 2배 버튼이 «안» 그려진다', not any('2배' in t for t in btns), btns[:3])
            ghosts = page.evaluate(GHOST_JS)
            check('F 유령 여백/빈 상자 0건', len(ghosts) == 0, ghosts[:3])
            texts = page.evaluate(
                """() => [...document.querySelectorAll('.screen *')].filter(e=>e.children.length===0)
                    .map(e=>(e.textContent||'').trim()).filter(Boolean)"""
            )
            check('F 출석 카드가 보인다(일차·다음 보상)', any('출석' in t for t in texts),
                  [t for t in texts if '출석' in t][:2])
            check('F ★「하루 쉬어도 이어져요」가 있다', any('하루 쉬어도' in t for t in texts))
            page.screenshot(path=str(out / 'F_recharge_card.png'), full_page=True)
            rep['shots'].append('F_recharge_card')

            #  ── G ★랭킹 오염 — 분자·분모가 같이 커지면 수익률은 안 움직인다
            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.wait_for_timeout(2400)
            home_txt = page.evaluate(
                """() => [...document.querySelectorAll('.screen *')].filter(e=>e.children.length===0)
                    .map(e=>(e.textContent||'').trim()).filter(Boolean).slice(0,12)"""
            )
            pct = None
            for t in home_txt:
                mm = re.search(r'\(([+-]?[\d.]+)%\)', t)
                if mm:
                    pct = float(mm.group(1))
                    break
            rep['homePnlPct'] = pct
            check('G ★수익률이 출석으로 «오염되지 않는다»(±1%p)',
                  pct is not None and abs(pct) <= 1.0, '%s%% · %s' % (pct, home_txt[:5]))

            #  ── H ★저장본 손상 — 게임이 죽지 «않고» 출석 0일로 떨어진다 ──
            page.evaluate("(k) => localStorage.setItem(k, '{{{ 깨진 JSON')", ATTEND_KEY)
            #  ⛔★«진짜 리로드»여야 한다. 해시 이동만 하면 `AttendanceLedger` 는 페이지 로드 때
            #    읽은 «옛 상태»를 그대로 들고 있어 손상값을 아예 «보지 않는다».
            #    실제로 그렇게 짜서 이 검사가 「None」으로 죽었다 — 결함이 아니라 하네스였다.
            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            ok_alive = True
            try:
                page.wait_for_selector('.tabbar', timeout=30000)
            except Exception:
                ok_alive = False
            page.wait_for_timeout(3000)
            h = page.evaluate(LEDGER_JS, ATTEND_KEY)
            check('H ★출석 저장본이 깨져도 «게임이 산다»', ok_alive and h['alive'], ok_alive)
            check('H ★깨진 값은 «출석 1일차»로 떨어진다(전 진행이 날아가지 않는다)',
                  h['streak'] == 1, h['streak'])
            #  ⚠️★알고 넘어가는 «대가»: 원장을 일부러 손상시키면 그날 몫을 «한 번 더» 받는다.
            #    ⇒ 세이브 블롭 밖에 둔 대가다. 「게임이 죽지 않는 것」과 맞바꾼 것이고,
            #      상한은 «하루치 한 번»이라 감수한다. 조용히 넘어가지 않게 여기 적어 둔다.
            check('H ★잔고는 «그대로»다(세이브 블롭과 분리된 근거)',
                  h['cash'] is not None and h['cash'] > 0, h['cash'])

            #  ── I 일지 요약 — 출석이 «거래»로 세지지 않는다 ───────────────
            page.goto(base + '#/journal', wait_until='domcontentloaded')
            page.wait_for_timeout(1800)
            summ = page.evaluate(
                """() => ({ v: [...document.querySelectorAll('.sumrow__v')].map(e=>(e.textContent||'').trim()),
                            rows: [...document.querySelectorAll('.jrow')].map(e=>(e.textContent||'').replace(/\\s+/g,' ').trim()) })"""
            )
            rep['journalSummary'] = summ
            check('I 일지에 출석 줄이 보인다', any('출석' in t for t in summ['rows']), summ['rows'][:2])
            #  ★기대값은 0 이 아니라 «픽스처의 tradeCount(4)» 다 — 출석이 그 수를 «안 건드리는»지를 본다.
            #    ⛔0 을 기대하면 픽스처를 안 읽은 것이다(내가 실제로 그렇게 틀렸다).
            check('I ★요약 「거래 횟수」가 원장값 4회 그대로 — 출석은 «거래»가 아니다',
                  any('4' in x for x in summ['v']), summ['v'])
            page.screenshot(path=str(out / 'I_journal.png'), full_page=True)
            rep['shots'].append('I_journal')

            check('본검사 pageerror 0', len(perr) == 0, perr[:2])
            ctx.close()
    finally:
        httpd.shutdown()

    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if rep['fail']:
        print('\nFAILED: %d건' % len(rep['fail']))
        for n, d in rep['fail']:
            print('  -', n, d)
        return 1
    print('\nOK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
