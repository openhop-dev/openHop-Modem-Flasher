// Real Vue/app/backend admission with only the browser/serial/network boundaries replaced.
// The release and its assets below are synthetic test inputs, not published firmware.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserModule,hardwareStubs} from './modules.mjs';
import {firmwareFixture,hash,policy} from './p4-fixtures.mjs';
const baseline=JSON.parse(await readFile(new URL('../config.json',import.meta.url),'utf8'));
globalThis.location={host:'localhost',pathname:'/',search:''};
const listeners={};
globalThis.window={location,addEventListener(name,handler) {listeners[name]=handler;}};
globalThis.history={replaceState() {},pushState() {}};
globalThis.localStorage={getItem() {return null;}};
globalThis.alert=message => {throw Error(message);};
const stubs={...hardwareStubs,
  'js/serial.js':`export const serialSupported=true; export const serialAPI={requestPort:() => globalThis.p4IO.choose()};`,
  'lib/console.js':'export class SerialConsole {}',
  'lib/esp32.js':`export class Transport {
      constructor() {this.io=globalThis.p4IO;}
      async setRTS() {} async disconnect() {this.io.events.push('closed');}
    }
    export class HardReset {async reset() {}}
    export class ESPLoader {
      constructor(options) {
        this.transport=options.transport; this.io=globalThis.p4IO; this.IS_STUB=true;
        this.chip={CHIP_NAME:this.io.family??'ESP32-P4',getChipRevision:async () => {this.io.events.push('identify');return this.io.detect?this.io.detect():this.io.revision;}};
      }
      async main() {this.io.events.push('connect');}
      async flashId() {this.io.events.push('flash-id');}
      async readFlash(a,n) {this.io.events.push('read');return this.io.read?this.io.read(a,n):this.io.installed.slice(a,a+n);}
      async writeFlash(options) {this.io.events.push('write');this.io.writes.push(options);}
      async after() {this.io.events.push('reset');}
    }`,
};
const {createSetup}=await browserModule('js/app.js',stubs);
const base='https://raw.githubusercontent.com/openhop-dev/openhop_modem/v1.4.0/firmware';
function responsesFor(f) {
  const metadata=JSON.stringify(f.metadata)+'\n';
  const sums=[...Object.entries(f.metadata.parts).map(([name,p]) => `${p.sha256}  ${name}`),`${f.metadata.factory.sha256}  firmware.factory.bin`,`${hash(metadata)}  firmware.json`].join('\n')+'\n';
  const parts={'firmware.json':metadata,'SHA256SUMS.txt':sums,'firmware.factory.bin':f.factory,'firmware.bin':f.bytes['firmware.bin']};
  return Object.fromEntries(Object.entries(parts).map(([name,body]) => [`${base}/${f.metadata.environment}/${name}`,body]));
}
function appFor(board='ethermesh_1w',revision=302) {
  const config=structuredClone(baseline);
  for(const device of config.device) for(const fw of device.firmware) fw.version={'v1.4.0':{...fw.version.main,ref:'v1.4.0'}};
  const legacy=firmwareFixture(board,false), production=firmwareFixture(board,true);
  const io=globalThis.p4IO={revision,events:[],writes:[],requests:[],installed:revision<200?legacy.factory:production.factory};
  io.choose=() => {io.events.push('chooser');return Promise.resolve({});};
  io.responses={...responsesFor(legacy),...responsesFor(production)};
  globalThis.fetch=async url => {io.events.push('fetch');io.requests.push(url);return Object.hasOwn(io.responses,url)?new Response(io.responses[url]):new Response('missing fixture asset',{status:404});};
  const app=createSetup(config)();
  const name=board==='ethermesh_1w'?'EtherMesh-1W':'ESP32-P4 Nano';
  app.selected.device=app.config.device.find(d => d.name===name);
  app.selectFirmware(app.selected.device.firmware[0]);
  return {app,io,legacy,production};
}
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('P4 catalogue has one entry per physical board with both silicon alternatives', () => {
  for(const [name,board] of [['EtherMesh-1W','ethermesh_1w'],['ESP32-P4 Nano','esp32_p4_nano']]) {
    const devices=baseline.device.filter(d => d.name===name);
    assert.equal(devices.length,1);
    assert.deepEqual(devices[0].firmware[0].silicon,policy(board));
  }
});
test('P4 app detects v3.2 before downloads and writes only the production factory at zero', async () => {
  const {app,io,production}=appFor();
  const run=app.flashDevice();
  assert.deepEqual(io.events,['chooser']);
  assert.equal(app.flashing.busy,true);
  await run;
  assert.equal(app.flashing.error,'');
  assert.equal(io.writes.length,1);
  assert.equal(io.writes[0].eraseAll,true);
  assert.deepEqual(io.writes[0].fileArray.map(f => f.address),[0]);
  assert.equal(hash(io.writes[0].fileArray[0].data),production.metadata.factory.sha256);
  assert.ok(io.events.includes('identify') && io.events.indexOf('identify')<io.events.indexOf('fetch'));
  assert.ok(io.requests.every(url => url.includes('/v1.4.0/firmware/ethermesh_1w_v3/')));
  assert.match(app.flashing.target,/ESP32-P4 v3\.2.*production firmware/);
  assert.ok(io.events.indexOf('closed')>io.events.indexOf('write'));
});

