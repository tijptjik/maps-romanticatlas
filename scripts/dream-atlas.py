#!/usr/bin/env python3
"""Run one fresh, file-backed image generation session per registered map tile option."""

import argparse
import concurrent.futures
import contextlib
import fcntl
from functools import cache
import hashlib
import html
import json
import math
import os
from pathlib import Path
import random
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'releases/sources'
BATCH = ROOT / 'generated-tiles/dream-atlas'
OUT = BATCH / 'city-context'
GALLERY = BATCH / 'cards'
CACHE = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'generated_images'
STOP = threading.Event()
WORKER = """Use the built-in image generation tool exactly once. Edit the attached genuine square
Hong Kong atlas tile. Keep its canvas, north-up orientation, road and path network,
shoreline, water and land registration. Read the site first: locate a building, court, street edge
or waterfront workplace in the source, identify its access and an ordinary use,
then adapt that place. The source already releases eligible minor streets. Keep
the remaining circulation connected. Work in the material, roof orientation,
setbacks, grain and scale of the neighbouring blocks. Let one unusual operation
grow out of an everyday part of the city, such as a library parapet, storm drain,
loading bay or sheltered walkway. Translate even a monumental concept into that
site. Keep buildings, paths and doorways legible as ordinary urban fabric at map
zoom. An action too small to see can be inferred from its architecture. Avoid
enlarging people, props or planting for narrative emphasis. Treat the concept
as a possibility; these geographic and scale instructions take priority. Leave out titles,
captions, lettering, borders and legends. Make one finished square map tile.

{}

Use the attachment as the edit target. The built-in generator saves its full-resolution
output automatically. End after that single generation with a short text receipt.
The controller copies the tool's persisted image from this thread's output directory.
Do not return, print, encode or embed image data, run shell commands or create other files."""


def load(path):
    return json.loads(path.read_text())


