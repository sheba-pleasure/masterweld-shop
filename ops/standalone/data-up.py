#!/usr/bin/env python3
"""Prepare a new, empty, isolated production database/API. Never imports DEV/Cloud."""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import stat
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRIVATE = ROOT / "ops/.secrets/production"
LABEL = "mw.environment=production"
DB = "masterweld_production"


def run(args, **kwargs):
    # Do not leak SQL/passwords through exception command lines or output.
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError("COMMAND_FAILED:" + args[0])
    return result.stdout


def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def owned(kind, name):
    data = inspect(kind, name)
    if data:
        labels = data.get("Labels") or data.get("Config", {}).get("Labels") or {}
        if labels.get("mw.environment") != "production":
            raise RuntimeError("FOREIGN_RESOURCE:" + name)
    return data


def private_file(name, content):
    path = PRIVATE / name
    if path.exists():
        meta = path.lstat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
            raise RuntimeError("PRIVATE_FILE_REQUIRED:" + name)
        if path.read_text() != content:
            raise RuntimeError("CONFIGURATION_CONFLICT:" + name)
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)


def token(secret, role):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")
    payload = encode({"alg": "HS256", "typ": "JWT"}) + b"." + encode({
        "role": role, "iss": "masterweld-production", "iat": int(time.time()),
        "exp": int(time.time()) + 31536000,
    })
    return (payload + b"." + base64.urlsafe_b64encode(hmac.new(secret.encode(), payload, hashlib.sha256).digest()).rstrip(b"=")).decode()


def sql(statement):
    return run(["docker", "exec", "-i", "mw-prod-db", "psql", "-X", "-U", "postgres",
                "-d", DB, "-v", "ON_ERROR_STOP=1", "-Atq"], input=statement.encode()).decode().strip()


def container(name, arguments):
    if owned("container", name):
        run(["docker", "start", name])
    else:
        run(["docker", "run", "-d", "--name", name, "--label", LABEL,
             "--restart", "unless-stopped", *arguments])


