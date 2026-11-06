#!/usr/bin/env python3
"""Replace only the DEV app; preserve its previous container for rollback."""
import fcntl, json, os, pathlib, re, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def run(args,**kw): return subprocess.run(args,check=True,**kw)
def inspect(kind,name):
    p=subprocess.run(["docker",kind,"inspect",name],capture_output=True,text=True)
    return json.loads(p.stdout)[0] if p.returncode==0 else None
def owned(ct):
    if ct["Config"].get("Labels",{}).get("mw.environment")!="dev": raise SystemExit("Foreign container; refusing")
def main():
    state=ROOT/"ops/.state/dev"; state.mkdir(parents=True,exist_ok=True)
    with open(state/"update.lock","w") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        sha=sys.argv[1] if len(sys.argv)==2 else subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        if not re.fullmatch("[0-9a-f]{40}",sha): raise SystemExit("Full local commit SHA required")
        image="masterweld-dev:"+sha
        info=inspect("image",image)
        if not info or info["Config"].get("Labels",{}).get("mw.environment")!="dev": raise SystemExit("Build the selected DEV image first")
        old=inspect("container","mw-dev-app")
        prev=inspect("container","mw-dev-previous")
        if prev and not old: raise SystemExit("Previous DEV container exists without active app; recover it before replacement")
        if prev: owned(prev); run(["docker","rm","-f","mw-dev-previous"],stdout=subprocess.DEVNULL)
        if old:
            owned(old)
            run(["docker","stop","mw-dev-app"],stdout=subprocess.DEVNULL)
            run(["docker","rename","mw-dev-app","mw-dev-previous"])
            for net in old["NetworkSettings"]["Networks"]: run(["docker","network","disconnect",net,"mw-dev-previous"])
        try:
            run(["docker","run","-d","--name","mw-dev-app","--label","mw.environment=dev","--restart","unless-stopped",
                 "--network","mw-dev-edge","--env-file",str(ROOT/"ops/.secrets/dev/app.env"),
                 "--read-only","--tmpfs","/tmp:rw,noexec,nosuid,size=64m","--cap-drop","ALL",
                 "--security-opt","no-new-privileges","--memory","768m","--pids-limit","256",image],stdout=subprocess.DEVNULL)
            run(["docker","network","connect","mw-dev-private","mw-dev-app"])
            for _ in range(40):
                probe=subprocess.run(["docker","exec","mw-dev-app","node","-e","fetch('http://127.0.0.1:3000/').then(async r=>{const t=await r.text();process.exit(r.ok&&t.includes('Тестовый магазин')?0:1)}).catch(()=>process.exit(1))"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                if probe.returncode==0: break
                time.sleep(1)
            else: raise RuntimeError("DEV_HEALTH_FAILED")
        except Exception:
            if inspect("container","mw-dev-app"): run(["docker","rm","-f","mw-dev-app"],stdout=subprocess.DEVNULL)
            if old:
                run(["docker","rename","mw-dev-previous","mw-dev-app"])
                for net in old["NetworkSettings"]["Networks"]: run(["docker","network","connect",net,"mw-dev-app"])
                run(["docker","start","mw-dev-app"],stdout=subprocess.DEVNULL)
            raise
        (state/"active-sha").write_text(sha+"\n")
        print("DEV active local commit: "+sha+"; database preserved.")
if __name__=="__main__": main()
