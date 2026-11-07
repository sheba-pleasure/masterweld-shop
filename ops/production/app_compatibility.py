#!/usr/bin/env python3
"""Read-only production source-fact schema/image guard; never starts or changes resources."""
import argparse
import json
import pathlib
import re
import subprocess
import uuid

from preflight import DEV_ID, read_env

CAPABILITY = "mw.capabilities.source-facts"
DB_CONTAINER = "mw-prod-db"
DB_NAME = "masterweld_production"
SCHEMA_SQL = """
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT jsonb_build_object(
 'identity', public.mw_environment_identity(),
 'sourceFacts', jsonb_build_array(
  to_regclass('public.source_fact_reviews') IS NOT NULL,
  to_regclass('public.source_fact_rows') IS NOT NULL,
  to_regclass('public.source_fact_prompts') IS NOT NULL,
  to_regclass('public.technical_fact_origins') IS NOT NULL,
  to_regprocedure('public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)') IS NOT NULL,
  to_regprocedure('mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)') IS NOT NULL
 ));
COMMIT;
"""


def identity_from_env(env):
    identity = env.get("MW_INSTANCE_ID", "")
    try:
        parsed = str(uuid.UUID(identity))
    except (ValueError, AttributeError):
        raise ValueError("PROD_INSTANCE_ID_REQUIRED") from None
    if env.get("APP_ENV") != "production" or identity != parsed or identity == DEV_ID:
        raise ValueError("PROD_ENVIRONMENT_REQUIRED")
    return {"environment": "production", "instanceId": identity}


def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True, timeout=20)
    if result.returncode:
        # An unavailable Docker engine must not be confused with a missing resource.
        if re.search(r"no such (image|container|object)", result.stderr, re.I):
            raise ValueError("PROD_RESOURCE_MISSING")
        raise ValueError("PROD_DOCKER_UNAVAILABLE")
    try:
        values = json.loads(result.stdout)
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("PROD_DOCKER_METADATA_INVALID") from None
    return values[0]


def validate_schema(value, identity):
    if not isinstance(value, dict) or value.get("identity") != identity:
        raise ValueError("PROD_DATABASE_IDENTITY_MISMATCH")
    flags = value.get("sourceFacts")
    if not isinstance(flags, list) or len(flags) != 6 or any(type(flag) is not bool for flag in flags):
        raise ValueError("PROD_SCHEMA_INVALID")
    if any(flags) and not all(flags):
        raise ValueError("PROD_SOURCE_FACT_SCHEMA_INCOMPLETE")
    # Empty new tables still require compatible code: first writes may happen concurrently.
    return all(flags)


def schema_requirements(identity, db_container=DB_CONTAINER, db_name=DB_NAME):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", db_container) or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", db_name):
        raise ValueError("PROD_DATABASE_NAME_INVALID")
    database = inspect("container", db_container)
    if (database.get("Config", {}).get("Labels") or {}).get("mw.environment") != "production":
        raise ValueError("PROD_DATABASE_CONTAINER_REQUIRED")
    if database.get("State", {}).get("Running") is not True:
        raise ValueError("PROD_DATABASE_NOT_RUNNING")
    result = subprocess.run(
        ["docker", "exec", "-i", db_container, "psql", "-X", "-Atq", "-U", "postgres",
         "-d", db_name, "-v", "ON_ERROR_STOP=1"],
        input=SCHEMA_SQL, capture_output=True, text=True, timeout=20,
    )
    if result.returncode:
        raise ValueError("PROD_SCHEMA_UNAVAILABLE")
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise ValueError("PROD_SCHEMA_INVALID") from None
    return validate_schema(value, identity)


def validate_image(image, revision, source_facts):
    if not re.fullmatch(r"[0-9a-f]{40}", revision or ""):
        raise ValueError("PROD_FULL_REVISION_REQUIRED")
    labels = image.get("Config", {}).get("Labels") or {}
    if labels.get("org.opencontainers.image.revision") != revision:
        raise ValueError("PROD_IMAGE_REVISION_MISMATCH")
    if labels.get("mw.environment") == "dev":
        raise ValueError("PROD_DEV_IMAGE_FORBIDDEN")
    if source_facts and labels.get(CAPABILITY) != "1":
        raise ValueError("PROD_IMAGE_SOURCE_FACTS_UNSUPPORTED")
    image_id = image.get("Id", "")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("PROD_IMAGE_ID_REQUIRED")
    return image_id


def validate_container(container, revision, identity, slot):
    labels = container.get("Config", {}).get("Labels") or {}
    if slot not in ("a", "b") or labels.get("mw-shop.slot") != slot or labels.get("mw-shop.sha") != revision:
        raise ValueError("PROD_SLOT_IDENTITY_MISMATCH")
    entries = container.get("Config", {}).get("Env") or []
    if not isinstance(entries, list) or any(not isinstance(entry, str) or "=" not in entry for entry in entries):
        raise ValueError("PROD_CONTAINER_ENV_INVALID")
    env = {}
    for entry in entries:
        key, value = entry.split("=", 1)
        if key in env:
            raise ValueError("PROD_CONTAINER_ENV_INVALID")
        env[key] = value
    if identity_from_env(env) != identity:
        raise ValueError("PROD_CONTAINER_DATABASE_MISMATCH")
    image_id = container.get("Image", "")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("PROD_IMAGE_ID_REQUIRED")
    return image_id


def check(env, revision, image=None, container=None, slot=None,
          db_container=DB_CONTAINER, db_name=DB_NAME):
    identity = identity_from_env(env)
    required = schema_requirements(identity, db_container, db_name)
    if (image is None) == (container is None):
        raise ValueError("PROD_ONE_TARGET_REQUIRED")
    if container is not None:
        image = validate_container(inspect("container", container), revision, identity, slot)
    metadata = inspect("image", image)
    image_id = validate_image(metadata, revision, required)
    if container is not None and image_id != image:
        raise ValueError("PROD_IMAGE_ID_MISMATCH")
    return image_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=pathlib.Path)
    parser.add_argument("--sha", required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--image")
    target.add_argument("--container")
    parser.add_argument("--slot", choices=("a", "b"))
    parser.add_argument("--db-container", default=DB_CONTAINER)
    parser.add_argument("--db-name", default=DB_NAME)
    args = parser.parse_args()
    try:
        image_id = check(read_env(args.env_file), args.sha, args.image, args.container, args.slot,
                         args.db_container, args.db_name)
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError, AttributeError) as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r"PROD_[A-Z_]+", code) else "PROD_COMPATIBILITY_CHECK_FAILED") from None
    print(image_id)


if __name__ == "__main__":
    main()
