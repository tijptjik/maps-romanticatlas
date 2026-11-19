"""Protect scoped refill boundaries, replacement counting and crash recovery."""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atlas_v2_scope as scope


class ScopedDispatchTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.batch = self.root / 'generated-tiles/dream-atlas/production'
        self.batch.mkdir(parents=True)
        for name, value in [('ROOT', self.root), ('BATCH', self.batch),
                            ('SUPPLEMENT', self.batch/'grid-additions.json')]:
            override = patch.object(scope, name, value)
            override.start()
            self.addCleanup(override.stop)
        self.write(self.root/'releases/v2-reviews.json', [])
        self.write(self.root/'public/atlas-v2/catalog.json', dict(sheets=[]))
        self.write(self.batch/'jobs.json', dict(jobs=[], retained=[]))

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def art(self, name, colour='red', x=10, y=20, rows=1):
        url = '/atlas-v2/' + name + '.png'
        path = self.root/'public'/url.lstrip('/')
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (8, 8), colour).save(path)
        return dict(title=name, url=url, x=x, y=y, rows=rows)

    def catalog(self, art, accepted=False):
        self.write(self.root/'public/atlas-v2/catalog.json',
                   dict(sheets=[dict(art=art, accepted=accepted)]))

    def test_external_replacement_and_multitile_footprint_fill_slots(self):
        replacement = self.art('replacement', rows=2)
        self.catalog([replacement], accepted=True)
        inventory, unavailable, _ = scope.current_inventory([], {(10, 20), (10, 19)})
        rows = scope.deficits([dict(x=10, y=20, required=1), dict(x=10, y=19, required=1)], inventory)
        self.assertEqual([row['missing'] for row in rows], [0, 0])
        self.assertEqual(unavailable, [])

    def test_duplicate_sheets_bytes_and_revision_lineage_count_once(self):
        original = self.art('original')
        alias = self.art('alias')
        self.catalog([original, alias, original], accepted=True)
        candidate = dict(original, url='/artwork-revisions/revision.png')
        folder = self.batch.parent/'review-revisions/jobs/revision'
        self.write(folder/'revision.json', dict(state='ready', source=alias, candidate=candidate))
        Image.new('RGB', (8, 8), 'blue').save(folder/'candidate.png')
        inventory, _, _ = scope.current_inventory([], {(10, 20)})
        self.assertEqual(len(inventory[10, 20]), 1)
        option = next(iter(inventory[10, 20].values()))
        self.assertEqual(option['status'], 'accepted')
        self.assertEqual(option['urls'], {original['url'], alias['url'], candidate['url']})

    def test_rejected_source_with_pending_revision_already_has_candidate(self):
        original = self.art('original')
        self.catalog([original], accepted=True)
        self.write(self.root/'releases/v2-reviews.json', [dict(original, status='rejected')])
        candidate = dict(original, url='/artwork-revisions/revision.png')
        folder = self.batch.parent/'review-revisions/jobs/revision'
        self.write(folder/'revision.json', dict(state='ready', source=original, candidate=candidate))
        Image.new('RGB', (8, 8), 'blue').save(folder/'candidate.png')
        inventory, _, _ = scope.current_inventory([], {(10, 20)})
        row = scope.deficits([dict(x=10, y=20, required=1)], inventory)[0]
        self.assertEqual((row['accepted'], row['pending'], row['missing']), (0, 1, 0))

    def test_registered_image_before_publication_is_recovered_as_pending(self):
        job = dict(id='0010', x=10, y=20, name='Recovered', option=1)
        folder = self.batch/'jobs/0010'
        folder.mkdir(parents=True)
        Image.new('RGB', (8, 8), 'red').save(folder/'overlay.webp')
        import hashlib
        digest = hashlib.sha256((folder/'overlay.webp').read_bytes()).hexdigest()
        self.write(folder/'production.json', dict(overlaySha256=digest))
        inventory, unavailable, _ = scope.current_inventory([job], {(10, 20)})
        self.assertEqual(len(inventory[10, 20]), 1)
        self.assertFalse(unavailable)
        self.assertEqual(scope.deficits([dict(x=10, y=20, required=1)], inventory)[0]['missing'], 0)

    def test_dispatch_uses_only_missing_options_and_leaves_other_cells_alone(self):
        jobs = [dict(id=str(index), x=10, y=20, option=index) for index in range(1, 4)]
        jobs.append(dict(id='other', x=30, y=40, option=1))
        self.write(self.batch/'jobs/1/production.json', dict(overlaySha256='a'*64))
        source = '/atlas-v2/production/1-' + 'a'*16 + '.webp'
        inventory = {(10, 20): {'revision': dict(urls={source, '/artwork-revisions/r.png'})}}
        selected = scope.dispatch_jobs([dict(x=10, y=20, missing=1)], jobs, inventory)
        self.assertEqual([job['id'] for job in selected], ['2'])

    def test_hku_quota_survives_automatic_land_cutoff_but_north_does_not(self):
        base = dict(jobs=[dict(x=30, y=40, region=scope.NORTH)])
        self.write(self.batch/'sites.json', dict(sites=[dict(x=10, y=20, region='HKU', ring=2)]))
        def inspect(action, tiles):
            return [dict(tile, selected=True, isTargetable=False) for tile in tiles]
        with patch.object(scope, 'grid', side_effect=inspect):
            targets, excluded = scope.scope_targets(base, ['hku', 'north'], [])
        self.assertEqual([(row['x'], row['required']) for row in targets], [(214184, 5), (10, 3)])
        self.assertEqual([(row['x'], row['y']) for row in excluded], [(30, 40)])

    def test_scope_run_freezes_initial_gaps_and_uses_existing_worker(self):
        target = dict(x=10, y=20, region='HKU', required=2)
        already_full = dict(x=11, y=20, region='HKU', required=1)
        job = dict(id='0010', x=10, y=20, option=2)
        completed = set()
        def snapshot(base, targets):
            rows = [dict(site, missing=int(site['x'] == 10 and not completed)) for site in targets]
            return dict(cells=rows, jobs=[] if completed else [job], unavailable=[], sources={},
                        missing=sum(row['missing'] for row in rows), acceptanceMissing=1)
        def generate(*arguments):
            completed.add(arguments[0]['id'])
            return 'ready'
        production = SimpleNamespace(legacy={'file_hash': lambda path: 'hash', 'exclusive': lambda **kwargs: nullcontext('lock')},
            stop=threading.Event(), save=self.write, make_examples=lambda: [],
            illustration_direction=lambda: 'direction', reconcile_rejections=Mock(),
            generate=Mock(side_effect=generate), valid=lambda job: True, publish=Mock())
        args = SimpleNamespace(scope=['hku'], cell=None, action='run', workers=1)
        with patch.object(scope, 'scope_targets', return_value=([target, already_full], [])), \
             patch.object(scope, 'snapshot', side_effect=snapshot), patch.object(scope.signal, 'signal'):
            scope.run(production, args)
        production.generate.assert_called_once()
        self.assertEqual(production.reconcile_rejections.call_args.args[0], [job])
        manifest = json.loads(next((self.batch/'scopes').glob('*/run-*.json')).read_text())
        self.assertEqual([row['x'] for row in manifest['targets']], [10])
        status = json.loads(next((self.batch/'scopes').glob('*/status.json')).read_text())
        self.assertEqual(status['state'], 'ready-for-review')

    def test_interrupted_run_resumes_frozen_cells_when_new_gaps_appear_elsewhere(self):
        selection = dict(scopes=['hku'], cells=[])
        import hashlib
        identity = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()[:16]
        folder = self.batch/'scopes'/identity
        target = dict(x=10, y=20, required=1)
        later_gap = dict(x=11, y=20, required=1)
        self.write(folder/'run-1.json', dict(file='run-1.json', selection=selection, targets=[target]))
        self.write(folder/'status.json', dict(state='generating', manifest='run-1.json'))
        calls = []
        def snapshot(base, targets):
            calls.append(targets)
            return dict(cells=[dict(site, missing=0) for site in targets], jobs=[], unavailable=[],
                        sources={}, missing=0, acceptanceMissing=1)
        production = SimpleNamespace(legacy={'file_hash': lambda path: 'hash', 'exclusive': lambda **kwargs: nullcontext('lock')},
            stop=threading.Event(), save=self.write, make_examples=lambda: [],
            illustration_direction=lambda: 'direction', generate=Mock(), publish=Mock())
        args = SimpleNamespace(scope=['hku'], cell=None, action='run', workers=1)
        with patch.object(scope, 'scope_targets', return_value=([target, later_gap], [])), \
             patch.object(scope, 'snapshot', side_effect=snapshot), patch.object(scope.signal, 'signal'):
            scope.run(production, args)
        self.assertTrue(all(targets == [target] for targets in calls))
        production.generate.assert_not_called()

    def test_missing_existing_asset_blocks_optimistic_inventory(self):
        art = self.art('missing')
        self.catalog([art], accepted=True)
        scope.artwork_path(art['url']).unlink()
        inventory, unavailable, _ = scope.current_inventory([], {(10, 20)})
        self.assertEqual(len(unavailable), 1)
        self.assertEqual(dict(inventory), {})

    def test_changed_bytes_cannot_inherit_hash_bound_review(self):
        art = self.art('changed')
        art['url'] += '?v=' + '0'*16
        self.catalog([art], accepted=True)
        inventory, unavailable, _ = scope.current_inventory([], {(10, 20)})
        self.assertEqual(unavailable[0]['error'], 'Artwork bytes differ from the reviewed URL')
        self.assertEqual(dict(inventory), {})

    def test_retained_rejection_reports_additive_slot_without_reusing_live_job(self):
        job = dict(id='0010', x=10, y=20, option=1)
        self.write(self.batch/'jobs/0010/production.json', dict(overlaySha256='a'*64))
        url = '/atlas-v2/production/0010-' + 'a'*16 + '.webp'
        inventory = {(10, 20): {'current': dict(urls={url})}}
        shortages = []
        selected = scope.dispatch_jobs([dict(x=10, y=20, required=4, missing=1)], [job], inventory, shortages)
        self.assertEqual(selected, [])
        self.assertEqual(shortages[0]['newSlots'], 1)

    def test_additive_slot_is_saved_once_and_reused_after_interruption(self):
        base = dict(seed=5, jobs=[dict(id='0010', x=30, y=40, option=1, family='first', prompt='brief')],
                    retained=[dict(x=10, y=20, family='first')]*3)
        row = dict(x=10, y=20, region='HKU', ring=1, required=4, missing=1, newSlots=1)
        self.write(self.root/'releases/sources/families/second.json', [dict(name='Second', prompt='Second brief')])
        def prepare(action, tiles):
            self.assertEqual(action, 'prepare')
            return [dict(tiles[0], referenceSha256='reference')]
        def make_jobs(sites, families, seed, seen, rejected):
            self.assertEqual(sites[0]['existingOptions'], 3)
            self.assertEqual(sites[0]['options'], 4)
            return [dict(x=10, y=20, option=4, family='second', prompt='Second brief')]
        with patch.object(scope, 'grid', side_effect=prepare), \
             patch.object(scope.runpy, 'run_path', return_value={'make_jobs': make_jobs}), \
             patch('atlas_v2_registration._layout', return_value=(None, SimpleNamespace(mean=lambda: .5), None, None)):
            written = scope.add_scope_slots(base, [row], self.write)
        self.assertEqual(written, ['0011'])
        jobs = json.loads(scope.SUPPLEMENT.read_text())
        self.assertEqual(len(jobs), 1)
        self.assertTrue(jobs[0]['scopedRefill'])
        shortages = []
        selected = scope.dispatch_jobs([row], jobs, {}, shortages)
        self.assertEqual([job['id'] for job in selected], ['0011'])
        self.assertEqual(shortages, [])


if __name__ == '__main__':
    unittest.main()
