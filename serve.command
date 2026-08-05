#!/bin/bash
# Double-click to serve this folder at http://localhost:8765
# (the app needs http:// — ES modules and fetch are blocked on file://).
#
# Uses serve.py so /api/mci-home can proxy the MCI website for the live
# liturgical calendar (browsers cannot fetch mci.archpitt.org directly: CORS).
cd "$(dirname "$0")" || exit 1
echo "Serving $(pwd) at http://localhost:8765"
echo "Close this window to stop."
exec python3 serve.py
