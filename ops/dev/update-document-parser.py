#!/usr/bin/env python3
"""Guarded DEV parser replacement. Drain the worker; retain the old parser for rollback."""
import argparse
import fcntl
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
PARSER = "mw-dev-document-parser"
WORKER = "mw-dev-document-worker"
NETWORK = "mw-dev-document-private"
IDENTITY = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def inspect(name):
    return json.loads(run(["docker", "inspect", name], text=True).stdout)[0]


def sql(query):
    return run(["docker", "exec", "mw-dev-db", "psql", "-X", "-Atq", "-v", "ON_ERROR_STOP=1",
                "-U", "postgres", "-d", "masterweld_dev", "-c", query], text=True).stdout.strip()


def validate_parser(container, expected):
    config, host = container["Config"], container["HostConfig"]
    labels = config.get("Labels") or {}
    if labels.get("mw.environment") != "dev" or labels.get("org.opencontainers.image.revision") != expected:
        raise RuntimeError("PARSER_IDENTITY")
    if config["Cmd"] != ["/usr/bin/python3", "/worker/parser.py"] or config["User"] != "65534:65534":
        raise RuntimeError("PARSER_COMMAND")
    if set(container["NetworkSettings"]["Networks"]) != {NETWORK} or host.get("PortBindings") or container.get("Mounts"):
        raise RuntimeError("PARSER_NETWORK_OR_MOUNT")
    if (not host["ReadonlyRootfs"] or host["CapDrop"] != ["ALL"] or
        host["SecurityOpt"] != ["no-new-privileges"] or
        host["Tmpfs"] != {"/tmp": "rw,noexec,nosuid,size=256m"} or
        host["Memory"] != 1073741824 or host["NanoCpus"] != 1000000000 or host["PidsLimit"] != 96):
        raise RuntimeError("PARSER_HARDENING")
    env = dict(entry.split("=", 1) for entry in config["Env"])
    if env.get("APP_ENV") != "dev" or env.get("RELEASE_SHA") != expected:
        raise RuntimeError("PARSER_ENVIRONMENT")
    if any(re.search("TOKEN|SECRET|PASSWORD|SUPABASE", key, re.I) for key in env):
        raise RuntimeError("PARSER_HAS_CREDENTIALS")
    if not container["State"]["Running"]:
        raise RuntimeError("PARSER_NOT_RUNNING")


def fingerprints():
    return json.loads(sql("""
      SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}')
      FROM document_intakes d
    """))


def probe(name, host="127.0.0.1"):
    # Exercise the real parser endpoint without a database or Telegram transport.
    code = """import base64,json,urllib.request
raw=b'\\nsku  price\\n\\nTEST-LOCATOR  10\\n'
req=urllib.request.Request('http://127.0.0.1:8090/extract',
 data=json.dumps({'base64':base64.b64encode(raw).decode(),'file_name':'probe.txt'}).encode(),
 headers={'Content-Type':'application/json'})
with urllib.request.urlopen(req,timeout=10) as response:
 result=json.load(response)
assert result['text_locator_version']==2
assert result['tables'][0]['header_locator']=='document:1/line:2'
assert result['tables'][0]['row_locators']==['document:1/line:4']
assert result['tables'][0]['rows']==[['TEST-LOCATOR','10']]
assert result['blocks'][0]['text']==raw.decode()
"""
    for attempt in range(10):
        try:
            run(["docker", "exec", name, "/usr/bin/python3", "-c", code.replace("127.0.0.1", host)])
            return
        except subprocess.CalledProcessError:
            if attempt == 9:
                raise RuntimeError("PARSER_PROBE_FAILED") from None
            time.sleep(1)


