#!/usr/bin/env node
// Offline four-candidate acceptance through the production catalogue + app caller.
// No public release, physical device, serial port, erase, reset or RF is exercised.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open,readFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {appHarness,boundedFlash,baseline,candidateTag} from '../tests/p4-harness.mjs';

const boards=['esp32_p4_nano','ethermesh_1w'];
const componentNames=['bootloader.bin','partitions.bin','boot_app0.bin','firmware.bin'];
const digest=bytes => createHash('sha256').update(bytes).digest('hex');
const maxFlash=16*1024*1024;
async function boundedRead(path,limit) {
  const file=await open(path,'r');
  try {
    const stat=await file.stat();
    assert.ok(stat.isFile() && stat.size>0 && stat.size<=limit,`${path}: invalid/oversized file`);
    const data=Buffer.alloc(stat.size);
    let offset=0;
    while(offset<data.length) {
      const {bytesRead}=await file.read(data,offset,data.length-offset,null);
      assert.ok(bytesRead>0,`${path}: file changed/short read`);
      offset+=bytesRead;
    }
    assert.equal((await file.read(Buffer.alloc(1),0,1,null)).bytesRead,0,`${path}: file grew while reading`);
    return data;
  }
  finally {await file.close();}
}
async function readCandidate(root,board,production) {
  const environment=board+(production?'_v3':'');
  const files={};
  for(const name of ['firmware.json','SHA256SUMS.txt','firmware.factory.bin',...componentNames]) {
    const limit=name==='firmware.json'?64*1024:name==='SHA256SUMS.txt'?16*1024:maxFlash;
    files[name]=await boundedRead(join(root,environment,name),limit);
  }
  const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files['firmware.json']));
  assert.equal(metadata.board_id,board,`${environment}: physical board identity`);
  assert.equal(metadata.environment,environment,`${environment}: environment identity`);
  const sums=new Map();
  for(const line of files['SHA256SUMS.txt'].toString('utf8').split(/\r?\n/)) {
    if(!line) continue;
    const match=line.match(/^([0-9a-f]{64})[ \t]+\*?([a-zA-Z0-9_.-]+)$/);
    assert.ok(match && !sums.has(match[2]),`${environment}: invalid/duplicate checksum entry`);
    sums.set(match[2],match[1]);
  }
  for(const [name,bytes] of Object.entries(files)) {
    if(name!=='SHA256SUMS.txt') assert.equal(digest(bytes),sums.get(name),`${environment}/${name}: SHA-256 mismatch`);
  }
  for(const name of componentNames) {
    const part=metadata.parts?.[name];
    assert.ok(part,`${environment}/${name}: missing metadata component`);
    assert.equal(files[name].length,part.size,`${environment}/${name}: size mismatch`);
    assert.equal(digest(files[name]),part.sha256,`${environment}/${name}: metadata SHA-256 mismatch`);
    assert.equal(digest(files['firmware.factory.bin'].subarray(part.offset,part.offset+part.size)),part.sha256,
      `${environment}/${name}: factory slice mismatch`);
  }
  return {board,environment,revision:production?302:100,metadata,files};
}
async function checkAdmission(candidate,assets,path,mode) {
  const factory=mode==='factory', custom=path==='custom';
  const {app,io}=await appHarness({boardId:custom?null:candidate.board,revision:candidate.revision,
    assets,installed:candidate.files['firmware.factory.bin'],releases:custom?[{tag_name:'v1.4.1'}]:undefined});
  if(custom) {
    app.customFirmwareLoad({target:{files:[
      new File([candidate.files[factory?'firmware.factory.bin':'firmware.bin']],factory?'renamed.bin':'application-merged.bin'),
      new File([candidate.files['firmware.json']],'firmware.json'),
    ]}});
  }
  else {
    assert.equal(app.selected.version,candidateTag);
    assert.deepEqual(app.downloads.value,[]);
    app.selected.wipe=factory;
  }
  await boundedFlash(app);
  const label=`${candidate.environment} ${path}/${mode}`;
  assert.equal(app.flashing.error,'',`${label}: ${app.flashing.error}`);
  assert.equal(app.flashing.busy,false,`${label}: busy lock must release`);
  assert.equal(io.writes.length,1,`${label}: exactly one admitted write`);
  const options=io.writes[0];
  assert.equal(options.eraseAll,factory,`${label}: erase mode`);
  assert.deepEqual(options.fileArray.map(f => f.address),[factory?0:0x10000],`${label}: offset plan`);
  assert.ok(options.fileArray[0].data instanceof Uint8Array,`${label}: loader byte type`);
  const expected=candidate.files[factory?'firmware.factory.bin':'firmware.bin'];
  assert.equal(digest(options.fileArray[0].data),digest(expected),`${label}: exact loader bytes`);
  const boot=candidate.metadata.parts['bootloader.bin'], partitions=candidate.metadata.parts['partitions.bin'];
  assert.deepEqual(io.reads,factory?[]:[[boot.offset,partitions.offset+partitions.size-boot.offset]],`${label}: installed-contract read`);
  assert.ok(io.events.indexOf('identify')<io.events.indexOf('write'),`${label}: identify before write`);
  if(custom) {
    assert.deepEqual(io.requests,[],`${label}: custom must not fetch releases/assets`);
    assert.equal(io.confirmations.length,1,`${label}: physical-board confirmation`);
    const name=candidate.board==='ethermesh_1w'?'EtherMesh-1W':'ESP32-P4 Nano';
    assert.ok(io.confirmations[0].includes(name),`${label}: correct physical-board name`);
    assert.ok(io.events.indexOf('confirm')<io.events.indexOf('write'),`${label}: confirmation before write`);
  }
  else {
    const prefix=baseline.staticPath.replace('/main/firmware',`/${candidateTag}/firmware`)+`/${candidate.environment}/`;
    assert.deepEqual(io.requests.toSorted(),['firmware.json','SHA256SUMS.txt',factory?'firmware.factory.bin':'firmware.bin'].map(n => prefix+n).toSorted(),
      `${label}: matching board/profile only, no fallback`);
    assert.ok(io.events.indexOf('identify')<io.events.indexOf('fetch'),`${label}: identify before downloads`);
  }
  assert.ok(io.events.indexOf('closed')>io.events.indexOf('write'),`${label}: transport cleanup`);
  return {environment:candidate.environment,path,mode,eraseAll:options.eraseAll,address:options.fileArray[0].address,
    sha256:digest(options.fileArray[0].data),installedReads:io.reads,confirmations:io.confirmations};
}
async function main() {
  assert.equal(process.argv.length,3,'Usage: node scripts/check-p4-candidates.mjs <candidate-root>');
  const root=await realpath(resolve(process.argv[2]));
  const candidates=[];
  // Preflight all four before performing even simulated write admission.
  for(const board of boards) for(const production of [false,true]) candidates.push(await readCandidate(root,board,production));
  const assets={};
  for(const c of candidates) for(const [name,bytes] of Object.entries(c.files)) assets[`${c.environment}/${name}`]=bytes;
  const admissions=[];
  for(const candidate of candidates) for(const path of ['catalogue','custom']) for(const mode of ['factory','application']) {
    admissions.push(await checkAdmission(candidate,assets,path,mode));
  }
  assert.equal(candidates.length,4); assert.equal(admissions.length,16);
  const sourceSha256={};
  for(const name of ['config.json','js/app.js','js/p4.js','js/catalog.js','js/flash.js','js/router.js','js/util.js','js/site.js',
    'js/commands.js','lib/version.js','lib/vue.prod.min.js','tests/p4-harness.mjs','tests/modules.mjs','scripts/check-p4-candidates.mjs']) {
    sourceSha256[name]=digest(await readFile(new URL('../'+name,import.meta.url)));
  }
  console.log(JSON.stringify({candidateRoot:root,candidateCount:candidates.length,hardwareAccess:false,
    inputBoundary:'Caller-supplied candidate bytes, not independently authenticated; no firmware is generated by this driver.',
    releaseDiscoveryBoundary:`Simulated ${candidateTag} discovery for offline candidate admission; not a published release assertion. Production config/fallbacks are unchanged.`,
    installedReadBoundary:'Loader installed-flash reads are simulated from the supplied actual factory bytes, not hardware.',
    confirmationBoundary:'Physical-board confirmation is simulated accepted; hardware board identity is not detected.',
    sourceSha256,environments:candidates.map(c => ({environment:c.environment,revision:c.revision,profile:c.metadata.silicon.profile,
      files:Object.fromEntries(Object.entries(c.files).map(([name,bytes]) => [name,{size:bytes.length,sha256:digest(bytes)}]))})),admissions},null,2));
}
const deadline=setTimeout(() => {console.error('P4 candidate admission exceeded 120 seconds');process.exit(1);},120000);
try {await main();}
catch(error) {console.error(`P4 candidate admission failed: ${error.message}`);process.exitCode=1;}
finally {clearTimeout(deadline);}
