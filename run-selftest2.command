#!/bin/bash
# Double-click to run the simulated-playback self-test in Safari.
#
# The server runs in the FOREGROUND of this window on purpose: Terminal appends
# "; exit" when it opens a .command, so a backgrounded server would be killed
# the moment the script returned. Close this window to stop the server.
cd "$(dirname "$0")" || exit 1

URL="http://localhost:8765/index.html?pdf=08-16-26_Sunday_Vespers.pdf&selftest=2"

( sleep 2; open -a Safari "$URL" ) &

echo "Serving $(pwd) on http://localhost:8765"
echo "Opening Safari at:"
echo "  $URL"
echo
echo "The test takes about 70 seconds. Watch the banner at the bottom of the page."
echo "Close this window when you are done to stop the server."
echo
exec python3 -m http.server 8765
