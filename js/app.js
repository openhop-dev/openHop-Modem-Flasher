import { reactive, ref, shallowRef, nextTick, watch, computed } from '/lib/vue.prod.min.js?v=openhop15';
import { SerialConsole } from '/lib/console.js?v=openhop15';
import { commandReference } from './commands.js?v=openhop15';
import { firmwareClasses, defaultFirmwareVersion, compareDevices, hasVersions, roleValue, renderNotice, formatChangeLog, firmwareUrl } from './catalog.js?v=openhop15';
import { Dfu, downloadFirmware, esp32Address, flashEsp32, flashNrf52, isMergedImage, pickFlashFiles, releaseFlasher } from './flash.js?v=openhop15';
import { CONSOLE_PATH, buildPath, parsePath, isSamePage } from './router.js?v=openhop15';
import { serialAPI, serialSupported } from './serial.js?v=openhop15';
import { isIframe, logoFile } from './site.js?v=openhop15';

const WEB_SERIAL_UNSUPPORTED = "Your browser doesn't support Web Serial API. Please use Chrome or Edge on Desktop";

export function createSetup(config) {
  return function setup() {
    const consoleEditBox = ref();
    const consoleWindow = ref();
    const deviceFilterText = ref('');
    // device tooltips embed large SVG pictures, so only the hovered one is rendered
    const hoveredDevice = shallowRef(null);
    const displayWelcomeBanner = ref(isIframe && !localStorage.getItem('welcomeBannerDismissed'));

    const snackbar = reactive({ text: '', class: '', icon: '' });

    const selected = reactive({
      device: null,
      firmware: null,
      version: null,
      firmwareClass: null,
      wipe: false,
    });

    const flashing = reactive({
      supported: serialSupported,
      instance: null,
      active: false,
      busy: false,
      phase: '',
      percent: 0,
      log: '',
      error: '',
      dfuComplete: false,
    });

    // nRF52 "Erase Flash": flashes a formatter firmware that wipes the external flash
    const eraser = reactive({ active: false, percent: 0 });

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
      writeLine(data) { flashing.log += data + '\n' },
    };

    // --- catalog views ---

    const fwValue = (firmware, key) => roleValue(config, firmware, key);
    const currentVersion = computed(() => selected.firmware?.version[selected.version] ?? null);
    const hasFlashWipe = computed(() => Boolean(currentVersion.value?.files.some(file => file.type === 'flash-wipe')));
    const notice = computed(() => selected.firmware ? renderNotice(config, selected.device, selected.firmware) : '');

    const devices = computed(() => {
      const filter = deviceFilterText.value.toLowerCase();
      return config.device
        .toSorted(compareDevices)
        .filter(d => d.name.toLowerCase().includes(filter));
    });

    const deviceFirmwareByClass = computed(() => {
      if(!selected.device) return {};
      const groups = {};
      for(const fw of selected.device.firmware) {
        if(!hasVersions(fw)) continue;
        if(selected.firmwareClass && fw.class !== selected.firmwareClass) continue;
        (groups[fw.class || selected.device.class || 'openhop'] ??= []).push(fw);
      }
      // known classes first, in their defined order
      const order = [...Object.keys(firmwareClasses), ...Object.keys(groups)];
      return Object.fromEntries([...new Set(order)].filter(cls => groups[cls]).map(cls => [cls, groups[cls]]));
    });

    const downloads = computed(() => {
      const { device } = selected;
      if(!currentVersion.value || currentVersion.value.customFile) return [];
      const files = currentVersion.value.files.map(file => ({ title: file.title, href: firmwareUrl(config, file, currentVersion.value) }));
      if(device.type === 'nrf52') {
        if(device.erase) {
          const eraseUf2 = device.erase.replace('.zip', '.uf2');
          files.push({ title: eraseUf2, href: `${config.staticPath}/${eraseUf2}` });
        }
        for(const bootloader of device.bootloader ?? []) {
          files.push({ title: bootloader, href: `${config.staticPath}/${bootloader}` });
        }
      }
      return files;
    });

    // --- navigation ---

    const selectFirmware = (firmware) => {
      if(flashing.active) return;
      selected.firmware = firmware;
      selected.version = defaultFirmwareVersion(firmware);
      selected.wipe = selected.device?.type === 'esp32' && Boolean(currentVersion.value?.files.some(file => file.type === 'flash-wipe'));
    };

    const applySelection = ({ device, firmware, version, firmwareClass }) => {
      selected.device = device;
      selected.firmwareClass = firmwareClass;
      selectFirmware(firmware);
      if(version) selected.version = version;
    };

    const stepBack = () => {
      if(flashing.active) return;
      if(selected.firmware) {
        // custom files have no role screen to go back to
        if(currentVersion.value?.customFile) selected.device = null;
        selectFirmware(null);
        return;
      }
      selected.device = null;
      selected.firmwareClass = null;
    };

    const resetFlashing = async () => {
      if(flashing.busy) return;
      flashing.busy = true;
      try {
        await releaseFlasher(flashing.instance);
        Object.assign(flashing, { instance: null, active: false, phase: '', percent: 0, log: '', error: '', dfuComplete: false });
      }
      finally {
        flashing.busy = false;
      }
    };

    const retry = resetFlashing;
    const close = () => { if(!flashing.busy) location.reload() };

    // --- URL sync ---

    const currentPath = computed(() => {
      if(serialCon.opened) return CONSOLE_PATH;
      // a local file can't be linked to
      if(currentVersion.value?.customFile) return '/';
      return buildPath(config, selected);
    });

    // keeps ?config= and ?iframe= across navigation
    const setLocation = (path, replace) => history[replace ? 'replaceState' : 'pushState'](null, '', path + location.search);

    watch(currentPath, (path) => {
      if(location.pathname === path) return;
      setLocation(path, isSamePage(location.pathname, path));
    });

    // restores the selection from the URL, then normalizes the URL in place (e.g. adds the default version)
    const applyLocation = () => {
      applySelection(parsePath(config, location.pathname));
      setLocation(currentPath.value, true);
    };

    window.addEventListener('popstate', () => {
      if(flashing.busy) {
        setLocation(currentPath.value, true);
        return;
      }
      if(serialCon.opened) closeSerialCon();
      flashing.active = false;
      flashing.log = '';
      flashing.error = '';
      applyLocation();
    });

    applyLocation();

    // --- serial console ---

    const openSerialGUI = () => {
      window.open('https://config.meshcore.io', 'meshcore_config', 'directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=1000,height=800');
    };

    const openSerialCon = async () => {
      const serialConsole = serialCon.instance = new SerialConsole(await serialAPI.requestPort());

      serialCon.content =
        '-------------------------------------------------------------------------\n' +
        'Welcome to MeshCore serial console.\n' +
        'Click on the cursor to get all supported commands.\n' +
        '-------------------------------------------------------------------------\n\n';

      serialConsole.onOutput = (text) => { serialCon.content += text };
      serialConsole.connect();
      serialCon.opened = true;
      await nextTick();
      consoleEditBox.value.focus();
    };

    const closeSerialCon = async () => {
      serialCon.opened = false;
      await serialCon.instance.disconnect();
    };

    const sendCommand = async (text) => {
      const consoleEl = consoleWindow.value;
      serialCon.edit = '';
      await serialCon.instance.sendCommand(text);
      setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
    };

    const showMessage = (text, icon = '', displayMs = 2000) => {
      Object.assign(snackbar, { class: 'active', text, icon });
      setTimeout(() => Object.assign(snackbar, { class: '', text: '', icon: '' }), displayMs);
    };

    const consoleMouseUp = () => {
      const selection = window.getSelection().toString();
      if(selection.length) {
        navigator.clipboard.writeText(selection);
        showMessage('text copied to clipboard');
      }
      consoleEditBox.value.focus();
    };

    // --- flashing ---

    const dfuMode = async () => {
      await Dfu.forceDfuMode(await serialAPI.requestPort({}));
      flashing.dfuComplete = true;
    };

    const customFirmwareLoad = (ev) => {
      if(flashing.active) return;
      const file = ev.target.files[0];
      if(!file) return;
      selected.wipe = false;
      selected.device = {
        name: 'Custom device',
        type: file.name.endsWith('.bin') ? 'esp32' : 'nrf52',
      };

      if(isMergedImage(file.name)) {
        alert(
          'You selected custom file that ends with "merged.bin". ' +
          'This will erase your flash! Proceed with caution. ' +
          'If you want just to update your firmware, please use non-merged bin.'
        );
        selected.wipe = true;
      }

      selected.firmware = {
        icon: 'unknown_document',
        title: file.name,
        version: {
          [file.name]: { customFile: true, files: [{ type: 'flash', file }] },
        },
      };
      selected.version = file.name;
    };

    const nrfErase = async () => {
      const { device } = selected;
      if(!(device.type === 'nrf52' && device.erase)) {
        console.error('nRF erase called for non-nrf device or device.erase is not defined');
        return;
      }

      let data;
      try {
        data = await downloadFirmware(`${config.staticPath}/${device.erase}`);
      }
      catch(e) {
        alert(e.message);
        return;
      }

      const dfu = new Dfu(await serialAPI.requestPort({}));
      try {
        eraser.active = true;
        await flashNrf52(dfu, data, (progress) => { eraser.percent = progress });
        eraser.active = false;
        flashing.dfuComplete = false;
        setTimeout(() => alert('Device erase firmware has been flashed and flash has been erased.\nYou can flash MeshCore now.'), 200);
      }
      catch(e) {
        alert(`${e.message}\nDid you put the device into DFU mode before attempting erasing?`);
        eraser.active = false;
        eraser.percent = 0;
      }
    };

    const flashDevice = async () => {
      if(flashing.busy || flashing.active) return;
      // Resolve every hardware input now, never from mutable selection after an await.
      const esp32 = selected.device.type === 'esp32';
      const wipe = selected.wipe;
      const files = pickFlashFiles(currentVersion.value.files, { esp32, wipe }).map(file => ({
        data: file.file,
        url: file.file ? null : firmwareUrl(config, file, currentVersion.value),
        address: esp32Address(file),
      }));
      if(!files.length) {
        alert('Cannot find configuration for flash file! please report this to Discord.');
        return;
      }

      flashing.busy = true;
      flashing.active = true;
      flashing.phase = 'selecting';
      const onProgress = (percent) => { flashing.percent = percent };
      try {
        // The chooser must run in the click handler, before network awaits consume activation.
        const port = await serialAPI.requestPort({});
        flashing.phase = 'downloading';
        const data = await Promise.all(files.map(async file => ({
          data: file.data ?? await downloadFirmware(file.url),
          address: file.address,
        })));
        flashing.phase = 'flashing';
        if(esp32) {
          await flashEsp32(port, data, {
            eraseAll: wipe,
            terminal: log,
            onProgress,
            onLoader: (loader) => { flashing.instance = loader },
          });
        }
        else {
          const dfu = flashing.instance = new Dfu(port);
          await flashNrf52(dfu, data[0].data, onProgress);
        }
      }
      catch(e) {
        // Cancelling the chooser is not a failed flash; no port was opened yet.
        if(flashing.phase === 'selecting' && e.name === 'NotFoundError') {
          flashing.active = false;
          flashing.phase = '';
        }
        else {
          flashing.error = e.message;
        }
      }
      finally {
        flashing.busy = false;
      }
    };

    return {
      config, logoFile, isIframe, commandReference, firmwareClasses, WEB_SERIAL_UNSUPPORTED,
      displayWelcomeBanner, dismissWelcomeBanner() {
        localStorage.setItem('welcomeBannerDismissed', '1');
        displayWelcomeBanner.value = false;
      },
      snackbar,
      selected, flashing, eraser, serialCon,
      deviceFilterText, hoveredDevice, devices, deviceFirmwareByClass,
      currentVersion, hasFlashWipe, notice, downloads, fwValue, formatChangeLog,
      selectFirmware, stepBack, retry, close,
      consoleEditBox, consoleWindow, consoleMouseUp, openSerialCon, closeSerialCon, sendCommand, openSerialGUI,
      dfuMode, nrfErase, flashDevice, customFirmwareLoad,
    };
  };
}
