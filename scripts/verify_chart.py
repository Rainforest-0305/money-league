# -*- coding: utf-8 -*-
"""
차트 실측 — 거래량 막대 · 이동평균선이 «화면에» 실제로 그려지는가. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_chart.py <출력폴더> [비교할 .ait]
  ML_DIST=_ait_web python scripts/verify_chart.py <출력폴더>

★★왜 이 하네스가 생겼나 (2026-08-22)
  President 가 실기기(라이브 20260821-8)에서 「거래량이랑 이평선 표시 제대로 나오게 고쳐」.
  ★코드에는 «있었다». 그런데 화면에는 안 나온다 — 그 간극을 코드 읽기로는 못 잡는다.
  ⇒ 이 하네스는 ★«그려진 SVG 를 센다». 상태를 «전 조합» 돌면서 센다:
      라인 × 기간 4(1·2·4일·전체) + 캔들(1일봉 · 전체 고정)
  ⇒ 그리고 ★비교 대상 .ait 가 주어지면 «같은 조작»을 그쪽에도 하고 나란히 낸다.

★측정 정의 (⛔「있다/없다」가 아니라 «셀 수 있는 것»으로 잰다)
  · 봉 개수      = 캔들 svg 안 <g> 개수
  · 장기 MA      = path[stroke-dasharray="5 4"] 개수   (없으면 0 = 안 그려진 것)
  · 단기 MA      = path[stroke="var(--t2)"] 개수
  · MA 꼭짓점    = path d 의 좌표 개수 — ★2 이하면 「선」이 아니라 «직선 조각»이다
  · 거래량 막대  = 거래량 svg path 의 서브패스(M) 개수 · 그리고 «보이는 높이»(≥1.5px)
  · 거래량 x축   = 거래량 막대 개수가 «봉 개수»와 같은가 (캔들 모드에서만 뜻이 있다)
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

# ★★조직 표준 headless 런처를 «경유»한다 (2026-08-22 Chief 지시).
#   ⛔`pw.chromium.launch()` 를 직접 부르지 않는다 — headless 를 «변수로 받는» 구멍이
#     President 화면 점유 사고를 두 번 냈다. 이 런처는 headless=True 를 하드코딩하고
#     channel·devtools·slowMo 를 «시그니처에서 아예 안 받는다».
sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}

PERIODS = ['1일', '2일', '4일', '전체']
# ★[2026-08-26] 봉 단위 칩이 «없어졌다» — 1봉 = 게임 1일 하나뿐이라
#   고를 게 없고, 그 단위가 설 수 있는 기간도 «전체» 뿐이다(900틱 = 6봉).
#   ⇒ 캔들 모드는 ★상태가 하나다. 스윙할 조합이 없다.
CHART_TABS = ['라인', '1일봉']


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
                tgt = dest / n[len(root):]
                tgt.parent.mkdir(parents=True, exist_ok=True)
                tgt.write_bytes(z.read(n))
    return dest


# ★★시드를 «고정»한다 (2026-08-22, 이 하네스가 스스로 발견한 측정 함정).
#   gameWorld 는 «매 세션 다른 시드»를 쓴다 — 그래서 분포성 지표(거래량 막대 크기)가
#   실행마다 흔들린다. 같은 dist 를 두 번 재서 13 vs 25 가 나왔다.
#   ⇒ 인계문서 11장 2번 「단일 시드로 판단하지 마라」의 정확한 사례다.
#   ⇒ 전/후를 «같은 시드»로 재야 비교가 성립한다.
FIXED_SEED = int(os.environ.get('ML_SEED', '20260822'))


def init_js(theme='light', save=None):
    parts = [
        "localStorage.setItem('ml.seed','%d');" % FIXED_SEED,
        "localStorage.setItem('ml.onboarded','1');",
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));",
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'%s',updown:'kr'}));" % theme,
    ]
    if save is not None:
        parts.append("localStorage.setItem('ml.game', %s);" % json.dumps(save))
    else:
        parts.append("localStorage.removeItem('ml.game');")
    return '(() => {' + ''.join(parts) + '})()'


def restored_save():
    """★저장본 복원 «직후» 상태 — 워밍업이 끝나고 가격을 평행이동한 직후다.
    거래량 링버퍼는 워밍업이 채운 것이 그대로 남는다. 그게 실제로 그런지 이 상태로 확인한다."""
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 4200,
        'account': {'cash': 8000, 'holdings': [['NVDA', {'qty': 5, 'avgCost': 300}]],
                    'levPositions': [], 'optPositions': [], 'realizedPnl': -120.5,
                    'feesPaid': 33.2, 'tradeCount': 7, 'liquidationCount': 0, 'topupCount': 1},
        'topup': {'dateKey': '', 'usedToday': 1, 'lastTopupAt': 0},
        'prices': {'NVDA': 402.75},
    })


# ★그려진 것을 «센다». ⛔「컴포넌트가 있다」가 아니라 «SVG 에 좌표가 있다».
MEASURE_JS = r"""() => {
  const subpaths = (d) => (d ? (d.match(/M/g) || []).length : 0);
  const verts = (d) => (d ? (d.match(/[ML]\s*-?[\d.]/g) || []).length : 0);
  const svgs = [...document.querySelectorAll('.screen svg')];
  const price = svgs.find(s => /^0 0 390 (176|200)$/.test(s.getAttribute('viewBox') || ''));
  const vol = svgs.find(s => (s.getAttribute('viewBox') || '') === '0 0 390 44');

  let bars = 0, maLong = 0, maShort = 0, maLongVerts = 0, maShortVerts = 0, mode = 'none';
  if (price) {
    mode = price.getAttribute('viewBox').endsWith('200') ? 'candle' : 'line';
    bars = price.querySelectorAll('g').length;
    const dl = [...price.querySelectorAll('path[stroke-dasharray="5 4"]')];
    const ds = [...price.querySelectorAll('path[stroke="var(--t2)"]')];
    maLong = dl.length; maShort = ds.length;
    maLongVerts = dl.length ? verts(dl[0].getAttribute('d')) : 0;
    maShortVerts = ds.length ? verts(ds[0].getAttribute('d')) : 0;
  }
  let volBars = 0, volEmpty = true, volVisible = 0, volH = 0, volGrid = 0;
  if (vol) {
    const ps = [...vol.querySelectorAll('path')];
    volBars = ps.reduce((a, p) => a + subpaths(p.getAttribute('d')), 0);
    volEmpty = volBars === 0;
    /* ★「보이는 막대」 = 높이 1.5px 이상. 0.8px 바닥선은 «있는 척»이다 */
    for (const p of ps) {
      const d = p.getAttribute('d') || '';
      for (const m of d.matchAll(/v(-?[\d.]+)/g)) {
        const h = Math.abs(parseFloat(m[1]));
        if (h >= 1.5) volVisible++;
        if (h > volH) volH = h;
      }
    }
    /*
     * ★★x축 «격자»를 잰다 — 막대 «개수»로는 못 잰다.
     *   거래가 0인 칸은 막대를 «안 그리므로» 개수가 봉 수보다 적은 게 «정상»이다.
     *   ⇒ 대신 막대 «폭»에서 칸 수를 역산한다: bw = (390 / n) * 0.58.
     *     이 값이 봉 수와 같아야 「막대 하나 = 봉 하나」다.
     */
    let bw = 0;
    for (const p of ps) {
      const m = (p.getAttribute('d') || '').match(/h([\d.]+)v/);
      if (m) { bw = parseFloat(m[1]); break; }
    }
    volGrid = bw > 0 ? Math.round((390 * 0.58) / bw) : 0;
  } else {
    /* svg 가 아예 없으면 «빈 상태 문구»가 대신 있다 */
    volEmpty = true;
  }
  const texts = [...document.querySelectorAll('.screen *')]
    .filter(e => e.children.length === 0).map(e => (e.textContent || '').trim()).filter(Boolean);
  return {
    mode, bars, maLong, maShort, maLongVerts, maShortVerts,
    volBars, volEmpty, volVisible, volGrid, volMaxH: Math.round(volH * 10) / 10,
    legend: texts.filter(t => /평균/.test(t)),
    volNote: texts.filter(t => /거래량/.test(t)),
    activePeriod: (document.querySelector('.chips .is-on, .chips [aria-pressed="true"]') || {}).textContent || null,
  };
}"""


def click_text(page, label):
    page.eval_on_selector_all(
        'button',
        'els => { const b = els.find(e => (e.textContent||"").trim() === %s); if (b) b.click(); return !!b; }' % json.dumps(label),
    )
    page.wait_for_timeout(650)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_chart')
    out.mkdir(parents=True, exist_ok=True)
    cmp_ait = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None

    targets = {'new': DIST}
    if cmp_ait and cmp_ait.exists():
        targets['ref'] = extract(cmp_ait, out / '_ref')

    rep = {'dist': str(DIST), 'ref': str(cmp_ait) if cmp_ait else None,
           'controls': [], 'rows': [], 'shots': [], 'fail': []}
    fails = []

    def control(name, caught):
        rep['controls'].append([name, bool(caught)])
        print(f"  {'CAUGHT' if caught else 'MISSED'}  {name}")
        return bool(caught)

    with open_browser() as (_pw, b):
        try:
            for tname, tdist in targets.items():
                httpd, port = serve(tdist)
                base = f'http://127.0.0.1:{port}/'
                for state, save in [('fresh', None), ('restored', restored_save())]:
                    ctx = b.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                    ctx.add_init_script(init_js('light', save))
                    pg = ctx.new_page()
                    perr = []
                    pg.on('pageerror', lambda e: perr.append(str(e)))
                    pg.goto(base + '#/stock/NVDA', wait_until='domcontentloaded')
                    pg.wait_for_selector('.orderbar', timeout=40000)
                    pg.wait_for_timeout(3200)

                    # ── 대조: 측정기가 살아 있는가 (첫 타깃·첫 상태에서 한 번) ──
                    if tname == 'new' and state == 'fresh':
                        print('\n대조 (측정기 생존 증명)')
                        base_m = pg.evaluate(MEASURE_JS)
                        ok = True
                        ok &= control('가격 차트 svg 를 찾는다', base_m['mode'] in ('line', 'candle'))
                        # 니들: 파선 path 를 심으면 maLong 이 는다
                        pg.evaluate("""() => {
                            const s=[...document.querySelectorAll('.screen svg')].find(x=>/^0 0 390 (176|200)$/.test(x.getAttribute('viewBox')||''));
                            const p=document.createElementNS('http://www.w3.org/2000/svg','path');
                            p.id='needleMa'; p.setAttribute('stroke-dasharray','5 4'); p.setAttribute('d','M0 0L10 10L20 5'); s.appendChild(p);
                        }""")
                        n1 = pg.evaluate(MEASURE_JS)
                        ok &= control('장기 MA 계수기(파선)', n1['maLong'] > base_m['maLong'])
                        ok &= control('MA 꼭짓점 계수기', n1['maLongVerts'] >= 3)
                        pg.evaluate("() => document.getElementById('needleMa')?.remove()")
                        # 니들: 거래량 svg 에 막대 하나 심으면 volBars 가 는다
                        pg.evaluate("""() => {
                            const s=[...document.querySelectorAll('.screen svg')].find(x=>(x.getAttribute('viewBox')||'')==='0 0 390 44');
                            if(!s) return;
                            const p=document.createElementNS('http://www.w3.org/2000/svg','path');
                            p.id='needleVol'; p.setAttribute('d','M5 10h4v20h-4Z'); s.appendChild(p);
                        }""")
                        n2 = pg.evaluate(MEASURE_JS)
                        ok &= control('거래량 막대 계수기', n2['volBars'] > base_m['volBars'])
                        ok &= control('★거래량 «보이는 높이» 계수기', n2['volVisible'] > base_m['volVisible'])
                        pg.evaluate("() => document.getElementById('needleVol')?.remove()")
                        if not ok:
                            print('FAILED: 대조 실패 — 이 실행의 수치는 무효다.')
                            return 1

                    for chart in CHART_TABS:
                        click_text(pg, chart)
                        if chart == '라인':
                            for per in PERIODS:
                                click_text(pg, per)
                                m = pg.evaluate(MEASURE_JS)
                                rep['rows'].append({'target': tname, 'state': state, 'chart': chart,
                                                    'unit': '-', 'period': per, **m})
                        else:
                            # ★캔들은 기간이 «고정»이다. 알약을 눌러도 상태가 안 변하는 게 정상이다
                            m = pg.evaluate(MEASURE_JS)
                            rep['rows'].append({'target': tname, 'state': state, 'chart': chart,
                                                'unit': '1일봉', 'period': '전체(고정)', **m})
                    # 대표 스크린샷 (라이트·다크 × 라인·캔들)
                    for theme in ['light', 'dark']:
                        pg.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
                        for chart in CHART_TABS:
                            click_text(pg, chart)
                            if chart == '라인':
                                click_text(pg, '전체')
                            name = f'{tname}_{state}_{theme}_{"line" if chart == "라인" else "candle"}.png'
                            pg.screenshot(path=str(out / name))
                            rep['shots'].append(name)
                    rep['rows'].append({'target': tname, 'state': state, 'pageerrors': perr})
                    if perr:
                        fails.append(f'{tname}/{state} pageerror')
                    ctx.close()
                httpd.shutdown()
        finally:
            pass  # ★브라우저 종료는 open_browser 의 with 가 보장한다

    # ── 표 ────────────────────────────────────────────────────────────
    print('\n%-5s %-9s %-5s %-5s %-5s | %5s %5s %5s | %6s %6s %6s' %
          ('대상', '상태', '모드', '단위', '기간', '봉', '장기MA', '단기MA', '거래량', '격자', '보임'))
    for r in rep['rows']:
        if 'mode' not in r:
            continue
        print('%-5s %-9s %-5s %-5s %-5s | %5d %5d %5d | %6d %6d %6d' %
              (r['target'], r['state'], r['chart'], r['unit'], r['period'],
               r['bars'], r['maLong'], r['maShort'], r['volBars'], r.get('volGrid', 0), r['volVisible']))

    rows = [r for r in rep['rows'] if 'mode' in r and r['target'] == 'new']
    cand = [r for r in rows if r['chart'] == '1일봉']
    line = [r for r in rows if r['chart'] == '라인']
    summary = {
        '캔들 조합 수': len(cand),
        # ★★[2026-08-26] 캔들 이평선은 «빼는 것»이 정답이 됐다(6봉에서 점 3개 = 잔해).
        #   ⇒ 판정이 «뒤집혔다». 그리고 ⛔«양방향»으로 본다 — 캔들만 보면 라인까지
        #     지워도 통과한다. 두 줄이 «같이» 0 이어야 정상이다.
        '★캔들: 이평선이 «그려진» 조합 (있으면 결함 · 잔해 복귀)':
            sum(1 for r in cand if r['maLong'] > 0 or r['maShort'] > 0),
        '★라인: 이평선이 «안 그려진» 조합 (있으면 결함 · 지우면 안 되는 쪽)':
            sum(1 for r in line if r['maLong'] == 0 or r['maShort'] == 0),
        '★캔들 봉 수(1봉 = 게임 1일 · 900틱이면 6봉이 정답)': [r['bars'] for r in cand],
        '거래량 0건 조합': sum(1 for r in rows if r['volBars'] == 0),
        '★거래량 «보이는 막대» 비율 50% 미만 조합':
            sum(1 for r in rows if r['volBars'] > 0 and r['volVisible'] / r['volBars'] < 0.5),
        # ★막대 «개수»가 아니라 «격자»로 본다 — 거래 0인 칸은 «안 그리는» 것이 정상이다
        '★캔들: 거래량 격자 ≠ 봉 수': sum(1 for r in cand if r.get('volGrid') != r['bars']),
        '캔들: 거래량 막대 수 > 봉 수(있으면 결함)': sum(1 for r in cand if r['volBars'] > r['bars']),
        '★MA 꼭짓점 2 이하(선이 아닌 조각)': sum(1 for r in rows if 0 < r['maLongVerts'] <= 2 or 0 < r['maShortVerts'] <= 2),
    }
    rep['summary'] = summary
    print('\n요약 (new 빌드)')
    for k, v in summary.items():
        print(f'  {k}: {v}')

    # ★요약의 «결함 항목»을 실패로 승격한다 — 표만 찍고 0 을 반환하면 게이트가 아니다
    for key, v in summary.items():
        if key.startswith('★캔들: 이평선이') or key.startswith('★라인: 이평선이'):
            if v:
                fails.append(f'{key} = {v}')

    rep['fail'] = fails
    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"\n스크린샷 {len(rep['shots'])}장 · 조합 {len(rows)} · pageerror {'있음' if fails else '0'}")
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
