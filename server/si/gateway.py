"""Authenticated durable queue for the SI Codex renderer."""
import base64
import fcntl
import hashlib
import hmac
import io
import importlib.util
import re
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

ROOT = Path(os.environ.get('ATLAS_GENERATOR_ROOT', '/var/lib/codex-vpn/atlas'))
JOBS = ROOT / 'generated-tiles/dream-atlas/live/jobs'
TOKEN = '' if sys.argv[1:] == ['work'] else Path(os.environ.get('ATLAS_GENERATOR_TOKEN_FILE', '/etc/atlas-generator/token')).read_text().strip()
ORIGIN = os.environ.get('ATLAS_PRODUCTION_ORIGIN', 'https://romanticatlas.hype.hk')
MAX_BODY = 7_000_000
MAX_ACTIVE = 5
GUARD = threading.Lock()
SCENES = json.loads((ROOT / 'releases/si-scenes.json').read_text())


spec = importlib.util.spec_from_file_location('revisions', ROOT / 'scripts/review-revisions.py')
revisions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(revisions)


def revision_worker():
    while True:
        revisions.drain()
        time.sleep(2)


def save(path, value):
    temporary = path.with_name(path.name + '.' + str(uuid.uuid4()))
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)


def read(path):
    return json.loads(path.read_text())


def valid_id(value):
    return str(uuid.UUID(value)) == value


def pending():
    return [p for p in JOBS.glob('*/request.json')
            if not (p.parent / 'result.json').exists() and not (p.parent / 'error.json').exists()]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_request(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            return self.reply(401, {'error': 'Authentication required.'})
        parts = self.path.strip('/').split('/')
        if self.command == 'DELETE' and parts != ['revisions']:
            return self.reply(405, {'error': 'Unsupported generator method.'})
        if parts == ['revisions']:
            if self.command == 'GET':
                return self.reply(200, revisions.records())
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'Revision references exceed the input limit.'})
            body = json.loads(self.rfile.read(length))
            if self.command == 'DELETE':
                return self.reply(200, revisions.withdraw(body['id']))
            return self.reply(202, revisions.submit(body))
        if len(parts) == 2 and parts[0] == 'revisions' and re.fullmatch(r'[a-f0-9]{32}', parts[1]) and self.command == 'GET':
            path = revisions.JOBS / parts[1] / 'candidate.png'
            if not path.is_file():
                return self.reply(404, {'error': 'Revision unavailable.'})
            data = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if parts == ['health'] and self.command == 'GET':
            return self.reply(200, {'ready': True, 'pending': len(pending())})
        if len(parts) not in (2, 3) or parts[0] != 'jobs' or not valid_id(parts[1]):
            return self.reply(404, {'error': 'Unknown job.'})
        directory = JOBS / parts[1]
        if self.command == 'POST' and len(parts) == 2:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'Invalid input size.'})
            body = json.loads(self.rfile.read(length))
            scene, y, source = body.get('scene'), body.get('y'), body.get('sourceImage', '')
            if scene not in SCENES or type(y) is not int or not 0 <= y < 2**18 or not source.startswith('data:image/png;base64,'):
                return self.reply(400, {'error': 'Invalid atlas tile.'})
            image = base64.b64decode(source.split(',', 1)[1], validate=True)
            with Image.open(io.BytesIO(image)) as png:
                if png.format != 'PNG' or png.width != png.height or png.width not in (512, 1024, 2048):
                    return self.reply(400, {'error': 'Invalid atlas PNG.'})
                png.verify()
            fingerprint = hashlib.sha256(json.dumps([scene, y, hashlib.sha256(image).hexdigest()]).encode()).hexdigest()
            with GUARD:
                if (directory / 'request.json').exists():
                    if read(directory / 'request.json')['fingerprint'] != fingerprint:
                        return self.reply(409, {'error': 'Job input differs.'})
                    return self.reply(202, {'pending': True})
                if len(pending()) >= MAX_ACTIVE:
                    return self.reply(429, {'error': 'The image queue is full. Please try again shortly.'})
                directory.mkdir(parents=True, exist_ok=True)
                (directory / 'source.png').write_bytes(image)
                save(directory / 'request.json', {'scene': scene, 'y': y, 'fingerprint': fingerprint})
            return self.reply(202, {'pending': True})
        if self.command != 'GET' or not (directory / 'request.json').exists():
            return self.reply(404, {'error': 'Unknown job.'})
        if (directory / 'error.json').exists():
            return self.reply(502, read(directory / 'error.json'))
        if not (directory / 'result.json').exists():
            return self.reply(202, {'pending': True})
        if len(parts) == 3 and parts[2] == 'image':
            image = (directory / 'image.png').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(image)))
            self.end_headers()
            return self.wfile.write(image)
        return self.reply(200, read(directory / 'result.json'))

    def do_GET(self):
        try:
            self.handle_request()
        except (ValueError, KeyError, OSError) as exc:
            print(type(exc).__name__, flush=True)
            self.reply(400, {'error': 'Invalid generator request.'})

    do_POST = do_GET
    do_DELETE = do_GET


