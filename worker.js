const RELEASES_PATH = "/api/firmware-releases";
const RELEASES_FEED =
  "https://github.com/openhop-dev/openhop_modem/releases.atom";
const CACHE_CONTROL = "public, max-age=900, stale-while-revalidate=86400";

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function getAttribute(element, name) {
  const match = element.match(new RegExp(`${name}=["']([^"']+)["']`));
  return match ? decodeXml(match[1]) : null;
}

function parseReleases(feed) {
  const releases = [];

  for (const match of feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const id = entry.match(/<id>[^<]*\/([^/<]+)<\/id>/);
    const alternate = [...entry.matchAll(/<link\b[^>]*>/g)]
      .map((link) => link[0])
      .find((link) => getAttribute(link, "rel") === "alternate");
    const htmlUrl = alternate && getAttribute(alternate, "href");

    if (!id || !htmlUrl) continue;
    releases.push({
      tag_name: decodeXml(id[1]),
      html_url: htmlUrl,
      draft: false,
      prerelease: false,
    });
  }

  return releases;
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function headResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function firmwareReleases(request, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "GET, HEAD" } },
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(RELEASES_PATH, request.url), {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);
  if (cached) return request.method === "HEAD" ? headResponse(cached) : cached;

  try {
    const upstream = await fetch(new Request(RELEASES_FEED, {
      headers: {
        Accept: "application/atom+xml",
        "User-Agent": "openHop-Modem-Flasher",
      },
    }));
    if (!upstream.ok) {
      throw new Error(`GitHub releases feed returned ${upstream.status}`);
    }

    const releases = parseReleases(await upstream.text());
    if (releases.length === 0) {
      throw new Error("GitHub releases feed contained no releases");
    }

    const response = jsonResponse(releases, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return request.method === "HEAD" ? headResponse(response) : response;
  } catch (error) {
    console.warn("Could not refresh the firmware release feed.", error);
    return jsonResponse(
      { error: "Firmware release discovery is temporarily unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === RELEASES_PATH) {
      return firmwareReleases(request, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
