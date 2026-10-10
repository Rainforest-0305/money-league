# -*- coding: utf-8 -*-
"""
실렌더 검증 하네스 — ★headless 전용. ⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_render.py <출력폴더>

★★이 스크립트가 «먼저» 하는 일 = 자기 검사기들의 양성대조다.
  「0건」을 말하기 전에 ①콘솔 에러 레코더 ②pageerror 레코더 ③raw 키 누출 스캐너
  ④blur 스캐너 가 «실제로 잡는지»를 니들로 증명한다. 하나라도 못 잡으면 즉시 실패한다.
  (근거: 오늘 이 조직에서 「0건」이 부재의 증거가 아니었던 사례가 여러 건 나왔다)
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
import os as _os

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
# ★검증 대상 폴더를 «바꿀 수 있게» 한다 — `ait:build` 후에는 dist/ 가 RN 번들로 바뀌므로
#   ★«아티팩트에서 꺼낸 web/»(_ait_web) 을 검증해야 «출하물»을 검증한 것이 된다.
DIST = ROOT / _os.environ.get('ML_DIST', 'dist')

VIEW = {'width': 390, 'height': 844}

# raw i18n 키가 화면에 새면 이런 모양이다: home.macroNow · traders.concept.x.name
RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
# 실제 문장에 섞일 수 있는 «점 표기»를 걸러낸다(파일명·소수점·도메인)
RAW_KEY_ALLOW = re.compile(r'\d|\.(com|io|co|kr|js|css|png|json)$')


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


PRIME = """
() => {
  localStorage.setItem('ml.onboarded', '1');
  localStorage.setItem('ml.session', JSON.stringify({ userId: 'local', token: '', nickname: '리미' }));
}
"""


class Rec:
    """콘솔 error / pageerror 레코더"""

    def __init__(self):
        self.console = []
        self.pageerr = []

    def attach(self, page):
        page.on('console', lambda m: self.console.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: self.pageerr.append(str(e)))

    def reset(self):
        self.console.clear()
        self.pageerr.clear()


def scan_raw_keys(page):
    """화면에 그려진 «보이는» 텍스트에서 raw i18n 키 후보를 찾는다"""
    texts = page.eval_on_selector_all(
        'body *',
        """els => els
            .filter(e => e.children.length === 0)
            .filter(e => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName))
            .map(e => (e.textContent || '').trim())
            .filter(Boolean)""",
    )
    hits = []
    for tx in texts:
        for m in RAW_KEY_RE.finditer(' ' + tx + ' '):
            k = m.group(1)
            if RAW_KEY_ALLOW.search(k):
                continue
            hits.append((k, tx[:60]))
    return hits


def scan_blur(page):
    """★계산된 스타일»에서 blur/backdrop-filter 를 센다 — CSS 파일 grep 보다 강하다"""
    return page.evaluate(
        """() => {
            const out = [];
            for (const el of document.querySelectorAll('*')) {
                const cs = getComputedStyle(el);
                const f = cs.filter || '';
                const b = cs.backdropFilter || cs.webkitBackdropFilter || '';
                if (f.includes('blur') || (b && b !== 'none')) {
                    out.push(el.tagName + '.' + (el.className || '') + ' filter=' + f + ' backdrop=' + b);
                }
            }
            return out;
        }"""
    )


def positive_controls(page, rec):
    """★검사기 4종에 니들을 주입해 «잡히는지» 먼저 증명한다"""
    results = []

    # ① 콘솔 error 레코더
    rec.reset()
    page.evaluate("() => console.error('NEEDLE_CONSOLE_ERROR')")
    page.wait_for_timeout(120)
    results.append(('① console.error 레코더', any('NEEDLE_CONSOLE_ERROR' in c for c in rec.console)))

    # ② pageerror 레코더
    rec.reset()
    page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE_ERROR'); }, 0)")
    page.wait_for_timeout(200)
    results.append(('② pageerror 레코더', any('NEEDLE_PAGE_ERROR' in e for e in rec.pageerr)))

    # ③ raw 키 누출 스캐너
    page.evaluate(
        """() => {
            const d = document.createElement('div');
            d.id = 'needle-rawkey';
            d.textContent = 'traders.concept.needle.name';
            document.body.appendChild(d);
        }"""
    )
    hits = scan_raw_keys(page)
    caught3 = any(k.startswith('traders.concept.needle') for k, _ in hits)
    page.evaluate("() => document.getElementById('needle-rawkey')?.remove()")
    results.append(('③ raw 키 누출 스캐너', caught3))

    # ④ blur 스캐너
    page.evaluate(
        """() => {
            const d = document.createElement('div');
            d.id = 'needle-blur';
            d.style.backdropFilter = 'blur(4px)';
            d.style.filter = 'blur(2px)';
            document.body.appendChild(d);
        }"""
    )
    caught4 = len(scan_blur(page)) > 0
    page.evaluate("() => document.getElementById('needle-blur')?.remove()")
    results.append(('④ blur 스캐너', caught4))

    rec.reset()
    return results


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_render')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    report = {'positiveControls': [], 'seeds': {}, 'shots': [], 'console': [], 'pageerror': [], 'rawKeys': [], 'blur': []}

    with sync_playwright() as pw:
        # ⛔headless 고정. devtools/slowMo 없음.
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(f'({PRIME})()')
            page = ctx.new_page()
            rec = Rec()
            rec.attach(page)

            page.goto(base + '#/home', wait_until='networkidle')
            page.wait_for_selector('.screen', timeout=20000)
            page.wait_for_timeout(2500)  # 워밍업 청크

            # ── 0) 양성대조 ──────────────────────────────────────────────
            report['positiveControls'] = [(n, bool(c)) for n, c in positive_controls(page, rec)]
            if not all(c for _, c in report['positiveControls']):
                print(json.dumps(report, ensure_ascii=False, indent=1))
                print('FAILED: 검사기 니들을 놓쳤다. 이 실행의 「0건」은 무효다.')
                return 1
            print('양성대조 4/4 CAUGHT')

            # ── 1) 시드 스윕: 거시 이벤트가 «진행 중»인 시드를 찾는다 ────
            found = {}
            for seed in range(1, 61):
                page.goto(f'{base}?seed={seed}#/home', wait_until='domcontentloaded')
                try:
                    page.wait_for_selector('.screen', timeout=15000)
                except Exception:
                    continue
                page.wait_for_timeout(1600)
                info = page.evaluate(
                    """() => {
                        const el = document.querySelector('.macro');
                        if (!el) return null;
                        return {
                            tone: [...el.classList].find(c => c.startsWith('macro--')),
                            title: el.querySelector('.macro__title')?.textContent,
                            remain: el.querySelector('.macro__remain')?.textContent,
                            chips: [...el.querySelectorAll('.macro__chip')].map(c => c.textContent),
                            label: el.querySelector('.macro__label')?.textContent,
                        };
                    }"""
                )
                if info:
                    report['seeds'][seed] = info
                    if info['tone'] not in found:
                        found[info['tone']] = seed
                if len(found) == 3:
                    break
            print('시드 스윕 — 이벤트 확인 시드', list(report['seeds'].keys())[:12], '· 종류별', found)

            if not found:
                print('FAILED: 60 시드 안에서 진행 중인 거시 이벤트를 한 번도 못 잡았다')
                return 1

            # ── 2) 종류 × 로케일 × 테마 실렌더 ──────────────────────────
            def shoot(name, seed, lang, theme, route='#/home', pre=None, scroll=0):
                ctx2 = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR' if lang == 'ko' else 'en-US')
                nick = '리미' if lang == 'ko' else 'Rimi'
                # ★★화살표 함수를 «그냥 넘기면 실행되지 않는다» — 반드시 감싸서 «호출»한다.
                #   이걸 빠뜨렸다가 12장을 «온보딩 화면»으로 찍었다. 파일 개수만 보면 성공처럼 보였다.
                #   ⇒ 그래서 아래 boot 게이트를 넣었다: 홈에 도달했는지 «구조»로 확인한다.
                ctx2.add_init_script(
                    "(() => {"
                    "localStorage.setItem('ml.onboarded','1');"
                    f"localStorage.setItem('ml.session', JSON.stringify({{userId:'local',token:'',nickname:'{nick}'}}));"
                    f"localStorage.setItem('ml.settings', JSON.stringify({{lang:'{lang}',theme:'{theme}',updown:'kr'}}));"
                    "})()"
                )
                p2 = ctx2.new_page()
                r2 = Rec()
                r2.attach(p2)
                p2.goto(f'{base}?seed={seed}{route}', wait_until='domcontentloaded')
                p2.wait_for_selector('.screen', timeout=20000)
                p2.wait_for_timeout(2000)
                """
                ★★부팅 게이트 — 「샷을 찍었다」와 「그 화면을 찍었다」는 다르다.
                  init script 를 «호출»하지 않아 12장을 전부 온보딩 화면으로 찍은 사고가 있었다.
                  파일 개수·용량만 보면 성공처럼 보였다. ⇒ 구조로 확인한다.
                """
                # 상세 화면(종목·트레이더)은 «푸시된» 화면이라 탭바가 없는 게 정상이다.
                needs_tabbar = '/stock/' not in route and '/trader/' not in route
                if needs_tabbar and not p2.query_selector('.tabbar'):
                    raise RuntimeError(f'{name}: 탭바가 없다 = 앱 본화면에 도달하지 못했다(온보딩/부팅 화면일 가능성)')
                if not needs_tabbar and not p2.query_selector('.appbar'):
                    raise RuntimeError(f'{name}: 앱바가 없다 = 상세 화면에 도달하지 못했다')
                got_theme = p2.evaluate("() => document.documentElement.getAttribute('data-theme')")
                if got_theme != theme:
                    raise RuntimeError(f'{name}: data-theme={got_theme!r} 인데 {theme!r} 를 기대했다')
                if pre:
                    pre(p2)
                    p2.wait_for_timeout(900)
                if scroll:
                    # ★스크롤 컨테이너가 «없으면» 조용히 넘어가지 않는다 — 그건 화면 구조가
                    #   달라졌다는 뜻이고, 그 상태의 스크롤 샷은 «검증이 아니다».
                    p2.wait_for_selector('.scroll', timeout=15000)
                    p2.eval_on_selector('.scroll', f'e => e.scrollTop = {scroll}')
                    p2.wait_for_timeout(350)
                    top = p2.eval_on_selector('.scroll', 'e => e.scrollTop')
                    if top < scroll * 0.5:
                        report.setdefault('scrollShort', []).append([name, top, scroll])
                p2.screenshot(path=str(out / f'{name}.png'))
                report['shots'].append(name)
                for k, tx in scan_raw_keys(p2):
                    report['rawKeys'].append([name, k, tx])
                for b in scan_blur(p2):
                    report['blur'].append([name, b])
                report['console'] += [[name, c] for c in r2.console]
                report['pageerror'] += [[name, e] for e in r2.pageerr]
                ctx2.close()

            for tone, seed in found.items():
                short = tone.replace('macro--', '')
                for lang in ('ko', 'en'):
                    for theme in ('light', 'dark'):
                        shoot(f'A_{short}_{lang}_{theme}', seed, lang, theme)

            any_seed = next(iter(found.values()))

            # 피드 안의 소식 행 (스크롤)
            shoot('B_feed_ko_light', any_seed, 'ko', 'light', scroll=1250)
            shoot('B_feed_en_dark', any_seed, 'en', 'dark', scroll=1250)

            # 업종 칩 -> 종목 탭 딥링크 «실제로 눌러본다»
            def click_chip(p2):
                chip = p2.query_selector('.macro__chip')
                if chip:
                    chip.click()

            shoot('C_sector_link_ko', any_seed, 'ko', 'light', pre=click_chip)
            shoot('C_sector_link_en', any_seed, 'en', 'dark', pre=click_chip)

            # 종목 화면 한 줄
            shoot('D_stock_ko_light', any_seed, 'ko', 'light', route='#/stock/NVDA')
            shoot('D_stock_en_dark', any_seed, 'en', 'dark', route='#/stock/NVDA')

            # 이벤트가 «없을 때» 홈이 멀쩡한지 (빈 껍데기 0)
            shoot('E_noevent_ko_light', 999999, 'ko', 'light')

        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n샷 {len(report['shots'])}장")
    print(f"console error {len(report['console'])} · pageerror {len(report['pageerror'])} "
          f"· rawKey {len(report['rawKeys'])} · blur {len(report['blur'])}")
    for row in report['console'][:10]:
        print('  CONSOLE', row)
    for row in report['pageerror'][:10]:
        print('  PAGEERR', row)
    for row in report['rawKeys'][:15]:
        print('  RAWKEY ', row)
    for row in report['blur'][:10]:
        print('  BLUR   ', row)
    bad = report['console'] or report['pageerror'] or report['rawKeys'] or report['blur']
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
