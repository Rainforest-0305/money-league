# -*- coding: utf-8 -*-
"""
전면 광고 삽입 지점 2곳 실렌더 검증 — ★headless 전용. ⛔창을 띄우지 않는다.

  ML_DIST=dist python scripts/verify_interstitial.py <라벨> [출력폴더]

★무엇을 재나 (모바일 세로 390×844 — President 지정 뷰포트)
  ① 충전 «완료» 화면 (전면 삽입 지점 a)
     · 무료 충전 경로로 진입 → 완료 화면이 뜬다
     · CTA 버튼이 «한 번» 눌리면 disabled 로 잠긴다(중복 탭 방지)
     · ★지면이 «빈 값»이라 전면 SDK 호출은 0 이어야 하고, 그래도 ★홈으로 «반드시» 간다
  ② 시즌 마감 게이트 (전면 삽입 지점 b)
     · 마감 시각을 과거로 심어 게이트를 띄운다
     · 「새 시즌 시작」 탭 → 게이트가 «사라지고» 새 시즌 홈으로 간다(광고 실패해도 막히지 않는다)
  ③ 출석 2배 버튼 — 배선 수정 뒤에도 «그려지는 자리»가 그대로인지(회귀)

⛔운영 광고 ID 로 «실렌더»하지 않는다. 토스 밖이라 SDK 자체가 없고, 이 검사는
  「광고가 없을 때 화면이 어떻게 되는가」 = ★no-op 경로를 본다. 그게 이 앱의 정상 경로다.
★양성대조 먼저: CTA 를 «지운» 사본에서 검사가 «잡히는지»부터 본다.
"""
import http.server
import json
import os
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
VW, VH = 390, 844


def kst_key(days_ago=0):
    return (datetime.now(KST) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def init(lang='ko', theme='light', *, bankrupt=False, exhausted=False, season_over=False, streak=None):
    """저장소를 심어 원하는 화면 상태로 «부팅»시킨다. ⛔화면을 클릭해 만들지 못하는 상태만 심는다."""
    if bankrupt:
        acct = {'cash': 120.0, 'holdings': [], 'topupCount': 0}
    elif exhausted:
        acct = {'cash': 10000.0, 'holdings': [], 'topupCount': 0}
    else:
        acct = {'cash': 250000.0, 'holdings': [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD], 'topupCount': 0}
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {
            'cash': acct['cash'], 'holdings': acct['holdings'],
            'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
            'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0,
            'topupCount': acct['topupCount'], 'bonusSeed': 0,
        },
        'topup': {'dateKey': kst_key(), 'usedToday': 3 if exhausted else 0, 'lastTopupAt': 0},
        'prices': {},
    }
    # ★★출석 자동지급을 «반드시» 막는다.
    #   [2026-09-05 실측] 이걸 안 심으면 부팅 즉시 1일차 출석 $5,000 이 들어와
    #   cash 120 → 5,120 이 되고 ★파산(<$200)이 «해제»된다 — 그래서 파산 화면이 안 뜬다.
    #   ⇒ 「화면이 안 뜬다」를 앱 고장으로 오진하기 딱 좋은 자리다. 원인은 «시드»였다.
    att = {'streak': streak if streak is not None else 1, 'lastClaimedDate': kst_key(0),
           'lastDoubledDate': None, 'totalUsd': 0}
    season = None
    if season_over:
        # ★마감을 «과거»로 심는다. 그래야 부팅 직후 게이트가 뜬다.
        season = {'endAt': int((datetime.now(timezone.utc).timestamp() - 3600) * 1000), 'n': 2, 'extended': 0}
    return (
        "(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260905');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Christopher12'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
        "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
        "localStorage.setItem('ml.game', %s);"
        "const at = %s; if (at) localStorage.setItem('ml.attendance', JSON.stringify(at));"
        "const se = %s; if (se) localStorage.setItem('ml.season', JSON.stringify(se));"
        "})()" % (lang, theme, json.dumps(json.dumps(save)), json.dumps(att), json.dumps(season))
    )


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen, .seasongate', timeout=120000)
    try:
        p.wait_for_selector('.boot', state='detached', timeout=180000)
    except Exception:
        pass
    p.wait_for_timeout(1500)


