import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'generated-tiles/dream-atlas/live'
CACHE = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'generated_images'
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


def where(job, part):
    return OUT / 'jobs' / job['id'] / part


def check_png(path, reference=False):
    with Image.open(path) as image:
        if image.format != 'PNG' or image.width != image.height or image.width < (128 if reference else 512):
            raise ValueError(f'Invalid square PNG dimensions or format in {path}')
        image.verify()
    with Image.open(path) as image:
        image.load()
        if all(low == high for low, high in image.convert('RGB').getextrema()):
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
            shutil.copyfile(asset, tmp)
    record = dict(id=job['id'], source=origin, sha256=digest, referenceSha256=file_hash(source),
                  width=width, height=width)
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


def child(job, lock, timeout):
    source = reference_for(job)
    attempts = where(job, 'attempts')
    number = len(list(attempts.glob('*.json'))) + 1
    path = attempts / f'{number:04d}.json'
    meta = {'started': int(time.time())}
    save(path, meta)
    cmd = ['codex', 'exec', '--ephemeral', '--enable', 'image_generation', '-C', str(ROOT),
           '--sandbox', 'read-only', '--json', '--image', str(source), '-']
    detail = job['prompt']
    with tempfile.TemporaryFile() as prompt:
        prompt.write(WORKER.format(detail).encode())
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
            while time.monotonic() < deadline:
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
                        buffer, dropping = b'', False
            else:
                kind = 'timeout'
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Render one live atlas clearing.')
    parser.add_argument('job_id', type=uuid.UUID)
    args = parser.parse_args()
    directory = OUT / 'jobs' / str(args.job_id)
    job = dict(id=str(args.job_id), reference=str((directory / 'source.png').relative_to(ROOT)),
               prompt=sys.stdin.read())
    save(directory / 'job.json', job)
    with (directory / 'worker.lock').open('a') as lock:
        result = child(job, lock, 900)
    if result != 'saved':
        sys.exit('Codex image generation: ' + result)
