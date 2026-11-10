// Host-only production catalogue/Vue/app/flash harness. No serial or network I/O.
// Chip/revision and writes are simulated; installed reads use the supplied factory bytes.
import {readFile} from 'node:fs/promises';
import {browserModule,hardwareStubs} from './modules.mjs';

export const baseline=JSON.parse(await readFile(new URL('../config.json',import.meta.url),'utf8'));
export const candidateTag='v1.4.2'; // Injected discovery fixture, NOT a published release assertion.
const stubs={...hardwareStubs,
  'js/serial.js':`export const serialSupported=true; export const serialAPI={requestPort:() => globalThis.p4Boundary.choose()};`,
  'lib/console.js':'export class SerialConsole {}',
  'lib/esp32.js':`export class Transport {
      constructor() {this.io=globalThis.p4Boundary;}
      async setRTS() {} async disconnect() {this.io.events.push('closed');}
    }
    export class HardReset {async reset() {}}
    export class ESPLoader {
      constructor(options) {
        this.transport=options.transport; this.io=globalThis.p4Boundary; this.IS_STUB=true;
        this.chip={CHIP_NAME:this.io.family,getChipRevision:async () => {
          this.io.events.push('identify'); return this.io.detect?this.io.detect():this.io.revision;
        }};
      }
      async main() {this.io.events.push('connect');}
      async flashId() {this.io.events.push('flash-id');}
      async readFlash(address,length) {
        this.io.events.push('read'); this.io.reads.push([address,length]);
        return this.io.read?this.io.read(address,length):this.io.installed.slice(address,address+length);
      }
      async writeFlash(options) {this.io.events.push('write');this.io.writes.push(options);}
      async after() {this.io.events.push('reset');}
    }`,
};
let modules;
export async function appHarness({boardId,revision=302,assets={},installed=new Uint8Array(),releases=[{tag_name:candidateTag}]}={}) {
  globalThis.location={host:'localhost',pathname:'/',search:''};
  const listeners={};
  globalThis.window={location,addEventListener:(name,handler) => {listeners[name]=handler;}};
  globalThis.history={replaceState() {},pushState() {}};
  globalThis.localStorage={getItem() {return null;},setItem() {}};
  globalThis.alert=message => {throw Error(`unexpected alert: ${message}`);};
  const io=globalThis.p4Boundary={revision,family:'ESP32-P4',installed,events:[],writes:[],reads:[],requests:[],catalogRequests:[],confirmations:[],assets};
  io.choose=() => {io.events.push('chooser');return Promise.resolve({});};
  globalThis.confirm=message => {io.events.push('confirm');io.confirmations.push(message);return io.confirmResult??true;};
  globalThis.fetch=async url => {
    if(url==='/config.json') {io.catalogRequests.push(url);return new Response(JSON.stringify(baseline));}
    if(url===baseline.firmwareReleases.api) {io.catalogRequests.push(url);return new Response(JSON.stringify(releases));}
    io.events.push('fetch'); io.requests.push(url);
    const prefix=baseline.staticPath.replace('/main/firmware',`/${candidateTag}/firmware`)+'/';
    const name=typeof url==='string' && url.startsWith(prefix)?url.slice(prefix.length):null;
    return name && Object.hasOwn(io.assets,name)?new Response(io.assets[name]):new Response('missing local test/candidate asset',{status:404});
  };
  // Always execute the current checkout, even if an unrelated TEST_REVISION is set.
  modules??={catalog:await browserModule('js/catalog.js',{},null),app:await browserModule('js/app.js',stubs,null)};
  const config=await modules.catalog.loadCatalog();
  const app=modules.app.createSetup(config)();
  if(boardId) {
    const device=config.device.find(d => d.firmware.some(fw => fw.silicon?.boardId===boardId));
    if(!device) throw Error(`No eligible catalogue device for ${boardId}`);
    app.selected.device=device;
    app.selectFirmware(device.firmware.find(fw => fw.silicon?.boardId===boardId));
  }
  return {app,io,listeners};
}

export async function boundedFlash(app,timeoutMs=10000) {
  let timer;
  try {
    await Promise.race([app.flashDevice(),new Promise((_,reject) => {
      timer=setTimeout(() => reject(Error(`Host admission exceeded ${timeoutMs} ms`)),timeoutMs);
    })]);
  }
  finally {clearTimeout(timer);}
}