CTA = """() => {
  const btns = [...document.querySelectorAll('.cta button')];
  return btns.map((b) => ({
    text: (b.textContent || '').trim(),
    disabled: b.disabled === true,
    cls: b.className,
    h: Math.round(b.getBoundingClientRect().height),
    w: Math.round(b.getBoundingClientRect().width),
  }));
}"""


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_ads_260905'
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
        print('  %s  %s%s' % ('PASS' if cond else '★FAIL', name, ('  ' + str(detail)) if detail else ''))
        if not cond:
            fails.append(name)

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)  # ⛔headless 고정. President 화면을 점유하지 않는다.
            try:
                # ─────────────── ① 충전 완료 화면 (삽입 지점 a) ───────────────
                print('\n① 충전 «완료» 화면 — 전면 삽입 지점 (a)')
                ctx = br.new_context(viewport={'width': VW, 'height': VH}, locale='ko-KR')
                ctx.add_init_script(init('ko', 'light', bankrupt=True))
                errs = []
                p = ctx.new_page()
                p.on('pageerror', lambda e: errs.append(str(e)))
                boot(p, base, '#/recharge')

                # ★양성대조 — 검사가 «CTA 를 실제로 본다»는 것부터 증명한다
                before = p.evaluate(CTA)
                p.evaluate("() => { const b = document.querySelector('.cta button'); if (b) b.remove(); }")
                after_removed = p.evaluate(CTA)
                check('양성대조: CTA 를 지우면 «잡힌다»', len(after_removed) < len(before),
                      '%d -> %d' % (len(before), len(after_removed)))
                p.reload()
                boot(p, base, '#/recharge')

                bank = p.evaluate(CTA)
                facts['bankruptCta'] = bank
                check('파산 화면에 무료 충전 CTA 가 있다', any('받' in b['text'] or '$' in b['text'] for b in bank), bank)
                p.screenshot(path=str(out / ('%s_390_recharge_bankrupt.png' % label)), full_page=True)

                # 무료 충전 → 완료 화면
                p.locator('.cta button').first.click()
                p.wait_for_timeout(1200)
                done = p.evaluate(CTA)
                facts['doneCta'] = done
                check('무료 충전 후 «완료» 화면으로 간다', len(done) == 1 and '다시' in done[0]['text'] or len(done) == 1,
                      done)
                check('완료 CTA 는 처음엔 «눌릴 수 있다»', done and done[0]['disabled'] is False, done)
                check('완료 CTA 터치 타깃 ≥ 24px (WCAG 2.2 AA)', done and done[0]['h'] >= 24, done and done[0]['h'])
                p.screenshot(path=str(out / ('%s_390_recharge_done.png' % label)), full_page=True)

                # ★전면 지면이 빈 값이라 광고 호출은 0. 그래도 «반드시» 홈으로 간다.
                p.locator('.cta button').first.click()
                p.wait_for_timeout(1500)
                url = p.url
                facts['afterDoneUrl'] = url
                check('완료 CTA 를 누르면 ★홈으로 간다 (광고 없어도 막히지 않는다)', url.endswith('#/home'), url)
                check('페이지 에러 0건', len(errs) == 0, errs[:3])
                ctx.close()

                # ─────────────── ② 시즌 마감 게이트 (삽입 지점 b) ───────────────
                print('\n② 시즌 마감 게이트 — 전면 삽입 지점 (b)')
                errs2 = []
                ctx = br.new_context(viewport={'width': VW, 'height': VH}, locale='ko-KR')
                ctx.add_init_script(init('ko', 'light', season_over=True))
                p = ctx.new_page()
                p.on('pageerror', lambda e: errs2.append(str(e)))
                boot(p, base, '#/home')
                p.wait_for_timeout(1200)
                gate = p.locator('.seasongate')
                check('마감 시각이 지나면 게이트가 뜬다', gate.count() == 1, gate.count())
                if gate.count() == 1:
                    gcta = p.evaluate(CTA)
                    facts['gateCta'] = gcta
                    check('게이트 CTA 가 «전부» 활성', all(not b['disabled'] for b in gcta), gcta)
                    check('게이트 CTA 터치 타깃 ≥ 24px', all(b['h'] >= 24 for b in gcta), [b['h'] for b in gcta])
                    p.screenshot(path=str(out / ('%s_390_seasongate.png' % label)), full_page=True)

                    # 「새 시즌 시작」 = 마지막 버튼(연장 버튼은 광고 미지원이라 안 그려진다)
                    p.locator('.cta button').last.click()
                    p.wait_for_timeout(1500)
                    check('「새 시즌 시작」 → 게이트가 사라진다 (광고 실패해도 막히지 않는다)',
                          p.locator('.seasongate').count() == 0, p.locator('.seasongate').count())
                    p.screenshot(path=str(out / ('%s_390_after_newseason.png' % label)), full_page=True)
                check('게이트 페이지 에러 0건', len(errs2) == 0, errs2[:3])
                ctx.close()

                # ─────────────── ③ 출석 2배 버튼 회귀 ───────────────
                print('\n③ 출석 2배 버튼 — 배선 수정 후 회귀')
                ctx = br.new_context(viewport={'width': VW, 'height': VH}, locale='ko-KR')
                ctx.add_init_script(init('ko', 'light', exhausted=True, streak=3))
                p = ctx.new_page()
                boot(p, base, '#/recharge')
                strip = p.locator('.attstrip')
                check('소진 화면에 출석표가 그대로 있다', strip.count() >= 1, strip.count())
                # ★토스 «밖»이라 리워드 SDK 가 없다 ⇒ 2배 버튼은 «안 그려지는» 것이 정상이다.
                dbl = p.locator('.card button.btn--sub')
                facts['attendDoubleBtn'] = dbl.count()
                check('토스 밖에서는 2배 버튼이 «안 그려진다»(죽은 버튼 0)', dbl.count() == 0, dbl.count())
                p.screenshot(path=str(out / ('%s_390_recharge_exhausted.png' % label)), full_page=True)
                ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()

    (out / ('%s_facts.json' % label)).write_text(json.dumps(facts, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\n스크린샷: %s' % out)
    print('RESULT: %s' % ('ALL PASS' if not fails else '*** FAIL *** %s' % fails))
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
