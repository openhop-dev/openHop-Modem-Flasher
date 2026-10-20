import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModule } from './modules.mjs';
import { inflateSync } from 'node:zlib';

const realFlash = await browserModule('js/flash.js', { 'lib/dfu.js': 'export class Dfu {}' });

for (const eraseAll of [false, true]) {
  test(`real backend preserves every binary byte through vendor compression (erase=${eraseAll})`, async () => {
    const bytes = Uint8Array.from({ length: 65539 }, (_, i) => i % 256);
    const images = (eraseAll ? [0, 0x8000, 0x10000] : [0x10000]).map(address => ({ address, data: new Blob([bytes]) }));
    const writes = [];
    let erased = 0, disconnected = false;
    const progress = [];
    await realFlash.flashEsp32({ getInfo: () => ({}) }, images, {
      eraseAll, terminal: { clean() {}, write() {}, writeLine() {} },
      onProgress: value => progress.push(value),
      onLoader(loader) {
        // Replace device I/O only; retain real writeFlash, padding and compression.
        loader.chip = loader.romFromChipId(18);
        loader.IS_STUB = true;
        loader.main = async () => {};
        loader.flashId = async () => {};
        loader.after = async () => {};
        loader.eraseFlash = async () => { erased++; };
        loader.flashDeflBegin = async (size, compressed, address) => {
          writes.push({ size, address, blocks: [] });
          return Math.ceil(compressed / loader.FLASH_WRITE_SIZE);
        };
        loader.flashDeflBlock = async block => { writes.at(-1).blocks.push(block); };
        loader.flashDeflFinish = async () => {};
        loader.transport.setRTS = async () => {};
        loader.transport.disconnect = async () => { disconnected = true; };
      },
    });
    assert.equal(erased, eraseAll ? 1 : 0);
    assert.deepEqual(writes.map(w => w.address), images.map(i => i.address));
    for (const write of writes) {
      const decoded = inflateSync(Buffer.concat(write.blocks));
      assert.deepEqual(decoded.subarray(0, bytes.length), Buffer.from(bytes));
      assert.equal(decoded.length, 65540);
      assert.equal(decoded.at(-1), 255, 'only alignment padding may be added');
    }
    assert.equal(progress.at(-1), 100);
    assert.equal(disconnected, true);
  });
}

// Exercise the shipped vendor bundle, not a replacement ESP loader.
const { ESPLoader } = await browserModule('lib/esp32.js');
function fixture(revision, { secure = false, xpd = false, date = 0 } = {}) {
  const loader = new ESPLoader({ transport: { getInfo: () => ({}) }, baudrate: 115200,
    terminal: { clean() {}, write() {}, writeLine() {} } });
  assert.equal(typeof loader.romFromChipId, 'function', 'loader must support current P4 chip identification');
  const chip = loader.romFromChipId(18);
  assert.equal(chip.CHIP_NAME, 'ESP32-P4');
  const writes = [];
  const registers = new Map([
    [chip.EFUSE_RD_REPEAT_DATA1_REG, xpd ? chip.EFUSE_DOWNLOAD_MODE_XPD_ON_MASK : 0],
    [chip.PMU_DATE_REG, date],
  ]);
  chip.getChipRevision = async () => revision;
  loader.usesUsbOtg = async () => false;
  chip.usesUsbJtagSerial = async () => false;
  loader.secureDownloadMode = secure;
  loader.readReg = async address => registers.get(address) ?? 0;
  loader.writeReg = async (address, value) => { writes.push([address, value]); registers.set(address, value); };
  return { loader, chip, writes, registers };
}

for (const revision of [301, 302]) {
  test(`P4 revision ${revision}: postConnect powers flash before attachment`, async () => {
    const { loader, chip, writes, registers } = fixture(revision);
    await chip.postConnect(loader);
    assert.deepEqual(writes[0], [chip.LP_SYSTEM_REG_ANA_XPD_PAD_GROUP_REG, 1]);
    assert.equal(registers.get(chip.PMU_DATE_REG) & chip.PMU_DATE_FLASH_FORCE_ON, chip.PMU_DATE_FLASH_FORCE_ON);
    assert.equal(writes.length, 8);
  });
}

for (const revision of [0, 100, 300, 303]) {
  test(`P4 revision ${revision}: leaves flash power registers untouched`, async () => {
    const { loader, chip, writes } = fixture(revision);
    await chip.postConnect(loader);
    assert.deepEqual(writes, []);
  });
}

test('P4 v3.2 XPD eFuse: releases force-on without repeating power-up or changing other bits', async () => {
  const { loader, chip, writes } = fixture(302, { xpd: true, date: 0x123 });
  await chip.postConnect(loader);
  assert.deepEqual(writes, [[chip.PMU_DATE_REG, 0x120]]);
});

test('P4 v3.2 XPD eFuse: already-released state needs no writes', async () => {
  const { loader, chip, writes } = fixture(302, { xpd: true, date: 0x120 });
  await chip.postConnect(loader);
  assert.deepEqual(writes, []);
});

test('P4 secure download mode skips flash-power access', async () => {
  const { loader, chip, writes } = fixture(301, { secure: true });
  chip.getChipRevision = async () => { throw new Error('must not read protected registers'); };
  await chip.postConnect(loader);
  assert.deepEqual(writes, []);
});
