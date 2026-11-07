#!/usr/bin/env python3
"""Real Docker/nginx rehearsal of unchanged release/rollback scripts with synthetic HTTP applications.

No production app startup, existing database or Telegram. GitHub and the isolated schema are fixtures.
All containers/images/network/state are uniquely named; only loopback ports are published.
Run without concurrent container tests: the preservation check observes every pre-existing container.
"""
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
RUN_ID = uuid.uuid4().hex[:12]
PREFIX = "mw-rehearsal-" + RUN_ID
BASE = ROOT / "ops/.state/release-rehearsal" / RUN_ID
BASE.mkdir(parents=True, mode=0o700)
BASE.chmod(0o700)
STATE = BASE / "state"
STATE.mkdir(mode=0o700)
CONTEXT = BASE / "context"
CONTEXT.mkdir(mode=0o700)
SHAS = [digit * 40 for digit in "1234"]
MODES = ["normal", "normal", "candidate-failure", "gateway-failure"]
DB = PREFIX + "-db"
INSTANCE = str(uuid.uuid4())
NAMES = [PREFIX + suffix for suffix in ("-gateway", "-slot-a", "-slot-b", "-backend")] + [DB]
NETWORK = PREFIX + "-net"
IMAGE_REPO = PREFIX
REPORT = {"id": RUN_ID, "scope": "real release scripts, Docker, nginx and worker activation; synthetic app and GitHub",
          "applicationStartupVerified": False, "databaseUsed": True, "existingDatabaseUsed": False, "telegramSent": False,
          "productionPromotionAuthorized": False, "checks": [], "passed": False}
OWNED_CONTAINERS = set()
OWNED_IMAGES = set()
network_created = False
server = None
ports_reserved = []
env = {k: v for k, v in os.environ.items()
       if k not in ("GITHUB_TOKEN", "GITHUB_API", "GITHUB_REPO", "OPS_DIR", "STATE_DIR", "SECRETS_ENV",
                    "IMAGE_REPO", "GATEWAY_PORT", "SLOT_A_PORT", "SLOT_B_PORT", "BACKEND_PORT",
                    "MW_CONTAINER_PREFIX", "APP_NETWORK", "HEALTH_TRIES", "HEALTH_SLEEP",
                    "MW_PRODUCTION_DB_CONTAINER", "MW_PRODUCTION_DB_NAME")}
github_online = True
github_requests = []


def run(args, check=True, timeout=60, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, **kwargs)
    if check and result.returncode:
        raise RuntimeError("Command failed: " + str(args[:3]) + "\n" + result.stderr[-3000:])
    return result


def docker(*args, **kwargs):
    return run(["docker", *args], **kwargs)


def sql(statement):
    return docker("exec", "-i", DB, "psql", "-X", "-Atq", "-U", "postgres",
                  "-v", "ON_ERROR_STOP=1", input=statement).stdout.strip()


def source_schema(enabled):
    if enabled:
        sql("""
          CREATE SCHEMA mw_private;
          CREATE TABLE source_fact_reviews(id integer);
          CREATE TABLE source_fact_rows(id integer);
          CREATE TABLE source_fact_prompts(id integer);
          CREATE TABLE technical_fact_origins(id integer);
          CREATE FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)
            RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
          CREATE FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)
            RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
        """)
    else:
        sql("""
          DROP TABLE source_fact_reviews, source_fact_rows, source_fact_prompts, technical_fact_origins;
          DROP FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb);
          DROP SCHEMA mw_private CASCADE;
        """)


def maintenance():
    assert (STATE / "active_sha").read_text().strip() == ""
    assert (STATE / "active_slot").read_text().strip() == ""
    assert json.loads((STATE / "workers/active.json").read_text()) == {}
    try:
        urllib.request.urlopen(gateway, timeout=3)
        raise AssertionError("Unsafe fallback did not leave maintenance")
    except urllib.error.HTTPError as error:
        assert error.code == 503


def read_json(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=3) as response:
        return json.load(response)


