# -*- coding: utf-8 -*-
"""
광고 «상하 간격» 전수 조사 — 지면 11종 × (광고 있음 / 없음) × (라이트 / 다크). ★headless 전용.
⛔창을 띄우지 않는다(President 화면 점유 금지).

  python scripts/verify_adgaps.py <출력폴더>
  ML_DIST=_ait_web python scripts/verify_adgaps.py <출력폴더>   # ★출하물 검증

★★왜 이 파일이 따로 있나 (2026-08-21 President 지적)
  「광고 지면이 들어가서 상하 간격이 이상해진 것들이 좀 보여.」 — ★위치를 안 알려주셨다.
  ⇒ 화면을 하나씩 눈으로 찾는 대신 **11 지면 전부를 같은 자로 재고 스크린샷을 남긴다.**

★★두 상태를 «둘 다» 본다. 결함이 어느 쪽에서 나는지 다르다.
  · 광고 «있음» — `sessionStorage['ads.preview']='1'`. 토스 밖에서는 `adSlotVisible()` 이
    `bannerSupported() → isInToss()` 를 요구해 ★아무것도 안 그려진다(그게 정상이다).
  · 광고 «없음» — 미리보기 끄기. 이 앱의 «정상 경로»(itch.io·GitHub Pages·MS Store·로컬)다.
    ⇒ 여기서 재는 것은 ★«유령 여백»이다. `AdBanner` 가 null 을 돌려줘도 그것을 감싼
      래퍼의 padding·margin 은 «남는다». padding 은 마진 상쇄로 사라지지도 않는다.

★★대조를 «먼저» 통과해야 결과를 낸다(이 레포에서 죽은 검사기가 여러 건 나왔다).
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
VIEW_SHORT = {'width': 360, 'height': 640}  # ★세로 짧은 기기


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


def seed_journal(n):
    rows = []
    for i in range(n):
        rows.append({
            'id': 'j%d' % (n - i), 'at': 1700000000000 + i * 1000, 'tick': 100 + i,
            'gameDay': 1 + i // 4, 'product': 'spot' if i % 2 == 0 else 'leverage',
            'action': 'buy' if i % 3 else 'sell', 'ticker': ['NVDA', 'MSFT', 'TSLA', 'AAPL'][i % 4],
            'fee': 1.25, 'qty': 3, 'price': 100 + i, 'notional': 300 + i, 'realized': (i - 5) * 12.5,
        })
    return json.dumps(rows, ensure_ascii=False)


def seed_save(cash, holdings):
    """저장본 주입 — 잔고/보유를 «상태»로 만든다(UI 로 사는 경로는 다른 하네스가 검증한다)."""
    return json.dumps({
        'v': 1, 'savedAt': 1700000000000, 'tick': 3200,
        'account': {
            'cash': cash,
            'holdings': [[t, {'qty': q, 'avgCost': c}] for (t, q, c) in holdings],
            'levPositions': [], 'optPositions': [],
            'realizedPnl': 0, 'feesPaid': 0, 'tradeCount': 4,
            'liquidationCount': 0, 'topupCount': 0,
        },
        'topup': {'dateKey': '', 'usedToday': 0, 'lastTopupAt': 0},
        'prices': {},
    })


HOLD6 = [('NVDA', 8, 300), ('AAPL', 12, 200), ('MSFT', 20, 150),
         ('TSLA', 5, 400), ('AMD', 30, 90), ('GOOGL', 4, 420)]


def init_js(theme, ads, journal_n=20, watch=(), save=None):
    parts = [
        "localStorage.setItem('ml.onboarded','1');",
        "localStorage.setItem('ml.session', JSON.stringify({userId:'local',token:'',nickname:'리미'}));",
        "localStorage.setItem('ml.settings', JSON.stringify({lang:'ko',theme:'%s',updown:'kr'}));" % theme,
        "localStorage.setItem('ml.journal', %s);" % json.dumps(seed_journal(journal_n)),
    ]
    if watch:
        parts.append("localStorage.setItem('ml.traderwatch', %s);" % json.dumps(json.dumps(list(watch))))
    if save is not None:
        parts.append("localStorage.setItem('ml.game', %s);" % json.dumps(save))
    if ads:
        parts.append("sessionStorage.setItem('ads.preview','1');")
    else:
        parts.append("sessionStorage.removeItem('ads.preview');")
    return '(() => {' + ''.join(parts) + '})()'


# ── 측정기 ────────────────────────────────────────────────────────────────
# ★「광고 블록」의 정의: `.adslot` 에서 위로 올라가며, 부모가 «형제를 여러 개» 갖는
#   지점까지 간다. 그 지점의 요소가 곧 목록/섹션 흐름에서 광고가 «차지하는» 블록이다.
#   그래야 `<div class="sec"><AdBanner/></div>` 같은 래퍼의 여백까지 포함해서 잰다.
MEASURE_JS = r"""() => {
  const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
  const blockOf = (el) => {
    let cur = el;
    while (cur.parentElement && cur.parentElement.children.length === 1
           && !cur.parentElement.classList.contains('scroll')
           && cur.parentElement !== document.body) cur = cur.parentElement;
    return cur;
  };
  const out = [];
  for (const slot of document.querySelectorAll('.adslot')) {
    const blk = blockOf(slot);
    const r = blk.getBoundingClientRect();
    const sr = slot.getBoundingClientRect();
    const prev = blk.previousElementSibling;
    const next = blk.nextElementSibling;
    const pr = prev ? prev.getBoundingClientRect() : null;
    const nr = next ? next.getBoundingClientRect() : null;
    out.push({
      box: Math.round(sr.height), blockH: Math.round(r.height),
      top: Math.round(sr.top), bottom: Math.round(sr.bottom),
      gapAbove: pr ? Math.round(r.top - pr.bottom) : null,
      gapBelow: nr ? Math.round(nr.top - r.bottom) : null,
      prevCls: prev ? (prev.className || prev.tagName) : null,
      nextCls: next ? (next.className || next.tagName) : null,
      blockCls: blk.className || blk.tagName,
      padT: px(blk, 'paddingTop'), padB: px(blk, 'paddingBottom'),
      mT: px(blk, 'marginTop'), mB: px(blk, 'marginBottom'),
    });
  }
  return out;
}"""

# ★광고가 «없을 때» 남는 유령 여백 탐지기.
#   `.scroll`(또는 `.vlist`) 안의 «직계 자식» 중 높이가 0 인데 세로 padding/margin 이
#   남아 있는 요소를 찾는다. 화면마다 이름이 달라도 «모양»으로 잡힌다.
GHOST_JS = r"""() => {
  const px = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
  const roots = [...document.querySelectorAll('.scroll, .vlist, .screen')];
  const seen = new Set();
  const out = [];
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const c of el.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      const r = c.getBoundingClientRect();
      const pad = px(c, 'paddingTop') + px(c, 'paddingBottom');
      const mar = px(c, 'marginTop') + px(c, 'marginBottom');
      if (Math.round(r.height) === 0 && (pad + mar) > 0) {
        out.push({ cls: c.className || c.tagName, pad, mar, top: Math.round(r.top) });
      } else if (Math.round(r.height) <= pad && pad > 0 && c.children.length === 0) {
        out.push({ cls: c.className || c.tagName, pad, mar, top: Math.round(r.top), empty: true });
      }
      walk(c, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}"""

# 화면의 «리듬»(같은 흐름 안 형제들의 간격) — 광고 간격이 튀는지 비교할 기준
RHYTHM_JS = r"""(blockSel) => {
  const sc = document.querySelector('.scroll') || document.querySelector('.vlist');
  if (!sc) return null;
  const kids = [...sc.children].filter(e => e.getBoundingClientRect().height > 0);
  const gaps = [];
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i-1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
    gaps.push({ gap: Math.round(b.top - a.bottom), cls: (kids[i].className || kids[i].tagName).toString().slice(0,40) });
  }
  return gaps;
}"""


def main():
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else '_verify_adgaps')
    out.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f'http://127.0.0.1:{port}/'
    rep = {'dist': str(DIST), 'controls': [], 'slots': [], 'ghosts': []}
    fails = []

    def check(name, ok, detail=''):
        rep['controls'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            fails.append(name)
        print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + str(detail)) if detail != '' else ''))

    # 지면 → (해시 라우트, 준비 동작, 대기 셀렉터)
    CASES = [
        ('bannerHome', '#/home', None, '.screen', {}),
        ('bannerStocks', '#/stocks', 'scroll_stocks', '.screen', {}),
        ('bannerLeaderboard_all', '#/rank', None, '.screen', {}),
        ('bannerLeaderboard_watch', '#/rank', 'watch_tab', '.screen',
         {'watch': ['BOT001', 'BOT002', 'BOT003', 'BOT004', 'BOT005', 'BOT006', 'BOT007', 'BOT008', 'BOT009']}),
        ('bannerTraderProfile', '#/rank', 'open_trader', '.screen', {}),
        ('bannerSettings', '#/settings', None, '.screen', {}),
        ('bannerRechargeDone', '#/recharge', 'topup', '.screen', {'save': seed_save(80, [])}),
        # ★[2026-09-10 · -33] bannerDerivatives 케이스 제거 — 지면 자체를 코드에서 뺐다(verify_journal ⑩ 이 「.adslot 0」을 센다)
        ('bannerJournal', '#/journal', 'scroll_journal', '.jrow', {}),
        ('bannerStockDetail', '#/stock/NVDA', None, '.screen', {}),
    ]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)  # ⛔headless 고정
        try:
            # ── ① 대조: 측정기가 살아 있는가 ───────────────────────────
            print('\n① ★대조 (측정기 생존 증명)')
            ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init_js('light', True))
            page = ctx.new_page()
            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.wait_for_timeout(1500)
            n0 = len(page.evaluate(MEASURE_JS))
            check('①-a [양성] 광고 미리보기 ON 이면 .adslot 이 «있다»', n0 >= 1, n0)
            g0 = page.evaluate(GHOST_JS)
            page.evaluate("""() => {
                const sc = document.querySelector('.scroll');
                const d = document.createElement('div');
                d.id='__ghost'; d.style.cssText='padding:31px 0';
                sc.appendChild(d);
            }""")
            g1 = page.evaluate(GHOST_JS)
            check('①-b [양성] 유령여백 탐지기가 «빈 padding 상자»를 잡는다',
                  any(x.get('pad') == 62 for x in g1) and not any(x.get('pad') == 62 for x in g0),
                  f'{len(g0)} -> {len(g1)}')
            page.evaluate("() => document.getElementById('__ghost')?.remove()")
            g2 = page.evaluate(GHOST_JS)
            check('①-c [음성] 니들을 빼면 «원래»로 돌아온다', len(g2) == len(g0), f'{len(g1)} -> {len(g2)}')
            ctx.close()

            ctx = browser.new_context(viewport=VIEW, locale='ko-KR')
            ctx.add_init_script(init_js('light', False))
            page = ctx.new_page()
            page.goto(base + '#/home', wait_until='domcontentloaded')
            page.wait_for_timeout(1500)
            n1 = len(page.evaluate(MEASURE_JS))
            check('①-d [음성] 미리보기 OFF 면 .adslot 이 «0개»다 (토스 밖 정상 경로)', n1 == 0, n1)
            ctx.close()
            if fails:
                raise SystemExit('대조 실패 — 아래 숫자는 무효다')

            # ── ② 전수 측정 ───────────────────────────────────────────
            for theme in ('light', 'dark'):
                for ads in (True, False):
                    for view, vname in ((VIEW, '390x844'), (VIEW_SHORT, '360x640')):
                        if vname == '360x640' and theme == 'dark':
                            continue  # 짧은 기기는 라이트만(스크린샷 폭증 방지)
                        for slot, route, prep, wait_sel, extra in CASES:
                            ctx = browser.new_context(viewport=view, locale='ko-KR')
                            ctx.add_init_script(init_js(theme, ads, **extra))
                            page = ctx.new_page()
                            try:
                                page.goto(base + route, wait_until='domcontentloaded')
                                page.wait_for_selector(wait_sel, timeout=25000)
                                page.wait_for_timeout(1600)
                                if prep == 'watch_tab':
                                    page.get_by_role('tab').nth(1).click(timeout=4000)
                                    page.wait_for_timeout(900)
                                elif prep == 'open_trader':
                                    page.locator('.rk, .rkrow, [class*=rk]').first.click(timeout=4000)
                                    page.wait_for_timeout(1400)
                                elif prep == 'topup':
                                    page.locator('button.btn').first.click(timeout=4000)
                                    page.wait_for_timeout(1200)
                                elif prep == 'scroll_stocks':
                                    page.evaluate("""() => {
                                        const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
                                        if (sc) sc.scrollTop = 63 * 9;
                                    }""")
                                    page.wait_for_timeout(700)
                                elif prep == 'scroll_journal':
                                    page.evaluate("""() => {
                                        const sc = document.querySelector('.vlist') || document.querySelector('.scroll');
                                        if (sc) sc.scrollTop = 83 * 4;
                                    }""")
                                    page.wait_for_timeout(700)

                                m = page.evaluate(MEASURE_JS)
                                gh = page.evaluate(GHOST_JS) if not ads else []
                                rhythm = page.evaluate(RHYTHM_JS, '')
                                tag = f'{slot}__{theme}__{"ads" if ads else "noads"}__{vname}'
                                shot = out / f'{tag}.png'
                                page.screenshot(path=str(shot), full_page=False)
                                rep['slots'].append({
                                    'slot': slot, 'theme': theme, 'ads': ads, 'view': vname,
                                    'measured': m, 'ghosts': gh, 'rhythm': rhythm, 'shot': shot.name,
                                })
                                mark = m[0] if m else None
                                print(f'  {tag:62s} adslot={len(m)} ' +
                                      (f'box={mark["box"]} up={mark["gapAbove"]} dn={mark["gapBelow"]} blk={mark["blockCls"]}'
                                       if mark else ('ghosts=' + str([(g["cls"], g["pad"], g["mar"]) for g in gh]) if gh else '')))
                                # ★★광고가 «없을 때» 빈 상자가 남으면 실패다.
                                #   `AdBanner` 는 토스 밖에서 null 을 돌려주는데 그것을 «감싼» 래퍼의
                                #   padding·margin 은 살아남는다. 토스 밖은 이 앱의 «정상 경로»라
                                #   그 구멍은 실제 유저가 본다(V-2 ⛔6).
                                #   ⇒ 여백은 «래퍼»가 아니라 `AdBanner` 자신이 들어야 한다.
                                if not ads and gh:
                                    check(f'[유령여백] {tag}', False,
                                          str([(g['cls'], g['pad'], g['mar']) for g in gh]))
                            except Exception as e:  # noqa: BLE001
                                print(f'  ERR   {slot} {theme} ads={ads} {vname}: {str(e)[:140]}')
                                rep['slots'].append({'slot': slot, 'theme': theme, 'ads': ads,
                                                     'view': vname, 'error': str(e)[:300]})
                            finally:
                                ctx.close()
        finally:
            browser.close()
            httpd.shutdown()

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n산출: {out}')
    if fails:
        sys.exit(1)


if __name__ == '__main__':
    main()