for(const board of ['ethermesh_1w','esp32_p4_nano']) for(const revision of [100,302]) for(const wipe of [false,true]) {
  test(`${board} v${revision} ${wipe?'full install':'checked update'} writes only the admitted image`,async () => {
    const {app,io,legacy,production}=appFor(board,revision);
    app.selected.wipe=wipe;
    await app.flashDevice();
    assert.equal(app.flashing.error,'');
    assert.equal(io.writes.length,1);
    const metadata=(revision<200?legacy:production).metadata;
    assert.equal(io.writes[0].eraseAll,wipe);
    assert.deepEqual(io.writes[0].fileArray.map(f => f.address),[wipe?0:0x10000]);
    assert.equal(hash(io.writes[0].fileArray[0].data),wipe?metadata.factory.sha256:metadata.parts['firmware.bin'].sha256);
    assert.equal(io.events.includes('read'),!wipe);
    assert.ok(io.events.includes('identify') && io.events.indexOf('identify')<io.events.indexOf('fetch'));
  });
}
test('P4 offers no guessed legacy direct download before detecting silicon',() => {
  assert.deepEqual(appFor().app.downloads.value,[]);
});
test('P4 retry clears the previously detected target',async () => {
  const {app}=appFor();
  await app.flashDevice();
  await app.retry();
  assert.equal(app.flashing.target,'');
  assert.equal(app.flashing.instance,null);
});
for(const [label,change,reason] of [
  ['unknown revision',io => {io.revision=0;},/Unsupported ESP32-P4 revision/],
  ['literal v3.0',io => {io.revision=300;},/Unsupported ESP32-P4 revision/],
  ['failed detection',io => {io.detect=async () => {throw Error('identification failed');};},/Could not determine/],
  ['wrong chip',io => {io.family='ESP32-S3';},/requires ESP32-P4/],
  ['missing matching release',io => {delete io.responses[`${base}/ethermesh_1w_v3/firmware.json`];},/unavailable/],
  ['missing production image',io => {delete io.responses[`${base}/ethermesh_1w_v3/firmware.factory.bin`];},/unavailable/],
  ['metadata checksum mismatch',io => {io.responses[`${base}/ethermesh_1w_v3/firmware.json`]+=' ';},/SHA-256 mismatch/],
]) {
  test(`P4 ${label} cannot erase/write or fall back`,async t => {
    t.mock.method(console,'error',() => {});
    const {app,io}=appFor(); change(io);
    await app.flashDevice();
    assert.match(app.flashing.error,reason);
    assert.equal(io.writes.length,0);
    assert.ok(!io.events.includes('write'));
    assert.ok(io.events.includes('closed'));
    assert.equal(app.flashing.busy,false);
    assert.ok(io.requests.every(url => url.includes('/ethermesh_1w_v3/')));
  });
}
test('selecting a non-P4 catalogue board cannot bypass P4 compatibility admission',async t => {
  t.mock.method(console,'error',() => {});
  const {app,io}=appFor();
  app.selected.device=app.config.device.find(d => d.name==='Heltec V3');
  app.selectFirmware(app.selected.device.firmware[0]);
  for(const file of app.currentVersion.value.files) io.responses[`${base}/${file.name}`]=new Uint8Array([0xe9,0]);
  await app.flashDevice();
  assert.equal(io.writes.length,0);
  assert.match(app.flashing.error,/selected.*(P4|ESP32-P4)|P4.*selected/i);
});

