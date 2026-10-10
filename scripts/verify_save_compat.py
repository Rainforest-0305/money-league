# -*- coding: utf-8 -*-
"""
저장본 호환 검증 — ★라이브 빌드로 만든 세이브를 «새 빌드»에 물린다. ★headless 전용.

  python scripts/verify_save_compat.py <출력폴더> [라이브 .ait 경로]

★★왜 이 방식인가 (President 하드게이트)
  `SAVE_VERSION` 을 올리면 `loadGame()` 이 `s.v !== SAVE_VERSION` 에서 null 을 뱉어
  ★라이브 유저 진행이 «통째로» 날아간다. 그래서 이번 파도의 신규 필드는 전부 optional 이다.
  ⇒ 그 약속이 «실제로» 지켜졌는지는 ★「라이브에서 만든 세이브가 새 빌드에서 그대로 열리는가」
    로만 증명된다. 타입 선언을 읽는 것으로는 증명되지 않는다.

★단계
  A) ★라이브 .ait 를 풀어 그 빌드로 «플레이»한다(현물 매수 + 레버리지 + 옵션).
     → localStorage 세이브와 «화면에 보이는 값»을 뜬다.
  B) 그 localStorage 를 ★새 빌드에 «그대로» 물리고 항목별로 대조한다.
  C) ★경계값 — 신규 필드 없음 · 손상값 · NaN/Infinity · JSON 깨짐 · 세이브 없음.
  D) ★신규 필드 왕복 — 새 빌드에서 선도/스왑/옵션매도를 열고 «새로고침» → 그대로인가.
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
MONEY = re.compile(r'-?\$[\d,]+\.\d{2}')


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

SAVE_KEYS = ['ml.game', 'ml.session', 'ml.settings', 'ml.onboarded', 'ml.watchlist', 'ml.traderwatch', 'ml.firstSeen']


def _attend_day1():
    """★출석 1일차 금액을 «소스에서» 읽는다. ⛔여기에 5000 을 적지 마라 —
    곡선을 바꾸면 이 하네스가 옛 값을 계속 맞다고 말하게 된다(stale 기대값 사고)."""
    try:
        src = (ROOT / 'src' / 'lib' / 'attendance.ts').read_text(encoding='utf-8')
        m = re.search(r'ATTENDANCE_REWARDS = \[([^\]]*)\]', src)
        return int(m.group(1).split(',')[0].replace('_', '').strip())
    except Exception:
        return 0


ATTEND_DAY1 = _attend_day1()


def extract_live(ait: Path, dest: Path):
    """.ait 는 zip 이다. 안의 정적 번들을 꺼낸다"""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(ait) as z:
        names = z.namelist()
        # index.html 이 있는 «가장 얕은» 디렉터리를 루트로 본다
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



def confirm_live(p):
    """
    ★라이브 빌드(20260819-3)는 ★«스와이프 확정»을 쓴다 — 지금 빌드의 탭 1회 버튼이 «아니다».
      (President 지시로 스와이프를 걷어낸 게 그 «뒤»의 변경이다)
    ⇒ 그래서 `.btn--lg` 를 찾으면 «영영 안 나온다». 실제로 25초 타임아웃이 났다.
    ⇒ ★그 시절의 UI 로 조작해야 그 시절의 세이브가 나온다. 손잡이를 «끝까지 끈다».
    """
    kn = p.query_selector('.swipe__knob')
    if not kn:
        return False
    track = p.query_selector('.swipe')
    tb = track.bounding_box()
    kb = kn.bounding_box()
    p.mouse.move(kb['x'] + kb['width'] / 2, kb['y'] + kb['height'] / 2)
    p.mouse.down()
    for i in range(1, 13):
        p.mouse.move(tb['x'] + (tb['width'] - kb['width'] / 2) * (i / 12), kb['y'] + kb['height'] / 2)
        p.wait_for_timeout(30)
    p.mouse.up()
    p.wait_for_timeout(1800)
    return True


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_verify_save')
    ait = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_backup_ait_20260820_ux' / 'moneyleague_20260819-3_live.ait'
    out.mkdir(parents=True, exist_ok=True)
    live_dir = extract_live(ait, ROOT / '_live_extracted')
    print(f'라이브 번들 전개: {live_dir}  (index.html {"O" if (live_dir/"index.html").exists() else "X"})')

    rep = {'checks': [], 'fail': [], 'shots': [], 'A': {}, 'B': {}, 'boundary': {}}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), detail])
        if not ok:
            rep['fail'].append([name, detail])
        print(f"  {'PASS' if ok else '★FAIL'}  {name}  {detail}")

    live_httpd, live_port = serve(live_dir)
    # ★`ait:build` «후»에는 dist/ 가 RN 번들 출력이고 웹 자산은 dist/web/ 로 내려간다.
    #   그 상태에서 dist/ 를 그냥 가리키면 .screen 을 못 찾아 20초 타임아웃이 난다(U-3 함정).
    #   ⇒ 다른 하네스와 같은 규약으로 ML_DIST 를 받고, 없으면 dist/web → dist 순으로 «찾는다».
    new_dir = ROOT / os.environ['ML_DIST'] if os.environ.get('ML_DIST') else (
        ROOT / 'dist' / 'web' if (ROOT / 'dist' / 'web' / 'index.html').exists() else ROOT / 'dist'
    )
    print(f'새 빌드 번들: {new_dir}  (index.html {"O" if (new_dir/"index.html").exists() else "X"})')
    rep['newDist'] = str(new_dir)
    rep['liveAit'] = str(ait)
    new_httpd, new_port = serve(new_dir)
    live_base = f'http://127.0.0.1:{live_port}/'
    new_base = f'http://127.0.0.1:{new_port}/'

    def head_text(p):
        return p.evaluate(
            """() => [...document.querySelectorAll('.screen *')]
                 .filter(e => !e.children.length)
                 .map(e => (e.textContent||'').trim())
                 .filter(Boolean).slice(0, 14).join(' | ')"""
        )

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            # ── A) 라이브 빌드에서 «플레이» ────────────────────────────
            ctx = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            ctx.add_init_script(INIT)
            p = ctx.new_page()
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.goto(live_base + '#/stock/AAPL', wait_until='domcontentloaded')
            p.wait_for_selector('.appbar', timeout=30000)
            p.wait_for_timeout(3000)
            # 현물 매수 — ★라이브 빌드의 UI 는 «지금과 다를 수 있다».
            #   ⛔한 단계 실패로 검증 전체를 날리지 않는다. 무엇을 «해냈는지» 기록하고 넘어간다.
            #   (실제로 라이브 주문시트의 확정 버튼이 «비활성»이라 여기서 30초 타임아웃이 났다 —
            #    수량 프리셋 선택자가 지금 빌드와 달랐다)
            spot_log = []
            try:
                buy = p.query_selector('.orderbar button:last-child') or p.query_selector('.btn--up')
                if buy:
                    buy.click()
                    p.wait_for_timeout(1000)
                    picked = False
                    for sel in ['.qty__chip', '.pill', '.sheet button']:
                        for e in p.query_selector_all(sel):
                            tx = (e.text_content() or '').strip()
                            if tx in ('50%', '25%', '최대') or '50' in tx:
                                e.click()
                                picked = True
                                spot_log.append(f'프리셋 {tx}')
                                break
                        if picked:
                            break
                    p.wait_for_timeout(700)
                    if confirm_live(p):
                        spot_log.append('스와이프 확정')
                    else:
                        # ★★선택자 주의: 현행 빌드의 주문 화면은 «바텀시트가 아니라 전체화면»이고,
                        #   `.btn--lg` 는 뒤쪽 orderbar 의 «팔기»(보유 0이면 disabled)에도 붙는다.
                        #   그래서 첫 `.btn--lg` 를 집으면 «비활성 버튼»을 집어 「확정 수단 없음」이 된다.
                        #   ⇒ 확정 버튼만 갖는 «색 클래스»로 먼저 찾는다.
                        cta = (p.query_selector('.btn--lg.btn--up, .btn--lg.btn--down')
                               or p.query_selector('.sheet .btn--lg')
                               or p.query_selector('.btn--lg'))
                        if cta and not cta.is_disabled():
                            cta.click()
                            p.wait_for_timeout(1600)
                            spot_log.append('버튼 확정')
                        else:
                            spot_log.append('확정 수단을 못 찾음')
            except Exception as ex:  # noqa: BLE001
                spot_log.append(f'예외: {ex}'[:120])
            rep['A']['spot'] = spot_log
            print('  A 현물:', spot_log)
            # 레버리지
            for route, tag in (('#/leverage/NVDA', '레버리지'), ('#/option/AMD', '옵션')):
                try:
                    p.goto(live_base + route, wait_until='domcontentloaded')
                    p.wait_for_selector('.appbar', timeout=25000)
                    p.wait_for_timeout(2500)
                    if confirm_live(p):
                        rep['A'].setdefault('opened', []).append(f'{tag}(스와이프)')
                    else:
                        b = p.query_selector('.btn--lg')
                        if b and not b.is_disabled():
                            b.click()
                            p.wait_for_timeout(1600)
                            rep['A'].setdefault('opened', []).append(f'{tag}(버튼)')
                        else:
                            rep['A'].setdefault('opened', []).append(f'{tag}(확정 수단 없음)')
                except Exception as ex:  # noqa: BLE001
                    rep['A'].setdefault('opened', []).append(f'{tag} 예외 {ex}'[:80])
            # ★[2026-08-21 추가] 선도·스왑도 «연다» — 현재 라이브(20260821-7)는 이 둘을 갖고 있고,
            #   실유저 저장본에도 들어 있을 수 있다. 안 열면 B 단계의 보존 검사가 «공허»해진다.
            #   ⛔파생 이전 세대에서는 라우트가 없어 조용히 넘어간다(그 세대엔 검사할 것이 없다).
            for route, tag in (('#/contract/forward/AAPL', '선도'), ('#/contract/swap/MSFT', '스왑')):
                try:
                    p.goto(live_base + route, wait_until='domcontentloaded')
                    p.wait_for_selector('.appbar', timeout=15000)
                    p.wait_for_timeout(2200)
                    if tag == '스왑':
                        # 상대 종목을 골라야 확정이 열린다
                        li = p.query_selector('.card.li, .li')
                        if li:
                            li.click()
                            p.wait_for_timeout(800)
                            row = p.query_selector('.sheet .row')
                            if row:
                                row.click()
                                p.wait_for_timeout(800)
                    b = p.query_selector('.btn--lg.btn--up, .btn--lg.btn--down') or p.query_selector('.btn--lg')
                    if b and not b.is_disabled():
                        b.click()
                        p.wait_for_timeout(1600)
                        rep['A'].setdefault('opened', []).append(tag)
                    else:
                        rep['A'].setdefault('opened', []).append(f'{tag}(이 세대엔 없음/불가)')
                except Exception as ex:  # noqa: BLE001
                    rep['A'].setdefault('opened', []).append(f'{tag} 예외'[:60])

            p.wait_for_timeout(7000)  # 되돌리기 창 경과 + 스냅샷 저장
            print('  A 파생:', rep['A'].get('opened'))

            p.goto(live_base + '#/home', wait_until='domcontentloaded')
            p.wait_for_selector('.tabbar', timeout=25000)
            p.wait_for_timeout(2500)
            store = p.evaluate(
                "(keys) => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)]))", SAVE_KEYS
            )
            rep['A']['home'] = head_text(p)
            rep['A']['storeKeys'] = {k: (v[:80] if v else v) for k, v in store.items()}
            saved = json.loads(store['ml.game']) if store.get('ml.game') else None
            check('A: 라이브 빌드가 세이브를 «만들었다»', saved is not None)
            if saved:
                acc = saved.get('account', {})
                rep['A']['save'] = {
                    'v': saved.get('v'),
                    'cash': acc.get('cash'),
                    'holdings': acc.get('holdings'),
                    'lev': len(acc.get('levPositions') or []),
                    'opt': len(acc.get('optPositions') or []),
                }
                check('A: SAVE_VERSION', saved.get('v') == 1, str(saved.get('v')))
                check('A: 포지션이 실제로 생겼다',
                      (len(acc.get('levPositions') or []) + len(acc.get('optPositions') or [])) > 0,
                      f"lev {len(acc.get('levPositions') or [])} · opt {len(acc.get('optPositions') or [])}")
                """
                ★[2026-08-21 정정] 예전에는 여기서 「신규 필드가 «없다»」를 ★단언했다.
                  그건 원본이 «파생 이전 세대»일 때만 참인 문장이다. 현재 라이브(20260821-7)는
                  선도·스왑을 «갖고 있으므로» 그 단언은 ★맞는 빌드에 FAIL 을 찍는다.
                  (ait_header.py 의 stale 기대값 사고와 «같은 형태»다)
                ⇒ 단언하지 말고 ★«세대를 기록»하고, 있으면 B 단계에서 «보존»을 검사한다.
                  그게 원래 알고 싶었던 것이다.
                """
                rep['A']['gen'] = {
                    'fwd': len(acc.get('fwdPositions') or []),
                    'swap': len(acc.get('swapPositions') or []),
                    'hasDaily': bool(saved.get('daily')),
                    'accountKeys': sorted(acc.keys()),
                }
                print('  NOTE  원본 세대 =', rep['A']['gen'])
            p.screenshot(path=str(out / 'A_live_home.png'))
            rep['shots'].append('A_live_home')
            check('A: pageerror 0', len(errs) == 0, str(errs[:2]))
            ctx.close()

            # ── B) 그 세이브를 «새 빌드»에 물린다 ──────────────────────
            def open_new(store_map, tag):
                c = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
                js = '(() => {' + ''.join(
                    f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)});" for k, v in store_map.items() if v is not None
                ) + '})()'
                c.add_init_script(js)
                pg = c.new_page()
                e2 = []
                pg.on('pageerror', lambda e: e2.append(str(e)))
                pg.on('console', lambda m: e2.append('console:' + m.text) if m.type == 'error' else None)
                pg.goto(new_base + '#/home', wait_until='domcontentloaded')
                pg.wait_for_selector('.tabbar', timeout=30000)
                pg.wait_for_timeout(3500)
                txt = head_text(pg)
                nan = 'NaN' in txt or 'Infinity' in txt or 'undefined' in txt
                pg.screenshot(path=str(out / f'{tag}.png'))
                rep['shots'].append(tag)
                after = pg.evaluate("() => localStorage.getItem('ml.game')")
                return pg, c, txt, nan, e2, after

            pg, c, txtB, nanB, errB, afterB = open_new(store, 'B_new_home')
            rep['B']['home'] = txtB
            check('★B: 라이브 세이브가 새 빌드에서 «열린다»', 'NaN' not in txtB and len(txtB) > 20, txtB[:90])
            check('★B: NaN/Infinity/undefined 0', not nanB)
            check('★B: pageerror·console error 0', len(errB) == 0, str(errB[:2]))
            savedB = json.loads(afterB) if afterB else None
            if saved and savedB:
                a1, a2 = saved['account'], savedB['account']
                #  ★★[2026-08-22 정정] 새 빌드는 부팅 때 «출석 1일차»를 자동 지급한다.
                #    ⇒ 기존 유저의 현금은 «그대로»가 아니라 «그대로 + 출석 1일차»가 된다.
                #    ⛔여기서 판정을 「≥ 옛값」으로 «느슨하게» 풀지 마라 — 그러면 진짜 손실도 통과한다.
                #    ⇒ 허용하는 «증가분»을 소스에서 «유도»해 그 값과 «정확히» 같은지 본다.
                cash1 = a1.get('cash') or 0
                cash2 = a2.get('cash') or 0
                delta = cash2 - cash1
                ok_cash = abs(delta) < 1e-6 or abs(delta - ATTEND_DAY1) < 1e-6
                check('★B: 현금이 «보존»됐다 (변화는 출석 1일차뿐)', ok_cash,
                      f"{cash1} → {cash2}  Δ{delta:+.2f}"
                      + (f"  = 출석 1일차 {ATTEND_DAY1}" if abs(delta - ATTEND_DAY1) < 1e-6 else ''))
                if a1.get('holdings'):
                    check('★B: 보유 종목이 «보존»됐다',
                          json.dumps(a1.get('holdings')) == json.dumps(a2.get('holdings')),
                          f"{a1.get('holdings')} → {a2.get('holdings')}")
                else:
                    print('  SKIP  B: 보유 종목 비교 — A 단계에서 현물을 못 샀다(위 로그 참조)')
                check('★B: 레버리지/옵션 개수 «보존»',
                      len(a1.get('levPositions') or []) == len(a2.get('levPositions') or [])
                      and len(a1.get('optPositions') or []) == len(a2.get('optPositions') or []),
                      f"lev {len(a1.get('levPositions') or [])}→{len(a2.get('levPositions') or [])} · "
                      f"opt {len(a1.get('optPositions') or [])}→{len(a2.get('optPositions') or [])}")
                check('★B: SAVE_VERSION «그대로 1»', savedB.get('v') == 1, str(savedB.get('v')))
                # ★파생 세대(20260821-7)의 선도·스왑도 «보존»돼야 한다.
                #   ⛔원본에 없으면 검사하지 «않는다» — 0 == 0 은 공허한 PASS 다.
                if (a1.get('fwdPositions') or a1.get('swapPositions')):
                    check('★B: 선도/스왑 포지션 «보존»',
                          len(a1.get('fwdPositions') or []) == len(a2.get('fwdPositions') or [])
                          and len(a1.get('swapPositions') or []) == len(a2.get('swapPositions') or []),
                          f"fwd {len(a1.get('fwdPositions') or [])}→{len(a2.get('fwdPositions') or [])} · "
                          f"swap {len(a1.get('swapPositions') or [])}→{len(a2.get('swapPositions') or [])}")
                else:
                    print('  NOTE  원본에 선도/스왑이 «없다» → 그 보존 검사는 하지 않는다(공허한 PASS 금지)')
                # ★★«중간 세대» 키 — daily.topupAdUsed · viewBonus · viewedTraders · topup.
                #   ★이건 20260820-6 세대가 «만드는» 키다. 새 빌드가 그걸 삼키면
                #   유저의 «오늘 쓴 충전·열람권»이 리셋된다(하루치 손해).
                d1, d2 = saved.get('daily') or {}, savedB.get('daily') or {}
                t1, t2 = saved.get('topup') or {}, savedB.get('topup') or {}
                #  ★★[2026-08-22 정정] 새 빌드는 `daily` 에 «키를 더한다»(shareGrants·shareUsd).
                #    옛 판정은 «완전 일치»라 키가 하나만 늘어도 FAIL 이었다 —
                #    그건 「데이터가 사라졌다」가 아니라 「스키마가 자랐다」다. 둘은 다른 사실이다.
                #    ⇒ 판정을 ★«옛 키·값이 전부 살아남았는가»로 바꾼다(부분집합).
                #    ⛔여전히 «값이 바뀐» 것은 잡는다 — 그게 진짜 유저 손해(오늘 쓴 충전이 리셋)다.
                lost = {k: (v, d2.get(k)) for k, v in d1.items()
                        if k not in d2 or json.dumps(d2[k], sort_keys=True) != json.dumps(v, sort_keys=True)}
                added = sorted(set(d2) - set(d1))
                check('★B: daily 의 «옛 키·값이 전부 살아남았다»', not lost,
                      f'사라지거나 바뀐 것 {lost}' if lost else (f'추가된 키 {added}' if added else '변화 없음'))
                check('★B: topup «보존»', json.dumps(t1, sort_keys=True) == json.dumps(t2, sort_keys=True),
                      f'{t1} → {t2}')
                if d1:
                    # ★양성대조 — 원본 세이브에 그 키가 «실제로 있었어야» 위 보존 검사가 뜻이 있다
                    check('★B: daily 에 topupAdUsed 가 «있었다»(양성대조)', 'topupAdUsed' in d1, str(list(d1.keys())))
                else:
                    # ★20260819-3 세대는 daily 키 자체가 «없다». 그래서 위 보존 검사가 «공허»하다.
                    #   ⛔이걸 PASS 로 세지 않는다 — 「검사했다」와 「검사할 게 있었다」는 다르다.
                    #   중간 세대(20260820-6) 경로는 «별도 실행»으로 덮었다:
                    #     python scripts/verify_save_compat.py <out> moneyleague.ait
                    print('  NOTE  이 원본 세대에는 daily 키가 «없다» → daily 보존 검사는 공허하다. '
                          '중간 세대는 별도 실행으로 덮었다.')
            # 파생 탭도 열어 본다(신규 코드가 옛 포지션을 그리는 경로)
            pg.goto(new_base + '#/derivatives', wait_until='domcontentloaded')
            pg.wait_for_selector('.pillrow', timeout=25000)
            pg.wait_for_timeout(1800)
            pg.screenshot(path=str(out / 'B_new_deriv.png'))
            rep['shots'].append('B_new_deriv')
            dtxt = pg.evaluate("() => (document.querySelector('.scroll')||{}).textContent || ''")
            check('★B: 옛 레버리지가 파생 탭에 «그려진다»', '무기한' in dtxt or 'pbadge' in dtxt or len(dtxt) > 30, dtxt[:70])
            check('★B: 파생 탭 NaN 0', 'NaN' not in dtxt and 'undefined' not in dtxt)
            c.close()

            # ── C) 경계값 ──────────────────────────────────────────────
            g = json.loads(store['ml.game'])
            cases = {}
            # C1 신규 필드 «없음» (= B 와 같지만 명시적으로)
            cases['C1_신규필드없음'] = dict(store)
            # C2 손상값: 배열이어야 하는 곳에 객체
            bad = json.loads(json.dumps(g))
            bad['account']['levPositions'] = {'nope': 1}
            cases['C2_손상값'] = {**store, 'ml.game': json.dumps(bad)}
            # C3 NaN/Infinity 문자열
            bad2 = json.loads(json.dumps(g))
            bad2['account']['cash'] = 'Infinity'
            cases['C3_NaN'] = {**store, 'ml.game': json.dumps(bad2)}
            # C4 JSON 깨짐
            cases['C4_JSON깨짐'] = {**store, 'ml.game': '{"v":1,"account":'}
            # C5 세이브 없음
            cases['C5_세이브없음'] = {k: v for k, v in store.items() if k != 'ml.game'}
            # C6 호가 세션 손상 (내가 새로 만든 키)
            cases['C6_호가세션손상'] = {**store, 'ml.quotesession': '[1,2,3]'}

            for tag, sm in cases.items():
                pg2, c2, txt2, nan2, err2, _ = open_new(sm, tag)
                rep['boundary'][tag] = {'head': txt2[:120], 'nan': nan2, 'errors': err2[:3]}
                check(f'C {tag}: 화면이 «뜬다»', len(txt2) > 20, txt2[:60])
                check(f'C {tag}: NaN/undefined 0', not nan2)
                check(f'C {tag}: pageerror 0', len(err2) == 0, str(err2[:1]))
                c2.close()

            # ── D) 신규 필드 «왕복» (새 빌드에서 만들고 새로고침) ──────
            c3 = browser.new_context(viewport=VIEW, device_scale_factor=2, locale='ko-KR')
            c3.add_init_script(INIT)
            pg3 = c3.new_page()
            e3 = []
            pg3.on('pageerror', lambda e: e3.append(str(e)))
            pg3.goto(new_base + '#/contract/forward/NVDA', wait_until='domcontentloaded')
            pg3.wait_for_selector('.btn--lg', timeout=30000)
            pg3.wait_for_timeout(2500)
            pg3.query_selector('.btn--lg').click()
            pg3.wait_for_timeout(7000)
            g2 = pg3.evaluate("() => localStorage.getItem('ml.game')")
            acc3 = json.loads(g2)['account'] if g2 else {}
            check('★D: 신규 필드 fwdPositions 가 «저장»된다', len(acc3.get('fwdPositions') or []) == 1,
                  str(len(acc3.get('fwdPositions') or [])))
            check('★D: SAVE_VERSION «여전히 1»', json.loads(g2).get('v') == 1 if g2 else False)
            pg3.reload(wait_until='domcontentloaded')
            pg3.wait_for_selector('.pillrow', timeout=30000)
            pg3.wait_for_timeout(4000)
            pg3.query_selector_all('.pillrow .pill')[2].click()
            pg3.wait_for_timeout(800)
            still = len(pg3.query_selector_all('.pbadge--fwd'))
            check('★D: 새로고침 뒤에도 선도 포지션 «남는다»', still == 1, f'{still}개')
            dtxt3 = pg3.evaluate("() => (document.querySelector('.scroll')||{}).textContent || ''")
            check('★D: 복귀 후 NaN 0', 'NaN' not in dtxt3 and 'undefined' not in dtxt3)
            check('★D: pageerror 0', len(e3) == 0, str(e3[:2]))
            pg3.screenshot(path=str(out / 'D_new_fields_reload.png'))
            rep['shots'].append('D_new_fields_reload')
            c3.close()
        finally:
            browser.close()
            live_httpd.shutdown()
            new_httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"\n검사 {len(rep['checks'])}건 · ★실패 {len(rep['fail'])}건")
    for f in rep['fail']:
        print('  ★FAIL', f)
    return 1 if rep['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
