# -*- coding: utf-8 -*-
# Enumerate every hook/debug/url hit with surrounding context so none is hand-waved.
import re, sys, zipfile

ESC = re.compile(r"\\u([0-9a-fA-F]{4})")
unesc = lambda s: ESC.sub(lambda m: chr(int(m.group(1), 16)), s)

PATS = [
    ("window.__ hook", r"window\.__[A-Za-z_]+"),
    ("http:// url",    r"http://[^\s\"'`<>\\)]{0,70}"),
    ("https:// url",   r"https://[^\s\"'`<>\\)]{0,70}"),
    ("console.log",    r"console\.log"),
]

z = zipfile.ZipFile(sys.argv[1])
web = [n for n in z.namelist() if n.startswith("web/") and (n.endswith(".js") or n.endswith(".html"))]

for label, pat in PATS:
    print("=" * 84)
    print("### %s" % label)
    print("=" * 84)
    seen = {}
    for n in sorted(web):
        u = unesc(z.read(n).decode("utf-8", errors="replace"))
        for m in re.finditer(pat, u):
            key = (n, m.group(0))
            seen[key] = seen.get(key, 0) + 1
    if not seen:
        print("   (none)")
    for (n, txt), c in sorted(seen.items()):
        print("   %-34s x%-3d %s" % (n, c, txt))
    print()

# console.log call sites with a bit of context (which module emitted them)
print("=" * 84)
print("### console.log CONTEXT (first 60 chars after the call)")
print("=" * 84)
for n in sorted(web):
    if not n.endswith(".js"):
        continue
    u = unesc(z.read(n).decode("utf-8", errors="replace"))
    for m in re.finditer(r"console\.log\(", u):
        s = u[m.start(): m.start() + 90].replace("\n", " ")
        print("   %-34s %s" % (n, s))
