// The board is the user's choice; only silicon identity is detected from hardware.
const FLASH_SIZE = 16 * 1024 * 1024;
const OFFSETS = {'bootloader.bin':0x2000,'partitions.bin':0x8000,'boot_app0.bin':0xe000,'firmware.bin':0x10000};
const SHA256 = /^[0-9a-f]{64}$/;
const rejectUnless = (condition,reason) => {
  if(!condition) throw new Error(`P4 bundle rejected: ${reason}. No flash was written.`);
};

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
}

function validateMetadata(m,t) {
  rejectUnless(m?.schema_version === 1 && m.chip_family === 'ESP32-P4' &&
    m.board_id === t.boardId && m.environment === t.environment, 'board/environment/schema mismatch');
  const s=m.silicon, fw=m.framework, parts=m.parts, update=m.update_contract;
  rejectUnless(s?.board_id === t.boardId && s.profile === t.profile && s.chip_variant === t.chipVariant &&
    s.min_revision === t.minRevision && s.max_revision === t.maxRevision, 'silicon/SDK profile mismatch');
  rejectUnless(m.settings?.flash_size_bytes === FLASH_SIZE, 'unsupported flash size');
  const idf=typeof fw?.esp_idf === 'string' ? fw.esp_idf.match(/\d+\.\d+\.\d+/)?.[0] : null;
  rejectUnless(idf && typeof fw.idf_package === 'string' && fw.idf_package.match(/\d+\.\d+\.\d+/)?.[0] === idf, 'SDK package/application version mismatch');
  const [major,minor,patch]=idf.split('.').map(Number);
  const fixed=(major === 5 && (minor > 5 || (minor === 5 && patch >= 5))) || major > 6 || (major === 6 && (minor > 0 || patch >= 1));
  rejectUnless(t.profile !== 'v3' || fixed, 'production firmware requires an AR2026-004 patched SDK');
  rejectUnless(fw.sdkconfig?.CONFIG_ESP_REV_MIN_FULL === String(t.minRevision) &&
    fw.sdkconfig?.CONFIG_ESP_REV_MAX_FULL === String(t.maxRevision), 'resolved SDK revision limits mismatch');
  rejectUnless(parts && Object.keys(parts).length === Object.keys(OFFSETS).length, 'incomplete component set');
  const names=Object.keys(OFFSETS);
  for(let i=0;i<names.length;i++) {
    const name=names[i], part=parts[name], limit=i+1 < names.length ? OFFSETS[names[i+1]] : FLASH_SIZE;
    rejectUnless(part?.offset === OFFSETS[name] && Number.isSafeInteger(part.size) && part.size > 0 &&
      part.offset+part.size <= limit && SHA256.test(part.sha256), `invalid component offset/size/hash: ${name}`);
  }
  rejectUnless(parts['partitions.bin'].size <= 0x1000 && parts['boot_app0.bin'].size === 0x2000, 'invalid partition/OTA initialization size');
  rejectUnless(m.factory?.path === 'firmware.factory.bin' && m.factory.offset === 0 &&
    m.factory.size === OFFSETS['firmware.bin']+parts['firmware.bin'].size && SHA256.test(m.factory.sha256), 'invalid complete factory contract');
  rejectUnless(update?.board_id === t.boardId && update.silicon_profile === t.profile &&
    update.flash_size_bytes === FLASH_SIZE && update.bootloader_sha256 === parts['bootloader.bin'].sha256 &&
    update.partitions_sha256 === parts['partitions.bin'].sha256, 'bootloader/partition update contract mismatch');
}

function validateImage(bytes,part,target,metadata,application) {
  rejectUnless(bytes.length >= 24 && bytes[0] === 0xe9, 'invalid ESP image header');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const header={chip_id:view.getUint16(12,true),min_revision:view.getUint16(15,true),max_revision:view.getUint16(17,true),
    flash_mode:['qio','qout','dio','dout','fast_read','slow_read'][bytes[2]],
    flash_frequency_mhz:({0:40,1:26,2:20,15:80})[bytes[3]&15],flash_size_bytes:(2**(bytes[3]>>4))*1024*1024};
  rejectUnless(header.chip_id === 18 && header.min_revision <= target.revision && target.revision <= header.max_revision &&
    header.flash_mode && header.flash_frequency_mhz && header.flash_size_bytes === FLASH_SIZE &&
    Object.entries(header).every(([key,value]) => part.image_header?.[key] === value), 'image-header identity/revision/settings mismatch');
  if(application) {
    rejectUnless(bytes.length >= 176 && view.getUint32(32,true) === 0xabcd5432, 'application descriptor missing');
    const idf=new TextDecoder().decode(bytes.subarray(144,176)).split('\0')[0];
    rejectUnless(idf === metadata.framework.esp_idf, 'application SDK descriptor mismatch');
  }
}

