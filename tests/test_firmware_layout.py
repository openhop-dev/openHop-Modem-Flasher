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


if __name__ == "__main__":
    unittest.main()
