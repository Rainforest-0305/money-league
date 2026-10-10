# -*- coding: utf-8 -*-
"""
포트폴리오 «복사» 실동작·실렌더 검증 — ★headless 전용. ⛔창을 띄우지 않는다.

  ML_DIST=dist/web python scripts/verify_copy_ui.py <라벨> [출력폴더]

★무엇을 재나 (President 지시 2026-08-30 + 「파생도 복사하라고」)
  ★대상 두 종류 — 봇 명부 실측(2026-08-30): «주식만» 드는 봇(momentum 등, BOT001~)과 «레버리지만» 드는 봇
    (derivatives_heavy, BOT169~BOT210)뿐이고 둘을 «같이» 드는 봇은 없다. ⇒ 주식 대상·파생 대상을 따로 잡아 각각 검증한다.
  (B) 현재 현금만 [주식 대상]: 미리보기 행(data-*)에서 Σ비중 = 1 · Σ투입 ≤ 현금 · 수량 정수 · 건너뜀 표시 · 남는 현금 = 현금 − 투입
      → 「복사 구매」 → 결과 전부 ok → ★저장본(ml.game) 보유 수량 = 계획 수량
  (B) [파생 대상]: 레버리지 행 ≥ 2 · 방향·배율 = 대상 · 증거금 정수 → 실행 → 저장본 레버리지 방향·배율·증거금 = 계획
  (A) 전량 청산 [주식 대상]: 내 보유 3종(+ 기존 주문 화면으로 연 레버리지 1개) → 미리보기 「먼저 정리할 것」 → 실행 →
      close 단계 전부 ok → 저장본에 옛 보유 «없음» · 새 보유 = 계획
  시즌 마감: ml.season 만료 → 버튼을 JS 로 눌러 시트를 열고 확정 → SEASON_ENDED 문구 · 저장본 «무변경»
  현금 0: 잔고 0 + 보유 0 → 버튼 disabled + 사유 문구
  줄바꿈: ko/en × 375/390/430 미리보기 시트 — .cprow__nm 말줄임은 허용, 오른쪽 값·제목·옵션 라벨·버튼은 한 줄
          + 합성 긴 이름(「Brinker International Holdings」) 주입 뒤에도 오른쪽 값이 화면 안
⛔양성대조 먼저: 값 폭을 20px + wrap 로 강제 → 두 줄이 «잡히는지».
★tick 3200 · 옛 savedAt 저장본으로 부팅한다 — 따라잡기가 돌아 봇들이 «실제로 거래한 상태»가 된다(tick 0 새 게임은 봇 보유 0).
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
KST = timezone(timedelta(hours=9))
HOLD = ['VZ', 'NVDA', 'KO']


def kst_key(days_ago=0):
    return (datetime.now(KST) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def init(lang, cash, holdings=(), season=None, theme='light'):
    save = {
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {'cash': float(cash), 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in holdings],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }
    # ★출석 보너스(+$5,000)가 현금을 흔들지 않게 «오늘 이미 받은» 상태로 심는다
    att = {'streak': 1, 'lastClaimedDate': kst_key(), 'lastDoubledDate': None, 'totalUsd': 0}
    js = ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
          "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
          "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
          "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
          "localStorage.removeItem('ml.journal');"
          "localStorage.setItem('ml.game', %s);localStorage.setItem('ml.attendance', %s);"
          % (lang, theme, json.dumps(json.dumps(save)), json.dumps(json.dumps(att))))
    if season is not None:
        js += "localStorage.setItem('ml.season', JSON.stringify(%s));" % json.dumps(season)
    return js + "})()"


GAME = "() => { try { return JSON.parse(localStorage.getItem('ml.game') || 'null'); } catch { return null; } }"
JOURNAL = "() => { try { return JSON.parse(localStorage.getItem('ml.journal') || '[]'); } catch { return []; } }"
PROFILE = """() => {
  const rows = [...document.querySelectorAll('.card--list .rk')];
  const lev = rows.filter((r) => r.querySelector('.badge--up, .badge--down')).length;
  return { rows: rows.length, lev, spot: rows.length - lev, btn: !!document.querySelector('.cpbtn'), disabled: !!(document.querySelector('.cpbtn') || {}).disabled };
}"""
PREVIEW = """() => {
  const rows = [...document.querySelectorAll('.sheet .cprow[data-kind]')].map((r) => ({
    kind: r.dataset.kind, ticker: r.dataset.ticker, qty: Number(r.dataset.qty || 0), margin: Number(r.dataset.margin || 0),
    side: r.dataset.side || '', lev: Number(r.dataset.lev || 0), cost: Number(r.dataset.cost || 0), weight: Number(r.dataset.weight || 0),
    skip: r.dataset.skip || '', text: (r.textContent || '').trim().slice(0, 80),
  }));
  const tot = document.querySelector('.sheet .cptotal');
  return { rows, cash: tot ? Number(tot.dataset.cash) : null, spend: tot ? Number(tot.dataset.spend) : null, left: tot ? Number(tot.dataset.left) : null,
           closeRows: [...document.querySelectorAll('.sheet .cprow:not([data-kind]):not([data-step])')].length };
}"""
RESULT = """() => ({
  title: (document.querySelector('.sheet .cpsheet__h') || {}).textContent || '',
  steps: [...document.querySelectorAll('.sheet .cprow[data-step]')].map((r) => ({ step: r.dataset.step, kind: r.dataset.kind, ticker: r.dataset.ticker, ok: r.dataset.ok === '1', code: r.dataset.code })),
  alert: (document.querySelector('.sheet [role=alert]') || {}).textContent || '',
})"""
WRAPS = """() => {
  const out = [];
  document.querySelectorAll('.sheet .cpsheet__h, .sheet .opt__t, .sheet .cprow__v, .sheet .cprow__q, .sheet .cprow__skip, .sheet .btn, .cpbtn').forEach((e) => {
    if (e.querySelector('.btn__sub')) return;
    const r = e.getBoundingClientRect(); if (r.height === 0) return;
    const cs = getComputedStyle(e); const fs = parseFloat(cs.fontSize) || 14;
    let lh = parseFloat(cs.lineHeight); if (!lh || Number.isNaN(lh)) lh = fs * 1.25;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const lines = (r.height - pad) / lh;
    if (lines >= 1.6 && !e.classList.contains('cpsheet__h')) out.push({ cls: e.className, text: (e.textContent || '').trim().slice(0, 40), lines: Math.round(lines * 10) / 10 });
  });
  const rights = [...document.querySelectorAll('.sheet .cprow__r')];
  const rightOut = rights.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length;
  const rightOverflow = rights.filter((e) => e.scrollWidth > e.clientWidth + 1).length;
  return { wraps: out, rightOut, rightOverflow, rows: rights.length };
}"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(1500)


