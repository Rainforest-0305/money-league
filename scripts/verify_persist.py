# -*- coding: utf-8 -*-
"""
«앱 종료 → 재진입» 영속 실측 — ★headless 전용(창 0). L6 「나갔다가 들어오면 기록이 다 날아가?」 진단.

  ML_DIST=dist/web python scripts/verify_persist.py <라벨> [출력폴더]

★시나리오
  A) 새 계정으로 부팅 → 틱 20초(자산 그래프 쌓임) → 파생 주문 2건(선물 NVDA · 선도 NVDA, 되돌리기 창 5초 경과)
     → 홈 「+ 충전」 1회 시도 → 측정 A(저장 키 스냅샷 + 화면: 자산 그래프 점 수 · 일지 행 수 · 중앙은행 체결 행 수)
  B) 컨텍스트 «폐기»(= 앱 완전 종료) → 같은 storage state 로 «새 컨텍스트» 부팅 → 측정 B → A/B 대조
  C) 같은 컨텍스트 안 새로고침(pagehide 경로) → 측정 C
★판정 라벨: [실측] = 브라우저(토스 밖 폴백: localStorage 만, 네이티브 미러 no-op) · [추론] = 실기기(토스 안) 경로는 코드로만.
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

DIST = resolve_dist()
INIT = ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260830');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Rimi'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "sessionStorage.setItem('ads.preview','1');"
        "if (!localStorage.getItem('ml.cbfills')) localStorage.setItem('ml.cbfills', JSON.stringify({v:1,total:3,fills:["
        "{id:3,at:1756500000000,sid:1756499000000,tick:300,gameDay:2,ticker:'SPX',side:'sell',notional:120000,price:5100,basisBefore:0.0012,basketSide:'buy',basketNotional:1150000,basketPrice:5094},"
        "{id:2,at:1756499900000,sid:1756499000000,tick:250,gameDay:1,ticker:'NDX',side:'buy',notional:80000,price:18000,basisBefore:-0.0011,basketSide:'sell',basketNotional:430000,basketPrice:18020},"
        "{id:1,at:1756400000000,sid:1756399000000,tick:100,gameDay:0,ticker:'SPX',side:'buy',notional:95000,price:5050,basisBefore:-0.0015}]}));})()")

SNAP = """() => {
  const g = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const game = g('ml.game'); const j = g('ml.journal') || []; const att = g('ml.attendance'); const season = g('ml.season');
  return {
    keys: Object.keys(localStorage).filter((k) => k.startsWith('ml')).sort(),
    equity: g('ml.equity'), cb: g('ml.cbfills'),
    sizes: { equity: (localStorage.getItem('ml.equity')||'').length, cbfills: (localStorage.getItem('ml.cbfills')||'').length, game: (localStorage.getItem('ml.game')||'').length, journal: (localStorage.getItem('ml.journal')||'').length },
    game: game ? { v: game.v, tick: game.tick, savedAt: game.savedAt, cash: game.account.cash, tradeCount: game.account.tradeCount,
                   holdings: (game.account.holdings||[]).length, lev: (game.account.levPositions||[]).length, fwd: (game.account.fwdPositions||[]).length,
                   topupCount: game.account.topupCount, prices: Object.keys(game.prices||{}).length, dailyTopupAd: (game.daily||{}).topupAdUsed } : null,
    journalLen: j.length, journalIds: j.slice(0, 5).map((e) => e.id + ':' + e.product + ':' + e.action),
    attendance: att, season: season,
    bytes: Object.keys(localStorage).reduce((a, k) => a + (localStorage.getItem(k) || '').length, 0),
  };
}"""
CHART_PTS = """() => {
  const secs = [...document.querySelectorAll('.sec')];
  for (const s of secs) { const p = s.querySelector('svg path'); if (p && (p.getAttribute('d') || '').startsWith('M')) return ((p.getAttribute('d') || '').match(/L/g) || []).length + 1; }
  return -1;
}"""
SEAMS = """() => {
  const secs = [...document.querySelectorAll('.sec')];
  for (const s of secs) { const svg = s.querySelector('svg'); if (svg && svg.querySelector('path')) return [...svg.querySelectorAll('line')].filter((l) => l.getAttribute('stroke-dasharray') === '3 4').length; }
  return -1;
}"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route, settle=1500):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(settle)


