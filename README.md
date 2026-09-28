# openHop MeshCore Flasher

openHop MeshCore Flasher is a static, browser-based firmware flasher for loading openHop Modem firmware onto supported MeshCore-compatible devices. Flashing runs entirely in the browser using Web Serial. Production uses HTTPS static assets and a small Cloudflare Worker for same-origin release discovery.

The modem firmware variants are maintained in the openHop modem repository:

https://github.com/openhop-dev/openhop_modem

User documentation is available at:

https://docs.openhop.dev/projects/openhop-modem/flasher/

Only published stable releases are selectable, with the newest eligible semantic version selected by default. Releases are discovered via `/api/firmware-releases` and link to their GitHub release pages. Live, cached and fallback lists are filtered, deduplicated and sorted newest first. The catalogue excludes releases before v1.0.1 (which lack required P4 factory images); per-firmware `minimumRelease` further restricts availability. `main` is an internal file-layout template, never a selectable branch build. `expandReleases: false` disables template expansion and permits only explicitly configured versions present in the release list. Roles and devices without eligible files are hidden. Discovery caches successful results in the browser for 15 minutes and uses configured fallback tags when the service is unavailable; an empty successful release list stays empty. Custom BIN/ZIP uploads remain independent of catalogue release filtering.

## What it does

- Flashes ESP32-family devices with esptool.js.
- Supports normal ESP32 firmware updates.
- Supports Erase Device/full ESP32 flashing with bootloader, partition table, and firmware images when those files are available.
- Flashes nRF52 devices with serial DFU packages.
- Provides a serial console for supported devices.

## Configured modem variants

- ESP32-P4 Nano
- EtherMesh-1W
- Photon-1W XAIO ESP32 C6
- Heltec T114
- Heltec Tracker V2
- Heltec V3
- Heltec V4
- Heltec V4.2
- Heltec V4.3
- Ikoka Stick
- LilyGo T3S3
- LilyGo T-Beam-S3 Supreme
- RAK3401 + RAK13302
- RAK4631 USB
- RAK4631 WisMesh Ethernet
- RAK WisMesh Base/Rak3112
- Seeed XIAO ESP32S3 + Wio SX1262
- Seeed XIAO nRF52 + Wio SX1262
- UnitEng Station G2
- UnitEng/BQ Voyage Station G3

## Firmware source

Firmware release history:

https://github.com/openhop-dev/openhop_modem/releases

The flasher configuration points at raw firmware files from each release tag. ESP32-P4 devices use the complete `firmware.factory.bin` at `0x0` because their bootloader starts at `0x2000`. Other ESP32 devices use the build-specific full-flash layout, commonly:

- `bootloader.bin` at `0x0`
- `partitions.bin` at `0x8000`
- `firmware.bin` at `0x10000`

For nRF52 devices, the flasher uses the variant's `firmware.zip` DFU package.

## Architecture and local validation

No dependencies need to be installed and there is no build step:

- `flasher.js` boots the production Vue application; `js/app.js` owns selection and UI state.
- `js/catalog.js` loads the unchanged openHop catalogue, discovers releases and resolves selected-tag firmware URLs.
- `js/flash.js` selects complete flash plans and invokes ESP32/DFU backends. Explicit per-file addresses take priority; full flash writes every configured image. P4 factory images start at zero.
- `js/router.js` handles in-app history. Initial non-root URLs deliberately redirect to `/`; deep-link reload restoration is not supported.
- `js/serial.js` chooses Web Serial or the upstream Android serial-over-WebUSB polyfill; `lib/dfu.js` propagates rejected reads without waiting for its timeout.
- `worker.js` and `wrangler.jsonc` retain the same release-proxy/static-assets deployment. `.assetsignore` excludes tests and development tooling.

Run the dependency-free regression suites:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/*.test.mjs
node --check flasher.js
for file in js/*.js lib/dfu.js lib/overflow.vue.js lib/polyfill/serial.js; do node --check "$file"; done
git diff --check
```

Node tests execute real catalogue, routing, Vue selection and flash orchestration with network/hardware boundaries stubbed. They do not flash hardware. Python tests cover catalogue layouts, branding, safe controls and module wiring. When changing JavaScript, bump `openhop14` consistently in the entry, module imports and HTML/CSS URLs; an entry-only cache key does not invalidate its imports.

For a static UI preview, run `python3 -m http.server 8000 --bind 127.0.0.1`. This server does **not** implement `/api/firmware-releases`: expect fallback versions and a handled HTTP 404. Use a separately authorized local Worker preview to exercise the real proxy. Firmware binaries still require browser CORS access to raw GitHub. Do not click Flash or Enter DFU mode during ordinary UI validation.

## Browser and mobile limits

Desktop Chrome/Edge with Web Serial remains the recommended path. Android Chromium with WebUSB can use the upstream polyfill for compatible USB CDC ACM devices, with a USB host/OTG connection and browser permission. This is not universal USB-serial driver support: proprietary bridges, USB interface claiming, OS restrictions and bootloader re-enumeration can prevent operation. Neither Android hardware flashing nor device compatibility has been established by the automated tests. Firefox/Safari and iOS are not implied to be supported.

For nRF52, select the inner DFU `firmware.zip` (not an outer distribution archive). Enter DFU by 1200-baud touch or double-tap RESET, then choose the newly enumerated bootloader port when flashing. No erase control is offered without a configured erase package. Custom `-merged.bin` uploads use address zero and warn that flash will be erased; ordinary BIN uploads use `0x10000` without full erase. The configured ESP32 initial-install path defaults **Erase Device** on; disable it only when an update-only operation is intended.
