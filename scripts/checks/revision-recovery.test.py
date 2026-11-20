"""Exercise the SI revision loop and its on-disk state without a generator account."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

from PIL import Image
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Path(temp.name)
        with patch.dict(os.environ, ATLAS_GENERATOR_ROOT=str(ROOT)), patch.object(sys, 'argv', ['gateway', 'work']):
            spec = importlib.util.spec_from_file_location('gateway', ROOT / 'server/si/gateway.py')
            self.gateway = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.gateway)
        self.worker = self.gateway.revisions
        self.worker.STORE = self.store
        self.worker.JOBS = self.store / 'jobs'

    def job(self, name, created):
        folder = self.worker.JOBS / name
        folder.mkdir(parents=True)
        record = folder / 'revision.json'
        self.worker.atomic(record, dict(id=name, created=created, state='pending'))
        return record

    def poll(self, now, finish):
        # Stop at the gateway's next poll, like restarting the service between passes.
        with patch.object(self.worker, 'finish', side_effect=finish) as render, \
                patch('time.time', return_value=now), patch('time.sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                self.gateway.revision_worker()
            return [call.args[1]['id'] for call in render.call_args_list]

    def test_queue_cooldown_and_retry_exhaustion(self):
        first = self.job('first', 1)
        second = self.job('second', 2)
        rate = self.worker.GenerationError('rate')
        self.assertEqual(self.poll(1000, rate), ['first'])
        self.assertEqual(json.loads(first.read_text())['retryAt'], 1060)
        self.assertEqual(self.poll(1059, rate), [])
        self.assertEqual(self.poll(1060, rate), ['first'])
        self.assertEqual(self.poll(1180, rate), ['first'])
        self.assertEqual(self.poll(1420, rate), ['first'])
        failed = json.loads(first.read_text())
        self.assertEqual((failed['state'], failed['failedAttempts'], failed['lastError']), ('failed', 4, 'rate'))
        self.assertNotIn('retryAt', failed)
        self.assertEqual(json.loads(second.read_text())['state'], 'pending')
        self.assertEqual(self.poll(1660, self.worker.GenerationError('quota')), ['second'])
        self.assertEqual(json.loads(second.read_text())['state'], 'failed')

    def test_dev_worker_recovers_cached_png_on_scheduled_retry(self):
        root = self.store
        scripts = root / 'scripts'
        scripts.mkdir()
        for name in ('review-revisions.py', 'dream-atlas.py'):
            shutil.copyfile(ROOT / 'scripts' / name, scripts / name)
        job_id = uuid.uuid4().hex
        job = root / 'generated-tiles/dream-atlas/review-revisions/jobs' / job_id
        (job / 'attempts').mkdir(parents=True)
        thread = str(uuid.uuid4())
        cache = root / 'generated_images' / thread
        cache.mkdir(parents=True)
        image = Image.new('RGB', (512, 512), 'white')
        image.putpixel((0, 0), (0, 0, 0))
        image.save(job / 'source.png')
        image.paste('#ff00ff', (0, 0, 512, 512))
        image.paste('green', (128, 128, 384, 384))
        image.save(cache / 'result.png')
        (job / 'attempts/0001.json').write_text(json.dumps({'thread': thread}))
        record = dict(id=job_id, state='pending', mode='generate', created=1,
                      source=dict(title='Fixture', rows=1, scene='circus'), prompt='Fixture',
                      lastError='timeout', failedAttempts=1, retryAt=4102444800)
        path = job / 'revision.json'
        def run_worker():
            result = subprocess.check_output([sys.executable, scripts / 'review-revisions.py', 'work'],
                                             env={**os.environ, 'CODEX_HOME': str(root), 'PATH': ''})
            return json.loads(result)
        path.write_text(json.dumps(record))
        self.assertEqual(run_worker(), record['retryAt'])
        record['retryAt'] = 1
        path.write_text(json.dumps(record))
        self.assertIsNone(run_worker())
        result = json.loads(path.read_text())
        self.assertEqual((result['state'], result['id']), ('ready', job_id))
        self.assertNotIn('retryAt', result)
        self.assertNotIn('lastError', result)
        with Image.open(job / 'candidate.png') as candidate:
            self.assertEqual(candidate.getchannel('A').getextrema(), (0, 255))

    def test_timeout_allows_other_work_and_withdrawal(self):
        first = self.job('a' * 32, 1)
        second = self.job('b' * 32, 2)

        def finish(folder, record):
            if folder == first.parent:
                raise self.worker.GenerationError('timeout')
            record['state'] = 'ready'

        self.assertEqual(len(self.poll(100, finish)), 2)
        self.assertEqual(json.loads(second.read_text())['state'], 'ready')
        self.assertEqual(json.loads(first.read_text())['retryAt'], 130)
        self.worker.withdraw(first.parent.name)
        self.assertEqual(self.poll(130, finish), [])


if __name__ == '__main__':
    unittest.main()
