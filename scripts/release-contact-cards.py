"""Refresh the v2 review sheets from the pinned coastal exports and latest HKU editions."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

gallery = Path('generated-tiles/dream-atlas/cards')
manifest = json.loads(Path('releases/v2-artwork.json').read_text())
font = ImageFont.truetype('DejaVuSans.ttf', 18)
for collection in manifest['collections']:
    for art in collection['artworks']:
        if hashlib.sha256(Path(art['image']).read_bytes()).hexdigest() != art['sha256']:
            raise ValueError('Release image changed: ' + art['image'])
    if collection['title'] == 'HKU Main Building':
        subprocess.run([sys.executable, 'scripts/export-hku-towers.py', '--cards-only'], check=True)
        continue
    if collection.get('isolated'):
        # Cell cards are composed against the surveyed tile by the ring exporter.
        for card in collection['galleryCards']:
            with Image.open(gallery / card) as sheet:
                sheet.verify()
        continue
    if not collection.get('fullTile'):
        study = json.loads(Path(collection['source']).read_text())
        scenes = {(t['x'], t['y']): t['scene'] for t in study['tiles']}
    for offset, filename in enumerate(collection['galleryCards']):
        row = collection['artworks'][5*offset:5*offset+5]
        sheet = Image.new('RGB', (400*len(row), 448), '#fff9e9')
        draw = ImageDraw.Draw(sheet)
        for column, art in enumerate(row):
            with Image.open(art['image']) as painting:
                tile = painting.convert('RGBA')
                if not collection.get('fullTile'):
                    scene = scenes[tuple(art['tile'][1:])]
                    source = Path('generated-tiles') / study['slug'] / (scene+'-sourceImage.png')
                    with Image.open(source) as base:
                        background = base.convert('RGBA').resize(tile.size, Image.Resampling.NEAREST)
                    background.alpha_composite(tile)
                    tile = background
                sheet.paste(tile.resize((400,400), Image.Resampling.LANCZOS), (400*column,0))
            title = art['title'].replace(' · ', '\n')
            draw.multiline_text((400*column+8,402), title, font=font, fill='#33291e', spacing=0)
        sheet.save(gallery / filename, quality=94)
