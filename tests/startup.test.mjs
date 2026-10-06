import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { browserModule, hardwareStubs } from './modules.mjs';

const root = new URL('../', import.meta.url);
const readSource = path => process.env.TEST_REVISION
  ? execFileSync('git', ['show', `${process.env.TEST_REVISION}:${path}`], { cwd: root, encoding: 'utf8' })
  : readFile(new URL(path, root), 'utf8');
const config = JSON.parse(await readSource('config.json'));

let starts = 0;

// Only replace DOM mounting and hardware; run the actual entry, setup, router,
// catalogue/release discovery and Vue reactivity with the production config.
async function startup(pathname, search = '', tags = ['v1.5.0', 'v1.4.0', 'v1.0.1']) {
  const redirects = [], requests = [], historyCalls = [], listeners = {};
  const storage = new Map();
  globalThis.location = { host: 'localhost', pathname, search, replace: target => redirects.push(target) };
  globalThis.window = { location, addEventListener(name, handler) { listeners[name] = handler; } };
  globalThis.history = Object.fromEntries(['replaceState', 'pushState'].map(method => [method, (_state, _title, url) => {
    historyCalls.push({ method, url });
    const target = new URL(url, 'http://localhost');
    location.pathname = target.pathname;
    location.search = target.search;
  }]));
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.fetch = async url => {
    requests.push(url);
    if(url === '/config.json' || url === '/custom.json') return { ok: true, json: async () => structuredClone(config) };
    if(url === config.firmwareReleases.api) return { ok: true, json: async () => tags.map(tag_name => ({ tag_name })) };
    throw new Error(`Unexpected startup request: ${url}`);
  };
  globalThis.startupMounted = null;
  const stubs = { ...hardwareStubs,
    'flasher.js': await readSource('flasher.js') + `\n// fresh startup ${++starts}`,
    'js/site.js': await readSource('js/site.js') + `\n// fresh page ${starts}`,
    'lib/beer.min.js': 'export default {};',
    'lib/overflow.vue.js': 'export default {};',
    'lib/vue.prod.min.js': (await readSource('lib/vue.prod.min.js')).replace(/\b\w+ as createApp\b/, 'testCreateApp as createApp') + '\nconst testCreateApp = options => ({mount(target) { globalThis.startupMounted = {target, app: options.setup()}; }});',
    'lib/console.js': 'export class SerialConsole {}',
    'js/serial.js': 'export const serialAPI = {}; export const serialSupported = true;',
  };
  delete stubs['js/util.js'];
  await browserModule('flasher.js', stubs);
  const { nextTick } = await browserModule('lib/vue.prod.min.js', stubs);
  await nextTick();
  return { ...globalThis.startupMounted, redirects, requests, historyCalls, listeners, nextTick };
}

const devicePath = '/openhop-uniteng-bq-voyage-station-g3/';
const rolePath = devicePath + 'openhop-modem/';
const buildPath = rolePath + 'v1.4.0';

test('real entry restores an explicitly linked stable build on initial load and reload', async () => {
  for(let load = 0; load < 2; load++) {
    const result = await startup(buildPath);
    assert.deepEqual(result.redirects, [], 'direct links must reach application startup instead of redirecting home');
    assert.equal(result.target, '#app');
    assert.equal(result.app.selected.device.name, 'UnitEng/BQ Voyage Station G3');
    assert.equal(result.app.fwValue(result.app.selected.firmware, 'title'), 'openHop Modem');
    assert.equal(result.app.selected.version, 'v1.4.0', 'explicit version wins over newest v1.5.0');
    assert.equal(result.app.currentVersion.value.ref, 'v1.4.0');
    assert.equal(location.pathname, buildPath);
    assert.ok(result.app.downloads.value.every(file => file.href.includes('/v1.4.0/firmware/station_g3/')));
    assert.deepEqual(result.requests, ['/config.json', config.firmwareReleases.api]);
  }
});

for(const [path, expected, role] of [
  ['/', '/', false],
  [devicePath, devicePath, false],
  [rolePath, rolePath + 'v1.5.0', true],
  ['/unknown-device/openhop-modem/v1.4.0', '/', false],
  [devicePath + 'unknown-role/v1.4.0', devicePath, false],
  [rolePath + 'unknown-version', rolePath + 'v1.5.0', true],
  [rolePath + 'main', rolePath + 'v1.5.0', true],
]) {
  test(`initial route ${path} uses the existing partial-match/default fallback`, async () => {
    const { app, redirects, target } = await startup(path);
    assert.deepEqual(redirects, []);
    assert.equal(target, '#app');
    assert.equal(location.pathname, expected);
    assert.equal(Boolean(app.selected.device), expected !== '/');
    assert.equal(Boolean(app.selected.firmware), role);
    assert.equal(app.selected.version, role ? 'v1.5.0' : null);
    for(const device of app.config.device) for(const firmware of device.firmware) {
      assert.ok(Object.keys(firmware.version).every(version => /^v\d+\.\d+\.\d+$/.test(version)));
    }
  });
}

test('unavailable requested version is replaced by the actual eligible build in selection, URL and downloads', async () => {
  const { app } = await startup(buildPath, '', ['v1.5.0']);
  assert.equal(app.selected.version, 'v1.5.0');
  assert.equal(location.pathname, rolePath + 'v1.5.0');
  assert.equal(app.currentVersion.value.ref, 'v1.5.0');
  assert.ok(app.downloads.value.every(file => file.href.includes('/v1.5.0/firmware/')));
  assert.equal(app.selected.firmware.version['v1.4.0'], undefined);
});

test('no eligible releases restores home without a branch build', async () => {
  const { app } = await startup(buildPath, '', []);
  assert.equal(location.pathname, '/');
  assert.equal(app.selected.device, null);
  assert.equal(app.selected.version, null);
  assert.deepEqual(app.config.device, []);
  assert.deepEqual(app.downloads.value, []);
});

test('deep-link startup retains custom config, iframe branding and flashing notices', async () => {
  const search = '?config=custom&iframe=1';
  const { app, requests } = await startup(buildPath, search);
  assert.equal(requests[0], '/custom.json');
  assert.equal(location.search, search);
  assert.equal(app.logoFile, 'openhop_logo.png');
  assert.equal(app.isIframe, true);
  assert.match(app.notice.value, /Erase Device/);
  assert.match(app.notice.value, /antenna/);
});

test('real history restores back/forward selections and locks popstate during a busy flash', async () => {
  const { app, listeners, nextTick, historyCalls } = await startup(buildPath);
  app.stepBack();
  await nextTick();
  assert.equal(location.pathname, devicePath);
  assert.equal(historyCalls.at(-1).method, 'pushState');
  for(const path of [buildPath, devicePath, buildPath]) {
    location.pathname = path;
    listeners.popstate();
    await nextTick();
    assert.equal(location.pathname, path);
    assert.equal(app.selected.version, path === buildPath ? 'v1.4.0' : null);
  }
  app.flashing.busy = true;
  app.flashing.active = true;
  location.pathname = '/';
  listeners.popstate();
  await nextTick();
  assert.equal(location.pathname, buildPath);
  assert.equal(app.selected.version, 'v1.4.0');
  assert.equal(app.flashing.active, true);
});
