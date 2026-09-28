import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserModule, hardwareStubs } from './modules.mjs';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
globalThis.location = { host: 'localhost', pathname: '/', search: '' };
const listeners = {};
globalThis.window = { location, addEventListener(name, handler) { listeners[name] = handler; } };
globalThis.history = { replaceState() {}, pushState() {} };
globalThis.localStorage = { getItem() { return null; } };
globalThis.alert = message => { throw new Error(message); };
const stubs = { ...hardwareStubs,
  'lib/dfu.js': 'export class Dfu {constructor(port) {this.port=port;} async dfuUpdate(data, progress) {globalThis.dfuBlob=data; if(globalThis.dfuUpdate) return globalThis.dfuUpdate(data, progress); progress(100);}}',
  'js/serial.js': 'export const serialAPI = {requestPort: (...args) => globalThis.requestPort?.(...args) ?? Promise.resolve({})}; export const serialSupported = true;',
  'lib/console.js': 'export class SerialConsole {}',
  'lib/vue.min.js': await readFile(new URL('../lib/vue.prod.min.js', import.meta.url), 'utf8'),
};
delete stubs['js/util.js'];
const { createSetup } = await browserModule('js/app.js', stubs);

function stationApp(wipe = false) {
  const app = createSetup(structuredClone(config))();
  app.selected.device = app.config.device.find(d => d.name === 'UnitEng/BQ Voyage Station G3');
  app.selectFirmware(app.selected.device.firmware[0]);
  app.selected.wipe = wipe;
  return app;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('port chooser runs synchronously before any firmware download', async () => {
  const app = stationApp();
  const network = deferred();
  const events = [];
  globalThis.requestPort = () => { events.push('chooser'); return Promise.resolve({}); };
  globalThis.fetch = async () => { events.push('fetch'); return network.promise; };
  const flashing = app.flashDevice();
  const immediate = [...events];
  network.resolve({ok: true, blob: async () => new Blob(['firmware'])});
  await flashing;
  delete globalThis.requestPort;
  assert.deepEqual(immediate, ['chooser'], 'chooser must retain click user activation');
  assert.deepEqual(events, ['chooser', 'fetch']);
});

test('flash plan freezes wipe, chip, URLs, offsets and local data before the chooser await', async () => {
  const app = stationApp();
  app.currentVersion.value.ref = 'v1.2.0';
  const chooser = deferred();
  const network = deferred();
  const started = deferred();
  const urls = [];
  globalThis.requestPort = () => chooser.promise;
  globalThis.fetch = async url => { urls.push(url); started.resolve(); return network.promise; };
  const run = app.flashDevice();
  app.currentVersion.value.ref = 'main';
  for(const file of app.currentVersion.value.files) file.address = 0;
  app.selected.device.type = 'nrf52';
  chooser.resolve({});
  await started.promise;
  app.selected.wipe = true;
  network.resolve({ok:true, blob:async () => new Blob(['original firmware'])});
  await run;
  delete globalThis.requestPort;
  assert.equal(globalThis.writtenFlash.eraseAll, false, 'update must never become a full erase');
  assert.deepEqual(globalThis.writtenFlash.fileArray.map(f => f.address), [0x10000]);
  assert.ok(urls.every(url => url.includes('/v1.2.0/firmware/station_g3/')));
  assert.equal(globalThis.writtenFlash.fileArray[0].data, 'original firmware');
});

test('flash locks synchronously against duplicate calls and unlocks after completion', async () => {
  const app = stationApp();
  const chooser = deferred();
  const network = deferred();
  const started = deferred();
  let choosers = 0, fetches = 0;
  globalThis.requestPort = () => { choosers++; return chooser.promise; };
  globalThis.fetch = async () => { fetches++; started.resolve(); return network.promise; };
  const first = app.flashDevice();
  const initial = { busy: app.flashing.busy, active: app.flashing.active };
  const second = app.flashDevice();
  chooser.resolve({});
  await started.promise;
  const third = app.flashDevice();
  network.resolve({ok:true, blob:async () => new Blob(['firmware'])});
  await Promise.all([first, second, third]);
  delete globalThis.requestPort;
  assert.deepEqual(initial, {busy:true, active:true});
  assert.equal(choosers, 1);
  assert.equal(fetches, 1);
  assert.equal(app.flashing.busy, false);
  assert.equal(app.flashing.active, true, 'keep completion screen until retry/close');
  await app.retry();
  assert.equal(app.flashing.active, false);
  assert.equal(app.flashing.instance, null);
  assert.equal(app.flashing.percent, 0);
});

test('active transaction blocks navigation, cleanup and selection replacement', async () => {
  const app = stationApp();
  const device = app.selected.device;
  const firmware = app.selected.firmware;
  const chooser = deferred();
  const network = deferred();
  const started = deferred();
  let reloads = 0, choosers = 0;
  location.reload = () => { reloads++; };
  globalThis.requestPort = () => { choosers++; return chooser.promise; };
  globalThis.fetch = async () => { started.resolve(); return network.promise; };
  const run = app.flashDevice();
  chooser.resolve({});
  await started.promise;
  await app.retry();
  app.close();
  app.stepBack();
  app.selectFirmware(null);
  app.customFirmwareLoad({target:{files:[new File(['other'], 'other.bin')]}});
  listeners.popstate();
  const during = {active:app.flashing.active, busy:app.flashing.busy, device:app.selected.device, firmware:app.selected.firmware};
  network.resolve({ok:true, blob:async () => new Blob(['firmware'])});
  await run;
  delete globalThis.requestPort;
  assert.deepEqual(during, {active:true, busy:true, device, firmware});
  assert.equal(reloads, 0);
  assert.equal(choosers, 1);
  await app.retry();
  app.stepBack();
  assert.equal(app.selected.firmware, null);
  app.close();
  assert.equal(reloads, 1);
});

test('cancelled chooser restores selection without downloading or leaving an error', async () => {
  const app = stationApp();
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('must not download'); };
  globalThis.requestPort = async () => { throw new DOMException('No port selected', 'NotFoundError'); };
  await assert.doesNotReject(app.flashDevice());
  delete globalThis.requestPort;
  assert.equal(fetches, 0);
  assert.equal(app.flashing.busy, false);
  assert.equal(app.flashing.active, false);
  assert.equal(app.flashing.error, '');
  assert.equal(app.flashing.instance, null);
  assert.equal(app.selected.device.name, 'UnitEng/BQ Voyage Station G3');
  globalThis.fetch = async () => ({ok:true, blob:async () => new Blob(['retry'])});
  await app.flashDevice();
  assert.equal(globalThis.writtenFlash.fileArray[0].data, 'retry');
});

