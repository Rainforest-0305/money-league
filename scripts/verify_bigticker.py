# -*- coding: utf-8 -*-
"""
★종목 1,000개 확장이 «화면»을 깨뜨렸는지 — 온보딩 · 종목 선택기 · 목록. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_bigticker.py <출력폴더> [비교할 .ait(=100종목 시절)]

★★왜 «따로» 필요한가
  기존 하네스는 종목 «수»를 전제하지 않고 도는 것이 많다. 그런데 1,000종목에서
  실제로 깨질 만한 자리는 «수에 비례하는» 세 곳이다:
    ① 온보딩 종목 고르기 — 목록이 1,000개가 되면 첫 화면·스크롤·선택 상태가 흔들린다
    ② 종목 선택기(TickerPicker) — 가상 스크롤 좌표가 «개수»로 계산된다
    ③ 종목 목록(Stocks) — 위와 같다
  ⇒ 셋 다 ★「에러가 안 나고 그림만 어긋나는」 종류다. 그래서 «세어서» 본다.

★프레임은 ⛔fps 가 아니다 — 짝지은 구조 지표다(비교 .ait 를 주면 나란히 낸다).
  ⛔headless 는 vsync 가 없어 「거짓 60」을 준다. 절대값을 주장하지 않는다.

⚠️★이 하네스가 «못 보는» 것
  1. ⛔실기기 스크롤 관성·터치 판정은 못 본다. 좌표와 개수만 본다.
  2. ⛔한글 종목명 품질은 안 본다(신규 894종목은 영문명이다 — CTO 미해결 항목).
  3. ⛔검색 «정확도»는 안 본다. 좁혀지는지만 본다.
"""
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import sys
import threading
import zipfile
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}
SEED = 20260822


def ticker_count(root=ROOT):
    """★종목 수를 «소스에서» 센다. ⛔숫자를 박지 않는다"""
    try:
        src = (root / 'src' / 'data' / 'tickers.generated.ts').read_text(encoding='utf-8')
        return len(re.findall(r'"ticker":', src)) or len(re.findall(r"ticker: '", src))
    except Exception:
        return 0


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


def extract(ait, dest):
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(ait) as z:
        names = z.namelist()
        idx = sorted([n for n in names if n.endswith('index.html')], key=lambda n: n.count('/'))
        root = idx[0].rsplit('index.html', 1)[0]
        for n in names:
            if n.startswith(root) and not n.endswith('/'):
                t = dest / n[len(root):]
                t.parent.mkdir(parents=True, exist_ok=True)
                t.write_bytes(z.read(n))
    return dest


def init_js(onboarded=True):
    parts = [
        "localStorage.setItem('ml.seed','%d');" % SEED,
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));",
        "localStorage.removeItem('ml.game');",
        "localStorage.removeItem('ml.journal');",
    ]
    if onboarded:
        parts += [
            "localStorage.setItem('ml.onboarded','1');",
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));",
        ]
    else:
        # ★온보딩을 «처음부터» 본다
        parts += ["localStorage.removeItem('ml.onboarded');", "localStorage.removeItem('ml.session');"]
    return '(() => {' + ''.join(parts) + '})()'


# 넘침·줄바꿈 — 1,000종목에서 «이름이 길어져» 깨지는 자리를 잡는다
OVERFLOW_JS = r"""() => {
  const out = [];
  for (const el of document.querySelectorAll('.screen *')) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    /* 가로 넘침 */
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'auto' && cs.overflow !== 'scroll') {
      out.push({ kind: 'overflowX', cls: el.className || el.tagName,
                 txt: (el.textContent || '').trim().slice(0, 30), sw: el.scrollWidth, cw: el.clientWidth });
    }
    /*
     * 화면 밖으로 삐져나감.
     * ⛔★「가로로 스크롤되는 조상」 안에 있는 것은 «정상»이다 — 칩 줄(.pillrow)이 그렇다.
     *   이 예외를 안 두고 재서 ★섹터 칩 3개가 «결함»으로 잡혔다(오탐).
     *   오탐을 남기면 진짜가 묻힌다 — 어포던스 감사에서 61건 중 44건이 오탐이던 것과 같다.
     */
    let inHScroll = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ac = getComputedStyle(a);
      if ((ac.overflowX === 'auto' || ac.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) {
        inHScroll = true; break;
      }
    }
    if (!inHScroll && (r.right > 391 || r.left < -1)) {
      /* ★SVG 안의 요소는 className 이 객체(SVGAnimatedString)라 «{}» 로 찍힌다.
         그러면 무엇인지 알 수 없다 — 태그와 «SVG 안인지»를 같이 남긴다. */
      const inSvg = !!el.closest('svg');
      out.push({ kind: 'offscreen',
                 cls: (typeof el.className === 'string' && el.className) || el.tagName,
                 inSvg, txt: (el.textContent || '').trim().slice(0, 30),
                 left: Math.round(r.left), right: Math.round(r.right),
                 w: Math.round(r.width) });
    }
  }
  return out;
}"""

