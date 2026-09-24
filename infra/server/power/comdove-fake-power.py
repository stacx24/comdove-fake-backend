#!/usr/bin/env python3
# Local-only power endpoint for the fake server (WS-340). Listens on
# 127.0.0.1:4021; Caddy exposes it at /_power/* behind the login.
#   GET  /_power/status  → {"state":"on", "uptime_seconds":…, "idle_off_minutes":…}
#   POST /_power/off     → needs header X-Confirm: turn-off → powers the instance
#                          off (EC2 "stop": disk and data are kept).
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDLE_FILE = "/etc/comdove-fake/idle_minutes"


def uptime_seconds() -> int:
    with open("/proc/uptime") as f:
        return int(float(f.read().split()[0]))


def idle_minutes():
    try:
        with open(IDLE_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") == "/_power/status":
            return self._send(200, {
                "state": "on",
                "uptime_seconds": uptime_seconds(),
                "idle_off_minutes": idle_minutes(),
            })
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/_power/off":
            return self._send(404, {"error": "not found"})
        if self.headers.get("X-Confirm") != "turn-off":
            return self._send(400, {"error": "confirmation missing"})
        self._send(202, {"state": "turning_off"})
        # Let the response reach the browser, then shut down. The shutdown runs
        # the final S3 backup (comdove-fake-backup-on-shutdown.service).
        threading.Timer(2.0, lambda: subprocess.run(["systemctl", "poweroff"])).start()

    def log_message(self, *args):  # keep the journal quiet
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 4021), Handler).serve_forever()