function validatePartitions(bytes,applicationSize) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), partitions=[];
  for(let p=0;p+32<=bytes.length;p+=32) {
    const magic=view.getUint16(p,true);
    if(magic === 0xffff || magic === 0xebeb) break;
    rejectUnless(magic === 0x50aa, 'invalid partition table');
    partitions.push({type:bytes[p+2],subtype:bytes[p+3],offset:view.getUint32(p+4,true),size:view.getUint32(p+8,true)});
  }
  let end=0x9000;
  for(const p of partitions.toSorted((a,b) => a.offset-b.offset)) {
    rejectUnless(p.size > 0 && p.offset >= end && p.offset+p.size <= FLASH_SIZE, 'partitions overlap or exceed flash');
    end=p.offset+p.size;
  }
  rejectUnless(partitions.some(p => p.type === 1 && p.subtype === 0 && p.offset === 0xe000 && p.size === 0x2000), 'missing matching OTA initialization partition');
  for(const subtype of [0x10,0x11]) {
    const slots=partitions.filter(p => p.type === 0 && p.subtype === subtype);
    rejectUnless(slots.length === 1 && slots[0].size >= applicationSize &&
      (subtype !== 0x10 || slots[0].offset === 0x10000), 'application does not fit both OTA slots');
  }
}

async function fetchBytes(url,maxSize,label) {
  const controller=new AbortController();
  const timer=setTimeout(() => controller.abort(),30000);
  let reader;
  try {
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    rejectUnless(response.ok,`${label} unavailable (HTTP ${response.status}); select a release containing matching P4 bundles`);
    const declared=response.headers.get('content-length');
    rejectUnless(declared === null || (/^\d+$/.test(declared) && Number(declared) <= maxSize),`${label} declared size is too large`);
    reader=response.body?.getReader();
    rejectUnless(reader,`${label} has no readable body`);
    const chunks=[];
    let size=0;
    for(;;) {
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.length;
      rejectUnless(size <= maxSize,`${label} size is too large`);
      chunks.push(value);
    }
    rejectUnless(size > 0,`${label} is empty`);
    const bytes=new Uint8Array(size);
    let offset=0;
    for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    return bytes;
  }
  catch(error) {
    if(error.message.startsWith('P4 bundle rejected:')) throw error;
    rejectUnless(false,`${label} download failed: ${error.message}`);
  }
  finally {
    clearTimeout(timer);
    if(reader) {
      try {await reader.cancel();} catch { /* preserve the original admission failure */ }
      reader.releaseLock();
    }
  }
}

