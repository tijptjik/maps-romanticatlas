"""Regression checks for the staggered traversal and the persisted district job contract."""
from collections import Counter
from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atlas_central_western import BOOK, FOLDER, staggered


class DistrictPlan(unittest.TestCase):
    def test_row_phase_fallbacks_and_wrap(self):
        rows = {y:list(range(10,24)) for y in range(3)}
        sites = {(x,0) for x in (10,12,13,14,19,21,22)}
        sites.update((x,y) for y in (1,2) for x in rows[y])
        self.assertEqual(staggered(rows,sites),
                         [(10,0),(13,0),(14,0),(19,0),(22,0),
                          (11,1),(14,1),(17,1),(20,1),(23,1),
                          (12,2),(15,2),(18,2),(21,2),(23,2)])
        self.assertEqual(staggered({0:rows[0]},{(10,0),(12,0)}),[(10,0),(12,0)])

    def test_corpus(self):
        entries = [json.loads(p.read_text()) for p in BOOK.glob('*.json')]
        self.assertEqual(len(entries),24)
        self.assertTrue(all(len(book)==5 for book in entries))
        for field in ('name','prompt'):
            self.assertEqual(len({c[field] for book in entries for c in book}),120)

    @unittest.skipUnless((FOLDER/'jobs.json').exists(),'requires frozen local district inventory')
    def test_frozen_assignment(self):
        plan = json.loads((FOLDER/'jobs.json').read_text())
        jobs = plan['jobs']
        self.assertEqual(len({(j['x'],j['y']) for j in jobs}),len(jobs))
        self.assertEqual(set(Counter(j['family'] for j in jobs)),{p.stem for p in BOOK.glob('*.json')})
        for i,job in enumerate(jobs):
            self.assertTrue(job['selected'] and job['isTargetable'] and not job['coastal'])
            self.assertTrue(job['originalSha256'] and job['referenceSha256'])
            for other in jobs[:i]:
                if abs(job['x']-other['x'])<=4 and abs(job['y']-other['y'])<=4:
                    self.assertNotEqual(job['family'],other['family'])

if __name__ == '__main__':
    unittest.main()
