import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModule } from './modules.mjs';
import { firmwareFixture, hash } from './p4-fixtures.mjs';

const p4 = await browserModule('js/p4.js').catch(error => {
  if(error.code === 'ENOENT') return {};
  throw error;
});
const select = p4.selectP4Profile ?? (async () => null);
const admit = p4.admitP4Image ?? (async () => []);
const loadBundle = p4.loadP4Bundle ?? (async () => []);
const policy = boardId => ({boardId, profiles:[
  {profile:'pre_v3', environment:boardId, minRevision:1, maxRevision:199},
  {profile:'v3', environment:`${boardId}_v3`, minRevision:301, maxRevision:399},
]});
const chip = revision => ({chip:{CHIP_NAME:'ESP32-P4', getChipRevision:async () => revision}});

test('a matching P4 factory bundle is admitted intact at zero', async () => {
  const {metadata,blob} = firmwareFixture();
  const target = await select(chip(302),policy('ethermesh_1w'));
  assert.deepEqual(await admit(metadata,target,blob,{wipe:true}), [{data:blob,address:0}]);
});

test('connected P4 v3.2 selects the production environment for the physical board', async () => {
  const selected = await select(chip(302), policy('ethermesh_1w'));
  assert.deepEqual(selected, {
    boardId:'ethermesh_1w', environment:'ethermesh_1w_v3', profile:'v3',
    minRevision:301, maxRevision:399, chipVariant:'esp32p4',
    revision:302, revisionLabel:'v3.2', label:'production firmware',
  });
});

function bundleResponses(fixture) {
  const metadata=JSON.stringify(fixture.metadata)+'\n';
  const sums=[...Object.entries(fixture.metadata.parts).map(([name,p]) => `${p.sha256}  ${name}`),`${fixture.metadata.factory.sha256}  firmware.factory.bin`,`${hash(metadata)}  firmware.json`].join('\n')+'\n';
  return {'/firmware.json':metadata,'/SHA256SUMS.txt':sums,'/firmware.factory.bin':fixture.factory,'/firmware.bin':fixture.bytes['firmware.bin']};
}
const urls={metadata:'/firmware.json',checksums:'/SHA256SUMS.txt',factory:'/firmware.factory.bin',application:'/firmware.bin'};

test('P4 downloads and verifies the matching metadata, checksums and complete factory', async t => {
  const f=firmwareFixture(), responses=bundleResponses(f), fetched=[];
  t.mock.method(globalThis,'fetch',async url => {fetched.push(url);return new Response(responses[url],{status:200});});
  const target={...await select(chip(302),policy('ethermesh_1w')),urls};
  const images=await loadBundle(target,{wipe:true,loader:chip(302)});
  assert.equal(images.length,1);
  assert.equal(images[0].address,0);
  assert.equal(hash(new Uint8Array(await images[0].data.arrayBuffer())),f.metadata.factory.sha256);
  assert.deepEqual(fetched.toSorted(),['/SHA256SUMS.txt','/firmware.factory.bin','/firmware.json']);
});

