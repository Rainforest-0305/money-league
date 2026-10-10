# -*- coding: utf-8 -*-
"""
옵션 주문 «실동작» 검증 — 행사가 사다리 + 매수/매도 × 콜/풋 × ITM/ATM/OTM. ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_options.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_options.py <출력폴더>   # ★출하물 검증

★★무엇을 증명하려는 파일인가 (2026-08-21 President 지적)
  「현재가보다 낮은 가격의 콜옵션 구매가 안 되는데?」
  ⇒ ★딥 ITM 콜을 «실제로 사본다». 사다리 숫자만 보는 것은 `check_strikes.mjs` 의 몫이고,
    여기는 ★버튼을 눌러 체결까지 간다.

★★같이 증명하는 것
  ① 화면이 말하는 필요현금 = 엔진이 요구하는 필요현금 (경계에서 INSUFFICIENT_CASH 가 «안» 난다)
     → 「최대」 프리셋을 누르고 그대로 확정한다. 화면이 「살 수 있다」고 한 최대치다.
  ② ★버튼이 죽어 있으면 «이유가 화면에 있다» — 회색 버튼만 남는 상태를 «불변식»으로 금지한다.
     (예전에는 `disabled={cash < payNow}` 뿐이라 아무 말도 안 했다)
  ③ 매도 경로는 증거금 식이 매수와 «완전히 다르다»(8-4장). 같이 누른다.

★★대조를 «먼저» 통과해야 결과를 낸다.
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


def save_blob(cash):
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {'cash': cash, 'holdings': [], 'levPositions': [], 'optPositions': [],
                    'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 2,
                    'liquidationCount': 0, 'topupCount': 0},
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    })


def init_js(lang='ko', theme='light', cash=None):
    parts = [
        "localStorage.setItem('ml.onboarded','1');",
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));",
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));" % (lang, theme),
    ]
    if cash is not None:
        parts.append("localStorage.setItem('ml.game', %s);" % json.dumps(save_blob(cash)))
    return '(() => {' + ''.join(parts) + '})()'


# ── 화면 읽기 ─────────────────────────────────────────────────────────────
# 행사가 칩 = `aria-pressed` 를 가진 버튼 중 만기 알약(.pill)·수량 프리셋(.qty__chip) 이 아닌 것.
STRIKES_JS = r"""() => {
  const btns = [...document.querySelectorAll('button[aria-pressed]')]
      .filter(b => !b.classList.contains('pill') && !b.classList.contains('qty__chip'));
  const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  const spotEl = document.querySelector('.appbar .num');
  /* ★[2026-09-05] 칩은 «1계약 비용»을 적는다(주당 프리미엄이 아니다). 그래서 하한 임계값도
     계약 크기만큼 커진다. ⛔여기에 10 을 박지 마라 — 계약 크기는 종목마다 다르다.
     ⇒ «화면이 스스로 인쇄한 값»(비용 카드의 「1계약 = N주 기준」)에서 읽는다. */
  const spcM = (document.querySelector('.screen') || document.body).innerText
      .match(/1계약\s*=\s*([0-9.]+)\s*주|1 contract = ([0-9.]+) shares/);
  return {
    spot: spotEl ? num(spotEl.textContent) : null,
    sharesPerContract: spcM ? Number(spcM[1] ?? spcM[2]) : null,
    chips: btns.map(b => {
      const ns = [...b.querySelectorAll('.num')].map(e => e.textContent.trim());
      return { k: num(ns[0]), kText: ns[0], prem: num(ns[1]), on: b.getAttribute('aria-pressed') === 'true' };
    }),
  };
}"""

# ★핵심 불변식 판정기: 「확정 버튼이 죽었다」 ⇒ 「이유가 화면에 있다」
STATE_JS = r"""() => {
  const btn = document.querySelector('.btn.btn--lg');
  // ★확정 버튼과 「막힌 이유」는 «스크롤 밖»(고정 푸터)에 있다 — 화면 전체를 읽는다.
  const txt = (document.querySelector('.screen') || document.body).innerText;
  return {
    disabled: !!(btn && btn.disabled),
    btnText: btn ? btn.innerText.replace(/\n/g, ' ') : null,
    hasReason: /1계약에|per contract/.test(txt),
    hasMaxLine: /지금 현금으로 최대|Up to .* contracts/.test(txt),
    hasSwitch: /행사가로 바꾸기|Switch to the/.test(txt),
    errNote: (() => { const n = [...document.querySelectorAll('.note')]
        .map(e => e.innerText.trim()).filter(Boolean); return n; })(),
  };
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_options')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'dist': str(DIST), 'checks': [], 'ladders': [], 'orders': []}
    fails = []

    def check(name, ok, detail=''):
        rep['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            fails.append(f'{name}  {detail}')
        print(('  PASS  ' if ok else '  ★FAIL ') + name + (('  ' + str(detail)) if detail != '' else ''))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init_js())
            page = ctx.new_page()
            errs, perrs = [], []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: perrs.append(str(e)))

            # ── ① 대조 ────────────────────────────────────────────────
            print('\n① ★대조 (검사기 생존 증명)')
            page.goto(base + '#/option/NVDA', wait_until='domcontentloaded')
            page.wait_for_selector('.btn.btn--lg', timeout=25000)
            page.wait_for_timeout(2500)
            page.evaluate("() => console.error('NEEDLE_CONSOLE')")
            page.wait_for_timeout(150)
            check('①-a [양성] 콘솔 에러 수집기가 살아 있다', any('NEEDLE_CONSOLE' in c for c in errs))
            page.evaluate("() => setTimeout(() => { throw new Error('NEEDLE_PAGE'); }, 0)")
            page.wait_for_timeout(250)
            check('①-b [양성] pageerror 수집기가 살아 있다', any('NEEDLE_PAGE' in e for e in perrs))
            base_n = len(page.evaluate(STRIKES_JS)['chips'])
            check('①-c 행사가 칩이 4개다', base_n == 4, base_n)
            page.evaluate("""() => { const b=document.createElement('button');
                b.id='__nk'; b.setAttribute('aria-pressed','false');
                b.innerHTML='<span class="num">$1</span><span class="num">$2</span>';
                document.querySelector('.scroll').appendChild(b); }""")
            n1 = len(page.evaluate(STRIKES_JS)['chips'])
            check('①-d [양성] 칩 세는 눈이 «니들»을 잡는다', n1 == base_n + 1, f'{base_n} -> {n1}')
            page.evaluate("() => document.getElementById('__nk')?.remove()")
            n2 = len(page.evaluate(STRIKES_JS)['chips'])
            check('①-e [음성] 니들을 빼면 원래대로', n2 == base_n, f'{n1} -> {n2}')
            st = page.evaluate(STATE_JS)
            check('①-f [음성] 시드 상태에서는 버튼이 «살아 있다»', not st['disabled'], st['btnText'])
            page.evaluate("""() => { const d=document.createElement('div');
                d.id='__nr'; d.textContent='1계약에 $999 · 지금 현금 $1'; document.querySelector('.scroll').appendChild(d); }""")
            check('①-g [양성] 「이유 문구」 판정기가 살아 있다', page.evaluate(STATE_JS)['hasReason'])
            page.evaluate("() => document.getElementById('__nr')?.remove()")
            check('①-h [음성] 니들을 빼면 이유 문구가 «없다»', not page.evaluate(STATE_JS)['hasReason'])
            ctx.close()
            if fails:
                raise SystemExit('대조 실패 — 아래 숫자는 무효다')
            errs.clear()
            perrs.clear()

            # ── ② 사다리 실렌더 (President 가 본 종목 포함) ────────────
            print('\n② 행사가 사다리 실렌더')
            TICKERS = ['NVDA', 'AAPL', 'APH', 'MU', 'C', 'GOOGL']
            for tk in TICKERS:
                for kind_i, kind in ((0, 'call'), (1, 'put')):
                    ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                    ctx.add_init_script(init_js())
                    page = ctx.new_page()
                    page.goto(base + f'#/option/{tk}', wait_until='domcontentloaded')
                    page.wait_for_selector('.btn.btn--lg', timeout=25000)
                    page.wait_for_timeout(2200)
                    page.get_by_role('tab').nth(kind_i).click()
                    page.wait_for_timeout(500)
                    d = page.evaluate(STRIKES_JS)
                    spot, chips = d['spot'], d['chips']
                    rep['ladders'].append({'ticker': tk, 'kind': kind, 'spot': spot, 'chips': chips})
                    ks = [c['k'] for c in chips]
                    itm = [k for k in ks if (k < spot if kind == 'call' else k > spot)]
                    on = [c for c in chips if c['on']]
                    step = (max(ks) - min(ks)) / 3 if len(ks) == 4 else 0
                    check(f'{tk} {kind}: 칩 4개', len(chips) == 4, ks)
                    # ★ATM 칩이 현재가의 «어느 쪽»에 떨어지느냐에 따라 ITM 은 2개 또는 3개다.
                    #   (예: NVDA put spot 389.94 · ATM 390 → 390 도 ITM 이다) ⇒ 하한만 본다.
                    check(f'{tk} {kind}: ITM 칩 2개 이상', len(itm) >= 2, f'spot={spot} ks={ks} itm={itm}')
                    check(f'{tk} {kind}: 간격 {step:.2f} = 현재가의 {(step/spot*100 if spot else 0):.1f}% (≤5%)',
                          spot and step / spot <= 0.05, '')
                    check(f'{tk} {kind}: 기본 선택이 ATM 이다',
                          len(on) == 1 and abs(on[0]['k'] - spot) <= step / 2 + 0.01,
                          f'선택={on[0]["k"] if on else None} spot={spot}')
                    # ★칩은 «1계약 비용»이므로 하한도 계약 크기만큼 곱해진다(주당 $0.01 × N주).
                    #   ⛔상수 10 을 박지 마라 — 화면이 인쇄한 계약 크기를 그대로 쓴다.
                    spc = d.get('sharesPerContract')
                    check(f'{tk} {kind}: 화면이 계약 크기를 인쇄한다', bool(spc), spc)
                    floor_min = 0.0101 * (spc or 10)
                    check(f'{tk} {kind}: 프리미엄 하한(1계약 ${floor_min:.4f}) 칩 없음',
                          all(c['prem'] > floor_min for c in chips), [c['prem'] for c in chips])
                    check(f'{tk} {kind}: 칩 표기가 값과 같다',
                          all(abs(c['k'] - float(c['kText'].replace('$', '').replace(',', ''))) < 1e-9 for c in chips),
                          [c['kText'] for c in chips])
                    if tk in ('NVDA', 'APH'):
                        page.screenshot(path=str(out / f'ladder_{tk}_{kind}.png'))
                    ctx.close()

            # ── ③ 실매수/실매도 12조합 ────────────────────────────────
            print('\n③ 매수/매도 × 콜/풋 × 딥ITM/ATM/OTM — ★실제로 누른다')
            # 칩 인덱스: 콜은 오름차순 [딥ITM, ITM, ATM, OTM] · 풋은 [OTM, ATM, ITM, 딥ITM]
            SPOTS = {'call': {'딥ITM': 0, 'ATM': 2, 'OTM': 3}, 'put': {'딥ITM': 3, 'ATM': 1, 'OTM': 0}}
            for action_i, action in ((0, 'buy'), (1, 'sell')):
                for kind_i, kind in ((0, 'call'), (1, 'put')):
                    for label, idx in SPOTS[kind].items():
                        ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                        ctx.add_init_script(init_js())
                        page = ctx.new_page()
                        perr = []
                        page.on('pageerror', lambda e: perr.append(str(e)))
                        tag = f'{action}_{kind}_{label}'
                        try:
                            page.goto(base + '#/option/NVDA', wait_until='domcontentloaded')
                            page.wait_for_selector('.btn.btn--lg', timeout=25000)
                            page.wait_for_timeout(2400)
                            page.get_by_role('tab').nth(kind_i).click()
                            page.wait_for_timeout(400)
                            page.get_by_role('tab').nth(2 + action_i).click()
                            page.wait_for_timeout(400)
                            chips = [b for b in page.query_selector_all('button[aria-pressed]')
                                     if 'pill' not in (b.get_attribute('class') or '')
                                     and 'qty__chip' not in (b.get_attribute('class') or '')]
                            chips[idx].click()
                            page.wait_for_timeout(500)
                            st = page.evaluate(STATE_JS)
                            check(f'{tag}: 버튼이 살아 있다', not st['disabled'], st['btnText'])
                            if st['disabled']:
                                check(f'{tag}: (죽었다면) 이유가 화면에 있다', st['hasReason'], st)
                                ctx.close()
                                continue
                            page.click('.btn.btn--lg')
                            page.wait_for_timeout(1800)
                            hash_now = page.evaluate('() => location.hash')
                            st2 = page.evaluate(STATE_JS)
                            check(f'{tag}: 체결 후 파생 화면으로 간다', '/derivatives' in hash_now, hash_now)
                            check(f'{tag}: 오류 문구가 없다', not any('모자' in n or 'Not enough' in n for n in st2['errNote']),
                                  st2['errNote'])
                            check(f'{tag}: JS 예외 0건', not perr, perr[:1])
                            rep['orders'].append({'tag': tag, 'hash': hash_now})
                            page.screenshot(path=str(out / f'order_{tag}.png'))
                        except Exception as e:  # noqa: BLE001
                            check(f'{tag}: 진행', False, str(e)[:140])
                        finally:
                            ctx.close()

            # ── ④ 경계값 — 「최대」 계약수로 그대로 확정한다 ─────────────
            print('\n④ ★경계값 — 화면이 말한 «최대»가 엔진에서 통과하는가')
            for cash in (10000, 3000, 800, 300):
                for action_i, action in ((0, 'buy'), (1, 'sell')):
                    ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
                    ctx.add_init_script(init_js(cash=cash))
                    page = ctx.new_page()
                    tag = f'max_{action}_cash{cash}'
                    try:
                        page.goto(base + '#/option/NVDA', wait_until='domcontentloaded')
                        page.wait_for_selector('.btn.btn--lg', timeout=25000)
                        page.wait_for_timeout(2400)
                        page.get_by_role('tab').nth(2 + action_i).click()
                        page.wait_for_timeout(400)
                        # 딥 ITM 콜 = 가장 비싼 쪽으로 경계를 만든다
                        chips = [b for b in page.query_selector_all('button[aria-pressed]')
                                 if 'pill' not in (b.get_attribute('class') or '')
                                 and 'qty__chip' not in (b.get_attribute('class') or '')]
                        chips[0].click()
                        page.wait_for_timeout(400)
                        st = page.evaluate(STATE_JS)
                        if st['disabled']:
                            check(f'{tag}: 버튼이 죽었으면 ★이유가 화면에 있다', st['hasReason'], st)
                            page.screenshot(path=str(out / f'{tag}_blocked.png'))
                            ctx.close()
                            continue
                        page.click('.qty__presets button:last-child')  # 「최대」
                        page.wait_for_timeout(500)
                        st = page.evaluate(STATE_JS)
                        check(f'{tag}: 「최대」 선택 후에도 버튼이 살아 있다', not st['disabled'], st['btnText'])
                        check(f'{tag}: 잔고가 상한이면 「최대 N계약」 줄이 있다',
                              st['hasMaxLine'] or cash >= 10000, st['hasMaxLine'])
                        page.click('.btn.btn--lg')
                        page.wait_for_timeout(1800)
                        st2 = page.evaluate(STATE_JS)
                        hash_now = page.evaluate('() => location.hash')
                        check(f'{tag}: ★INSUFFICIENT_CASH 가 «안» 난다',
                              '/derivatives' in hash_now and not any('모자' in n for n in st2['errNote']),
                              f'{hash_now} {st2["errNote"]}')
                        page.screenshot(path=str(out / f'{tag}.png'))
                    except Exception as e:  # noqa: BLE001
                        check(f'{tag}: 진행', False, str(e)[:140])
                    finally:
                        ctx.close()

            # ── ⑤ ★잔고 부족 — 「막힌 이유」를 화면이 말하는가 ────────────
            print('\n⑤ ★잔고 부족 상태 — 회색 버튼만 남지 않는가')
            for lang in ('ko', 'en'):
                for cash in (200, 60, 12):
                    ctx = browser.new_context(viewport=VIEW, locale='ko-KR' if lang == 'ko' else 'en-US')
                    ctx.add_init_script(init_js(lang=lang, cash=cash))
                    page = ctx.new_page()
                    tag = f'low_{lang}_{cash}'
                    try:
                        page.goto(base + '#/option/NVDA', wait_until='domcontentloaded')
                        page.wait_for_selector('.btn.btn--lg', timeout=25000)
                        page.wait_for_timeout(2400)
                        chips = [b for b in page.query_selector_all('button[aria-pressed]')
                                 if 'pill' not in (b.get_attribute('class') or '')
                                 and 'qty__chip' not in (b.get_attribute('class') or '')]
                        chips[0].click()  # 가장 비싼 딥 ITM
                        page.wait_for_timeout(500)
                        st = page.evaluate(STATE_JS)
                        # ★불변식: 버튼이 죽었으면 이유가 «반드시» 있다
                        check(f'{tag}: 버튼이 죽으면 이유 문구가 «있다»',
                              (not st['disabled']) or st['hasReason'], st)
                        page.screenshot(path=str(out / f'{tag}.png'))
                        if st['disabled'] and st['hasSwitch']:
                            # 「~ 행사가로 바꾸기」를 누르면 «살 수 있게» 돼야 한다
                            page.evaluate("""() => {
                                const b = [...document.querySelectorAll('button')]
                                    .find(e => /행사가로 바꾸기|Switch to the/.test(e.textContent||''));
                                if (b) b.click();
                            }""")
                            page.wait_for_timeout(600)
                            st2 = page.evaluate(STATE_JS)
                            check(f'{tag}: 「행사가로 바꾸기」를 누르면 버튼이 «살아난다»',
                                  not st2['disabled'], st2['btnText'])
                            page.screenshot(path=str(out / f'{tag}_switched.png'))
                    except Exception as e:  # noqa: BLE001
                        check(f'{tag}: 진행', False, str(e)[:140])
                    finally:
                        ctx.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    ok = len([c for c in rep['checks'] if c['ok']])
    print(f'\n검사 {ok}/{len(rep["checks"])} PASS · 산출: {out}')
    if fails:
        print('\nFAILED:')
        for f in fails:
            print('  ' + f)
        sys.exit(1)


if __name__ == '__main__':
    main()
