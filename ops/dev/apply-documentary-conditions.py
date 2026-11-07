#!/usr/bin/env python3
"""Reviewed DEV-only 0042 transition. --finish reads the receipt and never repeats SQL."""
import argparse
import fcntl
import json
import os
import pathlib
import re
import subprocess
import time
import uuid

import app_compatibility as compatibility
import documentary_conditions_installation as installation
import documentary_transition
import restart

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = ROOT / "ops/.state/dev"
JOURNAL = STATE / "documentary-transition.json"
WORKER = "mw-dev-document-worker"
PREVIOUS_PREFIX = "mw-dev-before-0042-"
PHASES = {"prepared", "draining", "drain_failed", "migration_submitted",
          "migration_requires_review", "migration_recorded", "activation_requires_review",
          "application_ready", "worker_requires_review", "complete"}


def run(args, **kwargs):
    kwargs.setdefault("timeout", 300)
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def sql(query):
    try:
        return run(["docker", "exec", "-i", compatibility.DB_CONTAINER, "psql", "-X", "-Atq",
                    "-U", "postgres", "-d", compatibility.DB_NAME, "-v", "ON_ERROR_STOP=1"],
                   input=query).stdout.strip()
    except (subprocess.SubprocessError, OSError) as error:
        raise RuntimeError("DOCUMENTARY_SQL_RESULT_REQUIRES_REVIEW") from error


def revision():
    if run(["git", "status", "--porcelain"], cwd=ROOT).stdout.strip():
        raise RuntimeError("COMMIT_SOURCE_REQUIRED")
    return run(["git", "rev-parse", "HEAD"], cwd=ROOT).stdout.strip()


def baseline():
    if compatibility.schema_requirements() != frozenset({compatibility.CAPABILITY}):
        raise RuntimeError("DOCUMENTARY_BASELINE_REQUIRED")
    proposal = installation.load_proposal()
    guard, separator, _ = proposal.partition("END $baseline$;")
    if not separator:
        raise RuntimeError("DOCUMENTARY_BASELINE_GUARD_REQUIRED")
    sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s';" + guard + separator + "COMMIT;")
    if sql("SELECT count(*) FROM mw_private.dev_migration_receipts WHERE path=" +
           installation.literal(installation.PROPOSAL_PATH)) != "0":
        raise RuntimeError("DOCUMENTARY_RECEIPT_ALREADY_EXISTS")


def check_record(record):
    expected = {"version", "phase", "operation", "sourceSha", "imageId",
                "oldId", "oldImage", "oldRevision", "workerId", "workerImage"}
    if not isinstance(record, dict) or set(record) != expected or record["version"] != 1 or record["phase"] not in PHASES:
        raise RuntimeError("DOCUMENTARY_JOURNAL_INVALID")
    for key in ("sourceSha", "oldRevision"):
        if not isinstance(record[key], str) or not re.fullmatch("[0-9a-f]{40}", record[key]):
            raise RuntimeError("DOCUMENTARY_JOURNAL_INVALID")
    for key in ("imageId", "oldImage", "workerImage"):
        if not isinstance(record[key], str) or not re.fullmatch("sha256:[0-9a-f]{64}", record[key]):
            raise RuntimeError("DOCUMENTARY_JOURNAL_INVALID")
    for key in ("oldId", "workerId"):
        if not isinstance(record[key], str) or not re.fullmatch("[0-9a-f]{64}", record[key]):
            raise RuntimeError("DOCUMENTARY_JOURNAL_INVALID")
    if not isinstance(record["operation"], str) or not re.fullmatch("[0-9a-f]{32}", record["operation"]):
        raise RuntimeError("DOCUMENTARY_JOURNAL_INVALID")
    return record


