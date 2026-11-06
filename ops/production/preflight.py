#!/usr/bin/env python3
"""Read-only production readiness inventory. Never provisions, migrates or approves."""
import json, os, pathlib, socket, stat, urllib.request, urllib.error, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
DEV_ID="3a6a67bc-5ce6-46a4-af72-e6ab78800e49"
DEV_BOT="8996533708"
def read_env(path):
    meta=path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=os.getuid() or meta.st_mode & 0o077:
        raise ValueError("PRIVATE_FILE_REQUIRED")
    return dict(line.split("=",1) for line in path.read_text().splitlines() if "=" in line and not line.startswith("#"))
def configuration_errors(env,dev):
    errors=[]
    required=["APP_ENV","MW_INSTANCE_ID","PUBLIC_ORIGIN","SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SERVICE_ROLE_KEY","TELEGRAM_BOT_TOKEN","TELEGRAM_BOT_ID","TELEGRAM_BOT_USERNAME","TELEGRAM_WEBHOOK_SECRET"]
    errors.extend("MISSING:"+k for k in required if not env.get(k))
    if env.get("APP_ENV")!="production": errors.append("PRODUCTION_ENV_REQUIRED")
    try: uuid.UUID(env.get("MW_INSTANCE_ID",""))
    except ValueError: errors.append("INVALID_INSTANCE_ID")
    if env.get("MW_INSTANCE_ID")==DEV_ID: errors.append("DEV_INSTANCE_FORBIDDEN")
    if env.get("PUBLIC_ORIGIN")!="https://shop.masterweld.ru": errors.append("ORIGIN_REVIEW_REQUIRED")
    if env.get("TELEGRAM_BOT_ID")==DEV_BOT or env.get("TELEGRAM_BOT_USERNAME")=="testmw639bot": errors.append("DEV_BOT_FORBIDDEN")
    for k in ["SUPABASE_SERVICE_ROLE_KEY","SUPABASE_PUBLISHABLE_KEY","TELEGRAM_BOT_TOKEN","TELEGRAM_WEBHOOK_SECRET"]:
        if env.get(k) and env.get(k)==dev.get(k): errors.append("SHARED_DEV_SECRET:"+k)
    if env.get("SUPABASE_URL")==dev.get("SUPABASE_URL") and env.get("SUPABASE_URL"): errors.append("DEV_DATABASE_FORBIDDEN")
    if env.get("SUPABASE_URL") and env["SUPABASE_URL"] != "http://mw-prod-api:8080":
        errors.append("INDEPENDENT_DATABASE_ENDPOINT_REQUIRED")
    if env.get("ORDER_NOTIFICATIONS_ENABLED")=="true": errors.append("PRODUCTION_ALERTS_NOT_REVIEWED")
    return errors
def main():
    checks=[]; blockers=[]
    try: socket.getaddrinfo("shop.masterweld.ru",443,type=socket.SOCK_STREAM); checks.append("DNS_RESOLVES")
    except socket.gaierror: blockers.append("DNS_NOT_RESOLVED:shop.masterweld.ru")
    try:
        env=read_env(ROOT/"ops/.secrets/shop.env")
        dev=read_env(ROOT/"ops/.secrets/dev/app.env")
        errors=configuration_errors(env,dev); blockers.extend(errors)
        if not errors:
            checks.append("DISTINCT_CONFIGURATION")
            req=urllib.request.Request(env["SUPABASE_URL"].rstrip("/")+"/rest/v1/rpc/mw_environment_identity",
                 data=b"{}",headers={"apikey":env["SUPABASE_SERVICE_ROLE_KEY"],
                 **({"Authorization":"Bearer "+env["SUPABASE_SERVICE_ROLE_KEY"]} if not env["SUPABASE_SERVICE_ROLE_KEY"].startswith("sb_secret_") else {}),
                 "Content-Type":"application/json"})
            try:
                with urllib.request.urlopen(req,timeout=10) as response: identity=json.load(response)
                if identity!={"environment":"production","instanceId":env["MW_INSTANCE_ID"]}: blockers.append("DATABASE_IDENTITY_MISMATCH")
                else: checks.append("DATABASE_IDENTITY_VERIFIED")
            except Exception: blockers.append("DATABASE_IDENTITY_UNAVAILABLE")
    except FileNotFoundError: blockers.append("PRODUCTION_CONFIGURATION_MISSING")
    except ValueError: blockers.append("PRIVATE_CONFIGURATION_INVALID")
    # These require real evidence, not generated green flags or placeholder files.
    blockers.extend(["PRODUCTION_BACKUP_RESTORE_EVIDENCE_REQUIRED","MIGRATION_REHEARSAL_REQUIRED",
                     "PRODUCTION_BOT_REVIEW_REQUIRED","LIVE_DEPLOY_ROLLBACK_NOT_TESTED",
                     "OWNER_RELEASE_COMMAND_REQUIRED"])
    print(json.dumps({"checks":checks,"blockers":blockers,"approved":False},ensure_ascii=False,indent=2))
    return 1
if __name__=="__main__": raise SystemExit(main())
