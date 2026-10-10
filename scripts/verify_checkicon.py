# -*- coding: utf-8 -*-
"""
체크 표식(이모지 → SVG) 전후 실렌더 대조 — ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_checkicon.py <출력폴더> <이전.ait> <이후.ait>

★★왜 «두 빌드를 나란히» 찍나
  「적용했다」는 산출물이 아니다. 산출물은 «전후 실렌더»다.
  그리고 이 건은 특히 그렇다 — 바뀐 것이 «문자 하나»라 코드만 보면
  간격·정렬·색이 어떻게 변했는지 알 수 없다(문자열 결합 `✓ ` 의 공백이 사라졌다).

★대상 2곳
  ① 온보딩 닉네임 통과 표시  (12px 글자 옆 · 색 = var(--brand))
  ② 온보딩 종목 선택 배지    (20px 브랜드 원 안 · 색 = #fff)

★양성대조를 먼저 통과해야 결과를 낸다 — 「✓ 0건」은 검사기가 ✓ 를 «잡을 수 있음»을
  증명한 뒤에만 의미가 있다. (이 프로젝트에서 세 층의 검사기가 전부 ✓ 를 못 잡았다)
"""
import http.server
import json
import shutil
import socket
import socketserver
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
CK = '✓'

# 화면에 «그려진» 체크 글자를 센다(SVG 는 텍스트가 아니라 안 잡힌다 — 그게 목적이다)
CK_JS = """() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.textContent || '';
    if (t.includes('\\u2713') || t.includes('\\u2717')) out.push(t.trim().slice(0, 30));
  }
  return out;
}"""


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


