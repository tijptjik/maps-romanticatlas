"""Export the V2 review map catalog and its map-ready paintings."""
import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path

from PIL import Image
from atlas_artwork_reservation import allows_artwork

root = Path(__file__).resolve().parents[1]
batch = root / 'generated-tiles/dream-atlas'
out = root / 'public/atlas-v2'
out.mkdir(exist_ok=True)


def read(path):
    return json.loads(path.read_text())


def export(image, filename):
    with tempfile.NamedTemporaryFile(dir=out, delete=False) as tmp:
        try:
            image.save(tmp, format='WEBP', quality=94, method=4)
            tmp.close()
            os.replace(tmp.name, out / filename)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
    return '/atlas-v2/' + filename


sheets = []
release = read(root / 'releases/v2-artwork.json')
choices = {c['title']: c for c in read(root / 'releases/sources/hku-selection.json')}
assert release['status'] == 'accepted'
for group in release['collections']:
    entries = []
    for art in group['artworks']:
        path = root / art['image']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == art['sha256'], path
        url = '/' + path.relative_to(root / 'public').as_posix() + '?v=' + art['sha256'][:16]
        cells = group.get('clickTiles') or [art['tile']]
        _, x, y = max(cells, key=lambda c: c[2])
        choice = choices.get(art['title'], {})
        if choice.get('viewerImage'):
            viewer_image = root / 'public' / choice['viewerImage'].lstrip('/')
            digest = hashlib.sha256(viewer_image.read_bytes()).hexdigest()
            url = choice['viewerImage'] + '?v=' + digest[:16]
        elif choice.get('reviewEdition'):
            folder = batch / 'hku-in-place'
            original = folder / choice['slug'] / choice['reviewEdition'] / 'painting.png'
            frame = read(folder / 'frame.json')['crop']
            digest = hashlib.sha256(original.read_bytes() + path.read_bytes() + str(frame).encode()).hexdigest()
            filename = choice['slug'] + '-' + digest[:16] + '.webp'
            if not (out / filename).exists():
                with Image.open(path) as base, Image.open(original) as painting:
                    base = base.convert('RGB')
                    base.paste(painting.resize((frame[2]-frame[0],frame[3]-frame[1]),Image.Resampling.LANCZOS),frame[:2])
                    export(base, filename)
            url = '/atlas-v2/' + filename
        entry = dict(title=art['title'], x=x, y=y, rows=len(cells), url=url)
        if 'scene' in art:
            entry['scene'] = art['scene']
        entries.append(entry)
    for i, card in enumerate(group['galleryCards']):
        sheets.append(dict(id=Path(card).stem, title=group['title'], accepted=True, art=entries[i*5:i*5+5], **({'isolated': True} if group.get('isolated') else {})))

# These registered plates span the anchor tile and its northern neighbour.
for slug in ('harbour-airworks', 'western-district-towers', 'rain-exchange',
             'kowloon-grand-skyworks'):
    study = read(root / 'releases/sources' / (slug + '.json'))
    entries = []
    for tile in study['tiles']:
        x, y = tile['x'], tile['y']
        path = root / 'public' / slug / f'{x}-{y}.webp'
        digest = hashlib.sha256(path.read_bytes())
        url = f'/{slug}/{path.name}?v={digest.hexdigest()[:16]}'
        animation = {}
        if tile.get('glitterOrigin'):
            animation['glitterOrigin'] = tile['glitterOrigin']
        if tile.get('auditoriumOriginPixels'):
            animation['auditoriumOriginPixels'] = tile['auditoriumOriginPixels']
        # Retain the still URL as the review identity and static fallback.
        if motion := tile.get('motion'):
            sprite = path.with_name(motion['sprite'] + '.webp')
            animation.update(motion=motion, folder=slug, plate=url)
            digest.update(sprite.read_bytes())
            digest.update(str(motion['box']).encode())
            filename = f'{slug}-{x}-{y}-{digest.hexdigest()[:16]}.webp'
            if not (out / filename).exists():
                with Image.open(path) as plate, Image.open(sprite) as figure:
                    still = plate.convert('RGBA')
                    still.alpha_composite(figure.convert('RGBA'), tuple(motion['box'][:2]))
                    export(still, filename)
            url = '/atlas-v2/' + filename
        entry = dict(title=tile['title'], x=x, y=y, rows=2, url=url)
        if animation:
            entry['animation'] = dict(animation, pixelsPerTile=tile['illustration']['pixelsPerTile'])
        entries.append(entry)
    sheets.append(dict(id=slug, title='Skyscrapers · ' + study['title'], isolated=True, art=entries))

