# -*- coding: utf-8 -*-
"""
moneyleague.ait — 결제/IAP/광고 SDK 코드 스캔 (2026-08-18)

★규율: 「0건」은 증거가 아니다. 대조를 «두 층»에 심는다.
  L1 문자열층 : 합성 버퍼를 «본 검사와 같은 함수»에 넣어 히트 수를 «수치»로 확인
  L2 파이프층 : 가짜 .ait(zip) 을 만들어 «본 검사와 같은 진입점»에 통과시킨다
                (zip 읽기·엔트리 열거 결함까지 잡힌다 — L1 은 원리적으로 못 잡는 층)
"""
import io, json, re, sys, zipfile

AIT = sys.argv[1]
BS = chr(92)

NEEDLES = {
    # 광고
    "googlesyndication": rb"googlesyndication",
    "adsbygoogle": rb"adsbygoogle",
    "admob": rb"(?i)admob",
    "adfit(kakao)": rb"(?i)adfit",
    "applovin": rb"(?i)applovin",
    "unityads": rb"(?i)unityads",
    "ironsource": rb"(?i)ironsource",
    "adsense": rb"(?i)adsense",
    "doubleclick": rb"(?i)doubleclick",
    "vungle/pangle": rb"(?i)(vungle|pangle)",
    # 결제 / IAP
    "in-app purchase": rb"(?i)in[-_ ]?app[-_ ]?purchase",
    "inAppPurchase ident": rb"inAppPurchase",
    "IAP token": rb"(?<![A-Za-z])IAP(?![A-Za-z])",
    "billing": rb"(?i)billing",
    "stripe": rb"(?i)stripe",
    "paypal": rb"(?i)paypal",
    "iamport": rb"(?i)iamport",
    "tosspayments": rb"(?i)tosspayments",
    "requestPayment": rb"requestPayment",
    "createPayment": rb"createPayment",
    "StoreKit": rb"StoreKit",
    "BillingClient": rb"BillingClient",
    "purchase(": rb"purchase[A-Za-z]*\s*\(",
}

TEXTY = (".js", ".css", ".html", ".json", ".map", ".txt")


def scan_bytes(buf):
    """단일 버퍼 스캔 — ★본 검사와 대조가 «같은 함수»를 탄다."""
    out = {}
    for label, pat in NEEDLES.items():
        hits = re.findall(pat, buf)
        if hits:
            out[label] = len(hits)
    return out


def scan_ait(path):
    """.ait 진입점 — L2 대조도 «이 함수»를 탄다."""
    raw = open(path, "rb").read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    per = {}
    scanned = skipped = 0
    for n in z.namelist():
        norm = n.replace(BS, "/")
        if not norm.lower().endswith(TEXTY):
            skipped += 1
            continue
        scanned += 1
        got = scan_bytes(z.read(n))
        if got:
            per[norm] = got
    return {"entries": len(z.namelist()), "scanned": scanned,
            "skippedBinary": skipped, "hits": per}


print("=" * 78)
print("[L1] 문자열층 대조 — 검사기가 «FIRE 하는지» 수치로 확인")
print("=" * 78)
synth = (b"var a=window.adsbygoogle||[];" +
         b"pagead2.googlesyndication.com/pagead/js/adsbygoogle.js " +
         b"import AdMob from 'admob'; kakao adfit unit; " +
         b"const IAP = require('react-native-iap'); in-app-purchase flow; " +
         b"BillingClient.startConnection(); Stripe('pk_live'); " +
         b"requestPayment({amount:1000}); StoreKit; purchaseItem();")
l1 = scan_bytes(synth)
print("  needle 합성버퍼 히트 :", json.dumps(l1, ensure_ascii=False))
print("  FIRE 라벨 수         :", len(l1), "/", len(NEEDLES))
l1_ok = len(l1) >= 12
print("  L1 판정              :", "ALIVE" if l1_ok else "*** DEAD (검사 무의미) ***")

print()
print("=" * 78)
print("[L2] 파이프층 대조 — 가짜 .ait 를 «본 검사 진입점»에 통과시킨다")
print("=" * 78)
fake = "C:/Users/USER/AppData/Local/Temp/claude/C--Users-urimk/6c09fee0-e9fe-4985-8b5b-f7ed5a2f171a/scratchpad/__fake_needle.ait"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as fz:
    fz.writestr("web/index.html", "<html><body>ok</body></html>")
    fz.writestr("web" + BS + "assets/index-DEADBEEF.js",
                "loadAd();(adsbygoogle=window.adsbygoogle||[]).push({});"
                "requestPayment({});BillingClient.x();")
    fz.writestr("web/assets/clean.css", "body{color:red}")
    fz.writestr("bundle.ios.js", "var iap = require('react-native-iap');")
open(fake, "wb").write(b"AITBUNDL" + bytes(8) + buf.getvalue())
l2 = scan_ait(fake)
print("  가짜본 엔트리 %d / 스캔 %d / 히트파일 %d"
      % (l2["entries"], l2["scanned"], len(l2["hits"])))
print("  " + json.dumps(l2["hits"], ensure_ascii=False, indent=2).replace("\n", "\n  "))
# ★대조는 «두 방향» 모두 확인한다: needle 파일은 잡히고(FIRE), clean 파일은 안 잡힌다(거짓양성 없음)
l2_fire = [k for k in l2["hits"] if "index-DEADBEEF" in k]
l2_quiet = not any("clean.css" in k for k in l2["hits"])
l2_ok = bool(l2_fire) and l2_quiet and len(l2["hits"][l2_fire[0]]) >= 4
print("  FIRE(needle파일) %s / QUIET(clean.css) %s" % (bool(l2_fire), l2_quiet))
print("  L2 판정              :", "ALIVE" if l2_ok else "*** DEAD (검사 무의미) ***")

print()
print("=" * 78)
print("[본검사] %s" % AIT)
print("=" * 78)
real = scan_ait(AIT)
print("  엔트리 %d / 텍스트 스캔 %d / 바이너리 건너뜀 %d"
      % (real["entries"], real["scanned"], real["skippedBinary"]))
if not real["hits"]:
    print("  히트 0건")
else:
    for f, h in sorted(real["hits"].items()):
        print("  HIT  %-38s %s" % (f, json.dumps(h, ensure_ascii=False)))

verdict = (l1_ok and l2_ok)
print()
print("RESULT:",
      ("검사기 ALIVE(2층) · 본검사 히트 %d파일" % len(real["hits"]))
      if verdict else "*** 검사기 신뢰불가 — 판정 보류 ***")
