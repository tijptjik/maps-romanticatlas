"""Plan a staggered second painting for existing Central and Western District sites."""
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

from shapely.geometry import Point, shape
from shapely.prepared import prep

from atlas_v2_scope import current_inventory
from atlas_v2_grid import BATCH, ROOT, cell, grid, read

FOLDER = BATCH / 'central-western'
BOOK = ROOT / 'releases/sources/families/backfill'


def district_rows(feature):
    geometry = shape(feature['geometry'])
    boundary = prep(geometry)
    west, south, east, north = geometry.bounds
    def col(lon):
        return math.floor((lon + 180) / 360 * 2**18)
    def row(lat):
        return math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) * 2**17)
    rows = {}
    for y in range(row(north), row(south) + 1):
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2*(y+.5)/2**18))))
        xs = [x for x in range(col(west), col(east)+1)
              if boundary.covers(Point((x+.5)/2**18*360-180, lat))]
        if xs:
            rows[y] = xs
    return rows


def staggered(rows, eligible):
    """Three steps from the last pick; fall back to two, one, then look ahead."""
    picks = []
    west = min(min(xs) for xs in rows.values())
    north = min(rows)
    for y, xs in sorted(rows.items()):
        start = min(xs)
        x = start + ((west + (y - north) % 3 - start) % 3) - 3
        while x < max(xs):
            options = [p for p in (x+3, x+2, x+1) if (p,y) in eligible]
            if not options:
                options = [p for p in xs if p > x+3 and (p,y) in eligible]
            if not options:
                break
            x = options[0]
            picks.append((x,y))
    return picks


def production_jobs():
    jobs = []
    for receipt in (BATCH/'jobs').glob('*/production.json'):
        job = read(receipt)
        _, x, y = job['cell']
        jobs.append(dict(id=job['id'], x=x, y=y, name=job['title'], family=job['family']))
    return jobs


def scene_inventory(inventory, jobs):
    scenes = {}
    for source in (ROOT/'releases/catalog.json', ROOT/'public/atlas-v2/catalog.json'):
        for sheet in read(source)['sheets']:
            for art in sheet['art']:
                if art.get('scene'):
                    scenes[art['url']] = art['scene']
    for j in jobs:
        receipt = read(BATCH/'jobs'/j['id']/'production.json')
        scenes[f"/atlas-v2/production/{j['id']}-{receipt['overlaySha256'][:16]}.webp"] = j['family']
    occupied = defaultdict(set)
    for site, options in inventory.items():
        for option in options.values():
            for url in option['urls']:
                family = scenes.get(url)
                if url.startswith('/generated-tiles/'):
                    family = Path(urlsplit(url).path).name
                if family:
                    occupied[site].add(family)
    # Existing live cache entries take part in the regular 9x9 scene exclusion.
    for path in (ROOT/'generated-tiles/18').glob('*/*/*.image'):
        occupied[int(path.parent.parent.name), int(path.parent.name)].add(path.name.split('.')[0])
    return occupied