def main():
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if PRIVATE.is_symlink() or PRIVATE.stat().st_mode & 0o077:
        raise RuntimeError("PRIVATE_DIRECTORY_REQUIRED")
    with open(PRIVATE / "provision.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credential_path = PRIVATE / "credentials.json"
        if not credential_path.exists():
            if inspect("volume", "mw-prod-pgdata") or inspect("container", "mw-prod-db"):
                raise RuntimeError("EXISTING_DATABASE_WITHOUT_CREDENTIALS")
            conf = {"instance": str(uuid.uuid4()), "db": secrets.token_hex(24),
                    "api": secrets.token_hex(24), "jwt": secrets.token_hex(32)}
            conf.update(anon=token(conf["jwt"], "anon"), service=token(conf["jwt"], "service_role"))
            private_file("credentials.json", json.dumps(conf))
        private_file("credentials.json", credential_path.read_text())
        conf = json.loads(credential_path.read_text())
        uuid.UUID(conf["instance"])
        private_file("postgres.env", f"POSTGRES_DB={DB}\nPOSTGRES_PASSWORD={conf['db']}\n")
        private_file("postgrest.env",
                     f"PGRST_DB_URI=postgres://authenticator:{conf['api']}@mw-prod-db:5432/{DB}\n"
                     f"PGRST_DB_SCHEMAS=public\nPGRST_DB_ANON_ROLE=anon\nPGRST_JWT_SECRET={conf['jwt']}\nPGRST_DB_MAX_ROWS=1000\n")
        private_file("database.env", f"APP_ENV=production\nMW_INSTANCE_ID={conf['instance']}\n"
                     "PUBLIC_ORIGIN=https://shop.masterweld.ru\nSUPABASE_URL=http://mw-prod-api:8080\n"
                     f"SUPABASE_PUBLISHABLE_KEY={conf['anon']}\nSUPABASE_SERVICE_ROLE_KEY={conf['service']}\n")
        private_file("build-public.env", "VITE_APP_ENV=production\nVITE_SUPABASE_PROJECT_ID=mw-production\n"
                     f"VITE_SUPABASE_URL=https://shop.masterweld.ru/backend\nVITE_SUPABASE_PUBLISHABLE_KEY={conf['anon']}\n")
        for network, internal in [("mw-prod-private", True), ("mw-prod-edge", False)]:
            if not owned("network", network):
                run(["docker", "network", "create", "--label", LABEL, *(["--internal"] if internal else []), network])
        if not owned("volume", "mw-prod-pgdata"):
            run(["docker", "volume", "create", "--label", LABEL, "mw-prod-pgdata"])
        container("mw-prod-db", ["--network", "mw-prod-private", "--env-file", str(PRIVATE / "postgres.env"),
                  "-v", "mw-prod-pgdata:/var/lib/postgresql/data", "postgres:17.6-alpine"])
        for _ in range(30):
            probe = subprocess.run(["docker", "exec", "mw-prod-db", "pg_isready", "-U", "postgres", "-d", DB], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("DATABASE_NOT_READY")
        if sql("SELECT to_regclass('mw_private.environment') IS NOT NULL") != "t":
            if sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'") != "0":
                raise RuntimeError("NONEMPTY_DATABASE_WITHOUT_IDENTITY")
            migrations = sorted((ROOT / "drizzle/migrations").glob("*.sql")) + sorted((ROOT / "docs/migrations").glob("*.sql"))
            bootstrap = """CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOINHERIT LOGIN;
GRANT anon, authenticated, service_role TO authenticator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
"""
            identity = f"""CREATE SCHEMA mw_private;
REVOKE ALL ON SCHEMA mw_private FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE mw_private.environment (
singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
environment text NOT NULL CHECK(environment='production'), instance_id uuid NOT NULL UNIQUE);
INSERT INTO mw_private.environment VALUES(true,'production','{conf['instance']}');
CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=mw_private,pg_temp AS $$
SELECT jsonb_build_object('environment',environment,'instanceId',instance_id) FROM mw_private.environment WHERE singleton $$;
REVOKE ALL ON FUNCTION public.mw_environment_identity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mw_environment_identity() TO service_role;
CREATE TABLE mw_private.schema_files(path text PRIMARY KEY, sha256 text NOT NULL);
ALTER ROLE authenticator PASSWORD '{conf['api']}';
"""
            ledger = "\n".join("INSERT INTO mw_private.schema_files VALUES ('" + str(p.relative_to(ROOT)) +
                               "','" + hashlib.sha256(p.read_bytes()).hexdigest() + "');" for p in migrations)
            sql("BEGIN;\n" + bootstrap + "\n".join(p.read_text() for p in migrations) + "\n" + identity + ledger + "\nCOMMIT;")
            print("Empty production schema initialized. No catalog, orders or staff imported.")
        expected = {"environment": "production", "instanceId": conf["instance"]}
        if json.loads(sql("SELECT public.mw_environment_identity()")) != expected:
            raise RuntimeError("DATABASE_IDENTITY_MISMATCH")
        container("mw-prod-rest", ["--network", "mw-prod-private", "--env-file", str(PRIVATE / "postgrest.env"),
                  "postgrest/postgrest:v12.2.12"])
        container("mw-prod-api", ["--network", "mw-prod-private", "-p", "127.0.0.1:18084:8080",
                  "-v", str(ROOT / "ops/standalone/api.conf") + ":/etc/nginx/conf.d/default.conf:ro",
                  "nginx:1.27-alpine"])
        data = owned("container", "mw-prod-api")
        if "mw-prod-edge" not in data["NetworkSettings"]["Networks"]:
            run(["docker", "network", "connect", "mw-prod-edge", "mw-prod-api"])
        print("Independent production database/API prepared. API binds only 127.0.0.1:18084.")
        print("No app deployment, public traffic, Cloud mutation, DEV data copy or bot connection.")


if __name__ == "__main__":
    main()
