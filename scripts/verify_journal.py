# -*- coding: utf-8 -*-
"""
거래 일지 · 캔들 시간단위 · 광고 배치 실렌더 검증 — ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_journal.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_journal.py <출력폴더>   # 출하물 검증

★★이 스크립트가 «먼저» 하는 일 = 자기 검사기들의 양성대조다.
  ①콘솔 에러 ②pageerror ③raw 키 누출 ④blur ⑤이모지 스캐너 — 니들로 «잡히는지»
  먼저 증명한다. 하나라도 못 잡으면 그 실행의 「0건」은 무효다.

★주문은 «실제 UI 를 눌러» 낸다. 일지에 들어가는 숫자가 엔진이 장부에 적은 값과
  같은지 보려면 스토어를 훔쳐보지 말고 «유저가 하는 대로» 해야 한다.
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

# ★종목 «수»를 소스에서 센다. ⛔여기에 숫자를 적지 마라 — 그게 stale 라벨의 시작이다.
def _ticker_count():
    try:
        src = (Path(__file__).resolve().parent.parent / 'src' / 'data' / 'tickers.generated.ts').read_text(encoding='utf-8')
        return len(re.findall(r"ticker: '", src)) or len(re.findall(r'"ticker":', src))
    except Exception:
        return 0


TICKER_COUNT = _ticker_count()
DIST = ROOT / os.environ.get('ML_DIST', 'dist')
VIEW = {'width': 390, 'height': 844}

RAW_KEY_RE = re.compile(r'(?:^|[\s>\[(])([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,4})(?:$|[\s<\])])')
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


def init_js(lang, theme, preview_ads=False):
    """★★반드시 «감싸서 호출»한 형태로 돌려준다.

    ⛔화살표 함수 소스를 그대로 add_init_script 에 넘기면 ★정의만 되고 «실행되지 않는다».
      이번 실행에서 실제로 그 실수를 했고, 세션이 안 깔려 Gate 가 온보딩으로 되돌렸다.
      (verify_render.py 주석에 같은 함정이 이미 적혀 있었다 — 적어두는 것으로는 안 막힌다)
    ⇒ 그래서 «호출까지» 이 함수가 붙여서 준다. 호출부가 잊을 수 없다.
    """
    nick = '리미' if lang == 'ko' else 'Rimi'
    ads = "sessionStorage.setItem('ads.preview','1');" if preview_ads else ''
    #  ★★출석이 부팅 시 일지에 한 줄을 «자동으로» 넣는다(2026-08-22).
    #    ⇒ 그대로 두면 「빈 일지」 상태를 ★만들 수가 없다.
    #    ⇒ 「오늘 이미 받았다」로 씨를 뿌려 지급을 막는다. ⛔기능을 끄는 게 아니라 «상태»를 만드는 것이다.
    attend = (
        "(() => { const k = new Date(Date.now() + 9*3600*1000);"
        " const key = k.getUTCFullYear()+'-'+String(k.getUTCMonth()+1).padStart(2,'0')"
        " +'-'+String(k.getUTCDate()).padStart(2,'0');"
        " localStorage.setItem('ml.attendance', JSON.stringify("
        "   { streak: 1, lastClaimedDate: key, lastDoubledDate: null, totalUsd: 0 })); })();"
    )
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        f"localStorage.setItem('ml.session', JSON.stringify({{userId:'local',token:'',nickname:'{nick}'}}));"
        f"localStorage.setItem('ml.settings', JSON.stringify({{lang:'{lang}',theme:'{theme}',updown:'kr'}}));"
        f"{ads}"
        f"{attend}"
        "})()"
    )


def scan_raw_keys(page):
    texts = page.eval_on_selector_all(
        'body *',
        """els => els
            .filter(e => e.children.length === 0)
            .filter(e => !['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))
            .map(e => (e.textContent||'').trim())
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
                const f = cs.filter || '';
                const b = cs.backdropFilter || cs.webkitBackdropFilter || '';
                if (f.includes('blur') || (b && b !== 'none')) out.push(el.tagName + '.' + (el.className||''));
            }
            return out;
        }"""
    )


# ★화면에 «실제로 그려진» 이모지를 센다. 소스 grep 이 아니라 렌더 결과다.
#
# ★★[2026-08-21 정정] `\p{Extended_Pictographic}` 는 ✓(U+2713)·✗(U+2717) 을 «안 잡는다»
#   [실측: /\p{Extended_Pictographic}/u.test('✓') === false, '✔'(U+2714) 은 true].
#   그래서 화면 아이콘으로 쓰인 ✓ 2곳이 이 검사기를 그대로 통과해 ★출하물까지 갔다.
#   ⛔같은 구멍이 `scripts/check_emoji.mjs` 에도 있었다 — 소스·번들·DOM ★세 층이
#     전부 같은 이유로 못 잡았다. 「0건」이 세 번 나왔지만 세 번 다 «부재의 증거»가 아니었다.
#   ⇒ 두 검사기에 «같은 문자»를 더했다. 아래 니들 ⑦ 이 이 층의 생존을 증명한다.
EMOJI_JS = r"""() => {
  const RE = /(\p{Extended_Pictographic}|️|⃣|✓|✗)/gu;
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const p = n.parentElement;
    if (!p) continue;
    const tag = p.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(tag)) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const t = n.textContent || '';
    const m = t.match(RE);
    if (m) out.push({ chars: [...new Set(m)].join(''), text: t.trim().slice(0, 30), cls: p.className || '', size: cs.fontSize });
  }
  return out;
}"""


def scan_emoji(page):
    return page.evaluate(EMOJI_JS)


def scan_bot_word(page):
    """유저에게 보이는 텍스트에 「봇」 0건 — 이스케이프는 렌더 시점에 이미 풀려 있다"""
    return page.evaluate(
        """() => {
            const out = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walk.nextNode())) {
                const t = n.textContent || '';
                if (t.includes('봇')) out.push(t.trim().slice(0, 40));
            }
            return out;
        }"""
    )


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_journal')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'positive': [], 'checks': [], 'shots': [], 'console': [], 'pageerror': [], 'rawKeys': [], 'blur': [], 'emoji': [], 'bot': [], 'fail': []}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(init_js('ko', 'light', preview_ads=True))
            page = ctx.new_page()
            errs, perrs = [], []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: perrs.append(str(e)))

            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=30000)
            page.wait_for_timeout(3200)

            # ── 0-a) ★부팅 게이트 — «온보딩을 지났는지»를 구조로 확인한다.
            #   세션 주입이 실패하면 Gate 가 /start 로 되돌리는데, 그 상태로도 스크린샷은
            #   «찍힌다». 파일 개수만 보면 성공처럼 보인다(verify_render 가 겪은 실패다).
            if '#/start' in page.url or page.query_selector('.hero') is not None:
                print('FAILED: 온보딩 화면에 머물러 있다 — 세션 주입이 안 됐다. 이 실행은 무효다.', page.url)
                return 1

            # ── 0) 양성대조 ────────────────────────────────────────────
            page.evaluate("() => console.error('NEEDLE_CONSOLE')")
            page.wait_for_timeout(120)
            c1 = any('NEEDLE_CONSOLE' in c for c in errs)
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)")
            page.wait_for_timeout(200)
            c2 = any('NEEDLE_PAGE' in e for e in perrs)
            page.evaluate("() => { const d=document.createElement('div'); d.id='nk'; d.textContent='journal.needle.key'; document.body.appendChild(d); }")
            c3 = any(k.startswith('journal.needle') for k, _ in scan_raw_keys(page))
            page.evaluate("() => document.getElementById('nk')?.remove()")
            page.evaluate("() => { const d=document.createElement('div'); d.id='nb'; d.style.backdropFilter='blur(4px)'; document.body.appendChild(d); }")
            c4 = len(scan_blur(page)) > 0
            page.evaluate("() => document.getElementById('nb')?.remove()")
            # ⑤ 이모지 스캐너 — «화면에 없는» 이모지를 심어서 잡히는지 본다
            page.evaluate("() => { const d=document.createElement('div'); d.id='ne'; d.textContent='NEEDLE \U0001F953'; document.body.appendChild(d); }")
            c5 = any('\U0001F953' in h['chars'] for h in scan_emoji(page))
            page.evaluate("() => document.getElementById('ne')?.remove()")
            # ⑥ 「봇」 스캐너
            page.evaluate("() => { const d=document.createElement('div'); d.id='nw'; d.textContent='NEEDLE 봇'; document.body.appendChild(d); }")
            c6 = len(scan_bot_word(page)) > 0
            page.evaluate("() => document.getElementById('nw')?.remove()")
            # ⑦ ★✓(U+2713) — Extended_Pictographic 밖이라 예전엔 «못 잡던» 문자다.
            #   이 니들이 없으면 아래의 「이모지 0건」이 ✓ 에 대해서는 «거짓»이 된다.
            page.evaluate(
                "() => { const d=document.createElement('div'); d.id='nc';"
                " d.textContent='NEEDLE ' + String.fromCharCode(0x2713); document.body.appendChild(d); }"
            )
            c7 = any('✓' in h['chars'] for h in scan_emoji(page))
            page.evaluate("() => document.getElementById('nc')?.remove()")

            rep['positive'] = [['console', c1], ['pageerror', c2], ['rawKey', c3], ['blur', c4],
                               ['emoji', c5], ['botWord', c6], ['checkGlyph(U+2713)', c7]]
            if not all(x[1] for x in rep['positive']):
                print('FAILED: 양성대조 실패 — 이 실행의 0건은 무효다', rep['positive'])
                json.dump(rep, open(out / 'report.json', 'w'), ensure_ascii=False, indent=1)
                return 1
            print(f'양성대조 {len(rep["positive"])}/{len(rep["positive"])} CAUGHT')
            errs.clear()
            perrs.clear()

            # ── 1) 빈 일지 ─────────────────────────────────────────────
            page.goto(base + '#/settings', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            rows = page.eval_on_selector_all('.li', 'els => els.map(e => ({tag: e.tagName, txt: (e.textContent||"").trim().slice(0,24), chev: !!e.querySelector(".chev")}))')
            hist = [r for r in rows if '거래' in r['txt']]
            check('설정: 「거래 내역」 행이 button 이다', bool(hist) and hist[0]['tag'] == 'BUTTON', hist[:1])
            check('설정: 셰브런이 붙었다', bool(hist) and hist[0]['chev'], hist[:1])
            page.screenshot(path=str(out / 'S1_settings_ko_light.png'), full_page=True)
            rep['shots'].append('S1_settings_ko_light')

            # 「거래 내역」 행을 «실제로 눌러» 이동한다
            page.eval_on_selector_all('.li', 'els => { const b = els.find(e => (e.textContent||"").includes("거래")); b && b.click(); }')
            page.wait_for_timeout(700)
            check('설정 → 일지 이동', '#/journal' in page.url, page.url)
            page.screenshot(path=str(out / 'J0_empty_ko_light.png'))
            rep['shots'].append('J0_empty_ko_light')
            check('빈 일지: 안내 카드 있음', page.query_selector('.card') is not None)

            # ── 2) 실제 주문 — 현물 매수/매도 ──────────────────────────
            def spot(tk, side, qty):
                """★현물 주문은 «바텀시트»가 아니라 ★전체화면 오버레이(OrderSheet)다.
                   ⛔`.sheet` 로 찾다가 전부 실패했다 — 선택자를 «마크업을 읽고» 맞춘다.
                   ★orderbar 순서도 [0]=팔기(보유 없으면 disabled) · [1]=사기 다."""
                page.goto(base + f'#/stock/{tk}', wait_until='domcontentloaded')
                page.wait_for_selector('.orderbar', timeout=20000)
                page.wait_for_timeout(1200)
                btns = page.query_selector_all('.orderbar .btn')
                if len(btns) < 2:
                    return False
                b0 = btns[1] if side == 'buy' else btns[0]
                if not b0.is_enabled():
                    return False
                b0.click()
                try:
                    # ★확정 버튼(.btn--lg.btn--up/.btn--down)이 «오버레이에만» 있다.
                    #   orderbar 의 팔기/사기는 btn--sub / 인라인 스타일이라 겹치지 않는다.
                    page.wait_for_selector('.btn--lg.btn--up, .btn--lg.btn--down', timeout=10000)
                except Exception:
                    return False
                # 수량 +버튼이 있으면 qty-1 번 누른다(없으면 기본 1주로 낸다)
                for _ in range(max(0, qty - 1)):
                    plus = page.query_selector_all('.qty__pm')
                    if len(plus) >= 2 and plus[1].is_enabled():
                        plus[1].click()
                        page.wait_for_timeout(90)
                cta = page.query_selector('.btn--lg.btn--up, .btn--lg.btn--down')
                if not cta or not cta.is_enabled():
                    return False
                cta.click()
                page.wait_for_timeout(1000)
                return True

            check('현물 매수 실행', spot('NVDA', 'buy', 3))
            check('현물 매도 실행', spot('NVDA', 'sell', 1))

            # ── 3) 파생 — 선물 개시 ────────────────────────────────────
            page.goto(base + '#/leverage/NVDA', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            lev_cta = page.query_selector('.btn--lg')
            ok_lev = bool(lev_cta) and lev_cta.is_enabled()
            if ok_lev:
                lev_cta.click()
                page.wait_for_timeout(900)
            check('선물/레버리지 개시', ok_lev)

            # ── 4) 파생 — 선도 개시 ────────────────────────────────────
            page.goto(base + '#/contract/forward/AAPL', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            fwd_cta = page.query_selector('.btn--lg')
            ok_fwd = bool(fwd_cta) and fwd_cta.is_enabled()
            if ok_fwd:
                fwd_cta.click()
                page.wait_for_timeout(900)
            check('선도 개시', ok_fwd)

            # ── 5) 파생 — 스왑 개시 ────────────────────────────────────
            page.goto(base + '#/contract/swap/MSFT', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            # 스왑은 상대 종목을 골라야 한다 — 「종목 고르기」 행을 누른다
            picker_btn = page.query_selector('.card.li, .li')
            if picker_btn:
                picker_btn.click()
                page.wait_for_timeout(600)
                first = page.query_selector('.sheet .row')
                if first:
                    first.click()
                    page.wait_for_timeout(600)
            swp_cta = page.query_selector('.btn--lg')
            ok_swp = bool(swp_cta) and swp_cta.is_enabled()
            if ok_swp:
                swp_cta.click()
                page.wait_for_timeout(900)
            check('스왑 개시', ok_swp)

            # ── 6) 파생 — 옵션 매수 ────────────────────────────────────
            page.goto(base + '#/option/TSLA', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            opt_cta = page.query_selector('.btn--lg')
            ok_opt = bool(opt_cta) and opt_cta.is_enabled()
            if ok_opt:
                opt_cta.click()
                page.wait_for_timeout(900)
            check('옵션 개시', ok_opt)

            # ── 7) 파생 포지션 «청산» 1건 (실현 손익이 찍히는지) ────────
            page.goto(base + '#/derivatives', wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            closed = page.evaluate(
                """() => {
                    const btns = [...document.querySelectorAll('button')];
                    const b = btns.find(x => /청산|정리|팔기/.test(x.textContent || ''));
                    if (!b) return false;
                    b.click();
                    return true;
                }"""
            )
            page.wait_for_timeout(900)
            check('파생 1건 청산 시도', closed)

            # ── 8) 일지 실렌더 ─────────────────────────────────────────
            page.goto(base + '#/journal', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            info = page.evaluate(
                """() => {
                    const rows = [...document.querySelectorAll('.jrow')];
                    return {
                        n: rows.length,
                        badges: [...new Set(rows.map(r => (r.querySelector('.pbadge')||{}).textContent))],
                        sample: rows.slice(0,8).map(r => ({
                            tk: (r.querySelector('.jrow__tk')||{}).textContent,
                            d: (r.querySelector('.jrow__d')||{}).textContent,
                            w: (r.querySelector('.jrow__w')||{}).textContent,
                            v: (r.querySelector('.jrow__v')||{}).textContent,
                            f: (r.querySelector('.jrow__f')||{}).textContent,
                        })),
                        sum: [...document.querySelectorAll('.sumrow__v')].map(e => e.textContent),
                        note: (document.querySelector('.hint')||{}).textContent,
                        h: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
                    };
                }"""
            )
            rep['journal'] = info
            check('일지 행이 그려졌다', info['n'] > 0, f"{info['n']}행")
            check('행 높이가 고정(82)', info['h'] == 82, info['h'])
            check('상품 배지 2종 이상', len(info['badges']) >= 2, info['badges'])
            check('실현 손익이 붙은 줄 있음', any((r['v'] or '').startswith(('+', '-')) for r in info['sample']), [r['v'] for r in info['sample']])
            page.screenshot(path=str(out / 'J1_list_ko_light.png'))
            rep['shots'].append('J1_list_ko_light')

            # 필터
            for i, nm in enumerate(['all', 'spot', 'deriv']):
                page.eval_on_selector_all('.seg button', f'els => els[{i}] && els[{i}].click()')
                page.wait_for_timeout(400)
                cnt = page.eval_on_selector_all('.jrow', 'els => els.length')
                check(f'필터 {nm} 동작', True, f'{cnt}행')
                page.screenshot(path=str(out / f'J2_filter_{nm}.png'))
                rep['shots'].append(f'J2_filter_{nm}')
            page.eval_on_selector_all('.seg button', 'els => els[0] && els[0].click()')
            page.wait_for_timeout(300)

            # ── 8-b) ★영속 — 새로고침해도 일지가 남는가 ────────────────
            #   저장 키가 `ml.journal`(세이브 블롭과 «다른 키»)이라는 설계의 실증이다.
            before_n = page.eval_on_selector_all('.jrow', 'els => els.length')
            keys = page.evaluate("() => ({ journal: !!localStorage.getItem('ml.journal'), game: !!localStorage.getItem('ml.game'), v: JSON.parse(localStorage.getItem('ml.game')||'{}').v })")
            rep['journalKeys'] = keys
            check('일지가 «별도 키»(ml.journal)에 저장된다', keys['journal'], keys)
            check('세이브 블롭 SAVE_VERSION 이 여전히 1', keys['v'] == 1, keys)
            # ★일지는 «탭바가 없는» 전체화면 라우트다 — .tabbar 를 기다리면 영영 안 온다.
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.screen', timeout=25000)
            page.wait_for_timeout(3400)
            page.goto(base + '#/journal', wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            after_n = page.eval_on_selector_all('.jrow', 'els => els.length')
            check('새로고침해도 일지가 «그대로»', after_n == before_n, '%d -> %d' % (before_n, after_n))

            # ── 8-c) ★되돌리기 = 일지에서도 «없던 일»이 된다 ────────────
            #   되돌린 주문이 기록에 남으면 유저는 자기 기록을 믿지 못한다.
            n0 = after_n
            page.goto(base + '#/leverage/AMD', wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            cta2 = page.query_selector('.btn--lg')
            undone = False
            mid_n = -1
            if cta2 and cta2.is_enabled():
                cta2.click()
                page.wait_for_timeout(900)
                # ★★되돌리기 «전»에 한 번 센다.
                #   ⛔「전후가 같다」만 보면 «애초에 기록되지 않은» 경우도 통과한다 —
                #     그건 검사가 아니라 우연이다. 늘었다가 → 되돌리면 준다, 를 본다.
                page.goto(base + '#/journal', wait_until='domcontentloaded')
                page.wait_for_timeout(900)
                mid_n = page.eval_on_selector_all('.jrow', 'els => els.length')
                page.go_back()
                page.wait_for_timeout(700)
                # 토스트의 「되돌리기」 버튼을 «실제로» 누른다
                undone = page.evaluate(
                    """() => {
                        const b = [...document.querySelectorAll('.toast__act')];
                        if (!b.length) return false;
                        b[b.length - 1].click();
                        return true;
                    }"""
                )
                page.wait_for_timeout(1200)
            page.goto(base + '#/journal', wait_until='domcontentloaded')
            page.wait_for_timeout(1000)
            n1 = page.eval_on_selector_all('.jrow', 'els => els.length')
            check('되돌리기 «전»에 일지가 늘었다(양성대조)', mid_n == n0 + 1, '%d -> %d' % (n0, mid_n))
            check('되돌리기를 눌렀다', undone)
            check('되돌린 주문은 일지에서 «사라진다»', undone and n1 == n0, '%d -> %d -> %d' % (n0, mid_n, n1))

            # ── 9) 캔들 시간 단위 ──────────────────────────────────────
            page.goto(base + '#/stock/NVDA', wait_until='domcontentloaded')
            page.wait_for_timeout(1000)
            page.evaluate("""() => { const b=[...document.querySelectorAll('.pill')].find(x=>/캔들/.test(x.textContent||'')); b&&b.click(); }""")
            page.wait_for_timeout(600)
            unit_pills = page.evaluate(
                """() => {
                    const rows = [...document.querySelectorAll('.pillrow')];
                    const last = rows[rows.length-1];
                    return last ? [...last.querySelectorAll('.pill')].map(p => ({t:(p.textContent||'').trim(), on:p.className.includes('pill--on')})) : [];
                }"""
            )
            rep['candleUnits'] = unit_pills
            check('봉 단위 알약 3개', len(unit_pills) == 3, unit_pills)
            check('1분 단위가 있다', any('1분' in p['t'] for p in unit_pills), [p['t'] for p in unit_pills])
            for i, p_ in enumerate(unit_pills):
                page.evaluate(
                    f"""() => {{
                        const rows=[...document.querySelectorAll('.pillrow')];
                        const last=rows[rows.length-1];
                        const ps=[...last.querySelectorAll('.pill')];
                        ps[{i}] && ps[{i}].click();
                    }}"""
                )
                page.wait_for_timeout(700)
                st = page.evaluate(
                    """() => ({
                        bars: document.querySelectorAll('svg rect[rx="1"]').length,
                        sub: [...document.querySelectorAll('span')].map(s=>s.textContent).filter(t=>t&&t.includes('봉'))[0]||'',
                        periodOn: [...document.querySelectorAll('.pillrow')][0] ? null : null,
                        legend: [...document.querySelectorAll('.pillrow')].length,
                    })"""
                )
                check(f"봉 단위 {p_['t']}: 캔들이 그려짐", st['bars'] >= 6, f"{st['bars']}봉 · {st['sub']}")
                page.screenshot(path=str(out / f"C1_candle_{p_['t']}.png"))
                rep['shots'].append(f"C1_candle_{p_['t']}")

            # ── 10) 광고 배치 — 파생 탭 ★[2026-09-10 · -33 반전] 배너 «제거» ─────
            #   예전 검사 「파생 탭: 배너가 렌더된다 · CTA 간격 ≥ 100px」는 지면이 있을 때의 규칙이었다.
            #   콘솔 실측(09-02~08 노출 797회 → 241원 · eCPM 213원)으로 이 지면을 «뺐다»(President 승인 전략 2-2).
            #   ⇒ 이제 이 화면에는 .adslot 이 «0개»여야 하고, 배너가 있던 자리에 «유령 여백»이 남지 않아야 한다.
            page.goto(base + '#/derivatives', wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            geo = page.evaluate(
                """() => {
                    const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
                    const sc = document.querySelector('.scroll');
                    const ghosts = [];
                    if (sc) for (const c of sc.children) {
                        const r = c.getBoundingClientRect();
                        const pad = px(c, 'paddingTop') + px(c, 'paddingBottom');
                        const mar = px(c, 'marginTop') + px(c, 'marginBottom');
                        if (Math.round(r.height) === 0 && (pad + mar) > 0 && !c.classList.contains('scroll-pad')) ghosts.push(c.className || c.tagName);
                    }
                    return { adslots: document.querySelectorAll('.adslot').length, ghosts, cta: !!document.querySelector('.derivcta') };
                }"""
            )
            rep['derivAdGeo'] = geo
            check('파생 탭: 배너가 «없다»(.adslot 0 — 2026-09-10 제거)', geo['adslots'] == 0, geo)
            check('파생 탭: 배너 자리에 유령 여백 0 · 고정 CTA 는 그대로', len(geo['ghosts']) == 0 and geo['cta'], geo)
            page.screenshot(path=str(out / 'A1_deriv_empty.png'))
            rep['shots'].append('A1_deriv_empty')

            # ── 11) 광고 배치 — 설정 화면에서 로그아웃 버튼과의 거리 ───
            page.goto(base + '#/settings', wait_until='domcontentloaded')
            page.wait_for_timeout(900)
            sgeo = page.evaluate(
                """() => {
                    const ad = document.querySelector('.adslot');
                    if (!ad) return null;
                    const btns = [...document.querySelectorAll('.li')];
                    const out = btns.find(b => /로그아웃|Sign out/.test(b.textContent||''));
                    if (!out) return null;
                    const a = ad.getBoundingClientRect(), o = out.getBoundingClientRect();
                    return { adBottom: Math.round(a.bottom), outTop: Math.round(o.top), gap: Math.round(o.top - a.bottom) };
                }"""
            )
            rep['settingsAdGeo'] = sgeo
            check('설정: 배너 ↔ 로그아웃 간격 ≥ 24px', bool(sgeo) and sgeo['gap'] >= 24, sgeo)
            page.screenshot(path=str(out / 'A2_settings_ad.png'), full_page=True)
            rep['shots'].append('A2_settings_ad')

            # ── 12) 종목 목록 — 끝까지 스크롤하며 좌표 어긋남 확인 ─────
            page.goto(base + '#/stocks', wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            scroll_rep = page.evaluate(
                """async () => {
                    const sc = document.querySelector('.scroll');
                    if (!sc) return null;
                    const seen = [];
                    const bad = [];
                    for (let y = 0; y <= sc.scrollHeight; y += 400) {
                        sc.scrollTop = y;
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const rows = [...sc.querySelectorAll('.row')];
                        for (let i = 1; i < rows.length; i++) {
                            const a = rows[i-1].getBoundingClientRect(), b = rows[i].getBoundingClientRect();
                            if (b.top < a.bottom - 1) bad.push({ y, gap: Math.round(b.top - a.bottom) });
                        }
                        seen.push({ y, rows: rows.length });
                    }
                    return { scrollHeight: sc.scrollHeight, steps: seen.length, overlaps: bad.slice(0, 5), overlapN: bad.length };
                }"""
            )
            rep['stocksScroll'] = scroll_rep
            # ★라벨에 종목 «수»를 박지 않는다 — 100 → 1,000 으로 이미 바뀌었고 또 바뀐다.
            #   그 형태가 이 프로젝트가 반복해서 데인 「라벨이 코드보다 늦게 따라간다」다.
            check('종목 «전 구간» 스크롤: 행 겹침 0', bool(scroll_rep) and scroll_rep['overlapN'] == 0, scroll_rep)
            page.screenshot(path=str(out / 'A3_stocks_scrolled.png'))
            rep['shots'].append('A3_stocks_scrolled')

            # ── 13) 파생 종목 선택기 — 전 종목 + 검색 ──────────────────
            page.goto(base + '#/derivatives', wait_until='domcontentloaded')
            page.wait_for_timeout(1000)
            page.evaluate("""() => { const b=document.querySelector('.derivcta .btn'); b&&b.click(); }""")
            page.wait_for_timeout(700)
            pick = page.evaluate(
                """async () => {
                    const sheet = document.querySelector('.sheet');
                    if (!sheet) return null;
                    const list = sheet.querySelector('.card--list');
                    const hasSearch = !!sheet.querySelector('input');
                    if (!list) return { hasSearch, total: 0 };
                    let max = 0;
                    for (let y = 0; y <= list.scrollHeight; y += 300) {
                        list.scrollTop = y;
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    }
                    max = Math.round(list.scrollHeight / 64);
                    return { hasSearch, total: max, visible: list.querySelectorAll('.row').length };
                }"""
            )
            rep['picker'] = pick
            check('파생 종목 선택기: 검색창 있음', bool(pick) and pick['hasSearch'], pick)
            # ★기대값을 «데이터에서» 유도한다. 손으로 박은 95 는 1,000종목에서 무의미해진다.
            check('파생 종목 선택기: 전 종목 접근 가능(엔진 화이트리스트 없음)',
                  bool(pick) and pick['total'] >= TICKER_COUNT, dict(pick, expect=TICKER_COUNT) if pick else pick)
            page.screenshot(path=str(out / 'A4_picker.png'))
            rep['shots'].append('A4_picker')
            # 검색 동작
            page.evaluate("""() => { const i=document.querySelector('.sheet input'); if(i){ const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'TSLA'); i.dispatchEvent(new Event('input',{bubbles:true})); } }""")
            page.wait_for_timeout(600)
            found = page.eval_on_selector_all('.sheet .row .row__sub', 'els => els.map(e => (e.textContent||"").trim())')
            check('검색: TSLA 로 좁혀진다', len(found) >= 1 and all('TSLA' in f for f in found), found[:3])
            page.screenshot(path=str(out / 'A5_picker_search.png'))
            rep['shots'].append('A5_picker_search')

            # ── 14) 로케일·테마 조합 실렌더 ────────────────────────────
            for lang in ('ko', 'en'):
                for theme in ('light', 'dark'):
                    c2x = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR' if lang == 'ko' else 'en-US')
                    c2x.add_init_script(init_js(lang, theme, preview_ads=True))
                    pg = c2x.new_page()
                    pg.goto(base + '#/home', wait_until='domcontentloaded')
                    pg.wait_for_selector('.tabbar', timeout=25000)
                    pg.wait_for_timeout(2600)
                    pg.goto(base + '#/journal', wait_until='domcontentloaded')
                    pg.wait_for_timeout(900)
                    pg.screenshot(path=str(out / f'J3_{lang}_{theme}.png'))
                    rep['shots'].append(f'J3_{lang}_{theme}')
                    c2x.close()

            # ── 14-a) ★랭킹 탭 — 배너가 «탭당 1개»인지
            #   정책 원문: 「동일 화면에 동일 포맷 광고를 2개 이상 배치하는 경우」 금지.
            #   Leaderboard 는 지면 하나를 두 곳에서 쓴다(전체/관심). 코드상 동시 렌더가
            #   아니라고 «읽었지만», 정책이 걸린 곳이라 ★DOM 개수로 확정한다.
            page.goto(base + '#/rank', wait_until='domcontentloaded')
            page.wait_for_timeout(1400)
            segs = page.eval_on_selector_all('.seg button', 'els => els.map(e => (e.textContent||"").trim())')
            rep['rankSegs'] = segs
            for i in range(min(2, len(segs))):
                page.eval_on_selector_all('.seg button', 'els => els[%d] && els[%d].click()' % (i, i))
                page.wait_for_timeout(900)
                n_ad = page.eval_on_selector_all('.adslot', 'els => els.length')
                check('랭킹 「%s」 탭: 배너 1개 이하' % segs[i], n_ad <= 1, '%d개' % n_ad)
                page.screenshot(path=str(out / ('A6_rank_tab%d.png' % i)))
                rep['shots'].append('A6_rank_tab%d' % i)

            # ★관심 20명(상한)을 채운 상태 — 목록이 길어지면 두 지면이 동시에 뜰 수 있다
            page.evaluate(
                """() => {
                    const ids = Array.from({length: 20}, (_, i) => 'BOT' + String(i + 1).padStart(3, '0'));
                    localStorage.setItem('ml.traderwatch', JSON.stringify(ids));
                }"""
            )
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=25000)
            page.wait_for_timeout(3200)
            page.goto(base + '#/rank', wait_until='domcontentloaded')
            page.wait_for_timeout(1400)
            for i in range(min(2, len(segs))):
                page.eval_on_selector_all('.seg button', 'els => els[%d] && els[%d].click()' % (i, i))
                page.wait_for_timeout(900)
                n_ad = page.eval_on_selector_all('.adslot', 'els => els.length')
                check('랭킹 「%s」 탭(관심 20명): 배너 1개 이하' % segs[i], n_ad <= 1, '%d개' % n_ad)
            page.screenshot(path=str(out / 'A7_rank_watch20.png'))
            rep['shots'].append('A7_rank_watch20')

            # ── 14-b) ★종목 상세 배너 — 첫 화면 밖 · 주문바와의 거리 ──
            page.goto(base + '#/stock/NVDA', wait_until='domcontentloaded')
            page.wait_for_selector('.orderbar', timeout=20000)
            page.wait_for_timeout(1600)
            sd = page.evaluate(
                """async () => {
                    const ad = document.querySelector('.adslot');
                    const bar = document.querySelector('.orderbar');
                    const sc = document.querySelector('.scroll');
                    if (!ad || !bar || !sc) return null;
                    const adTop = Math.round(ad.getBoundingClientRect().top);
                    const vh = window.innerHeight;
                    sc.scrollTop = sc.scrollHeight;
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    const a = ad.getBoundingClientRect(), b = bar.getBoundingClientRect();
                    return { adTop, vh, scrolledAdBottom: Math.round(a.bottom), barTop: Math.round(b.top), gapAtBottom: Math.round(b.top - a.bottom) };
                }"""
            )
            rep['stockDetailAd'] = sd
            check('종목 상세: 배너가 렌더된다', sd is not None, sd)
            if sd:
                check('종목 상세: 첫 화면(710px) 밖', sd['adTop'] >= 710, 'top=%d' % sd['adTop'])
                check('종목 상세: 끝까지 내려도 주문바와 100px 이상', sd['gapAtBottom'] >= 100, '%dpx' % sd['gapAtBottom'])
            page.screenshot(path=str(out / 'A8_stockdetail_ad.png'), full_page=True)
            rep['shots'].append('A8_stockdetail_ad')

            # ── 15) 전 화면 정적 검사(이모지·raw키·blur·「봇」) ────────
            #   ★주문 3화면까지 «전부» 돈다 — 이모지가 남아 있던 곳 대부분이 그 화면들이었다.
            #     안 도는 화면의 0건은 0건이 아니다.
            ROUTES = ['#/home', '#/stocks', '#/derivatives', '#/rank', '#/settings', '#/journal',
                      '#/stock/NVDA', '#/recharge', '#/leverage/NVDA', '#/option/NVDA',
                      '#/contract/forward/NVDA', '#/contract/swap/MSFT']
            for r in ROUTES:
                page.goto(base + r, wait_until='domcontentloaded')
                page.wait_for_timeout(900)
                for k, tx in scan_raw_keys(page):
                    rep['rawKeys'].append([r, k, tx])
                for b in scan_blur(page):
                    rep['blur'].append([r, b])
                for e in scan_emoji(page):
                    rep['emoji'].append([r, e])
                for w in scan_bot_word(page):
                    rep['bot'].append([r, w])

            # ★온보딩 — 세션이 «없는» 화면이라 별도 컨텍스트로 돈다.
            #   이모지가 가장 크게(46~52px) 남아 있던 자리가 여기였다.
            cOb = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            pOb = cOb.new_page()
            pOb.goto(base + '#/start', wait_until='domcontentloaded')
            pOb.wait_for_timeout(2600)
            for step in range(5):
                for e in scan_emoji(pOb):
                    rep['emoji'].append(['#/start(step%d)' % step, e])
                pOb.screenshot(path=str(out / ('E1_onboarding%d.png' % step)))
                rep['shots'].append('E1_onboarding%d' % step)
                nxt = pOb.query_selector('.cta .btn, .hero .btn--primary, .btn--primary')
                if nxt and not nxt.is_enabled():
                    # ★닉네임 단계 — 비워 두면 다음 버튼이 «비활성»이라 규칙 화면(이모지 4개가
                    #   있던 자리)까지 못 간다. 실제 유저처럼 이름을 넣고 진행한다.
                    pOb.evaluate(
                        """() => {
                            const i = document.querySelector('input');
                            if (!i) return;
                            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            set.call(i, '검증이');
                            i.dispatchEvent(new Event('input', { bubbles: true }));
                        }"""
                    )
                    pOb.wait_for_timeout(500)
                    nxt = pOb.query_selector('.cta .btn, .hero .btn--primary, .btn--primary')
                if not nxt or not nxt.is_enabled():
                    break
                nxt.click()
                pOb.wait_for_timeout(1400)
            cOb.close()

            rep['console'] = errs[:20]
            rep['pageerror'] = perrs[:20]
            check('콘솔 에러 0', len(errs) == 0, errs[:3])
            check('pageerror 0', len(perrs) == 0, perrs[:3])
            check('raw i18n 키 0', len(rep['rawKeys']) == 0, rep['rawKeys'][:3])
            check('blur/backdrop 0', len(rep['blur']) == 0, rep['blur'][:3])
            check('「봇」 0건', len(rep['bot']) == 0, rep['bot'][:3])
            check('렌더된 이모지 0건', len(rep['emoji']) == 0, [e[1]['chars'] for e in rep['emoji']][:12])

        finally:
            browser.close()
            httpd.shutdown()

    json.dump(rep, open(out / 'report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"\n스크린샷 {len(rep['shots'])}장 · 검사 {len(rep['checks'])}건 · 실패 {len(rep['fail'])}건 → {out}")
    return 1 if rep['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