def make_plan(boundary_path):
    feature, = [f for f in read(boundary_path)['features']
                if f['properties']['NAME_EN'] == 'Central and Western District']
    rows = district_rows(feature)
    all_cells = {(x,y) for y,xs in rows.items() for x in xs}
    survey = read(BATCH/'sites.json')
    hashes = {**read(ROOT/'releases/sources/source.json')['hashes'], **survey['hashes']}
    extra = read(ROOT/'releases/sources/central-western/vectors.json')
    hashes = {**extra['hashes'], **hashes}
    pinned = []
    unresolved = []
    for x,y in sorted(all_cells):
        parent = f'{x//8}-{y//8}'
        if parent not in hashes or not (BATCH.parent/'vectors'/f'{parent}.mvt').exists():
            unresolved.append([x,y])
        else:
            pinned.append(dict(x=x,y=y))
    classified = grid('inspect', tiles=pinned, centralWestern=True)
    jobs = production_jobs()
    halo = {(xx,yy) for x,y in all_cells for xx in range(x-4,x+5) for yy in range(y-4,y+5)}
    inventory, unavailable, sources = current_inventory(jobs, halo)
    if unavailable:
        raise ValueError(f'Cannot count existing compositions: {unavailable}')
    occupied = scene_inventory(inventory,jobs)
    books = {p.stem:read(p) for p in sorted(BOOK.glob('*.json'))}
    inland = set(read(ROOT/'releases/si-scenes.json')) - set(grid('coastal-catalog'))
    expected = inland - {p.stem for p in BOOK.parent.glob('*.json')}
    if set(books) != expected or len(books)!=24 or any(len(book)!=5 for book in books.values()):
        raise ValueError('Expected five concepts for each of the 24 previously uncovered inland families')
    choices = {}
    stats = Counter()
    ring = {cell(s):s.get('ring') for s in survey['sites'] if s['region']=='HKU'}
    for site in classified:
        xy = cell(site)
        options = list(inventory.get(xy,{}).values())
        if not (site['selected'] and site['regionalLandAvailable'] and site['isTargetable']):
            stats['ineligible']+=1
        elif site['coastal']:
            stats['coastal']+=1
        elif len(options)!=1 or options[0]['status']!='accepted':
            stats['withoutExactlyOneAcceptedAndNoPending']+=1
        elif xy in ((214184,114419),(214184,114420)) or ring.get(xy) in (1,2,3):
            stats['protectedCampusStack']+=1
        else:
            choices[xy]=dict(site, original=options[0]['url'],originalSha256=options[0]['sha256'])
    picks=staggered(rows,choices)
    seed = grid('cloud-seed')
    def assign(pass_number):
        planned = defaultdict(set)
        family_uses = Counter()
        concept_uses = Counter()
        assigned = []
        for x,y in picks:
            neighbours = [(xx, yy) for xx in range(x-4,x+5) for yy in range(y-4,y+5)]
            nearby = set().union(*(occupied[xy] | planned[xy] for xy in neighbours))
            available = set(books) - nearby
            if not available:
                continue
            def tie(value):
                return hashlib.sha256(f'{seed}:{pass_number}:{x}:{y}:{value}'.encode()).hexdigest()
            family = min(available, key=lambda f:(family_uses[f],tie(f)))
            index = min(range(5), key=lambda i:(concept_uses[family,i],tie(f'{family}-{i}')))
            concept = books[family][index]
            assigned.append(dict(choices[x,y], id=f'cw-{x}-{y}',z=18,region='Central and Western District',
                                 option=2,family=family,concept=index+1,name=concept['name'],prompt=concept['prompt']))
            planned[x,y].add(family)
            family_uses[family]+=1
            concept_uses[family,index]+=1
        return assigned, family_uses

    # Resolve tied choices across the frozen route so the last neighbourhood is
    # as well balanced as the first, keeping the real cloud seed unchanged.
    best = None
    for pass_number in range(128):
        candidate, counts = assign(pass_number)
        spread = max(counts.values(),default=0) - min((counts[f] for f in books),default=0)
        score = (len(picks)-len(candidate),spread)
        if best is None or score < best:
            assigned,family_uses,best = candidate,counts,score
        if score[0]==0 and spread<=1:
            break
    stats['familyExhausted'] = len(picks)-len(assigned)
    return dict(cloudSeed=seed, district=feature['properties'],boundarySha256=hashlib.sha256(boundary_path.read_bytes()).hexdigest(),
                sources=sources,districtCells=len(all_cells), unresolved=unresolved, exclusions=dict(stats),
                eligibleSecondSites=len(choices),familyCounts=dict(sorted(family_uses.items())),jobs=assigned)


