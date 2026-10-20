export function delay(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export function toSlug(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if(!res.ok) throw new Error(`Could not load ${url}: HTTP ${res.status}`);

  return await res.json();
}

// esptool-js 0.7.0 requires raw bytes, not binary strings.
export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
