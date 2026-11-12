import sys,re
repo,sid=sys.argv[1:3]
p=f"{repo}/research/sources/{sid}.yaml"; t=open(p,encoding="utf8").read()
blk='''permissions:
  capture: denied
  retainInternal: denied
  quoteInternal: unknown
  redistributeExcerpt: denied
  automatedCollection: allowed
  attributionRequired: null
  basis: "OrgBook BC (read 2026-10-21): its API page says anyone may use OrgBook BC data in their own services through the API, and the data is provided under the BC government's Access Only Data terms, under which reproduction is not permitted without written permission. CANDEF therefore reads the record through the API and keeps no copy; facts are cited by locator only."
  termsReviewedAt: "2026-10-21"
'''
t=re.sub(r"permissions:\n(?:  .*\n)+?(?=captures:)",lambda m:blk,t)
open(p,"w",encoding="utf8").write(t)
