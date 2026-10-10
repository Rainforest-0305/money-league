# -*- coding: utf-8 -*-
"""
.ait «세대 식별» — 저장본 4세대 대조 대상을 «파일명이 아니라 내용»으로 확정한다.

  python scripts/bench_ait_generation.py

★왜 필요한가 (Chief 지시 2026-08-22): 「파일명 말고 내장 deploymentId 로 대조하라」.
  그리고 「파생 이전 중간 세대」가 어느 파일인지 파일명만으로는 «확정되지 않는다».
  ⇒ 번들 «내용»으로 판정한다: 선도/스왑 유무(파생 세대) · topupAdUsed 유무(저장 스키마 세대).

⛔정규식을 쓰지 «않는다». check_position_paths.mjs 규약과 같다 —
  이 프로젝트는 이스케이프 사고가 반복됐고, 이 스크립트를 쓰는 동안에도 실제로 났다
  (re.error: incomplete escape). 문자열 탐색이면 그럴 일이 없다.

★유니코드 이스케이프를 «되돌리지» 않고, 대신 «찾는 말을 이스케이프해서» 같이 센다.
  번들에 한글이 backslash-u 형태로 박히는 구간이 실제로 있다
  (핸드오버: bootstrap.js 의 「선도」 리터럴 2건 + 이스케이프 2건).
  한쪽만 세면 「0건」이 거짓이 된다.

★양성대조: 「청산」은 «모든» 세대에 있다. 0건이면 그때가 검사기 사망이다.
  ⛔「머니 리그」를 생존 판정에 쓰면 «안 된다» — 2026-08-19 개명 이전 빌드는
    정상적으로 0건이라, 맞는 것을 틀렸다고 말하게 된다(ait_header.py stale 사고와 같은 형태).
"""
import glob
import hashlib
import os
import sys
import zipfile

# ★Windows 기본 stdout 은 cp949 라 특수기호에서 UnicodeEncodeError 로 죽는다(실제로 죽었다).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

LIVE_CONTROL = "청산"       # 모든 세대에 존재 -> 검사기 생존 증명용
BRAND = "머니 리그"          # 개명(2026-08-19) 이후에만 존재 -> 생존 판정에 쓰지 마라

PROBES = [
    "선도", "스왑", "fwdPositions", "swapPositions",  # 파생 세대
    "거래 일지",                                      # 일지 세대
    "topupAdUsed",                                    # ★저장 스키마 «중간 세대» 판별자
]


def escaped(s):
    """'선도' -> backslash-u 표기 문자열. 번들에 이스케이프된 채 들어간 경우를 잡는다."""
    out = []
    for c in s:
        out.append("\\u%04x" % ord(c))
    return "".join(out)


def count_both(blob, needle):
    """리터럴 + 이스케이프 두 형태를 각각 세서 합친다. 정규식 없음."""
    return blob.count(needle) + blob.count(escaped(needle))


def bundle_text(path):
    parts = []
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(".js") and not n.endswith(".map"):
                parts.append(z.read(n).decode("utf-8", "ignore"))
    return "".join(parts)


def deployment_id(blob):
    """'deploymentId' 뒤의 값을 문자열 탐색으로 뽑는다(정규식 없음)."""
    key = "deploymentId"
    i = blob.find(key)
    while i >= 0:
        j = i + len(key)
        while j < len(blob) and blob[j] in " \":='":
            j += 1
        k = j
        while k < len(blob) and (blob[k].isalnum() or blob[k] == "-"):
            k += 1
        val = blob[j:k]
        if len(val) >= 20:
            return val
        i = blob.find(key, i + 1)
    return "-"


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    files = sorted(set(
        glob.glob("_backup_ait_*/*.ait")
        + glob.glob("_release_snapshot_*/*.ait")
        + glob.glob("*.ait")
    ))
    if not files:
        print("[FAIL] .ait 를 하나도 못 찾았다")
        return 1

    rows = []
    dead = 0
    for f in files:
        try:
            blob = bundle_text(f)
        except Exception as e:
            print("[FAIL] %s: %s" % (f, e))
            dead += 1
            continue
        if count_both(blob, LIVE_CONTROL) == 0:
            print("[FAIL] 검사기 사망 — %s: 「%s」 0건. 이 파일 결과는 무효다" % (f, LIVE_CONTROL))
            dead += 1
            continue
        rows.append({
            "file": f.replace("\\", "/"),
            "dep": deployment_id(blob),
            "md5": hashlib.md5(open(f, "rb").read()).hexdigest(),
            "probes": dict((p, count_both(blob, p)) for p in PROBES),
            "brand": count_both(blob, BRAND) > 0,
        })

    if dead:
        print("\n[FAIL] 검사기 사망 %d건 — 그 파일들의 결과는 무효다\n" % dead)
    branded = sum(1 for r in rows if r["brand"])
    print("[OK] 양성대조: %d개 파일 «전부»에서 「%s」 검출 — 검사기 생존 증명" % (len(rows), LIVE_CONTROL))
    print("     「%s」는 %d/%d 건. 나머지는 2026-08-19 개명 «이전» 세대라 0건이 정상이다." % (BRAND, branded, len(rows)))
    print("     ⇒ 그래서 생존 판정에는 「%s」만 쓴다(개명과 무관한 말).\n" % LIVE_CONTROL)

    print("%-50s %-38s %-11s %s" % ("파일", "deploymentId", "md5", "".join(p.rjust(14) for p in PROBES)))
    for r in rows:
        print("%-50s %-38s %-11s %s%s" % (
            os.path.basename(r["file"])[:50],
            r["dep"],
            r["md5"][:10],
            "".join(str(r["probes"][p]).rjust(14) for p in PROBES),
            "" if r["brand"] else "  (개명 이전)",
        ))

    print("\n=== 세대 판정 ===")
    for r in rows:
        deriv = r["probes"]["fwdPositions"] + r["probes"]["swapPositions"]
        journal = r["probes"]["거래 일지"]
        if deriv and journal:
            gen = "파생+일지"
        elif deriv:
            gen = "파생만"
        else:
            gen = "파생 이전"
        daily = "daily 있음" if r["probes"]["topupAdUsed"] else "daily 없음"
        print("  %-50s %-12s %s" % (os.path.basename(r["file"])[:50], gen, daily))

    seen = {}
    for r in rows:
        seen.setdefault(r["md5"], []).append(os.path.basename(r["file"]))
    dup = dict((k, v) for k, v in seen.items() if len(v) > 1)
    if dup:
        print("\n[WARN] md5 가 «같은» 파일들 — 4세대 목록에 둘 다 넣으면 «공허한 중복»이다:")
        for k, v in dup.items():
            print("  %s: %s" % (k[:10], v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
