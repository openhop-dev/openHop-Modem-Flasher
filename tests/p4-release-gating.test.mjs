import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserModule } from './modules.mjs';

globalThis.location = { host: 'localhost', search: '' };
const catalog = await browserModule('js/catalog.js');
const baseline = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const boards = ['ethermesh_1w', 'esp32_p4_nano'];

// Synthetic discovery fixtures exercise configuration, not actual release availability.
for(const source of ['feed', 'cache', 'fallback']) {
  for(const eligible of [false, true]) {
    test(`P4 ${source} ${eligible ? 'admits v1.4.2 and newer' : 'rejects metadata-incompatible releases'}`, async t => {
      t.mock.method(console, 'warn', () => {});
      const input = structuredClone(baseline);
      for(const board of boards) {
        const firmware = input.device.flatMap(d => d.firmware).find(f => f.silicon?.boardId === board);
        assert.equal(firmware.minimumRelease, 'v1.4.2', board);
      }
      const tags = ['v1.4.1', 'v1.4.0', 'v1.4.2-rc1', 'main', 'dev'];
      if(eligible) tags.push('v1.5.0', 'v1.4.2', 'v1.4.2');
      input.firmwareReleases.fallbackTags = tags;
      const releases = tags.map(tag_name => ({ tag_name }));
      const storage = new Map();
      if(source === 'cache') storage.set(`firmware-releases:${input.firmwareReleases.api}`,
        JSON.stringify({ fetchedAt: Date.now(), releases }));
      globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
      globalThis.fetch = async url => {
        if(url === '/config.json') return { ok: true, json: async () => structuredClone(input) };
        assert.notEqual(source, 'cache', 'fresh cached discovery must avoid the network');
        return { ok: source !== 'fallback', status: 502, json: async () => releases };
      };
      const loaded = await catalog.loadCatalog();
      for(const board of boards) {
        const device = loaded.device.find(d => d.firmware.some(f => f.silicon?.boardId === board));
        if(!eligible) {
          assert.equal(device, undefined, `${board} must not fall back to old metadata or a branch`);
          continue;
        }
        const firmware = device.firmware[0];
        assert.deepEqual(Object.keys(firmware.version), ['v1.5.0', 'v1.4.2']);
        assert.equal(catalog.defaultFirmwareVersion(firmware), 'v1.5.0');
        for(const [tag, version] of Object.entries(firmware.version)) {
          assert.equal(version.ref, tag);
          for(const file of version.files) assert.ok(catalog.firmwareUrl(loaded, file, version).includes(`/${tag}/firmware/`));
        }
      }
      const photon = loaded.device.find(d => d.name === 'Photon-1W XAIO ESP32 C6');
      assert.ok(photon.firmware[0].version['v1.4.0'], 'P4 floor must not hide old releases on other hardware');
      if(eligible) assert.deepEqual(loaded.device.toSorted(catalog.compareDevices).slice(0, 2).map(d => d.name),
        ['EtherMesh-1W', 'Photon-1W XAIO ESP32 C6']);
    });
  }
}

test('release configuration stages v1.4.2 as the API-outage fallback', () => {
  assert.deepEqual(baseline.firmwareReleases.fallbackTags, ['v1.4.2']);
});
