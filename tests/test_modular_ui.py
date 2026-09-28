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

    def test_startup_redirect_and_production_graph(self):
        entry = source('flasher.js')
        self.assertIn("location.replace('/')", entry)
        for path in ['flasher.js', 'js/app.js', 'lib/overflow.vue.js']:
            self.assertNotIn('vue.min.js', source(path))
        self.assertRegex(source('index.html'), r'flasher\.js\?v=openhop13')
        for path in ['flasher.js', 'js/app.js', 'js/catalog.js', 'js/router.js', 'js/flash.js', 'js/serial.js', 'lib/overflow.vue.js']:
            for spec in re.findall(r'(?:from\s*|import\s*\()[\'"]([^\'"]+)', source(path)):
                if spec.startswith(('.', '/')):
                    self.assertIn('?v=openhop13', spec, (path, spec))

if __name__ == '__main__':
    unittest.main()
