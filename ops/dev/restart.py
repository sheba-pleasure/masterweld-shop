#!/usr/bin/env python3
"""Replace only DEV, probing the image first and refusing incompatible fallback."""
import fcntl
import os
import pathlib
import re
import subprocess
import sys
import time

from app_compatibility import inspect, owned, schema_requirements, validate_image, validate_previous

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = "mw-dev-app"
PREVIOUS = "mw-dev-previous"
CANDIDATE = "mw-dev-candidate"
EDGE_NETWORK = "mw-dev-edge"
PRIVATE_NETWORK = "mw-dev-private"
PROBE_ATTEMPTS = 40


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=90, **kwargs)


def probe(name, sha):
    script = """
const expected = process.argv[1];
fetch('http://127.0.0.1:3000/api/public/release-health', {signal: AbortSignal.timeout(3000)})
 .then(async response => {
  const result = await response.json();
  if (!response.ok || result.ready !== true || result.environment !== 'dev' || result.revision !== expected) process.exit(1);
  const page = await fetch('http://127.0.0.1:3000/', {signal: AbortSignal.timeout(3000)});
  process.exit(page.ok && (await page.text()).includes('Тестовый магазин') ? 0 : 1);
 }).catch(() => process.exit(1));
"""
    for _ in range(PROBE_ATTEMPTS):
        result = subprocess.run(
            ["docker", "exec", name, "node", "-e", script, sha],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("DEV_HEALTH_FAILED")


def launch(name, image_id, preflight=False, operation_id=None):
    if operation_id is not None and not re.fullmatch('[0-9a-f]{32}', operation_id):
        raise RuntimeError('DEV_OPERATION_ID_REQUIRED')
    args = ["docker", "create", "--name", name, "--label", "mw.environment=dev",
            "--restart", "no" if preflight else "unless-stopped",
            "--network", EDGE_NETWORK, "--env-file", str(ROOT / "ops/.secrets/dev/app.env")]
    if operation_id is not None:
        args += ['--label', 'mw.dev-transition=' + operation_id]
    # Candidate has no public upstream alias/port. Verify normal startup guards,
    # but never start a second notification worker during the preflight.
    if preflight:
        args += ["--env", "ORDER_NOTIFICATIONS_ENABLED=false"]
    args += ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL",
             "--security-opt", "no-new-privileges", "--memory", "768m", "--pids-limit", "256", image_id]
    run(args, stdout=subprocess.DEVNULL)
    run(["docker", "network", "connect", PRIVATE_NETWORK, name])
    # Both DNS/network paths must exist before startup identity checks run.
    run(["docker", "start", name], stdout=subprocess.DEVNULL)


def remove_created(name, image_id):
    container = inspect("container", name)
    if container:
        owned(container)
        if container["Image"] != image_id:
            raise RuntimeError("DEV_CONTAINER_IMAGE_CHANGED")
        run(["docker", "rm", "-f", container["Id"]], stdout=subprocess.DEVNULL)


def preflight_image(image_id, sha):
    if inspect("container", CANDIDATE):
        raise RuntimeError("DEV_CANDIDATE_EXISTS_REQUIRES_REVIEW")
    try:
        launch(CANDIDATE, image_id, preflight=True)
        probe(CANDIDATE, sha)
    finally:
        remove_created(CANDIDATE, image_id)


def write_active(state, sha):
    temporary = state / "active-sha.next"
    temporary.write_text(sha + "\n")
    temporary.replace(state / "active-sha")


def restore(old, state):
    current = inspect("container", old["Id"])
    if not current:
        raise RuntimeError("DEV_PREVIOUS_CONTAINER_MISSING")
    # The initial stop may have failed without touching the active app.
    if current["State"]["Running"] and current["Name"] == "/" + APP:
        return
    revision = validate_previous(current)
    occupied = inspect("container", APP)
    if occupied and occupied["Id"] != old["Id"]:
        raise RuntimeError("DEV_ACTIVE_NAME_OCCUPIED")
    if current["Name"] != "/" + APP:
        run(["docker", "rename", old["Id"], APP])
    for network in old["NetworkSettings"]["Networks"]:
        if network not in current["NetworkSettings"]["Networks"]:
            run(["docker", "network", "connect", network, old["Id"]])
    run(["docker", "start", old["Id"]], stdout=subprocess.DEVNULL)
    probe(APP, revision)
    write_active(state, revision)


def replace(sha, state):
    info = inspect("image", "masterweld-dev:" + sha)
    image_id = validate_image(info, sha, schema_requirements())
    old = inspect("container", APP)
    previous = inspect("container", PREVIOUS)
    if old:
        owned(old)
    if previous:
        owned(previous)
        if not old or previous["State"]["Running"]:
            raise RuntimeError("DEV_PREVIOUS_REQUIRES_REVIEW")
    preflight_image(image_id, sha)

    # Re-read before touching running containers; migrations share update.lock.
    validate_image(info, sha, schema_requirements())
    if previous:
        run(["docker", "rm", previous["Id"]], stdout=subprocess.DEVNULL)
    new_started = False
    try:
        if old:
            run(["docker", "stop", old["Id"]], stdout=subprocess.DEVNULL)
            run(["docker", "rename", old["Id"], PREVIOUS])
            for network in old["NetworkSettings"]["Networks"]:
                run(["docker", "network", "disconnect", network, old["Id"]])
        new_started = True
        launch(APP, image_id)
        probe(APP, sha)
        write_active(state, sha)
    except Exception as failure:
        # Do not remove the old app when a stop/rename/disconnect failed.
        try:
            if new_started:
                remove_created(APP, image_id)
            if old:
                restore(old, state)
            else:
                (state / "active-sha").unlink(missing_ok=True)
        except Exception as recovery:
            (state / "active-sha").unlink(missing_ok=True)
            raise RuntimeError(
                "DEV_ROLLBACK_REQUIRES_REVIEW: Previous container retained; "
                "do not start an incompatible image or change database records"
            ) from recovery
        raise RuntimeError("DEV_REPLACEMENT_FAILED_PREVIOUS_RESTORED" if old else "DEV_REPLACEMENT_FAILED") from failure
    print("DEV active local commit: " + sha + "; database preserved.")


def main():
    os.umask(0o077)
    state = ROOT / "ops/.state/dev"
    state.mkdir(parents=True, exist_ok=True)
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sha = sys.argv[1] if len(sys.argv) == 2 else subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True,
        ).strip()
        if len(sys.argv) > 2 or not re.fullmatch("[0-9a-f]{40}", sha):
            raise RuntimeError("DEV_FULL_REVISION_REQUIRED")
        replace(sha, state)


if __name__ == "__main__":
    main()
