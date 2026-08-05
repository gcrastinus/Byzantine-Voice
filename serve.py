#!/usr/bin/env python3
"""
Local static server for Byzantine Voice + a small proxy for the MCI home page.

Why a proxy?
  The app needs to read https://mci.archpitt.org/ (sidebar: Liturgical Calendar
  + Vigil Divine Liturgy propers). That site does not send CORS headers, so a
  browser cannot fetch it directly. This process serves the app files and
  answers GET /api/mci-home with a fresh copy of the MCI home HTML so the
  calendar panel stays live (September updates, etc.).

Usage: python3 serve.py
  → http://localhost:8765
"""
from __future__ import annotations

import http.server
import socketserver
import ssl
import urllib.error
import urllib.request
from pathlib import Path

PORT = 8765
ROOT = Path(__file__).resolve().parent
# Prefer https; fall back to http if local Python lacks CA certs (common on macOS).
MCI_HOME_HTTPS = "https://mci.archpitt.org/"
MCI_HOME_HTTP = "http://mci.archpitt.org/"
UA = "ByzantineVoiceLocalProxy/1.0 (+local calendar; contact: local app)"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Allow the app origin (same host) to read the proxy response.
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/mci-home":
            self._proxy_mci_home()
            return
        return super().do_GET()

    def _proxy_mci_home(self):
        headers = {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
        }
        body = None
        ctype = "text/html; charset=utf-8"
        last_err = None

        # Try HTTPS with normal certs, then HTTPS with unverified context (macOS
        # Python often lacks certifi), then plain HTTP.
        attempts = [
            (MCI_HOME_HTTPS, True),
            (MCI_HOME_HTTPS, False),
            (MCI_HOME_HTTP, True),
        ]
        for url, verify in attempts:
            req = urllib.request.Request(url, headers=headers, method="GET")
            try:
                ctx = None
                if url.startswith("https:") and not verify:
                    ctx = ssl._create_unverified_context()
                with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                    body = resp.read()
                    ctype = resp.headers.get("Content-Type", ctype)
                if body and b"Liturgical" in body:
                    break
                last_err = "unexpected content from " + url
                body = None
            except Exception as e:
                last_err = e
                body = None

        if not body:
            msg = f"Could not reach MCI: {last_err}".encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Quieter default log
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    # Allow Ctrl+C to free the port quickly
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Serving {ROOT}")
        print(f"  App:      http://localhost:{PORT}/")
        print(f"  MCI proxy: http://localhost:{PORT}/api/mci-home")
        print("Close this window (or Ctrl+C) to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