for(const [label,change] of [
  ['missing metadata',r => {r['/firmware.json']=new Response('not found',{status:404});}],
  ['missing checksums',r => {r['/SHA256SUMS.txt']=new Response('not found',{status:404});}],
  ['altered metadata',r => {r['/firmware.json']=r['/firmware.json'].replace('3.3.11','3.3.12');}],
  ['empty checksums',r => {r['/SHA256SUMS.txt']='';}],
  ['missing component checksum',r => {r['/SHA256SUMS.txt']=r['/SHA256SUMS.txt'].split('\n').filter(line => !line.endsWith('boot_app0.bin')).join('\n');}],
  ['incorrect component checksum',r => {r['/SHA256SUMS.txt']=r['/SHA256SUMS.txt'].replace(/^[0-9a-f]{64}/,'0'.repeat(64));}],
  ['duplicate checksum names',r => {r['/SHA256SUMS.txt']+=r['/SHA256SUMS.txt'].split('\n')[0]+'\n';}],
  ['malformed checksum line',r => {r['/SHA256SUMS.txt']+='not-a-hash  firmware.bin\n';}],
  ['factory HTTP failure',r => {r['/firmware.factory.bin']=new Response(r['/firmware.factory.bin'],{status:503});}],
  ['oversized declared metadata',r => {r['/firmware.json']=new Response(r['/firmware.json'],{headers:{'Content-Length':'1000000'}});}],
]) {
  test(`P4 catalogue bundle stops for ${label}`, async t => {
    const f=firmwareFixture(), responses=bundleResponses(f); change(responses);
    t.mock.method(globalThis,'fetch',async url => responses[url] instanceof Response ? responses[url] : new Response(responses[url]));
    const target={...await select(chip(302),policy('ethermesh_1w')),urls};
    await assert.rejects(loadBundle(target,{wipe:true,loader:chip(302)}),/P4 bundle rejected/);
  });
}
test('P4 metadata streaming is bounded and cancelled before an oversized body finishes', async t => {
  const f=firmwareFixture(), responses=bundleResponses(f);
  let cancelled=false, pulls=0;
  const body=new ReadableStream({pull(controller) {pulls++;controller.enqueue(new Uint8Array(8192).fill(32));if(pulls===32) controller.close();},cancel() {cancelled=true;}});
  t.mock.method(globalThis,'fetch',async url => url === '/firmware.json' ? new Response(body) : new Response(responses[url]));
  const target={...await select(chip(302),policy('ethermesh_1w')),urls};
  await assert.rejects(loadBundle(target,{wipe:true,loader:chip(302)}),/P4 bundle rejected:.*(size|large)/);
  assert.equal(cancelled,true);
  assert.ok(pulls<32,'must reject before allocating the entire body');
});

test('a matching installed P4 bootloader and partition table permit an app-only update', async () => {
  const f=firmwareFixture(), reads=[];
  const loader={...chip(302),IS_STUB:true,readFlash:async (address,size) => {reads.push([address,size]); return f.factory.slice(address,address+size);}};
  const target=await select(loader,policy('ethermesh_1w'));
  const blob=new Blob([f.bytes['firmware.bin']]);
  assert.deepEqual(await admit(f.metadata,target,blob,{wipe:false,loader}),[{data:blob,address:0x10000}]);
  assert.deepEqual(reads,[[0x2000,0x8000+f.metadata.parts['partitions.bin'].size-0x2000]]);
});

for(const [label,change] of [
  ['no stub',loader => {loader.IS_STUB=false;}],
  ['read API missing',loader => {delete loader.readFlash;}],
  ['read failure',loader => {loader.readFlash=async () => {throw Error('transport read failed');};}],
  ['short read',loader => {loader.readFlash=async () => new Uint8Array(1);}],
  ['wrong bootloader',loader => {loader.readFlash=async (_,size) => new Uint8Array(size);}],
]) {
  test(`P4 app-only ${label} stops with an explicit full-install remedy`, async () => {
    const f=firmwareFixture();
    const loader={...chip(302),IS_STUB:true,readFlash:async (a,n) => f.factory.slice(a,a+n)};
    change(loader);
    const target=await select(loader,policy('ethermesh_1w'));
    await assert.rejects(admit(f.metadata,target,new Blob([f.bytes['firmware.bin']]),{wipe:false,loader}),/P4 bundle rejected:.*Erase Device/);
  });
}
test('P4 installed-contract read has a bounded deadline', async t => {
  let deadline;
  const token={};
  t.mock.method(globalThis,'setTimeout',callback => {deadline=callback;return token;});
  t.mock.method(globalThis,'clearTimeout',id => {assert.equal(id,token);});
  let reading;
  const started=new Promise(resolve => {reading=resolve;});
  const f=firmwareFixture();
  const loader={...chip(302),IS_STUB:true,readFlash:() => {reading();return new Promise(() => {});}};
  const target=await select(loader,policy('ethermesh_1w'));
  const run=admit(f.metadata,target,new Blob([f.bytes['firmware.bin']]),{wipe:false,loader});
  run.catch(() => {});
  await started;
  assert.equal(typeof deadline,'function','readback needs a deadline, not an infinite busy lock');
  deadline();
  await assert.rejects(run,/P4 bundle rejected:.*timed out.*Erase Device/);
});

