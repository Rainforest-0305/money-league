# -*- coding: utf-8 -*-
"""
.ait 프로모션 훅 검사기 (2026-08-29) — «0건은 부재의 증거가 아니다»

  python scripts/ait_scan_promo.py <file.ait> --mode canon
  python scripts/ait_scan_promo.py <file.ait> --mode testonly

  검사표                              canon        testonly
    새 코드 5종 각각(접두 무관)          >=1 each     >=1 each
    TEST_01M   (테스트 접두 코드)        == 0         >=5
    옛 코드 01M0X18BKA…                  == 0         == 0
    ★반려 코드 01M16CCAN…(100위, 08-29)  == 0         == 0
    규칙 태그 ml-promo-rules:…           streak=3;hold=10;cash=100000;equity=1000000;play=3600000
                                                     / streak=1;hold=2;cash=10000;equity=1;play=60000
    ★기준선 우회 표식 ml-promo-testonly:… == 0         >=1
    data-promo-<id>-amount               10/10/100/200/200 (canon·testonly 동일)

  함정 대응
    trap 1: .ait 은 zip → raw grep 무효. 풀어서 본다.
    trap 2: `TEST_` 만 찾으면 광고 SDK 의 TEST_MODE 가 잡힌다 → `TEST_01M` 으로 찾는다(★09-01 신설 코드는 01M1D… 라 01M16 으로는 안 잡힌다).
    trap 3: 웹 경로 앱은 RN 번들이 «셸»이라 앱 로직이 없다 → web/index.html · web/assets/*.js 를 본다.
            그래도 «전 엔트리»를 훑는다(어디 있든 잡히게).
    trap 4: 검사기 자체가 죽어 있을 수 있다 → L2 양성대조: 실제 .ait 를 «변조한 가짜 zip»을
            «같은 함수»에 태워 불합격이 나는지 확인하고, 원본은 통과하는지(음성대조) 본다.
"""
import io
import re
import sys
import zipfile

CODES = {
    'streak3': '__PROMOTION_CODE__',
    'hold10': '__PROMOTION_CODE__',
    'cash100k': '__PROMOTION_CODE__',
    # ★ 2026-09-01 신설 2종 (각 200원)
    'equity1m': '__PROMOTION_CODE__',
    'play1h': '__PROMOTION_CODE__',
}
AMOUNTS = {'streak3': '10', 'hold10': '10', 'cash100k': '100', 'equity1m': '200', 'play1h': '200'}
OLD_CODE = '01M0X18BKA' + '64324584DZYWNZJT'
# ★08-29 콘솔 «반려·종료»된 「100위 안에 들기」 코드 — 어느 빌드에도 0 이어야 한다
REJECTED_CODE = '01M16CCAN503' + 'FZZX3JR8MS7SKS'
# ★ 09-01: 신설 코드는 01M1D… 로 시작해 옛 접두 'TEST_01M16' 으로는 «안 잡힌다».
#    'TEST_' 만 찾으면 광고 SDK 의 TEST_MODE 가 잡힌다(trap 2) ⇒ 'TEST_01M' 이 유일하게 안전한 길이다.
TEST_PREFIX = 'TEST_01M'
TAG_RE = re.compile(r'ml-promo-rules:streak=(\d+);hold=(\d+);cash=(\d+);equity=(\d+);play=(\d+)')
EXPECT_TAG = {
    'canon': ('3', '10', '100000', '1000000', '3600000'),
    'testonly': ('1', '2', '10000', '1', '60000'),
}
# ★2026-09-01: TESTONLY 전용 「기준선 우회」 표식. promoCore.ts 의 우회 분기 안에 있는 문자열 리터럴이다.
#   canon 에 «한 건»이라도 있으면 소급 차단이 죽은 빌드다(기존 유저 전원에게 200원 → 예산 즉시 소진).
#   testonly 에 «0건»이면 우회가 번들에 안 실린 것이다(= President 기기에서 또 안 나간다).
IGNORE_BASE_MARK = 'ml-promo-testonly:ignore-baseline=1'
ESC = re.compile(r"\\u([0-9a-fA-F]{4})")


def unescape(s):
    return ESC.sub(lambda m: chr(int(m.group(1), 16)), s)


