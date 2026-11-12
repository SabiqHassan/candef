import csv,sys,subprocess,io
csv.field_size_limit(10**9)
D="research-cache/gov-data/2026-10-13/"
def cons(pat):
    hdr=open(D+"contracts.csv",encoding="utf-8-sig").readline().strip().split(",")
    out=subprocess.run(["grep","-i","-E",pat,D+"contracts.csv"],capture_output=True,text=True,encoding="utf8",errors="replace").stdout
    for r in csv.reader(io.StringIO(out)):
        d=dict(zip(hdr,r))
        print("C",d["reference_number"],d["procurement_id"],d["vendor_name"][:45],d["vendor_postal_code"],d["contract_date"],d["contract_value"],d["owner_org"],"|",d["description_en"][:50])
def gr(pat):
    hdr=open(D+"grants.csv",encoding="utf-8-sig").readline().strip().split(",")
    out=subprocess.run(["grep","-i","-E",pat,D+"grants.csv"],capture_output=True,text=True,encoding="utf8",errors="replace").stdout
    for r in csv.reader(io.StringIO(out)):
        d=dict(zip(hdr,r))
        print("G",d["ref_number"],d["amendment_number"],d["owner_org"],d["recipient_legal_name"][:35],d["recipient_postal_code"][:3],d.get("recipient_city","")[:14],d.get("recipient_province","")[:3],d["agreement_value"],d["agreement_start_date"],d["prog_name_en"][:45],"|",d["agreement_title_en"][:70])
if sys.argv[1]=="c": cons(sys.argv[2])
else: gr(sys.argv[2])