def work():
    # A filesystem lock survives gateway restarts and prevents a second renderer.
    while True:
        for request in sorted(pending(), key=lambda p: p.stat().st_mtime):
            directory = request.parent
            with (directory / 'dispatch.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                if (directory / 'result.json').exists() or (directory / 'error.json').exists():
                    continue
                body = read(request)
                # If the service restarted, recover a persisted image before considering another call.
                if (directory / 'started.json').exists():
                    import importlib.util
                    spec = importlib.util.spec_from_file_location('atlas_renderer', ROOT / 'scripts/dream-atlas.py')
                    renderer = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(renderer)
                    renderer.OUT = ROOT / 'generated-tiles/dream-atlas/live'
                    job_file = directory / 'job.json'
                    if job_file.exists() and renderer.recover(read(job_file)):
                        continue
                    save(directory / 'error.json', {'error': 'Generation was interrupted. Please retry this clearing.'})
                    continue
                save(directory / 'started.json', {'time': time.time()})
                with (directory / 'renderer.log').open('ab') as log:
                    result = subprocess.run(
                        ['python3', 'scripts/dream-atlas.py', 'live-tile', directory.name, body['scene'], str(body['y'])],
                        cwd=ROOT, input=SCENES[body['scene']].encode(), stdout=log, stderr=log)
                if result.returncode or not (directory / 'result.json').exists():
                    save(directory / 'error.json', {'error': 'SI could not complete the artwork. Please retry this clearing.'})
        time.sleep(1)


def publish():
    # Completion callbacks retry independently of the visitor and VPN renderer.
    while True:
        for request in JOBS.glob('*/request.json'):
            directory = request.parent
            if (directory / 'published.json').exists():
                continue
            if not any((directory / name).exists() for name in ('result.json', 'error.json')):
                continue
            try:
                req = urllib.request.Request(ORIGIN + '/api/discovery-jobs/' + directory.name,
                    data=b'', headers={'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'RomanticAtlas-SI/1.0'}, method='POST')
                with urllib.request.urlopen(req, timeout=60) as response:
                    if response.status in (200, 502):
                        save(directory / 'published.json', {'time': time.time()})
            except Exception as exc:
                # A terminal generator failure is also recorded in the Worker job.
                terminal = False
                if getattr(exc, 'code', None) == 502:
                    try:
                        terminal = json.loads(exc.read()).get('failed') is True
                    except (ValueError, OSError):
                        pass
                if terminal:
                    save(directory / 'published.json', {'time': time.time()})
                else:
                    print('Publication retry', directory.name, type(exc).__name__, flush=True)
        time.sleep(10)


if __name__ == '__main__':
    JOBS.mkdir(parents=True, exist_ok=True)
    if sys.argv[1:] == ['work']:
        workers = [threading.Thread(target=work) for _ in range(MAX_ACTIVE)]
        workers.append(threading.Thread(target=revision_worker))
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
    else:
        threading.Thread(target=publish, daemon=True).start()
        ThreadingHTTPServer(('127.0.0.1', 8796), Handler).serve_forever()
