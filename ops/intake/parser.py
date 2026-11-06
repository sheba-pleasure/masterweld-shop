#!/usr/bin/env python3
"""Private-network parser. No database credentials, Telegram tokens, or public port."""
import base64
import json
import pathlib
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):
        pass
    def do_POST(self):
        self.connection.settimeout(210)
        try:
            size=int(self.headers.get("Content-Length","0"))
            if self.path!="/extract" or not 0<size<=7100000:
                raise ValueError()
            job=json.loads(self.rfile.read(size))
            original=base64.b64decode(job["base64"],validate=True)
            if not 0<len(original)<=5*1024*1024 or len(job["file_name"])>200:
                raise ValueError()
            with tempfile.TemporaryDirectory(prefix="mw-parser-") as directory:
                source=pathlib.Path(directory)/"original"
                source.write_bytes(original);source.chmod(0o400)
                out=pathlib.Path(directory)/"result.json"
                with out.open("wb") as output:
                    subprocess.run(["/usr/bin/python3","/worker/extract.py",str(source),job["file_name"]],
                      stdout=output,stderr=subprocess.DEVNULL,timeout=180,check=True,
                      env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8","TMPDIR":directory})
                if out.stat().st_size>5000000: raise ValueError()
                data=out.read_bytes()
                if "sha256" not in json.loads(data): raise ValueError()
            self.send_response(200)
        except Exception:
            data=b'{"error":"EXTRACTION_FAILED"}'
            self.send_response(422)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__=="__main__":
    if os.environ.get("APP_ENV")!="dev" or json.loads(pathlib.Path("/worker/manifest.json").read_text())!={"environment":"dev","revision":os.environ.get("RELEASE_SHA")}:
        raise SystemExit("BUILD_IDENTITY_MISMATCH")
    HTTPServer(("0.0.0.0",8090),Handler).serve_forever()