for(const [label,change] of [
  ['numeric SDK version',f => {f.metadata.framework.esp_idf=555;}],
  ['nonstring SDK package',f => {f.metadata.framework.idf_package={};}],
  ['schema',f => {f.metadata.schema_version=2;}],
  ['board identity',f => {f.metadata.board_id='esp32_p4_nano';}],
  ['environment',f => {f.metadata.environment='ethermesh_1w';}],
  ['silicon profile',f => {f.metadata.silicon.profile='pre_v3';}],
  ['silicon board',f => {f.metadata.silicon.board_id='esp32_p4_nano';}],
  ['SDK variant',f => {f.metadata.silicon.chip_variant='esp32p4_es';}],
  ['SDK revision range',f => {f.metadata.silicon.min_revision=0;}],
  ['resolved SDK bounds',f => {f.metadata.framework.sdkconfig.CONFIG_ESP_REV_MIN_FULL='1';}],
  ['package/application version',f => {f.metadata.framework.idf_package='5.5.4+sha.fixture';}],
  ['flash size',f => {f.metadata.settings.flash_size_bytes=8*1024*1024;}],
  ['component missing',f => {delete f.metadata.parts['boot_app0.bin'];}],
  ['bootloader offset',f => {f.metadata.parts['bootloader.bin'].offset=0;}],
  ['overlapping bootloader',f => {f.metadata.parts['bootloader.bin'].size=0x8000;}],
  ['empty component',f => {f.metadata.parts['firmware.bin'].size=0;}],
  ['factory path',f => {f.metadata.factory.path='../firmware.factory.bin';}],
  ['factory offset',f => {f.metadata.factory.offset=0x2000;}],
  ['component checksum',f => {f.metadata.parts['firmware.bin'].sha256='f'.repeat(64);}],
  ['factory checksum',f => {f.metadata.factory.sha256='0'.repeat(64);}],
  ['update bootloader proof',f => {f.metadata.update_contract.bootloader_sha256='0'.repeat(64);}],
  ['update board proof',f => {f.metadata.update_contract.board_id='esp32_p4_nano';}],
  ['update profile proof',f => {f.metadata.update_contract.silicon_profile='pre_v3';}],
]) {
  test(`P4 factory rejects mismatched ${label}`, async () => {
    const fixture=firmwareFixture(); change(fixture);
    const target=await select(chip(302),policy('ethermesh_1w'));
    await assert.rejects(admit(fixture.metadata,target,new Blob([fixture.factory]),{wipe:true}),/P4 bundle rejected/);
  });
}

