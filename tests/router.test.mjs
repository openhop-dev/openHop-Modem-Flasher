import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModule } from './modules.mjs';
globalThis.location = {host:'localhost', search:''};
const router = await browserModule('js/router.js');

test('fork device/firmware slug overrides round-trip in-app routes', () => {
  const firmware = {slug:'modem', title:'openHop Modem', version:{'v1.1.0':{files:[{}]}}};
  const device = {slug:'ethermesh-1w', class:'openhop', name:'EtherMesh-1W', firmware:[firmware]};
  const config = {device:[device], role:{}};
  assert.equal(router.buildPath(config, {device,firmware,version:'v1.1.0'}), '/ethermesh-1w/modem/v1.1.0');
  assert.equal(router.parsePath(config, '/ethermesh-1w/modem/v1.1.0').firmware, firmware);
  assert.equal(router.parsePath(config, '/ethermesh-1w/modem/main').version, null);
});

test('fallback routes retain class-prefixed fork slugs and version refinement', () => {
  const firmware = {title:'openHop Modem',version:{'v1.1.0':{files:[{}]}}};
  const device = {class:'openhop',name:'Board X',firmware:[firmware]};
  const config = {device:[device],role:{}};
  const path = router.buildPath(config, {device,firmware,version:'v1.1.0'});
  assert.equal(path, '/openhop-board-x/openhop-modem/v1.1.0');
  assert.equal(router.parsePath(config,path).device,device);
  assert.equal(router.isSamePage(path,path.replace('v1.1.0','v1.2.0')),true);
  assert.equal(router.parsePath(config,'/unknown').device,null);
});
