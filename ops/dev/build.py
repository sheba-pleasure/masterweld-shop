#!/usr/bin/env python3
"""Build the exact local commit using only public DEV configuration."""
import pathlib, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
public = dict(line.split("=", 1) for line in (ROOT / "ops/.secrets/dev/build-public.env").read_text().splitlines() if line and not line.startswith("#"))
sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT, text=True).strip():
    raise SystemExit("Commit or isolate all source changes before building DEV")
if public.get("VITE_APP_ENV") != "dev" or public.get("VITE_SUPABASE_PROJECT_ID") != "mw-dev":
    raise SystemExit("Not a dev build configuration")
args = ["docker", "build", "--label", "mw.environment=dev", "--build-arg", "GIT_SHA=" + sha,
        "--build-arg", "PUBLIC_ORIGIN=https://masterweld-dev.138-124-106-211.sslip.io"]
for key in ("VITE_APP_ENV", "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PROJECT_ID"):
    args += ["--build-arg", key + "=" + public[key]]
args += ["-t", "masterweld-dev:" + sha, "-"]
with tempfile.TemporaryFile() as archive:
    subprocess.run(["git", "archive", "--format=tar", sha], cwd=ROOT, stdout=archive, check=True)
    archive.seek(0)
    subprocess.run(args, cwd=ROOT, stdin=archive, check=True)
print("Dev image: masterweld-dev:" + sha)
