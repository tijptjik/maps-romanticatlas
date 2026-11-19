"""Dispatch a frozen set of production-cell deficits through isolated image workers."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import runpy
import signal
import time
from urllib.parse import parse_qs, urlsplit

from PIL import Image

from atlas_v2_grid import BATCH, ROOT, SUPPLEMENT, NORTH, DISTRICTS, cell, grid, read, effective_plan


def parse_cell(value):
    parts = value.split('/')
    if len(parts) != 3 or parts[0] != '18' or not all(part.isdigit() for part in parts):
        raise ValueError('Expected a cell formatted as 18/X/Y')
    x, y = map(int, parts[1:])
    if not (0 <= x < 2**18 and 0 <= y < 2**18):
        raise ValueError('Cell coordinates are outside zoom 18')
    return x, y


def footprint(art):
    return [(art['x'] + column, art['y'] - row)
            for column in range(art.get('columns', 1)) for row in range(art['rows'])]


def artwork_path(url):
    parsed = urlsplit(url)
    path = Path(parsed.path.lstrip('/'))
    query = parse_qs(parsed.query)
    if parsed.path.startswith('/generated-tiles/'):
        version = query['version'][0]
        variant = '.' + query['variant'][0] if 'variant' in query else ''
        return ROOT / path.with_name(f'{path.name}.v{version}{variant}.image')
    if parsed.path.startswith('/artwork-revisions/'):
        return BATCH.parent / 'review-revisions/jobs' / path.stem / 'candidate.png'
    return ROOT / 'public' / path


@lru_cache(maxsize=4096)
def image_hash(path, size, modified, changed):
    with Image.open(path) as image:
        image.verify()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def current_inventory(jobs, wanted):
    """Include later editorial replacements and group revisions of one alternative."""
    review_path = ROOT / 'releases/v2-reviews.json'
    review_bytes = review_path.read_bytes()
    reviews = {entry['url']: entry for entry in json.loads(review_bytes)}
    catalog_path = ROOT / 'public/atlas-v2/catalog.json'
    catalog_bytes = catalog_path.read_bytes()
    arts = {}
    accepted = set()
    parents = {}
    for sheet in json.loads(catalog_bytes)['sheets']:
        for art in sheet['art']:
            arts[art['url']] = art
            if sheet.get('accepted'):
                accepted.add(art['url'])
    for path in (BATCH.parent / 'review-revisions/jobs').glob('*/revision.json'):
        revision = read(path)
        candidate = revision.get('candidate')
        if candidate:
            parents[candidate['url']] = revision['source']['url']
            if revision['state'] == 'ready':
                arts[candidate['url']] = candidate
    for url, art in reviews.items():
        if art['status'] == 'accepted' and url.startswith(('/artwork-revisions/', '/generated-tiles/')):
            arts[url] = art
    # A crash between registration and publication must not create another image.
    for job in jobs:
        if cell(job) not in wanted:
            continue
        folder = BATCH / 'jobs' / job['id']
        receipt_path = folder / 'production.json'
        if not receipt_path.exists():
            continue
        receipt = read(receipt_path)
        url = f"/atlas-v2/production/{job['id']}-{receipt['overlaySha256'][:16]}.webp"
        if url not in arts:
            arts[url] = dict(x=job['x'], y=job['y'], rows=1, title=job['name'], url=url,
                             localSource=folder / 'overlay.webp', expectedHash=receipt['overlaySha256'])

    def lineage(url):
        seen = set()
        while url in parents:
            if url in seen:
                raise ValueError('Cyclic artwork revision lineage')
            seen.add(url)
            url = parents[url]
        return url

    inventory = defaultdict(dict)
    unavailable = []
    for url, art in arts.items():
        covered = wanted.intersection(footprint(art))
        status = reviews.get(url, {}).get('status', 'accepted' if url in accepted else 'pending')
        if not covered or status == 'rejected':
            continue
        path = art.get('localSource') or artwork_path(url)
        try:
            stat = path.stat()
            digest = image_hash(path, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            if art.get('expectedHash', digest) != digest:
                raise ValueError('Receipt hash mismatch')
            version = parse_qs(urlsplit(url).query).get('v', [''])[0]
            production_hash = re.fullmatch(r'/atlas-v2/production/[^/]+-([0-9a-f]{16})\.webp', url)
            expected = production_hash[1] if production_hash else version
            if expected and not digest.startswith(expected):
                raise ValueError('Artwork bytes differ from the reviewed URL')
        except (OSError, ValueError, SyntaxError) as error:
            unavailable.append(dict(url=url, error=str(error)))
            continue
        for xy in covered:
            root = lineage(url)
            matching = [key for key, option in inventory[xy].items()
                        if root in option['lineages'] or digest in option['hashes']]
            option = dict(url=url, status=status, sha256=digest, urls={url, root},
                          lineages={root}, hashes={digest})
            for key in matching:
                previous = inventory[xy].pop(key)
                for field in ('urls', 'lineages', 'hashes'):
                    option[field].update(previous[field])
                if previous['status'] == 'accepted':
                    option.update(url=previous['url'], status='accepted', sha256=previous['sha256'])
            inventory[xy][root] = option
    sources = dict(reviews=hashlib.sha256(review_bytes).hexdigest(),
                   catalog=hashlib.sha256(catalog_bytes).hexdigest())
    return inventory, unavailable, sources


def scope_targets(base, scopes, cells):
    history = base['jobs'] + (read(SUPPLEMENT) if SUPPLEMENT.exists() else [])
    survey = {cell(site): site for site in read(BATCH / 'sites.json')['sites']}
    sites = {cell(job): dict(job, required=1) for job in history}
    for xy, site in survey.items():
        if site['region'] == 'HKU':
            sites[xy] = dict(site, required=5-site['ring'])
    sites[214184, 114420] = dict(x=214184, y=114420, region='HKU', ring=0, required=5)
    requested = set(cells)
    if requested - sites.keys():
        raise ValueError(f'Cells lack registered production sites: {sorted(requested - sites.keys())}')
    regions = set()
    if 'hku' in scopes:
        regions.add('HKU')
    if 'north' in scopes:
        regions.add(NORTH)
    if 'kowloon' in scopes:
        regions.update(DISTRICTS)
    selected = [site for xy, site in sites.items()
                if xy in requested or (not requested and site['region'] in regions)]
    inspected = grid('inspect', tiles=[dict(x=site['x'], y=site['y'], region=site['region'],
                                          ring=site.get('ring'), required=site['required']) for site in selected])
    targets = []
    excluded = []
    for site in inspected:
        centre = cell(site) == (214184, 114420)
        eligible = centre or (site['selected'] and (site['region'] == 'HKU' or site['isTargetable']))
        if eligible:
            targets.append(site)
        else:
            excluded.append(site)
    if requested.intersection(map(cell, excluded)):
        raise ValueError('An explicitly requested cell fails the current grid or land eligibility rules')
    targets.sort(key=lambda site: (site['region'] != 'HKU', site.get('ring') or 0, site['x'], site['y']))
    return targets, excluded


def deficits(targets, inventory):
    rows = []
    for target in targets:
        options = list(inventory.get(cell(target), {}).values())
        accepted = sum(option['status'] == 'accepted' for option in options)
        pending = len(options) - accepted
        rows.append(dict(target, accepted=accepted, pending=pending,
                         missing=max(0, target['required'] - len(options)),
                         acceptanceMissing=max(0, target['required'] - accepted)))
    return rows


def dispatch_jobs(rows, jobs, inventory, shortages=None):
    selected = []
    for row in rows:
        if not row['missing']:
            continue
        available_urls = {url for option in inventory.get(cell(row), {}).values() for url in option['urls']}
        choices = []
        for job in jobs:
            if cell(job) != cell(row):
                continue
            receipt_path = BATCH / 'jobs' / job['id'] / 'production.json'
            receipt = read(receipt_path) if receipt_path.exists() else None
            url = f"/atlas-v2/production/{job['id']}-{receipt['overlaySha256'][:16]}.webp" if receipt else None
            if url not in available_urls:
                choices.append(job)
        choices.sort(key=lambda job: (job['option'], job['id']))
        if len(choices) < row['missing']:
            if shortages is None:
                raise ValueError(f"Cell {cell(row)} needs {row['missing']} images but has only {len(choices)} reusable production slots")
            shortages.append(dict(row, newSlots=row['missing']-len(choices)))
        selected.extend(choices[:row['missing']])
    return selected


def add_scope_slots(base, shortages, save):
    """Append slots for rejected retained paintings while holding the batch lock."""
    from atlas_v2_registration import _layout
    queue = runpy.run_path(str(ROOT / 'scripts/atlas-v2-queue.py'))
    extra = read(SUPPLEMENT) if SUPPLEMENT.exists() else []
    history = base['jobs'] + extra
    families = {path.stem: read(path) for path in (ROOT/'releases/sources/families').glob('*.json')}
    names = {concept['name']: family for family, concepts in families.items() for concept in concepts}
    seen = list(history) + base['retained']
    for sheet in read(ROOT/'public/atlas-v2/catalog.json')['sheets']:
        seen.extend(dict(art, family=names.get(art['title'])) for art in sheet['art'])
    rejected = [entry for entry in read(ROOT/'releases/v2-reviews.json') if entry['status']=='rejected']
    serial = max(int(job['id']) for job in history)
    previous = {job['family']:job['prompt'] for job in history}
    written = []
    for row in shortages:
        if cell(row) == (214184, 114420):
            raise ValueError('The shared Main Building stack requires a two-cell artwork job')
        existing = max([job['option'] for job in history if cell(job)==cell(row)] +
                       [sum(cell(art)==cell(row) for art in base['retained']), row['required']-row['missing']])
        site = grid('prepare', tiles=[dict(row, z=18, existingOptions=existing,
                                         options=existing+row['newSlots'])])[0]
        _, usable, _, _ = _layout(site)
        for job in queue['make_jobs']([site], families, base['seed']+serial, seen, rejected):
            serial += 1
            job.update(id=f'{serial:04}', gridRefill=True, scopedRefill=True,
                       counterexample=previous.get(job['family']), referenceSha256=site['referenceSha256'],
                       usableFraction=float(usable.mean()))
            extra.append(job)
            seen.append(job)
            previous[job['family']] = job['prompt']
            written.append(job['id'])
    save(SUPPLEMENT, extra)
    return written


def snapshot(base, targets):
    plan, allowed = effective_plan(base)
    jobs = [job for job in plan['jobs'] if cell(job) in allowed]
    inventory, unavailable, sources = current_inventory(jobs, {cell(site) for site in targets})
    rows = deficits(targets, inventory)
    shortages = []
    selected = dispatch_jobs(rows, jobs, inventory, shortages)
    return dict(cells=rows, jobs=selected, newSlots=shortages, unavailable=unavailable, sources=sources,
                missing=sum(row['missing'] for row in rows),
                acceptanceMissing=sum(row['acceptanceMissing'] for row in rows))


def run(production, args):
    """Keep all writes and image workers behind the existing production batch lock."""
    base = read(BATCH / 'jobs.json')
    cells = [parse_cell(value) for value in args.cell or []]
    selection = dict(scopes=sorted(set(args.scope or [])), cells=sorted(set(cells)))
    identity = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()[:16]
    folder = BATCH / 'scopes' / identity
    status_path = folder / 'status.json'
    targets, excluded = scope_targets(base, selection['scopes'], cells)
    if args.action in ('plan', 'status'):
        result = snapshot(base, targets)
        result.update(selection=selection, excluded=excluded, directory=str(folder.relative_to(ROOT)))
        if status_path.exists():
            result['last'] = read(status_path)
        print(json.dumps(result, indent=2))
        return

    import atlas_v2_registration as registration
    registration.loaded_version = production.legacy['file_hash'](Path(registration.__file__))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: production.stop.set())
    print(json.dumps(dict(state='waiting-for-batch-lock', selection=selection)), flush=True)
    with production.legacy['exclusive'](wait=True) as lock:
        folder.mkdir(parents=True, exist_ok=True)
        previous = read(status_path) if status_path.exists() else {}
        if previous.get('state') not in (None, 'ready-for-review'):
            manifest = read(folder / previous['manifest'])
            targets = manifest['targets']
        else:
            initial = snapshot(base, targets)
            if initial['unavailable']:
                raise ValueError(f"Cannot verify existing artwork: {initial['unavailable']}")
            targets = [row for row in initial['cells'] if row['missing']]
            manifest = dict(selection=selection, targets=targets, created=int(time.time()),
                            sources=initial['sources'], file=f'run-{time.time_ns()}.json')
            production.save(folder / manifest['file'], manifest)

        def report(state, result, **extra):
            record = dict(state=state, manifest=manifest['file'], updated=int(time.time()),
                          cells=result['cells'], missing=result['missing'],
                          acceptanceMissing=result['acceptanceMissing'], sources=result['sources'], **extra)
            production.save(status_path, record)
            print(json.dumps(dict(state=state, missing=result['missing'], **extra)), flush=True)

        examples = production.make_examples()
        direction = production.illustration_direction()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            while not production.stop.is_set():
                result = snapshot(base, targets)
                if result['unavailable']:
                    report('unavailable-artwork', result, issues=result['unavailable'])
                    raise ValueError('Existing artwork could not be verified')
                if result.get('newSlots'):
                    added = add_scope_slots(base, result['newSlots'], production.save)
                    report('added-scoped-slots', result, jobs=added)
                    continue
                if not result['missing']:
                    production.publish()
                    final = snapshot(base, targets)
                    if final['missing'] or final['unavailable']:
                        continue
                    report('ready-for-review', final)
                    return
                active = result['jobs'][:args.workers]
                production.reconcile_rejections(active, {job['id'] for job in active}, set())
                report('generating', result, jobs=[job['id'] for job in active])
                futures = {pool.submit(production.generate, job, lock, examples, direction, registration): job
                           for job in active}
                issues = {}
                for future in as_completed(futures):
                    job = futures[future]
                    outcome = future.result()
                    if outcome == 'ready':
                        if not production.valid(job):
                            raise ValueError(f"Invalid generated receipt for {job['id']}")
                        production.publish()
                        print(json.dumps(dict(state='published', job=job['id'], cell=cell(job))), flush=True)
                    else:
                        issues[job['id']] = outcome
                if issues:
                    report('retry', snapshot(base, targets), issues=issues)
                    if 'access' in issues.values():
                        raise RuntimeError('Image worker authentication or access failed')
                    delay = 900 if 'quota' in issues.values() else 90 if 'rate' in issues.values() else 5
                    deadline = time.monotonic() + delay
                    while time.monotonic() < deadline and not production.stop.wait(min(60, deadline-time.monotonic())):
                        pass
            report('stopped', snapshot(base, targets))