def measure(p, base, label, out):
    r = {}
    boot(p, base, '#/home', 2500)
    r['chartPts'] = p.evaluate(CHART_PTS)
    r['seams'] = p.evaluate(SEAMS)
    r['seamCaption'] = p.locator('text=점선은 이전 접속').count()
    r['eq'] = p.evaluate("() => ((document.querySelector('.eqnum')||{}).textContent||'').trim()")
    p.screenshot(path=str(out / ('%s_home.png' % label)))
    boot(p, base, '#/journal', 1500)
    r['journalRows'] = p.locator('.jrow').count()
    p.screenshot(path=str(out / ('%s_journal.png' % label)))
    boot(p, base, '#/rank', 2000)
    r['cbFills'] = -1
    if p.locator('.cbcard').count():
        p.locator('.cbcard').first.click()
        p.wait_for_timeout(700)
        r['cbFills'] = p.locator('.sheet .badge--up, .sheet .badge--down').count()
        r['cbEmpty'] = p.locator('.sheet .cbsheet__empty').count()
        r['cbSessions'] = p.locator('.sheet .cbsession').count()
        r['cbSessionText'] = p.locator('.sheet .cbsession').all_inner_texts()
        r['cbLegs'] = p.locator('.sheet .cbleg').count()
        r['cbLegText'] = p.locator('.sheet .cbleg').all_inner_texts()[:4]
        r['cbTitle'] = (p.locator('#cb-title').first.inner_text() if p.locator('#cb-title').count() else '')
        r['cbCardSub'] = (p.locator('.cbcard__sub').first.inner_text() if p.locator('.cbcard__sub').count() else '')
        p.screenshot(path=str(out / ('%s_cbsheet.png' % label)))
        p.keyboard.press('Escape')
        p.wait_for_timeout(300)
    r['snap'] = p.evaluate(SNAP)
    return r


