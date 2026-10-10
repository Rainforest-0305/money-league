# -*- coding: utf-8 -*-
# .ait verifier
#  trap 1: .ait is a zip -> raw-byte grep is invalid. unzip first.
#  trap 2: Korean in RN bundles is \uXXXX escaped. UPPERCASE hex too -> [0-9a-fA-F]
#  trap 3: there are 4 RN bundles (ios/android x 0.84.0/0.72.6) -> check all
#
#  ── 2026-08-11 강화 (조직 규율 추가분 반영) ──────────────────────────────────
#  «양성대조 자체가 무력화될 수 있다»가 실제로 일어났다(ait_header.py 사례:
#  디코더 깊이 제한 때문에 본 검사와 양성대조가 «둘 다» 조용히 잘못된 답을 냈다).
#  교훈: 양성대조가 본 검사와 «같은 경로»를 타면 «같은 결함에 같이 걸린다».
#  그래서 이 검사기는 대조를 «두 층»으로 나눈다.
#     L1 (문자열 층)  : unescape/count 로직만 검증. zip 을 안 탄다.
#     L2 (파이프 전체) : «가짜 .ait(zip)» 를 만들어 «본 검사와 똑같은 함수»에
#                       통과시키고, 그것이 «불합격을 낸다»는 것을 확인한다.
#                       zip 읽기·디코딩 층의 결함은 L1 이 절대 못 잡는다.
#  그리고 대조가 «FIRE 했는지»를 수치로 출력한다 — «침묵»을 통과로 읽지 않는다.
import io
import os
import re
import sys
import tempfile
import zipfile

ESC = re.compile(r"\\u([0-9a-fA-F]{4})")   # backslash-u + 4 hex, EITHER CASE

# ★★[정정 2026-08-20] 정·오 표기가 «뒤집혀» 있었다.
#   이 검사기는 KO="머니리그"(붙여쓰기)를 «정»으로, "머니 리그"(띄어쓰기)를 «오»로 보고 있었다.
#   그런데 2026-08-19 President 승인 아래 앱 이름이 ★「머니 리그」로 확정됐다 —
#   앱인토스 콘솔 등록명과 달라 검수가 3초 만에 자동 반려됐고, 그 해소가 이 변경이다
#   (근거: src/lib/constants.ts 의 APP_NAME_KO 주석 · reviewRequestId 146453).
#
# ★그래서 이 검사기는 «죽어 있었다»:
#   ★승인돼 라이브로 나간 20260819-3 .ait 를 그대로 태워도 ★같은 FAIL(wrong 14)이 났다 [실측].
#   = 통과할 수 없는 게이트였다. 이대로 두면 다음 사람이 «앱 이름을 되돌려» 또 반려된다.
#   ⇒ 정·오를 «맞바꾼다». 이제 붙여쓰기 「머니리그」가 오표기다.
KO = "머니 리그"
EN = "Money League"
APPID = "moneyleague"
WRONG = ["머니리그", "머니리그게임", "네온스레드", "MoneyLeague"]


def unescape(s):
    return ESC.sub(lambda m: chr(int(m.group(1), 16)), s)


def esc_of(text, upper=True):
    """text 를 \\uXXXX 형태로. 백슬래시를 코드로 만들어 편집기/셸 훼손을 배제."""
    bs = chr(92)
    fmt = "u%04X" if upper else "u%04x"
    return "".join(bs + (fmt % ord(c)) for c in text)


# ══════════════════════════════════════════════════════════════════════════
#  본 검사 로직 — L2 대조와 «같은 함수»를 쓴다(그래야 대조가 의미를 갖는다)
# ══════════════════════════════════════════════════════════════════════════
def scan_archive(path_or_bytes):
    """.ait 를 열어 엔트리별 이름 카운트를 돌려준다."""
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    z = zipfile.ZipFile(src)
    result = {}
    for n in z.namelist():
        if n.endswith(".map"):
            continue
        u = unescape(z.read(n).decode("utf-8", errors="replace"))
        result[n] = {
            "ko": u.count(KO),
            "en": u.count(EN),
            "id": u.count(APPID),
            "wrong": sum(u.count(x) for x in WRONG),
        }
    return z.namelist(), result


