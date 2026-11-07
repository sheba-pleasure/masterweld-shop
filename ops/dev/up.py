#!/usr/bin/env python3
"""Create or resume ONLY the masterweld-dev stack. Never reads production secrets."""
import base64, hashlib, hmac, json, os, pathlib, secrets, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
PRIVATE = ROOT / "ops/.secrets/dev"
STATE = ROOT / "ops/.state/dev"
INSTANCE = "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"
DOMAIN = "masterweld-dev.138-124-106-211.sslip.io"

def run(args, **kw):
    return subprocess.run(args, check=True, **kw)

def capture(args):
    return run(args, capture_output=True, text=True).stdout.strip()

def exists(kind, name):
    return subprocess.run(["docker",kind,"inspect",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

def private_file(name, content):
    p=PRIVATE/name
    fd=os.open(p, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    with os.fdopen(fd,"w") as f: f.write(content)

def jwt(secret, role):
    enc=lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
    head=enc(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
    body=enc(json.dumps({"role":role,"iss":"masterweld-dev","ref":"mw-dev","iat":int(time.time()),"exp":int(time.time())+31536000},separators=(",",":")).encode())
    msg=head+b"."+body
    return (msg+b"."+enc(hmac.new(secret.encode(),msg,hashlib.sha256).digest())).decode()

def owned(kind, name):
    data=json.loads(capture(["docker",kind,"inspect",name]))[0]
    labels=data.get("Labels") or data.get("Config",{}).get("Labels") or {}
    if labels.get("mw.environment")!="dev": raise SystemExit("Refusing unlabelled/foreign resource: "+name)

def container(name, args):
    if exists("container",name):
        owned("container",name)
        run(["docker","start",name],stdout=subprocess.DEVNULL)
    else:
        run(["docker","run","-d","--name",name,"--label","mw.environment=dev","--restart","unless-stopped",*args],stdout=subprocess.DEVNULL)

def sql(text):
    run(["docker","exec","-i","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-v","ON_ERROR_STOP=1","-X","-q"],input=text,text=True,stdout=subprocess.DEVNULL)

def main():
    if sys.argv[1:] not in ([],["--database-only"]): raise SystemExit("Usage: python3 ops/dev/up.py [--database-only]")
    PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not (PRIVATE/"credentials.json").exists():
        if exists("volume","mw-dev-pgdata"): raise SystemExit("Existing database volume has no credentials. Restore secrets; do not regenerate.")
        conf={"db":secrets.token_hex(24),"api":secrets.token_hex(24),"jwt":secrets.token_hex(32)}
        conf["anon"]=jwt(conf["jwt"],"anon"); conf["service"]=jwt(conf["jwt"],"service_role")
        private_file("credentials.json",json.dumps(conf))
        private_file("postgres.env","POSTGRES_DB=masterweld_dev\nPOSTGRES_PASSWORD="+conf["db"]+"\n")
        private_file("postgrest.env","PGRST_DB_URI=postgres://authenticator:"+conf["api"]+"@mw-dev-db:5432/masterweld_dev\nPGRST_DB_SCHEMAS=public\nPGRST_DB_ANON_ROLE=anon\nPGRST_JWT_SECRET="+conf["jwt"]+"\nPGRST_DB_MAX_ROWS=1000\n")
        private_file("app.env","APP_ENV=dev\nVITE_APP_ENV=dev\nMW_INSTANCE_ID="+INSTANCE+"\nPUBLIC_ORIGIN=https://"+DOMAIN+"\nSUPABASE_URL=http://mw-dev-gateway:8080\nSUPABASE_PUBLISHABLE_KEY="+conf["anon"]+"\nSUPABASE_SERVICE_ROLE_KEY="+conf["service"]+"\nTELEGRAM_TRANSPORT=direct\nTELEGRAM_ENABLED=false\n")
        private_file("build-public.env","VITE_APP_ENV=dev\nVITE_SUPABASE_URL=https://"+DOMAIN+"/backend\nVITE_SUPABASE_PUBLISHABLE_KEY="+conf["anon"]+"\nVITE_SUPABASE_PROJECT_ID=mw-dev\n")
    conf=json.loads((PRIVATE/"credentials.json").read_text())
    for name,internal in [("mw-dev-private",True),("mw-dev-edge",False)]:
        if not exists("network",name):
            run(["docker","network","create","--label","mw.environment=dev",*(["--internal"] if internal else []),name],stdout=subprocess.DEVNULL)
        owned("network",name)
    if not exists("volume","mw-dev-pgdata"):
        run(["docker","volume","create","--label","mw.environment=dev","mw-dev-pgdata"],stdout=subprocess.DEVNULL)
    owned("volume","mw-dev-pgdata")
    container("mw-dev-db",["--network","mw-dev-private","--env-file",str(PRIVATE/"postgres.env"),"-v","mw-dev-pgdata:/var/lib/postgresql/data","postgres:17.6-alpine"])
    for _ in range(60):
        if subprocess.run(["docker","exec","mw-dev-db","pg_isready","-h","127.0.0.1","-U","postgres","-d","masterweld_dev"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
        time.sleep(1)
    else: raise SystemExit("Dev database did not become ready")
    # The ledger lives INSIDE this database; the entire initial schema is one transaction.
    ready=capture(["docker","exec","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-Atc","SELECT to_regclass('mw_private.environment') IS NOT NULL"])
    if ready!="t":
        paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),*sorted((ROOT/"docs/migrations").glob("*.sql")),ROOT/"ops/dev/identity.sql",ROOT/"ops/dev/seed.sql"]
        combined="BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nALTER ROLE authenticator PASSWORD '"+conf["api"]+"';\nCOMMIT;"
        sql(combined)
        print("Dev schema and synthetic catalog created.")
    identity=capture(["docker","exec","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-Atc","SELECT public.mw_environment_identity()"])
    if json.loads(identity)!={"environment":"dev","instanceId":INSTANCE}: raise SystemExit("Wrong database identity")
    if sys.argv[1:]==["--database-only"]: return
    container("mw-dev-rest",["--network","mw-dev-private","--env-file",str(PRIVATE/"postgrest.env"),"postgrest/postgrest:v12.2.12"])
    container("mw-dev-gateway",["--network","mw-dev-private","-v",str(ROOT/"ops/dev/Caddyfile")+":/etc/caddy/Caddyfile:ro","caddy:2.10.2-alpine"])
    networks=json.loads(capture(["docker","inspect","mw-dev-gateway"]))[0]["NetworkSettings"]["Networks"]
    if "mw-dev-edge" not in networks: run(["docker","network","connect","mw-dev-edge","mw-dev-gateway"])
    print("Dev database/API ready. No production resources used.")

if __name__=="__main__": main()
