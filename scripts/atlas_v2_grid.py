"""Apply the live atlas grid to a frozen production inventory and its review decisions."""
from collections import Counter, defaultdict
import json
import random
from functools import lru_cache
from pathlib import Path
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT/'generated-tiles/dream-atlas/production'
SUPPLEMENT = BATCH/'grid-additions.json'
NORTH = 'North Hong Kong Island'
DISTRICTS = ('Western Kowloon', 'Mong Kok', 'Tsim Sha Tsui and Kowloon Peninsula')


def read(path):
    return json.loads(path.read_text())


def grid(action, **fields):
    return json.loads(subprocess.check_output(
        ['bun', 'scripts/atlas-v2-grid-sites.ts'], cwd=ROOT, text=True,
        input=json.dumps(dict(action=action, **fields))))


def cell(row):
    return row['x'], row['y']


def decisions():
    return {r['url']:r['status'] for r in read(ROOT/'releases/v2-reviews.json')}


def edition_url(job):
    path = BATCH/'jobs'/job['id']/'production.json'
    if path.exists():
        digest = read(path)['overlaySha256']
        return f"/atlas-v2/production/{job['id']}-{digest[:16]}.webp"
    return None


def preserves_reviewed_scene(job, reviews):
    """Keep repairs of approved scenes in their slot without approving new pixels."""
    status = reviews.get(edition_url(job))
    if status in ('accepted', 'rejected'):
        return status == 'accepted'
    folder = BATCH/'jobs'/job['id']
    receipt_path = folder/'production.json'
    if not receipt_path.exists():
        return False
    previous = read(receipt_path).get('edgeRepairOf')
    if not previous:
        return False
    ancestors = None
    seen = set()
    while previous and previous not in seen:
        seen.add(previous)
        url = f"/atlas-v2/production/{job['id']}-{previous[:16]}.webp"
        status = reviews.get(url)
        if status in ('accepted', 'rejected'):
            return status == 'accepted'
        if ancestors is None:
            ancestors = {}
            for path in (folder/'revisions').glob('*/production.json'):
                receipt = read(path)
                ancestors[receipt['overlaySha256']] = receipt.get('edgeRepairOf')
        previous = ancestors.get(previous)
    return False


@lru_cache(maxsize=1)
def coastal_catalog():
    return grid('coastal-catalog')


def coastal_option(job,seed,retained):
    catalog=coastal_catalog()
    excluded={r.get('family') for r in retained if cell(r)==cell(job)}
    choices=sorted(catalog.keys()-excluded)
    rng=random.Random(f"{seed}:{job['x']}:{job['y']}")
    rng.shuffle(choices)
    family=choices[(job['option']-1)%len(choices)]
    entry=catalog[family]
    return dict(job,id='sea-'+job['id'],waterfront=True,supersedes=job['id'],
                family=family,concept=1,name=family.replace('-',' ').title(),
                prompt=entry['brief'],waterfrontDirection=entry['direction'],counterexample=None)


def effective_plan(base, *, include_supplement=True):
    extra = read(SUPPLEMENT) if include_supplement and SUPPLEMENT.exists() else []
    jobs = base['jobs'] + extra
    retained = base.get('retained',[])
    reviews = decisions()
    allowed = {cell(j) for j in grid('eligible',tiles=[dict(x=x,y=y) for x,y in {cell(j) for j in jobs}])}
    current = []
    for j in jobs:
        if cell(j) in allowed:
            # Preserve approved scenes and their pending repairs. Editorial
            # acceptance remains bound to each exact edition in reviews.
            if j.get('coastal') and not preserves_reviewed_scene(j, reviews):
                current.append(coastal_option(j,base['seed'],retained))
            else:
                current.append(j)
        else:
            # Keep reviewed/current existing work in the contact book. A
            # permanently clear cell never receives a new worker or a refill.
            url = edition_url(j)
            if url and reviews.get(url) != 'rejected':
                current.append(j)
    return dict(base,jobs=current,retained=[r for r in retained if reviews.get(r['url'])!='rejected']), allowed


def hku_stacks(plan):
    sites = [s for s in read(BATCH/'sites.json')['sites'] if s['region']=='HKU']
    expected = {cell(s):5-s['ring'] for s in grid('eligible',tiles=sites)}
    counts = Counter(cell(r) for r in plan['retained'])
    pending = Counter()
    for j in plan['jobs']:
        if cell(j) in expected:
            pending[cell(j)] += 1
    return {xy: n-counts[xy]-pending[xy] for xy,n in expected.items() if counts[xy]+pending[xy]<n}