def ready(url):
    last = None
    for _ in range(60):
        try:
            value = read_json(url)
            if value is not None:
                return value
        except (OSError, ValueError) as error:
            last = error
        time.sleep(0.1)
    raise AssertionError("HTTP did not become ready: " + str(last))


def record(name):
    REPORT["checks"].append(name)
    print("PASS " + name, flush=True)


def baseline():
    ids = docker("ps", "-aq").stdout.split()
    result = {}
    if ids:
        for c in json.loads(docker("inspect", *ids).stdout):
            if not c["Name"].lstrip("/").startswith(PREFIX):
                result[c["Name"]] = [c["Id"], c["State"]["Running"], c["State"]["StartedAt"]]
    return result


class GitHubFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        github_requests.append(self.path)
        if not github_online:
            self.send_error(503)
            return
        if self.path.startswith("/repos/sheba-pleasure/masterweld-shop/compare/main..."):
            payload = {"status": "behind"}
        elif self.path.endswith("/pulls"):
            payload = [{"merged_at": "fixture", "base": {"ref": "main"}}]
        elif self.path.endswith("/check-runs"):
            payload = {"check_runs": [{"name": "verify", "conclusion": "success"}]}
        else:
            self.send_error(404)
            return
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def release(sha, expected=0):
    result = run(["bash", str(ROOT / "ops/release.sh"), sha], check=False, env=env, timeout=90)
    (BASE / ("release-" + sha[:2] + "-" + str(len(REPORT["checks"])) + ".log")).write_text(result.stderr)
    assert result.returncode == expected, result.stderr


def rollback(sha, expected=0):
    before = len(github_requests)
    result = run(["bash", str(ROOT / "ops/rollback.sh"), sha], check=False, env=env, timeout=90)
    (BASE / ("rollback-" + str(len(REPORT["checks"])) + ".log")).write_text(result.stderr)
    assert result.returncode == expected, result.stderr
    assert len(github_requests) == before, "Offline rollback contacted GitHub"


def current(sha, slot):
    assert (STATE / "active_sha").read_text().strip() == sha
    assert (STATE / "active_slot").read_text().strip() == slot
    assert json.loads((STATE / "workers/active.json").read_text()) == {"sha": sha, "slot": slot}
    assert read_json(gateway + "/api/public/release-health") == {
        "ready": True, "revision": sha, "environment": "production"}


def worker(slot):
    return read_json(slot_urls[slot] + "/fixture/worker")["active"]


def check_standby_health(slot):
    lines = docker("logs", PREFIX + "-slot-" + slot).stdout.splitlines()
    events = [json.loads(line) for line in lines if line.startswith("{")]
    events = [e for e in events if e.get("health")]
    assert events and events[0]["workerActive"] is False
    gateway_events = [e for e in events if e["viaGateway"]]
    assert gateway_events and gateway_events[0]["workerActive"] is False


