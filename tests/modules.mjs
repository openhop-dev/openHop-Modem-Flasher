// Load browser modules without a server; stub only hardware/vendor boundaries.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
export async function loadModule(path, stubs = {}, revision = null, cache = new Map()) {
  if (cache.has(path)) return cache.get(path);
  let source = stubs[path] ?? (revision
    ? execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' })
    : await readFile(new URL(path, root), 'utf8'));
  const matches = [...source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)(['"])([^'"]+)\1/g)];
  for (const match of matches) {
    const target = match[2].startsWith('/') ? match[2].slice(1) : new URL(match[2], new URL(path, root)).pathname.slice(root.pathname.length);
    const cleanTarget = target.split('?')[0];
    const url = await moduleUrl(cleanTarget, stubs, revision, cache);
    source = source.replace(match[0], match[0].replace(match[2], url));
  }
  return source;
}
async function moduleUrl(path, stubs, revision, cache) {
  if (cache.has(path)) return cache.get(path);
  const source = await loadModule(path, stubs, revision, cache);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  cache.set(path, url);
  return url;
}
export async function browserModule(path, stubs = {}, revision = process.env.TEST_REVISION || null) {
  return import(await moduleUrl(path, stubs, revision, new Map()));
}
export const hardwareStubs = {
  'lib/dfu.js': 'export class Dfu {}',
  'lib/esp32.js': `export class Transport { async setRTS() {} async disconnect() {} }
    export class HardReset { async reset() {} }
    export class ESPLoader {
      constructor(options) { this.transport = options.transport; }
      async main() {} async flashId() {} async after() {}
      async writeFlash(options) { globalThis.writtenFlash = options; }
    }`,
  'js/util.js': `export const delay = async () => {}; export const blobToBinaryString = async blob => String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));`,
};
