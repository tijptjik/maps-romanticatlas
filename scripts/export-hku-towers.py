"""Export HKU artwork painted on a fixed geographic frame, with survey review cards."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cards-only', action='store_true', help='refresh review cards without exporting map assets')
args = parser.parse_args()

source = Path('releases/sources')
batch = Path('generated-tiles/dream-atlas')
work = batch / 'hku-in-place'
output = Path('public/hku-skyscrapers-in-place')
choices = json.loads((source / 'hku-selection.json').read_text())
site = json.loads((source / 'hku-footprint.json').read_text())
frame = json.loads((work / 'frame.json').read_text())
crop = frame['crop']
size = frame['tileSize']
zoom, x, y = site['baseTile']
base = Image.new('RGB', (size, 2*size))
for row in range(2):
    with Image.open(batch / 'references' / f'{zoom}-{x}-{y+row}.png') as tile:
        base.paste(tile.resize((size, size)), (0, row*size))
rings = [site['coordinatesInBaseTile'], *site['holes']]
panel_width = 330
panel_height = round(panel_width * (crop[3]-crop[1]) / (crop[2]-crop[0]))
font = ImageFont.truetype('DejaVuSans.ttf', 17)
small = ImageFont.truetype('DejaVuSans.ttf', 13)

def board():
    return Image.new('RGB', (panel_width * len(choices), panel_height + 56), '#fff9e9')

comparison = board()
survey = board()
output.mkdir(exist_ok=True)
for index, choice in enumerate(choices):
    edition = choice.get('edition', '')
    with Image.open(work / choice['slug'] / edition / 'painting.png') as original:
        w, h = crop[2]-crop[0], crop[3]-crop[1]
        if abs(original.width / original.height / (w/h) - 1) > .01:
            raise ValueError('Painting changed map frame: ' + choice['slug'])
        # One map scale and translation for the whole scene, including streets.
        # No per-building anchors, warping, key colour or extracted silhouette.
        painting = original.convert('RGB').resize((w,h), Image.Resampling.LANCZOS)
    plate = base.copy()
    plate.paste(painting, (crop[0], crop[1]))
    if not args.cards_only:
        plate.save(output / (choice['slug']+'.webp'), quality=95, method=6)
    if choice.get('reviewEdition'):
        with Image.open(work / choice['slug'] / choice['reviewEdition'] / 'painting.png') as review:
            if abs(review.width / review.height / (w/h) - 1) > .01:
                raise ValueError('Review painting changed map frame: ' + choice['slug'])
            painting = review.convert('RGB').resize((w,h), Image.Resampling.LANCZOS)
    audit = painting.copy()
    draw = ImageDraw.Draw(audit)
    surveyed = rings if choice['number'] == 6 else rings[:1]
    for num, coords in enumerate(surveyed):
        points = [(a*size-crop[0], b*size-crop[1]) for a,b in coords]
        draw.line(points, fill='#007790' if num == 0 else '#e9ff20', width=3)
    display = painting
    if choice.get('viewerImage'):
        with Image.open(Path('public') / choice['viewerImage'].lstrip('/')) as viewer:
            display = viewer.copy()
    for sheet, view in [(comparison,display),(survey,audit)]:
        left = index*panel_width
        preview = view.copy()
        preview.thumbnail((panel_width,panel_height),Image.Resampling.LANCZOS)
        sheet.paste(preview, (left+(panel_width-preview.width)//2,0))
        caption = ImageDraw.Draw(sheet)
        caption.text((left+7,panel_height+4),choice['title'],font=font,fill='#33291e')
        caption.text((left+7,panel_height+30),'HKU Main Building  ·  north up',font=small,fill='#514637')
comparison.save(batch/'cards/hku-skyscrapers-current.jpg', quality=94)
survey.save(work/'footprint-check.jpg',quality=94)
