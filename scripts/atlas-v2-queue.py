"""Freeze a reconciled production queue with one reference per geographic cell."""
import argparse
import fcntl
import hashlib
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path
import random
import secrets
import subprocess
import tempfile
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('releases/sources')
BATCH = Path('generated-tiles/dream-atlas')
OUT = BATCH / 'production'
LIVE = Path('generated-tiles')
TARGET = 500
DISTRICTS = ('Western Kowloon', 'Mong Kok', 'Tsim Sha Tsui and Kowloon Peninsula')
CENTRE = {(214184, 114419), (214184, 114420)}


def load(path):
    return json.loads(Path(path).read_text())


def save(path, data):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(handle.name, path)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def coords(item):
    return item['x'], item['y']


def inventory(families):
    names = {c['name']: f for f, entries in families.items() for c in entries}
    reviews = {r['url']: r for r in load('releases/v2-reviews.json')}
    kept = {}
    rejected = []
    sheets = load('public/atlas-v2/catalog.json')['sheets']
    catalog = {s['id']: s for s in sheets}
    for collection in load('releases/v2-artwork.json')['collections']:
        pins = collection['artworks']
        for pinned in pins:
            if digest(Path(pinned['image'])) != pinned['sha256']:
                raise ValueError('Accepted release image changed: ' + pinned['image'])
        for index, card in enumerate(collection['galleryCards']):
            sheet = catalog[Path(card).stem]
            row = pins[5*index:5*index+5]
            if not sheet.get('accepted') or [a['title'] for a in sheet['art']] != [p['title'] for p in row]:
                raise ValueError('Rebuild the local V2 catalog from the current release before reconciliation: ' + card)
    for sheet in sheets:
        if sheet['id'].startswith('production-'):
            continue
        for a in sheet['art']:
            url = a['url']
            status = reviews.get(url, {}).get('status', 'accepted' if sheet.get('accepted') else 'pending')
            if status == 'rejected':
                rejected.append(dict(a, family=a.get('scene') or names.get(a['title'])))
                continue
            source = Path('public' + urlsplit(url).path)
            sha = digest(source)
            version = parse_qs(urlsplit(url).query).get('v', [''])[0]
            if version and not sha.startswith(version):
                raise ValueError(f'{url} changed since review')
            kept[url] = dict(a, z=18, status=status, family=a.get('scene') or names.get(a['title']),
                             source=str(source), sha256=sha, sheet=sheet['id'])
    for url, a in reviews.items():
        if not url.startswith('/generated-tiles/'):
            continue
        parts = urlsplit(url)
        source = Path(parts.path[1:])
        query = parse_qs(parts.query)
        family = source.name
        if a['status'] == 'rejected':
            rejected.append(dict(a, family=family))
            continue
        cached = source.with_name(f'{family}.v{query["version"][0]}.{query["variant"][0]}.image')
        sha = digest(cached)
        if load(cached.with_suffix('.json'))['sha256'] != sha:
            raise ValueError(f'Accepted cached artwork changed: {url}')
        kept[url] = dict(a, z=18, family=family, source=str(cached), sha256=sha, sheet=None)
    rejected_by_url = {a['url']: a for a in rejected}
    for url, a in reviews.items():
        if a['status'] == 'rejected' and url not in rejected_by_url:
            rejected_by_url[url] = dict(a, family=a.get('scene') or names.get(a['title']))
    # The public viewer can expose one image through a contact sheet and again
    # through an accepted review alias. Count that image only once.
    unique = {}
    for item in kept.values():
        if item['sha256'] not in unique or item['status'] == 'accepted':
            unique[item['sha256']] = item
    return list(unique.values()), list(rejected_by_url.values())


def first_previous():
    prompts = {}
    for subdir in ('v2', 'hku-next', 'hku-north', 'hku-stewart', 'hku-west-upper'):
        path = BATCH / subdir / 'jobs.json'
        for job in load(path)['jobs']:
            if (path.parent / 'jobs' / job['id'] / 'result.json').exists():
                prompts[job['family']] = job['prompt']
    return prompts


