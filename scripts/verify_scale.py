# -*- coding: utf-8 -*-
"""
□C 참가자 1,000 → 3,310명 «자릿수·레이아웃» 실렌더 검증 — ★headless 전용.

  python scripts/verify_scale.py <출력폴더>

★★핵심 장치: `ml.firstSeen` 을 «30일 전»으로 심는다.
  roster.ts 의 elapsedDays() 가 그 키만 보므로, 명부가 ★3,310명(1,000 + 77×30)이 된
  상태를 «오늘» 재현할 수 있다. 30일을 기다리지 않고 4자리 순위를 실제로 그린다.
  ⇒ 「나중에 문제가 될 것이다」가 아니라 ★「지금 화면에 이렇게 나온다」로 판정한다.
"""
import http.server
import json
import re
import socket
import socketserver
import sys
import threading
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


def init_js(lang, theme, days_ago):
    nick = '리미' if lang == 'ko' else 'Rimi'
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        f"localStorage.setItem('ml.session', JSON.stringify({{userId:'local',token:'',nickname:'{nick}'}}));"
        f"localStorage.setItem('ml.settings', JSON.stringify({{lang:'{lang}',theme:'{theme}',updown:'kr'}}));"
        # ★roster.ts FIRST_SEEN_KEY. 형식은 firstSeenDayKey() 가 만드는 KST 날짜키와 같아야 한다.
        f"const d = new Date(Date.now() + 9*3600e3 - {days_ago}*86400e3);"
        "const k = d.toISOString().slice(0,10);"
        "localStorage.setItem('ml.firstSeen', k);"
        "})()"
    )