def run(production, args):
    import signal
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import atlas_v2_registration as registration
    district = ROOT/'releases/sources/central-western/district.geojson'
    manifest = FOLDER/'jobs.json'
    status = FOLDER/'status.json'
    if args.action != 'run':
        result = (read(status) if args.action == 'status' and status.exists()
                  else read(manifest) if manifest.exists() else make_plan(district))
        print(json.dumps(result, indent=2))
        return
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: production.stop.set())
    registration.loaded_version = production.legacy['file_hash'](Path(registration.__file__))
    FOLDER.mkdir(exist_ok=True)
    print('Waiting for production batch lock', flush=True)
    with production.legacy['exclusive'](wait=True) as lock:
        if not manifest.exists():
            plan = make_plan(district)
            if set(plan['familyCounts']) != {path.stem for path in BOOK.glob('*.json')}:
                raise ValueError('Placement cannot cover every requested family')
            prepared = grid('prepare', tiles=plan['jobs'])
            for job in prepared:
                registration._layout(job)
                lat = math.atan(math.sinh(math.pi * (1-2*(job['y']+.5)/2**18)))
                width = 40075016.6856 * math.cos(lat) / 2**18
                job.update(gridRefill=True, context=f"This north-up Hong Kong site spans {width:.1f} m. "
                           f"A 1.7 m adult projects {1.7*.6*1024/width:.1f} pixels vertically at 1024 px. "
                           f"Registered landmarks: {json.dumps(job['siteContext'], ensure_ascii=False)}")
            plan['jobs'] = prepared
            production.save(manifest,plan)
        jobs=read(manifest)['jobs']
        direction=production.illustration_direction()
        examples=production.make_examples()
        attempts=Counter()
        while not production.stop.is_set():
            ready=[job for job in jobs if production.valid(job)]
            sites={cell(job) for job in jobs}
            inventory, unavailable, sources=current_inventory(production_jobs(),sites)
            if unavailable:
                raise ValueError(f'Existing artwork unavailable: {unavailable}')
            skipped=[]
            candidates=[]
            for job in jobs:
                if job in ready:
                    continue
                options=list(inventory.get(cell(job),{}).values())
                if (len(options)==1 and options[0]['status']=='accepted'
                        and job['originalSha256'] in options[0]['hashes']):
                    candidates.append(job)
                else:
                    skipped.append(job['id'])
            def report(state, active=(), **extra):
                data=dict(state=state, planned=len(jobs), registered=len(ready), heldForInventoryChange=skipped,
                          active=[j['id'] for j in active], updated=int(time.time()),sources=sources,**extra)
                production.save(status,data)
                print(json.dumps({k:v for k,v in data.items() if k!='sources'}),flush=True)
            if not candidates:
                production.publish()
                report('ready-for-review' if not skipped else 'inventory-changed')
                return
            previous={}
            for job in sorted(ready,key=lambda j:(production.directory(j)/'production.json').stat().st_mtime):
                previous[job['family']]=read(production.directory(job)/'production.json').get('description') or job['prompt']
            active=[]
            for job in sorted(candidates,key=lambda j:attempts[j['id']]):
                if any(j['family']==job['family'] for j in active):
                    continue
                if production.legacy['file_hash'](ROOT / job['reference']) != job['referenceSha256']:
                    raise ValueError(f"Source reference changed for {job['id']}")
                active.append(dict(job,counterexample=previous.get(job['family'])))
                if len(active)==args.workers:
                    break
            report('generating',active)
            issues={}
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures={pool.submit(production.generate,j,lock,examples,direction,registration):j for j in active}
                for future in as_completed(futures):
                    job=futures[future]
                    outcome=future.result()
                    attempts[job['id']]+=1
                    if outcome=='ready' and production.valid(job):
                        ready.append(job)
                        production.publish()
                        report('generating',[j for f,j in futures.items() if not f.done()])
                    else:
                        issues[job['id']]=outcome
            if issues:
                report('retry',issues=issues)
                if 'access' in issues.values() or 'disk-space' in issues.values():
                    raise RuntimeError(str(issues))
                production.stop.wait(900 if 'quota' in issues.values() else 90 if 'rate' in issues.values() else 5)
        report('stopped')
