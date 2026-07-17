#!/usr/bin/env python3
"""elizaOS Live WASM demo server.

- Serves docs/ (also the GitHub Pages root) with COOP/COEP (SharedArrayBuffer
  for xterm-pty).
- Reverse-proxies /v1/* to the local model server (127.0.0.1:8873) so the
  guest can reach it through the in-page fetch proxy without loopback
  ambiguity.
- /persist/<name>: GET/PUT blob store backing the greeter's Persistent
  Storage mode (encrypted tarballs of ~/.eliza).
- /server-info.json: advertises the LAN origin so a loopback-opened page
  can hop to a non-loopback origin.
"""
import http.server
import json
import os
import pathlib
import re
import socket
import sys
import urllib.request
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
HTDOCS = HERE / "docs"
PERSIST_DIR = HERE / "persist"
MODEL_UPSTREAM = os.environ.get("ELIZA_MODEL_UPSTREAM", "http://127.0.0.1:8873")
MAX_PERSIST_BYTES = 512 * 1024 * 1024
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HTDOCS), **kw)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- routing ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/v1/"):
            return self.proxy_model()
        if self.path == "/server-info.json":
            port = self.server.server_address[1]
            ip = lan_ip()
            body = json.dumps({"lan_origin": f"http://{ip}:{port}" if ip else None}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/persist/"):
            return self.persist_get()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/v1/"):
            return self.proxy_model()
        self.send_error(404)

    def do_PUT(self):
        if self.path.startswith("/persist/"):
            return self.persist_put()
        self.send_error(404)

    # ---- model reverse proxy ---------------------------------------------
    def proxy_model(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        url = MODEL_UPSTREAM + self.path
        req = urllib.request.Request(url, data=body, method=self.command)
        for h in ("Content-Type", "Authorization", "Accept"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            resp = e
        except OSError as e:
            self.send_error(502, f"model upstream unreachable: {e}")
            return
        data = resp.read()
        self.send_response(resp.status if hasattr(resp, "status") else resp.code)
        self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- persistence blobs -------------------------------------------------
    def _persist_path(self):
        name = self.path[len("/persist/"):]
        if not SAFE_NAME.match(name):
            self.send_error(400, "bad blob name")
            return None
        PERSIST_DIR.mkdir(exist_ok=True)
        return PERSIST_DIR / name

    def persist_get(self):
        p = self._persist_path()
        if p is None:
            return
        if not p.is_file():
            self.send_error(404)
            return
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def persist_put(self):
        p = self._persist_path()
        if p is None:
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_PERSIST_BYTES:
            self.send_error(413 if length > MAX_PERSIST_BYTES else 411)
            return
        remaining, chunks = length, []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        p.write_bytes(b"".join(chunks))
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    ip = lan_ip()
    print(f"elizaOS Live demo server: http://{ip or '127.0.0.1'}:{port}/  (model upstream: {MODEL_UPSTREAM})")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
