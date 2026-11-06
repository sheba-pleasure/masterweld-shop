#!/usr/bin/env python3
"""Install only new DEV document containers from an exact clean commit; refuse existing names."""
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("preflight",ROOT/"ops/production/preflight.py")
preflight=importlib.util.module_from_spec(spec);spec.loader.exec_module(preflight)
def run(args,**kw):return subprocess.run(args,check=True,capture_output=True,**kw)
def exists(kind,name):return subprocess.run(["docker",kind,"inspect",name],capture_output=True).returncode==0
def main():
    if run(["git","status","--porcelain"],cwd=ROOT).stdout.strip():raise RuntimeError("COMMIT_SOURCE_REQUIRED")
    sha=run(["git","rev-parse","HEAD"],cwd=ROOT,text=True).stdout.strip()
    env=preflight.read_env(ROOT/"ops/.secrets/dev/app.env")
    if env.get("APP_ENV")!="dev" or env.get("SUPABASE_URL")!="http://mw-dev-gateway:8080":
        raise RuntimeError("DEV_REQUIRED")
    identity=json.loads(run(["docker","exec","mw-dev-db","psql","-X","-Atq","-U","postgres","-d","masterweld_dev",
        "-c","SELECT mw_environment_identity()"],text=True).stdout)
    if identity!={"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}:raise RuntimeError("IDENTITY_MISMATCH")
    network="mw-dev-document-private"
    for name in ("mw-dev-document-parser","mw-dev-document-worker"):
        if exists("container",name):raise RuntimeError("EXISTING_DOCUMENT_CONTAINER_REQUIRES_REVIEW")
    if exists("network",network):raise RuntimeError("EXISTING_DOCUMENT_NETWORK_REQUIRES_REVIEW")
    image="masterweld-document-worker:"+sha
    with tempfile.TemporaryDirectory() as directory:
        archive=run(["git","archive",sha,"ops/intake"],cwd=ROOT).stdout
        run(["tar","-xf","-","-C",directory],input=archive)
        subprocess.run(["docker","build","--label","mw.environment=dev","--label","org.opencontainers.image.revision="+sha,
            "--build-arg","GIT_SHA="+sha,"-t",image,str(pathlib.Path(directory)/"ops/intake")],check=True)
    credentials=ROOT/"ops/.secrets/dev/document-worker.env"
    payload="APP_ENV=dev\nSUPABASE_URL=http://mw-dev-gateway:8080\nSUPABASE_SERVICE_ROLE_KEY="+env["SUPABASE_SERVICE_ROLE_KEY"]+"\n"
    if credentials.exists():
        if credentials.is_symlink() or credentials.stat().st_mode&0o077 or credentials.read_text()!=payload:raise RuntimeError("WORKER_CONFIG_CONFLICT")
    else:
        fd=os.open(credentials,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w") as stream:stream.write(payload)
    created=[]
    try:
        run(["docker","network","create","--internal","--label","mw.environment=dev",network]);created.append(("network",network))
        hardening=["--read-only","--tmpfs","/tmp:rw,noexec,nosuid,size=256m","--cap-drop","ALL","--security-opt","no-new-privileges",
            "--memory","1g","--cpus","1","--pids-limit","96","--restart","unless-stopped",
            "--label","mw.environment=dev","--label","org.opencontainers.image.revision="+sha,"--env","APP_ENV=dev","--env","RELEASE_SHA="+sha]
        run(["docker","run","-d","--name","mw-dev-document-parser","--network",network,*hardening,image,
            "/usr/bin/python3","/worker/parser.py"]);created.append(("container","mw-dev-document-parser"))
        # Create while stopped: both private networks are attached before any job can be claimed.
        run(["docker","create","--name","mw-dev-document-worker","--network","mw-dev-private",*hardening,
            "--env-file",str(credentials),image]);created.append(("container","mw-dev-document-worker"))
        run(["docker","network","connect",network,"mw-dev-document-worker"])
        run(["docker","start","mw-dev-document-worker"])
    except Exception:
        for kind,name in reversed(created):
            subprocess.run(["docker","rm","-f",name] if kind=="container" else ["docker","network","rm",name],capture_output=True)
        raise
    print(json.dumps({"environment":"dev","revision":sha,"parserHasSecrets":False,"publishedPorts":[],"externalNetwork":False}))
if __name__=="__main__":main()
