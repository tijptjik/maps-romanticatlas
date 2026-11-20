"""Durable editorial revision jobs for the local and SI Codex renderers."""
import base64
import fcntl
import importlib.util
import io
import json
import os
import re
import signal
from pathlib import Path
import sys
import tempfile
import time
import uuid

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'generated-tiles/dream-atlas/review-revisions'
JOBS = STORE / 'jobs'
DIRECTION = {
    'adjust': 'Audit the previous edition against the fresh registered street map. Trace every road intersection, every exterior side and internal opening. Locate roads eating into painted forms, flat sliced roofs or canopies, floating fragments, disconnected approaches and cut-off return walls. Redesign the affected objects and their supports so all ends are finished in three dimensions. A road behind an elevated object must not erase its silhouette. Keep through-routes open at ground level. Preserve the concept, composition and useful coverage.',
    'spread': (
        'Keep the main scene as the focal point. Extend its activity into a selection of nearby parcels, '
        'courtyards or terraces where it fits the fresh basemap. Give each addition a purpose within the '
        'same concept and keep it at human scale. As a visual guide, aim for roughly 20% less density '
        'than a treatment that fills every suitable site. Leave some whole pockets open and visible ground '
        'between groups. Keep through-roads, access routes and water gaps clear.'
    ),
}
INSTRUCTION = """Use the built-in image generation tool once. Attachment 1 is a fresh surveyed north-up basemap. Attachment 2 is the exact previous artwork, registered to the same extent. Preserve the subject, palette, perspective and identity of the piece. Review the previous painting against the map before drawing. Output the revised intervention alone on uniform electric magenta #ff00ff, including internal openings and any padding. Preserve registration and the exact extent. Do not paint a substitute basemap or print text. Inspect all edges, roads, interiors, scale and coverage before finishing.

Use the painted areas of attachment 2 as the colour and tone reference. Match their saturation and contrast throughout the revision, including newly drawn areas. Compare the same materials in both editions: keep muted colours equally muted, shadows equally deep, highlights equally bright and painted edges equally soft or crisp. Ignore the electric magenta background when judging colour and tone.

{}

End with a short text receipt. Do not use shell tools or emit image data."""

def atomic(path, obj):
    tmp = path.with_suffix('.' + uuid.uuid4().hex)
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, path)

def records():
    items = (json.loads(p.read_text()) for p in sorted(JOBS.glob('*/revision.json')))
    return [record for record in items if record['state'] != 'withdrawn']

