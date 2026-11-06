#!/usr/bin/env python3
"""Install ONLY the DEV backup user units from an exact committed runner. Does not start them."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path("/home/codex/projects/masterweld.ru")
USER_UNITS = Path("/home/codex/.config/systemd/user")
UNIT = "masterweld-dev-database-backup"


def require(value, code):
    if not value:
        raise RuntimeError(code)


def run(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=30)
    require(result.returncode == 0, "BACKUP_INSTALL_COMMAND_FAILED")
    return result.stdout


def identical_file(path, payload, previous=None):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid()
                and not info.st_mode & 0o022 and path.read_bytes() in [payload, previous],
                "BACKUP_INSTALL_EXISTING_FILE_CONFLICT")
        if path.read_bytes() == payload:
            return False
        temporary = path.with_name(path.name + ".new-" + str(os.getpid()))
        identical_file(temporary, payload)
        os.replace(temporary, path)
        return True
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return True


def units(runner):
    require(re.fullmatch(r"[a-zA-Z0-9/_.-]+", str(runner)), "BACKUP_RUNNER_PATH_INVALID")
    service = f"""[Unit]
Description=Masterweld DEV database backup and Yandex restore check

[Service]
Type=oneshot
WorkingDirectory={ROOT}
ExecStart=/usr/bin/python3 {runner} backup dev --offsite
UMask=0077
TimeoutStartSec=45min
Restart=no
Nice=10
StandardOutput=journal
StandardError=journal
"""
    timer = f"""[Unit]
Description=Daily Masterweld DEV database backup at 05:00 Moscow time

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
RandomizedDelaySec=5min
Persistent=true
Unit={UNIT}.service

[Install]
WantedBy=timers.target
"""
    return service.encode(), timer.encode()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace-runner", help="Exact previous installed commit; both own units must be inactive")
    args = parser.parse_args()
    require(os.getuid() == 1001 and Path.home() == Path("/home/codex"), "BACKUP_INSTALL_USER_REQUIRED")
    require(not run(["git", "status", "--porcelain"]), "BACKUP_INSTALL_COMMIT_SOURCE_FIRST")
    sha = run(["git", "rev-parse", "HEAD"]).decode().strip()
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "BACKUP_INSTALL_SOURCE_INVALID")
    payload = run(["git", "show", sha + ":ops/standalone/database-backup.py"])
    require(payload == (ROOT / "ops/standalone/database-backup.py").read_bytes(), "BACKUP_INSTALL_SOURCE_CHANGED")
    base = ROOT / "ops/.state/backup-runners"
    base.mkdir(mode=0o700, exist_ok=True)
    require(not base.is_symlink() and base.stat().st_uid == os.getuid() and not base.stat().st_mode & 0o077,
            "BACKUP_INSTALL_PRIVATE_DIRECTORY_REQUIRED")
    pinned = base / sha
    pinned.mkdir(mode=0o700, exist_ok=True)
    require(not pinned.is_symlink() and pinned.stat().st_uid == os.getuid() and not pinned.stat().st_mode & 0o077,
            "BACKUP_INSTALL_PRIVATE_DIRECTORY_REQUIRED")
    runner = pinned / "database-backup.py"
    service, timer = units(runner)
    previous_service = previous_timer = None
    if args.replace_runner:
        require(re.fullmatch(r"[0-9a-f]{40}", args.replace_runner), "BACKUP_PREVIOUS_SHA_INVALID")
        old_runner = base / args.replace_runner / "database-backup.py"
        old_source = run(["git", "show", args.replace_runner + ":ops/standalone/database-backup.py"])
        require(old_runner.is_file() and not old_runner.is_symlink() and old_runner.read_bytes() == old_source,
                "BACKUP_PREVIOUS_RUNNER_CHANGED")
        for suffix in ("service", "timer"):
            state = run(["systemctl", "--user", "show", UNIT + "." + suffix, "-p", "ActiveState", "--value"]).decode().strip()
            require(state in ("inactive", "failed"), "BACKUP_STOP_OWN_UNITS_BEFORE_UPDATE")
        previous_service, previous_timer = units(old_runner)
    # Validate both destinations before writing either unit. Never replace an existing different service.
    USER_UNITS.mkdir(parents=True, exist_ok=True)
    require(USER_UNITS.resolve() == USER_UNITS and USER_UNITS.stat().st_uid == os.getuid()
            and not USER_UNITS.stat().st_mode & 0o022, "BACKUP_INSTALL_UNITS_DIRECTORY_UNSAFE")
    for suffix, data, previous in [("service", service, previous_service), ("timer", timer, previous_timer)]:
        path = USER_UNITS / (UNIT + "." + suffix)
        if path.exists() or path.is_symlink():
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid()
                    and not info.st_mode & 0o022 and path.read_bytes() in [data, previous],
                    "BACKUP_INSTALL_EXISTING_FILE_CONFLICT")
    identical_file(runner, payload)
    identical_file(USER_UNITS / (UNIT + ".service"), service, previous_service)
    identical_file(USER_UNITS / (UNIT + ".timer"), timer, previous_timer)
    run(["systemd-analyze", "--user", "verify", str(USER_UNITS / (UNIT + ".service")), str(USER_UNITS / (UNIT + ".timer"))])
    run(["systemctl", "--user", "daemon-reload"])
    print(json.dumps({"installed": True, "started": False, "environment": "dev", "sourceSha": sha,
                      "runnerSha256": hashlib.sha256(payload).hexdigest(), "unit": UNIT,
                      "schedule": "02:00 UTC / 05:00 Moscow, random delay up to 5 minutes",
                      "retention": "No automatic deletion; all copies retained."}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z_]+", str(error)) else "BACKUP_INSTALL_FAILED"
        print(json.dumps({"installed": False, "error": code}))
        raise SystemExit(1)