for(const failure of ['chooser rejection', 'chooser synchronous error', 'download']) {
  test(`${failure} is handled and retry clears transaction state`, async () => {
    const app = stationApp();
    let fetches = 0;
    const error = new DOMException('Permission denied', 'SecurityError');
    globalThis.requestPort = failure === 'chooser rejection' ? async () => { throw error; }
      : failure === 'chooser synchronous error' ? () => { throw error; }
      : async () => ({});
    globalThis.fetch = async () => { fetches++; return {ok:false, status:503}; };
    await assert.doesNotReject(app.flashDevice());
    delete globalThis.requestPort;
    assert.equal(app.flashing.busy, false);
    assert.equal(app.flashing.active, true);
    assert.match(app.flashing.error, failure === 'download' ? /HTTP 503/ : /Permission denied/);
    assert.equal(app.flashing.instance, null, 'failure before backend must not open the port');
    assert.equal(fetches, failure === 'download' ? 1 : 0);
    await app.retry();
    assert.equal(app.flashing.active, false);
    assert.equal(app.flashing.error, '');
    assert.equal(app.flashing.percent, 0);
    assert.equal(app.flashing.phase, '');
    globalThis.fetch = async () => ({ok:true, blob:async () => new Blob(['recovered'])});
    await app.flashDevice();
    assert.equal(globalThis.writtenFlash.fileArray[0].data, 'recovered');
    assert.equal(app.flashing.busy, false);
  });
}

test('custom local Blob is snapshotted before port selection', async () => {
  const app = createSetup(structuredClone(config))();
  const file = new File(['original'], 'firmware.bin');
  app.customFirmwareLoad({target:{files:[file]}});
  const chooser = deferred();
  globalThis.requestPort = () => chooser.promise;
  const run = app.flashDevice();
  app.currentVersion.value.files[0].file = new File(['replacement'], 'other-merged.bin');
  app.selected.wipe = true;
  chooser.resolve({});
  await run;
  delete globalThis.requestPort;
  assert.equal(globalThis.writtenFlash.fileArray[0].data, 'original');
  assert.equal(globalThis.writtenFlash.fileArray[0].address, 0x10000);
  assert.equal(globalThis.writtenFlash.eraseAll, false);
});