def make_jobs(sites, families, seed, kept, rejected):
    rng = random.Random(seed)
    uses = Counter()
    concepts = defaultdict(Counter)
    previous = first_previous()
    jobs = []
    for site in sites:
        forbidden = {a['family'] for a in kept if coords(a) == coords(site)}
        bad_titles = {a['title'] for a in rejected if coords(a) == coords(site)}
        metres = 40075016.6856 / (2**18 * math.cosh(math.pi * (1-2*(site['y']+.5)/2**18)))
        context = (f'Tile width {metres:.1f} m. At 1024 px, a 1.7 m standing adult projects '
                   f'{1.7*.6*1024/metres:.1f} px vertically; a 2.1 m door projects {2.1*.6*1024/metres:.1f} px. '
                   'Registered landmarks with left, top, right and bottom as percentages: '
                   + ', '.join(f"{s['name']} {s['bounds']}" for s in site.get('siteContext', [])))
        for option in range(site['existingOptions']+1, site['options']+1):
            candidates = [f for f in families if f not in forbidden]
            least = min(uses[f] for f in candidates)
            family = rng.choice([f for f in candidates if uses[f] == least])
            briefs = [(i,c) for i,c in enumerate(families[family],1)
                      if c['name'] not in bad_titles and c['prompt'] != previous.get(family)]
            least_used = min(concepts[family][i] for i,_ in briefs)
            number, concept = rng.choice([(i,c) for i,c in briefs if concepts[family][i]==least_used])
            job = dict(id=f'{len(jobs)+1:04}', x=site['x'], y=site['y'], z=18, option=option,
                       region=site['region'], family=family, concept=number, name=concept['name'],
                       prompt=concept['prompt'], reference=site['reference'], context=context,
                       drawing='Read the registered source image first. Preserve the real setbacks, lot orientations, ground colour, through-routes, intersections and the tiny physical scale of people. Finish every structure inside the tile.',
                       counterexample=previous.get(family), landFraction=site['landFraction'],
                       coastal=site['coastal'], reclaimedPaths=site.get('reclaimedPaths',[]))
            if site['region'] == 'HKU':
                job['ring'] = site['ring']
            jobs.append(job)
            uses[family] += 1
            concepts[family][number] += 1
            previous[family] = concept['prompt']
            forbidden.add(family)
    return jobs