def judge(names, res):
    """합격/불합격 판정. 실패 사유 리스트를 돌려준다."""
    fails = []
    rn = [n for n in names if re.match(r"bundle\.(ios|android)\.0_(84_0|72_6)\.js$", n)]
    if len(rn) != 4:
        fails.append(f"RN bundles {len(rn)} != 4")
    total_wrong = sum(v["wrong"] for v in res.values())
    if total_wrong:
        bad = {k: v["wrong"] for k, v in res.items() if v["wrong"]}
        fails.append(f"wrong-spelling {total_wrong} in {bad}")
    ko_in_rn = [n for n in rn if res.get(n, {}).get("ko", 0) > 0]
    if rn and len(ko_in_rn) != len(rn):
        fails.append(f"'{KO}' missing in {len(rn) - len(ko_in_rn)} RN bundle(s)")
    return fails, rn, total_wrong


# ══════════════════════════════════════════════════════════════════════════
#  L1 대조 — 문자열 층 (zip 을 «타지 않는다»)
# ══════════════════════════════════════════════════════════════════════════
def control_L1():
    print("-" * 84)
    print("[L1 대조] 문자열 층 — unescape/count 로직만. zip 경로를 «타지 않는다»")
    print("-" * 84)
    fires = 0
    ok = True

    upper = "X" + esc_of(KO, True) + "Y"
    lower = "X" + esc_of(KO, False) + "Y"
    print("   inputs: upper=%s  lower=%s" % (upper, lower))

    for label, s in (("UPPERCASE", upper), ("lowercase", lower)):
        hit = unescape(s).count(KO)
        good = hit == 1
        ok &= good
        fires += hit
        print("   %-10s escape -> found=%d  %s" % (label, hit, "PASS" if good else "*** FAIL ***"))

    naive = upper.count(KO)
    ok &= naive == 0
    print("   WITHOUT unescape -> found=%d  %s"
          % (naive, "PASS (0 이어야 정상 — 그래서 unescape 가 필수)" if naive == 0 else "*** FAIL ***"))

    absent = unescape(upper).count("네온스레드")
    ok &= absent == 0
    print("   absent name      -> found=%d  %s" % (absent, "PASS (거짓양성 없음)" if absent == 0 else "*** FAIL ***"))

    print("   >> L1 FIRE 수치 = %d (0 이면 대조가 «침묵»한 것 = 무효)" % fires)
    return ok and fires > 0