def add_missing_slots(base, plan):
    """Called after the first pass and on every refill pass. Keep existing IDs stable."""
    q = runpy.run_path(str(ROOT/'scripts/atlas-v2-queue.py'))
    from atlas_v2_registration import _layout
    extra = read(SUPPLEMENT) if SUPPLEMENT.exists() else []
    history = base['jobs'] + extra
    occupied = list(history)+base['retained']
    known = {cell(s):s for s in read(BATCH/'selected-sites.json')}
    surveyed = {cell(s):s for s in read(BATCH/'sites.json')['sites']}
    sites = []
    at_site = Counter(cell(j) for j in plan['jobs']+plan['retained'])
    for xy, deficit in sorted(hku_stacks(plan).items(),key=lambda entry:(surveyed[entry[0]]['ring'],entry[0])):
        s = dict(known.get(xy) or surveyed[xy])
        sites.append(dict(s,existingOptions=at_site[xy],options=at_site[xy]+deficit))
    needed = base['target']-len(plan['retained'])-len(plan['jobs'])-sum(s['options']-s['existingOptions'] for s in sites)
    if needed > 0:
        candidates = grid('candidates',occupied=[dict(x=x,y=y) for x,y in {cell(j) for j in occupied}])
        pools = defaultdict(list)
        for c in candidates:
            pools[c['region']].append(c)
        def take(region, count):
            pool=pools[region]
            n=min(max(count,0),len(pool))
            if not n: return 0
            # Spread replacements through the district instead of clustering.
            picks=[pool[int((i+.5)*len(pool)/n)] for i in range(n)]
            for p in picks:
                pool.remove(p)
                sites.append(dict(p,options=1,existingOptions=0))
            return n
        regional=Counter(j['region'] for j in plan['jobs'])
        for region in DISTRICTS:
            needed-=take(region,min(needed,20-regional[region]))
        needed-=take(NORTH,needed)
        # The district brief allows approximately twenty paintings each.
        for limit in (21,22):
            for region in DISTRICTS:
                allocated=sum(s['region']==region for s in sites)
                needed-=take(region,min(needed,limit-regional[region]-allocated))
    if not sites:
        return 0
    families={p.stem:read(p) for p in (ROOT/'releases/sources/families').glob('*.json')}
    # Forbid families already on the cell, including previously rejected ones.
    seen=[dict(x=j['x'],y=j['y'],family=j.get('family')) for j in occupied]
    previous = {j['family']:j['prompt'] for j in history}
    serial=max(int(j['id']) for j in history)
    written=0
    live_urls={r['url'] for r in plan['retained']}
    for site in grid('prepare',tiles=sites):
        try:
            _,usable,_,_=_layout(site)
        except ValueError as exc:
            raise ValueError(f"Cannot register grid refill site {cell(site)}: {exc}") from exc
        xy=cell(site)
        occupied_options={j['option'] for j in plan['jobs'] if cell(j)==xy}
        original=[r for r in base['retained'] if cell(r)==xy]
        occupied_options.update(i for i,r in enumerate(original,1) if r['url'] in live_urls)
        slots=iter(i for i in range(1,site['options']+1) if i not in occupied_options)
        for j in q['make_jobs']([site],families,base['seed']+serial,seen,base['excludedRejected']):
            serial+=1
            j.update(id=f'{serial:04}',option=next(slots),counterexample=previous.get(j['family']),gridRefill=True,
                     referenceSha256=site['referenceSha256'],usableFraction=float(usable.mean()))
            previous[j['family']]=j['prompt']
            extra.append(j)
            seen.append(j)
            written+=1
    q['save'](SUPPLEMENT,extra)
    return written


def stack_inventory(base, plan, reviews):
    sites=[s for s in read(BATCH/'sites.json')['sites'] if s['region']=='HKU']
    targets={cell(s):5-s['ring'] for s in grid('eligible',tiles=sites)}
    centre=(214184,114420)
    targets[centre]=5  # One stack shared with the northern Main Building cell.
    paintings=defaultdict(set)
    for r in plan['retained']:
        if reviews.get(r['url'])!='rejected':
            paintings[cell(r)].add(r['sha256'])
    for j in plan['jobs']:
        if cell(j) in targets:
            url=edition_url(j)
            if url and reviews.get(url)!='rejected':
                paintings[cell(j)].add(read(BATCH/'jobs'/j['id']/'production.json')['overlaySha256'])
    return [dict(x=x,y=y,required=n,current=len(paintings[x,y]),missing=max(0,n-len(paintings[x,y])))
            for (x,y),n in sorted(targets.items(),key=lambda t:(-t[1],t[0]))]