test('backend failure unlocks only after settlement and retry releases the exact instance', async t => {
  t.mock.method(console, 'error', () => {});
  const app = createSetup(structuredClone(config))();
  app.customFirmwareLoad({target:{files:[new File(['firmware'], 'firmware.zip')]}});
  const backend = deferred();
  const started = deferred();
  let closes = 0;
  const port = {async close() { closes++; }};
  globalThis.requestPort = async () => port;
  globalThis.dfuUpdate = (data, progress) => { progress(100); started.resolve(); return backend.promise; };
  const run = app.flashDevice();
  await started.promise;
  const instance = app.flashing.instance;
  await app.retry();
  const during = {busy: app.flashing.busy, sameInstance: app.flashing.instance === instance, closes};
  backend.reject(new Error('Disconnected'));
  await assert.doesNotReject(run);
  delete globalThis.requestPort;
  delete globalThis.dfuUpdate;
  assert.deepEqual(during, {busy:true, sameInstance:true, closes:0});
  assert.equal(app.flashing.busy, false);
  assert.match(app.flashing.error, /Disconnected/);
  assert.equal(instance.port.close, port.close);
  await app.retry();
  assert.equal(closes, 1);
  assert.equal(app.flashing.instance, null);
  assert.equal(app.flashing.active, false);
  assert.equal(app.flashing.error, '');
  assert.equal(app.flashing.percent, 0);
});

test('selection prefers main even after tags and defaults full flash for configured ESP32', () => {
  const app = createSetup(structuredClone(config))();
  const device = app.config.device.find(d => d.name === 'EtherMesh-1W');
  const firmware = device.firmware[0];
  firmware.version = { 'v1.2.0': structuredClone(firmware.version.main), main: firmware.version.main };
  app.selected.device = device;
  app.selectFirmware(firmware);
  assert.equal(app.selected.version, 'main');
  assert.equal(app.selected.wipe, true);
  app.selected.device = app.config.device.find(d => d.type === 'nrf52');
  app.selectFirmware(app.selected.device.firmware[0]);
  assert.equal(app.selected.wipe, false);
});

test('rendered device order pins EtherMesh and Photon before alphabetic remainder', () => {
  const app = createSetup(structuredClone(config))();
  assert.deepEqual(app.devices.value.slice(0, 2).map(d => d.name), ['EtherMesh-1W', 'Photon-1W XAIO ESP32 C6']);
  const names = app.devices.value.slice(2).map(d => d.name);
  assert.deepEqual(names, [...names].sort((a,b) => a.localeCompare(b, undefined, {sensitivity:'base', numeric:true})));
});

test('application downloads selected tagged multi-image plan and sends every address to loader', async () => {
  const app = createSetup(structuredClone(config))();
  app.selected.device = app.config.device.find(d => d.name === 'UnitEng/BQ Voyage Station G3');
  app.selectFirmware(app.selected.device.firmware[0]);
  app.selected.firmware.version.main.ref = 'v1.2.0';
  app.selected.wipe = true;
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(url); return {ok:true, blob:async () => new Blob(['firmware'])}; };
  await app.flashDevice();
  assert.deepEqual(globalThis.writtenFlash.fileArray.map(f => f.address), [0, 0x8000, 0x10000]);
  assert.equal(fetched.length, 3);
  assert.ok(fetched.every(url => url.includes('/v1.2.0/firmware/station_g3/')));
  assert.ok(app.downloads.value.every(file => file.href.includes('/v1.2.0/firmware/')));
});


test('custom merged BIN, update BIN and ZIP clear stale wipe state and retain their Blob', async () => {
  const app = createSetup(structuredClone(config))();
  const alerts = [];
  globalThis.alert = message => alerts.push(message);
  for(const [name, type, wipe, address] of [
    ['board-merged.bin', 'esp32', true, 0], ['firmware.bin', 'esp32', false, 0x10000], ['firmware.zip', 'nrf52', false, null],
  ]) {
    await app.retry();
    const file = new File(['bytes'], name);
    app.customFirmwareLoad({target:{files:[file]}});
    assert.equal(app.selected.device.type, type);
    assert.equal(app.selected.wipe, wipe);
    assert.equal(app.currentVersion.value.files[0].file, file);
    if(type === 'esp32') {
      await app.flashDevice();
      assert.equal(globalThis.writtenFlash.fileArray[0].address, address);
      assert.equal(globalThis.writtenFlash.eraseAll, wipe);
    } else {
      await app.flashDevice();
      assert.equal(globalThis.dfuBlob, file);
    }
  }
  assert.equal(alerts.length, 1);
  assert.doesNotThrow(() => app.customFirmwareLoad({target:{files:[]}}));
});
