"""Check generated PNGs and exercise the renderer's retry with a file-backed stand-in."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'dream-atlas.py'
spec = importlib.util.spec_from_file_location('renderer', SCRIPT)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class BlackColumnsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / 'tile.png'

    def test_exact_full_height_columns(self):
        for x in (0, 253, 511):
            with self.subTest(x=x):
                image = Image.new('RGB', (512, 512), 'white')
                image.paste('black', (x, 0, x + 1, 512))
                image.save(self.path)
                with self.assertRaisesRegex(renderer.BlackColumnError, f'x={x} '):
                    renderer.check_png(self.path)
                self.assertEqual(renderer.check_png(self.path, reference=True), 512)
                for color in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
                    image.putpixel((x, 511), color)
                    image.save(self.path)
                    self.assertEqual(renderer.check_png(self.path), 512)

    def test_transparent_margin(self):
        image = Image.new('RGBA', (512, 512), 'white')
        image.paste((0, 0, 0, 0), (0, 0, 10, 512))
        image.save(self.path)
        self.assertEqual(renderer.check_png(self.path), 512)
        image.paste((0, 0, 0, 255), (9, 0, 10, 512))
        image.save(self.path)
        with self.assertRaisesRegex(renderer.BlackColumnError, 'x=9 '):
            renderer.check_png(self.path)

    def test_retry_and_receipt(self):
        image = Image.new('RGB', (512, 512), 'white')
        image.paste('black', (111, 0, 112, 512))
        image.save(self.root / 'bad.png')
        image.putpixel((111, 511), (0, 0, 1))
        image.save(self.root / 'good.png')
        fake = self.root / 'codex'
        fake.write_text(f'#!{sys.executable}\n' + '''
import json, os, shutil, sys, uuid
from pathlib import Path
root = Path(sys.argv[sys.argv.index('-C') + 1])
cache = root / 'cache'
image = 'good.png' if os.environ['REPLACE'] == 'yes' and cache.exists() else 'bad.png'
thread = str(uuid.uuid4())
folder = cache / thread
folder.mkdir(parents=True)
shutil.copyfile(root / image, folder / 'output.png')
print(json.dumps({'type': 'thread.started', 'thread_id': thread}))
''')
        fake.chmod(0o700)
        for replace in ('no', 'yes'):
            root = self.root / replace
            root.mkdir()
            for name in ('bad.png', 'good.png'):
                (root / name).symlink_to(self.root / name)
            source = Image.new('RGB', (512, 512), 'tan')
            source.putpixel((0, 0), (255, 255, 255))
            source.save(root / 'source.png')
            job = dict(id='tile', reference='source.png', drawing='', context='', prompt='fixture')
            with self.subTest(replace=replace), patch.multiple(
                    renderer, ROOT=root, OUT=root / 'live', CACHE=root / 'cache',
                    edge_and_figure_directions=lambda: {}), patch.dict(
                    os.environ, PATH=str(self.root), REPLACE=replace), (root / 'lock').open('a') as lock:
                result = renderer.child(job, lock, 10)
                attempts = sorted(renderer.where(job, 'attempts').glob('*.json'))
                self.assertEqual(len(attempts), 2, (result, [renderer.load(p) for p in attempts]))
                self.assertEqual(renderer.load(attempts[0])['rejection'], 'black-column')
                self.assertIn('x=111 ', renderer.load(attempts[0])['invalidCachedImage'])
                if replace == 'yes':
                    self.assertEqual(result, 'saved')
                    receipt = renderer.load(renderer.where(job, 'result.json'))
                    self.assertEqual(receipt['source'], 'thread ' + renderer.load(attempts[1])['thread'])
                    self.assertEqual(renderer.where(job, 'image.png').read_bytes(), (root / 'good.png').read_bytes())
                else:
                    self.assertEqual(result, 'black-column')
                    self.assertFalse(renderer.where(job, 'result.json').exists())
                    self.assertFalse(renderer.where(job, 'image.png').exists())


if __name__ == '__main__':
    unittest.main()