def order(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.btn--lg', timeout=60000)
    p.wait_for_timeout(2500)
    cta = p.query_selector('.btn--lg')
    if cta is None or cta.is_disabled():
        return False
    cta.click()
    p.wait_for_timeout(6500)  # 되돌리기 창(5s) 경과 → 확정
    return True


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260830_persist'
    out.mkdir(parents=True, exist_ok=True)
    fails = []

    def check(name, cond, detail=''):
        print('  %s  %s  %s' % ('PASS' if cond else '★FAIL', name, detail))
        if not cond:
            fails.append(name)

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/' % port
    res = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # ── A ────────────────────────────────────────────────────────
                ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR')
                ctx.add_init_script(INIT)
                p = ctx.new_page()
                errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                boot(p, base, '#/home', 2000)
                p.wait_for_timeout(20000)  # 틱 ≈10회 → 자산 그래프
                res['pre'] = {'chartPts': p.evaluate(CHART_PTS), 'snap': p.evaluate(SNAP)}
                o1 = order(p, base, '#/leverage/NVDA')
                o2 = order(p, base, '#/contract/forward/NVDA')
                check('A: 주문 2건 확정(선물·선도)', o1 and o2, '%s %s' % (o1, o2))
                # 광고 충전 1회 시도(홈 「+ 충전」)
                boot(p, base, '#/home', 1500)
                before = p.evaluate(SNAP)
                topped = False
                if p.locator('.eqplus').count():
                    p.locator('.eqplus').first.click()
                    p.wait_for_timeout(4000)
                    # 리워드 광고 프리뷰/모의 시트가 뜨면 닫기/완료 버튼을 눌러 본다
                    for sel in ('.sheet .btn--primary', '.btn--lg'):
                        if p.locator(sel).count():
                            try:
                                p.locator(sel).first.click(timeout=1500)
                                p.wait_for_timeout(2500)
                            except Exception:
                                pass
                    after = p.evaluate(SNAP)
                    topped = bool(after['game'] and before['game'] and after['game']['topupCount'] > before['game']['topupCount'])
                res['topup'] = {'attempted': p.locator('.eqplus').count() > 0, 'granted': topped}
                print('  INFO  광고충전 시도: 버튼=%s 지급=%s (프리뷰 환경 — 미지급이면 [미실측])' % (res['topup']['attempted'], topped))
                A = measure(p, base, '%s_A' % label, out)
                boot(p, base, '#/home', 500)
                g0 = p.evaluate(CHART_PTS)
                p.wait_for_timeout(8500)
                g1 = p.evaluate(CHART_PTS)
                check('홈에 머무는 동안 그래프가 자란다(-22 정지 결함 회귀)', g1 > g0, '%s → %s (8.5초)' % (g0, g1))
                res['A'] = A
                # ── C (같은 컨텍스트 새로고침 = pagehide 경로) ─────────────────
                C = measure(p, base, '%s_C' % label, out)
                res['C'] = C
                # ★실기기와 같은 종료 경로: 백그라운드/종료 직전에 pagehide 가 온다(store.onPageHide → save+flush). 컨텍스트 폐기는 이벤트를 «안» 준다
                p.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
                p.wait_for_timeout(300)
                state = ctx.storage_state()  # ★pagehide flush «뒤»의 저장 상태 = 실기기가 다음 부팅에 읽는 것
                (out / ('%s_state_A.json' % label)).write_text(json.dumps(state), encoding='utf-8')
                ctx.close()  # ★앱 완전 종료

                # ── B (새 컨텍스트 · 같은 storage) ────────────────────────────
                ctx2 = br.new_context(viewport={'width': 390, 'height': 844}, locale='ko-KR', storage_state=state)
                p2 = ctx2.new_page()
                p2.on('pageerror', lambda e: errs.append(str(e)))
                B = measure(p2, base, '%s_B' % label, out)
                res['B'] = B
                ctx2.close()

                ga, gb = A['snap']['game'], B['snap']['game']
                check('B: ml.game 존재·v 동일', bool(ga and gb and ga['v'] == gb['v']), '%s → %s' % (ga and ga['v'], gb and gb['v']))
                check('B: 포지션 유지(선물·선도)', bool(gb) and gb['lev'] == ga['lev'] and gb['fwd'] == ga['fwd'], 'lev %s→%s fwd %s→%s' % (ga['lev'], gb['lev'], ga['fwd'], gb['fwd']))
                check('B: 거래 횟수 유지', bool(gb) and gb['tradeCount'] == ga['tradeCount'], '%s→%s' % (ga['tradeCount'], gb['tradeCount']))
                check('B: 현금 유지(±충전)', bool(gb) and abs(gb['cash'] - ga['cash']) < 1e-6, '%.2f→%.2f' % (ga['cash'], gb['cash']))
                check('B: 틱 이어짐(재진입 tick ≥ 종료 tick)', bool(gb) and gb['tick'] >= ga['tick'], '%s→%s' % (ga['tick'], gb['tick']))
                check('B: 일지(ml.journal) 건수 유지', B['snap']['journalLen'] >= A['snap']['journalLen'] and A['snap']['journalLen'] > 0, '%s→%s (화면 행 %s→%s)' % (A['snap']['journalLen'], B['snap']['journalLen'], A['journalRows'], B['journalRows']))
                check('B: 출석 원장 유지', B['snap']['attendance'] == A['snap']['attendance'], str(B['snap']['attendance']))
                check('B: 시즌 키 유지', B['snap']['season'] == A['snap']['season'], str(B['snap']['season']))
                check('③ 자산 그래프 «이어짐»: 재진입 점 수 ≥ 종료 직전(+새 점)', B['chartPts'] >= A['chartPts'] and B['chartPts'] > 2, 'A=%s → B=%s (같은 세션 이동 C=%s)' % (A['chartPts'], B['chartPts'], C['chartPts']))
                check('④ 세션 경계 점선 렌더(재진입 후 ≥1) · 캡션 표시', B['seams'] >= 1 and B['seamCaption'] >= 1 and A['seams'] == 0, 'A seams=%s → B seams=%s caption=%s' % (A['seams'], B['seams'], B['seamCaption']))
                check('③ 중앙은행 체결 원장 유지(심은 3건 ≥ 3 · 재진입 동일)', A['cbFills'] >= 3 and B['cbFills'] == A['cbFills'], 'A=%s → B=%s' % (A['cbFills'], B['cbFills']))
                check('④ 마켓 메이커 체결 «두 다리» 표기(심은 2쌍+옛 1건 = 다리 ≥5) · 제목 「마켓 메이커(LP)」', B.get('cbLegs', 0) >= 5 and '마켓 메이커(LP)' in B.get('cbTitle', ''), 'legs=%s %s title=%r' % (B.get('cbLegs'), B.get('cbLegText'), B.get('cbTitle')))
                check('④ 마켓 메이커 세션 헤더(접속 시각) ≥ 2 · 카드 「괴리 해소 N회」 누적', B.get('cbSessions', 0) >= 2 and ('3' in B.get('cbCardSub', '') or '해소' in B.get('cbCardSub', '')), 'sessions=%s %s card=%r' % (B.get('cbSessions'), B.get('cbSessionText'), B.get('cbCardSub')))
                check('ml.equity 저장본(A 종료 시): pts ≤180 · 재진입 메모리에 경계 존재', bool(A['snap']['equity']) and len(A['snap']['equity']['pts']) <= 180 and B['seams'] >= 1, 'pts=%s marks=%s' % (len((B['snap']['equity'] or {}).get('pts', [])), (B['snap']['equity'] or {}).get('marks')))
                print('  INFO  페이로드(자): ' + json.dumps(B['snap']['sizes']))
                print('  INFO  localStorage 키: %s · 총 %s자' % (B['snap']['keys'], B['snap']['bytes']))
                check('페이지 에러 0', not errs, (errs or [''])[0][:120])
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_facts.json' % label)).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n[%s] 영속 결함 %d건' % (label, len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
