# pyMC MeshCore Flasher

pyMC MeshCore Flasher is a static, browser-based firmware flasher for loading pyMC Modem firmware onto supported MeshCore-compatible devices. It runs entirely in the browser using Web Serial, so the website only needs static hosting over HTTPS.

The modem firmware variants are maintained in the pyMC modem repository:

https://github.com/pyMC-dev/pymc_modem

Most firmware files are loaded directly from the `pyMC-dev/pymc_modem` firmware folders. Temporary/custom firmware that is not yet in `pymc_modem` may be bundled under this repo's `firmware/` directory until it is moved upstream.

## What it does

- Flashes ESP32-family devices with esptool.js.
- Supports normal ESP32 firmware updates.
- Supports Erase Device/full ESP32 flashing with bootloader, partition table, and firmware images when those files are available.
- Flashes nRF52 devices with serial DFU packages.
- Provides a serial console for supported devices.

## Configured modem variants

- ESP32-P4 Nano
- Ethermesh-1W
- Photon-1W XAIO ESP32 C6
- Heltec T114
- Heltec Tracker V2
- Heltec V3
- Heltec V4
- Ikoka Stick
- LilyGo T3S3
- RAK WisMesh Base/Rak3112
- Seeed XIAO ESP32S3 + Wio SX1262
- Seeed XIAO nRF52 + Wio SX1262
- Station G2

## Firmware source

Primary firmware source:

https://github.com/pyMC-dev/pymc_modem/tree/main/firmware

The flasher configuration points at raw firmware files from that repository where available. For ESP32 devices, full erase flashing expects this layout per variant:

- `bootloader.bin` at `0x0`
- `partitions.bin` at `0x8000`
- `firmware.bin` at `0x10000`

For nRF52 devices, the flasher uses the variant's `firmware.zip` DFU package.