export async function loadP4Bundle(target,{wipe,loader,onVerify}) {
  const [raw,sumsRaw]=await Promise.all([
    fetchBytes(target.urls.metadata,64*1024,'firmware.json'),
    fetchBytes(target.urls.checksums,16*1024,'SHA256SUMS.txt'),
  ]);
  const sums=new Map();
  for(const line of new TextDecoder().decode(sumsRaw).split(/\r?\n/)) {
    if(!line) continue;
    const match=line.match(/^([0-9a-f]{64})[ \t]+\*?([a-zA-Z0-9_.-]+)$/);
    rejectUnless(match && !sums.has(match[2]),'invalid or duplicate checksum entry');
    sums.set(match[2],match[1]);
  }
  rejectUnless(await sha256(raw) === sums.get('firmware.json'),'firmware.json SHA-256 mismatch');
  let metadata;
  try { metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
  catch { rejectUnless(false,'invalid firmware.json'); }
  validateMetadata(metadata,target);
  for(const [name,part] of [...Object.entries(metadata.parts),['firmware.factory.bin',metadata.factory]]) {
    rejectUnless(sums.get(name) === part.sha256,`missing/mismatched checksum: ${name}`);
  }
  const expected=wipe ? metadata.factory : metadata.parts['firmware.bin'];
  const bytes=await fetchBytes(wipe ? target.urls.factory : target.urls.application,expected.size,expected.path ?? 'firmware.bin');
  onVerify?.();
  return admitP4Image(metadata,target,new Blob([bytes]),{wipe,loader});
}

export async function admitP4Image(metadata,target,blob,{wipe,loader}) {
  validateMetadata(metadata,target);
  const expected=wipe ? metadata.factory : metadata.parts['firmware.bin'];
  rejectUnless(blob?.size === expected.size, 'image size mismatch');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  rejectUnless(await sha256(bytes) === expected.sha256, 'image SHA-256 mismatch');
  if(wipe) {
    for(const [name,part] of Object.entries(metadata.parts)) {
      const slice=bytes.subarray(part.offset,part.offset+part.size);
      rejectUnless(await sha256(slice) === part.sha256, `factory component SHA-256 mismatch: ${name}`);
      if(name === 'bootloader.bin' || name === 'firmware.bin') validateImage(slice,part,target,metadata,name === 'firmware.bin');
      if(name === 'partitions.bin') validatePartitions(slice,metadata.parts['firmware.bin'].size);
    }
  }
  else {
    validateImage(bytes,expected,target,metadata,true);
    const boot=metadata.parts['bootloader.bin'], partitions=metadata.parts['partitions.bin'];
    const length=partitions.offset+partitions.size-boot.offset;
    const remedy='use Erase Device for a full install (erases settings)';
    rejectUnless(loader?.IS_STUB && typeof loader.readFlash === 'function',`cannot verify installed bootloader/partitions; ${remedy}`);
    let timer, installed;
    try {
      const timeout=new Promise((_,reject) => {timer=setTimeout(() => reject(new Error('read timed out')),20000);});
      installed=await Promise.race([loader.readFlash(boot.offset,length),timeout]);
    }
    catch(error) { rejectUnless(false,`cannot verify installed bootloader/partitions: ${error.message}; ${remedy}`); }
    finally { clearTimeout(timer); }
    rejectUnless(installed instanceof Uint8Array && installed.length === length,`incomplete installed-contract read; ${remedy}`);
    rejectUnless(await sha256(installed.subarray(0,boot.size)) === boot.sha256 &&
      await sha256(installed.subarray(partitions.offset-boot.offset,partitions.offset-boot.offset+partitions.size)) === partitions.sha256,
      'installed bootloader/partition contract differs; use Erase Device for a full install (erases settings)');
    validatePartitions(installed.subarray(partitions.offset-boot.offset),expected.size);
  }
  return [{data:blob,address:expected.offset}];
}
const BOARD_NAMES={ethermesh_1w:'EtherMesh-1W',esp32_p4_nano:'ESP32-P4 Nano'};

export async function loadCustomP4Bundle(loader,file,metadataFile,{onTarget,onVerify}={}) {
  rejectUnless(metadataFile && metadataFile.size > 0 && metadataFile.size <= 64*1024,
    'custom P4 BINs require their matching firmware.json; select the BIN and JSON together');
  let metadata;
  try { metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await metadataFile.arrayBuffer())); }
  catch { rejectUnless(false,'invalid custom firmware.json'); }
  rejectUnless(Object.hasOwn(BOARD_NAMES,metadata?.board_id),'unknown custom P4 board identity');
  const policy={boardId:metadata.board_id,profiles:Object.entries(PROFILES).map(([profile,p]) => ({
    profile,environment:`${metadata.board_id}${profile === 'v3' ? '_v3' : ''}`,minRevision:p.minRevision,maxRevision:p.maxRevision,
  }))};
  const target=await selectP4Profile(loader,policy);
  validateMetadata(metadata,target);
  onTarget?.(target,BOARD_NAMES[target.boardId]);
  rejectUnless(file?.size > 0 && file.size <= FLASH_SIZE,'invalid custom BIN size');
  const digest=await sha256(await file.arrayBuffer());
  const factory=file.size === metadata.factory.size && digest === metadata.factory.sha256;
  const application=file.size === metadata.parts['firmware.bin'].size && digest === metadata.parts['firmware.bin'].sha256;
  rejectUnless(factory !== application,'custom BIN does not match the metadata factory or application SHA-256');
  onVerify?.();
  const images=await admitP4Image(metadata,target,file,{wipe:factory,loader});
  return {images,eraseAll:factory,target,boardName:BOARD_NAMES[target.boardId]};
}

const PROFILES = {
  pre_v3:{chipVariant:'esp32p4_es', minRevision:1, maxRevision:199, label:'legacy firmware'},
  v3:{chipVariant:'esp32p4', minRevision:301, maxRevision:399, label:'production firmware'},
};

export async function selectP4Profile(loader, policy) {
  if(!['ethermesh_1w','esp32_p4_nano'].includes(policy?.boardId) ||
      !Array.isArray(policy.profiles) || policy.profiles.length !== 2 ||
      new Set(policy.profiles.map(p => p?.profile)).size !== 2 ||
      !policy.profiles.every(p => p && Object.hasOwn(PROFILES, p.profile) &&
        p.environment === `${policy.boardId}${p.profile === 'v3' ? '_v3' : ''}` &&
        p.minRevision === PROFILES[p.profile].minRevision && p.maxRevision === PROFILES[p.profile].maxRevision)) {
    throw new Error('Invalid P4 silicon profile configuration. No flash was written.');
  }
  if(loader.chip?.CHIP_NAME !== 'ESP32-P4') {
    throw new Error(`Selected firmware requires ESP32-P4; detected ${loader.chip?.CHIP_NAME ?? 'unknown chip'}. No flash was written.`);
  }
  if(loader.secureDownloadMode) throw new Error('Cannot verify P4 revision in Secure Download Mode. No flash was written.');
  let revision;
  try { revision = await loader.chip.getChipRevision(loader); }
  catch(error) { throw new Error(`Could not determine ESP32-P4 revision: ${error.message}`); }
  if(!Number.isSafeInteger(revision) || revision < 0) throw new Error('Could not determine ESP32-P4 revision. No flash was written.');
  const profile = policy.profiles.find(p => revision >= p.minRevision && revision <= p.maxRevision);
  if(!profile) throw new Error(`Unsupported ESP32-P4 revision v${Math.floor(revision / 100)}.${revision % 100}. No flash was written.`);
  const known = PROFILES[profile.profile];
  return {...profile, boardId:policy.boardId, chipVariant:known.chipVariant,
    revision, revisionLabel:`v${Math.floor(revision / 100)}.${revision % 100}`, label:known.label};
}
