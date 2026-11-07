#!/usr/bin/env python3
"""Compose an inactive production candidate from existing private credentials. No deployment."""
import json
import os
import stat

from preflight import ROOT, BOT_KEYS, DATABASE_KEYS, configuration_errors, read_env


def compose(database, bots, dev, build):
    if set(database) != set(DATABASE_KEYS) or set(bots) != set(BOT_KEYS):
        raise ValueError("SOURCE_KEYS_REQUIRE_REVIEW")
    env = {**database, **bots, "ORDER_NOTIFICATIONS_ENABLED": "false"}
    errors = configuration_errors(env, dev)
    if errors:
        raise ValueError("CONFIGURATION_INVALID:" + ",".join(errors))
    if (build.get("VITE_APP_ENV") != "production"
            or build.get("VITE_SUPABASE_PROJECT_ID") != "mw-production"
            or build.get("VITE_SUPABASE_URL") != env["PUBLIC_ORIGIN"] + "/backend"
            or build.get("VITE_SUPABASE_PUBLISHABLE_KEY") != env["SUPABASE_PUBLISHABLE_KEY"]):
        raise ValueError("PRODUCTION_BUILD_CONFIGURATION_MISMATCH")
    return env


def save_candidate(path, env):
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("PRIVATE_DIRECTORY_REQUIRED")
    if path.exists() or path.is_symlink():
        if read_env(path) != env:
            raise ValueError("EXISTING_CANDIDATE_CONFLICT")
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write("# INACTIVE CANDIDATE. Never mounted or installed by this command.\n")
        stream.write("".join(key + "=" + value + "\n" for key, value in env.items()))
        stream.flush()
        os.fsync(stream.fileno())
    return True


def main():
    folder = ROOT / "ops/.secrets/production"
    try:
        env = compose(read_env(folder / "database.env"), read_env(folder / "bots.env"),
                      read_env(ROOT / "ops/.secrets/dev/app.env"), read_env(folder / "build-public.env"))
        created = save_candidate(folder / "shop.env.candidate", env)
    except ValueError as error:
        # compose/save errors contain fixed codes and key names only, never values.
        print(json.dumps({"created": False, "error": str(error)}))
        return 1
    except OSError:
        print(json.dumps({"created": False, "error": "PRIVATE_CONFIGURATION_IO_ERROR"}))
        return 1
    print(json.dumps({"created": created, "candidate": "ops/.secrets/production/shop.env.candidate",
                      "active": False, "deployment": False, "webhooksChanged": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
