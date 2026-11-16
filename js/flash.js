// Flashing backends: esptool.js for ESP32, adafruit-nrfutil style serial DFU for nRF52
import { Dfu } from '/lib/dfu.js?v=openhop17';
import { ESPLoader, Transport, HardReset } from '/lib/esp32.js?v=openhop17';
import { blobToBytes, delay } from './util.js?v=openhop17';

// ESP32 app partition; merged images (bootloader + partitions + app) start at 0
const ESP32_APP_ADDRESS = 0x10000;

export async function downloadFirmware(url) {
  console.log(`downloading: ${url}`);
  const res = await fetch(url);
  if(!res.ok) {
    throw new Error(`Could not download the firmware file from the server, reported: HTTP ${res.status}.\nPlease try again.`);
  }

  return await res.blob();
}

export const isMergedImage = (filename) => /-merged\.bin$/.test(filename);

export function esp32Address(file) {
  return file.address ?? (file.type === 'flash-wipe' || isMergedImage(file.name ?? file.title ?? file.file?.name ?? '') ? 0 : ESP32_APP_ADDRESS);
}

// Select an entire configured plan, never silently substitute an update for a wipe.
export function pickFlashFiles(files, { esp32, wipe }) {
  const flashFiles = files.filter(f => f.type.startsWith('flash'));
  if(!esp32) return flashFiles.slice(0, 1);
  const preferred = flashFiles.filter(f => f.type === (wipe ? 'flash-wipe' : 'flash-update'));
  if(preferred.length) return preferred;
  return flashFiles.filter(f => f.type === 'flash' && (!wipe || f.file));
}

async function pulseRts(transport) {
  await transport.setRTS(true);
  await delay(100);
  await transport.setRTS(false);
}

// onLoader receives the ESPLoader as soon as it exists, so the caller can release the port later
export async function flashEsp32(port, images, { eraseAll, terminal, onProgress, onLoader, resolvePlan }) {
  const transport = new Transport(port, true);
  const options = {
    transport,
    terminal,
    compress: true,
    eraseAll,
    flashSize: 'keep',
    flashMode: 'keep',
    flashFreq: 'keep',
    baudrate: 115200,
    romBaudrate: 115200,
    enableTracing: false,
    fileArray: await Promise.all(images.map(async ({ data, address }) => ({ data: await blobToBytes(data), address }))),
    reportProgress: (index, written, total) => {
      const sizes = images.map(image => image.data.size);
      const complete = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
      const all = sizes.reduce((sum, size) => sum + size, 0);
      onProgress(Math.min(99, ((complete + sizes[index] * written / total) / all) * 100));
    },
  };

  const loader = new ESPLoader(options);
  loader.hr = new HardReset(transport);
  onLoader?.(loader);

  try {
    try {
      await loader.main();
      await loader.flashId();
    }
    catch(e) {
      console.error(e);
      throw new Error(`Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`);
    }

    // Revision-aware plans cannot choose their bytes until the chip is identified.
    if(resolvePlan) {
      const plan = await resolvePlan(loader);
      if(!Array.isArray(plan?.images) || !plan.images.length || typeof plan.eraseAll !== 'boolean') throw new Error('Invalid admitted flash plan');
      images = plan.images;
      options.eraseAll = plan.eraseAll;
      options.fileArray = await Promise.all(images.map(async ({data, address}) => ({data:await blobToBytes(data), address})));
    }
    await loader.writeFlash(options);
    await delay(100);
    await loader.after('hard_reset');
    await delay(100);
    onProgress(100);
  }
  catch(e) {
    console.error(e);
    throw new Error(`ESP32 flashing failed: ${e}`);
  }
  finally {
    try { await pulseRts(transport); }
    finally { await transport.disconnect(); }
  }
}

export async function flashNrf52(dfu, data, onProgress) {
  try {
    await dfu.dfuUpdate(data, onProgress);
  }
  catch(e) {
    console.error(e);
    throw new Error(`nRF flashing failed: ${e}. Please reset the device and try again.`);
  }
}

// Resets / closes whatever a previous flashing attempt left open
export async function releaseFlasher(instance) {
  try {
    if(instance instanceof ESPLoader) {
      await instance.hr.reset();
      await instance.transport.disconnect();
    }
    else if(instance instanceof Dfu) {
      await instance.port.close();
    }
  }
  catch(e) {
    console.error(e);
  }
}

export { Dfu };
