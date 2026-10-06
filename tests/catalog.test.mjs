import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserModule } from './modules.mjs';
globalThis.location = { host: 'localhost', search: '' };
const catalog = await browserModule('js/catalog.js');
const baseline = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
let cache = new Map();
globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
const releases = [
  { tag_name: 'v1.2.0', html_url: 'https://github.com/openhop-dev/openhop_modem/releases/tag/v1.2.0' },
  { tag_name: 'v1.1.0', html_url: 'https://github.com/openhop-dev/openhop_modem/releases/tag/v1.1.0' },
  { tag_name: 'v1.0.1', html_url: 'https://github.com/openhop-dev/openhop_modem/releases/tag/v1.0.1' },
  { tag_name: 'v1.0.0' }, { tag_name: 'v2.0.0', prerelease: true }, { tag_name: 'v3.0.0', draft: true },
];

test('catalog expands stable releases, omits branch builds, gates newer hardware, and caches discovery', async () => {
  cache.clear();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return { ok: true, json: async () => structuredClone(url === '/config.json' ? baseline : releases) };
  };
  const config = await catalog.loadCatalog();
  const fw = name => config.device.find(d => d.name === name).firmware[0];
  assert.deepEqual(Object.keys(fw('EtherMesh-1W').version), ['v1.2.0', 'v1.1.0', 'v1.0.1']);
  assert.deepEqual(Object.keys(fw('RAK3401 + RAK13302').version), ['v1.2.0']);
  assert.equal(fw('EtherMesh-1W').version['v1.2.0'].releaseUrl, releases[0].html_url);
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      assert.ok(!('main' in firmware.version), device.name);
      assert.equal(catalog.defaultFirmwareVersion(firmware), 'v1.2.0');
    }
  }
  assert.equal(requests[0][1].cache, 'no-store');
  await catalog.loadCatalog();
  assert.equal(requests.filter(([url]) => url === '/api/firmware-releases').length, 1);
});

test('selected tag rewrites raw source, while same-origin paths remain untouched', () => {
  assert.equal(catalog.firmwareUrl(baseline, { name: 'board/firmware.bin' }, { ref: 'v1.2.0' }), baseline.staticPath.replace('/main/firmware', '/v1.2.0/firmware') + '/board/firmware.bin');
  assert.equal(catalog.firmwareUrl(baseline, { name: '/local.bin' }, { ref: 'v1.2.0' }), '/local.bin');
});


test('failed refresh uses configured stable fallback and honors expandReleases false', async () => {
  cache.clear();
  const input = structuredClone(baseline);
  input.device[0].firmware[0].expandReleases = false;
  globalThis.fetch = async url => {
    if(url === '/config.json') return {ok:true, json:async () => input};
    return {ok:false, status:502};
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const config = await catalog.loadCatalog();
    assert.ok(!config.device.some(d => d.name === baseline.device[0].name));
    assert.deepEqual(Object.keys(config.device[0].firmware[0].version), baseline.firmwareReleases.fallbackTags);
  } finally { console.warn = warn; }
});

test('corrupt or disabled browser storage does not block successful release discovery', async () => {
  cache.set(`firmware-releases:${baseline.firmwareReleases.api}`, '{bad JSON');
  globalThis.fetch = async url => ({ok:true, json:async () => structuredClone(url === '/config.json' ? baseline : releases)});
  assert.ok((await catalog.loadCatalog()).device[0].firmware[0].version['v1.2.0']);
  const storage = globalThis.localStorage;
  globalThis.localStorage = {getItem() {throw Error('disabled');}, setItem() {throw Error('disabled');}};
  try { assert.ok((await catalog.loadCatalog()).device[0].firmware[0].version['v1.2.0']); }
  finally {globalThis.localStorage = storage;}
});

for(const source of ['feed', 'cache', 'fallback']) {
  test(`${source} normalizes unordered stable releases newest semver first`, async t => {
    cache.clear();
    t.mock.method(console, 'warn', () => {});
    const input = structuredClone(baseline);
    const tags = ['v1.2.0', 'main', 'v1.10.0', 'v1.3.0-rc1', 'v1.0.0', 'v1.10.0'];
    input.firmwareReleases.fallbackTags = tags;
    const unordered = tags.map(tag_name => ({tag_name}));
    if(source === 'cache') cache.set(`firmware-releases:${input.firmwareReleases.api}`, JSON.stringify({fetchedAt:Date.now(), releases:unordered}));
    globalThis.fetch = async url => {
      if(url === '/config.json') return {ok:true, json:async () => input};
      assert.notEqual(source, 'cache', 'fresh cache must avoid network discovery');
      return {ok:source !== 'fallback', status:502, json:async () => unordered};
    };
    const loaded = await catalog.loadCatalog();
    for(const device of loaded.device) {
      const fw = device.firmware[0];
      assert.deepEqual(Object.keys(fw.version), device.slug === 'lilygo-tbeam-1w' ? ['v1.10.0'] : ['v1.10.0', 'v1.2.0']);
      assert.equal(catalog.defaultFirmwareVersion(fw), 'v1.10.0');
      for(const version of Object.values(fw.version)) {
        for(const file of version.files) assert.ok(catalog.firmwareUrl(loaded, file, version).includes(`/${version.ref}/firmware/`));
      }
    }
  });
}