# 텍스트에서 「N위」/「#N」 을 뽑아 «가장 큰 순위»를 본다
RANK_KO = re.compile(r'([\d,]+)\s*위')
RANK_EN = re.compile(r'#([\d,]+)')


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_scale')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'shots': [], 'overflow': [], 'ranks': {}, 'console': [], 'pageerror': [], 'positive': []}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            def run(name, lang, theme, route, days_ago, scroll=0):
                ctx = browser.new_context(viewport=VIEW, device_scale_factor=2,
                                          locale='ko-KR' if lang == 'ko' else 'en-US')
                ctx.add_init_script(init_js(lang, theme, days_ago))
                p = ctx.new_page()
                errs, perrs = [], []
                p.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
                p.on('pageerror', lambda e: perrs.append(str(e)))
                p.goto(f'{base}?seed=7{route}', wait_until='domcontentloaded')
                p.wait_for_selector('.screen', timeout=25000)
                p.wait_for_timeout(3000)
                if scroll:
                    p.wait_for_selector('.scroll', timeout=15000)
                    p.eval_on_selector('.scroll', f'e => e.scrollTop = {scroll}')
                    p.wait_for_timeout(400)
                p.screenshot(path=str(out / f'{name}.png'))
                rep['shots'].append(name)

                # ── ★«줄바꿈·넘침» 을 구조로 잡는다 (눈으로만 보지 않는다) ──
                over = p.evaluate(
                    """() => {
                        const bad = [];
                        for (const el of document.querySelectorAll('*')) {
                            if (el.children.length) continue;
                            const tx = (el.textContent || '').trim();
                            if (!tx) continue;
                            const cs = getComputedStyle(el);
                            // ① 가로 넘침
                            if (el.scrollWidth - el.clientWidth > 1 && cs.overflow !== 'hidden' && cs.textOverflow !== 'ellipsis') {
                                bad.push(['overflowX', tx.slice(0, 40), el.className, el.scrollWidth, el.clientWidth]);
                            }
                            /*
                             * ② ★«실제로 몇 줄에 그려졌는가»를 Range 로 잰다.
                             *   ⛔처음엔 clientHeight > lineHeight*1.6 으로 짰다가 ★630건이 전부
                             *     «가운데 정렬된 고정 높이 박스»(아바타·타일·배지) 오탐이었다.
                             *     박스 높이는 «글자가 몇 줄인지»와 아무 상관이 없다.
                             *   ⇒ Range.getClientRects() 는 글자가 «접힌 줄 수»를 그대로 준다.
                             *     공백이 없는 짧은 라벨(순위·수치)이 2줄이면 그건 «깨진 것»이다.
                             */
                            if (tx.length <= 14 && !/\\s/.test(tx)) {
                                const r = document.createRange();
                                r.selectNodeContents(el);
                                /*
                                 * ★rect «개수»로 세면 안 된다 — text-overflow: ellipsis 가 걸린 줄은
                                 *   보이는 부분/잘린 부분이 갈려 ★한 줄인데도 rect 가 2개로 나온다.
                                 *   (실제로 이 오탐 때문에 「고쳤는데 그대로」로 보였다)
                                 * ⇒ ★«서로 다른 top»의 개수 = 진짜 줄 수다.
                                 */
                                const tops = new Set([...r.getClientRects()].map(x => Math.round(x.top)));
                                if (tops.size > 1) bad.push(['wrapped', tx.slice(0, 40), el.className, tops.size, cs.whiteSpace]);
                            }
                        }
                        return bad;
                    }"""
                )
                for b in over:
                    rep['overflow'].append([name] + b)

                txts = p.eval_on_selector_all(
                    'body *',
                    "els => els.filter(e => !e.children.length).map(e => (e.textContent||'').trim()).filter(Boolean)")
                mx = 0
                for tx in txts:
                    for m in (RANK_KO if lang == 'ko' else RANK_EN).finditer(tx):
                        try:
                            mx = max(mx, int(m.group(1).replace(',', '')))
                        except ValueError:
                            pass
                rep['ranks'][name] = mx
                rep['console'] += [[name, e] for e in errs]
                rep['pageerror'] += [[name, e] for e in perrs]
                ctx.close()

            # ── 양성대조: 넘침 탐지기가 «살아 있는지» 먼저 증명 ──────────
            ctx = browser.new_context(viewport=VIEW)
            ctx.add_init_script(init_js('ko', 'light', 30))
            p0 = ctx.new_page()
            p0.goto(base + '#/home', wait_until='domcontentloaded')
            p0.wait_for_selector('.screen', timeout=25000)
            p0.evaluate(
                """() => {
                    const d = document.createElement('div');
                    d.id = 'needle-overflow';
                    d.style.cssText = 'width:20px;font-size:15px;line-height:18px';
                    d.textContent = '99999999위';
                    document.body.appendChild(d);
                }"""
            )
            caught = p0.evaluate(
                """() => {
                    const el = document.getElementById('needle-overflow');
                    const r = document.createRange();
                    r.selectNodeContents(el);
                    return r.getClientRects().length > 1;
                }"""
            )
            rep['positive'].append(['넘침/줄바꿈 탐지기', bool(caught)])
            ctx.close()
            if not caught:
                print('FAILED: 넘침 탐지기 양성대조 실패 — 이 실행의 「0건」은 무효다')
                return 1
            print('양성대조 1/1 CAUGHT (넘침·줄바꿈 탐지기)')

            for lang in ('ko', 'en'):
                for theme in ('light', 'dark'):
                    run(f'S_home_{lang}_{theme}', lang, theme, '#/home', 30)
                    run(f'S_rank_{lang}_{theme}', lang, theme, '#/rank', 30)
            run('S_home_ko_scrolled', 'ko', 'light', '#/home', 30, scroll=1250)
            run('S_rank_ko_scrolled', 'ko', 'light', '#/rank', 30, scroll=900)
            run('S_onboard_ko', 'ko', 'light', '#/onboarding', 30)
            run('S_onboard_en', 'en', 'light', '#/onboarding', 30)
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n샷 {len(rep['shots'])}장 · 최대 순위 표기: {rep['ranks']}")
    print(f"console {len(rep['console'])} · pageerror {len(rep['pageerror'])} · 넘침/줄바꿈 {len(rep['overflow'])}")
    for row in rep['overflow'][:25]:
        print('  OVERFLOW', row)
    for row in rep['console'][:8]:
        print('  CONSOLE ', row)
    return 0


if __name__ == '__main__':
    sys.exit(main())