v2 = batch / 'v2'
families = defaultdict(list)
for job in read(v2 / 'jobs.json')['jobs']:
    families[job['family']].append(job)
for family, jobs in families.items():
    for offset in range(0,len(jobs),5):
        key = f'{family}-v2-{offset//5+1:02d}'
        if not (batch / 'cards' / (key+'.jpg')).is_file():
            continue
        row = jobs[offset:offset+5]
        assert len(row) == 5
        entries = []
        for job in row:
            folder = v2 / 'jobs' / job['id']
            digest = read(folder / 'result.json')['sha256']
            filename = job['id']+'-'+digest[:16]+'.webp'
            if not (out / filename).exists():
                src = folder/'image.png'
                assert hashlib.sha256(src.read_bytes()).hexdigest() == digest
                with Image.open(src) as painting:
                    export(painting, filename)
            entries.append(dict(title=job['name'], scene=family, x=job['x'], y=job['y'], rows=1, url='/atlas-v2/'+filename))
        sheets.append(dict(id=key, title=family.replace('-',' ').title(), art=entries))

sheets.append(read(root / 'releases/sources/airport.json'))

coasters = out / 'coasters/sheet.json'
if coasters.is_file():
    sheets.append(read(coasters))

maquette = out / 'peak-maquette/sheet.json'
if maquette.is_file():
    sheets.append(read(maquette))

pilot = out / 'hku-cell-pilot/sheet.json'
if pilot.is_file():
    sheets.append(read(pilot))
for sheet in sorted(out.glob('hku-ring-*/sheet.json')):
    if sheet.parent.name not in {item['id'] for item in sheets}:
        sheets.append(read(sheet))

production = out / 'production/sheets.json'
if production.is_file():
    review_file = root / 'releases/v2-reviews.json'
    rejected = {r['url'] for r in read(review_file) if r['status'] == 'rejected'} if review_file.exists() else set()
    sheets = [sheet for sheet in sheets if any(art['url'] not in rejected for art in sheet['art'])]
    known = {sheet['id'] for sheet in sheets}
    sheets.extend(sheet for sheet in read(production)['sheets'] if sheet['id'] not in known)

sanctuary = read(root / 'releases/sources/cat-street-sanctuary.json')
cell_id = f"production-cell-18-{sanctuary['x']}-{sanctuary['y']}"
cell = next((sheet for sheet in sheets if sheet['id'] == cell_id), None)
if cell is None:
    cell = dict(id=cell_id, title='Cat Street · Sheung Wan', isolated=True, art=[])
    sheets.append(cell)
cell['art'].append(sanctuary)
sheets.append(read(root / "releases/sources/tourist-disappearance-trap.json"))
sheets.append(read(root / 'releases/sources/space-elevator.json'))
sheets.append(read(root / 'releases/sources/west-kowloon-airship-mooring.json'))

# Legacy HKU sheets predate the scene field. Their titles are the authored
# concept names from the family books. Other one-off studies have their own subjects.
concept_families = {concept['name']: path.stem
                    for path in (root / 'releases/sources/families').glob('*.json')
                    for concept in read(path)}
scenes = {art['url']: art['scene'] for sheet in sheets for art in sheet['art'] if art.get('scene')}
for sheet in sheets:
    for art in sheet['art']:
        scene = scenes.get(art['url'])
        if not scene and art['url'].startswith('/atlas-v2/hku-'):
            scene = concept_families.get(art['title'])
        if scene:
            art['scene'] = scene

for sheet in sheets:
    sheet['art'] = [art for art in sheet['art'] if allows_artwork(art)]
sheets = [sheet for sheet in sheets if sheet['art']]

with tempfile.NamedTemporaryFile(mode='w', dir=out, delete=False) as tmp:
    json.dump(dict(release='v2', sheets=sheets), tmp, ensure_ascii=False, indent=2)
    tmp.write('\n')
os.replace(tmp.name, out/'catalog.json')
