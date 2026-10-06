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

    def test_tbeam_1w_has_distinct_release_gated_factory_layout(self):
        matches = [d for d in self.config["device"] if d.get("slug") == "lilygo-tbeam-1w"]
        self.assertEqual(len(matches), 1, "T-Beam 1W must be a distinct catalogue device")
        device = matches[0]
        self.assertEqual(
            (device["name"], device["maker"], device["class"], device["type"]),
            ("LilyGO T-Beam 1W", "lilygo", "openhop", "esp32"),
        )
        self.assertEqual(device["icon"], "/img/lora.svg")
        self.assertNotIn("image", device)
        firmware = device["firmware"][0]
        self.assertEqual(firmware["role"], "openHopModem")
        self.assertEqual(firmware["minimumRelease"], "v1.4.0")
        self.assertIsNot(firmware.get("expandReleases"), False)
        self.assertEqual(list(firmware["version"]), ["main"])
        self.assertEqual(
            [(f["type"], f["name"], f["address"]) for f in firmware["version"]["main"]["files"]],
            [("flash-update", "lilygo_tbeam_1w/firmware.bin", 0x10000),
             ("flash-wipe", "lilygo_tbeam_1w/firmware.factory.bin", 0x0)],
        )
        # Release expansion replaces version notes, so warnings must also survive as a notice.
        for text in (firmware["version"]["main"]["notes"], firmware["notice"]):
            for required in ("Flash", "Erase Device", "erases settings", "antenna", "7.4 V", "battery pack", "at least 2 A discharge", "USB-C", "sustained high-power"):
                self.assertIn(required, text)
        supreme = next(d for d in self.config["device"] if d["name"] == "LilyGo T-Beam-S3 Supreme")
        self.assertFalse(supreme["firmware"][0]["expandReleases"])
        self.assertTrue(all(f["name"].startswith("lilygo_tbeam_s3_supreme/") for f in self.firmware_files_for_device(supreme["name"])))

    def test_tbeam_1w_readme_documents_minimum_release_and_safe_modes(self):
        readme = (REPO_ROOT / "README.md").read_text()
        self.assertIn("- LilyGO T-Beam 1W (v1.4.0 and newer)", readme)
        for required in ("lilygo_tbeam_1w/firmware.bin", "lilygo_tbeam_1w/firmware.factory.bin", "erases settings", "7.4 V", "battery pack", "at least 2 A discharge", "USB-C"):
            self.assertIn(required, readme)

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
        self.assertNotIn("expandReleases", station_g3["firmware"][0])
        self.assertEqual(station_g3["firmware"][0]["minimumRelease"], "v1.1.0")
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

    def test_rak3401_modem_uses_v120_and_later_nrf52_dfu_packages(self):
        rak3401 = next(
            device
            for device in self.config["device"]
            if device["name"] == "RAK3401 + RAK13302"
        )

        self.assertEqual(rak3401["maker"], "rak")
        self.assertEqual(rak3401["type"], "nrf52")
        self.assertEqual(rak3401["image"], "/img/rak_1w.svg")
        self.assertEqual(rak3401["icon"], "/img/rak_1w.svg")
        self.assertTrue((REPO_ROOT / "img" / "rak_1w.svg").is_file())
        self.assertNotIn("expandReleases", rak3401["firmware"][0])
        self.assertEqual(rak3401["firmware"][0]["minimumRelease"], "v1.2.0")
        self.assertEqual(
            self.firmware_files_for_device("RAK3401 + RAK13302"),
            [
                {
                    "type": "flash",
                    "name": "rak3401/firmware.zip",
                    "title": "rak3401/firmware.zip",
                }
            ],
        )

    def test_rak4631_usb_modem_uses_v110_and_later_nrf52_dfu_packages(self):
        rak_usb = next(
            device
            for device in self.config["device"]
            if device["name"] == "RAK4631 USB"
        )

        self.assertEqual(rak_usb["maker"], "rak")
        self.assertEqual(rak_usb["type"], "nrf52")
        self.assertEqual(rak_usb["image"], "/img/rak_4631.svg")
        self.assertTrue((REPO_ROOT / "img" / "rak_4631.svg").is_file())
        self.assertNotIn("expandReleases", rak_usb["firmware"][0])
        self.assertEqual(rak_usb["firmware"][0]["minimumRelease"], "v1.1.0")
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
