"""Exclusive z18 artwork footprint, shared with the map through the registered site."""
import json
from pathlib import Path

SITE = json.loads((Path(__file__).resolve().parents[1] / 'releases/sources/peak-maquette/site.json').read_text())


def overlaps_peak(art):
    return (art['x'] < SITE['x'] + SITE['columns'] and art['x'] + art.get('columns', 1) > SITE['x']
            and art['y'] > SITE['y'] - SITE['rows'] and art['y'] - art.get('rows', 1) < SITE['y'])


def allows_artwork(art):
    return not overlaps_peak(art) or (art.get('url') == SITE['image']
        and all(art.get(key, 1) == SITE[key] for key in ('x', 'y', 'rows', 'columns')))