def reconcile(args):
    if (OUT/'jobs.json').exists():
        frozen=load(OUT/'jobs.json')
        print(f"Frozen queue: {len(frozen['jobs'])} jobs, {len(frozen['retained'])} retained")
        return
    if not (OUT/'sites.json').exists():
        subprocess.run(['dev-check','bun','scripts/atlas-v2-sites.ts','--fetch'],check=True)
    seedfile=OUT/'selection-seed.json'
    if not seedfile.exists():
        save(seedfile,{'seed':secrets.randbits(48)})
    seed=load(seedfile)['seed']
    families={p.stem:load(p) for p in sorted((SOURCE/'families').glob('*.json'))}
    assert len(families)==40 and all(len(c)==5 for c in families.values())
    kept,rejected=inventory(families)
    counts=Counter(map(coords,kept))
    source=load(OUT/'sites.json')
    ring=sorted((s for s in source['sites'] if s['region']=='HKU'),
                key=lambda s:(s['ring'],s['x'],s['y']))
    sites=[]
    for s in ring:
        n=max(1,5-s['ring'])
        if counts[coords(s)]<n:
            sites.append(dict(s,options=n,existingOptions=counts[coords(s)]))
    if args.first_cell:
        jobs=make_jobs(sites[:1],families,seed,kept,rejected)
        save(OUT/'first-cell.json',dict(seed=seed,jobs=jobs))
        return
    remaining=TARGET-len(kept)-sum(s['options']-s['existingOptions'] for s in sites)
    districts=[]
    for region in DISTRICTS:
        tiles=[s for s in load(SOURCE/'route.json') if s['region']==region and not counts[coords(s)]]
        districts.extend(dict(s,options=1,existingOptions=0) for s in tiles)
    remaining-=len(districts)
    # Visit every other checker cell first, then infill the same bounded corridor
    # when the checker alone cannot supply the requested 500 distinct paintings.
    north=[s for s in source['sites'] if s['region']=='North Hong Kong Island' and not counts[coords(s)]]
    selected=[]
    for parity,targetable in [(0,True),(0,False),(1,True),(1,False)]:
        pool=[s for s in north if sum(coords(s))%2==parity and s['isTargetable']==targetable]
        n=min(remaining-len(selected),len(pool))
        if n:
            selected.extend(pool[int((i+.5)*len(pool)/n)] for i in range(n))
    if len(selected)!=remaining:
        raise ValueError(f'Need {remaining} northern sites, found {len(selected)}')
    selected.sort(key=lambda s:(s['x'],-s['y'] if s['x']%2 else s['y']))
    sites.extend(dict(s,options=1,existingOptions=0) for s in selected)
    sites.extend(districts)
    if args.select:
        save(OUT/'selected-sites.json',sites)
        return
    selection=OUT/'selected-sites.json'
    if not selection.exists() or [coords(s) for s in load(selection)] != [coords(s) for s in sites]:
        save(selection,sites)
    if any(not Path(s['reference']).is_file() or 'siteContext' not in s for s in load(selection)):
        subprocess.run(['dev-check','bun','scripts/atlas-v2-sites.ts','--references'],check=True)
    prepared=load(selection)
    assert [coords(s) for s in prepared]==[coords(s) for s in sites]
    assert all(Path(s['reference']).is_file() and 'siteContext' in s for s in prepared)
    jobs=make_jobs(prepared,families,seed,kept,rejected)
    if (OUT/'first-cell.json').exists():
        first=load(OUT/'first-cell.json')['jobs']
        assert jobs[:len(first)]==first
    assert len(jobs)+len(kept)==TARGET
    import sys
    if not (OUT/'reference-audit.json').exists():
        subprocess.run(['dev-check',sys.executable,__file__,'--audit-refs'],check=True)
    audits=load(OUT/'reference-audit.json')
    for site in prepared:
        a=audits[site['reference']]
        if digest(Path(site['reference'])) != a['sha256']:
            raise ValueError('Source reference changed after its geographic audit: '+site['reference'])
    north_sites=[s for s in prepared if s['region']=='North Hong Kong Island']
    reconciliation=dict(
        effectiveAccepted=sum(a['status']=='accepted' for a in kept),
        existingPending=sum(a['status']=='pending' for a in kept),
        retainedLive=sum(a['sheet'] is None for a in kept),
        newByRegion=dict(Counter(j['region'] for j in jobs)),
        newByRing=dict(Counter(j['ring'] for j in jobs if 'ring' in j)),
        ringCellsByDistance=dict(Counter(s['ring'] for s in ring)),
        newNorthernCheckerboard=sum(sum(coords(s))%2==0 for s in north_sites),
        newNorthernInfill=sum(sum(coords(s))%2!=0 for s in north_sites),
        northBelowAutomaticCloudThreshold=sum(not s['isTargetable'] for s in north_sites),
        minimumDrawableFraction=min(a['usableFraction'] for a in audits.values()),
        districtTargets={region:20 for region in DISTRICTS},
        policy='Retain exact current V2 assets and approved live discoveries. Complete two-tile HKU rings on surveyed land within the campus and downhill boundary. Extend the northern zigzag on alternating cells first, then include additional drawable corridor cells to reach the total without extra Kowloon or duplicate options.'
    )
    manifest=dict(target=TARGET,seed=seed,retained=kept,excludedRejected=rejected,
                  reconciliation=reconciliation, referenceAudit='reference-audit.json',
                  vectorRelease=source['release'],vectorHashes=source['hashes'],jobs=jobs)
    save(OUT/'jobs.json',manifest)
    print(f'{len(kept)} retained, {len(jobs)} queued; {len(prepared)} new or unfinished cells')
    print(Counter(j['region'] for j in jobs))


def audit_plates():
    from atlas_v2_registration import _layout
    audits={}
    for s in load(OUT/'selected-sites.json'):
        ref=s['reference']
        _, usable, _, _ = _layout(s)
        audits[ref]=dict(sha256=digest(Path(ref)), usableFraction=round(float(usable.mean()),5))
    save(OUT/'reference-audit.json',audits)
    print('Registered drawable ground confirmed on',len(audits),'distinct references')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--first-cell',action='store_true')
    parser.add_argument('--select',action='store_true')
    parser.add_argument('--audit-refs',action='store_true')
    args=parser.parse_args()
    os.chdir(ROOT)
    OUT.mkdir(exist_ok=True,parents=True)
    if args.audit_refs:
        audit_plates()
        return
    with (OUT/'queue.lock').open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX)
        reconcile(args)


if __name__=='__main__':
    main()