def find_target(br, base, init_js, ids, want):
    """want='spot': 주식 ≥5 · want='lev': 레버리지 ≥2. 열람권 10장이라 한 컨텍스트에 10명까지"""
    ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
    ctx.add_init_script(init_js)
    p = ctx.new_page()
    try:
        boot(p, base, '#/home')
        for n in ids[:10]:
            bid = 'BOT%03d' % n
            boot(p, base, '#/trader/%s' % bid)
            info = p.evaluate(PROFILE)
            if (want == 'spot' and info['spot'] >= 5) or (want == 'lev' and info['lev'] >= 2):
                return bid, info
    finally:
        ctx.close()
    return None, None


def goto_profile(p, base, bid):
    """★홈을 «먼저» 거친다 — 첫 publicPortfolio() 호출이 따라잡기 «전»에 일어나면 빈 스냅샷이 10분간 게시된다
    (앱의 기존 스냅샷 타이밍. 프로필로 «직행»하면 보유 0 으로 보여 버튼이 「따라 살 것이 없어요」로 비활성이다. 실측 2026-08-30)"""
    boot(p, base, '#/home')
    boot(p, base, '#/trader/%s' % bid)


def open_preview(p, mode):
    p.locator('.cpbtn').scroll_into_view_if_needed()
    p.locator('.cpbtn').click()
    p.wait_for_selector('.sheet .opt', timeout=10000)
    p.locator('.sheet .opt').nth(0 if mode == 'all' else 1).click()
    p.wait_for_timeout(120)
    p.locator('.sheet .btn--primary').click()
    p.wait_for_selector('.sheet .cptotal, .sheet .card--pad', timeout=10000)
    p.wait_for_timeout(300)


