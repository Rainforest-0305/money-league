# -*- coding: utf-8 -*-
"""
광고 지면 실렌더 검증 — 「지면 ID 를 박은 뒤」 전용. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_adslots.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_adslots.py <출력폴더>   # ★출하물 검증

★★이 스크립트가 «왜» 따로 있나 (2026-08-21)
  `bannerJournal` · `bannerStockDetail` 두 지면이 「발급 대기」라 빈 문자열이었다.
  빈 값 동안은 `adSlotVisible()` 이 «아무것도 그리지 않아» 아래 것들을 «잴 수가 없었다»:
    · 한 화면에 같은 포맷(BANNER)이 2개가 되지 않는가   (정책 위반 = 광고 송출 정지)
    · 예약 높이(AD_RESERVED_H)와 실제 렌더 높이가 같은가 (CLS)
    · 일지: 배너가 들어가도 가상 스크롤 좌표가 안 어긋나는가
    · 종목 상세: 고정 주문바와 충분히 떨어져 있는가      (오탭 = (가상)돈이 나간다)
  ⇒ ID 가 박힌 «지금» 재는 것이 이 파일의 존재 이유다.

★★로컬에서 «진짜 토스 광고»는 뜨지 않는다 — 그게 정상이다.
  `bannerSupported()` 가 `isInToss()` 를 요구하고, SDK 는 토스 앱 안에서만 산다.
  ⛔운영 ID 로 로컬 실렌더를 시도하는 것은 계정 중단 사유다.
  ⇒ 여기서 재는 것은 ★«예약 상자»의 기하다(`sessionStorage['ads.preview']='1'`).
    실제 크리에이티브 높이는 ★[추정]이고 폰 실기기에서만 확정된다.

★★대조를 «먼저» 통과해야 결과를 낸다.
  이 프로젝트에서 죽은 검사기가 여러 건 나왔다. 「0건」/「1개」는 검사기가 살아
  있음을 증명한 «뒤»에만 의미가 있다.
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
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
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}

# ★기대값을 여기 박지 않는다 — 소스에서 «읽어» 온다.
#   (ait_header.py 가 stale 기대값으로 «맞는 빌드에 FAIL» 을 찍은 사고가 이 레포에 있다)
ADS_TS = (ROOT / 'src' / 'lib' / 'ads.ts').read_text(encoding='utf-8')


def reserved_h(slot: str) -> int:
    """`AD_RESERVED_H` 에서 슬롯 예약높이를 읽는다. 못 읽으면 «죽는다»(조용한 기본값 금지)."""
    for line in ADS_TS.splitlines():
        s = line.strip()
        if s.startswith(slot + ':') and s.rstrip(',').split(':')[1].strip().isdigit():
            return int(s.rstrip(',').split(':')[1].strip())
    raise SystemExit(f'[verify_adslots] AD_RESERVED_H 에서 {slot} 을 못 읽었다 — 검사 중단')


def box_extra_h() -> int:
    """`AD_BOX_EXTRA_H` — 라벨+gap 이 호스트 «위에» 더 쓰는 높이. 소스에서 읽는다."""
    for line in ADS_TS.splitlines():
        s = line.strip()
        if s.startswith('export const AD_BOX_EXTRA_H'):
            return int(s.split('=')[1].split(';')[0].strip())
    raise SystemExit('[verify_adslots] AD_BOX_EXTRA_H 를 못 읽었다 — 검사 중단')


def placement_id(slot: str) -> str:
    for line in ADS_TS.splitlines():
        s = line.strip()
        if s.startswith(slot + ':') and "'ait.v2.live." in s:
            return s.split("'")[1]
    return ''


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, *a):
        pass


def serve():
    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def seed_journal(n: int) -> str:
    """일지 n 건을 «저장본으로» 심는다.

    ⚠주문을 UI 로 넣는 경로는 `verify_journal.py` 가 이미 검증한다. 여기서 필요한 것은
      ★「배너가 들어갈 만큼 목록이 길 때」의 «레이아웃»뿐이라 저장본 주입이 옳다.
      (AD_AT=7 이므로 7건 이하면 배너가 목록 «끝»에 걸려 잴 것이 달라진다)
    """
    rows = []
    for i in range(n):
        rows.append(
            {
                'id': 'j%d' % (n - i),
                'at': 1700000000000 + i * 1000,
                'tick': 100 + i,
                'gameDay': 1 + i // 4,
                'product': 'spot' if i % 2 == 0 else 'leverage',
                'action': 'buy' if i % 3 else 'sell',
                'ticker': ['NVDA', 'MSFT', 'TSLA', 'AAPL'][i % 4],
                'fee': 1.25,
                'qty': 3,
                'price': 100 + i,
                'notional': 300 + i,
                'realized': (i - 5) * 12.5,
            }
        )
    return json.dumps(rows, ensure_ascii=False)


def init_js(theme='light', preview_ads=True, journal_n=20):
    """★반드시 «호출까지» 붙여서 돌려준다(정의만 하면 실행되지 않는다 — 실사고 이력)."""
    ads = "sessionStorage.setItem('ads.preview','1');" if preview_ads else ''
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        f"localStorage.setItem('ml.settings', JSON.stringify({{lang:'ko',theme:'{theme}',updown:'kr'}}));"
        f"localStorage.setItem('ml.journal', {json.dumps(seed_journal(journal_n))});"
        f"{ads}"
        "})()"
    )


# ── 측정기 (이 함수들이 «검사기»다 — 아래에서 니들로 먼저 증명한다) ──────────

COUNT_JS = "() => document.querySelectorAll('.adslot').length"

BOX_JS = """() => [...document.querySelectorAll('.adslot')].map(el => {
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), tag: !!el.querySelector('.adslot__tag') };
})"""

OVERLAP_JS = """async (sel) => {
    const sc = document.querySelector('.scroll') || document.querySelector('.vlist');
    if (!sc) return null;
    const bad = [];
    let steps = 0;
    for (let y = 0; y <= sc.scrollHeight; y += 300) {
        sc.scrollTop = y;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        steps++;
        const els = [...sc.querySelectorAll(sel)].map(e => e.getBoundingClientRect())
            .sort((a, b) => a.top - b.top);
        for (let i = 1; i < els.length; i++) {
            const gap = Math.round(els[i].top - els[i - 1].bottom);
            if (gap < -1) bad.push({ y, gap });
        }
    }
    sc.scrollTop = 0;
    return { steps, bad, scrollHeight: Math.round(sc.scrollHeight) };
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_adslots')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'

    rep = {'dist': str(DIST), 'checks': [], 'shots': [], 'measured': {}}
    fails = []

    def check(name, ok, detail=''):
        rep['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            fails.append(name)
        print(('  PASS  ' if ok else '  FAIL  ') + name + ('  ' + str(detail) if detail != '' else ''))

    # ★★기대값을 「예약 높이」로 잡으면 «맞는 빌드에 FAIL» 을 찍는다 [2026-08-21 실측].
    #   `AD_RESERVED_H` 는 `.adslot` 의 min-height 이고, 실제 상자는 라벨+gap 만큼 더 크다.
    #   (첫 판에 이 스크립트가 정확히 그 오판을 했다 — ait_header.py stale 기대값 사고와 같은 형태)
    EXTRA = box_extra_h()
    H_JOURNAL = reserved_h('bannerJournal') + EXTRA
    H_STOCK = reserved_h('bannerStockDetail') + EXTRA
    MARGIN_Y = 10  # 호출부가 AdBanner 에 주는 상하 여백(Journal/Stocks 둘 다 '10px 0')
    ID_JOURNAL = placement_id('bannerJournal')
    ID_STOCK = placement_id('bannerStockDetail')

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            # ── 0) ★지면 ID 가 «번들에 실제로 있는가» (소스 → 번들 대조) ──
            print('\n① 지면 ID — 소스와 출하 번들 대조')
            check('소스: bannerJournal ID 가 비어 있지 않다', ID_JOURNAL.startswith('ait.v2.live.'), ID_JOURNAL)
            check('소스: bannerStockDetail ID 가 비어 있지 않다', ID_STOCK.startswith('ait.v2.live.'), ID_STOCK)
            js_text = '\n'.join(
                p.read_text(encoding='utf-8', errors='ignore') for p in (DIST / 'assets').glob('*.js')
            )
            check('번들에 bannerJournal ID 가 들어갔다', ID_JOURNAL in js_text, ID_JOURNAL)
            check('번들에 bannerStockDetail ID 가 들어갔다', ID_STOCK in js_text, ID_STOCK)
            # ★음성대조 — 가짜 ID 는 «안» 잡혀야 한다(문자열 검색이 살아 있다는 증명)
            check('[음성대조] 가짜 지면 ID 는 번들에 «없다»', 'ait.v2.live.XXXXXXXXXXXXXXXX' not in js_text)

            # ── 1) ★대조 — 세는 검사기가 «살아 있는가» ────────────────
            print('\n② ★대조 (검사기 생존 증명) — 이걸 통과해야 아래 숫자가 의미가 있다')
            ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init_js(preview_ads=True))
            page = ctx.new_page()
            page.goto(base + '#/journal', wait_until='domcontentloaded')
            page.wait_for_selector('.jrow', timeout=25000)
            page.wait_for_timeout(1200)

            n0 = page.evaluate(COUNT_JS)
            page.evaluate(
                """() => {
                    const d = document.createElement('div');
                    d.className = 'adslot'; d.id = '__needle_ad';
                    document.body.appendChild(d);
                }"""
            )
            n1 = page.evaluate(COUNT_JS)
            check('①-a [양성] .adslot 을 하나 심으면 개수가 «늘어난다»', n1 == n0 + 1, f'{n0} -> {n1}')
            page.evaluate("() => document.getElementById('__needle_ad')?.remove()")
            n2 = page.evaluate(COUNT_JS)
            check('①-b [음성] 니들을 빼면 «원래 값»으로 돌아온다', n2 == n0, f'{n1} -> {n2}')

            # 높이 비교기 — 일부러 틀린 높이를 심어 «불일치»를 잡는지
            page.evaluate(
                """(h) => {
                    const d = document.createElement('div');
                    d.className = 'adslot'; d.id = '__needle_h';
                    d.style.height = (h + 40) + 'px';
                    document.body.appendChild(d);
                }""",
                H_JOURNAL,
            )
            boxes = page.evaluate(BOX_JS)
            check(
                '①-c [양성] 높이 비교기가 «틀린 높이»를 잡는다',
                any(b['h'] != H_JOURNAL for b in boxes),
                [b['h'] for b in boxes],
            )
            page.evaluate("() => document.getElementById('__needle_h')?.remove()")

            # 겹침 탐지기 — 일부러 겹치는 행을 심어 잡는지
            page.evaluate(
                """() => {
                    const sc = document.querySelector('.scroll');
                    const a = document.createElement('div'); a.className = '__nrow';
                    const b = document.createElement('div'); b.className = '__nrow';
                    a.style.cssText = 'position:absolute;top:0;height:60px;width:10px';
                    b.style.cssText = 'position:absolute;top:20px;height:60px;width:10px';
                    sc.appendChild(a); sc.appendChild(b);
                }"""
            )
            ov = page.evaluate(OVERLAP_JS, '.__nrow')
            check('①-d [양성] 겹침 탐지기가 «겹친 행»을 잡는다', ov and len(ov['bad']) > 0, ov and len(ov['bad']))
            page.evaluate("() => document.querySelectorAll('.__nrow').forEach(e => e.remove())")
            ctx.close()

            # ── 2) ⛔토스 «밖» — 아무것도 그리지 않아야 한다 ──────────
            #   V-2 ⛔6 「지면이 안 그려지는데 자리만 잡는」 형태로 되돌아가지 않았는지.
            #   ★ID 를 박았다고 토스 밖에서 «그려지지» 않는다 — bannerSupported() 가 막는다.
            print('\n③ ⛔토스 «밖»(itch.io·GitHub Pages·로컬) — 빈 구멍이 남지 않는가')
            cOff = browser.new_context(viewport=VIEW, locale='ko-KR')
            cOff.add_init_script(init_js(preview_ads=False))
            pOff = cOff.new_page()
            for route, sel in (('#/journal', '.jrow'), ('#/stock/NVDA', '.orderbar')):
                pOff.goto(base + route, wait_until='domcontentloaded')
                pOff.wait_for_selector(sel, timeout=25000)
                pOff.wait_for_timeout(1200)
                n = pOff.evaluate(COUNT_JS)
                check(f'{route}: 미지원 환경에서 광고 상자 0개', n == 0, f'{n}개')
                gapinfo = pOff.evaluate(
                    """async () => {
                        const sc = document.querySelector('.scroll');
                        if (!sc) return null;
                        sc.scrollTop = 0;
                        await new Promise(r => requestAnimationFrame(r));
                        return Math.round(sc.scrollHeight);
                    }"""
                )
                rep['measured'][f'noPreview{route}'] = {'adslots': n, 'scrollHeight': gapinfo}
            pOff.screenshot(path=str(out / 'N1_journal_no_toss.png'), full_page=True)
            rep['shots'].append('N1_journal_no_toss')
            cOff.close()

            # ── 3) 예약 상자 실렌더 — 개수 · 높이 · 좌표 ───────────────
            print('\n④ 예약 상자 실렌더 (ads.preview=1)')
            for theme in ('light', 'dark'):
                c = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                c.add_init_script(init_js(theme=theme, preview_ads=True))
                pg = c.new_page()

                # ── 거래 일지 ──────────────────────────────────────
                pg.goto(base + '#/journal', wait_until='domcontentloaded')
                pg.wait_for_selector('.jrow', timeout=25000)
                pg.wait_for_timeout(1200)
                n = pg.evaluate(COUNT_JS)
                check(f'[{theme}] 거래일지: 배너가 «그려진다»', n >= 1, f'{n}개')
                # ⛔정책: 「동일 화면에 동일 포맷 광고 2개 이상」 금지. 이 화면의 지면은 BANNER 뿐이다.
                check(f'[{theme}] 거래일지: 한 화면에 BANNER «1개»', n == 1, f'{n}개')
                boxes = pg.evaluate(BOX_JS)
                rep['measured'][f'journal_{theme}'] = boxes
                if boxes:
                    check(
                        f'[{theme}] 거래일지 CLS: 상자 렌더 높이 == 예약({H_JOURNAL - EXTRA})+크롬({EXTRA})',
                        boxes[0]['h'] == H_JOURNAL,
                        f"실측 {boxes[0]['h']}px",
                    )
                    check(f'[{theme}] 거래일지: 「광고」 라벨이 붙어 있다(네이티브 위장 금지)', boxes[0]['tag'], boxes[0]['tag'])
                # ── ★가상 스크롤 좌표: `insertHeight` 가 «실제 점유»와 같은가 ──
                #   ⛔이게 어긋나도 «에러가 안 난다». 삽입 지점 뒤 행들이 조용히 밀릴 뿐이고,
                #     삽입 개수만큼 오차가 곱해진다. ⇒ 눈이 아니라 «숫자»로 잡는다.
                #   재는 법: 행 간격의 «최빈값»(정상)과 «삽입 지점»(정상+블록)의 차.
                deltas = pg.evaluate(
                    """() => {
                        const rows = [...document.querySelectorAll('.jrow')].map(e => e.getBoundingClientRect());
                        const d = [];
                        for (let i = 1; i < rows.length; i++) d.push(Math.round(rows[i].top - rows[i - 1].top));
                        return d;
                    }"""
                )
                rep['measured'][f'journalRowDeltas_{theme}'] = deltas
                if deltas:
                    normal = max(set(deltas), key=deltas.count)
                    jumps = [d for d in deltas if d != normal]
                    occupied = (jumps[0] - normal) if len(jumps) == 1 else None
                    expected = H_JOURNAL + MARGIN_Y * 2  # 상자 + 상하 여백
                    rep['measured'][f'journalInsert_{theme}'] = {
                        'normalRowDelta': normal,
                        'jumps': jumps,
                        'occupiedByAd': occupied,
                        'expected': expected,
                    }
                    check(
                        f'[{theme}] ★일지: 삽입 지점이 «정확히 1곳»이다(insertMax=1)',
                        len(jumps) == 1,
                        jumps,
                    )
                    check(
                        f'[{theme}] ★일지: insertHeight 가 실제 점유({expected}px)와 «같다»',
                        occupied == expected,
                        f'실측 {occupied}px · 기대 {expected}px',
                    )

                jov = pg.evaluate(OVERLAP_JS, '.jrow')
                rep['measured'][f'journalScroll_{theme}'] = jov
                check(f'[{theme}] 거래일지: 전 구간 스크롤 행 겹침 0(가상스크롤 좌표)', jov and len(jov['bad']) == 0, jov and jov['bad'][:3])
                pg.screenshot(path=str(out / f'A1_journal_{theme}.png'), full_page=True)
                rep['shots'].append(f'A1_journal_{theme}')

                # 배너가 «목록 한가운데»인지 (첫 화면 밖 · 목록 끝이 아님)
                jgeo = pg.evaluate(
                    """() => {
                        const ad = document.querySelector('.adslot');
                        const rows = [...document.querySelectorAll('.jrow')];
                        const sc = document.querySelector('.scroll');
                        if (!ad || !rows.length || !sc) return null;
                        const a = ad.getBoundingClientRect();
                        const above = rows.filter(r => r.getBoundingClientRect().bottom <= a.top + 1).length;
                        const below = rows.filter(r => r.getBoundingClientRect().top >= a.bottom - 1).length;
                        return { adTop: Math.round(a.top + sc.scrollTop), above, below, rows: rows.length };
                    }"""
                )
                rep['measured'][f'journalGeo_{theme}'] = jgeo
                check(f'[{theme}] 거래일지: 배너 «아래»에도 목록이 남아 있다(끝에 붙지 않음)', bool(jgeo) and jgeo['below'] >= 1, jgeo)

                # ── 종목 상세 ──────────────────────────────────────
                pg.goto(base + '#/stock/NVDA', wait_until='domcontentloaded')
                pg.wait_for_selector('.orderbar', timeout=25000)
                pg.wait_for_timeout(1800)
                n = pg.evaluate(COUNT_JS)
                check(f'[{theme}] 종목 상세: 배너가 «그려진다»', n >= 1, f'{n}개')
                check(f'[{theme}] 종목 상세: 한 화면에 BANNER «1개»', n == 1, f'{n}개')
                boxes = pg.evaluate(BOX_JS)
                rep['measured'][f'stock_{theme}'] = boxes
                if boxes:
                    check(
                        f'[{theme}] 종목 상세 CLS: 상자 렌더 높이 == 예약({H_STOCK - EXTRA})+크롬({EXTRA})',
                        boxes[0]['h'] == H_STOCK,
                        f"실측 {boxes[0]['h']}px",
                    )
                    check(f'[{theme}] 종목 상세: 「광고」 라벨이 붙어 있다', boxes[0]['tag'], boxes[0]['tag'])

                sd = pg.evaluate(
                    """async () => {
                        const ad = document.querySelector('.adslot');
                        const bar = document.querySelector('.orderbar');
                        const sc = document.querySelector('.scroll');
                        if (!ad || !bar || !sc) return null;
                        sc.scrollTop = 0;
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const first = Math.round(ad.getBoundingClientRect().top);
                        // ★「끝까지 내렸을 때」가 최악이다 — 그때 주문바와 가장 가까워진다
                        sc.scrollTop = sc.scrollHeight;
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const a = ad.getBoundingClientRect(), b = bar.getBoundingClientRect();
                        /* ⛔「스크롤 도중 최소거리」는 «재면 안 되는» 지표다 [2026-08-21 정정].
                           .orderbar 는 오버레이가 아니라 .scroll 의 «형제»(flex 0 0 auto)라,
                           스크롤 영역이 주문바 «위»에서 끝나고 내용은 거기서 잘린다.
                           그래서 광고 rect 의 bottom 은 «보이지 않는» 좌표까지 뻗고,
                           그걸 빼면 −210px 같은 «허수»가 나온다(첫 판에 실제로 그렇게 나왔다).
                           ⇒ 정책이 금지하는 것은 «배치»다: 광고를 CTA 옆에 두지 말라는 것이지
                             「스크롤하면 CTA 근처를 지나간다」가 아니다(그건 모든 콘텐츠가 그렇다).
                           ⇒ 그래서 «구조»를 잰다 — 광고 «뒤에» 콘텐츠가 얼마나 남는가. */
                        const scRect = sc.getBoundingClientRect();
                        const adBottomInContent = Math.round(a.bottom - scRect.top + sc.scrollTop);
                        return {
                            firstScreenTop: first,
                            vh: window.innerHeight,
                            barTop: Math.round(b.top),
                            scrollBottom: Math.round(scRect.bottom),
                            adBottomAtEnd: Math.round(a.bottom),
                            gapAtEnd: Math.round(b.top - a.bottom),
                            contentAfterAd: Math.round(sc.scrollHeight - adBottomInContent),
                            scrollHeight: Math.round(sc.scrollHeight),
                        };
                    }"""
                )
                rep['measured'][f'stockGeo_{theme}'] = sd
                check(f'[{theme}] 종목 상세: 배너가 «첫 화면 밖»(top ≥ 710)', bool(sd) and sd['firstScreenTop'] >= 710, sd and sd['firstScreenTop'])
                check(f'[{theme}] 종목 상세: 끝까지 내려도 주문바와 ≥ 100px', bool(sd) and sd['gapAtEnd'] >= 100, sd and f"{sd['gapAtEnd']}px")
                # ★배너가 «마지막 요소»가 아니라는 구조 보증.
                #   ⚠기준선은 «내가 지어내지» 않는다 — 이 레포가 이미 쓰는 100px 이다
                #     (verify_journal.py 의 파생 탭·종목 상세 검사와 같은 값).
                #     첫 판에 「한 화면(844px) 이상」이라는 ★내가 만든 기준으로 FAIL 을 찍었다.
                check(
                    f'[{theme}] ★종목 상세: 배너 «뒤»에 콘텐츠가 ≥ 100px 남는다(마지막 요소가 아니다)',
                    bool(sd) and sd['contentAfterAd'] >= 100,
                    sd and f"{sd['contentAfterAd']}px",
                )
                # ★교차검증 — 「콘텐츠 좌표로 잰 값」과 「끝까지 내렸을 때의 화면 거리」는
                #   같은 것을 두 좌표계에서 잰 것이라 일치해야 한다. 어긋나면 둘 중 하나가 틀렸다.
                check(
                    f'[{theme}] ★두 좌표계가 일치한다(contentAfterAd ≈ gapAtEnd)',
                    bool(sd) and abs(sd['contentAfterAd'] - sd['gapAtEnd']) <= 4,
                    sd and f"{sd['contentAfterAd']} vs {sd['gapAtEnd']}",
                )
                # ★.orderbar 가 오버레이가 «아님»을 확인 — 위 판정의 전제다
                check(
                    f'[{theme}] 전제: 주문바는 오버레이가 아니라 스크롤 영역 «아래»에 있다',
                    bool(sd) and abs(sd['scrollBottom'] - sd['barTop']) <= 1,
                    sd and f"scrollBottom={sd['scrollBottom']} barTop={sd['barTop']}",
                )
                pg.screenshot(path=str(out / f'A2_stock_{theme}.png'), full_page=True)
                rep['shots'].append(f'A2_stock_{theme}')
                c.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"\n스크린샷 {len(rep['shots'])}장 · 검사 {len(rep['checks'])}건 · 실패 {len(fails)}건 -> {out}")
    if fails:
        for f in fails:
            print('  FAILED: ' + f)
        sys.exit(1)


if __name__ == '__main__':
    main()
