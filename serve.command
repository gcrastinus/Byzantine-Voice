#!/bin/bash
# Double-click to serve this folder at http://localhost:8765
# (the app needs http:// — ES modules and fetch are blocked on file://).
cd "$(dirname "$0")" || exit 1
echo "Serving $(pwd) at http://localhost:8765"
echo "Close this window to stop."
exec python3 -m http.server 8765