for(const wipe of [true,false]) {
  test(`custom P4 ${wipe?'renamed factory':'application'} requires matching metadata and confirms the physical board`,async t => {
    const {app,io,production}=appFor();
    const bytes=wipe?production.factory:production.bytes['firmware.bin'];
    const bin=new File([bytes],'anything.bin');
    const metadata=new File([JSON.stringify(production.metadata)],'firmware.json');
    globalThis.confirm=message => {io.events.push('confirm');assert.match(message,/EtherMesh-1W/);assert.match(message,wipe?/eras(es|e).*settings/i:/firmware.only/i);return true;};
    app.customFirmwareLoad({target:{files:[bin,metadata]}});
    await app.flashDevice();
    assert.equal(app.flashing.error,'');
    assert.equal(io.requests.length,0,'custom files must not fetch a catalogue release');
    assert.equal(io.writes.length,1);
    assert.equal(io.writes[0].eraseAll,wipe);
    assert.deepEqual(io.writes[0].fileArray.map(f => f.address),[wipe?0:0x10000]);
    assert.equal(hash(io.writes[0].fileArray[0].data),hash(bytes));
    assert.equal(io.events.filter(e => e==='confirm').length,1);
    assert.ok(io.events.indexOf('confirm')<io.events.indexOf('write'));
  });
}
test('a custom P4 BIN without compatibility metadata cannot write',async t => {
  t.mock.method(console,'error',() => {});
  const {app,io,production}=appFor();
  app.customFirmwareLoad({target:{files:[new File([production.bytes['firmware.bin']],'firmware.bin')]}});
  await app.flashDevice();
  assert.equal(io.writes.length,0);
  assert.match(app.flashing.error,/firmware\.json/);
  assert.ok(io.events.includes('closed'));
});
test('declining custom P4 board/mode confirmation cannot erase/write',async t => {
  t.mock.method(console,'error',() => {});
  const {app,io,production}=appFor();
  globalThis.confirm=() => false;
  app.customFirmwareLoad({target:{files:[new File([production.factory],'renamed.bin'),new File([JSON.stringify(production.metadata)],'firmware.json')]}});
  await app.flashDevice();
  assert.equal(io.writes.length,0);
  assert.match(app.flashing.error,/cancelled before erase\/write/);
  assert.ok(io.events.includes('closed'));
});

test('P4 chooser, identification and downloads retain one frozen busy transaction',async () => {
  const {app,io,production}=appFor();
  const chooser=deferred(), detection=deferred(), detecting=deferred(), network=deferred(), downloading=deferred();
  io.choose=() => {io.events.push('chooser');return chooser.promise;};
  io.detect=() => {detecting.resolve();return detection.promise;};
  const fetch=globalThis.fetch;
  globalThis.fetch=async (...args) => {downloading.resolve();await network.promise;return fetch(...args);};
  const first=app.flashDevice();
  const second=app.flashDevice();
  app.currentVersion.value.ref='main';
  app.config.staticPath='/wrong-source';
  app.selected.firmware.silicon.profiles[1].environment='esp32_p4_nano_v3';
  app.selected.wipe=false;
  chooser.resolve({});
  await detecting.promise;
  assert.equal(app.flashing.phase,'detecting');
  assert.equal(io.writes.length,0);
  detection.resolve(302);
  await downloading.promise;
  assert.match(app.flashing.target,/EtherMesh-1W production/);
  app.stepBack(); app.selectFirmware(null); await app.retry(); listeners.popstate();
  assert.equal(app.flashing.busy,true);
  assert.equal(io.writes.length,0);
  const third=app.flashDevice();
  network.resolve();
  await Promise.all([first,second,third]);
  assert.equal(app.flashing.error,'');
  assert.equal(io.events.filter(e => e==='chooser').length,1);
  assert.equal(io.writes.length,1);
  assert.equal(io.writes[0].eraseAll,true);
  assert.equal(hash(io.writes[0].fileArray[0].data),production.metadata.factory.sha256);
  assert.ok(io.requests.every(url => url.startsWith(base+'/ethermesh_1w_v3/')));
});
