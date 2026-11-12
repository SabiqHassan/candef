"""Terms-first check for a host: robots.txt, then the first existing legal page.
Prints only: robots rules for '*' (trimmed), which legal paths exist, and sentences about automation/copying.
Does NOT fetch the home page or any content page.
usage: terms.py https://www.example.com"""
import sys, re, urllib.request, html

base = sys.argv[1].rstrip("/")
UA = "Mozilla/5.0 (CANDEF research; one-off terms check)"


def get(url, n=400000):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        r = urllib.request.urlopen(req, timeout=25)
        return r.status, r.geturl(), r.read(n).decode("utf8", "replace")
    except Exception as e:
        return getattr(e, "code", 0), url, ""


st, u, robots = get(base + "/robots.txt")
print("ROBOTS", st, u)
if st == 200 and "<html" not in robots[:200].lower():
    keep = []
    on = False
    for line in robots.splitlines():
        l = line.strip()
        if l.lower().startswith("user-agent"):
            on = l.split(":", 1)[1].strip() == "*"
        if on and re.match(r"(?i)(disallow|allow|crawl-delay)", l):
            keep.append(l)
    print("  rules for *:", keep[:12] or "none")
else:
    print("  (no usable robots.txt)")

paths = ["/terms", "/terms-of-use", "/terms-of-service", "/terms-and-conditions", "/legal", "/terms-conditions", "/conditions", "/privacy-policy", "/privacy"]
found = None
for p in paths:
    st, u, body = get(base + p)
    if st == 200 and len(body) > 800:
        found = (p, u, body)
        if "term" in p or p in ("/legal", "/conditions"):
            break
if not found:
    print("TERMS none found at common paths")
    sys.exit()
p, u, body = found
print("TERMS page", u)
t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", body)
t = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t)))
hits = [s.strip() for s in re.split(r"(?<=[.;])\s+", t) if re.search(r"(?i)automat|scrap|crawl|\bbots?\b|robot|spider|systematic|data mining|reproduc|copy|download", s)]
for s in hits[:10]:
    print("  -", s[:300])
if not hits:
    print("  (no sentence about automation or copying)")
