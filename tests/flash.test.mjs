import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModule, hardwareStubs } from './modules.mjs';
const flash = await browserModule('js/flash.js', hardwareStubs);

test('ESP32 configured partition offsets override inferred wipe address', () => {
  assert.equal(flash.esp32Address({ type: 'flash-wipe', address: 0x8000 }), 0x8000);
});

test('full flash selects and writes every image, preserving explicit offsets', async () => {
  const files = [
    { type: 'flash-update', address: 0x10000 },
    ...[0, 0x8000, 0x10000].map((address, i) => ({ type: 'flash-wipe', address, file: new Blob([new Uint8Array([i, 255])]) })),
  ];
  const picked = flash.pickFlashFiles(files, { esp32: true, wipe: true });
  assert.deepEqual(picked, files.slice(1));
  await flash.flashEsp32({}, picked.map(file => ({ data: file.file, address: flash.esp32Address(file) })), {
    eraseAll: true, onProgress() {},
  });
  assert.deepEqual(globalThis.writtenFlash.fileArray, [0, 0x8000, 0x10000].map((address, i) => ({ address, data: String.fromCharCode(i, 255) })));
  assert.equal(globalThis.writtenFlash.eraseAll, true);
});


test('P4 factory image stays at zero; updates never include wipe images', () => {
  const files = [{type:'flash-update', address:0x10000}, {type:'flash-wipe', name:'firmware.factory.bin', address:0}];
  assert.deepEqual(flash.pickFlashFiles(files, {esp32:true,wipe:false}), [files[0]]);
  assert.equal(flash.esp32Address(flash.pickFlashFiles(files, {esp32:true,wipe:true})[0]), 0);
  assert.deepEqual(flash.pickFlashFiles([files[0]], {esp32:true,wipe:true}), []);
});


test('every configured ESP32 board preserves both full-flash and update plans', async () => {
  const {readFile} = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../config.json',import.meta.url),'utf8'));
  for(const device of config.device.filter(d => d.type === 'esp32')) {
    for(const firmware of device.firmware) {
      for(const wipe of [false,true]) {
        const files = firmware.version.main.files;
        const expected = files.filter(f => f.type === (wipe ? 'flash-wipe':'flash-update'));
        assert.deepEqual(flash.pickFlashFiles(files,{esp32:true,wipe}),expected,device.name);
        assert.deepEqual(expected.map(flash.esp32Address),expected.map(f => f.address),device.name);
      }
    }
  }
});