def lev_positions(game):
    out = []
    for x in game['account'].get('levPositions', []):
        out.append(x[1] if isinstance(x, list) else x)
    return out


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260830_copy'
    out.mkdir(parents=True, exist_ok=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    fails = []
    facts = {}

    def check(name, cond, detail=''):
        print('  %s  %s  %s' % ('PASS' if cond else '★FAIL', name, detail))
        if not cond:
            fails.append(name)

    def run_B(br, bid, tag, expect):
        ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
        ctx.add_init_script(init('ko', 250000))
        p = ctx.new_page()
        errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))
        goto_profile(p, base, bid)
        p.locator('.cpbtn').scroll_into_view_if_needed()
        p.screenshot(path=str(out / ('%s_ko_375_profile_btn_%s.png' % (label, tag))))
        game0 = p.evaluate(GAME)
        cash0 = game0['account']['cash']
        p.locator('.cpbtn').click()
        p.wait_for_selector('.sheet .opt', timeout=10000)
        p.wait_for_timeout(300)
        p.screenshot(path=str(out / ('%s_ko_375_choose_%s.png' % (label, tag))))
        p.locator('.sheet .opt').nth(1).click()
        p.locator('.sheet .btn--primary').click()
        p.wait_for_selector('.sheet .cptotal', timeout=10000)
        p.wait_for_timeout(300)
        pv = p.evaluate(PREVIEW)
        rows = pv['rows']
        wsum = sum(r['weight'] for r in rows)
        buys = [r for r in rows if not r['skip']]
        spot = [r for r in rows if r['kind'] == 'spot']
        levr = [r for r in rows if r['kind'] == 'lev']
        if expect == 'spot':
            check('(B·%s) 주식 행 ≥ 5' % tag, len(spot) >= 5, '%d행' % len(spot))
        else:
            check('(B·%s) 레버리지 행 ≥ 2 · 방향·배율 표기' % tag, len(levr) >= 2 and all(r['side'] in ('long', 'short') and r['lev'] > 0 for r in levr),
                  str([(r['ticker'], r['side'], r['lev'], r['margin'], r['skip']) for r in levr]))
        check('(B·%s) Σ비중 = 1' % tag, abs(wsum - 1) < 1e-4, '%.6f' % wsum)
        check('(B·%s) Σ투입 ≤ 현금 · 남는 현금 = 현금 − 투입' % tag, pv['spend'] <= pv['cash'] + 1 and abs(pv['left'] - (pv['cash'] - pv['spend'])) <= 1, 'cash=%s spend=%s left=%s' % (pv['cash'], pv['spend'], pv['left']))
        check('(B·%s) 계획 현금 = 내 현금' % tag, abs(pv['cash'] - round(cash0)) <= 1, '%s vs %.2f' % (pv['cash'], cash0))
        check('(B·%s) 수량·증거금 정수' % tag, all(float(r['qty']).is_integer() and float(r['margin']).is_integer() for r in rows))
        check('(B·%s) 건너뜀 행은 수량·증거금 0 + 사유' % tag, all(r['qty'] == 0 and r['margin'] == 0 and '건너뜀' in r['text'] for r in rows if r['skip']), '%d건 skip' % sum(1 for r in rows if r['skip']))
        wr = p.evaluate(WRAPS)
        check('(B·%s) 미리보기 줄바꿈 0 · 오른쪽 값 화면 안' % tag, len(wr['wraps']) == 0 and wr['rightOut'] == 0 and wr['rightOverflow'] == 0, str(wr))
        p.screenshot(path=str(out / ('%s_ko_375_preview_B_%s.png' % (label, tag))))
        facts['B_preview_%s' % tag] = pv
        p.locator('.sheet .btn--primary').click()
        p.wait_for_selector('.sheet .cprow[data-step]', timeout=90000)
        p.wait_for_timeout(600)
        res = p.evaluate(RESULT)
        game1 = p.evaluate(GAME)
        hold = {k: v for k, v in game1['account']['holdings']}
        levs = lev_positions(game1)
        check('(B·%s) 결과 단계 수 = 계획 매수 줄 수' % tag, len(res['steps']) == len(buys), '%d vs %d' % (len(res['steps']), len(buys)))
        check('(B·%s) 전부 ok' % tag, len(res['steps']) > 0 and all(st['ok'] for st in res['steps']), str([st for st in res['steps'] if not st['ok']][:3]))
        for r in buys:
            if r['kind'] == 'spot':
                got = hold.get(r['ticker'], {}).get('qty', 0)
                check('(B·%s) 저장본 %s 수량 = 계획 %d' % (tag, r['ticker'], r['qty']), abs(got - r['qty']) < 1e-6, 'got=%s' % got)
            else:
                hit = [x for x in levs if x.get('ticker') == r['ticker'] and x.get('side') == r['side'] and x.get('leverage') == r['lev'] and abs(x.get('margin', 0) - r['margin']) < 1e-6]
                check('(B·%s) 저장본 레버리지 %s %s %d배 증거금 $%d' % (tag, r['ticker'], r['side'], r['lev'], r['margin']), len(hit) >= 1, str([(x.get('ticker'), x.get('side'), x.get('leverage'), x.get('margin')) for x in levs][:4]))
        check('(B·%s) 실행 뒤 현금 ≥ 0 · ≈ 남는 현금(±2%%)' % tag, game1['account']['cash'] >= 0 and abs(game1['account']['cash'] - pv['left']) <= max(50, pv['cash'] * 0.02), 'cash=%.2f left=%s' % (game1['account']['cash'], pv['left']))
        via = [e for e in p.evaluate(JOURNAL) if e.get('via')]
        check('(B·%s) 일지 via 표지 수 = 단계 수' % tag, len(via) == len(res['steps']), '%d/%d' % (len(via), len(res['steps'])))
        p.screenshot(path=str(out / ('%s_ko_375_result_B_%s.png' % (label, tag))))
        facts['B_result_%s' % tag] = res
        boot(p, base, '#/journal')
        nb = p.locator('.pbadge--copy').count()
        check('(B·%s) 일지 화면 「복사」 배지 ≥ 1' % tag, nb >= 1, '%d' % nb)
        p.screenshot(path=str(out / ('%s_ko_375_journal_%s.png' % (label, tag))))
        check('(B·%s) 페이지 에러 0' % tag, not errs, (errs or [''])[0][:120])
        ctx.close()

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                spot_bid, sinfo = find_target(br, base, init('ko', 250000), list(range(1, 11)), 'spot')
                lev_bid, linfo = find_target(br, base, init('ko', 250000), list(range(169, 179)), 'lev')
                check('주식 대상 봇(주식≥5) 찾음', spot_bid is not None, '%s %s' % (spot_bid, sinfo))
                check('파생 대상 봇(레버리지≥2) 찾음', lev_bid is not None, '%s %s' % (lev_bid, linfo))
                if spot_bid is None or lev_bid is None:
                    return 1
                facts['targets'] = {'spot': {'id': spot_bid, **sinfo}, 'lev': {'id': lev_bid, **linfo}}

                # ── 양성대조 ─────────────────────────────────────────────
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 250000))
                p = ctx.new_page()
                goto_profile(p, base, spot_bid)
                open_preview(p, 'cash')
                p.evaluate("() => { const e = document.querySelector('.sheet .btn--primary'); e.style.whiteSpace = 'normal'; e.style.width = '40px'; }")
                pc = p.evaluate(WRAPS)
                check('양성대조: 확정 버튼 폭 40px 강제 → 두 줄 «잡힘»', len(pc['wraps']) >= 1, str(pc['wraps'][:1]))
                ctx.close()

                # ── (B) 주식 대상 · 파생 대상 ────────────────────────────
                run_B(br, spot_bid, 'spot', 'spot')
                run_B(br, lev_bid, 'lev', 'lev')

                # ── (A) 전량 청산 [주식 대상] ─────────────────────────────
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 100000, HOLD))
                p = ctx.new_page()
                errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                boot(p, base, '#/home')
                # 레버리지 1개는 «기존 주문 화면 경로»로 연다(저장본 형식을 손으로 흉내내지 않는다)
                boot(p, base, '#/leverage/NVDA')
                opened = False
                try:
                    p.wait_for_selector('.seg button', timeout=10000)
                    p.evaluate("() => document.querySelectorAll('.seg button')[1].click()")
                    p.wait_for_timeout(200)
                    p.wait_for_selector('button.btn--lg', timeout=10000)
                    p.evaluate("() => document.querySelector('button.btn--lg').click()")
                    p.wait_for_timeout(1000)
                    opened = len(lev_positions(p.evaluate(GAME))) >= 1
                except Exception as e:  # noqa: BLE001
                    print('  NOTE  레버리지 시드 주문 실패(%s)' % str(e)[:60])
                print('  NOTE  (A) 시드: 주식 3종 + 레버리지 %s' % ('1개(NVDA 숏)' if opened else '0개'))
                goto_profile(p, base, spot_bid)
                game0 = p.evaluate(GAME)
                n_old = len(game0['account']['holdings']) + len(lev_positions(game0))
                open_preview(p, 'all')
                pv = p.evaluate(PREVIEW)
                check('(A) 「먼저 정리할 것」 행 = 내 보유 %d건' % n_old, pv['closeRows'] == n_old, 'closeRows=%d' % pv['closeRows'])
                check('(A) 계획 현금 > 현재 현금(청산 예상 포함)', pv['cash'] > game0['account']['cash'], 'plan=%s now=%.0f' % (pv['cash'], game0['account']['cash']))
                p.screenshot(path=str(out / ('%s_ko_375_preview_A.png' % label)))
                p.locator('.sheet .btn--primary').click()
                p.wait_for_selector('.sheet .cprow[data-step]', timeout=90000)
                p.wait_for_timeout(600)
                res = p.evaluate(RESULT)
                game1 = p.evaluate(GAME)
                closes = [st for st in res['steps'] if st['step'] == 'close']
                buysA = [st for st in res['steps'] if st['step'] == 'buy']
                check('(A) close 단계 %d건 전부 ok(주식 → 파생 순)' % n_old, len(closes) == n_old and all(st['ok'] for st in closes) and [st['kind'] for st in closes] == sorted([st['kind'] for st in closes], key=lambda k: 0 if k == 'spot' else 1), str([(st['kind'], st['ticker'], st['ok']) for st in closes]))
                check('(A) buy 단계 전부 ok', len(buysA) >= 1 and all(st['ok'] for st in buysA), str([st for st in buysA if not st['ok']][:2]))
                hold = {k: v for k, v in game1['account']['holdings']}
                bought = {st['ticker'] for st in buysA if st['kind'] == 'spot'}
                leftover_old = [t for t in HOLD if t in hold and t not in bought and hold[t]['qty'] > 1e-6]
                check('(A) 옛 보유(VZ·NVDA·KO) 저장본에서 사라짐', not leftover_old, str(leftover_old))
                if opened:
                    check('(A) 옛 레버리지(NVDA 숏) 저장본에서 사라짐', not any(x.get('side') == 'short' and x.get('ticker') == 'NVDA' for x in lev_positions(game1)))
                check('(A) 실행 뒤 현금 ≥ 0', game1['account']['cash'] >= 0, '%.2f' % game1['account']['cash'])
                check('(A) 페이지 에러 0', not errs, (errs or [''])[0][:120])
                p.screenshot(path=str(out / ('%s_ko_375_result_A.png' % label)))
                facts['A_result'] = res
                ctx.close()

                # ── 시즌 마감 거절 ──────────────────────────────────────
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 250000, season={'endAt': 1000, 'n': 1, 'extended': 0}))
                p = ctx.new_page()
                goto_profile(p, base, spot_bid)
                p.wait_for_timeout(800)
                gate = p.locator('.seasongate').count()
                game0 = p.evaluate(GAME)
                p.evaluate("() => document.querySelector('.cpbtn').click()")
                p.wait_for_selector('.sheet .opt', timeout=10000)
                p.evaluate("() => document.querySelectorAll('.sheet .opt')[1].click()")
                p.evaluate("() => document.querySelector('.sheet .btn--primary').click()")
                p.wait_for_selector('.sheet .cptotal', timeout=10000)
                p.evaluate("() => document.querySelector('.sheet .btn--primary').click()")
                p.wait_for_timeout(1200)
                res = p.evaluate(RESULT)
                game1 = p.evaluate(GAME)
                check('시즌 마감: 게이트 표시 + 확정 시 SEASON_ENDED 문구', gate >= 1 and ('시즌' in res['alert']), 'gate=%d alert="%s"' % (gate, res['alert'][:40]))
                check('시즌 마감: 저장본 무변경(현금·보유)', game1['account']['cash'] == game0['account']['cash'] and len(game1['account']['holdings']) == len(game0['account']['holdings']))
                p.screenshot(path=str(out / ('%s_ko_375_season_ended.png' % label)))
                ctx.close()

                # ── 현금 0 ──────────────────────────────────────────────
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 0))
                p = ctx.new_page()
                goto_profile(p, base, spot_bid)
                info0 = p.evaluate(PROFILE)
                txt = p.evaluate("() => { const b = document.querySelector('.cpbtn'); return b && b.parentElement ? (b.parentElement.textContent || '') : ''; }")
                check('현금 0 + 보유 0: 버튼 disabled + 사유', info0['btn'] and info0['disabled'] and '현금이 없' in txt, txt[:60])
                p.locator('.cpbtn').scroll_into_view_if_needed()
                p.screenshot(path=str(out / ('%s_ko_375_nocash.png' % label)))
                ctx.close()

                # ── 줄바꿈 ko/en × 375/390/430 (+ 합성 긴 이름) — 주식 대상 · 파생 대상 ──
                for tag, bid in (('spot', spot_bid), ('lev', lev_bid)):
                    for lang in ('ko', 'en'):
                        for width in (375, 390, 430):
                            key = '%s_%s_%d' % (tag, lang, width)
                            ctx = br.new_context(viewport={'width': width, 'height': 812}, locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, 250000, HOLD))
                            p = ctx.new_page()
                            goto_profile(p, base, bid)
                            pb = p.evaluate(WRAPS)
                            p.locator('.cpbtn').click()
                            p.wait_for_selector('.sheet .opt', timeout=10000)
                            p.wait_for_timeout(300)
                            w0 = p.evaluate(WRAPS)
                            p.locator('.sheet .opt').nth(0).click()
                            p.locator('.sheet .btn--primary').click()
                            p.wait_for_selector('.sheet .cptotal', timeout=10000)
                            p.wait_for_timeout(300)
                            p.evaluate("() => { const e = document.querySelector('.sheet .cprow[data-kind] .cprow__nm'); if (e) e.textContent = 'Brinker International Holdings'; }")
                            p.wait_for_timeout(100)
                            w1 = p.evaluate(WRAPS)
                            allw = pb['wraps'] + w0['wraps'] + w1['wraps']
                            check('[%s] 버튼·선택·미리보기 줄바꿈 0 · 오른쪽 값 화면 안(긴 이름 주입 뒤에도)' % key, len(allw) == 0 and w1['rightOut'] == 0 and w1['rightOverflow'] == 0, str(allw[:2]) + ' rightOut=%d' % w1['rightOut'])
                            p.screenshot(path=str(out / ('%s_%s_%s_%d_preview_A.png' % (label, tag, lang, width))))
                            facts['wrap_%s' % key] = {'btn': pb, 'choose': w0, 'preview': w1}
                            ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_facts.json' % label)).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n포트폴리오 복사 결함 %d건' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
