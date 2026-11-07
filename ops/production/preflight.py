#!/usr/bin/env python3
"""Read-only readiness inventory. Never provisions, migrates, pairs or approves."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEV_ID = "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"
DEV_BOT = "8996533708"
# These DEV-installed proposals are required by the current application, but
# remain outside automatic migration runners. Inventory is not approval to apply.
REQUIRED_PROPOSALS = {
    "docs/proposals/0042_documentary_measurement_conditions.sql":
        "2b258b9a2ec9253bd357c13843020c3bb26e2931d0c9e186f7c48b7fc8b4ebad",
    "docs/proposals/0043_accessory_characteristics.sql":
        "0c39f8ad4d53145add3c07f8df3e6ad872ef9a11a23e3e4288c07c54d51f3378",
}
BOT_ROLES = {
    "staff": ("TELEGRAM_", "8861999166", "masterweldermanagerbot", "/api/public/telegram/webhook"),
    "customer": ("CUSTOMER_TELEGRAM_", "9168738475", "msvarbot", "/api/public/telegram/customer"),
}
DATABASE_KEYS = ("APP_ENV", "MW_INSTANCE_ID", "PUBLIC_ORIGIN", "SUPABASE_URL",
                 "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY")
BOT_KEYS = ("TELEGRAM_TRANSPORT",) + tuple(
    prefix + name for prefix, _, _, _ in BOT_ROLES.values()
    for name in ("ENABLED", "BOT_TOKEN", "BOT_ID", "BOT_USERNAME", "WEBHOOK_SECRET"))
MANUAL_BLOCKERS = [
    "CLOUD_EXPORT_RESTORE_AND_RECONCILIATION_REQUIRED",
    "OFFSITE_BACKUP_RESTORE_REQUIRED",
    "MIGRATION_REHEARSAL_EVIDENCE_REVIEW_REQUIRED",
    "PRODUCTION_BOT_CUTOVER_REVIEW_REQUIRED",
    "PRODUCTION_ALERTS_REVIEW_REQUIRED",
    "STAFF_IDENTITIES_AND_PERMISSIONS_REVIEW_REQUIRED",
    "LIVE_DEPLOY_ROLLBACK_NOT_TESTED",
    "OWNER_RELEASE_COMMAND_REQUIRED",
]


def read_env(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
            raise ValueError("PRIVATE_FILE_REQUIRED")
        env = {}
        for line in stream:
            line = line.rstrip("\r\n")
            if not line.strip() or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in env:
                raise ValueError("ENV_FORMAT_INVALID")
            env[key] = value
        return env


def configuration_errors(env, dev):
    errors = []
    errors.extend("MISSING:" + k for k in (*DATABASE_KEYS, *BOT_KEYS) if not env.get(k))
    if env.get("APP_ENV") != "production":
        errors.append("PRODUCTION_ENV_REQUIRED")
    try:
        uuid.UUID(env.get("MW_INSTANCE_ID", ""))
    except ValueError:
        errors.append("INVALID_INSTANCE_ID")
    if env.get("MW_INSTANCE_ID") == DEV_ID or (
        env.get("MW_INSTANCE_ID") and env.get("MW_INSTANCE_ID") == dev.get("MW_INSTANCE_ID")
    ):
        errors.append("DEV_INSTANCE_FORBIDDEN")
    if env.get("PUBLIC_ORIGIN") != "https://shop.masterweld.ru":
        errors.append("ORIGIN_REVIEW_REQUIRED")
    if env.get("SUPABASE_URL") == dev.get("SUPABASE_URL") and env.get("SUPABASE_URL"):
        errors.append("DEV_DATABASE_FORBIDDEN")
    if env.get("SUPABASE_URL") and env["SUPABASE_URL"] != "http://mw-prod-api:8080":
        errors.append("INDEPENDENT_DATABASE_ENDPOINT_REQUIRED")
    if env.get("SUPABASE_SERVICE_ROLE_KEY") == env.get("SUPABASE_PUBLISHABLE_KEY"):
        errors.append("DATABASE_ROLES_MUST_BE_SEPARATE")
    if env.get("TELEGRAM_TRANSPORT") != "direct":
        errors.append("DIRECT_TELEGRAM_REQUIRED")
    secret_keys = ("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY",
                   "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
                   "CUSTOMER_TELEGRAM_BOT_TOKEN", "CUSTOMER_TELEGRAM_WEBHOOK_SECRET")
    # Compare across roles, not only identically named fields.
    dev_values = {dev.get(k) for k in secret_keys} - {None, ""}
    for key in secret_keys:
        if env.get(key) and env[key] in dev_values:
            errors.append("SHARED_DEV_SECRET:" + key)
    for role, (prefix, bot_id, username, _) in BOT_ROLES.items():
        if env.get(prefix + "ENABLED") != "true":
            errors.append("BOT_ENABLED_REQUIRED:" + role)
        if env.get(prefix + "BOT_ID") == DEV_BOT or env.get(prefix + "BOT_USERNAME") == "testmw639bot":
            errors.append("DEV_BOT_FORBIDDEN")
        if env.get(prefix + "BOT_ID") != bot_id or env.get(prefix + "BOT_USERNAME") != username:
            errors.append("BOT_IDENTITY_REVIEW_REQUIRED:" + role)
        token = env.get(prefix + "BOT_TOKEN", "")
        if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]{20,}", token) or token.partition(":")[0] != bot_id:
            errors.append("BOT_TOKEN_INVALID:" + role)
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", env.get(prefix + "WEBHOOK_SECRET", "")):
            errors.append("WEBHOOK_SECRET_INVALID:" + role)
    for suffix in ("BOT_ID", "BOT_TOKEN", "WEBHOOK_SECRET"):
        value = env.get("TELEGRAM_" + suffix)
        if value and value == env.get("CUSTOMER_TELEGRAM_" + suffix):
            errors.append("BOT_ROLES_MUST_BE_SEPARATE:" + suffix)
    if env.get("ORDER_NOTIFICATIONS_ENABLED") not in ("true", "false"):
        errors.append("NOTIFICATION_MODE_INVALID")
    return sorted(set(errors))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(request):
    # Never propagate provider exceptions: they can contain token-bearing URLs.
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            body = response.read(262145)
            if len(body) > 262144:
                raise ValueError()
            return json.loads(body)
    except Exception:
        raise ValueError("REMOTE_CHECK_FAILED") from None


def telegram_read(token, method):
    if method not in {"getMe", "getWebhookInfo"}:
        raise ValueError("READ_ONLY_METHOD_REQUIRED")
    result = request_json(urllib.request.Request("https://api.telegram.org/bot" + token + "/" + method))
    if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("result"), dict):
        raise ValueError("TELEGRAM_CHECK_FAILED")
    return result["result"]


def inspect_bots(env, read=telegram_read):
    facts, checks, blockers = [], [], []
    for role, (prefix, bot_id, username, route) in BOT_ROLES.items():
        try:
            me = read(env[prefix + "BOT_TOKEN"], "getMe")
            if str(me.get("id")) != bot_id or me.get("username") != username or me.get("is_bot") is not True:
                blockers.append("BOT_IDENTITY_MISMATCH:" + role)
                continue
            checks.append("BOT_IDENTITY_VERIFIED:" + role)
            info = read(env[prefix + "BOT_TOKEN"], "getWebhookInfo")
            current = info.get("url")
            pending = info.get("pending_update_count")
            if not isinstance(current, str) or type(pending) is not int or pending < 0:
                raise ValueError("INVALID_WEBHOOK_RESPONSE")
            expected = env["PUBLIC_ORIGIN"] + route
            state = "absent" if not current else "expected" if current == expected else "other"
            # Paths, query strings and provider error messages may contain secrets.
            facts.append({"role": role, "bot": "@" + username, "webhook": state,
                          "pendingUpdates": pending, "hasDeliveryError": bool(info.get("last_error_date")),
                          "target": expected})
            if state != "expected":
                blockers.append("WEBHOOK_" + ("NOT_CONNECTED:" if state == "absent" else "CUTOVER_REQUIRED:") + role)
            else:
                checks.append("WEBHOOK_TARGET_MATCHES:" + role)
            if pending:
                blockers.append("PENDING_UPDATES_REVIEW_REQUIRED:" + role)
            if info.get("last_error_date"):
                blockers.append("TELEGRAM_DELIVERY_ERROR_REVIEW:" + role)
        except Exception:
            blockers.append("TELEGRAM_CHECK_UNAVAILABLE:" + role)
    return facts, checks, blockers


def database_identity(env):
    # This command runs on the host; Docker's mw-prod-api hostname is not host DNS.
    # Use only the fixed loopback publication, then verify the instance identity.
    return request_json(urllib.request.Request(
        "http://127.0.0.1:18084/rest/v1/rpc/mw_environment_identity", data=b"{}",
        headers={"apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
                 "Authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
                 "Content-Type": "application/json"}))


def schema_errors(rows, expected):
    actual = {row["path"]: row["sha256"] for row in rows}
    errors = ["MIGRATION_MISSING:" + path for path in expected.keys() - actual.keys()]
    errors += ["MIGRATION_UNEXPECTED:" + path for path in actual.keys() - expected.keys()]
    errors += ["MIGRATION_CHECKSUM_MISMATCH:" + path for path in actual.keys() & expected.keys()
               if actual[path] != expected[path]]
    return sorted(errors)


def expected_schema_files(root):
    paths = sorted((root / "drizzle/migrations").glob("*.sql")) + sorted((root / "docs/migrations").glob("*.sql"))
    expected = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    # Never glob arbitrary draft proposals or silently omit a missing required file.
    for relative, checksum in REQUIRED_PROPOSALS.items():
        if hashlib.sha256((root / relative).read_bytes()).hexdigest() != checksum:
            raise ValueError("REQUIRED_PROPOSAL_CHECKSUM_MISMATCH")
        expected[relative] = checksum
    return expected


def inspect_schema(env):
    # All docker/SQL operations here are fixed read-only calls.
    try:
        result = subprocess.run(["docker", "inspect", "mw-prod-db"], capture_output=True, timeout=10, check=True)
        container = json.loads(result.stdout)[0]
        if container["Config"]["Labels"].get("mw.environment") != "production":
            raise ValueError()
        sql = """SELECT json_build_object(
          'identity', public.mw_environment_identity(),
          'files', (SELECT json_agg(s) FROM mw_private.schema_files s));"""
        result = subprocess.run(["docker", "exec", "mw-prod-db", "psql", "-X", "-U", "postgres",
                                 "-d", "masterweld_production", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                capture_output=True, timeout=10, check=True)
        state = json.loads(result.stdout)
        if state["identity"] != {"environment": "production", "instanceId": env["MW_INSTANCE_ID"]}:
            return ["SCHEMA_DATABASE_IDENTITY_MISMATCH"]
        expected = expected_schema_files(ROOT)
        return schema_errors(state["files"], expected)
    except Exception:
        return ["SCHEMA_INVENTORY_UNAVAILABLE"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="Inspect inactive shop.env.candidate, not release shop.env")
    args = parser.parse_args()
    checks, blockers, bots = [], [], []
    try:
        socket.getaddrinfo("shop.masterweld.ru", 443, type=socket.SOCK_STREAM)
        checks.append("DNS_RESOLVES")
    except socket.gaierror:
        blockers.append("DNS_NOT_RESOLVED:shop.masterweld.ru")
    config = ROOT / ("ops/.secrets/production/shop.env.candidate" if args.staged else "ops/.secrets/shop.env")
    try:
        env = read_env(config)
        dev = read_env(ROOT / "ops/.secrets/dev/app.env")
        errors = configuration_errors(env, dev)
        blockers.extend(errors)
        if not errors:
            checks.append("DISTINCT_CONFIGURATION")
            bots, bot_checks, bot_blockers = inspect_bots(env)
            checks.extend(bot_checks)
            blockers.extend(bot_blockers)
            try:
                if database_identity(env) != {"environment": "production", "instanceId": env["MW_INSTANCE_ID"]}:
                    blockers.append("DATABASE_IDENTITY_MISMATCH")
                else:
                    checks.append("DATABASE_IDENTITY_VERIFIED")
                    missing = inspect_schema(env)
                    blockers.extend(missing)
                    if not missing:
                        checks.append("SCHEMA_LEDGER_MATCHES_REPOSITORY")
            except Exception:
                blockers.append("DATABASE_IDENTITY_UNAVAILABLE")
    except FileNotFoundError:
        blockers.append("PRODUCTION_CONFIGURATION_MISSING")
    except (OSError, ValueError):
        blockers.append("PRIVATE_CONFIGURATION_INVALID")
    if args.staged:
        blockers.append("STAGED_CONFIGURATION_NOT_ACTIVATED")
    # Evidence is reviewed separately; this inventory can never issue an approval.
    blockers.extend(MANUAL_BLOCKERS)
    print(json.dumps({"mode": "staged" if args.staged else "release", "checks": checks,
                      "bots": bots, "blockers": blockers, "approved": False}, ensure_ascii=False, indent=2))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
