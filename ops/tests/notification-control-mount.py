#!/usr/bin/env python3
"""Exercise the built activation guard in two isolated containers. No app startup, database, tokens or Telegram."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import uuid

if len(sys.argv) != 2 or not re.fullmatch(r"masterweld-dev:[0-9a-f]{40}", sys.argv[1]):
    raise SystemExit("Supply the exact built DEV image")
image = sys.argv[1]


def run(args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


labels = json.loads(run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image]).stdout)
if labels.get("mw.environment") != "dev" or labels.get("org.opencontainers.image.revision") != image.split(":")[1]:
    raise SystemExit("DEV_IMAGE_REQUIRED")
names = []
shas = {"a": "a" * 40, "b": "b" * 40}

with tempfile.TemporaryDirectory(prefix="mw-worker-mount-") as temp:
    directory = pathlib.Path(temp)
    directory.chmod(0o755)
    control = directory / "active.json"

    def activate(slot):
        target = directory / ".next"
        target.write_text(json.dumps({"slot": slot, "sha": shas[slot]} if slot else {}))
        target.chmod(0o644)
        os.replace(target, control)

    def active(name):
        code = "import('/app/.output/order-notifications.mjs').then(m=>console.log(m.notificationWorkerActive(process.env)))"
        return run(["docker", "exec", name, "node", "--input-type=module", "-e", code]).stdout.strip() == "true"

    activate(None)
    try:
        for slot in ("a", "b"):
            name = "mw-worker-mount-" + uuid.uuid4().hex[:12]
            names.append(name)
            args = ["docker", "run", "-d", "--name", name, "--network", "none", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "--mount", f"type=bind,source={directory},target=/run/mw-workers,readonly"]
            fixture = {
                "APP_ENV": "production", "ORDER_NOTIFICATIONS_ENABLED": "true",
                "TELEGRAM_ENABLED": "true", "TELEGRAM_TRANSPORT": "direct",
                "TELEGRAM_BOT_ID": "8861999166", "TELEGRAM_BOT_USERNAME": "masterweldermanagerbot",
                "TELEGRAM_BOT_TOKEN": "8861999166:synthetic_not_a_secret_1234567890",
                "PUBLIC_ORIGIN": "https://shop.masterweld.ru", "SUPABASE_URL": "http://mw-prod-api:8080",
                "MW_INSTANCE_ID": "11111111-1111-4111-8111-111111111111",
                "RELEASE_SHA": shas[slot], "MW_RELEASE_SLOT": slot,
            }
            for key, value in fixture.items():
                args += ["--env", key + "=" + value]
            args += ["--entrypoint", "node", image, "-e", "setInterval(()=>{},1000)"]
            run(args)
        assert [active(n) for n in names] == [False, False]
        activate("a")
        assert [active(n) for n in names] == [True, False]
        activate(None)
        assert [active(n) for n in names] == [False, False]
        activate("b")
        assert [active(n) for n in names] == [False, True]
        run(["docker", "restart", names[0]])
        assert [active(n) for n in names] == [False, True]
        activate("a")
        assert [active(n) for n in names] == [True, False]
        # The application cannot grant itself permission.
        write = run(["docker", "exec", names[1], "node", "-e",
                     "require('fs').writeFileSync('/run/mw-workers/active.json','{}')"], check=False)
        assert write.returncode != 0 and [active(n) for n in names] == [True, False]
        control.unlink()
        assert [active(n) for n in names] == [False, False]
        print(json.dumps({"sha": image.split(":")[1], "realReadOnlyMount": True,
                          "atomicSwitchVisible": True, "rollbackVisible": True,
                          "oldRestartInactive": True, "missingControlPauses": True,
                          "network": "none", "telegramSent": False}))
    finally:
        for name in names:
            run(["docker", "rm", "-f", name], check=False)
