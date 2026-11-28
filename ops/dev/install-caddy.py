#!/usr/bin/env python3
"""Install one masterweld dev vhost into the existing Caddy; preserve all other sites."""
import datetime, fcntl, json, os, pathlib, subprocess, tempfile
DOMAIN="masterweld-dev.213-165-53-111.sslip.io"
TARGET=pathlib.Path("/opt/remnawave/caddy/Caddyfile")
BEGIN="# BEGIN MASTERWELD DEV"
BLOCK=BEGIN+"\n"+DOMAIN+""" {
    reverse_proxy mw-dev-gateway:8080
    header X-Robots-Tag "noindex, nofollow"
    header Cache-Control "no-store"
    encode gzip zstd
}
# END MASTERWELD DEV
"""
def run(args,**kw): return subprocess.run(args,check=True,**kw)
if os.geteuid()!=0: raise SystemExit("Run with sudo; only the masterweld dev vhost is modified")
with open("/run/lock/masterweld-caddy.lock","w") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    original=TARGET.read_text()
    if BEGIN in original:
        if BLOCK not in original: raise SystemExit("Existing masterweld block differs; review it before changing")
        candidate=original
    else:
        if DOMAIN in original: raise SystemExit("Domain already configured outside managed block")
        candidate=original.rstrip()+"\n\n"+BLOCK
    networks=json.loads(run(["docker","inspect","caddy"],capture_output=True,text=True).stdout)[0]["NetworkSettings"]["Networks"]
    if "mw-dev-edge" not in networks: run(["docker","network","connect","mw-dev-edge","caddy"])
    with tempfile.TemporaryDirectory(prefix="mw-caddy-") as d:
        p=pathlib.Path(d)/"Caddyfile"; p.write_text(candidate)
        run(["docker","cp",str(p),"caddy:/tmp/masterweld-Caddyfile"])
        run(["docker","exec","caddy","caddy","validate","--config","/tmp/masterweld-Caddyfile","--adapter","caddyfile"])
    if candidate!=original:
        backup=TARGET.with_name("Caddyfile.masterweld-backup-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w") as f: f.write(original)
        # Preserve bind-mounted inode.
        TARGET.write_text(candidate)
    try: run(["docker","exec","caddy","caddy","reload","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"])
    except Exception:
        TARGET.write_text(original)
        run(["docker","exec","caddy","caddy","reload","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"])
        raise
    print("Installed https://"+DOMAIN+"; Caddy manages certificate issuance and renewal.")
