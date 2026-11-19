#!/usr/bin/env python3
"""Publish finished production cells for review and compare each five completed family members."""
from collections import defaultdict
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

from atlas_v2_grid import decisions, effective_plan

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / 'generated-tiles/dream-atlas/production'
PUBLIC = ROOT / 'public/atlas-v2/production'
GALLERY = BATCH.parent / 'cards'


def read(path):
    return json.loads(path.read_text())


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def replace(path, write):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        write(temporary)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def cell_key(job):
    return job['z'], job['x'], job['y']


def family_title(family):
    return family.replace('-', ' ').title()


def signature(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def panel_caption(draw, title, x, font):
    # Break long names using actual text metrics so adjacent panels never overlap.
    lines = ['']
    for word in title.split():
        candidate = (lines[-1] + ' ' + word).strip()
        if lines[-1] and draw.textlength(candidate, font=font) > 380:
            lines.append(word)
        else:
            lines[-1] = candidate
    for i, line in enumerate(lines):
        draw.text((x + 8, 406 + 21*i), line, font=font, fill='#342719')


def draw_card(path, row):
    card = Image.new('RGB', (400*len(row), 480), '#fff9e9')
    draw = ImageDraw.Draw(card)
    title = ImageFont.truetype('DejaVuSans.ttf', 17)
    caption = ImageFont.truetype('DejaVuSans.ttf', 14)
    for i, item in enumerate(row):
        with Image.open(ROOT / item['reference']) as source, Image.open(item['image']) as painting:
            overlay = painting.convert('RGBA')
            base = source.convert('RGBA').resize(overlay.size, Image.Resampling.LANCZOS)
            base.alpha_composite(overlay)
            card.paste(base.resize((400, 400), Image.Resampling.LANCZOS), (i*400, 0))
        panel_caption(draw, item['art']['title'], i*400, title)
        art = item['art']
        detail = f"{family_title(item['family'])} · {item['z']}/{art['x']}/{art['y']}"
        draw.text((i*400 + 8, 453), detail, font=caption, fill='#584937')
    replace(path, lambda temporary: card.save(temporary, format='JPEG', quality=94))


def publish():
    manifest, _ = effective_plan(read(BATCH / 'jobs.json'))
    jobs = manifest['jobs']
    sites_path = BATCH / 'selected-sites.json'
    sites = {cell_key(site): site for site in read(sites_path)} if sites_path.exists() else {}
    cells = defaultdict(list)
    retained = defaultdict(list)
    for art in manifest.get('retained', []):
        retained[cell_key(art)].append(art)
    rejected = {url for url,status in decisions().items() if status == 'rejected'}
    for job in jobs:
        cells[cell_key(job)].append(job)
    previous_path = BATCH / 'publication-cache.json'
    previous = read(previous_path) if previous_path.exists() else {}
    cache = {'images': {}, 'cards': {}}
    families = defaultdict(list)
    sheets = []
    links = []
    ready = []

    def make_sheet(key, title, section, row):
        filename = key + '.jpg'
        stamp = [[item['art'], item['family'], item['z'], item['reference'], item['referenceStat']] for item in row]
        if previous.get('cards', {}).get(key) != stamp or not (GALLERY / filename).is_file():
            draw_card(GALLERY / filename, row)
        cache['cards'][key] = stamp
        sheets.append(dict(id=key, title=title, isolated=True, art=[item['art'] for item in row]))
        links.append(dict(id=key, title=title, section=section, file=filename))

    def retained_panel(entry, reference):
        path = ROOT / entry['source']
        if digest(path) != entry['sha256']:
            raise ValueError(f'retained artwork changed: {path}')
        return dict(art={k: entry[k] for k in ('title', 'x', 'y', 'rows', 'url')},
                    family=entry.get('family') or 'Atlas V2', image=path, z=entry['z'],
                    reference=reference, referenceStat=signature(ROOT / reference))

    # Accepted live discoveries can fall outside this run's route. Their cached
    # image is the entire painted map tile, including its original background.
    for (z, x, y), entries in retained.items():
        if (z, x, y) in cells:
            continue
        row = [retained_panel(e, e['source']) for e in entries if not e.get('sheet') and e['url'] not in rejected]
        if row:
            title = f"{row[0]['art']['title']} · {z}/{x}/{y}"
            make_sheet(f'production-retained-{z}-{x}-{y}', title, 'Cells', row)

    for (z, x, y), group in cells.items():
        group.sort(key=lambda job: job['option'])
        if len({job['family'] for job in group}) != len(group):
            raise ValueError(f'duplicate scene family in {z}/{x}/{y}')
        if any(not (BATCH/'jobs'/job['id']/'production.json').is_file()
               and not (BATCH/'editorial-rejections'/job['id']).exists()
               and not (job.get('gridRefill') or job.get('waterfront')) for job in group):
            continue
        row = []
        reference = group[0]['reference']
        for entry in retained[(z, x, y)]:
            if entry['url'] in rejected:
                continue
            row.append(retained_panel(entry, reference))
        for job in group:
            job_id = str(job['id'])
            source = BATCH / 'jobs' / job_id / 'overlay.webp'
            if not source.with_name('production.json').is_file():
                continue
            receipt = read(source.with_name('production.json'))
            if not source.with_name('qa.json').is_file():
                raise ValueError(f'missing registration result for {job_id}')
            stat = signature(source)
            old = previous.get('images', {}).get(job_id, {})
            if old.get('stat') == stat:
                sha = old['sha256']
            else:
                with Image.open(source) as image:
                    if image.format != 'WEBP' or image.mode != 'RGBA' or image.size != (1024, 1024):
                        raise ValueError(f'invalid production overlay {source}')
                    image.load()
                    if not image.getchannel('A').getbbox():
                        raise ValueError(f'empty production overlay {source}')
                sha = digest(source)
            if receipt['overlaySha256'] != sha:
                raise ValueError(f'production hash mismatch for {job_id}')
            filename = f'{job_id}-{sha[:16]}.webp'
            target = PUBLIC / filename
            if not target.exists() or old.get('targetStat') != signature(target):
                if not target.exists() or digest(target) != sha:
                    replace(target, lambda temp: shutil.copyfile(source, temp))
            cache['images'][job_id] = dict(stat=stat, sha256=sha, targetStat=signature(target))
            url = '/atlas-v2/production/' + filename
            if url in rejected:
                continue
            ready.append(job_id)
            item = dict(art=dict(title=job['name'], x=x, y=y, rows=1, url=url),
                        family=job['family'], image=target, z=z, reference=job['reference'],
                        referenceStat=signature(ROOT / job['reference']))
            row.append(item)
            families[item['family']].append(item)
        if not row:
            continue
        region = group[0]['region']
        if region == 'HKU' and group[0].get('ring'):
            region = f"HKU ring {group[0]['ring']}"
        key = f'production-cell-{z}-{x}-{y}'
        names = sites.get((z,x,y), {}).get('siteContext', [])
        landmark = names[0]['name'] + ' · ' if names else ''
        title = f'{landmark}{region} · {z}/{x}/{y}'
        make_sheet(key, title, 'Cells', row)

    for family, members in sorted(families.items()):
        for offset in range(0, len(members), 5):
            row = members[offset:offset + 5]
            if len(row) < 5 and len(ready) != len(jobs):
                continue
            number = 1 + offset // 5
            name = family_title(family)
            make_sheet(f'production-{family}-{number:02}', f'{name} · Sheet {number}', 'Themes', row)

    index = dict(sheets=sheets, cards=links)
    data = json.dumps(index, ensure_ascii=False, indent=2) + '\n'
    replace(PUBLIC / 'sheets.json', lambda temp: temp.write_text(data))
    subprocess.run([sys.executable, str(ROOT / 'scripts/dream-atlas.py'), '--v2', 'cards', '--incremental'],
                   cwd=ROOT, check=True)
    replace(previous_path, lambda temp: temp.write_text(json.dumps(cache, ensure_ascii=False) + '\n'))
    return len(ready), len(cells), len(sheets)


if __name__ == '__main__':
    GALLERY.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    with (BATCH / 'publication.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        count, planned_cells, sheets = publish()
        print(f'{count} production paintings in {sheets} review sheets; {planned_cells} planned cells')
