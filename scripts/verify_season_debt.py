# -*- coding: utf-8 -*-
"""
시즌 초기화·로그아웃에서 «부채와 신용 이력이 지워지는가» — ★headless 전용(창을 띄우지 않는다).

  ML_DIST=dist/web python scripts/verify_season_debt.py <출력폴더> [라이브_v32.ait]

★★왜 생겼나 (2026-09-10 · President 실기기 발견 · 라이브 -32 결함)
  시즌을 초기화했는데 **대출 부채가 그대로 남았다.**
  실측 화면: 총자산 $9,988.27 · 현금 $42.06 · 퀄컴 93주 · 부채 $14,614.00 · 순자산 −$4,625.73 · 10001위(꼴찌).
  원인: `gameWorld.resetSeason()` 이 현금·보유·포지션·손익·카운터는 되돌리면서
        `acc.loans` 와 `acc.overdraft` 를 «건드리지 않았다». 같은 누락이 `resetPlayer()`(로그아웃)에도 있었다.
  ⇒ 포지션·손익은 전부 0 인데 부채만 남아 순자산이 즉시 마이너스 → 랭킹 꼴찌 고정 → 「다시 출발」이 성립하지 않는다.

★President 결정(2026-09-10) — 지울 것은 «네 개»다:
  ① `loans` ② `overdraft` ③ `delinquencyCount` ④ `bankruptcyCount`
  원문: 「시즌 초기화 후에는 연체 및 파산 내역 깨끗하게 지워」
  ⛔파산 «탕감» 경로(`world.declareOverdraftBankruptcy`)의 `bankruptcyCount += 1` 은 그대로다 — 거긴 영구 기록이다.

★무엇을 증명하나
  (0) ★양성대조 — 같은 검사를 «라이브 -32 번들»에 돌린다. 거기서 «반드시 실패»해야 한다.
      실패하지 않으면 이 검사기는 죽은 것이다(0건은 부재의 증거가 아니다).
  (A) 대출·연체·파산 이력이 있는 저장본 → 「새 시즌 시작」 → 넷 다 0 · 부채 표시 0 · 순자산 = 총자산.
  (A2) 마이너스 계좌(overdraft) 저장본 → 「새 시즌 시작」 → overdraft null · 현금 = 시드.
  (B) ★진짜 검사 — 리셋 «뒤» 주기 저장(SNAPSHOT_EVERY_TICKS=15틱 × TICK_MS=2s)이 한 번 돈 뒤 리로드해도 되살아나지 않는다.
  (C) 로그아웃 경로도 같다.
  (D) 신용등급이 «감점 없는» 계정과 같아진다(깨끗한 대조 계정과 등급·점수 비교).
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
import time
import zipfile
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, r'C:/Users/USER/tools')
from safe_headless_browser import open_browser  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _distguard import resolve_dist  # noqa: E402

VIEW = {'width': 390, 'height': 844}
SRC = (ROOT / 'src' / 'lib' / 'constants.ts').read_text(encoding='utf-8')
SEED_CASH = int(re.search(r'export const SEED_CASH = ([\d_]+);', SRC).group(1).replace('_', ''))
TICK_MS = int(re.search(r'export const TICK_MS = (\d+);', SRC).group(1))
SNAP_TICKS = int(re.search(r'export const SNAPSHOT_EVERY_TICKS = (\d+);', SRC).group(1))
SNAPSHOT_MS = TICK_MS * SNAP_TICKS


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


def extract_web(ait: Path, dest: Path) -> Path:
    """.ait 는 zip 이다 — 안의 «웹» 번들을 꺼낸다(verify_save_compat 와 같은 규약)."""
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


def kst_today():
    import datetime

    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)).strftime('%Y-%m-%d')


def make_save(cash, loans, overdraft, delinq, bankrupt, holdings=None):
    return {
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {
            'cash': float(cash),
            'holdings': holdings or [],
            'levPositions': [], 'optPositions': [], 'fwdPositions': [], 'swapPositions': [],
            'realizedPnl': 0.0, 'feesPaid': 0.0, 'tradeCount': 12,
            'liquidationCount': 0, 'topupCount': 0, 'bonusSeed': 0,
            'loans': loans, 'overdraft': overdraft,
            'delinquencyCount': delinq, 'bankruptcyCount': bankrupt,
        },
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0}, 'prices': {},
    }


LOAN = [{
    'id': 'L1', 'kind': 'unsecured', 'principal': 14000.0, 'accruedInterest': 614.0,
    'spreadBp': 900, 'grade': 'C', 'openedTick': 100, 'lastAccrualDay': 30,
    'delinquentDays': 0, 'marginCallDay': -1, 'interestPaid': 0,
}]
OVERDRAFT = {'spreadBp': 2500, 'sinceDay': 31, 'lastAccrualDay': 31}


def seed_js(save, season_ended=True):
    """localStorage 를 통째로 심는다. ★출석 보상은 «오늘 이미 받은» 상태로 만들어 잔고를 흔들지 않는다."""
    season = {'endAt': (1 if season_ended else 4102444800000), 'n': 3, 'extended': 0}
    return (
        "(() => {"
        "localStorage.setItem('ml.onboarded','1');"
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));"
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'light',updown:'kr'}));"
        "localStorage.setItem('ml.attendance', JSON.stringify({streak:1,lastClaimedDate:'%s',lastDoubledDate:'%s',totalUsd:5000}));"
        "localStorage.setItem('ml.season', JSON.stringify(%s));"
        "localStorage.setItem('ml.game', %s);})()"
        % (kst_today(), kst_today(), json.dumps(season), json.dumps(json.dumps(save)))
    )


ACC_JS = """() => {
  try {
    const g = JSON.parse(localStorage.getItem('ml.game') || 'null');
    if (!g || !g.account) return null;
    const a = g.account;
    return {
      savedAt: g.savedAt,
      cash: a.cash,
      loans: (a.loans || []).length,
      debt: (a.loans || []).reduce((s, l) => s + (l.principal || 0) + (l.accruedInterest || 0), 0),
      overdraft: a.overdraft === null || a.overdraft === undefined ? null : a.overdraft,
      delinquencyCount: a.delinquencyCount ?? 0,
      bankruptcyCount: a.bankruptcyCount ?? 0,
    };
  } catch (e) { return null; }
}"""

LOAN_SCREEN_JS = r"""() => {
  const t = (document.querySelector('.screen') || document.body).innerText;
  /* ★라벨은 「총 자산」처럼 «띄어쓰기»가 있다. 붙여 쓴 형태만 찾으면 null 이 나오고
     그 null 이 「검사가 통과하지 못했다」로 둔갑한다(첫 판 실측: total=None). ⇒ 공백을 허용해 찾는다. */
  const pick = (label) => {
    const re = new RegExp(label.split('').join('\\s*') + '[\\s\\S]{0,90}?(-?\\$[0-9][0-9,]*(?:\\.[0-9]+)?)');
    const m = t.match(re);
    return m ? Number(m[1].replace(/[$,]/g, '')) : null;
  };
  const gi = t.indexOf('신용등급');
  let grade = null, score = null;
  if (gi >= 0) {
    const seg = t.slice(gi, gi + 80);
    const gm = seg.match(/\b(AAA|AA|A|BBB|BB|B|CCC|CC|C|D)\b/);
    const sm = seg.match(/(\d{2,4})\s*$|점수\s*(\d{2,4})|·\s*[^\d]*?(\d{2,4})/);
    grade = gm ? gm[1] : null;
    score = sm ? Number(sm[1] || sm[2] || sm[3]) : null;
  }
  return { total: pick('총자산'), debt: pick('부채'), net: pick('순자산'), grade, score, raw: t.slice(0, 400) };
}"""

HOME_DEBT_JS = """() => {
  const t = (document.querySelector('.screen') || document.body).innerText;
  return { hasDebtChip: /부채\\s*\\$/.test(t) };
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_season_debt')
    out.mkdir(parents=True, exist_ok=True)
    live_ait = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '_built_moneyleague_01a08747_20260910-0249_v32.ait'

    dist = resolve_dist()
    httpd, port = serve(dist)
    base = 'http://127.0.0.1:%d/' % port

    rep = {'checks': [], 'fail': [], 'control': [], 'facts': {}}

    def check(name, ok, detail=''):
        rep['checks'].append([name, bool(ok), str(detail)])
        if not ok:
            rep['fail'].append([name, str(detail)])
        print('  %s  %s  %s' % ('PASS' if ok else '★FAIL', name, detail))

    print('dist = %s   (SEED_CASH=%d · 주기저장 %dms)' % (dist, SEED_CASH, SNAPSHOT_MS))

    with open_browser() as (_pw, browser):

        def new_ctx(url_base):
            ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
            errs = []
            ctx.on('weberror', lambda e: errs.append('PAGEERROR ' + str(e.error)))
            page = ctx.new_page()
            page.on('console', lambda m: errs.append('CONSOLE ' + m.type + ' ' + m.text) if m.type == 'error' else None)
            return ctx, page, errs

        def boot(page, url_base, save, route='#/home', wait='.tabbar', season_ended=True, settle=600):
            page.goto(url_base, wait_until='domcontentloaded')
            page.evaluate(seed_js(save, season_ended))
            page.goto(url_base + route, wait_until='domcontentloaded')
            page.wait_for_selector(wait, timeout=25000)
            page.wait_for_timeout(settle)

        def restart_season(page):
            """시즌 마감 화면에서 「새 시즌 시작」을 누른다. 못 찾으면 False."""
            try:
                page.wait_for_selector('.seasongate', timeout=25000)
            except Exception:
                return False
            page.evaluate(
                "() => { const b=[...document.querySelectorAll('.seasongate button')]"
                ".find(x=>/새 시즌 시작|New season/i.test(x.textContent||'')); b && b.click(); }"
            )
            page.wait_for_timeout(2500)
            return True

        def scenario_reset(url_base, tag, save, shots=True):
            """공통 시나리오 — 시즌 마감 → 새 시즌 시작 → 계좌 상태를 돌려준다."""
            ctx, page, errs = new_ctx(url_base)
            boot(page, url_base, save, route='#/home', wait='.seasongate', season_ended=True)
            before = page.evaluate(ACC_JS)
            if shots:
                page.screenshot(path=str(out / ('%s_before_gate.png' % tag)))
            ok = restart_season(page)
            page.goto(url_base + '#/loan', wait_until='domcontentloaded')
            page.wait_for_selector('.screen', timeout=25000)
            page.wait_for_timeout(900)
            screen = page.evaluate(LOAN_SCREEN_JS)
            if shots:
                page.screenshot(path=str(out / ('%s_after_loan.png' % tag)))
            page.goto(url_base + '#/home', wait_until='domcontentloaded')
            page.wait_for_selector('.tabbar', timeout=25000)
            page.wait_for_timeout(700)
            home = page.evaluate(HOME_DEBT_JS)
            after = page.evaluate(ACC_JS)
            if shots:
                page.screenshot(path=str(out / ('%s_after_home.png' % tag)))
            return {'ctx': ctx, 'page': page, 'errs': errs, 'gate': ok,
                    'before': before, 'after': after, 'screen': screen, 'home': home}

        def core_assertions(r):
            """★(0) 대조와 (A) 본검사가 «같은» 판정식을 쓴다 — 대조가 다른 식을 쓰면 대조가 아니다."""
            a = r['after'] or {}
            return [
                ('loans 0', a.get('loans') == 0, a.get('loans')),
                ('overdraft null', a.get('overdraft') is None, a.get('overdraft')),
                ('delinquencyCount 0', a.get('delinquencyCount') == 0, a.get('delinquencyCount')),
                ('bankruptcyCount 0', a.get('bankruptcyCount') == 0, a.get('bankruptcyCount')),
                ('부채 표시 0', (r['screen'] or {}).get('debt') == 0, (r['screen'] or {}).get('debt')),
                ('홈 부채 칩 없음', not (r['home'] or {}).get('hasDebtChip'), r['home']),
                ('순자산 = 총자산', (r['screen'] or {}).get('net') is not None
                 and (r['screen'] or {}).get('total') is not None
                 and abs((r['screen']['net'] or 0) - (r['screen']['total'] or 0)) < 0.02,
                 (r['screen'] or {}).get('net')),
            ]

        # ── (0) ★양성대조 — 라이브 -32 번들에서는 «반드시 실패»해야 한다 ──────────
        print('\n(0) ★양성대조 — 라이브 -32 번들(결함이 «있는» 판)에서 같은 검사가 실패하는가')
        if not live_ait.exists():
            check('★대조용 라이브 .ait 가 있다', False, str(live_ait))
        else:
            live_dir = extract_web(live_ait, ROOT / '_live_season_extracted')
            lhttpd, lport = serve(live_dir)
            lbase = 'http://127.0.0.1:%d/' % lport
            save = make_save(42.06, LOAN, None, 2, 1, holdings=[{'ticker': 'QCOM', 'qty': 93, 'avgCost': 150.0}])
            r0 = scenario_reset(lbase, 'CONTROL32', save)
            check('[대조] -32 에서도 「새 시즌 시작」 화면·버튼은 «있다»(조작 자체는 성립)', r0['gate'], r0['gate'])
            fired = [nm for nm, ok, _ in core_assertions(r0) if not ok]
            rep['control'] = fired
            rep['facts']['control_after'] = r0['after']
            for nm, ok, det in core_assertions(r0):
                print('    %s  [대조] %s  %s' % ('CAUGHT' if not ok else '★MISSED', nm, det))
            # ★대조에서 「부채가 남는다」가 «실제로» 보여야 한다
            check('★대조: -32 에서는 부채·이력이 남는다 = 검사기가 살아 있다(3항 이상 CAUGHT)',
                  len(fired) >= 3, '잡힌 항목 %d개: %s' % (len(fired), ', '.join(fired)))
            check('★대조: -32 저장본에도 대출이 그대로 남아 있다(loans>0 또는 debt>0)',
                  (r0['after'] or {}).get('loans', 0) > 0 or ((r0['screen'] or {}).get('debt') or 0) > 0,
                  r0['after'])
            r0['ctx'].close()
            lhttpd.shutdown()

        # ── (A) 시즌 초기화 — 대출 + 연체 + 파산 이력 ────────────────────────
        print('\n(A) 새 시즌 시작 — 대출·연체 이력·파산 이력이 «전부» 지워지는가')
        save = make_save(42.06, LOAN, None, 2, 1, holdings=[{'ticker': 'QCOM', 'qty': 93, 'avgCost': 150.0}])
        rA = scenario_reset(base, 'A_season', save)
        check('[A] 시즌 마감 화면에서 「새 시즌 시작」을 눌렀다', rA['gate'], rA['gate'])
        check('[A] 리셋 «전»에는 부채가 있었다(대조군 — 시드가 안 먹었으면 이 검사 전체가 무의미하다)',
              (rA['before'] or {}).get('loans') == 1 and (rA['before'] or {}).get('debt', 0) > 14000,
              rA['before'])
        for nm, ok, det in core_assertions(rA):
            check('[A] ' + nm, ok, det)
        check('[A] 현금이 시드로 돌아왔다', abs(((rA['after'] or {}).get('cash') or 0) - SEED_CASH) < 0.01,
              (rA['after'] or {}).get('cash'))
        check('[A] pageerror 0', not any('PAGEERROR' in e for e in rA['errs']),
              [e for e in rA['errs'] if 'PAGEERROR' in e][:2])
        rep['facts']['A_screen'] = rA['screen']
        rep['facts']['A_after'] = rA['after']
        gradeA, scoreA = (rA['screen'] or {}).get('grade'), (rA['screen'] or {}).get('score')

        # ── (B) ★진짜 검사 — 주기 저장 1회 뒤 리로드 ────────────────────────
        print('\n(B) ★주기 저장(%dms)이 한 번 돈 뒤 리로드 — 부채가 되살아나지 않는가' % SNAPSHOT_MS)
        page = rA['page']
        t0 = (rA['after'] or {}).get('savedAt')
        deadline = time.time() + SNAPSHOT_MS / 1000 + 20
        while time.time() < deadline:
            page.wait_for_timeout(1500)
            cur = page.evaluate(ACC_JS)
            if cur and cur.get('savedAt') != t0:
                break
        mid = page.evaluate(ACC_JS)
        check('[B] 리셋 «뒤» 주기 저장이 실제로 한 번 돌았다(savedAt 갱신 — 안 돌면 이 검사는 아무것도 증명 못 한다)',
              bool(mid) and mid.get('savedAt') != t0, '%s -> %s' % (t0, (mid or {}).get('savedAt')))
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.tabbar', timeout=25000)
        page.wait_for_timeout(1200)
        after2 = page.evaluate(ACC_JS)
        home2 = page.evaluate(HOME_DEBT_JS)
        check('[B] 리로드 뒤에도 loans 0 · overdraft null · 이력 0',
              bool(after2) and after2['loans'] == 0 and after2['overdraft'] is None
              and after2['delinquencyCount'] == 0 and after2['bankruptcyCount'] == 0, after2)
        check('[B] 리로드 뒤 홈에 부채 칩 없음', not home2.get('hasDebtChip'), home2)
        rep['facts']['B_after'] = after2
        rA['ctx'].close()

        # ── (A2) 마이너스 계좌(overdraft) ────────────────────────────────
        print('\n(A2) 마이너스 계좌(연체 잔액)도 지워지는가')
        save2 = make_save(-3200.0, [], OVERDRAFT, 3, 2)
        rA2 = scenario_reset(base, 'A2_overdraft', save2)
        check('[A2] 리셋 전에는 마이너스 계좌였다(대조군)',
              ((rA2['before'] or {}).get('cash') or 0) < 0 and (rA2['before'] or {}).get('overdraft') is not None,
              rA2['before'])
        for nm, ok, det in core_assertions(rA2):
            check('[A2] ' + nm, ok, det)
        check('[A2] 현금이 시드로 돌아왔다', abs(((rA2['after'] or {}).get('cash') or 0) - SEED_CASH) < 0.01,
              (rA2['after'] or {}).get('cash'))
        rA2['ctx'].close()

        # ── (C) 로그아웃 ────────────────────────────────────────────────
        print('\n(C) 로그아웃(계정 초기화) — 같은 네 가지가 지워지고 «되살아나지 않는가»')
        ctx, page, errs = new_ctx(base)
        save3 = make_save(42.06, LOAN, None, 2, 1, holdings=[{'ticker': 'QCOM', 'qty': 93, 'avgCost': 150.0}])
        # ★부팅이 «끝난 뒤» 눌러야 한다 — 부팅 도중에 로그아웃하면 부팅의 복원·출석 지급이
        #   초기화 «뒤»에 도착해 옛 계좌를 되살린다(실측: cash 42.06 + 출석 5000 = 5042.06 · loans 1).
        #   그건 이번 수정과 무관한 «부팅 경합»이라 여기서는 재현 조건을 피하고 보고서에 적는다.
        boot(page, base, save3, route='#/settings', wait='.screen', season_ended=False, settle=2500)
        before3 = page.evaluate(ACC_JS)
        check('[C] 로그아웃 «전»에는 부채가 있었다(대조군)',
              (before3 or {}).get('loans') == 1, before3)
        clicked = page.evaluate(
            "() => { const b=[...document.querySelectorAll('button')]"
            ".find(x=>/로그아웃|Log out|Sign out/i.test(x.textContent||'')); if(!b) return false; b.click(); return true; }"
        )
        page.wait_for_timeout(1500)
        post = page.evaluate(
            "() => ({ hash: location.hash, onboarded: localStorage.getItem('ml.onboarded'),"
            " game: localStorage.getItem('ml.game') === null ? null : 'present' })"
        )
        rep['facts']['C_postclick'] = post
        check('[C] 설정에서 로그아웃 버튼을 찾아 눌렀다', bool(clicked), clicked)
        check('[C] 로그아웃이 «실제로» 실행됐다(온보딩 해제 + 저장본 삭제 + /start 이동)',
              post.get('onboarded') is None and post.get('game') is None and '/start' in (post.get('hash') or ''),
              post)
        # ★로그아웃은 clearGame() 이라 저장본이 «없는» 게 정상이다 — 되살아나는지가 핵심이라 주기 저장을 기다린다
        deadline = time.time() + SNAPSHOT_MS / 1000 + 25
        seen = None
        while time.time() < deadline:
            page.wait_for_timeout(1500)
            seen = page.evaluate(ACC_JS)
            if seen is not None:
                break
        check('[C] ★로그아웃 뒤 주기 저장이 부채를 «다시 써넣지» 않는다(저장본이 없거나, 있어도 loans 0 · 이력 0)',
              seen is None or (seen['loans'] == 0 and seen['overdraft'] is None
                               and seen['delinquencyCount'] == 0 and seen['bankruptcyCount'] == 0),
              seen)
        rep['facts']['C_after'] = seen
        page.screenshot(path=str(out / 'C_after_logout.png'))
        ctx.close()

        # ── (D) 신용등급 복구 — «깨끗한» 계정과 같아지는가 ───────────────────
        print('\n(D) 신용등급 — 감점 이력이 사라졌으니 «처음부터 깨끗했던» 계정과 같아야 한다')
        ctx, page, errs = new_ctx(base)
        clean = make_save(SEED_CASH, [], None, 0, 0)
        boot(page, base, clean, route='#/loan', wait='.screen', season_ended=False)
        page.wait_for_timeout(900)
        cleanScreen = page.evaluate(LOAN_SCREEN_JS)
        page.screenshot(path=str(out / 'D_clean_loan.png'))
        ctx.close()
        rep['facts']['D_clean'] = cleanScreen
        check('[D] 리셋한 계정의 신용등급 = 깨끗한 계정의 신용등급 (★기대값을 코드에 박지 않고 «대조»로 잰다)',
              gradeA is not None and gradeA == cleanScreen.get('grade'),
              '리셋 %s(%s) vs 깨끗 %s(%s)' % (gradeA, scoreA, cleanScreen.get('grade'), cleanScreen.get('score')))

    httpd.shutdown()
    (out / 'season_debt_report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\n대조에서 잡힌 항목 %d개 · 검사 %d건 · ★실패 %d건 → %s'
          % (len(rep['control']), len(rep['checks']), len(rep['fail']), out))
    if rep['fail']:
        for nm, det in rep['fail']:
            print('  - %s  %s' % (nm, det))
        # ⛔대조 실패든 본검사 실패든 «똑같이» 종료코드에 실린다.
        #   (레인 A 사고: 양성대조 실패가 exit code 에 반영되지 않아 죽은 검사기가 통과로 읽혔다)
        sys.exit(1)
    print('OK')


if __name__ == '__main__':
    main()