def extract(ait: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(ait) as z:
        names = z.namelist()
        idx = sorted([n for n in names if n.endswith('index.html')], key=lambda n: n.count('/'))
        if not idx:
            raise SystemExit(f'index.html 을 못 찾았다: {names[:12]}')
        root = idx[0].rsplit('index.html', 1)[0]
        for n in names:
            if not n.startswith(root) or n.endswith('/'):
                continue
            rel = n[len(root):]
            if not rel:
                continue
            t = dest / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(z.read(n))
    return dest


TYPE_NICK = """(name) => {
    const i = document.querySelector('input');
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, name);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}"""


def walk_to_nick(page):
    """온보딩 첫 화면 → 닉네임 단계까지 «유저처럼» 넘어간다."""
    for _ in range(4):
        if page.query_selector('input'):
            return True
        b = page.query_selector('.cta .btn, .btn--primary')
        if not b or not b.is_enabled():
            return False
        b.click()
        page.wait_for_timeout(1200)
    return bool(page.query_selector('input'))


def shoot(pg, out: Path, label: str, theme: str, rep, check):
    """닉네임 통과 표시 + 종목 선택 배지를 찍고 «잰다»."""
    ok = walk_to_nick(pg)
    check(f'[{label}/{theme}] 온보딩 닉네임 단계 도달', ok)
    if not ok:
        return
    pg.evaluate(TYPE_NICK, '리미')
    pg.wait_for_timeout(700)
    pg.screenshot(path=str(out / f'{label}_{theme}_1_nick.png'))

    nick = pg.evaluate(
        """() => {
            const rows = [...document.querySelectorAll('div')];
            const row = rows.find(d => d.querySelector('svg') && /[가-힣]/.test(d.textContent||'')
                && getComputedStyle(d).display === 'flex' && d.children.length === 2
                && d.children[0].tagName === 'svg');
            const svg = row ? row.children[0] : null;
            const txt = row ? (row.children[1].textContent || '').trim() : null;
            if (!row) return { found: false };
            const cs = getComputedStyle(row);
            const sr = svg.getBoundingClientRect();
            const tr = row.children[1].getBoundingClientRect();
            return {
                found: true,
                text: txt,
                gapCss: cs.gap,
                gapMeasured: Math.round(tr.left - sr.right),
                svgW: Math.round(sr.width), svgH: Math.round(sr.height),
                stroke: svg.getAttribute('stroke'),
                strokeWidth: svg.getAttribute('stroke-width'),
                color: cs.color,
                ariaHidden: svg.getAttribute('aria-hidden'),
            };
        }"""
    )
    rep['measured'][f'{label}_{theme}_nick'] = nick
    glyphs = pg.evaluate(CK_JS)
    rep['measured'][f'{label}_{theme}_nickGlyphs'] = glyphs
    check(f'[{label}/{theme}] 닉네임 화면: 체크 «글자» {len(glyphs)}건', True, glyphs)

    # 종목 선택 단계로.
    # ⚠닉네임(step 1) 과 선택(step 3) 사이에 ★step 2(규칙 안내)가 있다.
    #   한 번만 누르면 «영영 도달하지 못한다» — 첫 판에 실제로 그렇게 0개가 나왔다.
    #   그리고 `submitNick` 은 async 라 버튼을 누른 «직후»에는 아직 step 이 안 바뀐다.
    for _ in range(4):
        if pg.query_selector('.pick'):
            break
        b = pg.query_selector('.cta .btn, .btn--primary')
        if not b or not b.is_enabled():
            pg.wait_for_timeout(900)
            continue
        b.click()
        pg.wait_for_timeout(1600)
    picks = pg.query_selector_all('.pick')
    check(f'[{label}/{theme}] 종목 선택 단계 도달', len(picks) >= 3, f'{len(picks)}개')
    if len(picks) >= 3:
        # ⚠★종목 3개는 «이미 선택된 채로» 시작한다(추천 3종).
        #   첫 판에 「3개를 고르자」며 앞의 3개를 눌렀다가 ★전부 «해제»해서
        #   배지 0개를 보고 실패로 판정했다 — 검사기가 틀린 것이었다.
        # ⇒ 기본 상태를 그대로 재고, 대신 «끄고 켜서» 배지가 따라오는지 확인한다.
        pressed = pg.eval_on_selector_all('.pick', 'e => e.map(x => x.getAttribute("aria-pressed"))')
        rep['measured'][f'{label}_{theme}_pressed'] = pressed
        check(f'[{label}/{theme}] 종목이 기본 3개 선택돼 있다', pressed.count('true') == 3, pressed)
        pg.screenshot(path=str(out / f'{label}_{theme}_2_pick.png'))

        # ★배지 자체의 양성·음성 대조 — 선택을 끄면 «사라지고» 켜면 «돌아온다»
        n_on = pg.eval_on_selector_all('.pick__ck', 'e => e.length')
        picks[0].click()
        pg.wait_for_timeout(400)
        n_off = pg.eval_on_selector_all('.pick__ck', 'e => e.length')
        picks[0].click()
        pg.wait_for_timeout(400)
        n_back = pg.eval_on_selector_all('.pick__ck', 'e => e.length')
        check(f'[{label}/{theme}] 배지: 선택 해제하면 «사라진다»', n_off == n_on - 1, f'{n_on} -> {n_off}')
        check(f'[{label}/{theme}] 배지: 다시 선택하면 «돌아온다»', n_back == n_on, f'{n_off} -> {n_back}')
        badge = pg.evaluate(
            """() => {
                const b = document.querySelector('.pick__ck');
                if (!b) return { found: false };
                const cs = getComputedStyle(b);
                const r = b.getBoundingClientRect();
                const svg = b.querySelector('svg');
                const sr = svg ? svg.getBoundingClientRect() : null;
                return {
                    found: true,
                    n: document.querySelectorAll('.pick__ck').length,
                    boxW: Math.round(r.width), boxH: Math.round(r.height),
                    bg: cs.backgroundColor, color: cs.color,
                    svg: !!svg,
                    svgW: sr ? Math.round(sr.width) : null,
                    svgH: sr ? Math.round(sr.height) : null,
                    strokeWidth: svg ? svg.getAttribute('stroke-width') : null,
                    text: (b.textContent || '').trim(),
                };
            }"""
        )
        rep['measured'][f'{label}_{theme}_badge'] = badge
        g2 = pg.evaluate(CK_JS)
        rep['measured'][f'{label}_{theme}_pickGlyphs'] = g2
        check(f'[{label}/{theme}] 선택 화면: 체크 «글자» {len(g2)}건', True, g2)


def main():
    out = ROOT / sys.argv[1]
    out.mkdir(parents=True, exist_ok=True)
    before = Path(sys.argv[2])
    after = Path(sys.argv[3])

    rep = {'before': str(before), 'after': str(after), 'checks': [], 'measured': {}}
    fails = []

    def check(name, ok, detail=''):
        rep['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            fails.append(name)
        print(('  PASS  ' if ok else '  FAIL  ') + name + ('  ' + str(detail) if detail != '' else ''))

    dirs = {
        'BEFORE': extract(before, ROOT / '_ckicon_before'),
        'AFTER': extract(after, ROOT / '_ckicon_after'),
    }
    servers = {k: serve(v) for k, v in dirs.items()}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            # ── ★양성대조 — 체크 «글자» 스캐너가 살아 있는가 ──────────
            print('\n① ★양성대조 (스캐너 생존 증명)')
            c0 = browser.new_context(viewport=VIEW, locale='ko-KR')
            p0 = c0.new_page()
            p0.goto(f'http://127.0.0.1:{servers["AFTER"][1]}/#/start', wait_until='domcontentloaded')
            p0.wait_for_timeout(2000)
            p0.evaluate(
                "() => { const d=document.createElement('div'); d.id='nck';"
                " d.textContent='NEEDLE ' + String.fromCharCode(0x2713); document.body.appendChild(d); }"
            )
            hit = p0.evaluate(CK_JS)
            check('[양성] 체크 글자를 심으면 «잡힌다»', any(CK in h for h in hit), hit)
            p0.evaluate("() => document.getElementById('nck')?.remove()")
            check('[음성] 니들을 빼면 «0건»', len(p0.evaluate(CK_JS)) == 0, p0.evaluate(CK_JS))
            c0.close()

            for theme in ('light', 'dark'):
                for label, (httpd, port) in servers.items():
                    print(f'\n② {label} · {theme}')
                    c = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                    c.add_init_script(
                        "(() => { localStorage.setItem('ml.settings',"
                        f" JSON.stringify({{lang:'ko',theme:'{theme}',updown:'kr'}})); }})()"
                    )
                    pg = c.new_page()
                    pg.goto(f'http://127.0.0.1:{port}/#/start', wait_until='domcontentloaded')
                    pg.wait_for_timeout(2600)
                    shoot(pg, out, label, theme, rep, check)
                    c.close()
        finally:
            browser.close()
            for httpd, _ in servers.values():
                httpd.shutdown()

    # ── 판정: AFTER 에는 체크 «글자»가 0건, BEFORE 에는 «있었다»(양성) ──
    print('\n③ 판정')
    for theme in ('light', 'dark'):
        b_n = rep['measured'].get(f'BEFORE_{theme}_nickGlyphs', [])
        b_p = rep['measured'].get(f'BEFORE_{theme}_pickGlyphs', [])
        a_n = rep['measured'].get(f'AFTER_{theme}_nickGlyphs', [])
        a_p = rep['measured'].get(f'AFTER_{theme}_pickGlyphs', [])
        check(f'[{theme}] ★BEFORE 에는 체크 «글자»가 있었다(대조군이 유효하다)', len(b_n) + len(b_p) > 0, (b_n, b_p))
        check(f'[{theme}] ★AFTER 에는 체크 «글자»가 0건', len(a_n) + len(a_p) == 0, (a_n, a_p))
        nk = rep['measured'].get(f'AFTER_{theme}_nick', {})
        bd = rep['measured'].get(f'AFTER_{theme}_badge', {})
        check(f'[{theme}] AFTER 닉네임: SVG 가 그려졌다', bool(nk.get('found')), nk)
        check(f'[{theme}] AFTER 닉네임: 아이콘이 aria-hidden(중복 낭독 없음)', nk.get('ariaHidden') in ('true', ''), nk.get('ariaHidden'))
        check(f'[{theme}] AFTER 닉네임: 간격이 CSS gap 으로 «보인다»', nk.get('gapCss') == '6px', nk.get('gapCss'))
        check(f'[{theme}] AFTER 배지: SVG 가 원 안에 들어갔다', bool(bd.get('svg')) and bd.get('text') == '', bd)
        check(f'[{theme}] AFTER 배지: 선택 3개 = 배지 3개', bd.get('n') == 3, bd.get('n'))

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"\n검사 {len(rep['checks'])}건 · 실패 {len(fails)}건 -> {out}")
    for f in fails:
        print('  FAILED: ' + f)
    if fails:
        sys.exit(1)


if __name__ == '__main__':
    main()
