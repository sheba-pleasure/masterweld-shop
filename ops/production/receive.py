#!/usr/bin/env python3
"""Forced SSH command: check SHA / deploy SHA. Install only after production provisioning."""
import fcntl, json, os, pathlib, re, shutil, subprocess, sys, tempfile
from gate import validate
ROOT=pathlib.Path(__file__).resolve().parents[2]
STATE=ROOT/"ops/.state/production"
def private_read(path):
    s=path.lstat()
    if not path.is_file() or path.is_symlink() or s.st_uid!=os.getuid() or s.st_mode & 0o077:
        raise ValueError("PRIVATE_FILE_PERMISSIONS_REQUIRED")
    return path.read_text().strip()
def main():
    command=os.environ.get("SSH_ORIGINAL_COMMAND","")
    m=re.fullmatch(r"(check|deploy) ([0-9a-f]{40})",command)
    if not m: raise ValueError("COMMAND_NOT_ALLOWED")
    action,sha=m.groups()
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    with open(STATE/"receive.lock","w") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        approval=STATE/"approval.json"
        validate(json.loads(private_read(approval)),sha)
        if (STATE/("consumed-"+sha)).exists(): raise ValueError("APPROVAL_ALREADY_USED")
        token=private_read(ROOT/"ops/.secrets/github-read-token")
        if not token: raise ValueError("GITHUB_ACCESS_REQUIRED")
        env={**os.environ,"GITHUB_TOKEN":token}
        # Existing release scripts verify GitHub merge + successful checks before actions.
        subprocess.run(["bash","-c",'source "$1/ops/lib.sh"; require_github_approval "$2"',"mw-check",str(ROOT),sha],env=env,check=True,stdout=subprocess.DEVNULL)
        if action=="check": print("RELEASE_APPROVED "+sha); return
        # Bounded tar input; no shell command or archive path is accepted from the sender.
        with tempfile.TemporaryDirectory(prefix="mw-release-") as tmp:
            archive=pathlib.Path(tmp)/"image.tar"
            total=0
            with open(archive,"wb") as out:
                while chunk:=sys.stdin.buffer.read(1024*1024):
                    total+=len(chunk)
                    if total>600*1024*1024: raise ValueError("IMAGE_TOO_LARGE")
                    out.write(chunk)
            subprocess.run(["docker","load","-i",str(archive)],check=True,stdout=subprocess.DEVNULL)
        image="masterweld-shop:"+sha
        info=json.loads(subprocess.check_output(["docker","image","inspect",image]))[0]
        if info["Config"]["Labels"].get("org.opencontainers.image.revision")!=sha: raise ValueError("IMAGE_SHA_MISMATCH")
        # The immutable image's runtime manifest must be for production before release.sh starts it.
        probe=subprocess.check_output(["docker","run","--rm","--network","none","--entrypoint","node",image,"-e","console.log(require('fs').readFileSync('/app/.output/mw-environment.json','utf8'))"])
        manifest=json.loads(probe)
        if manifest.get("environment")!="production": raise ValueError("PRODUCTION_IMAGE_REQUIRED")
        if manifest.get("revision")!=sha: raise ValueError("BUILD_REVISION_MISMATCH")
        # Consume before the first possible deployment effect; failures need an explicit fresh review.
        used=STATE/("consumed-"+sha)
        fd=os.open(used,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w") as f: f.write(approval.read_text())
        approval.unlink()
        subprocess.run(["bash",str(ROOT/"ops/release.sh"),sha],env=env,check=True)
        print("RELEASE_COMPLETE "+sha)
if __name__=="__main__":
    try: main()
    except Exception as exc:
        safe=str(exc) if isinstance(exc,ValueError) else "DEPLOYMENT_FAILED"
        print(safe,file=sys.stderr); sys.exit(1)
