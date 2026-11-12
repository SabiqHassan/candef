import sys,subprocess,csv,io
csv.field_size_limit(10**9)
D="research-cache/gov-data/2026-10-13/"
bn,pat=sys.argv[1],sys.argv[2]
def rows(f,p):
    hdr=open(D+f,encoding="utf-8-sig").readline().strip().split(",")
    out=subprocess.run(["grep","-i","-E",p,D+f],capture_output=True,text=True,encoding="utf8",errors="replace").stdout
    return [dict(zip(hdr,r)) for r in csv.reader(io.StringIO(out))]
cs=[d for d in rows("contracts.csv",pat) if d.get("owner_org")=="dnd-mdn"]
cs.sort(key=lambda d:-float(d["contract_value"] or 0))
print("DND contracts:",len(cs))
for d in cs[:6]: print("  C",d["reference_number"],"|",d["procurement_id"],"|",d["vendor_name"][:40],d["vendor_postal_code"],d["contract_date"],d["contract_value"],"|",d["description_en"][:40])
gs=rows("grants.csv",bn)
seen=set()
for d in gs:
    k=(d["ref_number"],d["amendment_number"])
    if d.get("owner_org")=="dnd-mdn" or "Defence" in d.get("prog_name_en","") or "IDEaS" in d.get("prog_name_en",""):
        print("  G",d["ref_number"],"|",d["amendment_number"],"|",d.get("owner_org"),d["recipient_legal_name"][:34],d["recipient_postal_code"][:3],d["recipient_city"][:12],d["agreement_value"],d["agreement_start_date"],"|",d["prog_name_en"][:40],"|",d["agreement_title_en"][:60])
print("  all grants for BN:",len(gs),"legal names:",sorted({d["recipient_legal_name"] for d in gs})[:4])
