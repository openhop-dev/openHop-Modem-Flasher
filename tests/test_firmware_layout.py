import json
import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class FirmwareLayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((REPO_ROOT / "config.json").read_text())

    def firmware_files_for_device(self, device_name):
        device = next(
            device for device in self.config["device"] if device["name"] == device_name
        )
        return device["firmware"][0]["version"]["main"]["files"]

    def test_esp32_p4_full_flash_uses_factory_image_at_zero(self):
        for device_name, variant in (
            ("EtherMesh-1W", "ethermesh_1w"),
            ("ESP32-P4 Nano", "esp32_p4_nano"),
        ):
            with self.subTest(device=device_name):
                files = self.firmware_files_for_device(device_name)
                wipe_files = [entry for entry in files if entry["type"] == "flash-wipe"]
                self.assertEqual(
                    wipe_files,
                    [
                        {
                            "type": "flash-wipe",
                            "name": f"{variant}/firmware.factory.bin",
                            "title": "Erase/full flash: firmware.factory.bin @ 0x0",
                            "address": 0,
                        }
                    ],
                )

    def test_release_filter_excludes_tags_without_factory_images(self):
        release_config = self.config["firmwareReleases"]
        tag_pattern = re.compile(release_config["tagPattern"])

        self.assertIsNone(tag_pattern.fullmatch("v1.0.0"))
        self.assertIsNotNone(tag_pattern.fullmatch("v1.0.1"))
        self.assertIsNotNone(tag_pattern.fullmatch("v1.1.0"))
        self.assertIsNotNone(tag_pattern.fullmatch("v2.0.0"))
        self.assertNotIn("v1.0.0", release_config["fallbackTags"])

    def test_release_discovery_uses_same_origin_worker_proxy(self):
        release_config = self.config["firmwareReleases"]
        wrangler = json.loads((REPO_ROOT / "wrangler.jsonc").read_text())

        self.assertEqual(release_config["api"], "/api/firmware-releases")
        self.assertEqual(wrangler["main"], "worker.js")
        self.assertEqual(wrangler["assets"]["binding"], "ASSETS")
        self.assertIn(
            "/api/*", wrangler["assets"]["run_worker_first"]
        )

    def test_browser_dependencies_are_production_ready(self):
        vue = (REPO_ROOT / "lib" / "vue.prod.min.js").read_text()
        font = (REPO_ROOT / "css" / "material-symbols-outlined.woff2").read_bytes()

        self.assertNotIn("You are running a development build of Vue", vue)
        self.assertEqual(font[:4], b"wOF2")

    def test_meshsmith_devices_are_pinned_and_use_local_product_images(self):
        sorted_devices = sorted(
            self.config["device"],
            key=lambda device: (device.get("order", 1000), device["name"].casefold()),
        )

        self.assertEqual(
            [device["name"] for device in sorted_devices[:2]],
            ["EtherMesh-1W", "Photon-1W XAIO ESP32 C6"],
        )
        self.assertEqual(
            [device["name"] for device in sorted_devices[2:]],
            sorted(
                (device["name"] for device in sorted_devices[2:]),
                key=str.casefold,
            ),
        )

        expected_images = {
            "EtherMesh-1W": "/img/meshsmith_ethermesh.png",
            "Photon-1W XAIO ESP32 C6": "/img/meshsmith_photon.png",
        }
        for device in sorted_devices[:2]:
            with self.subTest(device=device["name"]):
                self.assertEqual(device["image"], expected_images[device["name"]])
                self.assertTrue((REPO_ROOT / device["image"].lstrip("/")).is_file())

    def test_station_devices_use_current_names_and_g3_layout(self):
        device_names = {device["name"] for device in self.config["device"]}
        self.assertIn("UnitEng Station G2", device_names)
        self.assertNotIn("Station G2", device_names)

        station_g3 = next(
            device
            for device in self.config["device"]
            if device["name"] == "UnitEng/BQ Voyage Station G3"
        )
        self.assertEqual(station_g3["maker"], "uniteng")
        self.assertEqual(station_g3["image"], "/img/station_g3.svg")
        self.assertTrue((REPO_ROOT / "img" / "station_g3.svg").is_file())
        self.assertFalse(station_g3["firmware"][0]["expandReleases"])
        self.assertNotIn(
            "not published",
            station_g3["firmware"][0]["version"]["main"]["notes"].lower(),
        )
        self.assertEqual(
            self.firmware_files_for_device("UnitEng/BQ Voyage Station G3"),
            [
                {
                    "type": "flash-update",
                    "name": "station_g3/firmware.bin",
                    "title": "Update firmware only (firmware.bin)",
                    "address": 65536,
                },
                {
                    "type": "flash-wipe",
                    "name": "station_g3/bootloader.bin",
                    "title": "Erase/full flash: bootloader.bin @ 0x0",
                    "address": 0,
                },
                {
                    "type": "flash-wipe",
                    "name": "station_g3/partitions.bin",
                    "title": "Erase/full flash: partitions.bin @ 0x8000",
                    "address": 32768,
                },
                {
                    "type": "flash-wipe",
                    "name": "station_g3/firmware.bin",
                    "title": "Erase/full flash: firmware.bin @ 0x10000",
                    "address": 65536,
                },
            ],
        )

    def test_rak4631_usb_modem_uses_main_only_nrf52_dfu_package(self):
        rak_usb = next(
            device
            for device in self.config["device"]
            if device["name"] == "RAK4631 USB"
        )

        self.assertEqual(rak_usb["maker"], "rak")
        self.assertEqual(rak_usb["type"], "nrf52")
        self.assertEqual(rak_usb["image"], "/img/rak_4631.svg")
        self.assertTrue((REPO_ROOT / "img" / "rak_4631.svg").is_file())
        self.assertFalse(rak_usb["firmware"][0]["expandReleases"])
        self.assertEqual(
            self.firmware_files_for_device("RAK4631 USB"),
            [
                {
                    "type": "flash",
                    "name": "rak4631_usb/firmware.zip",
                    "title": "rak4631_usb/firmware.zip",
                }
            ],
        )

        rak_ethernet = next(
            device
            for device in self.config["device"]
            if device["name"] == "RAK4631 WisMesh Ethernet"
        )
        self.assertEqual(
            self.firmware_files_for_device(rak_ethernet["name"])[0]["name"],
            "rak4631_wismesh_eth/firmware.zip",
        )


if __name__ == "__main__":
    unittest.main()
