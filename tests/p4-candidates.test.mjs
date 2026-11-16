// This driver test uses SYNTHETIC fixtures, not flashable producer images.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {firmwareFixture,hash} from './p4-fixtures.mjs';
const script=new URL('../scripts/check-p4-candidates.mjs',import.meta.url);
const boards=['esp32_p4_nano','ethermesh_1w'];
function run(...args) {
  return spawnSync(process.execPath,[script.pathname,...args],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
}

test('four-candidate driver has a bounded caller-supplied-root interface',() => {
  assert.equal(existsSync(script),true,'provide scripts/check-p4-candidates.mjs');
  const result=run();
  assert.equal(result.status,1);
  assert.match(result.stderr,/Usage:.*check-p4-candidates\.mjs.*candidate-root/);
});

test('four-candidate driver exercises catalogue/custom factory/app admission and rejects altered or incomplete inputs',async () => {
  assert.equal(existsSync(script),true,'driver must exist before exercising synthetic inputs');
  const root=await mkdtemp(join(process.env.TMPDIR??'/home/yellowcooln/.hermes/cache/scratch','flasher-four-synthetic-'));
  try {
    for(const board of boards) for(const production of [false,true]) {
      const f=firmwareFixture(board,production), folder=join(root,f.metadata.environment);
      await mkdir(folder);
      const files={...f.bytes,'firmware.factory.bin':f.factory,'firmware.json':JSON.stringify(f.metadata)+'\n'};
      const sums=Object.entries(files).map(([name,body]) => `${hash(body)}  ${name}`).join('\n')+'\n';
      for(const [name,body] of Object.entries({...files,'SHA256SUMS.txt':sums})) await writeFile(join(folder,name),body);
    }
    const result=run(root);
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(result.stdout);
    assert.equal(report.candidateCount,4);
    assert.equal(report.admissions.length,16);
    assert.equal(report.hardwareAccess,false);
    assert.match(report.installedReadBoundary,/simulated.*factory bytes/i);
    assert.match(report.releaseDiscoveryBoundary,/simulated.*v1\.4\.2.*not.*published/i);
    assert.deepEqual(report.environments.map(e => e.environment).toSorted(),boards.flatMap(b => [b,`${b}_v3`]).toSorted());
    for(const env of report.environments) {
      const admissions=report.admissions.filter(a => a.environment===env.environment);
      assert.deepEqual(admissions.map(a => `${a.path}/${a.mode}`).toSorted(),
        ['catalogue/application','catalogue/factory','custom/application','custom/factory']);
      for(const admission of admissions) {
        assert.equal(admission.eraseAll,admission.mode==='factory');
        assert.equal(admission.address,admission.eraseAll?0:0x10000);
        assert.equal(admission.sha256,env.files[admission.eraseAll?'firmware.factory.bin':'firmware.bin'].sha256);
      }
    }
    await writeFile(join(root,'ethermesh_1w_v3','bootloader.bin'),new Uint8Array([0]));
    const altered=run(root);
    assert.equal(altered.status,1);
    assert.match(altered.stderr,/ethermesh_1w_v3.*bootloader\.bin.*(SHA-256|size)/);
    await rm(join(root,'ethermesh_1w_v3'),{recursive:true});
    const missing=run(root);
    assert.equal(missing.status,1);
    assert.match(missing.stderr,/ethermesh_1w_v3/);
  }
  finally {await rm(root,{recursive:true,force:true});}
});

test('offline candidate tooling is not part of Worker static assets',async () => {
  const ignored=await readFile(new URL('../.assetsignore',import.meta.url),'utf8');
  assert.match(ignored,/^scripts(?:\/\*\*|\/)?$/m);
});