function updatePart(fixture,name) {
  const part=fixture.metadata.parts[name];
  part.sha256=hash(fixture.bytes[name]);
  fixture.factory.set(fixture.bytes[name],part.offset);
  fixture.metadata.factory.sha256=hash(fixture.factory);
  if(name==='bootloader.bin') fixture.metadata.update_contract.bootloader_sha256=part.sha256;
  if(name==='partitions.bin') fixture.metadata.update_contract.partitions_sha256=part.sha256;
}
for(const [label,change] of [
  ['embedded component',f => {f.factory[0x2000+20]^=1; f.metadata.factory.sha256=hash(f.factory);}],
  ['wrong image chip',f => {f.bytes['bootloader.bin'][12]=9; updatePart(f,'bootloader.bin');}],
  ['image-header revision excludes hardware',f => {new DataView(f.bytes['bootloader.bin'].buffer).setUint16(17,199,true); f.metadata.parts['bootloader.bin'].image_header.max_revision=199; updatePart(f,'bootloader.bin');}],
  ['application SDK identity',f => {f.bytes['firmware.bin'].set(new TextEncoder().encode('v5.5.4'),144); updatePart(f,'firmware.bin');}],
  ['unpatched production SDK',f => {f.metadata.framework.esp_idf='v5.5.4'; f.metadata.framework.idf_package='5.5.4+sha.fixture'; f.bytes['firmware.bin'].set(new TextEncoder().encode('v5.5.4'),144); updatePart(f,'firmware.bin');}],
  ['partition overlap',f => {new DataView(f.bytes['partitions.bin'].buffer).setUint32(3*32+4,0x18000,true); updatePart(f,'partitions.bin');}],
  ['too-small OTA slot',f => {new DataView(f.bytes['partitions.bin'].buffer).setUint32(3*32+8,128,true); updatePart(f,'partitions.bin');}],
  ['missing OTA initialization',f => {f.bytes['partitions.bin'][32+3]=2; updatePart(f,'partitions.bin');}],
]) {
  test(`P4 factory rejects coherently checksummed but incompatible ${label}`, async () => {
    const fixture=firmwareFixture(); change(fixture);
    const target=await select(chip(302),policy('ethermesh_1w'));
    await assert.rejects(admit(fixture.metadata,target,new Blob([fixture.factory]),{wipe:true}),/P4 bundle rejected/);
  });
}

for(const board of ['ethermesh_1w','esp32_p4_nano']) {
  for(const revision of [1,199,301,399]) {
    test(`${board} revision ${revision} selects its own inclusive profile`, async () => {
      const selected = await select(chip(revision), policy(board));
      assert.equal(selected.environment, revision < 200 ? board : `${board}_v3`);
      assert.equal(selected.chipVariant, revision < 200 ? 'esp32p4_es' : 'esp32p4');
      assert.equal(selected.revision, revision);
    });
  }
}
for(const revision of [0,200,300,400,-1,undefined,null,'302',302.1,NaN,Infinity]) {
  test(`P4 rejects unsupported or unreadable revision ${String(revision)}`, async () => {
    await assert.rejects(select(chip(revision), policy('ethermesh_1w')), /Unsupported ESP32-P4 revision|Could not determine ESP32-P4 revision/);
  });
}
test('wrong chip family cannot be admitted as P4', async () => {
  let reads = 0;
  await assert.rejects(select({chip:{CHIP_NAME:'ESP32-S3',getChipRevision:async () => {reads++; return 302;}}},policy('ethermesh_1w')), /requires ESP32-P4/);
  assert.equal(reads,0);
});
test('secure download mode stops before protected revision access', async () => {
  let reads = 0;
  const loader = chip(302);
  loader.secureDownloadMode = true;
  loader.chip.getChipRevision = async () => {reads++; return 302;};
  await assert.rejects(select(loader,policy('ethermesh_1w')), /Secure Download Mode/);
  assert.equal(reads,0);
});
test('revision read failure reports identification failure rather than selecting legacy', async () => {
  const loader = chip(302);
  loader.chip.getChipRevision = async () => {throw Error('eFuse read failed');};
  await assert.rejects(select(loader,policy('ethermesh_1w')), /Could not determine ESP32-P4 revision.*eFuse read failed/);
});
for(const change of [
  p => {p.profiles[0]=null;},
  p => {p.boardId='unknown';},
  p => {p.profiles[1].environment='esp32_p4_nano_v3';},
  p => {p.profiles[0].maxRevision=399;},
  p => {p.profiles.push({...p.profiles[1]});},
]) {
  test('malformed board/profile alternatives are never used for admission', async () => {
    const rules = policy('ethermesh_1w'); change(rules);
    await assert.rejects(select(chip(302),rules), /Invalid P4 silicon profile configuration/);
  });
}
