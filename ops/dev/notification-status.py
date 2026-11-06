#!/usr/bin/env python3
"""Read-only status of notification delivery in the isolated DEV database."""
import json
import subprocess

BASE = ["docker", "exec", "mw-dev-db", "psql", "-U", "postgres",
        "-d", "masterweld_dev", "-X", "-v", "ON_ERROR_STOP=1"]
identity = json.loads(subprocess.check_output(
    BASE + ["-Atc", "SELECT public.mw_environment_identity()"], text=True))
if identity != {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}:
    raise SystemExit("Wrong database identity")
subprocess.run(BASE + ["-c", """
SELECT state, count(*) FROM public.order_notifications GROUP BY state ORDER BY state;
SELECT left(order_id::text,8) AS order_number, staff_telegram_id, state,
       attempts, reason, telegram_message_id
FROM public.order_notifications
WHERE state IN ('failed','uncertain') OR
      (state IN ('pending','sending') AND created_at < now()-interval '5 minutes')
ORDER BY created_at LIMIT 30;
"""], check=True)
issues = subprocess.check_output(BASE + ["-Atc", """
SELECT count(*) FROM public.order_notifications WHERE state IN ('failed','uncertain')
OR (state IN ('pending','sending') AND created_at < now()-interval '5 minutes');
"""], text=True).strip()
raise SystemExit(1 if int(issues) else 0)
