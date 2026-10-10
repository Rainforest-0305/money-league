# -*- coding: utf-8 -*-
"""
대출·연체 «실렌더» 검증 — ★headless 전용. ⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_loan_ui.py <출력폴더>

★★무엇을 증명하나 (2026-09-05 President 지시 3건)
  ① 충전 화면의 「충전」 버튼 «옆»에 「대출」 버튼이 «같은 행»에 있다
  ② 연체 중(cash<0)이면 대출 버튼이 죽고 «이유»가 화면에 있다
  ③ 연체 중에는 무료·광고 충전이 «둘 다» 잠긴다
  ④ 대출 화면이 한도·금리·순자산·만기 규칙을 그린다
  ⑤ 실제로 빌리면 순자산이 «안 변한다»(화면 숫자로)
  ⑥ 상환 버튼이 동작한다
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


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def kst_today():
    """KST 날짜키 — 출석 보상을 «이미 받은 것»으로 만들어 잔고를 흔들지 않게 한다."""
    import datetime

    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)).strftime('%Y-%m-%d')


def init(cash, holdings=None, block_attendance=False):
    save = {
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {
            'cash': float(cash),
            'holdings': holdings or [],
            'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
            'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 3,
            'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0,
        },
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    att = ''
    if block_attendance:
        # ★출석 보상($5,000)이 «오늘 이미 지급된» 상태로 만든다.
        #   ⛔안 막으면 파산 시나리오에서 잔고가 $5,050 이 되어 파산 phase 가 «안 나온다»
        #     (2026-09-06 실측으로 발견 — 화면을 안 봤으면 몰랐을 함정).
        att = "localStorage.setItem('ml.attendance', JSON.stringify({streak:1,lastClaimedDate:'%s',lastDoubledDate:null,totalUsd:5000}));" % kst_today()
    return (
        "(() => {localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        + att +
        "localStorage.setItem('ml.game', %s);})()" % json.dumps(json.dumps(save))
    )


TEXT = "() => (document.querySelector('.screen') || document.body).innerText"
BTNS = """() => [...document.querySelectorAll('button')].map(b => ({
  t: (b.innerText || '').replace(/\\n/g, ' ').trim(), d: !!b.disabled,
  r: (() => { const x = b.getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height) }; })(),
}))"""
LINES = """() => [...document.querySelectorAll('button')].map(b => {
  const r = b.getBoundingClientRect();
  let n = 0;
  for (const node of b.childNodes) {
    if (node.nodeType !== 3 || !node.textContent.trim()) continue;
    const rg = document.createRange();
    rg.selectNodeContents(node);
    n = Math.max(n, rg.getClientRects().length);
  }
  return { t: (b.innerText || '').replace(/\\n/g, ' ').trim().slice(0, 20), y: Math.round(r.y), lines: n };
})"""

NUM = """(label) => {
  const t = (document.querySelector('.screen') || document.body).innerText;
  const i = t.indexOf(label);
  if (i < 0) return null;
  const m = t.slice(i, i + 120).match(/[$][0-9][0-9,]*([.][0-9]+)?/);
  return m ? Number(m[0].slice(1).replace(/,/g, '')) : null;
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_loan_ui')
    out.mkdir(parents=True, exist_ok=True)
    port = free_port()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    rep = []

    def chk(name, ok_, d=''):
        rep.append({'name': name, 'ok': bool(ok_), 'detail': str(d)})
        print(('  PASS  ' if ok_ else '  ★FAIL ') + name + ('  ' + str(d) if d != '' else ''))
        if not ok_:
            fails.append(name)

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            # ── ① 정상 계정: 충전 화면에 「대출」 버튼이 «같은 행» ──────────
            # ★두 상태를 «둘 다» 본다: 파산(무료 충전 버튼이 있는 phase) · 소진(충전이 다 막힌 phase).
            #   President 지시는 「충전 버튼 옆」이므로 ★충전 버튼이 실제로 있는 phase 를 반드시 포함해야 한다.
            for tag, cash, holds, partner in [
                # ★파산 phase 의 충전 CTA 문구는 「무료로 $10,000 받기」다 — 「충전」이라는 낱말이 «없다».
                #   ⛔문구를 추측해서 박으면 검사가 거짓 FAIL 을 낸다(2026-09-06 실측).
                ('bankrupt', 50, [], '받기'),      # equity < $200 → 무료 충전 버튼이 뜬다
                ('exhausted', 150, [['AAPL', {'qty': 100, 'avgCost': 200}]], '홈으로'),
            ]:
                ctx = br.new_context(viewport=VIEW, locale='ko-KR')
                ctx.add_init_script(init(cash, holds, block_attendance=(tag == 'bankrupt')))
                pg = ctx.new_page()
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
                pg.goto(base + '#/recharge', wait_until='networkidle')
                pg.wait_for_selector('.cta', timeout=30000)
                pg.wait_for_timeout(2500)
                btns = pg.evaluate(BTNS)
                loan = [b for b in btns if b['t'].startswith('대출')]
                chk(f'① [{tag}] 충전 화면에 「대출」 버튼이 있다', len(loan) == 1, [b['t'] for b in btns][:6])
                # ★「같은 행」은 «옆에 있는 버튼»과의 y 일치로 잰다. phase 마다 짝이 다르므로
                #   특정 문구를 박지 않고 「y 가 같은 다른 버튼이 있는가」로 본다.
                row = [b for b in btns if loan and b is not loan[0] and abs(b['r']['y'] - loan[0]['r']['y']) <= 4]
                chk(f'① [{tag}] 대출이 «같은 행»에 짝이 있다(y ±4px)', bool(row),
                    f"loan y={loan[0]['r']['y'] if loan else None} · 짝={[b['t'][:12] for b in row]}")
                chk(f'① [{tag}] 짝이 「{partner}」 쪽 버튼이다', any(partner in b['t'] for b in row), [b['t'][:16] for b in row])
                chk(f'① [{tag}] 대출 버튼이 «살아 있다»', bool(loan) and not loan[0]['d'], loan[0] if loan else None)
                # ★President 「같은 행, 같은 높이」 — 높이도 «잴다». 문구가 접히면 여기서 터진다.
                chk(f'① [{tag}] 짝과 «같은 높이»(±2px)',
                    bool(row) and all(abs(b['r']['h'] - loan[0]['r']['h']) <= 2 for b in row),
                    f"loan h={loan[0]['r']['h'] if loan else None} · 짝 h={[b['r']['h'] for b in row]}")
                # ★주 버튼 문구가 «한 줄»인가 — 두 줄이면 높이가 갈린다(그 원인을 직접 잰다).
                #   ⛔높이 상수로 재지 마라: `.btn--gold`(61px)와 `.btn--ghost`(48px)의 «한 줄 높이»가
                #     이미 다르다. 추측한 임계값은 거짓 FAIL 을 낸다(2026-09-06 실측).
                #   ⇒ Range 로 «텍스트 줄 상자 개수»를 직접 센다. 그게 「한 줄인가」의 정의다.
                lines = pg.evaluate(LINES)
                bad = [x for x in lines if x['y'] is not None and loan and abs(x['y'] - loan[0]['r']['y']) <= 4 and x['lines'] > 1]
                chk(f'① [{tag}] 같은 행 버튼 문구가 «한 줄»이다(줄 상자 수로 측정)', not bad, str(bad))
                pg.screenshot(path=str(out / f'01_recharge_{tag}.png'))
                chk(f'① [{tag}] 콘솔 에러 0', len(errs) == 0, errs[:2])
                ctx.close()

            # ── ④⑤ 대출 화면 · 빌리면 순자산 불변 ──────────────────────
            ctx = br.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init(10000, [['AAPL', {'qty': 300, 'avgCost': 200}]]))
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            pg.goto(base + '#/loan', wait_until='networkidle')
            pg.wait_for_selector('.cta', timeout=30000)
            pg.wait_for_timeout(2500)
            txt = pg.evaluate(TEXT)
            for lab in ['총 자산', '부채', '순자산', '신용등급', '담보대출', '신용대출', '한도', '금리(연)', '만기가 되면']:
                chk(f'④ 대출 화면에 「{lab}」 이 있다', lab in txt, '')
            chk('④ 만기 규칙 3줄이 그대로 있다', ('①' in txt and '②' in txt and '③' in txt), '')
            chk('④ 중도상환 수수료 0 안내가 있다', '중도상환 수수료는 없어요' in txt, '')
            chk('④ 변동금리 안내가 있다', '변동금리' in txt, '')
            pg.screenshot(path=str(out / '02_loan_screen.png'), full_page=True)

            nw0 = pg.evaluate(NUM, '순자산')
            eq0 = pg.evaluate(NUM, '총 자산')
            btns = pg.evaluate(BTNS)
            borrow = [b for b in btns if b['t'].startswith('빌리기')]
            chk('⑤ 「빌리기」 버튼이 살아 있다', bool(borrow) and not borrow[0]['d'], borrow[0] if borrow else None)
            if borrow and not borrow[0]['d']:
                pg.click('.btn.btn--lg')
                pg.wait_for_timeout(1500)
                nw1 = pg.evaluate(NUM, '순자산')
                eq1 = pg.evaluate(NUM, '총 자산')
                # ★두 스냅샷 사이에 «틱이 흐른다» — 보유 주식 평가액이 그동안 움직인다.
                #   그래서 「완전히 같다」로 재면 시장 노이즈에 거짓 FAIL 이 난다(실측 −$22.79).
                #   ⇒ «대출 금액 대비» 얼마나 안 움직였나로 잰다. 대출이 순자산을 올리면
                #     Δ순자산 ≈ Δ총자산 이 되므로 이 임계는 그걸 확실히 잡는다.
                borrowed = (eq1 - eq0) if (eq0 is not None and eq1 is not None) else 0
                moved = abs(nw1 - nw0) if (nw0 is not None and nw1 is not None) else 1e9
                chk('⑤ ★빌려도 «순자산»이 안 변한다 (Δ순자산 < 대출액의 1%)',
                    borrowed > 0 and moved < borrowed * 0.01,
                    f'Δ순자산 {moved:.2f} vs 대출 {borrowed:.2f} ({nw0} → {nw1})')
                chk('⑤ 총자산은 «늘었다»(현금이 들어왔다)', eq0 is not None and eq1 is not None and eq1 > eq0, f'{eq0} → {eq1}')
                txt2 = pg.evaluate(TEXT)
                chk('⑥ 내 대출 목록에 항목이 생겼다', '원금' in txt2, '')
                pg.screenshot(path=str(out / '03_loan_after_borrow.png'), full_page=True)
                # ⑥ 전액 상환
                pg.get_by_role('button', name='전액', exact=True).first.click()
                pg.wait_for_timeout(1500)
                txt3 = pg.evaluate(TEXT)
                chk('⑥ 전액 상환하면 목록이 비워진다', '아직 빌린 돈이 없어요' in txt3, '')
                pg.screenshot(path=str(out / '04_loan_after_repay.png'), full_page=True)
            chk('④ 콘솔 에러 0', len(errs) == 0, errs[:2])
            ctx.close()

            # ── ②③ 연체 상태 ──────────────────────────────────────────
            ctx = br.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init(-8000, [['AAPL', {'qty': 100, 'avgCost': 200}]]))
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            pg.goto(base + '#/recharge', wait_until='networkidle')
            pg.wait_for_selector('.cta', timeout=30000)
            pg.wait_for_timeout(2500)
            btns = pg.evaluate(BTNS)
            txt = pg.evaluate(TEXT)
            loan = [b for b in btns if b['t'].startswith('대출')]
            chk('② 연체 중 대출 버튼이 «죽어 있다»', bool(loan) and loan[0]['d'], loan[0] if loan else None)
            chk('② 죽은 «이유»가 버튼에 적혀 있다', bool(loan) and '연체' in loan[0]['t'], loan[0]['t'] if loan else '')
            free = [b for b in btns if '충전' in b['t'] and not b['t'].startswith('대출')]
            chk('③ 연체 중 무료 충전 버튼이 «죽어 있다»', all(b['d'] for b in free) if free else True,
                [(b['t'], b['d']) for b in free])
            pg.screenshot(path=str(out / '05_recharge_overdue.png'))
            chk('② 콘솔 에러 0', len(errs) == 0, errs[:2])

            # 연체 상태의 대출 화면
            pg.goto(base + '#/loan', wait_until='networkidle')
            pg.wait_for_selector('.cta', timeout=30000)
            pg.wait_for_timeout(2000)
            txt = pg.evaluate(TEXT)
            btns = pg.evaluate(BTNS)
            borrow = [b for b in btns if b['t'].startswith('빌리기')]
            chk('② 연체 중 대출 화면: 「연체 잔액」 배너', '연체 잔액' in txt, '')
            chk('② 연체 중 대출 화면: 연체 이자율 표시', '연체 이자' in txt, '')
            chk('② 연체 중 「빌리기」가 죽어 있다', bool(borrow) and borrow[0]['d'], borrow[0] if borrow else None)
            chk('③ 「충전이 열리지 않아요」 안내', '충전이 열리지 않아요' in txt, '')
            pg.screenshot(path=str(out / '06_loan_overdue.png'), full_page=True)

            # ── 연체 상태의 «홈» — 총자산·부채·순자산이 같이 보이는가 ────────
            pg.goto(base + '#/home', wait_until='networkidle')
            pg.wait_for_selector('.eqrow', timeout=30000)
            pg.wait_for_timeout(2500)
            txt = pg.evaluate(TEXT)
            chk('④ 홈에 「부채」 가 보인다', '부채' in txt, '')
            chk('④ 홈에 「순자산」 이 보인다', '순자산' in txt, '')
            chk('④ 홈에 「연체」 이자율이 보인다', '연체' in txt, '')
            pg.screenshot(path=str(out / '07_home_overdue.png'))
            ctx.close()

            # ── 대출 «없는» 계정의 홈 — 새 줄이 «안» 생긴다(회귀 방지) ──────
            ctx = br.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init(10000, [['AAPL', {'qty': 10, 'avgCost': 200}]]))
            pg = ctx.new_page()
            pg.goto(base + '#/home', wait_until='networkidle')
            pg.wait_for_selector('.eqrow', timeout=30000)
            pg.wait_for_timeout(2500)
            txt = pg.evaluate(TEXT)
            chk('④ ★대출이 없으면 홈에 부채·순자산 줄이 «안» 생긴다(회귀 0)',
                ('부채' not in txt) and ('순자산' not in txt), '')
            pg.screenshot(path=str(out / '08_home_no_loan.png'))
            ctx.close()
        finally:
            br.close()
            httpd.shutdown()
            httpd.server_close()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    okn = sum(1 for r in rep if r['ok'])
    print(f'\n검사 {okn}/{len(rep)} PASS · 산출: {out}')
    if fails:
        print('\nFAILED:')
        for f in fails:
            print('  ' + f)
        sys.exit(1)


if __name__ == '__main__':
    main()
