"""Regression checks for coastal selection after exact-edition edge repairs."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atlas_v2_grid as grid


class RepairSelectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.batch = Path(self.temp.name)
        self.folder = self.batch/'jobs'/'0085'
        self.folder.mkdir(parents=True)
        self.job = dict(id='0085', x=1, y=2, coastal=True)
        self.old = 'a'*64
        self.current = 'b'*64
        self.url = lambda digest: f'/atlas-v2/production/0085-{digest[:16]}.webp'
        self.reviews = {self.url(self.old): 'accepted'}
        self.write(self.folder/'production.json', dict(overlaySha256=self.current, edgeRepairOf=self.old))
        self.batch_patch = patch.object(grid, 'BATCH', self.batch)
        self.batch_patch.start()
        self.addCleanup(self.batch_patch.stop)

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def test_pending_repair_remains_in_original_slot_without_acceptance(self):
        base = dict(jobs=[self.job], retained=[], seed=1)
        with patch.object(grid, 'decisions', return_value=self.reviews), patch.object(grid, 'grid', return_value=[self.job]), patch.object(grid, 'coastal_option') as replacement:
            plan, _ = grid.effective_plan(base, include_supplement=False)
        self.assertEqual(plan['jobs'], [self.job])
        replacement.assert_not_called()
        self.assertNotIn(self.url(self.current), self.reviews)

    def test_current_rejection_overrides_approved_ancestor(self):
        self.reviews[self.url(self.current)] = 'rejected'
        self.assertFalse(grid.preserves_reviewed_scene(self.job, self.reviews))

    def test_repeated_repairs_follow_archived_receipts(self):
        intermediate = 'c'*64
        self.write(self.folder/'production.json', dict(overlaySha256=self.current, edgeRepairOf=intermediate))
        self.write(self.folder/'revisions'/'previous'/'production.json', dict(overlaySha256=intermediate, edgeRepairOf=self.old))
        self.assertTrue(grid.preserves_reviewed_scene(self.job, self.reviews))
        self.reviews[self.url(intermediate)] = 'rejected'
        self.assertFalse(grid.preserves_reviewed_scene(self.job, self.reviews))

    def test_unapproved_or_broken_lineage_does_not_preserve_scene(self):
        self.assertFalse(grid.preserves_reviewed_scene(self.job, {}))
        self.write(self.folder/'production.json', dict(overlaySha256=self.current))
        self.assertFalse(grid.preserves_reviewed_scene(self.job, self.reviews))

    def test_cyclic_lineage_terminates(self):
        self.write(self.folder/'revisions'/'cycle'/'production.json', dict(overlaySha256=self.old, edgeRepairOf=self.old))
        self.assertFalse(grid.preserves_reviewed_scene(self.job, {}))


if __name__ == '__main__':
    unittest.main()
