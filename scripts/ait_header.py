# -*- coding: utf-8 -*-
"""
.ait 컨테이너 «헤더» 디코드.

왜 필요한가: granite.config.ts 에 webViewProps.type:'game' 을 «썼다»는 것과
그 값이 «.ait 메타에 실제로 들어갔다»는 것은 다른 문제다. 게임 판정은 이
메타로 이루어지므로(cli: isGame = webViewProps?.type === "game"), 산출물을
열어 확인해야 검증이 끝난다.

스키마 없이 protobuf wire format 만으로 훑는다(필드명은 wire 에 안 남는다 —
그래서 값 자체를 보고 granite.config.ts 와 대조한다).
"""
import sys, zipfile, io

path = sys.argv[1]
raw = open(path, "rb").read()

print("=" * 78)
print("[1] 컨테이너 구조")
print("=" * 78)
print(f"  파일 크기      : {len(raw):,} B")
print(f"  선두 16바이트  : {raw[:16]!r}")
magic = raw[:8]
print(f"  magic          : {magic!r}")

# zip 시작 오프셋 찾기 (PK\x03\x04)
zoff = raw.find(b"PK\x03\x04")
print(f"  zip 시작 오프셋: {zoff}")
preamble = raw[:zoff]
print(f"  preamble 길이  : {len(preamble)} B")


def varint(b, i):
    r = 0
    s = 0
    while i < len(b):
        c = b[i]
        r |= (c & 0x7F) << s
        i += 1
        if not c & 0x80:
            return r, i
        s += 7
    return r, i


def walk(b, depth=0, out=None):
    """스키마 없는 protobuf 훑기. 길이지정 필드는 재귀 시도."""
    if out is None:
        out = []
    i = 0
    while i < len(b):
        try:
            key, i = varint(b, i)
        except Exception:
            break
        fn, wt = key >> 3, key & 7
        if fn == 0 or i > len(b):
            break
        if wt == 0:
            v, i = varint(b, i)
            out.append((depth, fn, "varint", v))
        elif wt == 2:
            ln, i = varint(b, i)
            if ln < 0 or i + ln > len(b):
                break
            chunk = b[i:i + ln]
            i += ln
            txt = None
            try:
                t = chunk.decode("utf-8")
                if t and all(ch == "\n" or ch == "\t" or ord(ch) >= 0x20 for ch in t):
                    txt = t
            except Exception:
                pass
            if txt is not None and len(txt) > 0:
                out.append((depth, fn, "string", txt))
            else:
                out.append((depth, fn, "bytes", f"<{len(chunk)}B>"))
                # ★ 깊이 제한 4 였을 때 brand/navigationBar/webViewProps 의 «값»에
                #   도달하지 못해 전부 FAIL 로 나왔다(검사기 한계지 실패가 아님).
                #   설정 맵이 key=field1 / value=field2>field5 로 한 단계 더
                #   중첩돼 있어 12 로 넉넉히 올린다.
                if depth < 12 and len(chunk) > 1:
                    walk(chunk, depth + 1, out)
        elif wt == 5:
            i += 4
            out.append((depth, fn, "fixed32", "-"))
        elif wt == 1:
            i += 8
            out.append((depth, fn, "fixed64", "-"))
        else:
            break
    return out


print("\n" + "=" * 78)
print("[2] preamble protobuf 훑기 — 값으로 config 와 대조한다")
print("=" * 78)
# magic + 고정 헤더를 건너뛰며 파싱 시작점을 찾는다
best = []
for start in range(0, min(64, len(preamble))):
    got = walk(preamble[start:])
    if len(got) > len(best):
        best, bstart = got, start
print(f"  (파싱 시작 오프셋 {bstart}, 필드 {len(best)}개)\n")
for depth, fn, wt, v in best:
    s = str(v)
    if len(s) > 88:
        s = s[:88] + "…"
    print(f"   {'  ' * depth}field {fn:<3} {wt:<8} {s}")

print("\n" + "=" * 78)
print("[3] granite.config.ts 값이 «실제로» 들어갔는가")
print("=" * 78)
strings = [v for _, _, wt, v in best if wt == "string"]
blob = "\n".join(strings)
EXPECT = {
    "appName 'moneyleague'": "moneyleague",
    # ★[정정 2026-08-21] 기대값이 ★«stale» 이었다 — 「머니리그」(붙여쓰기).
    #   ★2026-08-19 에 앱 이름이 ★「머니 리그」(띄어쓰기)로 «확정»됐다.
    #   콘솔 등록명과 달라 검수가 ★3초 만에 자동 반려된 그 사건의 «결과»가 띄어쓰기다.
    #   ⇒ 그런데 이 검사기는 옛 값을 그대로 들고 있어 ★«올바른 빌드»에 FAIL 을 찍고 있었다.
    #   ★검사기의 기대값이 틀리면 «맞는 것을 틀렸다»고 말한다 — 가장 나쁜 종류다.
    #   ★정본은 lib/constants.ts 의 APP_NAME_KO 이고 granite.config.ts 가 그걸 쓴다.
    "brand.displayName '머니 리그'": "머니 리그",
    # ★그리고 ★«붙여쓰기가 없어야 한다»는 것도 아래 음성대조에서 확인한다.
    "brand.primaryColor '#6b4eff'": "#6b4eff",
    "webViewProps.type 'game'  ★게임 판정의 전부": "game",
    "brand.icon publicUrl  ★2026-08-18 확정값": "https://static.toss.im/appsintoss/63105/cf3e3cfc-9c50-42e5-a0b4-329bd1164bfc.png",
    "navigationBar.theme 'light'": "light",
    "overScrollMode 'never'": "never",
}
ok = True
for label, needle in EXPECT.items():
    hit = needle in blob
    ok &= hit
    print(f"   {'PASS' if hit else '*** FAIL ***'}  {label:44s} needle={needle!r}")

print("\n   -- 양성대조: «없어야 할» 값은 안 잡히는가 (거짓양성 방지) --")
for needle in ["partner", "네온스레드", "#7dffd4", "dark"]:
    hit = needle in blob
    print(f"   {'(없음) OK' if not hit else '(있음) 확인필요'}  {needle!r}")

print("\n   ※ 'partner' 가 «없어야» 정상이다 — webViewProps.type 기본값이 'partner' 라,")
print("     그게 들어갔다면 게임으로 인식되지 않는다.")

print("\n" + "=" * 78)
print("[4] zip 내부 파일 무결성 (CRC 재계산)")
print("=" * 78)
z = zipfile.ZipFile(io.BytesIO(raw))
bad = z.testzip()
print(f"   zip testzip() -> {bad if bad else 'None (전 엔트리 CRC 정상)'}")
print(f"   엔트리 수     -> {len(z.namelist())}")

print("\nRESULT:", "ALL PASS" if (ok and bad is None) else "*** REVIEW ***")
