import re,html,sys,glob
p=glob.glob(f"research-cache/captures/{sys.argv[1]}/*.html")[0]
t=open(p,encoding="utf8",errors="replace").read()
t=re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>","",t); t=html.unescape(re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",t)))
k=sys.argv[2] if len(sys.argv)>2 else ""
i=t.find(k) if k else 0
print(t[max(0,i-200):i+int(sys.argv[3]) if len(sys.argv)>3 else i+1800])
