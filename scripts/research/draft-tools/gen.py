import json,sys,subprocess,re,os
import os
REPO=os.environ.get("CANDEF_REPO",os.getcwd()).replace("\\","/")
CORP="src_172c3a6916b7@cap_01M5EKFAF4XWY3GFXKCD957YPK"
CON="src_54baa50305c0"; GR="src_06a51c1749c5"
spec=json.load(open(sys.argv[1],encoding="utf8"))
path=f"{REPO}/research/orgs/{spec['slug']}.yaml"
stub=open(path,encoding="utf8").read()
oid=re.search(r"id: (org_\w+)",stub).group(1)
def q(s): return json.dumps(s,ensure_ascii=False)
def cc(n): n=str(n); return n[:-1]+"-"+n[-1]
by=os.environ.get("CANDEF_AUTHOR","agent:claude-code/claude-sonnet-5-5")
DATE=os.environ.get("CANDEF_DATE","2026-10-21")
L=[]
L.append(f"# Created by candef new. Everything here stays proposed until the owner reviews it.\n# {spec.get('card','')} Drafted {DATE}. {spec.get('note','')}".rstrip())
L.append(f"org:\n  id: {oid}\n  kind: company\n  slug: {spec['slug']}\n  name: {q(spec['name'])}\ndefaults:\n  createdBy: {q(by)}\nfacts:")
reg=spec.get("corp")  # corporation number digits, in the federal dataset
loc=f"#corporation_number={reg}"
def fact(pred,value,srcs,extra=""):
    s=f"  - predicate: {pred}\n"+extra+f"    value: {value}\n    src: [\n"+"".join(f"        {q(x)},\n" for x in srcs)+"      ]"
    L.append(s)
fact("legal_name",q(spec["legal"]),(([f"{CORP}{loc} (Corporate name - form 1)"] if reg else [])+spec.get("legal_src",[])))
for r in spec.get("extra_regs",[]):
    fact("registry_id","{ system: %s, value: %s }"%(r["system"],q(r["value"])),r["srcs"])
if reg: fact("registry_id","{ system: corporations-canada, value: %s }"%q(cc(reg)),[f"{CORP}{loc} (Corporation number)"])
if spec.get("bn"):
    fact("registry_id","{ system: cra-bn, value: %s }"%q(spec["bn"]),(([f"{CORP}{loc} (Business number (BN))"] if reg else [])+spec.get("bn_src",[])))
h=spec["hq"]
fact("hq_location","{ city: %s, region: null, province: %s, country: CA%s }"%(q(h["city"]),h["prov"],(", postalCode: "+h["postal"]) if h.get("postal") else ""),
     (([f"{CORP}{loc} (City/town, Province/territory, Postal code)"] if reg and h.get("registry",True) else [])+h.get("src",[])),
     extra=("    # "+h["comment"]+"\n") if h.get("comment") else "")
fact("classified_as",q(spec["class"]),spec["class_src"],extra="    primary: true\n    epistemic: analyst_interpretation\n")
e=spec["elig"]
ev=[f"{CON}#reference_number={r}"+(f";procurement_id={p}" if p else "")+" (vendor_name, vendor_postal_code, contract_value, owner_org)" for r,p in e.get("contracts",[])]
ev+=[f"{GR}#ref_number={r};amendment_number={a} (recipient_legal_name, agreement_title_en, agreement_value)" for r,a in e.get("grants",[])]
ev+=e.get("src",[])
val=("    value:\n      decision: %s\n      rationale: %s\n      segments: [%s]\n      exclusion_check: { weapons_primary: %s, notes: %s }\n      entity_boundary: %s\n      reassess_by: \"2027-04\""
     %(e.get("decision","included"),q(e["rationale"]),spec["class"],str(e.get("weapons",False)).lower(),q(e.get("wnotes","")),q(e["boundary"])))
s=f"  - predicate: eligibility\n    epistemic: analyst_interpretation\n"+val+"\n    src: [\n"+"".join(f"        {q(x)},\n" for x in ev)+"      ]"
L.append(s)
for m in spec.get("more",[]):
    fact(m["pred"],m["value"],m["srcs"],extra=m.get("extra",""))
for f in spec.get("facts",[]): L.append(f)
L.append((spec["rounds_yaml"] if spec.get("rounds_yaml") else "rounds: []")+"\nagreements: []\nacquisitions: []\nresearch:")
for t in spec["ledger"]:
    L.append("  - {"+f" topic: {t['topic']}, sourcesSearched: {json.dumps(t['searched'],ensure_ascii=False)}, outcome: {t['outcome']}, by: {q(by)}, at: \"{DATE}\", nextReview: \"2027-04\" "+"}")
open(path,"w",encoding="utf8").write("\n".join(L)+"\n")
subprocess.run(["npx","prettier","--write",path],cwd=REPO,shell=True,capture_output=True)
print("wrote",path)
