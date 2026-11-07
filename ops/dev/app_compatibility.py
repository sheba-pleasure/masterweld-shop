"""Fail-closed DEV image/schema checks. Reads metadata only; never repairs data."""
import json
import re
import subprocess

IDENTITY = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
CAPABILITY = "mw.capabilities.source-facts"
DB_CONTAINER = "mw-dev-db"
DB_NAME = "masterweld_dev"
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


def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True, timeout=20)
    if result.returncode:
        if re.search(r"no such (image|container|object)", result.stderr, re.I):
            return None
        raise RuntimeError("DEV_DOCKER_INSPECT_FAILED")
    value = json.loads(result.stdout)
    if not isinstance(value, list) or len(value) != 1:
        raise RuntimeError("DEV_DOCKER_INSPECT_INVALID")
    return value[0]


def owned(container):
    if not container or (container["Config"].get("Labels") or {}).get("mw.environment") != "dev":
        raise RuntimeError("DEV_CONTAINER_REQUIRED")


def schema_requirements():
    database = inspect("container", DB_CONTAINER)
    owned(database)
    if not database["State"]["Running"]:
        raise RuntimeError("DEV_DATABASE_NOT_RUNNING")
    result = subprocess.run(
        ["docker", "exec", "-i", DB_CONTAINER, "psql", "-X", "-Atq", "-U", "postgres",
         "-d", DB_NAME, "-v", "ON_ERROR_STOP=1"],
        input=SCHEMA_SQL, capture_output=True, text=True, timeout=20,
    )
    if result.returncode:
        raise RuntimeError("DEV_SCHEMA_UNAVAILABLE")
    return validate_schema(json.loads(result.stdout))


def validate_schema(value):
    if not isinstance(value, dict) or value.get("identity") != IDENTITY:
        raise RuntimeError("DEV_DATABASE_IDENTITY_MISMATCH")
    flags = value.get("sourceFacts")
    if not isinstance(flags, list) or len(flags) != 6 or any(type(flag) is not bool for flag in flags):
        raise RuntimeError("DEV_SCHEMA_INVALID")
    if any(flags) and not all(flags):
        raise RuntimeError("DEV_SOURCE_FACT_SCHEMA_INCOMPLETE")
    # Require compatibility as soon as the schema exists, even if currently empty.
    # This avoids a read-empty / concurrent-first-write race and preserves history.
    return all(flags)


def validate_image(info, revision, source_facts):
    if not re.fullmatch("[0-9a-f]{40}", revision or ""):
        raise RuntimeError("DEV_FULL_REVISION_REQUIRED")
    if not info:
        raise RuntimeError("DEV_IMAGE_REQUIRED")
    labels = info["Config"].get("Labels") or {}
    if labels.get("mw.environment") != "dev":
        raise RuntimeError("DEV_IMAGE_ENVIRONMENT_MISMATCH")
    if labels.get("org.opencontainers.image.revision") != revision:
        raise RuntimeError("DEV_IMAGE_REVISION_MISMATCH")
    if source_facts and labels.get(CAPABILITY) != "1":
        raise RuntimeError("DEV_IMAGE_SOURCE_FACTS_UNSUPPORTED")
    if not re.fullmatch("sha256:[0-9a-f]{64}", info.get("Id", "")):
        raise RuntimeError("DEV_IMAGE_ID_REQUIRED")
    return info["Id"]


def validate_previous(container):
    owned(container)
    # Inspect the immutable image ID, never the mutable tag saved in Config.Image.
    image = inspect("image", container["Image"])
    revision = (image["Config"].get("Labels") or {}).get("org.opencontainers.image.revision") if image else None
    validate_image(image, revision, schema_requirements())
    return revision
