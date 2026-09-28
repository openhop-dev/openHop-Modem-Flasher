import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserModule } from './modules.mjs';

test('DFU rejected read propagates the original error and cancels its timeout', async () => {
  const {Dfu} = await browserModule('lib/dfu.js', {'lib/zip.min.js':'export const unused = true;'});
  const error = new Error('device disconnected');
  let released = false;
  const dfu = new Dfu({readable:{getReader:() => ({read:async () => {throw error;}, releaseLock() {released=true;}})}});
  const reader = dfu.getReader();
  await assert.rejects(reader.read(), e => e === error);
  reader.releaseLock();
  assert.equal(released,true);
});

test('serial backend uses Android WebUSB polyfill, desktop native serial, or unsupported', async () => {
  const source = await readFile(new URL('../js/serial.js',import.meta.url),'utf8');
  for(const [name, navigator, expected] of [
    ['android', {userAgent:'Android Chrome',usb:{}}, 'usb'],
    ['desktop', {userAgent:'Chrome Linux',serial:{kind:'native'}}, 'native'],
    ['unsupported', {userAgent:'Firefox'}, undefined],
  ]) {
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});
    const result = await browserModule('js/serial.js',{
      'js/serial.js':source + `\n// isolated ${name}`,
      'lib/polyfill/serial.js':'export const serial = {kind:"usb"};',
    },null);
    assert.equal(result.serialAPI?.kind,expected);
    assert.equal(result.serialSupported,Boolean(expected));
  }
});