def scan(path_or_bytes):
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    z = zipfile.ZipFile(src)
    res = {'codes': {k: 0 for k in CODES}, 'test': 0, 'old': 0, 'rejected': 0, 'ignorebase': 0,
           'tags': set(), 'amounts': {}, 'entries': 0, 'hits': []}
    for n in z.namelist():
        if n.endswith('.map'):
            continue
        res['entries'] += 1
        u = unescape(z.read(n).decode('utf-8', errors='replace'))
        for k, c in CODES.items():
            cnt = u.count(c)
            if cnt:
                res['codes'][k] += cnt
                res['hits'].append((n, k, cnt))
        t = u.count(TEST_PREFIX)
        if t:
            res['test'] += t
            res['hits'].append((n, 'TEST_', t))
        o = u.count(OLD_CODE)
        if o:
            res['old'] += o
            res['hits'].append((n, 'OLD', o))
        rj = u.count(REJECTED_CODE)
        if rj:
            res['rejected'] += rj
            res['hits'].append((n, 'REJECTED', rj))
        ib = u.count(IGNORE_BASE_MARK)
        if ib:
            res['ignorebase'] += ib
            res['hits'].append((n, 'IGNORE_BASE', ib))
        for m in TAG_RE.finditer(u):
            res['tags'].add(m.groups())
        for k in CODES:
            for m in re.finditer(r'data-promo-%s-amount="(\d+)"' % k, u):
                res['amounts'].setdefault(k, set()).add(m.group(1))
    return res


def judge(res, mode):
    fails = []
    for k in CODES:
        if res['codes'][k] < 1:
            fails.append('code %s (%s) = 0' % (k, CODES[k]))
    if mode == 'canon' and res['test'] != 0:
        fails.append('%s = %d (must be 0 in canon)' % (TEST_PREFIX, res['test']))
    if mode == 'testonly' and res['test'] < len(CODES):
        fails.append('%s = %d (must be >=%d in testonly)' % (TEST_PREFIX, res['test'], len(CODES)))
    if res['old'] != 0:
        fails.append('OLD code present = %d' % res['old'])
    if res['rejected'] != 0:
        fails.append('REJECTED code (top100, console-rejected 08-29) present = %d' % res['rejected'])
    # ★기준선 우회 표식 — canon 0 / testonly >=1 («두 방향» 다 본다)
    if mode == 'canon' and res['ignorebase'] != 0:
        fails.append('%s = %d (must be 0 in canon - retroactive gate would be dead)' % (IGNORE_BASE_MARK, res['ignorebase']))
    if mode == 'testonly' and res['ignorebase'] < 1:
        fails.append('%s = 0 (must be >=1 in testonly - baseline bypass not in bundle)' % IGNORE_BASE_MARK)
    exp = EXPECT_TAG[mode]
    if not res['tags']:
        fails.append('rule tag not found (0 hits) — bundle may have tree-shaken it')
    elif res['tags'] != {exp}:
        fails.append('rule tag mismatch: got %s expected %s' % (sorted(res['tags']), exp))
    for k, a in AMOUNTS.items():
        got = res['amounts'].get(k, set())
        if got != {a}:
            fails.append('amount %s: got %s expected %s' % (k, sorted(got), a))
    return fails


def mutate(path, fn):
    """원본 .ait 의 각 엔트리에 fn(name, bytes)->bytes 를 적용한 가짜 zip 바이트."""
    zin = zipfile.ZipFile(path)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        for n in zin.namelist():
            zout.writestr(n, fn(n, zin.read(n)))
    return buf.getvalue()