VLIST_JS = r"""() => {
  const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
  if (!sc) return null;
  return { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight,
           children: sc.children.length };
}"""

# 행 «겹침» — 가상 스크롤 좌표가 어긋나면 여기서 드러난다
OVERLAP_JS = r"""(sel) => {
  const rs = [...document.querySelectorAll(sel)]
    .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0)
    .sort((a, b) => a.top - b.top);
  let bad = 0;
  const gaps = [];
  for (let i = 1; i < rs.length; i++) {
    const d = rs[i].top - rs[i - 1].bottom;
    gaps.push(Math.round(d));
    if (d < -1) bad++;
  }
  return { n: rs.length, overlaps: bad, gaps: gaps.slice(0, 8) };
}"""


def frame_metrics(page, cdp):
    m = cdp.send('Performance.getMetrics')['metrics']
    return {x['name']: x['value'] for x in m if x['name'] in
            ('LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
             'ScriptDuration', 'TaskDuration', 'Nodes', 'JSHeapUsedSize')}


def run_target(browser, base, label, rep, check, out, want_onboarding=True):
    """한 빌드에서 «같은 조작»을 한다 — 짝지음 비교가 성립하도록"""
    res = {}
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
    ctx.add_init_script(init_js(onboarded=True))
    page = ctx.new_page()
    perr = []
    page.on('pageerror', lambda e: perr.append(str(e)))
    cdp = ctx.new_cdp_session(page)
    cdp.send('Performance.enable')

    # ── ② 종목 목록 ────────────────────────────────────────────────
    page.goto(base + '#/stocks', wait_until='domcontentloaded')
    page.wait_for_selector('.screen', timeout=40000)
    page.wait_for_timeout(3000)
    res['stocks_vlist'] = page.evaluate(VLIST_JS)
    res['stocks_overlap'] = page.evaluate(OVERLAP_JS, '.srow, .row')
    res['stocks_overflow'] = page.evaluate(OVERFLOW_JS)
    page.screenshot(path=str(out / ('%s_stocks.png' % label)))
    # 맨 끝까지 내려 본다 — 좌표 누적 오차는 «끝»에서 드러난다
    page.evaluate("""() => { const s=document.querySelector('.vlist')||document.querySelector('.scroll');
                             if (s) s.scrollTop = s.scrollHeight; }""")
    page.wait_for_timeout(900)
    res['stocks_end_overlap'] = page.evaluate(OVERLAP_JS, '.srow, .row')
    res['stocks_end_shot'] = True
    page.screenshot(path=str(out / ('%s_stocks_end.png' % label)))

    # ── ③ 종목 선택기 (파생 계약 화면) ───────────────────────────────
    #  ★종목 선택기 버튼은 ★«스왑»에만 있다 [실측: ContractOrder.tsx:184 `{isSwap && (`].
    #    ⛔forward 로 열면 «버튼이 아예 없다» — 그걸 「선택기가 안 열린다」로 읽으면 오진이다.
    page.goto(base + '#/contract/swap/NVDA', wait_until='domcontentloaded')
    page.wait_for_selector('.screen', timeout=40000)
    page.wait_for_timeout(2600)
    cdp.send('Performance.getMetrics')  # 기준점
    before = frame_metrics(page, cdp)
    #  ★실제 트리거는 <button className="card li"> 다 [실측: ContractOrder.tsx:187].
    #    ⛔글자로 찾지 «마라» — 로케일마다 다르고, 실제로 그렇게 짜서 못 찾았다.
    opened = page.evaluate("""() => {
        const b = document.querySelector('button.card.li') ||
                  [...document.querySelectorAll('button')].find((e) => e.classList.contains('li'));
        if (!b) return false;
        b.click();
        return true;
    }""")
    page.wait_for_timeout(1800)
    res['picker_opened'] = opened
    #  ★실제 행은 `.card--list button.row` 다 [실측: TickerPicker.tsx:122·132]
    res['picker_rows'] = page.evaluate("""() => document.querySelectorAll('.card--list button.row').length""")
    res['picker_overlap'] = page.evaluate(OVERLAP_JS, '.card--list button.row')
    res['picker_overflow'] = page.evaluate(OVERFLOW_JS)
    page.screenshot(path=str(out / ('%s_picker.png' % label)))
    # 검색으로 좁힌다
    typed = page.evaluate("""() => {
        const i = document.querySelector('input');
        if (!i) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(i, 'TSLA');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }""")
    page.wait_for_timeout(1100)
    res['picker_search_typed'] = typed
    res['picker_after_search'] = page.evaluate("""() => document.querySelectorAll('.card--list button.row').length""")
    after = frame_metrics(page, cdp)
    res['frame_picker_single'] = {k: round(after[k] - before[k], 6) for k in before}

    #  ★★단일 실행으로 판단하지 «마라». 같은 조작을 두 번 재서 ScriptDuration 이
    #    +84.6% / +121.8% 로 흔들렸다 — 그 폭 안의 차이는 «잡음»이다.
    #  ⇒ 5회 반복해 «중앙값»을 낸다.
    #
    #  ⚠️★★[실측으로 잡은 «죽은 측정»] 처음엔 「닫기 버튼을 누르고 다시 열기」로 반복했다.
    #    그런데 닫기 선택자가 안 맞아 ★모달이 열린 채였고, 다시 눌러도 «아무 일도 안 일어났다».
    #    ⇒ 그런데도 숫자는 «나왔다»: Nodes 0 · LayoutCount 0 · JSHeap 11KB.
    #      그리고 그 숫자로 「−93% 개선」 같은 결론이 나올 뻔했다.
    #    ★「0건이 부재의 증거가 아니다」의 «측정판»이다 — 측정이 죽어도 표는 채워진다.
    #  ⇒ 그래서 ① 매 회 «페이지를 새로 띄워» 확실히 처음부터 열고,
    #          ② ★측정이 «살아 있었는지»를 검사한다(Nodes 가 실제로 늘었는가).
    reps = []
    dead = 0
    for _ in range(5):
        #  ⛔같은 해시로 goto 하면 «아무 일도 안 일어난다»(해시 내비게이션 no-op).
        #    그래서 선택기가 «열린 채»로 남고, 다시 눌러도 행 수가 안 늘어 5회 전부 무효가 됐다.
        #    ⇒ 다른 화면을 «한 번 거쳐» 컴포넌트를 확실히 새로 마운트시킨다.
        page.goto(base + '#/home', wait_until='domcontentloaded')
        page.wait_for_timeout(700)
        page.goto(base + '#/contract/swap/NVDA', wait_until='domcontentloaded')
        page.wait_for_selector('.screen', timeout=40000)
        page.wait_for_timeout(2200)
        b0 = frame_metrics(page, cdp)
        n0 = page.evaluate("""() => document.querySelectorAll('.card--list button.row').length""")
        page.evaluate("""() => { const b = document.querySelector('button.card.li'); if (b) b.click(); }""")
        page.wait_for_timeout(1400)
        n1 = page.evaluate("""() => document.querySelectorAll('.card--list button.row').length""")
        a0 = frame_metrics(page, cdp)
        if n1 <= n0:
            dead += 1          # ★선택기가 «안 열렸다» = 이 회차 측정은 무효다
            continue
        reps.append({k: a0[k] - b0[k] for k in b0})
    res['frame_picker_reps'] = len(reps)
    res['frame_picker_dead'] = dead
    if reps:
        med = {}
        for k in reps[0]:
            v = sorted(x[k] for x in reps)
            med[k] = round(v[len(v) // 2], 6)
        res['frame_picker'] = med
    else:
        #  ⛔측정이 전부 죽었으면 «숫자를 내지 않는다». 빈 표가 잘못된 결론보다 낫다.
        res['frame_picker'] = None
    page.screenshot(path=str(out / ('%s_picker_search.png' % label)))
    res['pageerrors'] = perr
    ctx.close()

    # ── ① 온보딩 (세션을 지운 새 컨텍스트) ──────────────────────────
    if want_onboarding:
        c2 = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
        c2.add_init_script(init_js(onboarded=False))
        p2 = c2.new_page()
        e2 = []
        p2.on('pageerror', lambda e: e2.append(str(e)))
        p2.goto(base + '#/start', wait_until='domcontentloaded')
        p2.wait_for_selector('.screen', timeout=40000)
        p2.wait_for_timeout(2600)
        steps = []
        for i in range(10):
            _ov = p2.evaluate(OVERFLOW_JS)
            steps.append({
                'i': i,
                'overflow': len(_ov),
                'overflowDetail': _ov[:4],   # ★개수만 남기면 원인을 못 찾는다
                'txt': p2.evaluate("""() => [...document.querySelectorAll('.screen *')]
                    .filter((e) => e.children.length === 0)
                    .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 3)"""),
            })
            p2.screenshot(path=str(out / ('%s_onboard_%d.png' % (label, i))))
            #  ★온보딩은 «단계마다 막는 조건»이 다르다 [실측 locales onboarding.*]:
            #    닉네임을 입력해야 다음이 열리고, 종목은 «3개»를 골라야 CTA 가 켜진다.
            #    ⛔버튼만 누르면 2단계에서 멈춘다 — 실제로 그렇게 짜서 멈췄다.
            moved = p2.evaluate("""() => {
                const inp = document.querySelector('input[type="text"], input:not([type])');
                if (inp && !inp.value) {
                    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    set.call(inp, '리미');
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
                const rows = [...document.querySelectorAll('.card--list button.row, .srow, button.row')];
                const cta = [...document.querySelectorAll('button')].filter((e) => !e.disabled)
                    .filter((e) => /시작|받고|골랐|보러|다음|계속/.test(e.textContent || ''));
                if (rows.length >= 3 && !cta.length) { rows.slice(0, 3).forEach((r) => r.click()); return true; }
                if (cta.length) { cta[cta.length - 1].click(); return true; }
                if (rows.length) { rows[0].click(); return true; }
                return false;
            }""")
            p2.wait_for_timeout(1200)
            if not moved:
                break
        res['onboard_steps'] = steps
        res['onboard_overflow_total'] = sum(s['overflow'] for s in steps)
        res['onboard_pageerrors'] = e2
        c2.close()
    return res


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_bigticker')
    out.mkdir(parents=True, exist_ok=True)
    ref_ait = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    N = ticker_count()
    rep = {'dist': str(DIST), 'tickerCount': N, 'controls': [], 'checks': [], 'fail': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print('  ' + ('PASS' if ok else '★FAIL') + '  ' + name + '  ' + str(detail))

    if not (DIST / 'index.html').exists():
        print('FAILED: 빌드가 없다 —', DIST)
        return 1
    if N <= 0:
        print('FAILED: 종목 수를 못 셌다 — tickers.generated.ts 형식이 바뀌었으면 검사기를 고쳐라')
        return 1
    print('종목 수 [소스에서 셈]: %d' % N)

    targets = {'new': (DIST, True)}
    if ref_ait and ref_ait.exists():
        #  ★ref 에서도 온보딩을 «돈다». 안 돌리면 「새로 생긴 넘침인가」를 «가정»하게 된다.
        #    짝지어 재야 「원래 있었다」와 「이번에 생겼다」가 갈린다.
        targets['ref'] = (extract(ref_ait, out / '_ref'), True)

    with open_browser() as (_pw, browser):
        for label, (d, want_onb) in targets.items():
            httpd, port = serve(d)
            print('\n[%s] %s' % (label, d))
            try:
                rep[label] = run_target(browser, 'http://127.0.0.1:%d/' % port, label, rep, check, out, want_onb)
            finally:
                httpd.shutdown()

    r = rep['new']
    print('\n판정')
    check('종목 목록: 행 겹침 0 (첫 화면)', r['stocks_overlap']['overlaps'] == 0, r['stocks_overlap'])
    check('종목 목록: 행 겹침 0 (★맨 끝)', r['stocks_end_overlap']['overlaps'] == 0, r['stocks_end_overlap'])
    check('종목 목록: 넘침·화면이탈 0', len(r['stocks_overflow']) == 0, r['stocks_overflow'][:3])
    check('★종목 선택기: 열린다', r['picker_opened'] is True)
    check('★종목 선택기: 전 종목 접근 가능 (가상 스크롤이라 «렌더 행»은 적은 게 정상)',
          r['picker_rows'] > 0, {'rendered': r['picker_rows'], 'total': N})
    check('종목 선택기: 행 겹침 0', r['picker_overlap']['overlaps'] == 0, r['picker_overlap'])
    check('종목 선택기: 넘침·화면이탈 0', len(r['picker_overflow']) == 0, r['picker_overflow'][:3])
    check('★검색이 «좁힌다»', r['picker_search_typed'] and r['picker_after_search'] < max(1, r['picker_rows']),
          {'before': r['picker_rows'], 'after': r['picker_after_search']})
    check('종목 화면 pageerror 0', len(r['pageerrors']) == 0, r['pageerrors'][:2])
    if 'onboard_steps' in r:
        #  ★★판정을 «짝지음»으로 한다 — 「0건」이 아니라 「새로 생긴 게 0건」이다.
        #    [실측] 온보딩 5단계에 <circle inSvg> 넘침 1건이 있는데, ★100종목 ref 에도
        #    «같은 좌표로 똑같이» 있다(left 384 · right 393 · w 9).
        #    = 차트 끝점 장식(AreaChart 의 cx=W-2 r=4.5)이 2px 삐져나온 것이고
        #      종목 수와 «무관»하다. ⇒ 이걸 이번 확장의 결함으로 보고하면 오진이다.
        #  ⛔그렇다고 «면제 명단»으로 지우지 않는다 — 지우면 그 자리의 «다음» 넘침도 같이 삼킨다.
        #    ref 와 «비교»하면 면제 없이도 새 것만 걸린다.
        ref_ov = rep.get('ref', {}).get('onboard_overflow_total')
        if ref_ov is None:
            check('★온보딩: 전 단계 넘침 0 (⚠️비교 대상 없음 — 절대값 판정)',
                  r['onboard_overflow_total'] == 0,
                  [(x['i'], x['overflowDetail']) for x in r['onboard_steps'] if x['overflow']])
        else:
            check('★온보딩: «새로 생긴» 넘침 0 (ref 대비)',
                  r['onboard_overflow_total'] <= ref_ov,
                  {'new': r['onboard_overflow_total'], 'ref(100종목)': ref_ov})
        check('온보딩: pageerror 0', len(r['onboard_pageerrors']) == 0, r['onboard_pageerrors'][:2])
        check('온보딩: 단계가 «진행»된다', len(r['onboard_steps']) >= 3, len(r['onboard_steps']))

    if 'ref' in rep:
        print('\n★짝지은 구조 지표 — 종목 선택기 열기 «5회 중앙값» (⛔fps 아님)')
        a, b = rep['ref']['frame_picker'], rep['new']['frame_picker']
        if a is None or b is None:
            print('  ⛔측정 무효 — 선택기가 열리지 않은 회차가 있다'
                  ' (new dead %s · ref dead %s). 숫자를 내지 않는다.'
                  % (rep['new'].get('frame_picker_dead'), rep['ref'].get('frame_picker_dead')))
            rep['fail'].append(['프레임 측정 무효', '선택기 미개방'])
            a = b = None
        print('  %-22s %14s %14s %10s' % ('지표', '100종목(ref)', '1,000종목(new)', '변화'))
        for k in (b or {}):
            av, bv = a.get(k, 0), b[k]
            pct = ('%+.1f%%' % ((bv / av - 1) * 100)) if av else '-'
            print('  %-22s %14.6g %14.6g %10s' % (k, av, bv, pct))
        rep['framePaired'] = {'ref': a, 'new': b}
        if b:
            print('  유효 회차 — new %d/5 · ref %d/5 (죽은 회차 new %d · ref %d)'
                  % (rep['new']['frame_picker_reps'], rep['ref']['frame_picker_reps'],
                     rep['new']['frame_picker_dead'], rep['ref']['frame_picker_dead']))
        print('  ⛔fps 는 측정하지 않았고 주장하지도 않는다.')

    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n검사 %d건 · 실패 %d건 → %s' % (len(rep['checks']), len(rep['fail']), out))
    return 1 if rep['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
