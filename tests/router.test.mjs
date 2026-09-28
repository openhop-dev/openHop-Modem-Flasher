import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModule } from './modules.mjs';
globalThis.location = {host:'localhost', search:''};
const router = await browserModule('js/router.js');

test('fork device/firmware slug overrides round-trip in-app routes', () => {
  const firmware = {slug:'modem', title:'openHop Modem', version:{main:{files:[{}]}}};
  const device = {slug:'ethermesh-1w', class:'openhop', name:'EtherMesh-1W', firmware:[firmware]};
  const config = {device:[device], role:{}};
  assert.equal(router.buildPath(config, {device,firmware,version:'main'}), '/ethermesh-1w/modem/main');
  assert.equal(router.parsePath(config, '/ethermesh-1w/modem/main').firmware, firmware);
});

test('fallback routes retain class-prefixed fork slugs and version refinement', () => {
  const firmware = {title:'openHop Modem',version:{main:{files:[{}]}}};
  const device = {class:'openhop',name:'Board X',firmware:[firmware]};
  const config = {device:[device],role:{}};
  const path = router.buildPath(config, {device,firmware,version:'main'});
  assert.equal(path, '/openhop-board-x/openhop-modem/main');
  assert.equal(router.parsePath(config,path).device,device);
  assert.equal(router.isSamePage(path,path.replace('main','v1.2.0')),true);
  assert.equal(router.parsePath(config,'/unknown').device,null);
});
