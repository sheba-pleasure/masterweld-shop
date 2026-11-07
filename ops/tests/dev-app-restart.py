#!/usr/bin/env python3
"""Real Docker replacement rehearsal with synthetic apps, isolated networks and DB."""
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/dev"))
import app_compatibility as gate

spec = importlib.util.spec_from_file_location("dev_restart", ROOT / "ops/dev/restart.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

PREFIX = "mw-app-switch-qa-" + uuid.uuid4().hex[:12]
NETWORKS = [PREFIX + "-edge", PREFIX + "-private"]
DATABASE = PREFIX + "-db"
APP = PREFIX + "-app"
PREVIOUS = PREFIX + "-previous"
CANDIDATE = PREFIX + "-candidate"
IMAGES = []
CREATED_NETWORKS = []
DATABASE_CREATED = False
CHECKS = []


def command(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=120, **kwargs)


def sql(query):
    return command(["docker", "exec", "-i", DATABASE, "psql", "-X", "-Atq", "-U", "postgres",
                    "-d", "masterweld_dev", "-v", "ON_ERROR_STOP=1"], input=query).stdout.strip()


def build(mode, capable, documentary=False):
    revision = uuid.uuid4().hex + uuid.uuid4().hex[:8]
    tag = "masterweld-dev:" + revision
    assert gate.inspect("image", tag) is None
    server = """
const http = require('node:http');
http.createServer((request,response) => {
 if (request.url === '/api/public/release-health') {
  const ready = process.env.MODE !== 'fail-preflight' &&
   !(process.env.MODE === 'fail-active' && process.env.ORDER_NOTIFICATIONS_ENABLED !== 'false');
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify({ready, revision:process.env.RELEASE_SHA, environment:process.env.APP_ENV}));
 } else { response.end('Тестовый магазин'); }
}).listen(3000,'0.0.0.0');
"""
    labels = {"mw.environment": "dev", "mw.test": PREFIX,
              "org.opencontainers.image.revision": revision}
    if capable:
        labels[gate.CAPABILITY] = "1"
    if documentary:
        labels[gate.DOCUMENTARY_CAPABILITY] = "1"
    dockerfile = "FROM node:22-bookworm-slim\n"
    dockerfile += "LABEL " + " ".join(k + "=" + json.dumps(v) for k, v in labels.items()) + "\n"
    dockerfile += "ENV RELEASE_SHA=" + revision + " MODE=" + mode + "\nUSER node\n"
    dockerfile += "CMD " + json.dumps(["node", "-e", server], ensure_ascii=False) + "\n"
    command(["docker", "build", "--network", "none", "-q", "-t", tag, "-"], input=dockerfile)
    IMAGES.append(tag)
    return revision, gate.inspect("image", tag)["Id"]


def replace(revision, state, expected=None):
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            app.replace(revision, state)
    except RuntimeError as error:
        if expected is None or expected not in str(error):
            raise
    else:
        assert expected is None, "Expected refusal " + str(expected)


def schema():
    # Small metadata fixture; the real migrations/query are exercised separately
    # by source-fact-review.py. No shop/catalog/customer rows are copied here.
    sql("""
CREATE TABLE source_fact_reviews(id integer);
CREATE TABLE source_fact_rows(id integer);
CREATE TABLE source_fact_prompts(id integer);
CREATE TABLE technical_fact_origins(id integer);
CREATE FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)
 RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)
 RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
""")


def clean_apps():
    for name in [CANDIDATE, APP, PREVIOUS]:
        current = gate.inspect("container", name)
        if current:
            assert name.startswith(PREFIX)
            command(["docker", "rm", "-f", current["Id"]])


try:
    with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
        app.ROOT = pathlib.Path(directory)
        state = app.ROOT / "ops/.state/dev"
        state.mkdir(parents=True)
        secrets = app.ROOT / "ops/.secrets/dev"
        secrets.mkdir(parents=True)
        (secrets / "app.env").write_text("APP_ENV=dev\nORDER_NOTIFICATIONS_ENABLED=true\n")
        app.APP, app.PREVIOUS, app.CANDIDATE = APP, PREVIOUS, CANDIDATE
        app.EDGE_NETWORK, app.PRIVATE_NETWORK = NETWORKS
        app.PROBE_ATTEMPTS = 4
        gate.DB_CONTAINER = DATABASE
        assert all(name.startswith(PREFIX) for name in [app.APP, app.PREVIOUS, app.CANDIDATE,
                                                       app.EDGE_NETWORK, app.PRIVATE_NETWORK, gate.DB_CONTAINER])
        for network in NETWORKS:
            command(["docker", "network", "create", "--internal", "--label", "mw.test=" + PREFIX, network])
            CREATED_NETWORKS.append(network)
        command(["docker", "run", "-d", "--name", DATABASE, "--network", "none",
                 "--label", "mw.environment=dev", "--label", "mw.test=" + PREFIX,
                 "--tmpfs", "/var/lib/postgresql/data:rw,size=256m",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=masterweld_dev", "postgres:17.6-alpine"])
        DATABASE_CREATED = True
        for _ in range(100):
            probe = subprocess.run(["docker", "exec", DATABASE, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "masterweld_dev"], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError("QA_DATABASE_NOT_READY")
        sql("CREATE SCHEMA mw_private; CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb "
            "LANGUAGE sql AS $$ SELECT '" + json.dumps(gate.IDENTITY) + "'::jsonb $$;")
        legacy_sha, legacy_id = build("normal", False)
        good_sha, good_id = build("normal", True)
        bad_sha, bad_id = build("fail-active", True)
        preflight_sha, preflight_id = build("fail-preflight", True)

        assert gate.schema_requirements() == frozenset()
        app.launch(APP, legacy_id)
        app.probe(APP, legacy_sha)
        app.write_active(state, legacy_sha)
        schema()
        assert gate.schema_requirements() == frozenset({gate.CAPABILITY})
        original = gate.inspect("container", APP)["Id"]
        replace(legacy_sha, state, "SOURCE_FACTS_UNSUPPORTED")
        assert gate.inspect("container", APP)["Id"] == original
        assert gate.inspect("container", APP)["State"]["Running"]
        CHECKS.append("unsupported_target_preserves_running_app")

        # A healthy preflight does not guarantee successful normal worker config.
        # Old incompatible image must remain stopped after this actual failed switch.
        replace(bad_sha, state, "ROLLBACK_REQUIRES_REVIEW")
        assert gate.inspect("container", APP) is None
        assert gate.inspect("container", PREVIOUS)["Id"] == original
        assert not gate.inspect("container", PREVIOUS)["State"]["Running"]
        assert not (state / "active-sha").exists()
        assert sql("SELECT count(*) FROM source_fact_reviews") == "0"
        CHECKS.append("failed_switch_retains_but_never_starts_incompatible_previous")
        clean_apps()

        # Independent fixture for successful promotion and compatible fallback.
        app.launch(APP, good_id)
        app.probe(APP, good_sha)
        app.write_active(state, good_sha)
        original = gate.inspect("container", APP)["Id"]
        replace(preflight_sha, state, "DEV_HEALTH_FAILED")
        assert gate.inspect("container", APP)["Id"] == original
        assert gate.inspect("container", APP)["State"]["Running"]
        assert gate.inspect("container", CANDIDATE) is None
        CHECKS.append("failed_preflight_preserves_active_container")
        replace(bad_sha, state, "PREVIOUS_RESTORED")
        assert gate.inspect("container", APP)["Id"] == original
        app.probe(APP, good_sha)
        assert (state / "active-sha").read_text().strip() == good_sha
        CHECKS.append("compatible_previous_restored_and_probed")
        replace(good_sha, state)
        active = gate.inspect("container", APP)
        assert active["Id"] != original and active["Image"] == good_id
        assert active["HostConfig"]["PortBindings"] in (None, {})
        assert "ORDER_NOTIFICATIONS_ENABLED=true" in active["Config"]["Env"]
        assert set(active["NetworkSettings"]["Networks"]) == set(NETWORKS)
        assert gate.inspect("container", PREVIOUS)["Id"] == original
        assert not gate.inspect("container", PREVIOUS)["State"]["Running"]
        assert gate.inspect("container", CANDIDATE) is None
        assert (state / "active-sha").read_text().strip() == good_sha
        CHECKS += ["successful_switch_retains_previous", "normal_notification_setting_preserved",
                   "isolated_networks_no_published_ports", "no_catalog_or_order_data"]
        # Source-only images become incompatible even while the new schema is empty.
        documentary_sha, documentary_id = build("normal", True, documentary=True)
        documentary_bad_sha, _ = build("fail-active", True, documentary=True)
        active_before = gate.inspect("container", APP)["Id"]
        sql("CREATE FUNCTION mw_private.documentary_conditions_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1'")
        replace(documentary_sha, state, "DOCUMENTARY_SCHEMA_INCOMPLETE")
        assert gate.inspect("container", APP)["Id"] == active_before
        CHECKS.append("partial_documentary_schema_preserves_active_container")
        sql("""
CREATE TABLE technical_attributes(required_context text[],
 CONSTRAINT technical_attributes_required_context_check CHECK(required_context <@ ARRAY['test_conditions']));
ALTER TABLE source_fact_prompts ADD COLUMN field text;
ALTER TABLE source_fact_prompts ADD CONSTRAINT source_fact_prompts_field_check CHECK(field IN('test_conditions'));
CREATE FUNCTION mw_private.validate_technical_document_before_origins(jsonb,text) RETURNS void
 LANGUAGE plpgsql AS $$ DECLARE context_key text; BEGIN
 IF context_key='test_conditions' THEN RETURN; END IF; END $$;
CREATE OR REPLACE FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)
 RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE input_field text; BEGIN
 IF input_field='test_conditions' THEN RETURN '{}'::jsonb; END IF; RETURN '{}'::jsonb; END $$;
""")
        assert gate.schema_requirements() == frozenset({gate.CAPABILITY, gate.DOCUMENTARY_CAPABILITY})
        replace(good_sha, state, "DOCUMENTARY_CONDITIONS_UNSUPPORTED")
        assert gate.inspect("container", APP)["Id"] == active_before
        assert gate.inspect("container", APP)["State"]["Running"]
        assert gate.inspect("container", CANDIDATE) is None
        CHECKS.append("empty_documentary_schema_refuses_source_only_target_before_start")
        replace(documentary_bad_sha, state, "ROLLBACK_REQUIRES_REVIEW")
        assert gate.inspect("container", APP) is None
        assert gate.inspect("container", PREVIOUS)["Id"] == active_before
        assert not gate.inspect("container", PREVIOUS)["State"]["Running"]
        assert not (state / "active-sha").exists()
        CHECKS.append("documentary_failure_never_starts_source_only_predecessor")
        clean_apps()
        app.launch(APP, documentary_id)
        app.probe(APP, documentary_sha)
        app.write_active(state, documentary_sha)
        active_before = gate.inspect("container", APP)["Id"]
        replace(documentary_bad_sha, state, "PREVIOUS_RESTORED")
        assert gate.inspect("container", APP)["Id"] == active_before
        app.probe(APP, documentary_sha)
        assert (state / "active-sha").read_text().strip() == documentary_sha
        CHECKS.append("documentary_compatible_fallback_is_started_and_probed")
        print(json.dumps({"ok": True, "checks": CHECKS}))
finally:
    clean_apps()
    if DATABASE_CREATED:
        subprocess.run(["docker", "rm", "-f", DATABASE], capture_output=True)
    for network in reversed(CREATED_NETWORKS):
        subprocess.run(["docker", "network", "rm", network], capture_output=True)
    for tag in IMAGES:
        subprocess.run(["docker", "image", "rm", tag], capture_output=True)
