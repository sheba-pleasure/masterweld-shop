#!/usr/bin/env python3
"""Full isolated checkout HTTP stack from committed source; no live configuration or snapshots."""
import argparse
import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import select
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))
from preflight import expected_schema_files

parser = argparse.ArgumentParser()
parser.add_argument("--revision", required=True)
parser.add_argument("--playwright-modules", type=pathlib.Path,
                    default=pathlib.Path("/home/codex/.npm/_npx/e41f203b7505f1fb/node_modules"))
args = parser.parse_args()
if not re.fullmatch("[0-9a-f]{40}", args.revision):
    raise SystemExit("EXACT_COMMIT_REQUIRED")
if json.loads((args.playwright_modules / "playwright/package.json").read_text())["version"] != "1.65.0":
    raise SystemExit("PLAYWRIGHT_1_65_0_REQUIRED")
nonce = uuid.uuid4().hex[:12]
prefix = "mw-checkout-http-" + nonce
network, db, rest, gateway, app, browser = [prefix + "-" + part for part in
    ("net", "db", "rest", "gateway", "app", "browser")]
image = "mw-checkout-http-qa:" + nonce
state = ROOT / "ops/.state/checkout-http" / nonce
artifacts = state / "artifacts"
artifacts.mkdir(parents=True, mode=0o700)
origin = "http://127.0.0.1:8080"
identity = str(uuid.uuid4())
label = "mw.qa.operation=" + nonce
report = {"sourceSha": args.revision, "syntheticOnly": True, "liveDataRead": False,
          "backupCreated": False, "telegramEnabled": False, "checks": {},
          "harnessSha256": {name: hashlib.sha256((ROOT / "ops/tests" / name).read_bytes()).hexdigest()
                           for name in ("checkout-http.py", "checkout-http-browser.mjs")}}

def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=180, **kwargs)

def sql(query):
    return run(["docker", "exec", "-i", db, "psql", "-h", "127.0.0.1", "-U", "postgres",
                "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], input=query).stdout.strip()

def literal(value):
    return "'" + value.replace("'", "''") + "'"

def token(secret, role):
    enc = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
    header = enc(b'{"alg":"HS256","typ":"JWT"}')
    body = enc(json.dumps({"role": role, "iss": "isolated-checkout-qa",
                           "iat": int(time.time()), "exp": int(time.time()) + 7200},
                          separators=(",", ":")).encode())
    message = header + b"." + body
    return (message + b"." + enc(hmac.new(secret.encode(), message, hashlib.sha256).digest())).decode()

def private_file(directory, name, value):
    path = directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(value)
    return path

def container(name, arguments):
    run(["docker", "run", "--pull=never", "-d", "--name", name, "--label", label,
         "--label", "mw.environment=isolated-qa", *arguments])

def counts():
    return json.loads(sql("""SELECT json_build_object(
      'orders',(SELECT count(*) FROM shop_orders),
      'notifications',(SELECT count(*) FROM order_notifications));"""))

def health():
    program = """fetch('http://127.0.0.1:8080/api/public/release-health')
      .then(async r=>{const x=await r.json();process.exit(
        r.ok&&x.ready===true&&x.environment==='dev'&&x.revision===process.argv[1]?0:1)})
      .catch(()=>process.exit(1));"""
    for _ in range(60):
        result = subprocess.run(["docker", "exec", app, "node", "-e", program, args.revision],
                                capture_output=True, timeout=10)
        if result.returncode == 0:
            return
        time.sleep(.5)
    raise RuntimeError("QA_APP_NOT_READY")

def browser_phase(phase):
    command = ["docker", "run", "--pull=never", "--rm", "-i", "--name", browser,
               "--label", label, "--label", "mw.environment=isolated-qa",
               "--network", "container:" + gateway, "--read-only",
               "--tmpfs", "/tmp:rw,nosuid,size=512m", "--shm-size=512m", "--memory", "2g",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--user", str(os.getuid()) + ":" + str(os.getgid()),
               "--mount", f"type=bind,src={args.playwright_modules},dst=/node_modules,readonly",
               "--mount", f"type=bind,src={ROOT / 'ops/tests/checkout-http-browser.mjs'},dst=/checks/check.mjs,readonly",
               "--mount", f"type=bind,src={artifacts},dst=/artifacts",
               "-e", "MW_QA_PHASE=" + phase, "mcr.microsoft.com/playwright:v1.65.0-noble",
               "node", "/checks/check.mjs"]
    events = []
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1)
    deadline = time.monotonic() + 180
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([process.stdout], [], [], .5)
            if readable:
                line = process.stdout.readline()
                if line.strip():
                    event = json.loads(line)
                    if event.get("event") == "awaiting_price_confirmation":
                        assert counts() == {"orders": 1, "notifications": 1}
                        report["checks"]["priceChangeRequiresConsent"] = True
                        process.stdin.write('{"continue":true}\n')
                        process.stdin.flush()
                    else:
                        events.append(event)
            if process.poll() is not None:
                if process.returncode != 0:
                    raise RuntimeError(process.stderr.read()[-6000:])
                break
        else:
            raise RuntimeError("QA_BROWSER_TIMEOUT")
        assert len(events) == 1 and events[0]["passed"] is True
        return events[0]
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=15)