def selftest(path, mode):
    out = []
    ok = True
    # (1) 옛 코드를 web/index.html 에 심는다 → 불합격이어야 한다
    planted = mutate(path, lambda n, b: b.replace(b'<body', b'<body data-promo-code="' + OLD_CODE.encode() + b'"') if n == 'web/index.html' else b)
    f = judge(scan(planted), mode)
    fired = any('OLD' in x for x in f)
    out.append('  [L2] old-code planted -> %s (%d fails)' % ('FIRED' if fired else 'SILENT!!', len(f)))
    ok &= fired
    # (1b) ★반려 코드(100위)를 심는다 → 불합격이어야 한다
    planted = mutate(path, lambda n, b: b.replace(b'<body', b'<body data-promo-cash100k-code="' + REJECTED_CODE.encode() + b'"') if n == 'web/index.html' else b)
    f = judge(scan(planted), mode)
    fired = any('REJECTED' in x for x in f)
    out.append('  [L2] rejected-code(top100) planted -> %s' % ('FIRED' if fired else 'SILENT!!'))
    ok &= fired
    # (2) 코드 하나를 지운다 → 불합격
    erased = mutate(path, lambda n, b: b.replace(CODES['hold10'].encode(), b'XXXXXXXXXXXXXXXXXXXXXXXXXX'))
    f = judge(scan(erased), mode)
    fired = any('code hold10' in x for x in f)
    out.append('  [L2] hold10 code erased -> %s' % ('FIRED' if fired else 'SILENT!!'))
    ok &= fired
    # (3) canon: TEST_ 접두를 심는다 / testonly: TEST_ 접두를 «뗀다» → 불합격
    if mode == 'canon':
        t = mutate(path, lambda n, b: b.replace(CODES['streak3'].encode(), b'TEST_' + CODES['streak3'].encode()) if n == 'web/index.html' else b)
        f = judge(scan(t), mode)
        fired = any(TEST_PREFIX in x for x in f)
        out.append('  [L2] TEST_ planted in canon -> %s' % ('FIRED' if fired else 'SILENT!!'))
    else:
        t = mutate(path, lambda n, b: b.replace(b'TEST_01M', b'01M'))
        f = judge(scan(t), mode)
        fired = any(TEST_PREFIX in x for x in f)
        out.append('  [L2] TEST_ stripped in testonly -> %s' % ('FIRED' if fired else 'SILENT!!'))
    ok &= fired
    # (3b) ★기준선 우회 표식 — canon: 심으면 불합격 / testonly: 떼면 불합격
    if mode == 'canon':
        t = mutate(path, lambda n, b: b + IGNORE_BASE_MARK.encode() if n == 'web/index.html' else b)
        f = judge(scan(t), mode)
        fired = any('ignore-baseline' in x for x in f)
        out.append('  [L2] ignore-baseline mark planted in canon -> %s' % ('FIRED' if fired else 'SILENT!!'))
    else:
        t = mutate(path, lambda n, b: b.replace(IGNORE_BASE_MARK.encode(), b'ml-promo-testonly:XXXXXX'))
        f = judge(scan(t), mode)
        fired = any('ignore-baseline' in x for x in f)
        out.append('  [L2] ignore-baseline mark stripped in testonly -> %s' % ('FIRED' if fired else 'SILENT!!'))
    ok &= fired
    # (4) 규칙 태그를 바꾼다 → 불합격
    wrong = b'ml-promo-rules:streak=9;hold=9;cash=9;equity=9;play=9'
    t = mutate(path, lambda n, b: TAG_RE.sub(lambda m: wrong.decode(), b.decode('utf-8', 'replace')).encode('utf-8') if n.startswith('web/assets/') and n.endswith('.js') else b)
    f = judge(scan(t), mode)
    fired = any('rule tag' in x for x in f)
    out.append('  [L2] rule tag altered -> %s' % ('FIRED' if fired else 'SILENT!!'))
    ok &= fired
    # (5) 음성대조 — 원본은 통과
    f = judge(scan(path), mode)
    out.append('  [L2] original (negative control) -> %s' % ('PASS' if not f else 'FAIL: ' + '; '.join(f)))
    ok &= not f
    return ok, out


def main():
    if len(sys.argv) < 4 or sys.argv[2] != '--mode' or sys.argv[3] not in EXPECT_TAG:
        print(__doc__)
        sys.exit(2)
    path, mode = sys.argv[1], sys.argv[3]
    res = scan(path)
    print('== %s  mode=%s  entries(non-map)=%d' % (path, mode, res['entries']))
    for k in CODES:
        print('  code %-8s %s : %d' % (k, CODES[k], res['codes'][k]))
    print('  %-10s : %d' % (TEST_PREFIX, res['test']))
    print('  OLD code   : %d' % res['old'])
    print('  REJECTED   : %d  (top100 %s)' % (res['rejected'], REJECTED_CODE))
    print('  IGNORE_BASE: %d  (%s)' % (res['ignorebase'], IGNORE_BASE_MARK))
    print('  rule tag   : %s' % (sorted(res['tags']) if res['tags'] else 'NOT FOUND'))
    print('  amounts    : %s' % {k: sorted(v) for k, v in res['amounts'].items()})
    print('  hits       : %s' % res['hits'])
    fails = judge(res, mode)
    ok, lines = selftest(path, mode)
    print('-- selftest (L2 positive/negative controls)')
    for l in lines:
        print(l)
    if not ok:
        print('SELFTEST FAIL — checker itself is not trustworthy; result below is void')
        sys.exit(3)
    if fails:
        print('RESULT: FAIL')
        for f in fails:
            print('  - ' + f)
        sys.exit(1)
    print('RESULT: PASS (%s)' % mode)


if __name__ == '__main__':
    main()
