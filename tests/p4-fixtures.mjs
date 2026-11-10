// Synthetic host-only contract fixtures. These are NOT flashable firmware images.
import { createHash } from 'node:crypto';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const policy = boardId => ({boardId, profiles:[
  {profile:'pre_v3',environment:boardId,minRevision:1,maxRevision:199},
  {profile:'v3',environment:`${boardId}_v3`,minRevision:301,maxRevision:399},
]});
export const loaderFor = revision => ({chip:{CHIP_NAME:'ESP32-P4',getChipRevision:async () => revision}});

export function firmwareFixture(boardId='ethermesh_1w', production=true) {
  const idf = production ? 'v5.5.5' : 'v5.5.4';
  const app = new Uint8Array(512);
  const boot = new Uint8Array(256);
  for(const bytes of [app,boot]) {
    bytes[0]=0xe9; bytes[1]=1; bytes[2]=2; bytes[3]=0x4f;
    const view = new DataView(bytes.buffer);
    view.setUint16(12,18,true); view.setUint16(17,65535,true);
  }
  new DataView(app.buffer).setUint32(32,0xabcd5432,true);
  app.set(new TextEncoder().encode(idf),144);
  const partitions = new Uint8Array(3072).fill(255);
  const view = new DataView(partitions.buffer);
  [[1,2,0x9000,0x5000],[1,0,0xe000,0x2000],[0,0x10,0x10000,0x10000],[0,0x11,0x20000,0x10000]].forEach(([type,subtype,offset,size],i) => {
    const p=i*32;
    view.setUint16(p,0x50aa,true); partitions[p+2]=type; partitions[p+3]=subtype;
    view.setUint32(p+4,offset,true); view.setUint32(p+8,size,true);
  });
  const bytes = {'bootloader.bin':boot,'partitions.bin':partitions,'boot_app0.bin':new Uint8Array(8192),'firmware.bin':app};
  const offsets = {'bootloader.bin':0x2000,'partitions.bin':0x8000,'boot_app0.bin':0xe000,'firmware.bin':0x10000};
  const factory = new Uint8Array(offsets['firmware.bin']+app.length).fill(255);
  const parts = Object.fromEntries(Object.entries(bytes).map(([name,data]) => {
    factory.set(data,offsets[name]);
    const entry={offset:offsets[name],size:data.length,sha256:hash(data)};
    if(name === 'bootloader.bin' || name === 'firmware.bin') entry.image_header={chip_id:18,flash_mode:'dio',flash_frequency_mhz:80,flash_size_bytes:16*1024*1024,min_revision:0,max_revision:65535};
    return [name,entry];
  }));
  const profile = production ? 'v3' : 'pre_v3';
  const minRevision = production ? 301 : 1, maxRevision = production ? 399 : 199;
  const metadata = {
    schema_version:1,board_id:boardId,environment:`${boardId}${production?'_v3':''}`,chip_family:'ESP32-P4',
    silicon:{board_id:boardId,profile,chip_variant:production?'esp32p4':'esp32p4_es',min_revision:minRevision,max_revision:maxRevision},
    framework:{arduino:production?'3.3.11':'3.3.8',esp_idf:idf,idf_package:`${idf.slice(1)}+sha.fixture`,sdkconfig_sha256:hash('synthetic SDK config'),sdkconfig:{CONFIG_ESP_REV_MIN_FULL:String(minRevision),CONFIG_ESP_REV_MAX_FULL:String(maxRevision)}},
    settings:{flash_size_bytes:16*1024*1024,flash_hz:80000000,flash_mode:'qio'},
    parts,factory:{path:'firmware.factory.bin',offset:0,size:factory.length,sha256:hash(factory)},
    update_contract:{board_id:boardId,silicon_profile:profile,flash_size_bytes:16*1024*1024,bootloader_sha256:parts['bootloader.bin'].sha256,partitions_sha256:parts['partitions.bin'].sha256},
  };
  return {metadata,bytes,factory,blob:new Blob([factory])};
}
