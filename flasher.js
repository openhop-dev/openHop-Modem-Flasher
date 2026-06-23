import "/lib/beer.min.js";
import { createApp, reactive, ref, nextTick, watch, computed } from "/lib/vue.min.js";
import { Dfu } from "/lib/dfu.js";
import { ESPLoader, Transport, HardReset } from "/lib/esp32.js";
import { SerialConsole } from '/lib/console.js';

// Cloudflare serves index.html for deep links. If someone opens an old/in-app
// route directly, send them back to the flasher home page instead of trying to
// hydrate the app from that path.
if(location.pathname !== '/') {
  location.replace('/');
}

const searchParams = new URLSearchParams(location.search);
const configName = searchParams.get('config')?.replaceAll(/[^a-z_-]/g, '') ?? 'config';
const configRes = await fetch(`/${configName}.json`, { cache: 'no-store' });
const config = await configRes.json();

const githubRes = await fetch('/releases');
const github = await githubRes.json();

const commandReference  = {
  'time ': 'Set time {epoch-secs}',
  'erase': 'Erase filesystem',
  'advert': 'Send Advertisment packet',
  'reboot': 'Reboot device',
  'clock': 'Display current time',
  'password ': 'Set new password',
  'log': 'Ouput log',
  'log start': 'Start packet logging to file system',
  'log stop': 'Stop packet logging to file system',
  'log erase': 'Erase the packet logs from file system',
  'ver': 'Show device version',
  'set freq ': 'Set frequency {Mhz}',
  'set af ': 'Set Air-time factor',
  'set tx ': 'Set Tx power {dBm}',
  'set repeat ': 'Set repeater mode {on|off}',
  'set advert.interval ': 'Set advert rebroadcast interval {minutes}',
  'set guest.password ': 'Set guest password',
  'set name ': 'Set advertisement name',
  'set lat': 'Set the advertisement map latitude',
  'set lon': 'Set the advertisement map longitude',
  'get freq ': 'Get frequency (Mhz)',
  'get af': 'Get Air-time factor',
  'get tx': 'Get Tx power (dBm)',
  'get repeat': 'Get repeater mode',
  'get advert.interval': 'Get advert rebroadcast interval (minutes)',
  'get name': 'Get advertisement name',
  'get lat': 'Get the advertisement map latitude',
  'get lon': 'Get the advertisement map longitude',
};

async function delay(milis) {
  return await new Promise((resolve) => setTimeout(resolve, milis));
}

function toSlug(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getGithubReleases(roleType, files) {
  const versions = {};
  for(const [fileType, matchRE] of Object.entries(files)) {
    for(const versionType of github) {
      if(versionType.type !== roleType) { continue }
      const version = versions[versionType.version] ??= {
        notes: versionType.notes,
        files: []
      };
      for(const file of versionType.files) {
        if(!new RegExp(matchRE).test(file.name)) { continue }
        version.files.push({
          type: fileType,
          name: file.url,
          title: file.name,
        })
      }
    }
  }

  return versions;
}

function addGithubFiles() {
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      const gDef = firmware.github;
      if(!gDef?.files) { continue }
      firmware.version = getGithubReleases(gDef.type, gDef.files);

      // clean versions without files
      for(const [verName, verValue] of Object.entries(firmware.version)) {
        if(verValue.files.length === 0) delete firmware.version[verName]
      }
    }
  }

  config.device = config.device.filter(device => device.firmware.some(firmware => Object.keys(firmware.version).length > 0 ));

  return config;
}

async function digestMessage(message) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array

  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string

  return hashHex;
}

async function blobToBinaryString(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binString = '';

  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }

  return binString;
}

console.log(addGithubFiles());