try:
    # No implicit pull: the operator/CI provisions these public images explicitly.
    for image in ("node:22-bookworm-slim", "nginx:1.27-alpine", "postgres:17.6-alpine"):
        docker("image", "inspect", image)
    before = baseline()
    REPORT["existingContainersBefore"] = before
    for name in NAMES:
        assert docker("inspect", name, check=False).returncode != 0
    assert docker("network", "inspect", NETWORK, check=False).returncode != 0
    for _ in range(4):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        ports_reserved.append(sock)
    ports = [sock.getsockname()[1] for sock in ports_reserved]
    gateway_port, a_port, b_port, backend_port = ports
    gateway = "http://127.0.0.1:" + str(gateway_port)
    slot_urls = {"a": "http://127.0.0.1:" + str(a_port), "b": "http://127.0.0.1:" + str(b_port)}
    REPORT["ports"] = ports
    server = ThreadingHTTPServer(("127.0.0.1", 0), GitHubFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env.update({"STATE_DIR": str(STATE), "SECRETS_ENV": str(BASE / "fixture.env"),
                "IMAGE_REPO": IMAGE_REPO, "GITHUB_API": "http://127.0.0.1:" + str(server.server_port),
                "GITHUB_REPO": "sheba-pleasure/masterweld-shop",
                "GATEWAY_PORT": str(gateway_port), "SLOT_A_PORT": str(a_port), "SLOT_B_PORT": str(b_port),
                "BACKEND_PORT": str(backend_port), "MW_CONTAINER_PREFIX": PREFIX,
                "APP_NETWORK": NETWORK, "HEALTH_TRIES": "20", "HEALTH_SLEEP": "0.1",
                "MW_PRODUCTION_DB_CONTAINER": DB, "MW_PRODUCTION_DB_NAME": "postgres"})
    # Only the real activation guard is imported; no notification worker or transport exists in this image.
    run([str(ROOT / "node_modules/.bin/esbuild"),
         str(ROOT / "src/lib/orders/notification-environment.server.ts"),
         "--bundle", "--platform=node", "--format=esm", "--outfile=" + str(CONTEXT / "notification-environment.mjs")])
    shutil.copyfile(ROOT / "ops/tests/release-fixture.mjs", CONTEXT / "fixture.mjs")
    (CONTEXT / "Dockerfile").write_text(
        'FROM node:22-bookworm-slim\nWORKDIR /fixture\nCOPY *.mjs ./\n'
        'ARG SHA\nARG MODE\nARG CAP\nLABEL org.opencontainers.image.revision=$SHA mw.capabilities.source-facts=$CAP\n'
        'ENV FIXTURE_SHA=$SHA FIXTURE_MODE=$MODE\nUSER node\nCMD ["node","fixture.mjs"]\n')
    for sha, mode in zip(SHAS, MODES):
        image = IMAGE_REPO + ":" + sha
        assert docker("image", "inspect", image, check=False).returncode != 0
        OWNED_IMAGES.add(image)
        docker("build", "--network", "none", "--pull=false", "--build-arg", "SHA=" + sha,
               "--build-arg", "MODE=" + mode, "--build-arg", "CAP=" + ("0" if sha == SHAS[0] else "1"),
               "-t", image, str(CONTEXT), timeout=90)
    fixture_env = {
        "APP_ENV": "production", "ORDER_NOTIFICATIONS_ENABLED": "true", "TELEGRAM_ENABLED": "true",
        "TELEGRAM_TRANSPORT": "direct", "TELEGRAM_BOT_ID": "8861999166",
        "TELEGRAM_BOT_USERNAME": "masterweldermanagerbot",
        "TELEGRAM_BOT_TOKEN": "8861999166:synthetic_not_a_secret_1234567890",
        "PUBLIC_ORIGIN": "https://shop.masterweld.ru", "SUPABASE_URL": "http://mw-prod-api:8080",
        "MW_INSTANCE_ID": INSTANCE,
    }
    (BASE / "fixture.env").write_text("".join(k + "=" + v + "\n" for k, v in fixture_env.items()))
    (BASE / "fixture.env").chmod(0o600)
    OWNED_CONTAINERS.add(DB)
    docker("run", "-d", "--name", DB, "--network", "none",
           "--label", "mw.environment=production", "--label", "mw.scope=isolated-qa",
           "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine")
    for _ in range(100):
        if docker("exec", DB, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", check=False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Fixture database not ready")
    identity = json.dumps({"environment": "production", "instanceId": INSTANCE})
    sql("CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $$ SELECT '" +
        identity + "'::jsonb $$; CREATE TABLE qa_preserve(id integer, value text); "
        "INSERT INTO qa_preserve VALUES(1,'Keep exactly');")
    docker("network", "create", "--label", "mw.environment=production", NETWORK)
    network_created = True
    # A private bridge with explicit loopback publication reproduces the release topology.
    # Docker internal networks do not publish these ports on this host. No shared network is joined.
    REPORT["network"] = {"name": NETWORK, "driver": "bridge", "publishedBind": "127.0.0.1"}
    for sock in ports_reserved:
        sock.close()
    OWNED_CONTAINERS.update(NAMES)
    docker("run", "-d", "--name", PREFIX + "-backend", "--network", NETWORK,
           "-p", "127.0.0.1:" + str(backend_port) + ":3000", IMAGE_REPO + ":" + SHAS[0])
    run(["bash", str(ROOT / "ops/gateway-up.sh")], env={**env, "CONFIRM_SERVER_CHANGE": "yes"})
    # A failure after the very first switch must leave maintenance and no active worker.
    release(SHAS[3], expected=2)
    assert not (STATE / "active_sha").read_text().strip()
    assert json.loads((STATE / "workers/active.json").read_text()) == {}
    try:
        urllib.request.urlopen(gateway, timeout=3)
        raise AssertionError("First failed release did not leave maintenance")
    except urllib.error.HTTPError as error:
        assert error.code == 503
    record("first post-switch failure returns maintenance and pauses workers")

    release(SHAS[0])
    current(SHAS[0], "a")
    assert worker("a")
    check_standby_health("a")
    record("first release activates exact SHA after real nginx reload and smoke")
    backend = read_json(gateway + "/backend/rest/v1/probe", {"Authorization": "Bearer fixture-only"})
    assert backend == {"fixtureBackend": True, "authorization": "Bearer fixture-only"}
    record("backend proxy reaches isolated backend and forwards authorization")

    release(SHAS[1])
    current(SHAS[1], "b")
    assert not worker("a") and worker("b")
    check_standby_health("b")
    assert (STATE / "previous_sha").read_text().strip() == SHAS[0]
    record("second release retains predecessor and grants only new worker")
    docker("restart", PREFIX + "-slot-a")
    ready(slot_urls["a"] + "/fixture/worker")
    assert not worker("a") and worker("b")
    record("restarting predecessor cannot activate its worker")

    github_online = False
    rollback(SHAS[0])
    current(SHAS[0], "a")
    assert worker("a") and not worker("b")
    record("offline rollback restores predecessor and worker without GitHub")
    github_online = True

    release(SHAS[2], expected=1)
    current(SHAS[0], "a")
    assert worker("a")
    assert not json.loads(docker("inspect", PREFIX + "-slot-b").stdout)[0]["State"]["Running"]
    record("wrong candidate SHA is stopped before traffic switch")
    release(SHAS[3], expected=2)
    current(SHAS[0], "a")
    assert worker("a")
    assert not json.loads(docker("inspect", PREFIX + "-slot-b").stdout)[0]["State"]["Running"]
    record("wrong gateway SHA triggers automatic rollback and restores worker")

    release(SHAS[1])
    current(SHAS[1], "b")
    docker("exec", PREFIX + "-slot-a", "node", "-e",
           "require('fs').writeFileSync('/tmp/fail-gateway','yes')")
    github_online = False
    rollback(SHAS[0], expected=1)
    current(SHAS[1], "b")
    assert worker("b") and not worker("a")
    record("failed rollback returns traffic and worker to current release")
    docker("exec", PREFIX + "-slot-a", "node", "-e",
           "require('fs').unlinkSync('/tmp/fail-gateway')")
    docker("stop", PREFIX + "-slot-a")
    rollback(SHAS[0])
    current(SHAS[0], "a")
    assert worker("a") and not worker("b")
    record("offline rollback starts stopped predecessor and validates exact SHA")

    with (STATE / "release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release(SHAS[1], expected=1)
    current(SHAS[0], "a")
    record("held deployment lock refuses another release")
    readonly = docker("exec", PREFIX + "-slot-b", "node", "-e",
                      "require('fs').writeFileSync('/run/mw-workers/active.json','{}')", check=False)
    assert readonly.returncode != 0 and worker("a") and not worker("b")
    record("application cannot rewrite read-only worker control")

    # New source-fact tables are empty: compatibility is required even before their first write.
    github_online = True
    release(SHAS[1])
    current(SHAS[1], "b")
    docker("stop", PREFIX + "-slot-a")
    source_schema(True)
    rollback(SHAS[0], expected=1)
    current(SHAS[1], "b")
    assert not json.loads(docker("inspect", PREFIX + "-slot-a").stdout)[0]["State"]["Running"]
    record("new empty schema refuses incompatible manual rollback before predecessor starts")
    source_schema(False)
    rollback(SHAS[0])
    current(SHAS[0], "a")
    source_schema(True)
    release(SHAS[3], expected=1)
    maintenance()
    assert not worker("a")
    assert not json.loads(docker("inspect", PREFIX + "-slot-b").stdout)[0]["State"]["Running"]
    record("failed release refuses incompatible fallback, leaves 503 and pauses notifications")

    # Restore only this disposable fixture's old schema to exercise rollback's own fallback branch.
    source_schema(False)
    release(SHAS[0])
    release(SHAS[1])
    rollback(SHAS[0])
    source_schema(True)
    docker("exec", PREFIX + "-slot-b", "node", "-e",
           "require('fs').writeFileSync('/tmp/fail-gateway','yes')")
    rollback(SHAS[1], expected=1)
    maintenance()
    assert not worker("a") and not worker("b")
    record("failed rollback refuses incompatible current slot instead of resuming notifications")
    assert sql("SELECT value FROM qa_preserve WHERE id=1") == "Keep exactly"
    record("release and rollback preserve fixture database rows")

    assert baseline() == before, "An existing container changed during rehearsal"
    REPORT["existingContainersUnchanged"] = True
    REPORT["sourceSha"] = run(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).stdout.strip()
    REPORT["sourceFiles"] = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [ROOT / "ops" / f for f in ("lib.sh", "release.sh", "rollback.sh", "gateway-up.sh")] +
        [ROOT / "ops/tests/release-fixture.mjs", ROOT / "ops/production/app_compatibility.py",
         ROOT / "ops/accessory_compatibility.py", ROOT / "src/lib/technical/accessory-dictionary.json",
         ROOT / "src/lib/orders/notification-environment.server.ts"]}
    REPORT["passed"] = True
except Exception as error:
    REPORT["error"] = str(error)
    raise
finally:
    for sock in ports_reserved:
        sock.close()
    if server:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    cleanup_errors = []
    for name in sorted(OWNED_CONTAINERS):
        logs = docker("logs", name, check=False)
        (BASE / (name + ".log")).write_text(logs.stdout + logs.stderr)
        details = docker("inspect", name, check=False)
        if details.returncode == 0:
            container = json.loads(details.stdout)[0]
            (BASE / (name + "-runtime.json")).write_text(json.dumps({
                "state": container["State"], "ports": container["NetworkSettings"]["Ports"]}, indent=2))
        docker("rm", "-fv", name, check=False)
        if docker("inspect", name, check=False).returncode == 0:
            cleanup_errors.append(name)
    if network_created:
        docker("network", "rm", NETWORK, check=False)
        if docker("network", "inspect", NETWORK, check=False).returncode == 0:
            cleanup_errors.append(NETWORK)
    for image in sorted(OWNED_IMAGES):
        docker("image", "rm", image, check=False)
        if docker("image", "inspect", image, check=False).returncode == 0:
            cleanup_errors.append(image)
    REPORT["temporaryResourcesRemoved"] = not cleanup_errors
    REPORT["cleanupErrors"] = cleanup_errors
    REPORT["passed"] = REPORT["passed"] and not cleanup_errors
    for path in BASE.rglob("*"):
        if path.is_file():
            path.chmod(0o600)
    (BASE / "report.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n")
    (BASE / "report.json").chmod(0o600)
    print(json.dumps({"passed": REPORT["passed"], "report": str(BASE / "report.json"),
                      "temporaryResourcesRemoved": not cleanup_errors}), flush=True)
    if cleanup_errors:
        raise RuntimeError("Rehearsal cleanup failed")
