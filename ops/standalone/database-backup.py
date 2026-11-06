#!/usr/bin/env python3
"""Verified standalone DB backups. Restore always uses a new offline container."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid
from datetime import datetime, timezone

PROJECT = Path("/home/codex/projects/masterweld.ru")
IMAGE = "postgres:17.6-alpine"
BRIDGE = Path("/home/codex/.local/bin/yadisk_cli.py")
REMOTE = "disk:/Мастер Сварщик — резервные копии"
DEV_ID = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
FILES = {"database.dump", "roles.sql", "manifest.json", "restore.py", "README.txt"}
LIMIT = 5 * 1024**3


def require(value, code):
    if not value:
        raise RuntimeError(code)


def run(args, *, input=None, stdout=None, timeout=600):
    result = subprocess.run(args, input=input, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, "BACKUP_COMMAND_FAILED")
    return result.stdout


def private(path, directory=False):
    info = path.lstat()
    require(not path.is_symlink() and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),
            "BACKUP_PRIVATE_PATH_REQUIRED")


def directory(path):
    if not path.exists():
        path.mkdir(mode=0o700)
    private(path, True)
    return path


def write(path, payload):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def sql_args(container, db):
    return ["docker", "exec", "-i", container, "psql", "-X", "-U", "postgres",
            "-d", db, "-Atq", "-v", "ON_ERROR_STOP=1"]


def sql(container, db, query, snapshot=None):
    if snapshot:
        require(re.fullmatch(r"[0-9A-Fa-f-]+", snapshot), "BACKUP_SNAPSHOT_INVALID")
        query = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + snapshot + "';\n" + query + "\nROLLBACK;"
    return run(sql_args(container, db), input=query.encode()).decode().strip()


def inspect(container):
    return json.loads(run(["docker", "inspect", container]))[0]


def validate_source(container, db, expected):
    info = inspect(container)
    require(info["State"]["Running"] and info["Config"]["Labels"].get("mw.environment") == expected["environment"],
            "BACKUP_SOURCE_LABEL_MISMATCH")
    actual = json.loads(sql(container, db, "SELECT mw_environment_identity();"))
    require(actual == expected, "BACKUP_SOURCE_IDENTITY_MISMATCH")


@contextlib.contextmanager
def snapshot_session(container, db, expected):
    process = subprocess.Popen(sql_args(container, db), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
                            b"SET LOCAL idle_in_transaction_session_timeout='15min';\n"
                            b"SELECT jsonb_build_object('snapshot',pg_export_snapshot(),'identity',mw_environment_identity(),'time',now());\n")
        process.stdin.flush()
        require(select.select([process.stdout], [], [], 30)[0], "BACKUP_SNAPSHOT_TIMEOUT")
        line = process.stdout.readline()
        require(line, "BACKUP_SNAPSHOT_FAILED")
        result = json.loads(line)
        require(result["identity"] == expected, "BACKUP_SNAPSHOT_IDENTITY_MISMATCH")
        require(re.fullmatch(r"[0-9A-Fa-f-]+", result["snapshot"]), "BACKUP_SNAPSHOT_INVALID")
        yield result
    finally:
        if process.poll() is None:
            try:
                process.communicate(b"ROLLBACK;\n", timeout=10)
            except (subprocess.TimeoutExpired, BrokenPipeError):
                process.kill()
                process.communicate()


def fingerprints(container, db, snapshot=None):
    names = json.loads(sql(container, db, """SELECT coalesce(jsonb_agg(s ORDER BY s->>'schema',s->>'table'),'[]') FROM (
      SELECT jsonb_build_object('schema',schemaname,'table',tablename) s FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%'
    ) q;""", snapshot))
    queries = []
    for item in names:
        schema, table = item["schema"], item["table"]
        require(re.fullmatch(r"[a-z_][a-z0-9_]*", schema) and re.fullmatch(r"[a-z_][a-z0-9_]*", table),
                "BACKUP_UNSUPPORTED_IDENTIFIER")
        queries.append("SELECT '" + schema + "." + table + "' AS name,count(*) AS rows,"
                       "md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash "
                       'FROM "' + schema + '"."' + table + '" t')
    require(queries, "BACKUP_NO_TABLES")
    return json.loads(sql(container, db,
        "SELECT jsonb_object_agg(name,jsonb_build_object('rows',rows,'hash',hash)) FROM (" +
        " UNION ALL ".join(queries) + ") q;", snapshot))


def security(container, db, snapshot=None):
    # OIDs differ after restore; compare stable names, definitions, RLS and ACLs.
    return json.loads(sql(container, db, """SELECT jsonb_build_object(
      'tables',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text)
        ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p','v','S') AND n.nspname IN ('public','mw_private')),
      'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),
        p.proacl::text,pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','mw_private') AND p.prokind='f'),
      'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname)
        FROM pg_policies p WHERE schemaname IN ('public','mw_private')));""", snapshot))


def make_archive(folder, manifest):
    content = folder / "content"
    write(content / "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
    archive = folder / "database.tar.gz"
    with archive.open("xb") as out:
        os.chmod(archive, 0o600)
        with tarfile.open(fileobj=out, mode="w:gz") as tar:
            for name in sorted(FILES):
                tar.add(content / name, arcname=name, recursive=False)
    return archive


def unpack(archive, target):
    private(archive)
    require(archive.stat().st_size <= LIMIT, "BACKUP_ARCHIVE_TOO_LARGE")
    directory(target)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        require(len(members) == len(FILES) and {m.name for m in members} == FILES
                and all(m.isfile() and not m.issym() and not m.islnk() and 0 <= m.size <= LIMIT for m in members)
                and sum(m.size for m in members) <= LIMIT, "BACKUP_ARCHIVE_MEMBERS_INVALID")
        for item in members:
            with tar.extractfile(item) as source:
                fd = os.open(target / item.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out:
                    shutil.copyfileobj(source, out)
    manifest = json.loads((target / "manifest.json").read_text())
    require(manifest.get("format") == "masterweld-database-backup-v1"
            and set(manifest.get("files", {})) == FILES - {"manifest.json"}, "BACKUP_MANIFEST_INVALID")
    for name, entry in manifest["files"].items():
        require(entry == {"bytes": (target / name).stat().st_size, "sha256": digest(target / name)},
                "BACKUP_FILE_HASH_MISMATCH")
    return manifest


def ready(container):
    for _ in range(120):
        result = subprocess.run(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode == 0:
            return
        time.sleep(.25)
    raise RuntimeError("BACKUP_RESTORE_NOT_READY")


def restore(archive, folder):
    manifest = unpack(archive, directory(folder) / "extracted")
    # No source container/database argument exists for restore.
    run(["docker", "image", "inspect", IMAGE])
    name = "mw-backup-restore-" + uuid.uuid4().hex[:12]
    created = False
    try:
        run(["docker", "run", "-d", "--name", name, "--network", "none",
             "--label", "mw.environment=qa", "--label", "mw.purpose=backup-restore",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=recovery", IMAGE])
        created = True
        info = inspect(name)
        require(info["HostConfig"]["NetworkMode"] == "none" and not info["HostConfig"]["PortBindings"],
                "BACKUP_RESTORE_NOT_ISOLATED")
        ready(name)
        roles = (folder / "extracted/roles.sql").read_bytes()
        roles, count = re.subn(rb"(?m)^CREATE ROLE postgres;\r?$", b"", roles)
        require(count == 1, "BACKUP_ROLES_INVALID")
        sql(name, "recovery", roles.decode())
        with (folder / "extracted/database.dump").open("rb") as stream:
            result = subprocess.run(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", "recovery",
                                     "--exit-on-error", "--single-transaction"], stdin=stream,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
        require(result.returncode == 0, "BACKUP_RESTORE_FAILED")
        for attempt in range(2):
            require(json.loads(sql(name, "recovery", "SELECT mw_environment_identity();")) == manifest["identity"],
                    "BACKUP_RESTORED_IDENTITY_MISMATCH")
            require(fingerprints(name, "recovery") == manifest["tables"], "BACKUP_RESTORED_ROWS_MISMATCH")
            require(security(name, "recovery") == manifest["security"], "BACKUP_RESTORED_SECURITY_MISMATCH")
            if attempt == 0:
                run(["docker", "restart", name])
                ready(name)
        result = {"restored": True, "restartVerified": True, "tableCount": len(manifest["tables"]),
                  "allTableFingerprintsMatch": True, "securityMatches": True,
                  "identity": manifest["identity"], "snapshotTime": manifest["snapshotTime"],
                  "archiveSha256": digest(archive), "network": "none", "ports": []}
    finally:
        if created:
            run(["docker", "rm", "-fv", name])
    result["temporaryContainerRemoved"] = True
    write(folder / "report.json", (json.dumps(result, indent=2) + "\n").encode())
    return result


def bridge(*args):
    # Provider stderr may contain signed links; never copy it into status/journal.
    return json.loads(run([sys.executable, str(BRIDGE), *map(str, args)], timeout=900))


def offsite(archive, folder, environment, stamp):
    remote_folder = REMOTE + "/" + environment.upper() + "_database_" + stamp
    bridge("mkdir", remote_folder)
    remote_archive = remote_folder + "/database.tar.gz"
    bridge("upload", archive, remote_archive)
    downloaded = folder / "downloaded.tar.gz"
    bridge("download", remote_archive, downloaded)
    private(downloaded)
    require(digest(downloaded) == digest(archive), "BACKUP_DOWNLOAD_HASH_MISMATCH")
    verified = restore(downloaded, folder / "offsite-restore")
    result = {"remote": remote_archive, "downloadSha256": digest(downloaded), "restore": verified}
    write(folder / "offsite-result.json", (json.dumps(result, indent=2) + "\n").encode())
    bridge("upload", folder / "offsite-result.json", remote_folder + "/verification.json")
    return result


def backup(root, environment, upload=False):
    require(root == PROJECT and root.resolve() == root, "BACKUP_PROJECT_PATH_REFUSED")
    require(environment in ("dev", "production"), "BACKUP_ENVIRONMENT_REFUSED")
    os.umask(0o077)
    state = root / "ops/.state"
    info = state.lstat()
    require(not state.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o022, "BACKUP_STATE_PATH_UNSAFE")
    base = directory(directory(state / "database-backups") / environment)
    lock_path = base / "backup.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        private(lock_path)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("BACKUP_ALREADY_RUNNING") from None
        require(shutil.disk_usage(base).free > 1024**3, "BACKUP_DISK_SPACE_LOW")
        if environment == "dev":
            expected, container, db = DEV_ID, "mw-dev-db", "masterweld_dev"
        else:
            config = root / "ops/.secrets/production/database.env"
            private(config)
            values = re.findall(r"^MW_INSTANCE_ID=([0-9a-f-]+)$", config.read_text(), re.M)
            require(len(values) == 1 and str(uuid.UUID(values[0])) == values[0], "BACKUP_PRODUCTION_ID_MISSING")
            expected = {"environment": "production", "instanceId": values[0]}
            container, db = "mw-prod-db", "masterweld_production"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        folder = directory(base / stamp)
        content = directory(folder / "content")
        status = {"environment": environment, "run": stamp, "complete": False}
        try:
            validate_source(container, db, expected)
            with snapshot_session(container, db, expected) as snap:
                tables = fingerprints(container, db, snap["snapshot"])
                acl = security(container, db, snap["snapshot"])
                fd = os.open(content / "database.dump", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out:
                    run(["docker", "exec", container, "pg_dump", "-U", "postgres", "-d", db, "-Fc",
                         "--snapshot=" + snap["snapshot"], "--lock-wait-timeout=10s"], stdout=out)
            write(content / "roles.sql", run(["docker", "exec", container, "pg_dumpall", "-U", "postgres",
                                              "--roles-only", "--no-role-passwords"]))
            write(content / "restore.py", Path(__file__).read_bytes())
            write(content / "README.txt", (
                "Закрытая копия самостоятельной базы " + environment.upper() + ".\n"
                "Содержит прикладные данные, права и функции. Не содержит файлы изображений, пароли, токены, конфигурацию приложения.\n"
                "Сначала сверить SHA-256 архива по внешнему отчёту. Не распаковывать поверх проекта.\n"
                "Проверка: python3 restore.py restore /полный/путь/database.tar.gz --output /новая/закрытая/папка\n"
                "Нужны Python 3.10+, Docker и локальный postgres:17.6-alpine. Восстановление только в новый контейнер без сети.\n"
                "Восстановленная база не запускается приложением. Не сбрасывать состояния уведомлений для повторной отправки.\n"
            ).encode())
            manifest = {"format": "masterweld-database-backup-v1", "identity": expected,
                        "snapshotTime": snap["time"], "tables": tables, "security": acl,
                        "scope": "Full standalone database; no media bytes, passwords, tokens or app configuration.",
                        "files": {name: {"bytes": (content / name).stat().st_size, "sha256": digest(content / name)}
                                  for name in FILES - {"manifest.json"}}}
            archive = make_archive(folder, manifest)
            local = restore(archive, folder / "local-restore")
            external = offsite(archive, folder, environment, stamp) if upload else None
            status.update(complete=True, snapshotTime=snap["time"], archiveSha256=digest(archive),
                          archiveBytes=archive.stat().st_size, localRestore=local,
                          offsite=external, scope=manifest["scope"])
        except Exception as error:
            status["error"] = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z_]+", str(error)) else "BACKUP_FAILED"
            raise
        finally:
            write(folder / "status.json", (json.dumps(status, indent=2) + "\n").encode())
            temporary = base / ("latest-" + uuid.uuid4().hex + ".json")
            write(temporary, (json.dumps(status, indent=2) + "\n").encode())
            os.replace(temporary, base / "latest.json")
    return status


def status(environment):
    base = PROJECT / "ops/.state/database-backups" / environment
    private(base, True)
    path = base / "latest.json"
    private(path)
    report = json.loads(path.read_text())
    require(report.get("environment") == environment, "BACKUP_STATUS_ENVIRONMENT_MISMATCH")
    snapshot_time = report.get("snapshotTime")
    age = None
    if snapshot_time:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(snapshot_time)).total_seconds()
    external = report.get("offsite") or {}
    healthy = (report.get("complete") is True and external.get("restore", {}).get("restored") is True
               and age is not None and 0 <= age <= 26 * 3600)
    return {"environment": environment, "healthy": healthy, "lastRun": report.get("run"),
            "snapshotTime": snapshot_time, "ageHours": round(age / 3600, 2) if age is not None else None,
            "error": report.get("error"), "remote": (report.get("offsite") or {}).get("remote"),
            "scope": "Database only; media files and app secrets are excluded."}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    take = commands.add_parser("backup")
    take.add_argument("environment", choices=["dev", "production"])
    take.add_argument("--offsite", action="store_true")
    check = commands.add_parser("restore")
    check.add_argument("archive", type=Path)
    check.add_argument("--output", type=Path, required=True)
    health = commands.add_parser("status")
    health.add_argument("environment", choices=["dev", "production"])
    args = parser.parse_args()
    if args.command == "status":
        result = status(args.environment)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["healthy"] else 1
    if args.command == "restore":
        require(not args.output.exists() and not args.output.is_symlink(), "BACKUP_RESTORE_OUTPUT_EXISTS")
        result = restore(args.archive.absolute(), args.output.absolute())
    else:
        result = backup(PROJECT, args.environment, args.offsite)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z_]+", str(error)) else "BACKUP_FAILED"
        print(json.dumps({"complete": False, "error": code}))
        raise SystemExit(1)
