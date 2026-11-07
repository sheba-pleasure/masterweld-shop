#!/usr/bin/env python3
"""Production compatibility guard on private disposable PostgreSQL and stopped fixture images."""
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))
import app_compatibility as guard

PREFIX = "mw-prod-compat-qa-" + uuid.uuid4().hex[:10]
DB = PREFIX + "-db"
SLOT = PREFIX + "-slot-a"
IDENTITY = {"environment": "production", "instanceId": str(uuid.uuid4())}
ENV = {"APP_ENV": "production", "MW_INSTANCE_ID": IDENTITY["instanceId"]}
SHAS = ["1" * 40, "2" * 40]
IMAGES = [PREFIX + ":old", PREFIX + ":compatible"]
containers = []
images = []
image_ids = []
checks = []


def docker(*args, input=None, check=True):
    result = subprocess.run(["docker", *args], input=input, capture_output=True, text=True, timeout=90)
    if check and result.returncode:
        raise RuntimeError("QA_DOCKER_FAILED:" + args[0] + ":" + result.stderr[-1500:])
    return result


def sql(statement):
    return docker("exec", "-i", DB, "psql", "-X", "-Atq", "-U", "postgres",
                  "-v", "ON_ERROR_STOP=1", input=statement).stdout.strip()


def check_image(index):
    return guard.check(ENV, SHAS[index], image=IMAGES[index], db_container=DB, db_name="postgres")


def check_slot():
    return guard.check(ENV, SHAS[0], container=SLOT, slot="a", db_container=DB, db_name="postgres")


def refused(fn, code):
    try:
        fn()
    except ValueError as error:
        assert str(error) == code, str(error)
    else:
        raise AssertionError("QA_EXPECTED_REFUSAL:" + code)


try:
    # No pulls or host secrets, no published ports and no connection to existing databases.
    for name in ("postgres:17.6-alpine", "node:22-bookworm-slim"):
        docker("image", "inspect", name)
    docker("run", "-d", "--name", DB, "--network", "none",
           "--label", "mw.environment=production", "--label", "mw.scope=isolated-qa",
           "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine")
    containers.append(DB)
    for _ in range(100):
        if docker("exec", DB, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", check=False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("QA_DATABASE_NOT_READY")
    sql("CREATE SCHEMA mw_private; CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql "
        "AS $$ SELECT '" + json.dumps(IDENTITY) + "'::jsonb $$; "
        "CREATE TABLE public.qa_preserve(id integer PRIMARY KEY, value text); "
        "INSERT INTO public.qa_preserve VALUES(1,'Keep exactly');")
    with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
        context = pathlib.Path(directory)
        (context / "Dockerfile").write_text(
            'FROM node:22-bookworm-slim\nARG SHA\nARG CAP\nARG QA_RUN\n'
            'LABEL org.opencontainers.image.revision=$SHA mw.capabilities.source-facts=$CAP mw.qa-run=$QA_RUN\n'
            'CMD ["sleep","300"]\n'
        )
        for index, name in enumerate(IMAGES):
            assert docker("image", "inspect", name, check=False).returncode != 0
            images.append(name)
            docker("build", "--network", "none", "--build-arg", "SHA=" + SHAS[index],
                   "--build-arg", "CAP=" + str(index), "--build-arg", "QA_RUN=" + PREFIX, "-t", name, directory)
            image_ids.append(json.loads(docker("image", "inspect", name).stdout)[0]["Id"])
        old_id = check_image(0)
        new_id = check_image(1)
        docker("create", "--name", SLOT, "--network", "none", "--label", "mw-shop.slot=a",
               "--label", "mw-shop.sha=" + SHAS[0],
               "--env", "APP_ENV=production", "--env", "MW_INSTANCE_ID=" + IDENTITY["instanceId"],
               old_id)
        containers.append(SLOT)
        assert check_slot() == old_id
        checks.append("old_schema_allows_old_image_and_stopped_predecessor")
        sql("CREATE TABLE source_fact_reviews(id integer)")
        refused(lambda: check_image(1), "PROD_SOURCE_FACT_SCHEMA_INCOMPLETE")
        checks.append("partial_schema_refuses_even_capable_image")
        sql("""
          CREATE TABLE source_fact_rows(id integer);
          CREATE TABLE source_fact_prompts(id integer);
          CREATE TABLE technical_fact_origins(id integer);
          CREATE FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)
            RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
          CREATE FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)
            RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
        """)
        refused(lambda: check_image(0), "PROD_IMAGE_SOURCE_FACTS_UNSUPPORTED")
        refused(check_slot, "PROD_IMAGE_SOURCE_FACTS_UNSUPPORTED")
        assert check_image(1) == new_id
        checks.append("full_empty_schema_refuses_old_image_and_predecessor")
        checks.append("compatible_image_returns_immutable_id")
        # Retagging the old name cannot change the saved container's image identity.
        docker("tag", new_id, IMAGES[0])
        refused(check_slot, "PROD_IMAGE_SOURCE_FACTS_UNSUPPORTED")
        checks.append("retagged_predecessor_still_checked_by_image_id")
        wrong = {**ENV, "MW_INSTANCE_ID": str(uuid.uuid4())}
        refused(lambda: guard.check(wrong, SHAS[1], image=IMAGES[1],
                                   db_container=DB, db_name="postgres"), "PROD_DATABASE_IDENTITY_MISMATCH")
        checks.append("wrong_production_instance_refused")
        env_file = context / "production.env"
        env_file.write_text("\n".join(key + "=" + value for key, value in ENV.items()) + "\n")
        env_file.chmod(0o600)
        cli = subprocess.run([sys.executable, str(ROOT / "ops/production/app_compatibility.py"),
                              "--env-file", str(env_file), "--sha", SHAS[1], "--image", IMAGES[1],
                              "--db-container", DB, "--db-name", "postgres"], capture_output=True, text=True)
        assert cli.returncode == 0 and cli.stdout.strip() == new_id, cli.stderr
        assert sql("SELECT value FROM qa_preserve WHERE id=1") == "Keep exactly"
        assert json.loads(docker("inspect", SLOT).stdout)[0]["State"]["Running"] is False
        checks.append("CLI_reads_private_config_without_starting_predecessor_or_writing_rows")
    print(json.dumps({"ok": True, "checks": checks, "existingDatabaseUsed": False,
                      "releaseScriptsExercised": False, "telegramSent": False}))
finally:
    for name in reversed(containers):
        docker("rm", "-fv", name, check=False)
    for name in images + image_ids:
        docker("image", "rm", "-f", name, check=False)