function setup() {
  const consoleEditBox = ref();
  const consoleWindow = ref();

  const deviceFilterText = ref('');

  const snackbar = reactive({
    text: '',
    class: '',
    icon: '',
  });

  const selected = reactive({
    device: null,
    firmware: null,
    version: null,
    wipe: false,
    espFlashAddress: 0x10000,
    nrfEraserFlashingPercent: 0,
    nrfEraserFlashing: false,
    port: null,
  });

  const getRoleFwValue = (firmware, key) => {
    const role = config.role[firmware.role] ?? {};

    return firmware[key] ?? role[key] ?? '';
  }

  const getSelFwValue = (key) => {
    const fwVersion = selected.firmware.version[selected.version];

    return fwVersion ? fwVersion[key] || '' : '';
  }

  const getNotice = (selected) => {
    let notice = config.notice[selected.firmware.notice] || selected.firmware.notice || '';

    if(notice) {
      notice = notice.replaceAll(/\$\{(\w+)\}/g, (_, varName) => selected.device[varName] || '');
    }

    return notice;
  }

  const formatChangeLog = (changelog) => {
    return changelog
      .replace(/change log:\r?\n/i, '')
      .replace(/^[-*] /mg, '')
      .replace(/#(\d+)$/gm, `<a target="_blank" href="https://github.com/meshcore-dev/MeshCore/pull/$1">#$1</a>`)
//      .split(/\r?\n/)
//      .map(l => `* ${l}`)
//      .join('\n')
  }

  const flashing = reactive({
    supported: 'Serial' in window || 'serial' in window.navigator,
    instance: null,
    locked: false,
    percent: 0,
    log: '',
    error: '',
    dfuComplete: false,
  });

  const serialCon = reactive({
    instance: null,
    opened: false,
    content: '',
    edit: '',
  });

  window.app = { selected, flashing, serialCon };

  const log = {
    clean() { flashing.log = '' },
    write(data) { flashing.log += data },
    writeLine(data) { flashing.log += data + '\n' }
  };

  const retry = async() => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
  }

  const close = () => {
    location.reload()
  }

  const getFirmwarePath = (file) => {
    return file.name.startsWith('/') ? file.name : `${config.staticPath}/${file.name}`;
  }

  const firmwareHasData = (firmware) => {
    const firstVersion = Object.keys(firmware.version)[0];
    if(!firstVersion) return false;

    return firmware.version[firstVersion].files.length > 0;
  }

  const firmwareHasFlashWipe = () => {
    const files = getSelFwValue('files');
    return Array.isArray(files) && files.some(file => file.type === 'flash-wipe');
  }

  // --- URL Routing ---
  // NOTE: the server must serve index.html for all paths (catch-all / try_files).

  const deviceToSlug = (device) => device.slug ?? toSlug([device.class, device.name].join('-'));

  const firmwareToSlug = (firmware) => {
    if (firmware.slug) return firmware.slug;
    const title = getRoleFwValue(firmware, 'title');
    const subTitle = getRoleFwValue(firmware, 'subTitle');
    return toSlug(subTitle ? `${title}-${subTitle}` : title);
  };

  let initializingFromUrl = false;

  const buildUrl = () => {
    if (serialCon.opened) return '/console';
    if (!selected.device) return '/';
    let path = '/' + deviceToSlug(selected.device) + '/';
    if (!selected.firmware) return path;
    path += firmwareToSlug(selected.firmware) + '/';
    if (selected.version) path += toSlug(selected.version);
    return path;
  };

  const updateUrl = (replace = false) => {
    if (initializingFromUrl) return;
    const path = buildUrl();
    if (window.location.pathname !== path) {
      replace ? history.replaceState(null, '', path) : history.pushState(null, '', path);
    }
  };

  const applyUrlPath = (path) => {
    initializingFromUrl = true;
    const segments = path.replace(/^\/|\/$/g, '').split('/').filter(Boolean);

    if (segments.length === 0 || segments[0] === 'console') {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    const [deviceSlug, roleSlug, versionSlug] = segments;
    const matchingDevices = config.device.filter(d => deviceToSlug(d) === deviceSlug);
    if (matchingDevices.length === 0) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    // When multiple devices share the same slug, use the firmware slug to pick the right one
    let device, firmware;
    if (roleSlug && matchingDevices.length > 1) {
      for (const d of matchingDevices) {
        const f = d.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
        if (f) { device = d; firmware = f; break; }
      }
    }
    if (!device) device = matchingDevices[0];
    selected.device = device;

    if (!roleSlug) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }

    if (!firmware) firmware = device.firmware.find(f => firmwareToSlug(f) === roleSlug && firmwareHasData(f));
    if (!firmware) {
      nextTick(() => { initializingFromUrl = false; });
      return;
    }
    selected.firmware = firmware;

    // Use nextTick so the firmware watcher sets the default version first,
    // then we override it with the version from the URL.
    nextTick(() => {
      if (versionSlug) {
        const versionName = Object.keys(firmware.version).find(v => toSlug(v) === versionSlug);
        if (versionName) selected.version = versionName;
      }
      initializingFromUrl = false;
    });
  };

  const stepBack = () => {
    if(selected.device && selected.firmware) {
      if(selected.firmware.version[selected.version].customFile) {
        selected.firmware = null;
        selected.device = null;
        return
      }

      selected.firmware = null;
      return;
    }

    if(selected.device) {
      selected.device = null;
    }
  }

  const flasherCleanup = async () => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percent = 0;
    selected.firmware = null;
    selected.version = null;
    selected.wipe = false;
    selected.device = null;
    selected.nrfEraserFlashingPercent = 0;
    selected.nrfEraserFlashing = false;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
    else if(flashing.instance instanceof Dfu) {
      try {
        flashing.instance.port.close()
      }
      catch(e) {
        console.error(e);
      }
    }
    flashing.instance = null;
  }

  const openSerialGUI = () => {
    window.open('https://config.meshcore.dev','meshcore_config','directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=1000,height=800');
  }

  const openSerialCon = async() => {
    const port = selected.port = await navigator.serial.requestPort();
    const serialConsole = serialCon.instance = new SerialConsole(port);

    serialCon.content =  '-------------------------------------------------------------------------\n';
    serialCon.content += 'Welcome to MeshCore serial console.\n'
    serialCon.content += 'Click on the cursor to get all supported commands.\n';
    serialCon.content += '-------------------------------------------------------------------------\n\n';

    serialConsole.onOutput = (text) => {
      serialCon.content += text;
    };
    serialConsole.connect();
    serialCon.opened = true;
    await nextTick();

    consoleEditBox.value.focus();
  }

  const closeSerialCon = async() => {
    serialCon.opened = false;
    await serialCon.instance.disconnect();
  }

  const sendCommand = async(text) => {
    const consoleEl = consoleWindow.value;
    serialCon.edit = '';
    await serialCon.instance.sendCommand(text);
    setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
  }

  const dfuMode = async() => {
    await Dfu.forceDfuMode(await navigator.serial.requestPort({}))
    flashing.dfuComplete = true;
  }

  const customFirmwareLoad = async(ev) => {
    const firmwareFile = ev.target.files[0];
    const type = firmwareFile.name.endsWith('.bin') ? 'esp32' : 'nrf52';
      selected.device = {
      name: 'Custom device',
      type,
    };
    if(firmwareFile.name.endsWith('-merged.bin')) {
      alert(
        'You selected custom file that ends with "merged.bin".'+
        'This will erase your flash! Proceed with caution.'+
        'If you want just to update your firmware, please use non-merged bin.'
      );

      selected.wipe = true;
      selected.espFlashAddress = 0;
    }

    selected.firmware = {
      icon: 'unknown_document',
      title: firmwareFile.name,
      version: {},
    }
    selected.version = firmwareFile.name;
    selected.firmware.version[selected.version] = {
      customFile: true,
      files: [{ type: 'flash', file: firmwareFile }]
    }
  }

  const espReset = async(t) => {
    await t.setRTS(true);
    await delay(100)
    await t.setRTS(false);
  }

  const nrfErase = async() => {
    if(!(selected.device.type === 'nrf52' && selected.device.erase)) {
      console.error('nRF erase called for non-nrf device or device.erase is not defined')
      return;
    }

    const url = `${config.staticPath}/${selected.device.erase}`;

    console.log('downloading: ' + url);
    const resp = await fetch(url);
    if(resp.status !== 200) {
      alert(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.\nPlease try again.`)
      return;
    }
    const flashData = await resp.blob();

    const port = selected.port = await navigator.serial.requestPort({});
    const dfu = new Dfu(port);

    try {
      selected.nrfEraserFlashing = true;
      await dfu.dfuUpdate(flashData, async (progress) => {
        selected.nrfEraserFlashingPercent = progress;
        if(progress === 100 && selected.nrfEraserFlashing) {
          selected.nrfEraserFlashing = false;
          selected.dfuComplete = false;
          setTimeout(() => {
            alert('Device erase firmware has been flashed and flash has been erased.\nYou can flash MeshCore now.');
          }, 200);
        }
      }, 60000);

    }
    catch(e) {
      alert(`nRF flashing erase firmware failed: ${e}.\nDid you put the device into DFU mode before attempting erasing?`);
      selected.nrfEraserFlashing = false;
      selected.nrfEraserFlashingPercent = 0;
      return;
    }
  }

  const canFlash = (device) => {
    return device.type !== 'noflash'
  }

  const flashDevice = async() => {
    const device = selected.device;
    const firmware = selected.firmware.version[selected.version];

    const flashFiles = firmware.files.filter(f => f.type.startsWith('flash'));
    if(!flashFiles[0]) {
      alert('Cannot find configuration for flash file! please report this to Discord.')
      flasherCleanup();
      return;
    }

    const downloadFlashFile = async(file) => {
      if(file.file) {
        return file.file;
      }

      const url = getFirmwarePath(file);
      console.log('downloading: ' + url);
      const resp = await fetch(url);
      if(resp.status !== 200) {
        throw new Error(`Could not download the firmware file from the server, reported: HTTP ${resp.status}.`);
      }

      return await resp.blob();
    };

    const port = selected.port = await navigator.serial.requestPort({});

    if(device.type === 'esp32') {
      let esploader;
      let transport;

      const selectedFlashType = selected.wipe ? 'flash-wipe' : 'flash-update';
      let selectedFlashFiles = flashFiles.filter(f => f.type === selectedFlashType);
      if(!selected.wipe && !selectedFlashFiles.length) {
        selectedFlashFiles = flashFiles.filter(f => f.type === 'flash');
      }
      if(!selectedFlashFiles.length) {
        alert(`Cannot find configuration for ${selectedFlashType} files! please report this to Discord.`);
        flasherCleanup();
        return;
      }

      let fileArray;
      try {
        fileArray = [];
        for(const flashFile of selectedFlashFiles) {
          const flashData = await downloadFlashFile(flashFile);
          fileArray.push({
            data: await blobToBinaryString(flashData),
            address: flashFile.address ?? selected.espFlashAddress,
          });
        }
      }
      catch(e) {
        alert(`${e}\nPlease try again.`);
        flasherCleanup();
        return;
      }

      console.log({flashFiles, selectedFlashType, selectedFlashFiles, fileArray});

      const flashOptions = {
        terminal: log,
        compress: true,
        eraseAll: selected.wipe,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        baudrate: 115200,
        romBaudrate: 115200,
        enableTracing: false,
        fileArray,
        reportProgress: async (_, written, total) => {
          flashing.percent = (written / total) * 100;
        },
      };

      try {
        flashing.active = true;
        transport = new Transport(port, true);
        flashOptions.transport = transport;
        flashing.instance = esploader = new ESPLoader(flashOptions);
        esploader.hr = new HardReset(transport);
        await esploader.main();
        await esploader.flashId();
      }
      catch(e) {
        console.error(e);
        flashing.error = `Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`;
        esploader = null;
        return;
      }

      try {
        await esploader.writeFlash(flashOptions);
        await delay(100);
        await esploader.after('hard_reset');
        await delay(100);
        await espReset(transport);
        await transport.disconnect();
      }
      catch(e) {
        console.error(e);
        flashing.error = `ESP32 flashing failed: ${e}`;
        await espReset(transport);
        await transport.disconnect();
        return;
      }
    }
    else if(device.type === 'nrf52') {
      let flashData;
      try {
        flashData = await downloadFlashFile(flashFiles[0]);
      }
      catch(e) {
        alert(`${e}\nPlease try again.`);
        flasherCleanup();
        return;
      }

      const dfu = flashing.instance = new Dfu(port);

      flashing.active = true;

      try {
        await dfu.dfuUpdate(flashData, async (progress) => {
          flashing.percent = progress;
        }, 60000);

      }
      catch(e) {
        console.error(e);
        flashing.error = `nRF flashing failed: ${e}. Please reset the device and try again.`;
        return;
      }
    }
  };

  const devices = computed(() => {
    const classes = ['openhop', 'ripple', 'meshos', 'community'];
    const deviceGroups = {};

    for(const cls of classes) {
      const devices = config.device.toSorted(
        (a, b) => ((a.order ?? 1000) - (b.order ?? 1000)) || (a.maker + a.name).localeCompare(b.maker + b.name)
      ).filter(
        d => d.class === cls && (deviceFilterText.value == '' || d.name.toLowerCase().includes(deviceFilterText.value?.toLowerCase()))
      )
      if(devices.length > 0) deviceGroups[cls] = devices;
    }

    return deviceGroups;
  });

  const showMessage = (text, icon, displayMs) => {
    snackbar.class = 'active';
    snackbar.text = text;
    snackbar.icon = icon || '';

    setTimeout(() => {
      snackbar.icon = '';
      snackbar.text = '';
      snackbar.class = '';
    }, displayMs || 2000);
  }

  const consoleMouseUp = (ev) => {
    if(window.getSelection().toString().length) {
      navigator.clipboard.writeText(window.getSelection().toString())
      showMessage('text copied to clipboard');
    }
    consoleEditBox.value.focus();
  }

  watch(() => selected.firmware, (firmware) => {
    if(firmware == null) return;
    selected.version = Object.keys(firmware.version)[0];
  });

  watch(() => selected.device, updateUrl);
  watch(() => selected.firmware, updateUrl);
  watch(() => selected.version, () => updateUrl(true));  // replace: version is a refinement, not a new nav step
  watch(() => serialCon.opened, updateUrl);

  window.addEventListener('popstate', () => {
    if (serialCon.opened) closeSerialCon();
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    selected.firmware = null;
    selected.version = null;
    selected.device = null;
    applyUrlPath(window.location.pathname);
  });

  applyUrlPath(window.location.pathname);

  return {
    snackbar,
    consoleEditBox, consoleWindow, consoleMouseUp,
    config, devices, selected, flashing, deviceFilterText,
    flashDevice, flasherCleanup, dfuMode,
    serialCon, closeSerialCon, openSerialCon,
    sendCommand, openSerialGUI,
    retry, close, commandReference,
    stepBack,
    customFirmwareLoad, getFirmwarePath,
    getSelFwValue, getRoleFwValue, getNotice, formatChangeLog,
    firmwareHasData, firmwareHasFlashWipe,
    canFlash, nrfErase
  }
}

createApp({ setup }).mount('#app');
