# -*- coding: utf-8 -*-
"""
출하물 «내부 표지» 유출 검사 — 우리 소스에서 나온 것만 정확히 센다.

  python scripts/check_internal_leak.py [ait 경로]

══════════════════════════════════════════════════════════════════════════
★왜 «따로» 만들었나 (2026-08-23)
══════════════════════════════════════════════════════════════════════════
`_shared/preflight_ait.py` 의 `comment_leak()` 이 **오탐을 냈다**:
    FAIL  ★내부 주석 유출 — 주석 19개 중 1개에 내부 표지 (Partner×1)

실제로 걸린 것은 **프레임워크 코드**였다:
    @toss/tds-react-native 의 `PartnerWebViewScreen`
    @granite-js/react-native 의 라우터 코드

원인: 주석 정규식 `//([^\\n]*)` 과 `/*...*/` 가 **압축된 코드 안의 문자열·URL·정규식
리터럴**을 주석으로 오인해 «거대한 구간»을 한 덩어리로 잡는다. 그 안에 프레임워크의
`Partner…` 식별자가 들어 있으면 내부 표지로 «오판»한다.

⇒ ⛔**「주석만 본다」는 전제가 압축 번들에서 성립하지 않는다.**
⇒ 그래서 여기서는 **주석 범위를 가정하지 않고** 「우리가 쓴 «한국어 내부 문구»가
   번들에 있는가」를 직접 센다. 프레임워크는 한국어 내부 문구를 쓰지 않으므로
   식별자 오탐이 원천적으로 안 생긴다.

★유니코드 이스케이프를 «되돌린 뒤»가 아니라, ★**찾는 말을 이스케이프해서 같이 센다.**
  (번들에 한글이 \\uXXXX 로 박히는 구간이 실제로 있다 — 한쪽만 세면 「0건」이 거짓이 된다)

★양성대조 먼저: 어느 빌드에나 있는 말이 0건이면 검사기가 죽은 것이다.
"""
import sys
import zipfile
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent

# ★우리 소스에서만 나올 수 있는 «한국어 내부 문구». 프레임워크는 이런 말을 안 쓴다.
INTERNAL = [
    "Partner 승인", "Partner 결정", "Partner 게이트", "Partner 판정",
    "President 지시", "President 결정", "President 확정",
    "Chief 승인", "Chief 지시", "Chief 요구",
    "venture-cto", "venture-frontend", "venture-backend",
    "상신", "하드게이트", "인계문서", "실사고", "규율 L", "규율 M",
]
# 어느 빌드에나 있는 말 — 0건이면 «검사기 사망»
LIVE_CONTROL = "청산"


def escaped(s):
    """'청산' -> backslash-u 표기. 번들에 이스케이프된 채 들어간 경우를 잡는다."""
    return "".join("\\u%04x" % ord(c) for c in s)


def count_both(blob, needle):
    """리터럴 + 이스케이프 두 형태를 각각 세서 합친다. ⛔정규식 없음."""
    return blob.count(needle) + blob.count(escaped(needle))


def main():
    ait = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "moneyleague.ait"
    if not ait.exists():
        print("[FAIL] .ait 가 없다: %s" % ait)
        return 1

    with zipfile.ZipFile(ait) as z:
        names = [n for n in z.namelist() if not n.endswith((".map", ".png", ".woff2", ".jpg", ".ico"))]
        blob = ""
        for n in names:
            try:
                blob += z.read(n).decode("utf-8", "ignore")
            except Exception:
                pass

    ctl = count_both(blob, LIVE_CONTROL)
    if ctl == 0:
        print("[FAIL] 양성대조 실패 — 「%s」 0건. 검사기가 죽었다. 결과를 믿지 마라." % LIVE_CONTROL)
        return 1
    print("[OK] 양성대조: 「%s」 %d건 검출 — 검사기 생존 증명" % (LIVE_CONTROL, ctl))
    print("     검사 파일 %d개 · 총 %s 글자" % (len(names), format(len(blob), ",")))
    print()

    hits = {}
    for w in INTERNAL:
        c = count_both(blob, w)
        if c:
            hits[w] = c

    if hits:
        print("⛔내부 표지 유출 %d종:" % len(hits))
        for w, c in sorted(hits.items(), key=lambda x: -x[1]):
            print("   %-16s %d건" % (w, c))
        print()
        print("⇒ 소스 주석에서 해당 문구를 지워라. 출하물에 조직 내부 사정이 나간다.")
        return 1

    print("✓ 내부 표지 0건 — 우리 소스 주석은 출하물에 «없다»")
    print("  (검사 대상 %d종: %s …)" % (len(INTERNAL), ", ".join(INTERNAL[:4])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
