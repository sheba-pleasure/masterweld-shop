#!/usr/bin/env python3
"""Real isolated Docker/PG 0042/0043 transition. Apps/worker are synthetic; no Telegram."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/dev"))
import app_compatibility as gate
import documentary_transition as transition
import restart as app

spec = importlib.util.spec_from_file_location("documentary_apply", ROOT / "ops/dev/apply-documentary-conditions.py")
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)
PREFIX = "mw-doc-transition-qa-" + uuid.uuid4().hex[:12]
NETWORKS = [PREFIX + "-edge", PREFIX + "-private"]
CONTAINERS = []
IMAGES = []
CREATED_NETWORKS = []
CHECKS = []


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs)


def build(worker=False, documentary=False):
    sha = uuid.uuid4().hex + uuid.uuid4().hex[:8]
    tag = PREFIX + ":" + sha
    labels = {"mw.environment": "dev", "mw.test": PREFIX, "org.opencontainers.image.revision": sha,
              gate.CAPABILITY: "1"}
    if documentary:
        labels[gate.DOCUMENTARY_CAPABILITY] = "1"
        labels[gate.ACCESSORY_CAPABILITY] = "1"
    server = """
const http=require('node:http');
process.on('SIGTERM',()=>process.exit(0));
http.createServer((q,r)=>{
 if(q.url==='/api/public/release-health'){
  r.setHeader('Content-Type','application/json');
  r.end(JSON.stringify({ready:process.env.FAIL_READINESS!=='true',revision:process.env.RELEASE_SHA,environment:process.env.APP_ENV}));
 }else r.end('Тестовый магазин');
}).listen(3000,'0.0.0.0');
"""
    dockerfile = "FROM node:22-bookworm-slim\nLABEL " + " ".join(k+"="+json.dumps(v) for k,v in labels.items()) + "\n"
    dockerfile += "ENV RELEASE_SHA=" + sha + "\n"
    if worker:
        # Deliberate test worker: signal handling only, no parsing or database client.
        worker_script = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);"
        dockerfile += "RUN mkdir /worker && ln -s /usr/local/bin/node /usr/bin/python3\n"
        dockerfile += "COPY worker.py /worker/worker.py\n"
        cmd = ["/usr/bin/python3", "/worker/worker.py"]
    else:
        cmd = ["node", "-e", server]
    dockerfile += "USER node\nCMD " + json.dumps(cmd, ensure_ascii=False) + "\n"
    with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
        path = pathlib.Path(directory)
        (path/"Dockerfile").write_text(dockerfile)
        if worker:
            (path/"worker.py").write_text(worker_script)
        command(["docker","build","--network","none","-q","-t",tag,str(path)])
    IMAGES.append(tag)
    return sha,gate.inspect("image",tag)["Id"]


def start_database(name):
    command(["docker","run","-d","--name",name,"--network","none","--label","mw.environment=dev",
             "--label","mw.test="+PREFIX,"--tmpfs","/var/lib/postgresql/data:rw,size=256m",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","-e","POSTGRES_DB=masterweld_dev","postgres:17.6-alpine"])
    CONTAINERS.append(name)
    for _ in range(100):
        if subprocess.run(["docker","exec",name,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError("QA_DATABASE_NOT_READY")
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0041"]]
    op.sql("BEGIN;"+"\n".join(p.read_text() for p in paths)+"COMMIT;")
    op.sql((ROOT/"ops/dev/identity.sql").read_text())
    op.sql("CREATE TABLE mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());")
    op.baseline()


try:
    for network in NETWORKS:
        command(["docker","network","create","--internal","--label","mw.test="+PREFIX,network])
        CREATED_NETWORKS.append(network)
    old_sha,old_image=build()
    new_sha,new_image=build(documentary=True)
    _,worker_image=build(worker=True)
    for scenario in ("uncertain_commit","failed_readiness"):
        with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
            base=pathlib.Path(directory)
            app.ROOT=base
            app.APP=PREFIX+"-"+scenario+"-app"
            app.CANDIDATE=PREFIX+"-"+scenario+"-candidate"
            app.EDGE_NETWORK,app.PRIVATE_NETWORK=NETWORKS
            app.PROBE_ATTEMPTS=3
            op.STATE=base/"ops/.state/dev";op.STATE.mkdir(parents=True)
            op.JOURNAL=op.STATE/"transition.json"
            op.WORKER=PREFIX+"-"+scenario+"-worker"
            op.PREVIOUS_PREFIX=PREFIX+"-previous-"
            gate.DB_CONTAINER=PREFIX+"-"+scenario+"-db"
            env=base/"ops/.secrets/dev/app.env";env.parent.mkdir(parents=True)
            env.write_text("APP_ENV=dev\nORDER_NOTIFICATIONS_ENABLED=false\n")
            start_database(gate.DB_CONTAINER)
            app.launch(app.APP,old_image)
            CONTAINERS.append(app.APP)
            app.probe(app.APP,old_sha)
            app.write_active(op.STATE,old_sha)
            command(["docker","run","-d","--name",op.WORKER,"--network","none",
                     "--label","mw.environment=dev","--label","mw.test="+PREFIX,
                     "-e","APP_ENV=dev","-e","SUPABASE_URL=http://mw-dev-gateway:8080",worker_image])
            CONTAINERS.append(op.WORKER)
            worker=gate.inspect("container",op.WORKER)
            old=gate.inspect("container",app.APP)
            rec={"version":2,"phase":"prepared","operation":uuid.uuid4().hex,
                 "sourceSha":new_sha,"imageId":new_image,"oldId":old["Id"],"oldImage":old_image,
                 "oldRevision":old_sha,"workerId":worker["Id"],"workerImage":worker_image}
            previous=op.PREVIOUS_PREFIX+rec["operation"]
            CONTAINERS.append(previous)
            op.persist(rec,"prepared",create=True)
            adapter=op.Adapter()
            original_migrate=adapter.migrate
            writes=[]
            def migrate(value):
                writes.append(value["sourceSha"])
                original_migrate(value)
                if scenario=="uncertain_commit":
                    raise RuntimeError("Simulated lost response after real COMMIT")
            if scenario=="failed_readiness":
                env.write_text("APP_ENV=dev\nORDER_NOTIFICATIONS_ENABLED=false\nFAIL_READINESS=true\n")
            with patch.object(adapter,"migrate",side_effect=migrate):
                try:
                    transition.execute(adapter,rec,apply=True)
                except RuntimeError as error:
                    expected="COMMIT_REQUIRES_REVIEW" if scenario=="uncertain_commit" else "ACTIVATION_REQUIRES_REVIEW"
                    assert expected in str(error),str(error)
                else:
                    raise AssertionError("Expected transition refusal")
            assert writes==[new_sha]
            assert not (op.STATE/"active-sha").exists(), "Stopped app must not be recorded as active"
            assert not gate.inspect("container",old["Id"])["State"]["Running"]
            assert not gate.inspect("container",worker["Id"])["State"]["Running"]
            assert op.sql("SELECT count(*) FROM mw_private.dev_migration_receipts")=="2"
            assert gate.schema_requirements()==gate.KNOWN_CAPABILITIES
            # Disallow any migration call while a new process finishes the saved transition.
            saved=op.check_record(json.loads(op.JOURNAL.read_text()))
            if scenario=="failed_readiness":
                failed=gate.inspect("container",app.APP)
                assert failed["Image"]==new_image and not failed["State"]["Running"]
                assert failed["Config"]["Labels"]["mw.dev-transition"]==rec["operation"]
                command(["docker","rm",failed["Id"]])
                env.write_text("APP_ENV=dev\nORDER_NOTIFICATIONS_ENABLED=false\n")
            with patch.object(op.Adapter,"migrate",side_effect=AssertionError("Migration replay forbidden")):
                transition.execute(op.Adapter(),saved)
                transition.execute(op.Adapter(),op.check_record(json.loads(op.JOURNAL.read_text())))
            active=gate.inspect("container",app.APP)
            assert active["Image"]==new_image and active["State"]["Running"]
            assert active["Config"]["Labels"]["mw.dev-transition"]==rec["operation"]
            assert not gate.inspect("container",old["Id"])["State"]["Running"]
            assert not gate.inspect("container",old["Id"])["NetworkSettings"]["Networks"]
            assert gate.inspect("container",worker["Id"])["State"]["Running"]
            assert op.sql("SELECT count(*) FROM mw_private.dev_migration_receipts")=="2"
            assert (op.STATE/"active-sha").read_text().strip()==new_sha
            CHECKS.append(scenario+"_finish_without_replay")
            CHECKS.append(scenario+"_old_app_retained_stopped")
            CHECKS.append(scenario+"_worker_resumed_after_readiness")
    print(json.dumps({"ok":True,"checks":CHECKS,"realMigration":True,"syntheticAppsAndWorker":True,
                      "liveDevChanged":False,"telegramTransport":False}))
finally:
    for name in reversed(CONTAINERS):
        if not name.startswith(PREFIX):
            raise RuntimeError("QA_CLEANUP_PREFIX")
        current=gate.inspect("container",name)
        if current:
            command(["docker","rm","-f","-v",current["Id"]])
    for network in reversed(CREATED_NETWORKS):
        command(["docker","network","rm",network])
    for tag in reversed(IMAGES):
        command(["docker","image","rm",tag])