for(const source of ['feed', 'cache', 'fallback']) {
  for(const tags of [
    ['main', 'dev', 'v1.3.0', 'v1.4.0-rc1'],
    ['v1.3.0', 'v1.4.0'],
    ['v1.4.0', 'main', 'v1.10.0', 'v1.3.0', 'v1.5.0', 'v1.10.0', 'v1.11.0-rc1'],
    [],
  ]) {
    test(`T-Beam 1W ${source} gates releases for ${JSON.stringify(tags)}`, async t => {
      cache.clear();
      t.mock.method(console, 'warn', () => {});
      const input = structuredClone(baseline);
      assert.ok(input.device.some(d => d.slug === 'lilygo-tbeam-1w'), 'distinct T-Beam 1W must be configured');
      input.firmwareReleases.fallbackTags = tags;
      const discovered = tags.map(tag_name => ({tag_name}));
      if(source === 'cache') cache.set(`firmware-releases:${input.firmwareReleases.api}`, JSON.stringify({fetchedAt:Date.now(), releases:discovered}));
      let releaseRequests = 0;
      globalThis.fetch = async url => {
        if(url === '/config.json') return {ok:true, json:async () => structuredClone(input)};
        releaseRequests++;
        return {ok:source !== 'fallback', status:502, json:async () => structuredClone(discovered)};
      };
      const loaded = await catalog.loadCatalog();
      assert.equal(releaseRequests, source === 'cache' ? 0 : 1);
      const device = loaded.device.find(d => d.slug === 'lilygo-tbeam-1w');
      const expected = tags.includes('v1.10.0') ? ['v1.10.0', 'v1.5.0', 'v1.4.0'] : tags.includes('v1.4.0') ? ['v1.4.0'] : [];
      if(!expected.length) {
        assert.equal(device, undefined, 'no eligible release must hide device, never restore main');
        return;
      }
      assert.deepEqual(loaded.device.toSorted(catalog.compareDevices).slice(0, 2).map(d => d.name), ['EtherMesh-1W', 'Photon-1W XAIO ESP32 C6']);
      const fw = device.firmware[0];
      assert.deepEqual(Object.keys(fw.version), expected);
      assert.equal(catalog.defaultFirmwareVersion(fw), expected[0]);
      assert.ok(catalog.renderNotice(loaded, device, fw).includes('erases settings'));
      for(const [tag, version] of Object.entries(fw.version)) {
        assert.equal(version.ref, tag);
        assert.equal(version.releaseUrl, `${input.firmwareReleases.releaseBaseUrl}${tag}`);
        assert.deepEqual(version.files.map(f => [f.type, f.address, catalog.firmwareUrl(loaded, f, version)]), [
          ['flash-update', 0x10000, `${input.staticPath.replace('/main/firmware', `/${tag}/firmware`)}/lilygo_tbeam_1w/firmware.bin`],
          ['flash-wipe', 0, `${input.staticPath.replace('/main/firmware', `/${tag}/firmware`)}/lilygo_tbeam_1w/firmware.factory.bin`],
        ]);
      }
    });
  }
}

test('default ignores branch and empty versions regardless of insertion order', () => {
  const version = {files:[{}]};
  assert.equal(catalog.defaultFirmwareVersion({version:{'v1.2.0':version, main:version, 'v1.10.0':version, 'v2.0.0':{files:[]}}}), 'v1.10.0');
  assert.equal(catalog.defaultFirmwareVersion({version:{main:version}}), null);
});

test('no eligible releases hide devices and empty roles; disabled expansion only keeps published explicit tags', async () => {
  cache.clear();
  const input = structuredClone(baseline);
  const first = input.device[0].firmware[0];
  first.minimumRelease = 'v9.0.0';
  const second = input.device[1].firmware[0];
  second.expandReleases = false;
  second.version['v1.2.0'] = structuredClone(second.version.main);
  second.version['v8.0.0'] = structuredClone(second.version.main);
  input.device[1].firmware.push(structuredClone(first));
  globalThis.fetch = async url => ({ok:true, json:async () => structuredClone(url === '/config.json' ? input : releases)});
  const loaded = await catalog.loadCatalog();
  assert.ok(!loaded.device.some(d => d.name === input.device[0].name));
  const retained = loaded.device.find(d => d.name === input.device[1].name);
  assert.equal(retained.firmware.length, 1);
  assert.deepEqual(Object.keys(retained.firmware[0].version), ['v1.2.0']);
  cache.clear();
  globalThis.fetch = async url => ({ok:true, json:async () => structuredClone(url === '/config.json' ? baseline : [])});
  assert.deepEqual((await catalog.loadCatalog()).device, []);
});