def switch(candidate, previous, expected):
    old_id, candidate_id = inspect(PARSER)["Id"], inspect(candidate)["Id"]
    renamed = disconnected = promoted = worker_stopped = False
    try:
        # The worker handles SIGTERM after finishing its current lease; never force a job replay.
        run(["docker", "stop", "--time", "240", WORKER])
        worker_stopped = True
        if inspect(WORKER)["State"]["ExitCode"] != 0:
            raise RuntimeError("WORKER_DID_NOT_DRAIN")
        if sql("SELECT count(*) FROM document_intakes WHERE state='extracting'") != "0":
            raise RuntimeError("OUTSTANDING_DOCUMENT_LEASE")
        before = fingerprints()
        validate_parser(inspect(PARSER), expected)
        run(["docker", "stop", "--time", "15", old_id])
        run(["docker", "rename", old_id, previous])
        renamed = True
        run(["docker", "network", "disconnect", NETWORK, old_id])
        disconnected = True
        run(["docker", "rename", candidate_id, PARSER])
        promoted = True
        probe(PARSER, PARSER)
        after = fingerprints()
        if any(after.get(key) != value for key, value in before.items()):
            raise RuntimeError("PREVIOUS_DOCUMENT_CHANGED")
        run(["docker", "start", WORKER])
        worker_stopped = False
        if not inspect(WORKER)["State"]["Running"]:
            raise RuntimeError("WORKER_RESTART_FAILED")
        return {"previousContainer": previous, "previousParserId": old_id,
                "parserId": candidate_id, "preservedDocuments": len(before)}
    except Exception:
        # A restart result can be uncertain. Drain again before removing a promoted parser.
        # If draining fails, leave both containers for review instead of breaking an active lease.
        if promoted:
            run(["docker", "stop", "--time", "240", WORKER])
            worker_stopped = True
            if (inspect(WORKER)["State"]["ExitCode"] != 0 or
                sql("SELECT count(*) FROM document_intakes WHERE state=\'extracting\'") != "0"):
                raise RuntimeError("ROLLBACK_REQUIRES_REVIEW") from None
            run(["docker", "rm", "-f", candidate_id])
        if renamed:
            run(["docker", "rename", old_id, PARSER])
        if disconnected:
            run(["docker", "network", "connect", NETWORK, old_id])
        run(["docker", "start", old_id])
        if worker_stopped or not inspect(WORKER)["State"]["Running"]:
            run(["docker", "start", WORKER])
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-parser-sha", required=True)
    args = parser.parse_args()
    if not re.fullmatch("[0-9a-f]{40}", args.expected_parser_sha):
        raise RuntimeError("EXPECTED_SHA_REQUIRED")
    os.umask(0o077)
    state = ROOT / "ops/.state/dev"
    state.mkdir(parents=True, exist_ok=True)
    with (state / "document-parser-update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if run(["git", "status", "--porcelain"], cwd=ROOT).stdout.strip():
            raise RuntimeError("COMMIT_SOURCE_REQUIRED")
        sha = run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).stdout.strip()
        if sha == args.expected_parser_sha:
            raise RuntimeError("PARSER_ALREADY_CURRENT")
        if json.loads(sql("SELECT mw_environment_identity()")) != IDENTITY:
            raise RuntimeError("DATABASE_IDENTITY")
        network = json.loads(run(["docker", "network", "inspect", NETWORK], text=True).stdout)[0]
        if not network["Internal"] or network["Labels"].get("mw.environment") != "dev":
            raise RuntimeError("PRIVATE_NETWORK_REQUIRED")
        validate_parser(inspect(PARSER), args.expected_parser_sha)
        worker = inspect(WORKER)
        if (not worker["State"]["Running"] or worker["Config"]["Labels"].get("mw.environment") != "dev"
            or worker["Config"]["Cmd"] != ["/usr/bin/python3", "/worker/worker.py"]):
            raise RuntimeError("WORKER_IDENTITY")
        candidate = PARSER + "-candidate-" + sha[:12]
        previous = PARSER + "-previous-" + args.expected_parser_sha[:12]
        for name in (candidate, previous):
            if subprocess.run(["docker", "container", "inspect", name], capture_output=True).returncode == 0:
                raise RuntimeError("EXISTING_PARSER_REQUIRES_REVIEW")
        image = "masterweld-document-worker:" + sha
        with tempfile.TemporaryDirectory() as directory:
            archive = run(["git", "archive", sha, "ops/intake"], cwd=ROOT).stdout
            run(["tar", "-xf", "-", "-C", directory], input=archive)
            # The private artifact umask must not make public source unreadable to UID 65534.
            for source in ("extract.py", "parser.py", "worker.py", "Dockerfile"):
                (pathlib.Path(directory) / "ops/intake" / source).chmod(0o644)
            run(["docker", "build", "--label", "mw.environment=dev", "--label",
                 "org.opencontainers.image.revision=" + sha, "--build-arg", "GIT_SHA=" + sha,
                 "-t", image, str(pathlib.Path(directory) / "ops/intake")])
        candidate_id = None
        try:
            candidate_id = run(["docker", "run", "-d", "--name", candidate, "--network", NETWORK,
                "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "1g", "--cpus", "1", "--pids-limit", "96",
                "--restart", "unless-stopped", "--label", "mw.environment=dev", "--label",
                "org.opencontainers.image.revision=" + sha, "--env", "APP_ENV=dev", "--env", "RELEASE_SHA=" + sha,
                image, "/usr/bin/python3", "/worker/parser.py"], text=True).stdout.strip()
            validate_parser(inspect(candidate), sha)
            probe(candidate)
            report = switch(candidate, previous, args.expected_parser_sha)
        except Exception:
            # A promoted candidate is already removed during rollback. Never touch the old parser.
            if candidate_id:
                check = subprocess.run(["docker", "inspect", candidate_id], capture_output=True, text=True)
                if check.returncode == 0 and json.loads(check.stdout)[0]["Name"] == "/" + candidate:
                    subprocess.run(["docker", "rm", "-f", candidate_id], capture_output=True)
            raise
        report.update(environment="dev", parserRevision=sha,
                      workerRevision=worker["Config"]["Labels"]["org.opencontainers.image.revision"],
                      previousDocumentsPreserved=True, databaseMigration=False)
        target = state / "artifacts" / ("parser-update-" + sha[:12] + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
