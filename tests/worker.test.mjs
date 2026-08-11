import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

const atomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1208746600/v1.0.1</id>
    <link rel="alternate" type="text/html" href="https://github.com/openhop-dev/openhop_modem/releases/tag/v1.0.1"/>
    <title>v1.0.1</title>
  </entry>
</feed>`;

function makeRuntime() {
  const cachedResponses = new Map();
  let upstreamFetches = 0;

  globalThis.caches = {
    default: {
      async match(request) {
        const response = cachedResponses.get(request.url);
        return response?.clone();
      },
      async put(request, response) {
        cachedResponses.set(request.url, response.clone());
      },
    },
  };

  globalThis.fetch = async (request) => {
    upstreamFetches += 1;
    assert.equal(
      request.url,
      "https://github.com/openhop-dev/openhop_modem/releases.atom",
    );
    return new Response(atomFeed, {
      headers: { "Content-Type": "application/atom+xml" },
    });
  };

  const assetRequests = [];
  const env = {
    ASSETS: {
      async fetch(request) {
        assetRequests.push(request.url);
        return new Response("asset");
      },
    },
  };
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };

  return {
    env,
    ctx,
    pending,
    assetRequests,
    upstreamFetches: () => upstreamFetches,
  };
}

test("release endpoint converts and caches the GitHub Atom feed", async () => {
  const runtime = makeRuntime();
  const request = new Request(
    "https://flasher.openhop.dev/api/firmware-releases",
  );

  const first = await worker.fetch(request, runtime.env, runtime.ctx);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("Cache-Control"), /max-age=900/);
  assert.deepEqual(await first.json(), [
    {
      tag_name: "v1.0.1",
      html_url:
        "https://github.com/openhop-dev/openhop_modem/releases/tag/v1.0.1",
      draft: false,
      prerelease: false,
    },
  ]);
  await Promise.all(runtime.pending);

  const second = await worker.fetch(request, runtime.env, runtime.ctx);
  assert.equal(second.status, 200);
  assert.equal(runtime.upstreamFetches(), 1);
});

test("non-API requests are delegated to static assets", async () => {
  const runtime = makeRuntime();
  const request = new Request("https://flasher.openhop.dev/config.json");

  const response = await worker.fetch(request, runtime.env, runtime.ctx);

  assert.equal(await response.text(), "asset");
  assert.deepEqual(runtime.assetRequests, [request.url]);
});
