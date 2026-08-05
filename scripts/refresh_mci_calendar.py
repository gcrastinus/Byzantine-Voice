#!/usr/bin/env python3
"""Fetch mci.archpitt.org home HTML into data/ for GitHub Pages calendar panel."""
from __future__ import annotations

import json
import ssl
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_HTML = ROOT / "data" / "mci-home.html"
OUT_META = ROOT / "data" / "mci-meta.json"
MCI_URLS = (
    "https://mci.archpitt.org/",
    "http://mci.archpitt.org/",
)
UA = "ByzantineVoice-CalendarRefresh/1.0 (+https://github.com/gcrastinus/Byzantine-Voice)"


def fetch() -> bytes:
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}
    last_err: Exception | None = None
    for url in MCI_URLS:
        for verify in (True, False):
            if not url.startswith("https") and not verify:
                continue
            try:
                ctx = None
                if url.startswith("https") and not verify:
                    ctx = ssl._create_unverified_context()
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    body = resp.read()
                if body and b"Liturgical" in body and b"sidebar2" in body:
                    return body
                last_err = RuntimeError(f"unexpected content from {url}")
            except Exception as e:  # noqa: BLE001 — report last error
                last_err = e
    raise SystemExit(f"Could not fetch MCI home page: {last_err}")


def main() -> None:
    body = fetch()
    OUT_HTML.parent.mkdir(parents=True, exist_ok=True)
    OUT_HTML.write_bytes(body)
    meta = {
        "source": "https://mci.archpitt.org/",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bytes": len(body),
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_HTML} ({len(body)} bytes) at {meta['fetchedAt']}")


if __name__ == "__main__":
    main()
