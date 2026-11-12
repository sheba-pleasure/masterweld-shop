#!/usr/bin/env python3
"""Real isolated PostgreSQL checks for the combined 0042/0043 transaction."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import time
import uuid
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-accessory-install-qa-" + uuid.uuid4().hex[:12]
spec = importlib.util.spec_from_file_location("installation", ROOT / "ops/dev/documentary_conditions_installation.py")
installation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installation)
sys.path.insert(0, str(ROOT / "ops/production"))
dev_spec = importlib.util.spec_from_file_location("dev_guard", ROOT / "ops/dev/app_compatibility.py")
dev = importlib.util.module_from_spec(dev_spec)
dev_spec.loader.exec_module(dev)
prod_spec = importlib.util.spec_from_file_location("prod_guard", ROOT / "ops/production/app_compatibility.py")
prod = importlib.util.module_from_spec(prod_spec)
prod_spec.loader.exec_module(prod)
assert dev.SCHEMA_SQL == prod.SCHEMA_SQL


def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=180, **kwargs)


def sql(query, error=None):
    result = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-X", "-Atq", "-U", "postgres",
                             "-v", "ON_ERROR_STOP=1"], input=query, capture_output=True, text=True, timeout=90)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
    elif result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def ready():
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True, timeout=10).returncode == 0:
            return
        time.sleep(.2)
    raise RuntimeError("QA_DATABASE_NOT_READY")


def snapshot():
    names = sql("SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) FROM pg_tables "
                "WHERE schemaname IN('public','mw_private') ORDER BY schemaname,tablename").splitlines()
    values = [("(" + installation.literal(name) + ",(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) "
               "ORDER BY to_jsonb(t)::text),'[]')::text) FROM " + name + " t))") for name in names]
    return json.loads(sql("SELECT jsonb_object_agg(name,fingerprint) FROM (VALUES " +
                          ",".join(values) + ") snapshot(name,fingerprint)"))


created = False
try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none", "--label", "mw.environment=isolated-qa",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    ready()
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4] <= "0041"]]
    sql("BEGIN;\n" + "\n".join(p.read_text() for p in paths) + "\nCOMMIT;")
    sql((ROOT / "ops/dev/identity.sql").read_text())
    sql("""CREATE TABLE mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('previous-test','unchanged');
      INSERT INTO staff(telegram_id,name,role,elevated) VALUES(101,'Учебный администратор','admin',false);
      CREATE TABLE public.qa_preserved(id integer PRIMARY KEY,payload jsonb);
      INSERT INTO public.qa_preserved VALUES(1,'{"catalog":"unchanged","orders":[1,2]}');
      ALTER TABLE public.qa_preserved ENABLE ROW LEVEL SECURITY;""")
    baseline = snapshot()
    assert dev.validate_schema(json.loads(sql(dev.SCHEMA_SQL))) == frozenset({dev.CAPABILITY})
    tables = {"units": "technical_units", "attributes": "technical_attributes", "bindings": "technical_family_attributes"}
    old = {key: json.loads(sql("SELECT jsonb_agg(to_jsonb(t)) FROM " + table + " t")) for key, table in tables.items()}
    extension = json.loads((ROOT / "src/lib/technical/accessory-dictionary.json").read_text())
    with mock.patch.object(installation, "ACCESSORY_SHA256", "0" * 64):
        try:
            installation.transaction("a" * 40, "sha256:" + "b" * 64, accessories=True)
        except RuntimeError as failure:
            assert str(failure) == "ACCESSORY_INSTALL_CHECKSUM"
        else:
            raise AssertionError("MODIFIED_PROPOSAL_ACCEPTED")
    transaction = installation.transaction("a" * 40, "sha256:" + "b" * 64, accessories=True)
    def unchanged():
        assert snapshot() == baseline
        assert sql("SELECT to_regprocedure('mw_private.documentary_conditions_version()') IS NULL "
                   "AND to_regprocedure('mw_private.accessory_dictionary_version()') IS NULL") == "t"
    cases = [
        ("UPDATE staff SET name='Unexpected';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("UPDATE qa_preserved SET payload='{}';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("UPDATE technical_units SET label='Changed' WHERE code='a';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("UPDATE technical_units SET label='Changed' WHERE code='mm2';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("DELETE FROM technical_family_attributes WHERE family_code='tig_torch';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("INSERT INTO technical_units VALUES('extra','Лишняя','extra');", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
        ("GRANT SELECT ON technical_attributes TO anon;", "DOCUMENTARY_INSTALL_RELATIONS_CHANGED"),
        ("GRANT EXECUTE ON FUNCTION mw_private.accessory_dictionary_version() TO service_role;", "DOCUMENTARY_INSTALL_PRIVATE_ACCESS"),
        ("CREATE OR REPLACE FUNCTION mw_private.accessory_dictionary_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2';", "ACCESSORY_INSTALL_VERSION"),
        ("CREATE POLICY qa_unexpected ON qa_preserved USING(true);", "DOCUMENTARY_INSTALL_ACCESS_CHANGED"),
    ]
    for injected, error in cases:
        sql(transaction.replace("-- All checks precede", injected + "\n-- All checks precede"), error)
        unchanged()
    sql(transaction.replace("NOTIFY pgrst", "SELECT 1/0; NOTIFY pgrst"), "division by zero")
    unchanged()
    sql(transaction.replace("DO $identity$", "UPDATE mw_private.environment SET environment='production'; DO $identity$", 1),
        "DOCUMENTARY_INSTALL_DEV_REQUIRED")
    unchanged()
    sql(transaction)
    after = snapshot()
    for name, fingerprint in baseline.items():
        if name not in {"public." + table for table in tables.values()} | {"mw_private.dev_migration_receipts"}:
            assert after[name] == fingerprint, name
    for key, table in tables.items():
        actual = json.loads(sql("SELECT jsonb_agg(to_jsonb(t)) FROM " + table + " t"))
        ordered = lambda rows: sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
        assert ordered(actual) == ordered(old[key] + extension[key]), table
    assert json.loads(sql("SELECT jsonb_object_agg(path,sha256) FROM mw_private.dev_migration_receipts")) == {
        "previous-test": "unchanged", installation.PROPOSAL_PATH: installation.PROPOSAL_SHA256,
        installation.ACCESSORY_PATH: installation.ACCESSORY_SHA256}
    state = json.loads(sql(dev.SCHEMA_SQL))
    assert dev.validate_schema(state) == dev.SCHEMA_0043_CAPABILITIES
    assert prod.validate_schema(state, installation.IDENTITY) == prod.SCHEMA_0043_CAPABILITIES
    for gate, error, prefix in [(dev, RuntimeError, "DEV"), (prod, ValueError, "PROD")]:
        labels = {"org.opencontainers.image.revision": "a" * 40, gate.CAPABILITY: "1", gate.DOCUMENTARY_CAPABILITY: "1"}
        if gate is dev:
            labels["mw.environment"] = "dev"
        image = {"Id": "sha256:" + "b" * 64, "Config": {"Labels": labels}}
        try:
            gate.validate_image(image, "a" * 40, gate.SCHEMA_0043_CAPABILITIES)
        except error as failure:
            assert str(failure) == prefix + "_IMAGE_ACCESSORY_DICTIONARY_UNSUPPORTED"
        else:
            raise AssertionError("OLD_IMAGE_ACCEPTED_AFTER_DICTIONARY")
        labels[gate.ACCESSORY_CAPABILITY] = "1"
        assert gate.validate_image(image, "a" * 40, gate.SCHEMA_0043_CAPABILITIES) == image["Id"]
    corruptions = [
        "DROP FUNCTION mw_private.accessory_dictionary_version();",
        "CREATE OR REPLACE FUNCTION mw_private.accessory_dictionary_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2';",
        "UPDATE technical_units SET label='Other' WHERE code='mm2';",
        "UPDATE technical_attributes SET required_context='{}' WHERE code='tig_torch_max_dc_a';",
        "DELETE FROM technical_family_attributes WHERE family_code='tig_torch';",
        "INSERT INTO technical_family_attributes(family_code,attribute_code,label,sort_order,options_override) SELECT 'power_mma',attribute_code,label,sort_order,options_override FROM technical_family_attributes WHERE family_code='tig_torch' LIMIT 1;",
    ]
    read_probe = dev.SCHEMA_SQL.replace("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;", "").replace("COMMIT;", "ROLLBACK;")
    for mutation in corruptions:
        corrupt = json.loads(sql("BEGIN;" + mutation + read_probe))
        for gate, error, prefix in [(dev, RuntimeError, "DEV"), (prod, ValueError, "PROD")]:
            try:
                gate.validate_schema(corrupt, installation.IDENTITY) if gate is prod else gate.validate_schema(corrupt)
            except error as failure:
                assert str(failure) == prefix + "_ACCESSORY_SCHEMA_INCOMPLETE"
            else:
                raise AssertionError("CORRUPTED_DICTIONARY_ACCEPTED")
        assert json.loads(sql(dev.SCHEMA_SQL)) == state
    sql(transaction, "DOCUMENTARY_INSTALL_ALREADY_PRESENT")
    assert snapshot() == after
    run(["docker", "restart", NAME])
    ready()
    assert snapshot() == after
    print(json.dumps({"ok": True, "proposal0042": installation.PROPOSAL_SHA256,
                      "proposal0043": installation.ACCESSORY_SHA256, "rollback_cases": len(cases) + 2,
                      "exact_appended_dictionary": True, "both_receipts": True, "repeat_refused": True,
                      "restart_preserved": True, "schema_corruption_cases": len(corruptions),
                      "dev_and_production_guards": True, "old_image_refused": True}, ensure_ascii=False))
finally:
    if created:
        run(["docker", "rm", "-f", "-v", NAME])
