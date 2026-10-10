# -*- coding: utf-8 -*-
"""
종목 화면 «정렬»이 맞는가 + 1,000행 전환 «성능» — ★headless 전용.

  ML_DIST=dist python scripts/verify_sort.py

★검증 방식: 화면에 보이는 상위 행의 «값»을 읽어 단조성(monotonic)을 확인한다.
  ⛔「정렬 버튼이 눌린다」로 끝내지 마라 — 눌려도 «순서가 틀릴» 수 있다.
★성능: 정렬 전환 1회의 «클릭 → DOM 갱신 완료»까지 실측. 프레임 드랍이면 안 넣느니만 못하다.
"""
import http.server
import json
import os
import socket
import socketserver
import statistics
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

INIT = ("(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "})()")

# ⛔☠️★[검사기 결함 3종 — 내가 만들었고, 앱이 아니라 «검사기»가 틀렸다]
#   ① innerText 를 줄바꿈으로 쪼개 인덱스로 집었다 → 필드가 밀려 «가격» 자리에서
#      보유수량(100)·평단(500) 을 읽었다. ⇒ ★StockRow 에 «안정적인 클래스»가 있다:
#      .row__nm(이름) · .row__sub(티커·업종) · .row__p(가격) · .row__c(등락률)
#   ② 파싱 실패로 리스트가 «비면» all([]) == True 라 ★«거짓 PASS» 가 났다(등락률).
#      ⇒ 「값을 몇 개 읽었는지」를 «먼저» 검사한다. 0개면 그건 통과가 아니라 «측정 실패»다.
#   ③ 성능 측정 구간에 내가 넣은 wait_for_timeout(120) 이 «들어가 있었다».
#      ⇒ 168~191ms 중 120ms 가 내 sleep 이었다. ★측정이 자기 자신을 쟀다.
ROWS = """() => {
  const out = [];
  document.querySelectorAll('.row').forEach((r) => {
    const g = (sel) => { const e = r.querySelector(sel); return e ? (e.textContent || '').trim() : ''; };
    out.push({ nm: g('.row__nm'), sub: g('.row__sub'), price: g('.row__p'), chg: g('.row__c') });
  });
  return out.slice(0, 8);
}"""

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def num(s):
    """'$2,681.37' / '+1.18%' -> float. 못 읽으면 None (⛔0 으로 «채우지» 마라)"""
    keep = ''.join(c for c in str(s) if c.isdigit() or c in '.-')
    if keep in ('', '-', '.', '-.'):
        return None
    try:
        return float(keep)
    except ValueError:
        return None


def tick_of(row):
    """'GOLD · 원자재' -> 'GOLD'"""
    return str(row.get('sub', '')).split('·')[0].strip()


def monotonic(vals, desc=True):
    """★단조성 판정. ⛔값이 2개 미만이면 «통과가 아니라 측정 실패»다."""
    v = [x for x in vals if x is not None]
    if len(v) < 3:
        return None, v          # None = 판정불능
    ok = all((v[i] >= v[i + 1] - 1e-9) if desc else (v[i] <= v[i + 1] + 1e-9)
             for i in range(len(v) - 1))
    return ok, v


