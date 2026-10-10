# -*- coding: utf-8 -*-
"""
출석표(7일 스트립 · 홈 칩 · 시트) 실렌더 검증 — ★headless 전용. ⛔창을 띄우지 않는다.

  ML_DIST=dist/web python scripts/verify_attend_ui.py <라벨> [출력폴더]

★무엇을 재나
  ① 홈 칩(.attchip): 한 줄 · 높이 ≥ 24 · 화면 안 · 인사말(.herotop__greet)과 겹치지 않음 · 문구 = 「출석 n/7 · 내일 $X」
  ② 시트(.attstrip): 칸 7개 · 금액 축약 7종 = ATTENDANCE_REWARDS · 금액 텍스트 넘침 0(scrollWidth ≤ clientWidth)
     · 받은 칸 수 = 주기 위치(pos) · 오늘 칸 = pos · 7일차 칸이 가장 크다(폭)
  ③ 충전 화면 소진 카드(.attstrip): 같은 검사
  ④ ★상태 진실: 저장본 ml.attendance.streak 에서 pos 를 «유도»해 DOM 과 대조 —
     이어짐(3→4) · 반토막(7, 4일 전 → 3) · 8일차(7, 어제 → 8 = 새 주기 1) · 처음(없음 → 1)
⛔양성대조 먼저: 금액 폰트를 40px 로 강제 → 넘침이 «잡히는지» / 칩 폭 40px 강제 → 줄바꿈이 «잡히는지».
★BEFORE 라벨(옛 빌드)은 선택자가 없으므로 「없음」으로 적고 스크린샷만 남긴다.
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
REWARDS = [5000, 10000, 15000, 20000, 30000, 40000, 100000]
COMPACT = ['$5K', '$10K', '$15K', '$20K', '$30K', '$40K', '$100K']
HOLD = ['VZ', 'NVDA', 'KO']


def kst_key(days_ago=0):
    d = datetime.now(KST) - timedelta(days=days_ago)
    return d.strftime('%Y-%m-%d')


def expected_pos(streak):
    return ((max(1, streak) - 1) % 7) + 1


CASES = {
    # 이름: (저장 streak, 마지막 지급 며칠 전, 부팅 뒤 기대 streak)
    'cont4': (3, 1, 4),
    'halved': (7, 4, 3),
    'day8': (7, 1, 8),
    'first': (0, None, 1),
}


def init(lang, theme, case, exhausted=False):
    streak, ago, _ = CASES[case]
    att = None if ago is None else {'streak': streak, 'lastClaimedDate': kst_key(ago), 'lastDoubledDate': None, 'totalUsd': 0}
    save = {
        'v': 1, 'savedAt': 0, 'tick': 0,
        'account': {'cash': 10000.0 if exhausted else 250000.0, 'holdings': [] if exhausted else [[t, {'qty': 40.0, 'avgCost': 100.0}] for t in HOLD],
                    'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
                    'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 0, 'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0},
        'topup': {'dateKey': kst_key(), 'usedToday': 3 if exhausted else 0, 'lastTopupAt': 0}, 'prices': {},
    }
    return ("(() => {localStorage.setItem('ml.onboarded','1');localStorage.setItem('ml.seed','20260829');"
            "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'Christopher12'}));"
            "localStorage.setItem('ml.settings', JSON.stringify({lang:'%s',theme:'%s',updown:'kr'}));"
            "if (localStorage.getItem('ml.__seeded') === '1') return; localStorage.setItem('ml.__seeded','1');"
            "localStorage.setItem('ml.game', %s);"
            "const at = %s; if (at) localStorage.setItem('ml.attendance', JSON.stringify(at)); else localStorage.removeItem('ml.attendance');"
            "sessionStorage.setItem('ads.preview','1');})()"
            % (lang, theme, json.dumps(json.dumps(save)), json.dumps(att)))


CHIP = """() => {
  const chip = document.querySelector('.attchip');
  const greet = document.querySelector('.herotop__greet');
  if (!chip) return { present: false };
  const r = chip.getBoundingClientRect();
  const g = greet ? greet.getBoundingClientRect() : null;
  const cs = getComputedStyle(chip);
  const fs = parseFloat(cs.fontSize) || 12;
  let lh = parseFloat(cs.lineHeight); if (!lh || Number.isNaN(lh)) lh = fs * 1.25;
  return {
    present: true, text: (chip.textContent || '').trim(), label: chip.getAttribute('aria-label') || '',
    h: r.height, w: r.width, l: r.left, r: r.right, lines: Math.round((r.height / Math.max(lh, r.height * 0.5)) * 10) / 10,
    inside: r.right <= window.innerWidth - 20 + 1,
    /* ★겹침 = 가로·세로 «둘 다» 교차할 때만. 긴 닉네임이면 칩이 «아래 줄»로 내려가는 게 설계다(.herotop flex-wrap) */
    overlap: g ? (g.right > r.left + 0.5 && g.bottom > r.top + 0.5 && r.bottom > g.top + 0.5) : false,
    wrapped: g ? r.top >= g.bottom - 0.5 : false,
    greetEllipsis: greet ? greet.scrollWidth > greet.clientWidth + 1 : false,
  };
}"""

STRIP = """() => {
  const strip = document.querySelector('.sheet .attstrip') || document.querySelector('.attstrip');
  if (!strip) return { present: false };
  const cells = [...strip.querySelectorAll('.attstrip__c')];
  const vals = cells.map((c) => c.querySelector('.attstrip__v'));
  const widths = cells.map((c) => c.getBoundingClientRect().width);
  const sr = strip.getBoundingClientRect();
  return {
    present: true, n: cells.length,
    texts: vals.map((v) => (v.textContent || '').trim()),
    overflow: vals.filter((v) => v.scrollWidth > v.clientWidth + 1).length,
    cellOverflow: cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
    done: cells.filter((c) => c.classList.contains('is-done')).length,
    todayIdx: cells.findIndex((c) => c.classList.contains('is-today')) + 1,
    peakIdx: cells.findIndex((c) => c.classList.contains('is-peak')) + 1,
    widths: widths.map((w) => Math.round(w * 10) / 10),
    stripInside: sr.right <= window.innerWidth + 1,
    title: (document.querySelector('.attsum__t') || {}).textContent || '',
    next: (document.querySelector('.attsum__next') || {}).textContent || '',
    lines: [...document.querySelectorAll('.attline')].map((e) => (e.textContent || '').trim()),
    nextWrap: (() => { const e = document.querySelector('.attsum__next'); if (!e) return false; const r = e.getBoundingClientRect(); const fs = parseFloat(getComputedStyle(e).fontSize) || 12; return r.height > fs * 1.9; })(),
  };
}"""

LEDGER = "() => { try { return JSON.parse(localStorage.getItem('ml.attendance') || 'null'); } catch { return null; } }"


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(DIST), **k)

    def log_message(self, *a):
        pass


def boot(p, base, route):
    p.goto(base + route, wait_until='domcontentloaded')
    p.wait_for_selector('.screen', timeout=120000)
    p.wait_for_selector('.boot', state='detached', timeout=180000)
    p.wait_for_timeout(1800)


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else 'x'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_verify_20260830_attend'
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

    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(headless=True)
            try:
                # ── 양성대조 ─────────────────────────────────────────────
                ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                ctx.add_init_script(init('ko', 'light', 'cont4'))
                p = ctx.new_page()
                boot(p, base, '#/home')
                if p.locator('.attchip').count() == 0:
                    print('  NOTE  %s: .attchip 없음(옛 빌드) — 측정 «없음», 스크린샷만' % label)
                    p.screenshot(path=str(out / ('%s_ko_375_home.png' % label)))
                    for lang in ('ko', 'en'):
                        c2 = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                        c2.add_init_script(init(lang, 'light', 'cont4', exhausted=True))
                        p2 = c2.new_page()
                        boot(p2, base, '#/recharge')
                        p2.screenshot(path=str(out / ('%s_%s_375_recharge.png' % (label, lang))), full_page=True)
                        c2.close()
                    ctx.close()
                    (out / ('%s_facts.json' % label)).write_text(json.dumps({'note': 'no .attchip'}, ensure_ascii=False), encoding='utf-8')
                    return 0
                p.evaluate("() => { const c = document.querySelector('.attchip'); c.style.whiteSpace = 'normal'; c.style.width = '40px'; c.style.height = 'auto'; c.style.display = 'block'; }")
                p.wait_for_timeout(100)
                pc1 = p.evaluate(CHIP)
                check('양성대조① 칩 폭 40px 강제 → 두 줄 «잡힘»', pc1['lines'] >= 1.6, 'lines=%s' % pc1['lines'])
                p.reload()
                boot(p, base, '#/home')
                p.locator('.attchip').click()
                p.wait_for_selector('.sheet .attstrip', timeout=10000)
                p.evaluate("() => document.querySelectorAll('.sheet .attstrip__v').forEach((v) => { v.style.fontSize = '40px'; })")
                p.wait_for_timeout(100)
                pc2 = p.evaluate(STRIP)
                check('양성대조② 금액 40px 강제 → 넘침 «잡힘»', pc2['overflow'] >= 1, 'overflow=%d' % pc2['overflow'])
                ctx.close()

                # ── 본검사: 상태 진실 (ko 375 light) ─────────────────────
                for case, (_, _, exp_streak) in CASES.items():
                    ctx = br.new_context(viewport={'width': 375, 'height': 812}, locale='ko-KR')
                    ctx.add_init_script(init('ko', 'light', case))
                    p = ctx.new_page()
                    boot(p, base, '#/home')
                    led = p.evaluate(LEDGER)
                    streak = (led or {}).get('streak', 0)
                    pos = expected_pos(streak)
                    chip = p.evaluate(CHIP)
                    check('[%s] 부팅 뒤 streak = %d' % (case, exp_streak), streak == exp_streak, 'streak=%s' % streak)
                    check('[%s] 칩 문구에 «%d/7»' % (case, pos), chip.get('present') and ('%d/7' % pos) in chip['text'], chip.get('text'))
                    p.locator('.attchip').click()
                    p.wait_for_selector('.sheet .attstrip', timeout=10000)
                    st = p.evaluate(STRIP)
                    check('[%s] 칸 7개' % case, st['n'] == 7)
                    check('[%s] 받은 칸 = pos(%d)' % (case, pos), st['done'] == pos, 'done=%d' % st['done'])
                    check('[%s] 오늘 칸 = pos(%d)' % (case, pos), st['todayIdx'] == pos, 'today=%d' % st['todayIdx'])
                    check('[%s] 금액 7종 = 규칙 상수 축약' % case, st['texts'] == COMPACT, ' '.join(st['texts']))
                    check('[%s] 「내일 오면」 = 다음 칸 금액' % case, ('$%s' % format(REWARDS[pos % 7], ',')) in st['next'], st['next'])
                    if pos < 7:
                        check('[%s] 7일차 예고 줄 있음' % case, any('7일차' in x and '$100,000' in x for x in st['lines']), ' | '.join(st['lines']))
                    else:
                        check('[%s] 7일차 당일엔 예고 줄 없음' % case, not any('7일차엔' in x for x in st['lines']), ' | '.join(st['lines']))
                    p.screenshot(path=str(out / ('%s_ko_375_sheet_%s.png' % (label, case))))
                    facts['state_%s' % case] = {'streak': streak, 'pos': pos, 'chip': chip, 'strip': st}
                    ctx.close()

                # ── 본검사: 레이아웃 (ko/en × 375/390/430 × light/dark) ────
                for theme in ('light', 'dark'):
                    for lang in ('ko', 'en'):
                        for width in (375, 390, 430):
                            key = '%s_%s_%d' % (theme, lang, width)
                            ctx = br.new_context(viewport={'width': width, 'height': 812}, locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, theme, 'cont4'))
                            p = ctx.new_page()
                            errs = []
                            p.on('pageerror', lambda e: errs.append(str(e)))
                            boot(p, base, '#/home')
                            chip = p.evaluate(CHIP)
                            check('[%s] 칩 한 줄·높이≥24·화면 안·인사말과 안 겹침·인사말 말줄임 0' % key,
                                  chip.get('present') and chip['lines'] < 1.6 and chip['h'] >= 24 and chip['inside'] and not chip['overlap'] and not chip['greetEllipsis'],
                                  'h=%.1f w=%.1f lines=%s inside=%s overlap=%s wrapped=%s greetEllipsis=%s "%s"' % (chip.get('h', 0), chip.get('w', 0), chip.get('lines'), chip.get('inside'), chip.get('overlap'), chip.get('wrapped'), chip.get('greetEllipsis'), chip.get('text')))
                            p.screenshot(path=str(out / ('%s_%s_%s_%d_home.png' % (label, theme, lang, width))))
                            p.locator('.attchip').click()
                            p.wait_for_selector('.sheet .attstrip', timeout=10000)
                            p.wait_for_timeout(350)
                            st = p.evaluate(STRIP)
                            check('[%s] 시트 스트립: 7칸·넘침 0·7일차 칸이 가장 넓음·「내일」 한 줄' % key,
                                  st['n'] == 7 and st['overflow'] == 0 and st['cellOverflow'] == 0 and st['stripInside'] and st['widths'][6] == max(st['widths']) and not st['nextWrap'],
                                  'widths=%s overflow=%d' % (st['widths'], st['overflow']))
                            p.screenshot(path=str(out / ('%s_%s_%s_%d_sheet.png' % (label, theme, lang, width))))
                            facts['sheet_%s' % key] = {'chip': chip, 'strip': st}
                            ctx.close()
                            # 충전 화면 소진 카드
                            ctx = br.new_context(viewport={'width': width, 'height': 812}, locale='ko-KR' if lang == 'ko' else 'en-US')
                            ctx.add_init_script(init(lang, theme, 'cont4', exhausted=True))
                            p = ctx.new_page()
                            boot(p, base, '#/recharge')
                            if p.locator('.attstrip').count() == 0:
                                check('[%s] 충전 화면에 출석표 있음' % key, False, '.attstrip 없음')
                            else:
                                p.locator('.attstrip').scroll_into_view_if_needed()
                                p.wait_for_timeout(200)
                                st2 = p.evaluate(STRIP)
                                check('[%s] 충전 카드 스트립: 7칸·넘침 0·7일차 최대·「내일」 한 줄' % key,
                                      st2['n'] == 7 and st2['overflow'] == 0 and st2['cellOverflow'] == 0 and st2['widths'][6] == max(st2['widths']) and not st2['nextWrap'],
                                      'widths=%s overflow=%d' % (st2['widths'], st2['overflow']))
                                facts['recharge_%s' % key] = st2
                            p.screenshot(path=str(out / ('%s_%s_%s_%d_recharge.png' % (label, theme, lang, width))))
                            if errs:
                                check('[%s] 페이지 에러 0' % key, False, errs[0][:120])
                            ctx.close()
            finally:
                br.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    (out / ('%s_facts.json' % label)).write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n출석표 결함 %d건' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