# ══════════════════════════════════════════════════════════════════════════
#  L2 대조 — 파이프 «전체». 가짜 zip 을 본 검사 함수에 통과시킨다
#  ★ L1 이 절대 못 잡는 층(zip 읽기·엔트리 열거·디코딩)을 여기서 잡는다
# ══════════════════════════════════════════════════════════════════════════
def make_fake_ait(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in entries.items():
            z.writestr(name, text.encode("utf-8"))
    return buf.getvalue()


def control_L2():
    print("-" * 84)
    print("[L2 대조] 파이프 전체 — 가짜 .ait(zip) 를 «본 검사 함수»에 통과시킨다")
    print("-" * 84)
    ok = True
    rn4 = ["bundle.ios.0_84_0.js", "bundle.android.0_84_0.js",
           "bundle.ios.0_72_6.js", "bundle.android.0_72_6.js"]

    # N1: 오표기가 «이스케이프된 채» 번들에 들어간 경우 (실제 반려 사유 재현)
    bad = {n: "x=" + esc_of("머니리그", True) + ";" for n in rn4}   # ★오표기 = 붙여쓰기
    bad["web/index.html"] = "<title>%s</title>" % KO
    names, res = scan_archive(make_fake_ait(bad))
    fails, _, wrong = judge(names, res)
    caught = len(fails) > 0
    ok &= caught
    print("   %-46s wrong=%d fails=%d  %s"
          % ("N1 오표기'머니리그'(대문자 이스케이프)", wrong, len(fails),
             "CAUGHT" if caught else "*** MISSED ***"))

    # N2: RN 번들이 4개가 아닌 경우
    short = {n: "y=" + esc_of(KO, True) for n in rn4[:3]}
    names, res = scan_archive(make_fake_ait(short))
    fails, rn, _ = judge(names, res)
    caught = any("RN bundles" in f for f in fails)
    ok &= caught
    print("   %-46s rn=%d fails=%d  %s"
          % ("N2 RN 번들 3개(4개여야 함)", len(rn), len(fails), "CAUGHT" if caught else "*** MISSED ***"))

    # N3: 이름이 «빠진» 번들 (이름 누락 = 표시 이름 불일치)
    missing = {n: "z=1;" for n in rn4}
    names, res = scan_archive(make_fake_ait(missing))
    fails, _, _ = judge(names, res)
    caught = any("missing in" in f for f in fails)
    ok &= caught
    print("   %-46s fails=%d  %s"
          % ("N3 번들에 이름 문자열 없음", len(fails), "CAUGHT" if caught else "*** MISSED ***"))

    # N4(거짓양성 방지): «정상» 가짜본은 통과해야 한다
    good = {n: "n=" + esc_of(KO, True) + ";app='" + APPID + "'" for n in rn4}
    good["web/index.html"] = "<title>%s</title>" % KO
    names, res = scan_archive(make_fake_ait(good))
    fails, _, _ = judge(names, res)
    ok &= len(fails) == 0
    print("   %-46s fails=%d  %s"
          % ("N4 정상 가짜본 (거짓양성 확인)", len(fails),
             "PASS" if not fails else "*** FALSE POSITIVE *** %s" % fails))
    return ok


def main(path):
    print("=" * 84)
    print("[POSITIVE CONTROL] 검사기가 «불합격을 잡는가»를 «두 층»에서 먼저 증명한다")
    print("=" * 84)
    l1 = control_L1()
    print()
    l2 = control_L2()
    print("\n  => L1 %s / L2 %s" % ("PASSED" if l1 else "FAILED", "PASSED" if l2 else "FAILED"))
    if not (l1 and l2):
        print("\n대조 실패 — 본 검사를 «하지 않는다».")
        sys.exit(1)

    print("\n" + "=" * 84)
    print("[MAIN CHECK] %s" % os.path.basename(path))
    print("=" * 84)
    names, res = scan_archive(path)
    z = zipfile.ZipFile(path)
    print("zip entries: %d" % len(names))
    fails, rn, wrong = judge(names, res)

    print("\n%-46s %8s %13s %12s %8s" % ("entry", KO, EN, APPID, "wrong"))
    for n in sorted(res):
        v = res[n]
        if v["ko"] or v["en"] or v["id"] or v["wrong"]:
            print("%-46s %8d %13d %12d %8d" % (n, v["ko"], v["en"], v["id"], v["wrong"]))
    print("   (이름이 0인 엔트리 %d개는 생략)" % sum(
        1 for v in res.values() if not (v["ko"] or v["en"] or v["id"] or v["wrong"])))

    print("\nRN host bundles      : %d/4" % len(rn))
    print("wrong-spelling total : %d" % wrong)
    print("zip CRC (testzip)    : %s" % (z.testzip() or "None (전 엔트리 정상)"))

    print("\n" + "-" * 84)
    print("HOOK / DEBUG (web assets only; RN hosts are SDK-owned)")
    print("-" * 84)
    pats = [("window.__ hook", r"window\.__[A-Za-z]"), ("debugger", r"\bdebugger\b"),
            ("console.log", r"console\.log"), ("__nativeStorageMirror", r"__nativeStorageMirror")]
    for n in sorted(x for x in names if x.startswith("web/") and (x.endswith(".js") or x.endswith(".html"))):
        u = unescape(z.read(n).decode("utf-8", errors="replace"))
        print("   %-34s %s" % (n, "  ".join("%s=%d" % (l, len(re.findall(p, u))) for l, p in pats)))

    print("\nRESULT:", "ALL PASS" if not fails else "*** FAIL *** %s" % fails)
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main(sys.argv[1])
