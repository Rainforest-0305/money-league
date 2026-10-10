# -*- coding: utf-8 -*-
"""
렌더 부하 «구조 지표» 측정 — ★headless 전용.

  python scripts/verify_frame.py <출력폴더> [라이브 .ait]

★★⛔fps 를 «주장하지 않는다». headless 는 «거짓 60」을 준다 —
  vsync 가 없어 rAF 가 실제 화면 갱신과 무관하게 돌기 때문이다.
  ⇒ 대신 ★CDP `Performance.getMetrics` 의 «구조 지표»를 본다:
      LayoutCount · RecalcStyleCount · LayoutDuration · RecalcStyleDuration ·
      ScriptDuration · TaskDuration · Nodes · JSHeapUsedSize
    이건 «얼마나 일을 시켰는가»라서 headless 에서도 뜻이 있다.

★★그리고 ★«짝지은 차이»로만 판단한다 — 절대값은 기계·부하에 따라 요동친다.
  ★같은 시드 · 같은 스크립트 조작 · 같은 대기시간으로 ★라이브 빌드와 새 빌드를
  ★번갈아 N회 돌려 중앙값을 비교한다(연속 실행 시 머신 상태가 한쪽에 유리해진다).
"""
import http.server
import json
import shutil
import socket
import socketserver
import statistics
import os
import sys
import threading
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

# ★★[2026-08-22] 콘솔 인코딩을 «스크립트가 스스로» 고친다.
#   윈도우 기본 코드페이지(cp949)에서는 «»·★ 를 못 찍어 UnicodeEncodeError 로 죽는다.
#   ⛔그때 죽는 것은 «검사»가 아니라 «출력»인데 EXIT=1 이 나온다 —
#     「저장본 호환성 검증 실패」로 오독하기 딱 좋다(실제로 CTO 레인이 그렇게 만났다).
#   ⛔PYTHONIOENCODING 을 «기억해야» 도는 검사기는 언젠가 반드시 잘못 돌아간다.
for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
VIEW = {'width': 390, 'height': 844}
REPS = 5

METRICS = [
    'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
    'ScriptDuration', 'TaskDuration', 'Nodes', 'JSHeapUsedSize',
]


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


INIT = (
    "(() => {"
    "localStorage.setItem('ml.onboarded','1');"
    "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
    "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
    "})()"
)


def extract_live(ait: Path, dest: Path):
    if dest.exists():
        return dest
    dest.mkdir(parents=True)
    with zipfile.ZipFile(ait) as z:
        idx = sorted([n for n in z.namelist() if n.endswith('index.html')], key=lambda n: n.count('/'))
        root = idx[0].rsplit('index.html', 1)[0]
        for n in z.namelist():
            if not n.startswith(root) or n.endswith('/'):
                continue
            rel = n[len(root):]
            if not rel:
                continue
            t = dest / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(z.read(n))
    return dest


def scenario(page, base, has_deriv_chips):
    """
    ★두 빌드에 «똑같이» 먹이는 조작. 라이브에 없는 화면은 «양쪽 다» 안 간다 —
      안 그러면 새 빌드에만 부하를 더 주고 비교가 무의미해진다.
    """
    for route, scrolls in (
        ('#/home', [0, 700, 1400]),
        ('#/stocks', [0, 900, 1800]),
        ('#/rank', [0, 900, 1800]),
        ('#/derivatives', [0, 400]),
        ('#/stock/NVDA', [0, 700]),
    ):
        page.goto(base + route, wait_until='domcontentloaded')
        page.wait_for_selector('.screen', timeout=25000)
        page.wait_for_timeout(1400)
        for y in scrolls:
            try:
                page.eval_on_selector('.scroll', f'e => e.scrollTop = {y}')
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(450)
    if has_deriv_chips:
        page.goto(base + '#/derivatives', wait_until='domcontentloaded')
        page.wait_for_selector('.pillrow', timeout=20000)
        page.wait_for_timeout(900)
        for i in range(4):
            page.query_selector_all('.pillrow .pill')[i].click()
            page.wait_for_timeout(450)