def withdraw(job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise ValueError('Invalid revision id')
    path = JOBS / job_id / 'revision.json'
    with (STORE / 'submit.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = json.loads(path.read_text())
        record.pop('candidate', None)
        record['state'] = 'withdrawn'
        atomic(path, record)
    return record

def submit(body):
    JOBS.mkdir(parents=True, exist_ok=True)
    with (STORE / 'submit.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        mode = body['mode']
        source = body['source']
        for record in records():
            if mode == 'generate':
                other = record.get('candidate') or record['source']
                if (record['state'] != 'failed' and other.get('scene') == source['scene']
                        and other['x'] - 4 <= source['x'] <= other['x'] + other.get('columns', 1) - 1 + 4
                        and other['y'] - other.get('rows', 1) + 1 - 4 <= source['y'] <= other['y'] + 4):
                    return {'conflict': 'This family is already reserved within the 9×9 neighbourhood.'}
            elif record['source']['url'] == body['source']['url'] and record['state'] != 'failed':
                return record
        if mode != 'generate' and mode not in DIRECTION:
            raise ValueError('Unknown revision action')
        job_id = uuid.uuid4().hex
        with tempfile.TemporaryDirectory(dir=STORE) as staging:
            folder = Path(staging) / job_id
            folder.mkdir()
            references = [('mapImage', 'source.png')]
            if mode != 'generate':
                references.append(('previousImage', 'previous.png'))
            for field, name in references:
                data = base64.b64decode(body[field].removeprefix('data:image/png;base64,'), validate=True)
                with Image.open(io.BytesIO(data)) as im:
                    if im.format != 'PNG' or im.size != (1024, 1024):
                        raise ValueError('Expected a 1024px registered PNG reference')
                    im.verify()
                (folder / name).write_bytes(data)
            record = dict(id=job_id, state='pending', mode=mode, source=body['source'], created=time.time())
            if mode == 'generate':
                record['prompt'] = body['prompt']
            atomic(folder/'revision.json', record)
            folder.rename(JOBS/job_id)
        return record

# Delays are in seconds. Keep a bounded budget per revision across worker restarts.
RETRY_DELAYS = {'rate': (60, 120, 240), 'network': (15, 30, 60), 'timeout': (30, 60, 120)}

class GenerationError(Exception):
    pass

def finish(folder, record):
    spec = importlib.util.spec_from_file_location('renderer', ROOT/'scripts/dream-atlas.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    renderer.OUT = STORE
    source = record['source']
    job = dict(id=folder.name, reference=str((folder/'source.png').relative_to(ROOT)),
               context='All placement decisions must come from the fresh basemap.', prompt=source['title'])
    if record['mode'] == 'generate':
        job.update(prompt=record['prompt'], drawing='Draw ' + source['title'] + ' in the ' + source['scene'] + ' family.',
                   workerInstruction='Use the built-in image generation tool once. Paint an isometric vintage Hong Kong atlas intervention registered to the supplied north-up map. Preserve roads and coastline. Paint the artwork alone on uniform electric magenta #ff00ff, including gaps. Do not reproduce the basemap, labels or borders. {} End with a short text receipt.')
    else:
        job.update(footprintReference=str((folder/'previous.png').relative_to(ROOT)),
                   guideInstruction='Attachment 2 is the previous edition for this site.',
                   drawing=DIRECTION[record['mode']], workerInstruction=INSTRUCTION)
    with (folder/'worker.lock').open('a') as lock:
        # The renderer inherits this lock. After a parent exits, wait for its
        # child to finish before recovering the image or starting another attempt.
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not renderer.recover(job):
            result = renderer.child(job, lock, 900)
            if result != 'saved':
                raise GenerationError(result)
    with Image.open(folder/'image.png') as raw:
        im = raw.convert('RGBA')
        cols, rows = source.get('columns', 1), source['rows']
        w = round(im.width * cols / max(cols, rows))
        h = round(im.height * rows / max(cols, rows))
        x, y = (im.width-w)//2, (im.height-h)//2
        im = im.crop((x, y, x+w, y+h))
        # Remove the generated key only. Never clip the revision against the old placement mask.
        r, g, b, a = im.split()
        key = ImageChops.subtract(ImageChops.darker(r, b), g).point(lambda v: min(255, max(0, (v-25)*255/180)))
        alpha = ImageChops.multiply(a, ImageChops.invert(key))
        if not alpha.getbbox() or alpha.getextrema()[0] > 16:
            raise ValueError('The generator did not return an isolated intervention.')
        im.putalpha(alpha)
        im.save(folder/'candidate.png')
    record.update(state='ready', candidate={**source, 'url': '/artwork-revisions/'+folder.name+'.png'})

def drain():
    STORE.mkdir(parents=True, exist_ok=True)
    with (STORE/'render.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cooldown = STORE / 'rate-limit.json'
        if cooldown.exists():
            resume_at = json.loads(cooldown.read_text())
            if resume_at > time.time():
                return resume_at
        next_retry = None
        for record in sorted(records(), key=lambda r: r['created']):
            if record['state'] != 'pending':
                continue
            folder = JOBS/record['id']
            path = folder/'revision.json'
            if json.loads(path.read_text())['state'] != 'pending':
                continue
            retry_at = record.get('retryAt', 0)
            if retry_at > time.time():
                next_retry = min(next_retry or retry_at, retry_at)
                continue
            record.pop('retryAt', None)
            pause_until = None
            try:
                finish(folder, record)
                record.pop('lastError', None)
            except GenerationError as exc:
                reason = str(exc)
                failures = record.get('failedAttempts', 0) + 1
                record.update(lastError=reason, failedAttempts=failures)
                delays = RETRY_DELAYS.get(reason, ())
                now = time.time()
                if reason == 'rate':
                    pause_until = now + delays[min(failures, len(delays)) - 1]
                    atomic(cooldown, pause_until)
                if failures <= len(delays):
                    retry_at = now + delays[failures - 1]
                    record['retryAt'] = retry_at
                    next_retry = min(next_retry or retry_at, retry_at)
                    print(f"Revision {record['id']}: {reason}, retry in {delays[failures - 1]}s "
                          f"(attempt {failures + 1} of {len(delays) + 1})", file=sys.stderr)
                else:
                    record['state'] = 'failed'
                    print(f"Revision {record['id']} failed after {failures} attempt(s): {reason}", file=sys.stderr)
            except Exception as exc:
                print('Revision failed:', record['id'], exc, file=sys.stderr)
                record.update(state='failed', lastError='revision-processing')
            with (STORE / 'submit.lock').open('a') as submit_lock:
                fcntl.flock(submit_lock, fcntl.LOCK_EX)
                if json.loads(path.read_text())['state'] == 'pending':
                    atomic(path, record)
            if pause_until:
                return pause_until
        return next_retry

if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'submit':
        print(json.dumps(submit(json.load(sys.stdin))))
    elif command == 'withdraw':
        print(json.dumps(withdraw(json.load(sys.stdin)['id'])))
    elif command == 'work':
        signal.signal(signal.SIGTERM, signal.default_int_handler)
        try:
            print(json.dumps(drain()))
        except KeyboardInterrupt:
            print(json.dumps(time.time() + 2))
            print('Revision worker stopped. Pending work was preserved.', file=sys.stderr)
    elif command == 'list':
        print(json.dumps(records()))
