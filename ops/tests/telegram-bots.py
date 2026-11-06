#!/usr/bin/env python3
"""Isolated PG: bot-scoped receipts, concurrent delivery, legacy replay barrier and permissions."""
import concurrent.futures, json, pathlib, subprocess, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-bots-qa-"+uuid.uuid4().hex[:12]
def run(args, **kwargs):
    return subprocess.run(args,check=True,capture_output=True,text=True,**kwargs)
def sql(query,check=True):
    r=subprocess.run(["docker","exec","-i",NAME,"psql","-U","postgres","-X","-At","-v","ON_ERROR_STOP=1"],input=query,text=True,capture_output=True)
    if check and r.returncode: raise RuntimeError(r.stderr)
    return r
try:
    run(["docker","run","-d","--name",NAME,"--network","none","-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    for _ in range(60):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.3)
    else: raise RuntimeError("PG_NOT_READY")
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE telegram_updates(update_id bigint PRIMARY KEY); INSERT INTO telegram_updates VALUES(10);")
    sql((ROOT/"docs/migrations/0016_telegram_bot_receipts.sql").read_text())
    def claim(bot,update,legacy):
        return sql(f"SET ROLE service_role; SELECT claim_telegram_bot_update({bot},{update},{str(legacy).lower()});").stdout.strip().splitlines()[-1]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda _:claim(11,7,True),range(8)))
    assert results.count("t")==1 and results.count("f")==7
    assert sql("SELECT count(*) FROM telegram_updates WHERE update_id=7;").stdout.strip()=="1"
    assert claim(22,7,False)=="t"
    assert claim(22,7,False)=="f"
    assert claim(11,10,True)=="f"
    assert claim(22,10,False)=="t"
    assert sql("SET ROLE anon; SELECT claim_telegram_bot_update(1,1,false);",False).returncode
    assert sql("SET ROLE service_role; DELETE FROM telegram_bot_updates;",False).returncode
    assert sql("SET ROLE service_role; SELECT claim_telegram_bot_update(0,1,false);",False).returncode
    run(["docker","restart",NAME])
    for _ in range(60):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.3)
    assert claim(11,7,True)=="f"
    print(json.dumps({"botScoped":True,"concurrentSingleClaim":True,"legacyProtected":True,"permissions":True,"restartPreserved":True}))
finally:
    subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