def measure(browser, base, has_chips):
    ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    cdp = ctx.new_cdp_session(page)
    cdp.send('Performance.enable')
    page.goto(base + '#/home', wait_until='domcontentloaded')
    page.wait_for_selector('.tabbar', timeout=30000)
    page.wait_for_timeout(3500)  # 워밍업이 끝난 «뒤»에 기준선을 잡는다
    def snap():
        return {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    a = snap()
    scenario(page, base, has_chips)
    b = snap()
    out = {}
    for k in METRICS:
        if k in a and k in b:
            out[k] = b[k] - a[k] if k not in ('Nodes', 'JSHeapUsedSize') else b[k]
    ctx.close()
    return out


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_frame')
    ait = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_backup_ait_20260820_ux' / 'moneyleague_20260819-3_live.ait'
    out.mkdir(parents=True, exist_ok=True)
    live_dir = extract_live(ait, ROOT / '_live_extracted')

    lh, lp = serve(live_dir)
    # ⚠★`npm run ait:build` 뒤에는 `dist/` 가 RN 번들 출력으로 바뀐다(웹 자산은 dist/web/).
    #   그 상태로 그냥 돌리면 `.tabbar` 를 못 찾고 ★30초 타임아웃이 난다(U-3 의 함정 그대로).
    #   ⇒ 출하물을 재려면 `.ait` 의 web/ 을 펼쳐 `ML_DIST` 로 가리켜라.
    nh, np_ = serve(ROOT / os.environ.get('ML_DIST', 'dist'))
    live_base = f'http://127.0.0.1:{lp}/'
    new_base = f'http://127.0.0.1:{np_}/'
    # ★세 팔로 잰다:
    #   live      라이브 빌드 · 라이브 시나리오
    #   new_same  ★새 빌드 · ★«똑같은» 시나리오  ← ★회귀를 «격리»하는 팔이다
    #   new_full  새 빌드 · 파생 칩까지 포함(추가된 «기능»의 비용)
    # ⇒ live vs new_same 만이 «같은 처치»의 비교다. 판단은 그 쌍으로 한다.
    rows = {'live': [], 'new_same': [], 'new_full': []}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            for i in range(REPS):
                # ★번갈아 돈다 — 연속 실행이면 머신 상태(캐시·열)가 한쪽에 유리해진다
                order = [('live', live_base, False), ('new_same', new_base, False), ('new_full', new_base, True)]
                if i % 2:
                    order.reverse()
                for key, b, chips in order:
                    rows[key].append(measure(browser, b, chips))
                print(f'  회차 {i + 1}/{REPS} 완료')
        finally:
            browser.close()
            lh.shutdown()
            nh.shutdown()

    rep = {'reps': REPS, 'raw': rows, 'median': {}}
    print()
    print('★구조 지표 «중앙값» · 짝지은 실행 · ⛔fps 아님')
    print(f"  {'지표':<22}{'라이브':>12}{'새(동일)':>12}{'회귀':>10}{'새(파생포함)':>14}{'기능비용':>10}")
    for k in METRICS:
        lv = [r[k] for r in rows['live'] if k in r]
        ns = [r[k] for r in rows['new_same'] if k in r]
        nf = [r[k] for r in rows['new_full'] if k in r]
        if not lv or not ns or not nf:
            continue
        ml, ms, mf = statistics.median(lv), statistics.median(ns), statistics.median(nf)
        rep['median'][k] = {
            'live': ml, 'new_same': ms, 'new_full': mf,
            'regressionPct': (ms / ml - 1) * 100 if ml else None,
            'featurePct': (mf / ms - 1) * 100 if ms else None,
        }
        r1 = f"{(ms / ml - 1) * 100:+.1f}%" if ml else '-'
        r2 = f"{(mf / ms - 1) * 100:+.1f}%" if ms else '-'
        print(f"  {k:<22}{ml:>12.4g}{ms:>12.4g}{r1:>10}{mf:>14.4g}{r2:>10}")

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print()
    print('★「회귀」   = «같은 조작»에서 새 빌드가 더/덜 일한 정도 (라이브 → 새(동일))')
    print('★「기능비용」 = 파생 4종 칩 조작을 «추가»했을 때 늘어난 일 (새(동일) → 새(파생포함))')
    print('⛔fps 는 측정하지 않았고 주장하지도 않는다 — headless 는 vsync 가 없어 «거짓 60」을 준다.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
