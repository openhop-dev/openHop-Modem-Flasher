import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def source(path):
    revision = os.environ.get('TEST_REVISION')
    return subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=ROOT, text=True) if revision else (ROOT / path).read_text()

class ModularUITest(unittest.TestCase):
    def test_branding_and_docs_on_every_screen(self):
        html = source('index.html')
        self.assertIn('<title>openHop MeshCore Flasher</title>', html)
        self.assertIn('og:description', html)
        self.assertIn('twitter:image', html)
        self.assertIn('alt="openHop logo"', html)
        self.assertEqual(html.count('href="https://docs.openhop.dev/projects/openhop-modem/flasher/"'), 5)
        self.assertIn('openHop Modem Firmware', html)
        self.assertNotIn('Repeater Setup', html)
        self.assertIn('device.image', html)

    def test_home_header_keeps_utilities_together(self):
        html = source('index.html')
        match = re.search(r'<nav class="top-nav">(.*?)</nav>', html, re.S)
        assert match is not None, 'Home header navigation is missing'
        nav = match.group(1)
        self.assertIn('aria-label="openHop on GitHub"', nav)
        self.assertNotIn('<div class="max"></div>', nav)
        self.assertNotIn('Custom Firmware', nav)
        self.assertEqual(html.count('@change="customFirmwareLoad"'), 1)
        self.assertIn('<strong style="font-size: small;">Custom Firmware</strong>', html)
        self.assertLess(nav.index('title="USB Serial Console"'), nav.index('<span>Docs</span>'))
        self.assertLess(nav.index('<span>Docs</span>'), nav.index('aria-label="openHop on GitHub"'))

    def test_safe_erase_and_release_controls(self):
        html = source('index.html')
        self.assertIn('class="erase-control"', html)
        self.assertIn('class="erase-box"', html)
        self.assertIn('<span>Erase Device</span>', html)
        self.assertIn('hasFlashWipe', html)
        self.assertIn('v-if="selected.device.erase" @click="nrfErase"', html)
        self.assertIn('currentVersion.releaseUrl', html)
        self.assertNotIn('v-html="formatChangeLog(currentVersion.notes)"', html)

    def test_flash_transaction_loading_and_cleanup_controls(self):
        html = source('index.html')
        self.assertIn("flashing.phase === 'selecting'", html)
        self.assertIn('Downloading firmware...', html)
        for action in ['retry', 'close']:
            buttons = re.findall(r'<button[^>]+@click="' + action + r'"[^>]*>', html)
            self.assertTrue(buttons)
            self.assertTrue(all(':disabled="flashing.busy"' in button for button in buttons))

    def test_startup_restoration_and_production_graph(self):
        entry = source('flasher.js')
        self.assertNotIn("location.replace('/')", entry)
        self.assertIn('await loadCatalog()', entry)
        self.assertIn('setup: createSetup(config)', entry)
        for path in ['flasher.js', 'js/app.js', 'lib/overflow.vue.js']:
            self.assertNotIn('vue.min.js', source(path))
        self.assertRegex(source('index.html'), r'flasher\.js\?v=openhop15')
        for path in ['flasher.js', 'js/app.js', 'js/catalog.js', 'js/router.js', 'js/flash.js', 'js/serial.js', 'lib/overflow.vue.js']:
            for spec in re.findall(r'(?:from\s*|import\s*\()[\'"]([^\'"]+)', source(path)):
                if spec.startswith(('.', '/')):
                    self.assertIn('?v=openhop15', spec, (path, spec))

if __name__ == '__main__':
    unittest.main()
