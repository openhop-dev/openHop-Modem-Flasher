import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserModule} from './modules.mjs';

test('startup redirects non-root without loading catalogue; root mounts normally', async () => {
  const source = await readFile(new URL('../flasher.js',import.meta.url),'utf8');
  for(const pathname of ['/old/device/main','/']) {
    const redirects = [];
    globalThis.location = {pathname,replace: target => redirects.push(target)};
    globalThis.catalogLoads = 0;
    globalThis.mounted = null;
    await browserModule('flasher.js', {
      'flasher.js': source + `\n// isolated ${pathname}`,
      'lib/beer.min.js': 'export default {};',
      'lib/vue.prod.min.js': 'export const createApp = () => ({mount: target => {globalThis.mounted=target;}});',
      'lib/overflow.vue.js': 'export default {};',
      'js/app.js': 'export const createSetup = () => () => ({});',
      'js/catalog.js': 'export const loadCatalog = async () => {globalThis.catalogLoads++; return {};};',
    },null);
    assert.deepEqual(redirects, pathname === '/' ? [] : ['/']);
    assert.equal(globalThis.catalogLoads, pathname === '/' ? 1 : 0);
    assert.equal(globalThis.mounted, pathname === '/' ? '#app' : null);
  }
});
