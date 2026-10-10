# -*- coding: utf-8 -*-
"""
파생 4종 «실동작» 검증 — ★headless 전용. ⛔창을 띄우지 않는다.

  python scripts/verify_deriv.py <출력폴더>

★★「스크린샷을 찍었다」는 검증이 아니다. 이 스크립트는 ★«실제로 누른다»:
  칩 4개 · 새 계약 · 종목 선택 · 제안 카드 · 확정 · ★되돌리기.
  그리고 «누른 결과»를 구조로 확인한다(현금 복원 · 토스트 · 호가 결정성 · 재추첨 버튼 부재).

★검사기 양성대조를 «먼저» 통과시킨다. 통과 못 하면 이 실행의 「0건」은 무효다.
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

RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
RAW_KEY_ALLOW = re.compile(r'\d|\.(com|io|co|kr|js|css|png|json)$')
MONEY_RE = re.compile(r'-?\$([\d,]+(?:\.\d+)?)')


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


def init_js(lang, theme):
    nick = '리미' if lang == 'ko' else 'Rimi'
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        f"localStorage.setItem('ml.session', JSON.stringify({{userId:'local',token:'',nickname:'{nick}'}}));"
        f"localStorage.setItem('ml.settings', JSON.stringify({{lang:'{lang}',theme:'{theme}',updown:'kr'}}));"
        "})()"
    )


def scan_raw_keys(page):
    texts = page.eval_on_selector_all(
        'body *',
        """els => els
            .filter(e => e.children.length === 0)
            .filter(e => !['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))
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
    return page.evaluate(
        """() => {
            const out = [];
            for (const el of document.querySelectorAll('*')) {
                const cs = getComputedStyle(el);
                const b = cs.backdropFilter || cs.webkitBackdropFilter || '';
                if ((cs.filter||'').includes('blur') || (b && b !== 'none')) out.push(el.className);
            }
            return out;
        }"""
    )


def cash_of(page):
    """현금 표시를 «화면에서» 읽는다 — 스토어를 훔쳐보지 않고 유저가 보는 값으로 판정한다"""
    return page.evaluate(
        """() => {
            const rows = [...document.querySelectorAll('.kv')];
            for (const r of rows) {
                const v = r.querySelector('.kv__v');
                if (v && /\\$/.test(v.textContent || '')) return v.textContent.trim();
            }
            return null;
        }"""
    )


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_deriv')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'positive': [], 'shots': [], 'clicks': [], 'checks': [], 'console': [], 'pageerror': [], 'rawKeys': [], 'blur': [], 'fail': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), detail])
        if not ok:
            rep['fail'].append([name, detail])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(init_js('ko', 'light'))
            page = ctx.new_page()
            errs, perrs = [], []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: perrs.append(str(e)))

            page.goto(base + '#/derivatives', wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=25000)
            page.wait_for_timeout(3000)

            # ── 양성대조 ───────────────────────────────────────────────
            page.evaluate("() => console.error('NEEDLE_CONSOLE')")
            page.wait_for_timeout(120)
            c1 = any('NEEDLE_CONSOLE' in c for c in errs)
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)")
            page.wait_for_timeout(200)
            c2 = any('NEEDLE_PAGE' in e for e in perrs)
            page.evaluate("() => { const d=document.createElement('div'); d.id='nk'; d.textContent='derivatives.needle.key'; document.body.appendChild(d); }")
            c3 = any(k.startswith('derivatives.needle') for k, _ in scan_raw_keys(page))
            page.evaluate("() => document.getElementById('nk')?.remove()")
            page.evaluate("() => { const d=document.createElement('div'); d.id='nb'; d.style.backdropFilter='blur(4px)'; document.body.appendChild(d); }")
            c4 = len(scan_blur(page)) > 0
            page.evaluate("() => document.getElementById('nb')?.remove()")
            rep['positive'] = [['console', c1], ['pageerror', c2], ['rawKey', c3], ['blur', c4]]
            if not all(x[1] for x in rep['positive']):
                print('FAILED: 양성대조 실패 — 이 실행의 0건은 무효다', rep['positive'])
                return 1
            print('양성대조 4/4 CAUGHT')
            errs.clear()
            perrs.clear()

            # ── 칩 4개를 «실제로» 누른다 ────────────────────────────────
            chips = page.query_selector_all('.pillrow .pill')
            check('허브 칩 4개', len(chips) == 4, f'{len(chips)}개')
            names = []
            for i in range(len(chips)):
                c = page.query_selector_all('.pillrow .pill')[i]
                label = (c.text_content() or '').strip()
                names.append(label)
                c.click()
                page.wait_for_timeout(500)
                on = page.eval_on_selector_all('.pillrow .pill', 'els => els.map(e => e.className.includes("pill--on"))')
                check(f'칩 「{label}」 선택 반영', on[i] and sum(on) == 1, str(on))
                desc = page.eval_on_selector('.hint', 'e => (e.textContent||"").trim()')
                check(f'칩 「{label}」 설명 표시', bool(desc) and len(desc) > 8, desc[:40])
                page.screenshot(path=str(out / f'H_chip{i}_{label}.png'))
                rep['shots'].append(f'H_chip{i}_{label}')
            rep['clicks'].append(['chips', names])

            # ── 「새 계약」 → 종목 선택 → 주문폼 (4상품 전부) ──────────
            PRODUCT_IDX = {'선물': 0, '옵션': 1, '선도': 2, '스왑': 3}
            for label, idx in PRODUCT_IDX.items():
                page.goto(base + '#/derivatives', wait_until='domcontentloaded')
                page.wait_for_selector('.tabbar', timeout=20000)
                page.wait_for_timeout(1200)
                page.query_selector_all('.pillrow .pill')[idx].click()
                page.wait_for_timeout(300)
                cta = page.query_selector('.derivcta .btn')
                check(f'{label}: 새 계약 버튼 존재', cta is not None)
                if not cta:
                    continue
                cta.click()
                page.wait_for_timeout(500)
                sheet = page.query_selector('.sheet')
                check(f'{label}: 종목 선택 시트 열림', sheet is not None)
                if not sheet:
                    continue
                page.query_selector_all('.sheet .row')[0].click()
                page.wait_for_timeout(1600)
                url = page.evaluate('() => location.hash')
                check(f'{label}: 주문 화면 진입', '/leverage/' in url or '/option/' in url or '/contract/' in url, url)
                page.screenshot(path=str(out / f'O_{label}.png'))
                rep['shots'].append(f'O_{label}')
                for k, tx in scan_raw_keys(page):
                    rep['rawKeys'].append([f'O_{label}', k, tx])
                for b in scan_blur(page):
                    rep['blur'].append([f'O_{label}', b])

                # ⛔「다시 뽑기」 류 버튼이 «없어야» 한다 (차익거래 방지 ③)
                redraw = page.evaluate(
                    """() => [...document.querySelectorAll('button')]
                        .map(b => (b.textContent||'').trim())
                        .filter(t => /다시|재추첨|새로고침|refresh|reroll|redraw/i.test(t))"""
                )
                check(f'{label}: ⛔재추첨 버튼 없음', len(redraw) == 0, str(redraw))

                # 확정 버튼이 «실제로 눌리는» 상태인지
                cta2 = page.query_selector('.btn--lg')
                check(f'{label}: 확정 버튼 존재', cta2 is not None)
                if cta2:
                    if label == '스왑':
                        # ★스왑은 종목이 «둘»이다. 두 번째를 고르기 «전»에는 비활성이 «정상»이다.
                        #   ⇒ 그리고 고른 «뒤»에는 반드시 활성이 돼야 한다. 둘 다 확인한다.
                        check('스왑: 두 번째 종목 전에는 확정 «비활성»', cta2.is_disabled())
                        page.query_selector('.card.li').click()
                        page.wait_for_timeout(600)
                        page.query_selector_all('.sheet .row')[0].click()
                        page.wait_for_timeout(1600)
                        page.screenshot(path=str(out / 'O_스왑_2종목.png'))
                        rep['shots'].append('O_스왑_2종목')
                        q = page.query_selector_all('.qcard__nm')
                        check('스왑: 두 번째 종목 후 제안 3장', len(q) == 3, str(len(q)))
                        cta3 = page.query_selector('.btn--lg')
                        check('★스왑: 두 번째 종목 후 확정 «활성»', cta3 is not None and not cta3.is_disabled())
                    else:
                        check(f'{label}: 확정 버튼 활성', not cta2.is_disabled())

            # ── ★호가 «결정성» — 나갔다 돌아와도 같은 3장인가 ─────────
            def quote_names():
                return page.eval_on_selector_all('.qcard__nm', 'els => els.map(e => (e.textContent||"").trim())')

            page.goto(base + '#/contract/forward/NVDA', wait_until='domcontentloaded')
            page.wait_for_selector('.appbar', timeout=20000)
            page.wait_for_timeout(2200)
            q1 = quote_names()
            check('선도: 제안 3장', len(q1) == 3, str(q1))
            uniq = len(set(q1)) == len(q1)
            check('선도: 상대 «중복 없음»(비복원 추출)', uniq, str(q1))
            page.screenshot(path=str(out / 'Q_forward_quotes.png'))
            rep['shots'].append('Q_forward_quotes')
            # ★경로 A: «앱 안»에서 나갔다 돌아오기 (SPA 이동)
            page.evaluate("() => { location.hash = '#/home'; }")
            page.wait_for_timeout(1400)
            page.evaluate("() => { location.hash = '#/contract/forward/NVDA'; }")
            page.wait_for_selector('.qcard__nm', timeout=20000)
            page.wait_for_timeout(1200)
            qA = quote_names()
            check('★선도: 앱 안에서 나갔다 와도 «같은 3장»', q1 == qA, f'{q1} vs {qA}')
            # ★★경로 B: ★«전체 새로고침». 안 막으면 ★새로고침 버튼이 곧 재추첨 버튼이다
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.qcard__nm', timeout=30000)
            page.wait_for_timeout(2500)
            q2 = quote_names()
            check('★★선도: ★새로고침해도 «같은 3장»', q1 == q2, f'{q1} vs {q2}')
            # 방향을 바꾸면 «다른 묶음»이어야 정상이다(같은 계약이 아니다)
            page.query_selector_all('.seg button')[1].click()
            page.wait_for_timeout(900)
            q3 = quote_names()
            check('선도: 방향을 바꾸면 조건이 갱신됨', len(q3) == 3, str(q3))

            # ── ★주문 → 되돌리기 (선도) ────────────────────────────────
            page.goto(base + '#/contract/forward/NVDA', wait_until='domcontentloaded')
            page.wait_for_selector('.btn--lg', timeout=20000)
            page.wait_for_timeout(2000)
            cash_before = cash_of(page)
            page.query_selector('.btn--lg').click()
            page.wait_for_timeout(1500)
            toast = page.query_selector('.toast--act')
            check('선도: 체결 후 «되돌리기» 토스트', toast is not None)
            page.screenshot(path=str(out / 'U_forward_toast.png'))
            rep['shots'].append('U_forward_toast')
            if toast:
                act = page.query_selector('.toast__act')
                check('선도: 되돌리기 버튼 존재', act is not None)
                if act:
                    act.click()
                    page.wait_for_timeout(900)
                    # 되돌린 뒤 파생 허브의 선도 포지션이 «0» 이어야 한다
                    page.goto(base + '#/derivatives', wait_until='domcontentloaded')
                    page.wait_for_selector('.pillrow', timeout=20000)
                    page.wait_for_timeout(1200)
                    page.query_selector_all('.pillrow .pill')[2].click()
                    page.wait_for_timeout(500)
                    empty = page.query_selector('.card--pad')
                    check('★선도: 되돌리기 후 포지션 0', empty is not None)
                    page.screenshot(path=str(out / 'U_forward_after_undo.png'))
                    rep['shots'].append('U_forward_after_undo')
            rep['clicks'].append(['forward order+undo', cash_before])

            # ── ★주문 «유지» 경로 + 새로고침 복귀 ──────────────────────
            page.goto(base + '#/contract/forward/NVDA', wait_until='domcontentloaded')
            page.wait_for_selector('.btn--lg', timeout=20000)
            page.wait_for_timeout(2000)
            page.query_selector('.btn--lg').click()
            page.wait_for_timeout(6500)  # 되돌리기 창(5초)이 «지나가게» 둔다
            page.goto(base + '#/derivatives', wait_until='domcontentloaded')
            page.wait_for_selector('.pillrow', timeout=20000)
            page.wait_for_timeout(1500)
            page.query_selector_all('.pillrow .pill')[2].click()
            page.wait_for_timeout(600)
            pnl_before = page.evaluate("""() => (document.querySelector('.card .num')||{}).textContent || ''""")
            has_card = page.query_selector('.pbadge--fwd') is not None
            check('선도: 포지션 카드 표시', has_card)
            page.screenshot(path=str(out / 'P_forward_position.png'))
            rep['shots'].append('P_forward_position')

            # ★새로고침 복귀 — rescale 이 선도를 «옮기는지»(엔진 ⑤ 결함 회귀)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.pillrow', timeout=30000)
            page.wait_for_timeout(4000)
            page.query_selector_all('.pillrow .pill')[2].click()
            page.wait_for_timeout(700)
            still = page.query_selector('.pbadge--fwd') is not None
            check('★선도: 새로고침 복귀 후에도 포지션 유지', still)
            page.screenshot(path=str(out / 'P_forward_after_reload.png'))
            rep['shots'].append('P_forward_after_reload')

            rep['console'] += errs
            rep['pageerror'] += perrs
            ctx.close()

            # ── ko/en × 라이트/다크 실렌더 (칩 4개 각각) ───────────────
            for lang in ('ko', 'en'):
                for theme in ('light', 'dark'):
                    c2x = browser.new_context(viewport=VIEW, device_scale_factor=2,
                                              locale='ko-KR' if lang == 'ko' else 'en-US')
                    c2x.add_init_script(init_js(lang, theme))
                    p2 = c2x.new_page()
                    e2, pe2 = [], []
                    p2.on('console', lambda m, a=e2: a.append(m.text) if m.type == 'error' else None)
                    p2.on('pageerror', lambda e, a=pe2: a.append(str(e)))
                    p2.goto(base + '#/derivatives', wait_until='domcontentloaded')
                    p2.wait_for_selector('.tabbar', timeout=25000)
                    p2.wait_for_timeout(2500)
                    for i in range(4):
                        p2.query_selector_all('.pillrow .pill')[i].click()
                        p2.wait_for_timeout(350)
                        name = f'L_{lang}_{theme}_chip{i}'
                        p2.screenshot(path=str(out / f'{name}.png'))
                        rep['shots'].append(name)
                        for k, tx in scan_raw_keys(p2):
                            rep['rawKeys'].append([name, k, tx])
                        for b in scan_blur(p2):
                            rep['blur'].append([name, b])
                    # 주문폼 2종도
                    for route, tag in (('#/contract/forward/NVDA', 'fwd'), ('#/contract/swap/NVDA', 'swp'), ('#/option/AMD', 'opt'), ('#/leverage/NVDA', 'fut')):
                        p2.goto(base + route, wait_until='domcontentloaded')
                        p2.wait_for_selector('.appbar', timeout=20000)
                        p2.wait_for_timeout(1800)
                        name = f'L_{lang}_{theme}_{tag}'
                        p2.screenshot(path=str(out / f'{name}.png'))
                        rep['shots'].append(name)
                        for k, tx in scan_raw_keys(p2):
                            rep['rawKeys'].append([name, k, tx])
                        for b in scan_blur(p2):
                            rep['blur'].append([name, b])
                    rep['console'] += [[f'{lang}_{theme}', x] for x in e2]
                    rep['pageerror'] += [[f'{lang}_{theme}', x] for x in pe2]
                    c2x.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n샷 {len(rep['shots'])}장 · 검사 {len(rep['checks'])}건 · ★실패 {len(rep['fail'])}건")
    print(f"console {len(rep['console'])} · pageerror {len(rep['pageerror'])} · rawKey {len(rep['rawKeys'])} · blur {len(rep['blur'])}")
    for f in rep['fail']:
        print('  ★FAIL', f)
    for r in rep['rawKeys'][:12]:
        print('  RAWKEY', r)
    for r in rep['console'][:8]:
        print('  CONSOLE', r)
    return 1 if (rep['fail'] or rep['rawKeys'] or rep['blur'] or rep['console'] or rep['pageerror']) else 0


if __name__ == '__main__':
    sys.exit(main())