def persist(record, phase, create=False):
    record = {**record, "phase": phase}
    check_record(record)
    if create:
        fd = os.open(JOURNAL, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        target = JOURNAL
    else:
        target = JOURNAL.with_suffix(".next")
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(json.dumps(record, indent=2) + "\n")
        output.flush()
        os.fsync(output.fileno())
    if not create:
        target.replace(JOURNAL)
    directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def checked_container(container_id, image_id):
    container = compatibility.inspect("container", container_id)
    compatibility.owned(container)
    if container["Id"] != container_id or container["Image"] != image_id:
        raise RuntimeError("DOCUMENTARY_CONTAINER_CHANGED")
    return container


def checked_worker(record):
    worker = checked_container(record["workerId"], record["workerImage"])
    env = dict(item.split("=", 1) for item in worker["Config"].get("Env", []))
    if (worker["Name"] != "/" + WORKER or worker["Config"]["Cmd"] != ["/usr/bin/python3", "/worker/worker.py"]
            or env.get("APP_ENV") != "dev" or env.get("SUPABASE_URL") != "http://mw-dev-gateway:8080"):
        raise RuntimeError("DOCUMENTARY_WORKER_IDENTITY")
    return worker


def stop(container_id, seconds):
    run(["docker", "stop", "--time", str(seconds), container_id])


class Adapter:
    def persist(self, record, phase):
        persist(record, phase)
        record["phase"] = phase

    def pause_writers(self, record):
        old = checked_container(record["oldId"], record["oldImage"])
        worker = checked_worker(record)
        if old["Name"] != "/" + restart.APP or not old["State"]["Running"] or not worker["State"]["Running"]:
            raise RuntimeError("DOCUMENTARY_WRITERS_CHANGED")
        stop(old["Id"], 60)
        if checked_container(old["Id"], record["oldImage"])["State"]["Running"]:
            raise RuntimeError("DOCUMENTARY_APP_NOT_STOPPED")
        (STATE / "active-sha").unlink(missing_ok=True)
        stop(worker["Id"], 240)
        worker = checked_worker(record)
        if worker["State"]["Running"] or worker["State"]["ExitCode"] != 0:
            raise RuntimeError("DOCUMENTARY_WORKER_NOT_DRAINED")
        if sql("SELECT count(*) FROM public.document_intakes WHERE state='extracting'") != "0":
            raise RuntimeError("DOCUMENTARY_OUTSTANDING_LEASE")
        baseline()

    def restore_before_migration(self, record):
        baseline()
        old = checked_container(record["oldId"], record["oldImage"])
        if old["Name"] != "/" + restart.APP:
            raise RuntimeError("DOCUMENTARY_OLD_NAME_CHANGED")
        compatibility.validate_previous(old)
        if not old["State"]["Running"]:
            run(["docker", "start", old["Id"]])
        restart.probe(restart.APP, record["oldRevision"])
        restart.write_active(STATE, record["oldRevision"])
        worker = checked_worker(record)
        if not worker["State"]["Running"]:
            if worker["State"]["ExitCode"] != 0 or sql("SELECT count(*) FROM document_intakes WHERE state='extracting'") != "0":
                raise RuntimeError("DOCUMENTARY_WORKER_REQUIRES_REVIEW")
            run(["docker", "start", worker["Id"]])

    def migrate(self, record):
        sql(installation.transaction(record["sourceSha"], record["imageId"]))

    def confirm_commit(self, record):
        if compatibility.schema_requirements() != compatibility.KNOWN_CAPABILITIES:
            raise RuntimeError("DOCUMENTARY_FINISH_REQUIRES_COMMITTED_SCHEMA")
        receipt = sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT sha256 FROM "
                      "mw_private.dev_migration_receipts WHERE path=" +
                      installation.literal(installation.PROPOSAL_PATH) + "; COMMIT;")
        if receipt != installation.PROPOSAL_SHA256:
            raise RuntimeError("DOCUMENTARY_FINISH_REQUIRES_RECEIPT")
        compatibility.validate_image(compatibility.inspect("image", record["imageId"]),
                                     record["sourceSha"], compatibility.KNOWN_CAPABILITIES)

    def activate(self, record):
        old = checked_container(record["oldId"], record["oldImage"])
        previous_name = PREVIOUS_PREFIX + record["operation"]
        if old["Name"] not in ("/" + restart.APP, "/" + previous_name):
            raise RuntimeError("DOCUMENTARY_OLD_NAME_CHANGED")
        networks = old["NetworkSettings"]["Networks"]
        if not set(networks) <= {restart.EDGE_NETWORK, restart.PRIVATE_NETWORK}:
            raise RuntimeError("DOCUMENTARY_OLD_NETWORK_CHANGED")
        if old["State"]["Running"]:
            stop(old["Id"], 60)
            raise RuntimeError("DOCUMENTARY_OLD_APP_RESTARTED_REVIEW")
        active = compatibility.inspect("container", restart.APP)
        if active and active["Id"] != old["Id"]:
            self.check_target(active, record)
        if old["Name"] == "/" + restart.APP:
            if compatibility.inspect("container", previous_name):
                raise RuntimeError("DOCUMENTARY_PREVIOUS_NAME_OCCUPIED")
            run(["docker", "rename", old["Id"], previous_name])
        for network in networks:
            run(["docker", "network", "disconnect", network, old["Id"]])
        active = compatibility.inspect("container", restart.APP)
        if active:
            self.check_target(active, record)
            # A crash during create/connect is not repaired by guessing networks.
            if set(active["NetworkSettings"]["Networks"]) != {restart.EDGE_NETWORK, restart.PRIVATE_NETWORK}:
                raise RuntimeError("DOCUMENTARY_TARGET_NETWORK_REQUIRES_REVIEW")
            if not active["State"]["Running"]:
                run(["docker", "start", active["Id"]])
        else:
            restart.launch(restart.APP, record["imageId"], operation_id=record["operation"])
        try:
            restart.probe(restart.APP, record["sourceSha"])
        except Exception:
            active = compatibility.inspect("container", restart.APP)
            if active:
                self.check_target(active, record)
                stop(active["Id"], 60)
                (STATE / "active-sha").unlink(missing_ok=True)
            raise
        restart.write_active(STATE, record["sourceSha"])

    def check_target(self, container, record):
        compatibility.owned(container)
        if (container["Image"] != record["imageId"] or
                (container["Config"].get("Labels") or {}).get("mw.dev-transition") != record["operation"]):
            raise RuntimeError("DOCUMENTARY_TARGET_REQUIRES_REVIEW")

    def resume_worker(self, record):
        active = compatibility.inspect("container", restart.APP)
        if not active:
            raise RuntimeError("DOCUMENTARY_READY_APP_REQUIRED")
        self.check_target(active, record)
        restart.probe(restart.APP, record["sourceSha"])
        worker = checked_worker(record)
        if not worker["State"]["Running"]:
            if worker["State"]["ExitCode"] != 0 or sql("SELECT count(*) FROM document_intakes WHERE state='extracting'") != "0":
                raise RuntimeError("DOCUMENTARY_WORKER_REQUIRES_REVIEW")
            run(["docker", "start", worker["Id"]])
        time.sleep(1)
        if not checked_worker(record)["State"]["Running"]:
            raise RuntimeError("DOCUMENTARY_WORKER_NOT_RUNNING")