def main():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    out = ROOT / '_shots'
    out.mkdir(parents=True, exist_ok=True)

    def chk(name, ok, d=''):
        print('  %s  %s  %s' % ('PASS' if ok else '★FAIL', name, d))
        if not ok:
            fails.append(name)

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(INIT)
                p = ctx.new_page()
                errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                p.goto(base + '#/stocks', wait_until='domcontentloaded')
                p.wait_for_selector('.tabbar', timeout=120000)
                p.wait_for_selector('.boot', state='detached', timeout=180000)
                p.wait_for_timeout(2500)

                # ── ① 기본: 주요 자산 6종이 «맨 위» ──────────────────────
                rows = p.evaluate(ROWS)
                top6 = [tick_of(r) for r in rows[:6]]
                want = {'GOLD', 'WTI', 'BTC', 'ETH', 'SPX', 'NDX'}
                chk('① 기본정렬: 주요자산 6종이 «상위 6행»', set(top6) == want, '%s' % top6)
                chk('① 그 다음이 순위 1위(NVDA)', len(rows) > 6 and tick_of(rows[6]) == 'NVDA',
                    tick_of(rows[6]) if len(rows) > 6 else '(행 부족)')

                # ── ② 축별 정렬 + 성능 ───────────────────────────────────
                #   ★성능은 «클릭 → 첫 행이 실제로 바뀔 때까지»만 잰다.
                #     ⛔대기(sleep)를 측정 구간에 넣지 마라 — 그러면 내 sleep 을 재게 된다.
                perf = {}
                FIELD = {'등락률': 'chg', '가격': 'price'}
                for label in ('등락률', '가격', '시가총액', '배당', '거래량', '이름'):
                    btn = p.get_by_role('button', name=label, exact=True)
                    if btn.count() == 0:
                        chk('② %s 칩이 있다' % label, False, '버튼 없음')
                        continue
                    before_nm = (p.evaluate(ROWS) or [{}])[0].get('nm', '')
                    t0 = time.perf_counter()
                    btn.first.click()
                    try:
                        p.wait_for_function(
                            """(prev) => { const e = document.querySelector('.row .row__nm');
                                           return e && e.textContent.trim() !== prev; }""",
                            arg=before_nm, timeout=5000)
                    except Exception:
                        pass          # 첫 행이 «안 바뀌는» 정렬도 있다(이미 그 순서였던 경우)
                    perf[label] = (time.perf_counter() - t0) * 1000
                    p.wait_for_timeout(500)
                    rows = p.evaluate(ROWS)
                    f = FIELD.get(label)
                    if f:
                        ok, v = monotonic([num(r[f]) for r in rows[:5]], desc=True)
                        if ok is None:
                            chk('② %s 단조성 ★판정불능(값 %d개)' % (label, len(v)), False,
                                '★검사기가 값을 못 읽었다 — 앱 판정에 쓰지 마라')
                        else:
                            chk('② %s 내림차순이 «단조»한가' % label, ok, '%s' % v)
                    else:
                        chk('② %s 정렬이 «돈다»(상위 4행)' % label, len(rows) >= 4,
                            '%s' % [r['nm'] for r in rows[:4]])

                # ── ③ 방향 전환 ──────────────────────────────────────────
                b = p.get_by_role('button', name='가격', exact=True)
                b.first.click()
                p.wait_for_timeout(700)
                hi, _ = monotonic([num(r['price']) for r in p.evaluate(ROWS)[:5]], desc=True)
                hi_top = num(p.evaluate(ROWS)[0]['price'])
                b.first.click()
                p.wait_for_timeout(700)
                lo, lo_v = monotonic([num(r['price']) for r in p.evaluate(ROWS)[:5]], desc=False)
                lo_top = num(p.evaluate(ROWS)[0]['price'])
                chk('③ 재클릭이 «방향을 뒤집는다»(오름차순 단조)', lo is True, '%s' % lo_v)
                chk('③b 최고가 -> 최저가로 «바뀐다»',
                    hi_top is not None and lo_top is not None and lo_top < hi_top,
                    '%s -> %s' % (hi_top, lo_top))

                # ── ④ 필터 × 정렬 «직교» ─────────────────────────────────
                p.get_by_role('button', name='빅테크', exact=True).first.click()
                p.wait_for_timeout(700)
                on = p.evaluate("""() => [...document.querySelectorAll('.pill--on')].map((e) => e.innerText.trim())""")
                chk('④ 칩을 눌러도 «정렬이 유지»된다(직교)',
                    any('가격' in x for x in on) and any('빅테크' in x for x in on),
                    '활성 칩: %s' % on)
                p.screenshot(path=str(out / 'AFTER_ko_stocks_sorted.png'))

                # ── ⑤ 성능 판정 ─────────────────────────────────────────
                worst = max(perf.values()) if perf else 0
                print('  전환 소요(ms · 클릭→첫행 갱신): %s' % {k: round(v) for k, v in perf.items()})
                chk('⑤ 1,000행 정렬 전환이 «100ms 이내»', worst < 100, '최대 %.0fms' % worst)
                chk('pageerror 0', not errs, str(errs[:2]))
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    print('')
    print('검사 실패 %d건' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
