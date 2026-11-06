#!/usr/bin/env python3
"""Connect only the explicitly selected DEV bot. Does not grant staff access."""
import json, os, pathlib, secrets, subprocess, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
PRIVATE=ROOT/"ops/.secrets/dev"
EXPECTED="testmw639bot"
ORIGIN="https://masterweld-dev.138-124-106-211.sslip.io"
def call(token,method,body=None):
    req=urllib.request.Request("https://api.telegram.org/bot"+token+"/"+method,
        data=json.dumps(body or {}).encode(),headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=20) as r: data=json.load(r)
    except Exception: raise SystemExit("TELEGRAM_REQUEST_FAILED: provider response/token omitted")
    if data.get("ok") is not True: raise SystemExit("TELEGRAM_API_FAILED")
    return data["result"]
def main():
    path=PRIVATE/"telegram-token"
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077: raise SystemExit("Token file must exist with mode 600")
    token=path.read_text().strip()
    me=call(token,"getMe")
    if me.get("username")!=EXPECTED: raise SystemExit("WRONG_BOT: expected @"+EXPECTED)
    ids=subprocess.check_output(["docker","ps","-aq"],text=True).split()
    for cid in ids:
        ct=json.loads(subprocess.check_output(["docker","inspect",cid]))[0]
        if ct["Name"].startswith("/mw-dev-"): continue
        if any(v.partition("=")[2]==token for v in ct["Config"].get("Env",[])):
            raise SystemExit("BOT_ALREADY_USED_BY_ANOTHER_CONTAINER")
    hook=call(token,"getWebhookInfo")
    url=ORIGIN+"/api/public/telegram/webhook"
    if hook.get("url") not in ("",url): raise SystemExit("BOT_HAS_ANOTHER_WEBHOOK")
    envpath=PRIVATE/"app.env"
    env=dict(line.split("=",1) for line in envpath.read_text().splitlines() if line and not line.startswith("#"))
    if env.get("APP_ENV")!="dev": raise SystemExit("NOT_DEV")
    env.update(TELEGRAM_ENABLED="true",TELEGRAM_TRANSPORT="direct",TELEGRAM_BOT_TOKEN=token,
        TELEGRAM_BOT_ID=str(me["id"]),TELEGRAM_BOT_USERNAME=EXPECTED,
        TELEGRAM_WEBHOOK_SECRET=env.get("TELEGRAM_WEBHOOK_SECRET") or secrets.token_urlsafe(48))
    tmp=PRIVATE/"app.env.next"
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as f: f.write("\n".join(k+"="+v for k,v in env.items())+"\n")
    os.replace(tmp,envpath)
    # Start and verify the app before switching Telegram. Never drops pending updates.
    active=(ROOT/"ops/.state/dev/active-sha").read_text().strip()
    subprocess.run(["python3",str(ROOT/"ops/dev/restart.py"),active],check=True)
    call(token,"setWebhook",{"url":url,"secret_token":env["TELEGRAM_WEBHOOK_SECRET"],"allowed_updates":["message","callback_query"],"drop_pending_updates":False})
    after=call(token,"getWebhookInfo")
    if after.get("url")!=url: raise SystemExit("WEBHOOK_NOT_CONFIRMED")
    subprocess.run(["python3",str(ROOT/"ops/dev/configure-menu.py")],check=True)
    print("Connected @"+EXPECTED+" to DEV only. Staff permissions still require explicit assignment.")
if __name__=="__main__": main()
