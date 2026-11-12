import sys,re
# usage: setperm.py <repo> <target src id> <template src id>
repo,t,tpl=sys.argv[1:4]
T=open(f"{repo}/research/sources/{t}.yaml",encoding="utf8").read()
P=open(f"{repo}/research/sources/{tpl}.yaml",encoding="utf8").read()
blk=re.search(r"permissions:\n(?:  .*\n|\n)+?(?=captures:)",P).group(0)
T2=re.sub(r"permissions:\n(?:  .*\n)+?(?=captures:)",lambda m:blk,T)
open(f"{repo}/research/sources/{t}.yaml","w",encoding="utf8").write(T2)
print("ok",t)
