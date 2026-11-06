#!/usr/bin/env python3
"""DEV-only durable intake worker; deliberately no Telegram transport or enrichment provider."""
import base64
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time
import urllib.request

stopping=False
def stop(*_):
    global stopping
    stopping=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_):
        return None


def rpc(name,payload):
    request=urllib.request.Request(os.environ["SUPABASE_URL"]+"/rest/v1/rpc/"+name,
        data=json.dumps(payload).encode(),headers={
         "apikey":os.environ["SUPABASE_SERVICE_ROLE_KEY"],
         "Authorization":"Bearer "+os.environ["SUPABASE_SERVICE_ROLE_KEY"],
         "Content-Type":"application/json"})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response:
        data=response.read(8500001)
        if len(data)>8500000:
            raise ValueError("RESPONSE_LIMIT")
        return json.loads(data)


def verify():
    manifest=json.loads(pathlib.Path("/worker/manifest.json").read_text())
    if manifest!={"environment":"dev","revision":os.environ.get("RELEASE_SHA")}:
        raise ValueError("BUILD_IDENTITY_MISMATCH")
    if os.environ.get("APP_ENV")!="dev" or os.environ.get("SUPABASE_URL")!="http://mw-dev-gateway:8080":
        raise ValueError("DEV_REQUIRED")
    if rpc("mw_environment_identity",{})!={"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}:
        raise ValueError("IDENTITY_MISMATCH")


def once():
    verify()
    job=rpc("document_worker",{"p_op":"claim"})
    if job.get("idle"):
        return
    original=base64.b64decode(job["base64"])
    if hashlib.sha256(original).hexdigest()!=job["checksum"]:
        raise ValueError("SOURCE_CHECKSUM")
    try:
        request=urllib.request.Request("http://mw-dev-document-parser:8090/extract",
          data=json.dumps({"base64":base64.b64encode(original).decode(),"file_name":job["file_name"]}).encode(),
          headers={"Content-Type":"application/json"})
        with urllib.request.build_opener(NoRedirect).open(request,timeout=200) as response:
            data=response.read(5000001)
        if len(data)>5000000:
            raise ValueError("RESULT_LIMIT")
        result=json.loads(data)
        if result.get("sha256")!=job["checksum"]:
            raise ValueError("RESULT_CHECKSUM")
    except Exception:
        rpc("document_worker",{"p_op":"fail","p_id":job["id"],"p_lease":job["lease"]})
        print("document extraction failed; original retained",flush=True)
        return
    # An uncertain finish is not rerun. Stale leases become failed, original remains reviewable.
    rpc("document_worker",{"p_op":"finish","p_id":job["id"],"p_lease":job["lease"],"p_result":result})
    print("document extraction saved for human review",flush=True)


if __name__=="__main__":
    verify()
    while not stopping:
        try:
            once()
        except Exception:
            print("document worker requires review; no automatic mutation replay",flush=True)
        for _ in range(10):
            if stopping: break
            time.sleep(1)
