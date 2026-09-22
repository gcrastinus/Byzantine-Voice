/**
 * Cloudflare Pages Function — live proxy for mci.archpitt.org.
 * Served at /api/mci-home on chant.studiuminstitute.org (and local Pages preview).
 * Byzantine Voice already tries this path before the static data/ snapshot.
 */

const MCI_URL = "https://mci.archpitt.org/";
const UA = "ByzantineVoice-PagesFunction/1.0 (+https://github.com/gcrastinus/Byzantine-Voice)";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet() {
  let upstream;
  try {
    upstream = await fetch(MCI_URL, {
      headers: {
        "User-Agent": UA,
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
  return new Response(body, {
    status: upstream.status,
    headers: corsHeaders({
      "Content-Type":
        upstream.headers.get("Content-Type") || "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  });
}
