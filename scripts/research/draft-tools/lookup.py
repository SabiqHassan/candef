import csv,sys
csv.field_size_limit(10**9)
# usage: lookup.py <BN or name-regex>
q=sys.argv[1]
import re
for fn in ["corporations-active-cbca-en.csv","corporations-inactive-or-dissolved-cbca-en.csv"]:
    f=open("research-cache/corporations-canada/2026-10-16/"+fn,encoding="utf-8-sig",newline="")
    for r in csv.DictReader(f):
        if (q.isdigit() and r["Business number (BN)"]==q) or (not q.isdigit() and re.search(q,r["Corporate name - form 1"]+" "+r["Corporate name - form 2"],re.I)):
            print(fn[:20],r["Corporation number"],r["Business number (BN)"],r["Corporate name - form 1"],"|",r["Corporate name - form 2"],r["Status"],r["Status Detail"],r["Anniversary date"],r["City/town"],r["Province/territory"],r["Postal code"])