def cleanup(kind, name):
    inspected = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True)
    if inspected.returncode:
        return
    data = json.loads(inspected.stdout)[0]
    labels = data.get("Labels") or data.get("Config", {}).get("Labels") or {}
    if labels.get("mw.qa.operation") != nonce:
        raise RuntimeError("REFUSE_FOREIGN_QA_RESOURCE")
    command = ["docker", "rm", "-fv", name] if kind == "container" else ["docker", kind, "rm", name]
    run(command)

try:
    hashes = expected_schema_files(ROOT)
    paths = sorted(hashes, key=lambda path: pathlib.Path(path).name)
    assert len(paths) == 44
    for path, expected in hashes.items():
        data = subprocess.check_output(["git", "show", args.revision + ":" + path], cwd=ROOT)
        assert hashlib.sha256(data).hexdigest() == expected, "Schema differs from source commit"
    report["migrationCount"] = len(paths)
    with tempfile.TemporaryDirectory(prefix="private-", dir=state) as temporary:
        private = pathlib.Path(temporary)
        secret = secrets.token_hex(32)
        anon, service = token(secret, "anon"), token(secret, "service_role")
        with tempfile.TemporaryFile() as archive, (state / "build.log").open("w") as log:
            subprocess.run(["git", "archive", "--format=tar", args.revision], cwd=ROOT, stdout=archive, check=True)
            archive.seek(0)
            subprocess.run(["docker", "build", "--label", label, "--label", "mw.environment=isolated-qa",
                            "--build-arg", "GIT_SHA=" + args.revision,
                            "--build-arg", "VITE_APP_ENV=dev", "--build-arg", "PUBLIC_ORIGIN=" + origin,
                            "--build-arg", "VITE_SUPABASE_URL=" + origin + "/backend",
                            "--build-arg", "VITE_SUPABASE_PROJECT_ID=mw-isolated-qa",
                            "--build-arg", "VITE_SUPABASE_PUBLISHABLE_KEY=" + anon,
                            "-t", image, "-"], cwd=ROOT, stdin=archive, stdout=log, stderr=log, check=True, timeout=600)
        report["qaImage"] = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]).stdout.strip()
        run(["docker", "network", "create", "--internal", "--label", label,
             "--label", "mw.environment=isolated-qa", network])
        container(db, ["--network", network, "--network-alias", "qa-db",
                       "--tmpfs", "/var/lib/postgresql/data:rw,size=512m",
                       "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
        for _ in range(60):
            if subprocess.run(["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                              capture_output=True).returncode == 0:
                break
            time.sleep(.3)
        else:
            raise RuntimeError("QA_DB_NOT_READY")
        baseline = [path for path in paths if pathlib.Path(path).name[:4] <= "0013"]
        later = [path for path in paths if path not in baseline]
        bootstrap = (ROOT / "ops/dev/bootstrap.sql").read_text()
        marker = f"""
          CREATE SCHEMA mw_private;
          REVOKE ALL ON SCHEMA mw_private FROM PUBLIC,anon,authenticated,service_role;
          CREATE TABLE mw_private.environment(singleton boolean PRIMARY KEY CHECK(singleton),
            environment text NOT NULL CHECK(environment='dev'),instance_id uuid NOT NULL UNIQUE);
          INSERT INTO mw_private.environment VALUES(true,'dev','{identity}');
          CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path=mw_private,pg_temp AS $body$
            SELECT jsonb_build_object('environment',environment,'instanceId',instance_id)
              FROM mw_private.environment WHERE singleton $body$;
          REVOKE ALL ON FUNCTION public.mw_environment_identity() FROM PUBLIC,anon,authenticated;
          GRANT EXECUTE ON FUNCTION public.mw_environment_identity() TO service_role;
          CREATE TABLE mw_private.schema_files(path text PRIMARY KEY,sha256 text NOT NULL);
        """
        statements = lambda values: "\n".join((ROOT / path).read_text() for path in values)
        ledger = "\n".join("INSERT INTO mw_private.schema_files VALUES (" + literal(path) + "," +
                           literal(hashes[path]) + ");" for path in paths)
        sql("BEGIN;\n" + bootstrap + statements(baseline) + marker + statements(later) + ledger + """
          INSERT INTO staff(telegram_id,name,role,active) VALUES(42,'Учебный продавец','seller',true);
          INSERT INTO categories(id,slug,name) VALUES('10000000-0000-4000-8000-000000000001','qa-checkout','Учебная категория');
          INSERT INTO products(id,slug,title,category_id,sku,price,in_stock,status,description)
            VALUES('20000000-0000-4000-8000-000000000001','qa-checkout','Учебный HTTP товар',
              '10000000-0000-4000-8000-000000000001','QA-HTTP',900,true,'published','Учебный товар. Не продаётся.');
          COMMIT;""")
        assert json.loads(sql("SELECT public.mw_environment_identity()")) == {"environment": "dev", "instanceId": identity}
        rest_env = private_file(private, "rest.env",
            "PGRST_DB_URI=postgres://authenticator@qa-db:5432/postgres\nPGRST_DB_SCHEMAS=public\n"
            "PGRST_DB_ANON_ROLE=anon\nPGRST_JWT_SECRET=" + secret + "\n")
        container(rest, ["--network", network, "--network-alias", "qa-rest",
                         "--env-file", str(rest_env), "postgrest/postgrest:v12.2.12"])
        config = private_file(private, "nginx.conf", """
          events {}
          http { access_log off; server { listen 8080;
            location /backend/rest/v1/ { proxy_pass http://qa-rest:3000/; }
            location /rest/v1/ { proxy_pass http://qa-rest:3000/; }
            location / { proxy_pass http://127.0.0.1:3000;
              proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; }
          } }""")
        container(gateway, ["--network", network, "--mount",
                           f"type=bind,src={config},dst=/etc/nginx/nginx.conf,readonly", "nginx:1.27-alpine"])
        for _ in range(60):
            if subprocess.run(["docker", "exec", gateway, "wget", "-qO-", "http://qa-rest:3000/products?select=id"],
                              capture_output=True).returncode == 0:
                break
            time.sleep(.3)
        else:
            raise RuntimeError("QA_REST_NOT_READY")
        app_env = private_file(private, "app.env",
            "APP_ENV=dev\nMW_INSTANCE_ID=" + identity + "\nPUBLIC_ORIGIN=" + origin +
            "\nSUPABASE_URL=" + origin + "\nSUPABASE_PUBLISHABLE_KEY=" + anon +
            "\nSUPABASE_SERVICE_ROLE_KEY=" + service +
            "\nTELEGRAM_ENABLED=false\nCUSTOMER_TELEGRAM_ENABLED=false\nORDER_NOTIFICATIONS_ENABLED=false\n")
        container(app, ["--network", "container:" + gateway, "--env-file", str(app_env),
                        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "768m", image])
        health()
        report["checks"]["startupGuards"] = True
        report["checks"]["loss"] = browser_phase("loss")
        assert counts() == {"orders": 1, "notifications": 1}
        report["checks"]["parallelRequestsOneOrder"] = True
        sql("UPDATE products SET price=950 WHERE sku='QA-HTTP'")
        run(["docker", "restart", app]); health()
        report["checks"]["recovery"] = browser_phase("recovery")
        assert counts() == {"orders": 2, "notifications": 2}
        assert json.loads(sql("SELECT json_agg(total ORDER BY total) FROM shop_orders")) == [900, 950]
        assert sql("SELECT bool_and(state='pending' AND attempts=0) FROM order_notifications") == "t"
        report["checks"]["explicitRepeatAtNewPrice"] = True
        report["checks"]["notificationsUnsent"] = True
        report["passed"] = True
finally:
    for name in (browser, app, gateway, rest, db):
        cleanup("container", name)
    cleanup("network", network)
    cleanup("image", image)
    (state / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"passed": report.get("passed", False), "report": str(state / "report.json")}))
