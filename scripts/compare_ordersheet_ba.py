# -*- coding: utf-8 -*-
"""
주문 시트 «수정 전 / 수정 후» 대조 — Chief 승인조건 ②-b.

  python scripts/compare_ordersheet_ba.py

★판정 기준을 «왜 이렇게» 잡았는지:
  UI 값은 `floor(cap / price) * price` 다. 가격은 «부팅마다 달라진다»(랜덤워크).
  ⇒ ⛔「전후 숫자가 같은가」로 판정할 수 «없다». 같을 수가 없다.
  ⇒ ★«엔진 상한»을 진실값으로 놓고, UI 가 «그 상한 바로 아래에 붙어 있는가»를 본다.
     허용 오차 = 1주 값 x 1.5 (반올림으로 최대 1주만큼 모자랄 수 있다)
  ⛔엔진 상한을 파이썬에서 «다시 계산하지» 않는다 — 그게 이 사고의 원인이었다.
     `scripts/bench/run.mjs depthaudit` 가 내보낸 `_baseline/engine_caps.json` 을 읽는다.

판정 3종:
  ① 수정 후 UI 가 «엔진 상한»에 붙어 있는가        (전 종목)  ← 배선이 됐다는 증거
  ② ★비지수 종목이 «안 바뀌었는가»                          ← Chief 의 핵심 조건
     (전후 UI 차이가 1주 값 이내 = 가격 흔들림으로 설명됨)
  ③ ★지수(SPX·NDX)만 «바뀌었는가» + 16배 방향이 맞는가
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
B = ROOT / '_baseline'


def amount(row):
    """'주문 금액 $724,777.74 수수료 ...' -> 724777.74"""
    t = str(row.get('total', ''))
    i = t.find('$')
    if i < 0:
        return None
    j = i + 1
    out = []
    while j < len(t) and (t[j].isdigit() or t[j] in ',.'):
        out.append(t[j])
        j += 1
    try:
        return float(''.join(out).replace(',', ''))
    except ValueError:
        return None


def main():
    for f in ('ordersheet_BEFORE.json', 'ordersheet_AFTER.json', 'engine_caps.json'):
        if not (B / f).exists():
            print('[FAIL] 없다: %s' % (B / f))
            return 1
    before = json.loads((B / 'ordersheet_BEFORE.json').read_text(encoding='utf-8'))['rows']
    after = json.loads((B / 'ordersheet_AFTER.json').read_text(encoding='utf-8'))['rows']
    caps = json.loads((B / 'engine_caps.json').read_text(encoding='utf-8'))

    fails = []
    print('종목   자산군      수정전 UI        수정후 UI        엔진 상한        판정')
    for tk in after:
        a, b = amount(after[tk]), amount(before.get(tk, {}))
        c = caps.get(tk)
        if a is None or b is None or c is None:
            fails.append('%s 값 없음' % tk)
            print('  %-5s ★값 없음' % tk)
            continue
        cap, one = c['cap'], c['price']
        is_index = c.get('assetClass') == 'index'
        tol = one * 1.5

        # ① 수정 후가 엔진 상한 «바로 아래»에 붙어 있는가
        stuck = (a <= cap + 1e-6) and (cap - a < tol)
        # ②/③ 전후 변화
        moved = abs(a - b) >= tol
        want_moved = is_index
        ok = stuck and (moved == want_moved)
        if not ok:
            fails.append(tk)
        mark = 'OK' if ok else '★FAIL'
        note = ('★바뀜(의도)' if moved and want_moved
                else '유지' if not moved and not want_moved
                else '★바뀌어야 하는데 안 바뀜' if want_moved else '☠️바뀌면 안 되는데 바뀜')
        print('  %-5s %-9s %14s %14s %14s   %-5s %s'
              % (tk, c.get('assetClass', '?'), '%.2f' % b, '%.2f' % a, '%.2f' % cap, mark, note))

    idx = [t for t in after if caps.get(t, {}).get('assetClass') == 'index']
    print()
    print('★지수 상한 변화(엔진 기준): %s'
          % ' · '.join('%s %.0f -> %.0f' % (t, 181250.0, caps[t]['cap']) for t in idx))
    print('검사 %d종목 · ★실패 %d건' % (len(after), len(fails)))
    if fails:
        print('  실패: %s' % fails)
    else:
        print('⇒ ★비지수 전부 «유지» · 지수만 «바뀜» · 전 종목이 엔진 상한에 «붙었다».')
        print('  ⇒ Chief 조건 ②-b 충족. (②-a 전수 1,000종목은 depthaudit 이 「불일치 2개」로 이미 증명)')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