@contextlib.contextmanager
def temporary(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    os.close(fd)
    temp = Path(name)
    try:
        yield temp
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def save(path, value):
    with temporary(path) as temp:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


@contextlib.contextmanager
def exclusive(wait=False):
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / 'master.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('A master or surviving worker already holds this batch lock')
        yield lock


def make_plan():
    route = load(SOURCE / 'route.json')
    tiles = route['tiles'] if isinstance(route, dict) else route
    families = {p.stem: load(p) for p in sorted((SOURCE / 'families').glob('*.json'))}
    if len(families) != 40 or any(len(concepts) != 5 for concepts in families.values()):
        raise ValueError('Expected 40 families with five concepts each')
    unique = set()
    for values in families.values():
        for concept in values:
            brief = concept['prompt'].strip()
            name = concept['name'].strip()
            if not name or not brief or name.casefold() in brief.casefold() or brief in unique:
                raise ValueError(f'Empty, duplicated or title-bearing prompt for {name}')
            unique.add(brief)
    family_order = list(families)
    family_order.remove('grand-library')
    random.Random(114137).shuffle(family_order)
    family_order.insert(0, 'grand-library')
    direction = load(SOURCE / 'drawing-direction.json')
    v2 = OUT.name == 'v2'
    if v2:
        centre = load(SOURCE / 'hku-site.json')['tiles'][0]['clickTiles']
        def ring(tile):
            return min(max(abs(tile['x'] - x), abs(tile['y'] - y)) for _, x, y in centre)
        tiles = sorted(tiles, key=lambda tile: ring(tile) if tile['region'] == 'HKU' else 999)
        tiles = [dict(tile, options=max(1, 5-ring(tile))) if tile['region'] == 'HKU' else tile
                 for tile in tiles]
        random.Random(729184).shuffle(family_order)
    previous = {}
    jobs = []
    seen = set()
    for tile in tiles:
        tile_families = set()
        x, y, z = tile['x'], tile['y'], tile['z']
        if (z, x, y) in seen or not 1 <= tile['options'] <= 5:
            raise ValueError(f'Duplicate tile or invalid option count at {z}/{x}/{y}')
        seen.add((z, x, y))
        reference = tile.get('reference') or f'generated-tiles/dream-atlas/references/{z}-{x}-{y}.png'
        metres = 40075016.6856 / (2**z * math.cosh(math.pi*(1-2*(y+.5)/2**z)))
        landmarks = '; '.join(f"{v['name']} {v['bounds']}" for v in tile['siteContext'])
        local = (f"Tile width {metres:.1f} m. At 1024 px, a 1.7 m standing adult projects "
                 f"{1.7*.6*1024/metres:.1f} px vertically and a 2.1 m door {2.1*.6*1024/metres:.1f} px. "
                 "Scale these values with the output width. "
                 + (f"Mapped features with visible bounds [left, top, right, bottom] in percent: {landmarks}."
                    if landmarks else "Use the visible local fabric; the source supplies no landmark name here."))
        for option in range(1, tile['options'] + 1):
            index = len(jobs)
            # Eight different themes rotate across the route. Each appears five times
            # before the next cohort starts; at most four options share a tile.
            family = family_order[((index // 40) * 8 + index % 8) % len(family_order)]
            if family in tile_families:
                raise ValueError(f'Repeated scene family on tile {z}/{x}/{y}')
            tile_families.add(family)
            concept_number = (index // 8) % 5
            concept = families[family][concept_number]
            jobs.append(dict(id=f'{index+1:04d}', x=x, y=y, z=z, option=option,
                             region=tile['region'], family=family, concept=concept_number + 1,
                             reference=reference, footprintReference=tile.get('footprintReference'),
                             name=concept['name'], prompt=concept['prompt'], drawing=direction, context=local))
            if v2:
                if tile['region'] == 'HKU':
                    jobs[-1]['ring'] = ring(tile)
                if family in previous:
                    jobs[-1]['counterexample'] = previous[family]
                previous[family] = concept['prompt']
    if not 300 <= len(jobs) + 5 <= 500:
        raise ValueError(f'Route planned {len(jobs)} options, expected 300 to 500')
    return jobs


def plan():
    jobs = make_plan()
    path = OUT / 'jobs.json'
    manifest = {'workerPromptVersion': hashlib.sha256(WORKER.encode()).hexdigest(), 'jobs': jobs}
    if path.exists() and load(path) != manifest:
        raise ValueError('Route, worker prompt or concepts changed since this batch was frozen')
    if not path.exists():
        save(path, manifest)
    return jobs


def where(job, part):
    return OUT / 'jobs' / job['id'] / part


def check_png(path, reference=False):
    with Image.open(path) as image:
        if image.format != 'PNG' or image.width != image.height or image.width < (128 if reference else 512):
            raise ValueError(f'Invalid square PNG dimensions or format in {path}')
        image.verify()
    with Image.open(path) as image:
        image.load()
        colors = image.convert('RGB').getextrema()
        if all(low == high for low, high in colors):
            # A whole live tile can fall inside the basemap's park or landcover fill.
            landcover = colors == ((167, 167), (174, 174), (124, 124))
            if not (reference and OUT.name == 'live' and landcover
                    and image.convert('RGBA').getchannel('A').getextrema() == (255, 255)):
                raise ValueError(f'Blank image in {path}')
        return image.width


def reference_for(job):
    source = (ROOT / job['reference']).resolve()
    if not source.is_relative_to(ROOT):
        raise ValueError('Tile reference lies outside the checkout')
    if source.stat().st_size > 5_000_000:
        raise ValueError(f'Input reference exceeds 5 MB: {source}')
    check_png(source, reference=True)
    return source


def accept(job, asset, origin):
    source = reference_for(job)
    width = check_png(asset)
    dest = where(job, 'image.png')
    receipt = where(job, 'result.json')
    with Image.open(source) as base, Image.open(asset) as artwork:
        sample = artwork.convert('RGB').resize((128, 128))
        if not ImageChops.difference(base.convert('RGB').resize(sample.size), sample).getbbox():
            raise ValueError('Generation is identical to its input')
    digest = file_hash(asset)
    if dest.exists() and file_hash(dest) != digest:
        raise ValueError(f"Job {job['id']} already has a different full-resolution file")
    if not dest.exists():
        with temporary(dest) as tmp:
            if OUT.name == 'production':
                # Preserve an independent inode while sharing storage with the
                # immutable image-tool output on the project's Btrfs volume.
                subprocess.run(['cp', '--reflink=auto', '--', asset, tmp], check=True)
            else:
                shutil.copyfile(asset, tmp)
    record = dict(id=job['id'], source=origin, sha256=digest, referenceSha256=file_hash(source),
                  width=width, height=width)
    if job.get('title'):
        record['title'] = job['title']
    if not receipt.exists():
        save(receipt, record)
    return record


def is_done(job):
    return where(job, 'result.json').is_file() and where(job, 'image.png').is_file()


def recover(job):
    if is_done(job):
        return True
    dest = where(job, 'image.png')
    if dest.exists():
        accept(job, dest, 'recovered local image')
        return True
    for attempt in sorted(where(job, 'attempts').glob('*.json'), reverse=True):
        thread = load(attempt).get('thread')
        if thread:
            directory = CACHE / str(uuid.UUID(thread))
            files = list(directory.glob('*.png'))
            if len(files) == 1:
                try:
                    check_png(files[0])
                except (OSError, ValueError, SyntaxError) as exc:
                    meta = load(attempt)
                    meta['invalidCachedImage'] = str(exc)
                    save(attempt, meta)
                    continue
                accept(job, files[0], 'thread ' + thread)
                return True
            if files:
                raise ValueError(f'Ambiguous outputs for {thread}, inspect before accepting')
    return False


def error_kind(message):
    lower = message.lower()
    patterns = [('payload', ('response.create is too large', 'message too big', 'payload too large', '15 mib', '15mb')),
                ('quota', ('usage limit', 'quota exceeded', 'insufficient_quota', 'quota exhausted',
                           'credit balance', 'billing limit', 'out of credits')),
                ('rate', ('rate limit', 'rate_limit', '429 too many', 'http 429', 'status 429')),
                ('access', ('unauthorized', '401 unauthorized', 'authentication required', 'not logged in',
                            'permission denied', 'read-only file system', 'invalid_api_key')),
                ('network', ('connection refused', 'dns error', 'could not resolve', 'failed to connect',
                             'stream disconnected', 'connection closed', 'websocket error'))]
    for kind, markers in patterns:
        if any(marker in lower for marker in markers):
            return kind
    return None


@cache
def edge_and_figure_directions():
    script = "import { edgesAndFigures, atlasCompositionDirection } from './src/atlas-prompt.ts'; console.log(JSON.stringify({...edgesAndFigures, composition:atlasCompositionDirection}))"
    return json.loads(subprocess.check_output(['bun', '-e', script], cwd=ROOT, text=True))


def child(job, lock, timeout):
    source = reference_for(job)
    attempts = where(job, 'attempts')
    number = len(list(attempts.glob('*.json'))) + 1
    path = attempts / f'{number:04d}.json'
    # Apply current shared guidance at dispatch, including jobs frozen before it existed.
    guidance = edge_and_figure_directions()
    meta = {'started': int(time.time()), 'edgesAndFigures': guidance}
    save(path, meta)
    detail = '\n'.join([job['context'], job['drawing'],
                        *(rule for rule in guidance.values() if rule not in job['drawing']),
                        'Concept to adapt: ' + job['prompt']])
    if job.get('counterexample'):
        detail += ('\nPrevious brief in this family, supplied solely as a counterexample. '
                   'Avoid its silhouette, material arrangement and focal action. '
                   'Follow the current concept above. Previous brief: ' + job['counterexample'])
    extra = []
    if job.get('footprintReference'):
        footprint = reference_for(dict(job, reference=job['footprintReference']))
        extra = ['--image', str(footprint)]
        detail += '\n' + job.get('guideInstruction', 'Attachment 2 shows the original building footprint for context. Place the project on its actual site in attachment 1, preserving through-streets and the tile crop.')
    if job.get('styleReference'):
        style = reference_for(dict(job, reference=job['styleReference']))
        extra += ['--image', str(style)]
        detail += '\nThe last attachment is an approved painting on a DIFFERENT site. Borrow its perspective, line weight, figure scale and complete object edges. Derive the layout and action entirely from the first two attachments and the current brief.'
    if job.get('revisionReference'):
        revision = reference_for(dict(job, reference=job['revisionReference']))
        extra += ['--image', str(revision)]
        detail += ('\nThe last attachment is the previous FAILED painting on this SAME site. '
                   'Use it as an edit reference, not as an approved example. Correct the measured '
                   'failure above: expand the actual working surfaces inside the coloured guide, '
                   'finish every object edge, and preserve the real shoreline landing and small '
                   'human scale. Keep exposed sea and all gaps uniform magenta. Generate one '
                   'complete revised image; do not return the old image unchanged.')
    cmd = ['codex', 'exec', '--ephemeral', '--enable', 'image_generation', '-C', str(ROOT),
           '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--image', str(source), *extra, '-']
    with tempfile.TemporaryFile() as prompt:
        prompt.write(job.get('workerInstruction', WORKER).format(detail).encode())
        prompt.seek(0)
        proc = subprocess.Popen(cmd, stdin=prompt, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                start_new_session=True, pass_fds=(lock.fileno(),))
    deadline = time.monotonic() + timeout
    buffer = b''
    dropping = False
    kind = None
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while not STOP.is_set() and time.monotonic() < deadline:
                if not selector.select(1):
                    continue
                chunk = os.read(proc.stdout.fileno(), 8192)
                if not chunk:
                    break
                for fragment in chunk.splitlines(keepends=True):
                    end = fragment.endswith(b'\n')
                    if not dropping:
                        buffer += fragment
                        if len(buffer) > 16384:
                            buffer, dropping = b'', True
                    if end:
                        if not dropping:
                            line = buffer.decode(errors='replace')
                            observed = error_kind(line)
                            if observed and (kind not in ('quota', 'access') or observed == 'quota'):
                                kind = observed
                            if line.startswith('{'):
                                try:
                                    event = json.loads(line)
                                except ValueError:
                                    event = {}
                                if event.get('type') == 'thread.started':
                                    meta['thread'] = str(uuid.UUID(event['thread_id']))
                                    save(path, meta)
                                elif OUT.name == 'production' and event.get('type') == 'item.completed':
                                    item = event.get('item', {})
                                    if item.get('type') == 'agent_message':
                                        caption = item.get('text', '').strip()
                                        if 20 <= len(caption) <= 1200 and 'data:image' not in caption:
                                            meta['description'] = caption
                        buffer, dropping = b'', False
            else:
                kind = 'stopped' if STOP.is_set() else 'timeout'
    finally:
        if proc.poll() is None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
        proc.stdout.close()
        meta.update(finished=int(time.time()), exit=proc.returncode, diagnostic=kind)
        save(path, meta)
    if recover(job):
        return 'saved'
    return kind or 'missing-output'


def run_job(job, lock, args):
    if recover(job):
        return 'saved'
    for attempt in range(args.attempts):
        if STOP.is_set():
            return 'stopped'
        if shutil.disk_usage(OUT).free < 512 * 1024**2:
            return 'disk-space'
        result = child(job, lock, args.timeout)
        if result in ('saved', 'access', 'quota', 'disk-space', 'stopped'):
            return result
        if attempt + 1 < args.attempts:
            cooldown = min(300, 60 * (2 ** attempt)) if result == 'rate' else 5 * (attempt + 1)
            print(f"{job['id']} {result}, retry in {cooldown}s", flush=True)
            STOP.wait(cooldown)
    return result


def draw_card(jobs, target, crop=None):
    pic = 400 if crop else (1024 if len(jobs) == 1 else 280)
    height = round(pic * (crop[3] - crop[1]) / (crop[2] - crop[0])) if crop else pic
    canvas = Image.new('RGB', (pic * len(jobs), height + 87), '#fff9e9')
    draw = ImageDraw.Draw(canvas)
    title = ImageFont.truetype('DejaVuSans.ttf', 17)
    small = ImageFont.truetype('DejaVuSans.ttf', 13)
    for i, job in enumerate(jobs):
        x = i * pic
        with Image.open(where(job, 'image.png')) as image:
            thumb = image.convert('RGBA')
            if crop:
                thumb = thumb.crop(tuple(round(v * thumb.width) for v in crop))
            thumb.thumbnail((pic, height), Image.Resampling.LANCZOS)
            canvas.paste(thumb, (x + (pic - thumb.width) // 2, (height - thumb.height) // 2), thumb)
        lines = ['']
        for word in job['name'].split():
            line = (lines[-1] + ' ' + word).strip()
            if lines[-1] and draw.textlength(line, font=title) > pic - 16:
                lines.append(word)
            else:
                lines[-1] = line
        draw.multiline_text((x + 8, height + 5), '\n'.join(lines), font=title, fill='#26190f', spacing=1)
        lat = math.atan(math.sinh(math.pi * (1 - 2 * (job['y'] + .5) / 2**job['z'])))
        metres = round(40075016.7 * math.cos(lat) / 2**job['z'])
        draw.text((x + 8, height + 59), f"{job['z']}/{job['x']}/{job['y']}   ·   {metres} m tile",
                  font=small, fill='#574636')
        if job.get('footprintReference'):
            with Image.open(ROOT / job['footprintReference']) as guide:
                icon = guide.convert('RGBA')
                icon.thumbnail((38, 38), Image.Resampling.LANCZOS)
                canvas.paste(icon, (x + pic - 43, height + 45), icon)
    with temporary(target) as temp:
        canvas.save(temp, format='JPEG', quality=90)


def cards(jobs, force=False):
    current = OUT.name == 'v2'
    production = ROOT / 'public/atlas-v2/production/sheets.json'
    reviews = ROOT / 'releases/v2-reviews.json'
    rejected = {r['url'] for r in load(reviews) if r['status'] == 'rejected'} if current and production.exists() and reviews.exists() else set()
    folder = GALLERY if current else BATCH / 'archived-cards'
    sections = {}
    if current:
        if force:
            subprocess.run([sys.executable, str(ROOT / 'scripts/release-contact-cards.py')], cwd=ROOT, check=True)
        for collection in load(ROOT / 'releases/v2-artwork.json')['collections']:
            paths = [GALLERY / filename for filename in collection['galleryCards']]
            sections[collection['title']] = paths
    pilot = GALLERY / 'hku-cell-pilot.jpg'
    if current and pilot.is_file():
        sections['Haking Wong Podium · Four alternatives'] = [pilot]
    if current:
        for sheet in sorted((ROOT / 'public/atlas-v2').glob('hku-ring-*/sheet.json')):
            card = load(sheet)
            sections[card['title']] = [GALLERY / (card['id'] + '.jpg')]
    groups = {}
    for job in jobs:
        groups.setdefault(job['family'], []).append(job)
    gallery = []
    count = 0
    for key, group in groups.items():
        for offset in range(0, len(group), 5):
            row = group[offset:offset+5]
            if len(row) != 5 or any(not is_done(j) for j in row):
                continue
            if rejected and all(f"/atlas-v2/{j['id']}-{load(where(j, 'result.json'))['sha256'][:16]}.webp" in rejected for j in row):
                continue
            series = 'v2' if OUT.name == 'v2' else 'city-context'
            path = folder / f'{key}-{series}-{offset//5+1:02d}.jpg'
            if force or not path.exists():
                draw_card(row, path)
            count += 1
            sections.setdefault(key.replace('-', ' ').title(), []).append(path)
    for display, paths in sorted(sections.items()):
        gallery.append(f'<section><h2>{html.escape(display)}</h2>')
        for path in paths:
            number = path.stem.rsplit('-',1)[-1]
            label = f'{display} · Sheet {int(number)}' if number.isdigit() else display
            if path.stem.startswith('hku-ring-'):
                label = f'{display} · Four alternatives'
            if path.name == 'hku-skyscrapers-current.jpg':
                label = 'HKU Main Building · Five alternative futures'
            filename = html.escape(path.name, quote=True)
            gallery.append(f'<figure><figcaption>{html.escape(label)}</figcaption><a href="{filename}">'
                           f'<img loading="lazy" src="{filename}" alt="{html.escape(label)}"></a></figure>')
            if path.name == 'hku-skyscrapers-current.jpg' and (BATCH / 'hku-in-place/footprint-check.jpg').exists():
                gallery.append('<p><a href="../hku-in-place/footprint-check.jpg">'
                               'Compare the painted ground plan with the surveyed footprint and courtyard outlines</a></p>')
        gallery.append('</section>')
    if current and production.exists():
        links = load(production)['cards']
        for section in ('Themes', 'Cells'):
            entries = [card for card in links if card['section'] == section]
            if not entries:
                continue
            gallery.append(f'<section><h2>Production · {section}</h2>')
            for card in entries:
                label = html.escape(card['title'])
                filename = html.escape(card['file'], quote=True)
                key = html.escape(card['id'], quote=True)
                gallery.append(f'<figure><figcaption>{label} · <a href="/?review&amp;card={key}&amp;painting=1">Review on map</a></figcaption>'
                               f'<a href="{filename}"><img loading="lazy" src="{filename}" alt="{label}"></a></figure>')
            gallery.append('</section>')
    page = ('<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Dream Atlas scene comparisons</title>'
            '<style>body{max-width:94rem;margin:2rem auto;padding:0 1rem;background:#f8f3e9;'
            'color:#342717;font:1rem Georgia,serif}figure{margin:2rem 0}figcaption{margin-bottom:.4rem}'
            'img{display:block;width:100%;height:auto}</style><h1>Dream Atlas scene comparisons</h1>'
            + '\n'.join(gallery) + '</html>')
    with temporary(folder / 'index.html') as temp:
        temp.write_text(page)
    tiles = {}
    for job in jobs:
        if not is_done(job):
            continue
        key = f"{job['z']}/{job['x']}/{job['y']}"
        tile = tiles.setdefault(key, {'z': job['z'], 'x': job['x'], 'y': job['y'],
                                      'region': job['region'], 'options': []})
        tile['options'].append(dict(option=job['option'], family=job['family'], concept=job['concept'],
                                    caption=job['name'], image=f"jobs/{job['id']}/image.png"))
    save(OUT / 'index.json', {'version': 1, 'tiles': tiles})
    if current:
        subprocess.run([sys.executable, str(ROOT / "scripts/export-v2-map.py")], cwd=ROOT, check=True)
    return count


def run(args, lock, jobs):
    pending = [j for j in jobs if not recover(j)]
    for job in {j['reference']: j for j in pending}.values():
        reference_for(job)
    if args.limit:
        pending = pending[:args.limit]
    failures = []
    cursor = iter(pending)
    def dispatch():
        job = next(cursor, None)
        if job:
            running[pool.submit(run_job, job, lock, args)] = job
    with concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
        running = {}
        for _ in range(args.workers):
            dispatch()
        while running:
            finished, _ = concurrent.futures.wait(running, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in finished:
                job = running.pop(future)
                try:
                    result = future.result()
                except (ValueError, OSError) as exc:
                    result = 'validation: ' + str(exc)
                print(f"{job['id']} {result}", flush=True)
                if result == 'saved':
                    cards(jobs)
                else:
                    failures.append((job['id'], result))
                if (result in ('quota', 'access', 'disk-space') or len(failures) >= 3):
                    # Let already-issued work persist its result before returning.
                    cursor = iter(())
            if not STOP.is_set():
                for _ in finished:
                    dispatch()
    cards(jobs)
    if failures:
        print(json.dumps(failures), file=sys.stderr)
        return 1
    return 130 if STOP.is_set() else 0


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('Expected positive integer')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    global OUT
    parser.add_argument('--v2', action='store_true', help='use the two-tile HKU centre and v2 batch')
    sub = parser.add_subparsers(dest='command', required=True)
    for cmd in ('plan', 'status', 'verify'):
        sub.add_parser(cmd)
    contact_cards = sub.add_parser('cards')
    contact_cards.add_argument('--incremental', action='store_true', help='refresh the gallery and map using existing contact cards')
    generate = sub.add_parser('run')
    generate.add_argument('--workers', type=positive, default=3)
    generate.add_argument('--timeout', type=positive, default=900, help='seconds per fresh thread')
    generate.add_argument('--attempts', type=positive, default=2)
    generate.add_argument('--limit', type=positive, help='maximum additional jobs this invocation')
    live = sub.add_parser('live-tile')
    live.add_argument('job_id', type=uuid.UUID)
    live.add_argument('scene')
    live.add_argument('y', type=int)
    live.add_argument('--timeout', type=positive, default=900)
    imported = sub.add_parser('accept')
    imported.add_argument('--job', type=positive, required=True)
    imported.add_argument('--image', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'live-tile':
        OUT = BATCH / 'live'
        job_id = str(args.job_id)
        directory = OUT / 'jobs' / job_id
        family = SOURCE / 'families' / (args.scene + '.json')
        if family.parent != SOURCE / 'families':
            raise ValueError('Invalid scene family')
        if not family.exists():
            family = family.parent / 'backfill' / family.name
        if not family.exists():
            family = SOURCE / 'families' / 'editorial' / family.name
        brief = sys.stdin.read(10000).strip()
        selection = random.choice(load(family)) if family.exists() else None
        if selection:
            brief = selection['prompt']
        width = 40075016.6856 / (2**18 * math.cosh(math.pi * (1 - 2*(args.y+.5)/2**18)))
        job = dict(id=job_id, reference=str((directory / 'source.png').relative_to(ROOT)),
                   drawing=load(SOURCE / 'drawing-direction.json'), prompt=brief,
                   context=f'This north-up Hong Kong tile spans {width:.1f} metres.')
        if selection:
            job['title'] = selection['name']
        save(directory / 'job.json', job)
        with (directory / 'worker.lock').open('a') as lock:
            result = child(job, lock, args.timeout)
        if result != 'saved':
            raise ValueError('Codex image generation: ' + result)
        return 0
    if args.v2:
        OUT = BATCH / 'v2'
    if args.command == 'status':
        manifest = OUT / 'jobs.json'
        if not manifest.exists():
            print('No frozen job manifest yet.')
            return 0
        jobs = load(manifest)['jobs']
        print(json.dumps(dict(planned=len(jobs), saved=sum(is_done(j) for j in jobs),
                              cards=len(list(GALLERY.glob('*-v2-*.jpg' if args.v2 else '*.jpg'))))))
        return 0
    with exclusive(wait=args.command == 'cards' and args.incremental) as lock:
        if args.command == 'cards' and (OUT / 'jobs.json').exists():
            jobs = load(OUT / 'jobs.json')['jobs']
        else:
            jobs = plan()
        if args.command == 'run':
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, lambda *_: STOP.set())
            return run(args, lock, jobs)
        if args.command == 'accept':
            if args.job > len(jobs):
                raise ValueError('Job is outside the route')
            print(json.dumps(accept(jobs[args.job - 1], args.image, 'imported pilot')))
            cards(jobs)
        elif args.command == 'cards':
            print(f'{cards(jobs, force=not args.incremental)} cards')
        elif args.command == 'verify':
            for job in jobs:
                if not is_done(job):
                    continue
                receipt = load(where(job, 'result.json'))
                if (receipt['sha256'] != file_hash(where(job, 'image.png'))
                        or receipt['referenceSha256'] != file_hash(reference_for(job))):
                    raise ValueError(f"Changed image or reference for job {job['id']}")
                check_png(where(job, 'image.png'))
            print(f'{sum(is_done(j) for j in jobs)}/{len(jobs)} saved jobs verified')
        else:
            print(f'Frozen {len(jobs)} jobs in {OUT / "jobs.json"}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as exc:
        sys.exit(str(exc))
