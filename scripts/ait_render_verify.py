# -*- coding: utf-8 -*-
"""
moneyleague.ait  실렌더 검증 (2026-08-18)

목적 3가지
  (1) .ait 안의 web/ 을 «그대로» 꺼내 실제 브라우저로 띄운다 (코드 읽기가 아니라 실행)
  (2) 네트워크 요청을 «전수» 기록하고 외부(비 localhost) 요청을 센다
  (3) ★검사기가 살아 있음을 «먼저» 증명한다 — 외부요청이 «있는» 양성대조 페이지를
      같은 레코더에 통과시켜 external>0 이 나오는지 확인. 안 나오면 본 검사의 0 은 무의미.

토스 웹뷰 모사: window.ReactNativeWebView 를 심으면 index.html 이 SW 등록을 건너뛴다.
그 분기까지 «둘 다» 돌려서 비교한다.
"""
import io, json, os, shutil, sys, threading, zipfile, http.server, socketserver, functools, time

AIT = sys.argv[1]
OUT = sys.argv[2]
PORT = 8099

os.makedirs(OUT, exist_ok=True)
root = os.path.join(OUT, "web")
if os.path.isdir(root):
    shutil.rmtree(root)
os.makedirs(root, exist_ok=True)

# ── .ait 에서 web/ 만 꺼낸다 ────────────────────────────────────────────────
raw = open(AIT, "rb").read()
z = zipfile.ZipFile(io.BytesIO(raw))
BS = chr(92)
n_ext = 0
for n in z.namelist():
    norm = n.replace(BS, "/")
    if not norm.startswith("web/"):
        continue
    rel = norm[len("web/"):]
    if not rel:
        continue
    dst = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(z.read(n))
    n_ext += 1
print("extracted web/ files:", n_ext)

# 양성대조용 페이지 — 외부 요청이 «확실히» 있는 페이지. 같은 레코더를 태운다.
POSCTRL = """<!doctype html><meta charset="utf-8"><title>posctrl</title>
<img src="https://static.toss.im/appsintoss/63105/cf3e3cfc-9c50-42e5-a0b4-329bd1164bfc.png" width="8">
<script>
  fetch('https://example.com/__needle_fetch__').catch(function(){});
  var s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/__needle_script__.js';
  document.head.appendChild(s);
</script>"""
open(os.path.join(root, "__posctrl__.html"), "w", encoding="utf-8").write(POSCTRL)

# ── 로컬 정적 서버 ──────────────────────────────────────────────────────────
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

Handler = functools.partial(Q, directory=root)
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % PORT
print("serving", root, "at", BASE)

from playwright.sync_api import sync_playwright

LOCAL_PREFIXES = (BASE + "/", BASE)
def is_external(u):
    if u.startswith("data:") or u.startswith("blob:") or u.startswith("about:"):
        return False
    return not u.startswith(BASE)

report = {"ait": os.path.abspath(AIT), "cases": {}}

def run_case(pw, name, url, toss_stub, do_flow, shot):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844},
                              device_scale_factor=2, locale="ko-KR")
    if toss_stub:
        ctx.add_init_script(
            "window.ReactNativeWebView = { postMessage: function(){} };")
    page = ctx.new_page()
    reqs, ext, perr, cerr = [], [], [], []
    page.on("request", lambda r: (reqs.append(r.url),
                                  ext.append(r.url) if is_external(r.url) else None))
    page.on("requestfailed", lambda r: reqs.append("[FAILED] " + r.url))
    page.on("pageerror", lambda e: perr.append(str(e)))
    page.on("console", lambda m: cerr.append(m.text) if m.type == "error" else None)
    page.goto(url, wait_until="networkidle")
    if do_flow:
        page.wait_for_timeout(1200)
        page.screenshot(path=os.path.join(OUT, shot + "_01_boot.png"))
        # 온보딩 진입 시도 — 첫 CTA 버튼 클릭 후 추가 요청이 있는지까지 본다
        for sel in ["text=60초 만에 시작하기", "button >> nth=0"]:
            try:
                el = page.locator(sel).first
                if el.count() and el.is_visible():
                    el.click(timeout=3000)
                    break
            except Exception:
                pass
        page.wait_for_timeout(1500)
        page.screenshot(path=os.path.join(OUT, shot + "_02_after_cta.png"))
        title = page.title()
        lang = page.evaluate("document.documentElement.lang")
        body = page.evaluate("document.body.innerText.slice(0,180)")
        swreg = page.evaluate(
            "navigator.serviceWorker ? navigator.serviceWorker.getRegistrations()"
            ".then(function(r){return r.length}) : Promise.resolve(-1)")
    else:
        page.wait_for_timeout(2500)
        title, lang, body, swreg = page.title(), "", "", None
    ctx.close(); browser.close()
    report["cases"][name] = {
        "url": url, "tossStub": toss_stub,
        "requestsTotal": len(reqs), "externalCount": len(ext),
        "externalUrls": sorted(set(ext)),
        "allRequests": reqs,
        "pageErrors": perr, "consoleErrors": cerr,
        "title": title, "htmlLang": lang, "bodyHead": body,
        "serviceWorkerRegistrations": swreg,
    }
    print("[%s] requests=%d external=%d sw=%s errors=%d/%d"
          % (name, len(reqs), len(ext), swreg, len(perr), len(cerr)))
    return len(ext)

with sync_playwright() as pw:
    # ★ 순서 중요: 양성대조를 «먼저» 돌려 레코더가 산다는 걸 증명한다
    pc = run_case(pw, "POSITIVE_CONTROL", BASE + "/__posctrl__.html", False, False, "pc")
    a = run_case(pw, "A_plain_browser", BASE + "/index.html", False, True, "A")
    b = run_case(pw, "B_toss_webview_stub", BASE + "/index.html", True, True, "B")

report["verdict"] = {
    "positiveControlExternal": pc,
    "recorderProvenAlive": pc > 0,
    "A_external": a, "B_external": b,
    "PASS": (pc > 0 and a == 0 and b == 0),
}
httpd.shutdown()
open(os.path.join(OUT, "render_report.json"), "w", encoding="utf-8").write(
    json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report["verdict"], ensure_ascii=False, indent=2))
print("RESULT:", "PASS" if report["verdict"]["PASS"] else "*** REVIEW ***")