def prepare(sha):
    baseline()
    image_id = compatibility.validate_image(compatibility.inspect("image", "masterweld-dev:" + sha),
                                            sha, compatibility.KNOWN_CAPABILITIES)
    old = compatibility.inspect("container", restart.APP)
    compatibility.owned(old)
    if not old["State"]["Running"]:
        raise RuntimeError("DOCUMENTARY_ACTIVE_APP_REQUIRED")
    if set(old["NetworkSettings"]["Networks"]) != {restart.EDGE_NETWORK, restart.PRIVATE_NETWORK}:
        raise RuntimeError("DOCUMENTARY_OLD_NETWORK_CHANGED")
    old_revision = compatibility.validate_previous(old)
    worker = compatibility.inspect("container", WORKER)
    compatibility.owned(worker)
    record = {"version": 1, "phase": "prepared", "operation": uuid.uuid4().hex,
              "sourceSha": sha, "imageId": image_id, "oldId": old["Id"], "oldImage": old["Image"],
              "oldRevision": old_revision, "workerId": worker["Id"], "workerImage": worker["Image"]}
    check_record(record)
    if not checked_worker(record)["State"]["Running"]:
        raise RuntimeError("DOCUMENTARY_RUNNING_WORKER_REQUIRED")
    rehearsal = json.loads(run(["python3", str(ROOT / "ops/tests/source-fact-review.py"),
                                "--documentary-conditions"], cwd=ROOT, timeout=900).stdout)
    if rehearsal.get("ok") is not True or rehearsal.get("documentary_conditions", {}).get("proposal_sha256") != installation.PROPOSAL_SHA256:
        raise RuntimeError("DOCUMENTARY_REHEARSAL_REQUIRED")
    if revision() != sha:
        raise RuntimeError("DOCUMENTARY_SOURCE_CHANGED")
    restart.preflight_image(image_id, sha)
    baseline()
    persist(record, "prepared", create=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Read schema and transition journal only")
    mode.add_argument("--apply", metavar="FULL_SHA", help="Reviewed first install; refuses any existing journal")
    mode.add_argument("--finish", metavar="FULL_SHA", help="Finish only an already committed migration; never repeat SQL")
    args = parser.parse_args()
    os.umask(0o077)
    if args.check:
        record = check_record(json.loads(JOURNAL.read_text())) if JOURNAL.exists() else None
        print(json.dumps({"requiredCapabilities": sorted(compatibility.schema_requirements()), "transition": record}))
        return
    sha = args.apply or args.finish
    if revision() != sha:
        raise RuntimeError("DOCUMENTARY_EXACT_COMMITTED_SOURCE_REQUIRED")
    installation.load_proposal()
    with (STATE / "update.lock").open("a") as app_lock, (STATE / "document-parser-update.lock").open("a") as parser_lock:
        fcntl.flock(app_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(parser_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            if JOURNAL.exists():
                raise RuntimeError("DOCUMENTARY_JOURNAL_EXISTS_USE_CHECK")
            record = prepare(sha)
        else:
            record = check_record(json.loads(JOURNAL.read_text()))
            if record["sourceSha"] != sha:
                raise RuntimeError("DOCUMENTARY_JOURNAL_REVISION_MISMATCH")
        print(json.dumps(documentary_transition.execute(Adapter(), record, apply=bool(args.apply))))


if __name__ == "__main__":
    main()
