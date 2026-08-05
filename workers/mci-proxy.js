/**
 * Optional Cloudflare Worker — true live proxy for mci.archpitt.org.
 *
 * Deploy (free Cloudflare account):
 *   1. dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Paste this file, Deploy
 *   3. Copy the worker URL, e.g. https://byzantine-voice-mci.YOUR.workers.dev
 *   4. In app.js set MCI_LIVE_PROXY to that URL (or open the app with
 *      ?mciProxy=https://byzantine-voice-mci.YOUR.workers.dev )
 *
 * The worker returns the MCI home HTML with CORS headers so the calendar
 * panel can parse Liturgical Calendar + Vigil Divine Liturgy propers live.
 */

export default {
  async fetch(request) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const mci = "https://mci.archpitt.org/";
    let upstream;
    try {
      upstream = await fetch(mci, {
        headers: {
          "User-Agent": "ByzantineVoice-CF-Worker/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
        cf: { cacheTtl: 300, cacheEverything: false },
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e, {
        status: 502,
        headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    const body = await upstream.arrayBuffer();
    const headers = corsHeaders({
      "Content-Type":
        upstream.headers.get("Content-Type") || "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    return new Response(body, { status: upstream.status, headers });
  },
};

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}
