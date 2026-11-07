#!/usr/bin/env python3
"""Read-only investigation by the checkout code; no buyer contacts or secret output."""
import json, subprocess, sys, uuid
attempt=str(uuid.UUID(sys.argv[1])) if len(sys.argv)==2 else None
if not attempt: raise SystemExit("Usage: python3 ops/dev/order-attempt.py <request UUID>")
def sql(query):
    return subprocess.check_output(["docker","exec","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-X","-Atc",query],text=True).strip()
assert json.loads(sql("SELECT public.mw_environment_identity()"))=={"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
result=sql(f"SELECT json_build_object('requestId',s.request_id,'orderNumber',s.result->>'number','outcome',s.result->>'code','accepted',s.result->'ok','status',o.status) FROM order_submissions s LEFT JOIN shop_orders o ON o.id=s.order_id WHERE s.request_id='{attempt}'::uuid")
print(result or json.dumps({"requestId":attempt,"result":"Пока нет сохранённого результата. Это не доказательство отсутствия выполняющегося запроса."},ensure_ascii=False))
