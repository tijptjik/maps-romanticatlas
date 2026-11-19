"""Verify the frozen queue, image evidence, public sheets and the in-context contact book."""
import argparse
from collections import Counter, defaultdict
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

import numpy as np
from PIL import Image

from atlas_v2_grid import effective_plan, decisions, edition_url, stack_inventory, grid, coastal_catalog
from atlas_v2_registration import REFILL_MIN_PARCEL_OCCUPANCY, check_waterfront, _layout, _reviewed_crossing, _crossing_digest, _minor_sites, _source

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT/'generated-tiles/dream-atlas/production'
GALLERY = BATCH.parent/'cards'
PUBLIC = ROOT/'public/atlas-v2/production'
SOURCE = ROOT/'releases/sources'
DISTRICTS = ('Western Kowloon', 'Mong Kok', 'Tsim Sha Tsui and Kowloon Peninsula')


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(f.name, path)


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def token(item):
    return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()


def stamp(path):
    st = path.stat()
    return [str(path), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def xy(record):
    return record['x'], record['y']


def ring(x,y):
    return max(abs(x-214184),114419-y,y-114420,0)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = set()
        self.images = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.hrefs.add(attrs.get('href'))
        if tag == 'img':
            self.images.add(attrs.get('src'))


class Audit:
    def __init__(self, live=None, fresh=False):
        self.live = live
        self.reviews = decisions()
        self.cache_path = BATCH/'audit-cache.json'
        signature = [sha(Path(__file__)),sha(ROOT/'scripts/atlas_v2_registration.py'),sha(ROOT/'scripts/atlas_v2_grid.py')]
        old = read(self.cache_path) if self.cache_path.exists() and not fresh else {}
        self.cache = old if old.get('signature') == signature else {'signature':signature,'jobs':{},'cards':{}}
        self.report = {'goalComplete':False,'issues':[], 'queue':{}, 'generation':{}, 'gallery':{}}

    def issue(self, message):
        self.report['issues'].append(str(message))

    def run(self):
        manifest = BATCH/'jobs.json'
        if not manifest.exists():
            self.report['queue'] = {'frozen':False}
            self.report['generation'] = {'currentJobDirectories':len(list((BATCH/'jobs').glob('*/dispatch.json')))}
            return self.report
        plan = read(manifest)
        self.report['manifestSha256'] = sha(manifest)
        jobs = plan['jobs']
        old_report = read(BATCH/'audit.json') if (BATCH/'audit.json').is_file() else {}
        initial_hash=old_report.get('initialManifestSha256', old_report.get('manifestSha256',self.report['manifestSha256']))
        self.report['initialManifestSha256']=initial_hash
        if self.report['manifestSha256']!=initial_hash:self.issue('Frozen production manifest hash changed')
        self.check_plan(plan)
        base=plan
        plan,allowed=effective_plan(base)
        jobs=plan['jobs']
        extra=[j for j in jobs if j.get('gridRefill')]
        self.report['queue']['effectiveJobs']=len(jobs)
        self.report['queue']['effectiveRetained']=len(plan['retained'])
        self.report['queue']['eligibleGridAdditions']=len(extra)
        if len({j['id'] for j in jobs})!=len(jobs):self.issue('Duplicate effective job IDs')
        originals={xy(j) for j in base['jobs']+base['retained']}
        survey={xy(s):s for s in read(BATCH/'sites.json')['sites']}
        if extra:
            candidates={xy(s):s for s in grid('candidates',occupied=[dict(x=x,y=y) for x,y in originals])}
            families={f.stem:read(f) for f in (SOURCE/'families').glob('*.json')}
            for j in extra:
                pos=xy(j)
                geo=survey.get(pos) if j['region']=='HKU' else candidates.get(pos)
                if not geo or geo['region']!=j['region'] or pos not in allowed:
                    self.issue(f"{j['id']}: grid refill outside eligible surveyed region")
                if sha(ROOT/j['reference'])!=j['referenceSha256'] or not j['reference'].endswith(f"/18-{pos[0]}-{pos[1]}.png"):
                    self.issue(f"{j['id']}: grid refill reference mismatch")
                if not j.get('waterfront') and families[j['family']][j['concept']-1]!={'name':j['name'],'prompt':j['prompt']}:
                    self.issue(f"{j['id']}: unknown grid refill concept")
                if sum(k['family']==j['family'] and xy(k)==pos for k in jobs+plan['retained'])>1:
                    self.issue(f"{j['id']}: duplicate family in refill cell")
        for j in jobs:
            if j.get('waterfront'):
                if not j.get('coastal') or coastal_catalog().get(j['family'],{}).get('brief') != j['prompt']:
                    self.issue(f"{j['id']}: coastal scene differs from the shared atlas catalog")
            elif j.get('coastal') and xy(j) in allowed and self.reviews.get(edition_url(j))!='accepted':
                self.issue(f"{j['id']}: eligible shoreline slot still uses an unapproved land scene")
        self.report['queue']['coastalJobs']=sum(bool(j.get('waterfront')) for j in jobs)
        ready = {}
        failed = 0
        revisions = Counter()
        for job in jobs:
            folder=BATCH/'jobs'/job['id']
            if (folder/'revisions').exists():
                revisions[job['id']] = len(list((folder/'revisions').glob('*/result.json')))
            if not (folder/'production.json').is_file():
                continue
            current_url='/atlas-v2/production/'+job['id']+'-'+read(folder/'production.json')['overlaySha256'][:16]+'.webp'
            if self.reviews.get(current_url)=='rejected':
                continue
            try:
                ready[job['id']] = self.check_job(job, folder)
                if len(ready)%25 == 0:
                    save(self.cache_path,self.cache)
            except (ValueError,KeyError,OSError,IndexError) as e:
                self.issue(f"Job {job['id']}: {e}")
                failed += 1
        self.report['generation'] = dict(ready=len(ready),remaining=len(jobs)-len(ready),invalid=failed,
                revisionSources=sum(revisions.values()),semanticReviewPending=sum(self.reviews.get('/atlas-v2/production/'+i+'-'+q['sha256'][:16]+'.webp',q['visualReview'])=='pending' for i,q in ready.items()))
        hashes = [q['sha256'] for q in ready.values()]+[r['sha256'] for r in plan['retained']]
        if len(hashes)!=len(set(hashes)):
            self.issue('Duplicate image content in retained + registered production assets')
        self.check_gallery(plan,ready)
        stacks=stack_inventory(base,plan,self.reviews)
        self.report['hkuStacks']=dict(eligible=len(stacks),underfilled=sum(s['missing']>0 for s in stacks),
                                     missing=sum(s['missing'] for s in stacks))
        if len(ready)==len(jobs):
            if any(s['missing'] for s in stacks):self.issue('Eligible HKU stacks still have missing options')
            if len(plan['retained'])+len(jobs)!=base['target']:self.issue('Effective inventory does not yet sum to the release target')
        save(self.cache_path,self.cache)
        self.report['goalComplete'] = (not self.report['issues'] and len(ready)==len(jobs)
                and self.report['gallery']['publishedPaintings']==len(jobs)
                and self.report['gallery']['retainedInContactBook']==len(plan['retained']))
        return self.report

    def check_plan(self, plan):
        retained, jobs = plan['retained'],plan['jobs']
        self.report['queue'] = dict(frozen=True, target=plan['target'],retained=len(retained),jobs=len(jobs),
                total=len(retained)+len(jobs),regionJobs=dict(Counter(j['region'] for j in jobs)),
                ringJobs=dict(Counter(j['ring'] for j in jobs if j['region']=='HKU')))
        def check(ok, reason):
            if not ok:self.issue(reason)
        check(len(retained)+len(jobs)==plan['target']==500, 'Target is not 500 unique paintings')
        check(len({r['url'] for r in retained})==len(retained),'Duplicate retained URLs')
        check(len({j['id'] for j in jobs})==len(jobs),'Duplicate production IDs')
        rejects={r['url'] for r in plan['excludedRejected']}
        check(rejects.isdisjoint(r['url'] for r in retained),'Previously rejected artwork counted as retained')
        release=read(ROOT/'releases/v2-artwork.json')
        catalog=read(ROOT/'public/atlas-v2/catalog.json')
        reviews={r['url']:r['status'] for r in read(ROOT/'releases/v2-reviews.json')}
        all_art=[(s,a) for s in catalog['sheets'] if not s['id'].startswith('production-') for a in s['art']]
        catalog_urls={a['url'] for _,a in all_art}
        listed={r['url'] for r in retained}
        for s,a in all_art:
            if s.get('accepted') and reviews.get(a['url'])!='rejected':
                check(a['url'] in listed, f"Released image missing from inventory: {a['title']}")
        for a in retained:
            if a['url'].startswith('/generated-tiles/'):
                check(reviews.get(a['url']) in ('accepted','rejected'),f"Missing live decision: {a['url']}")
            else:
                check(a['url'] in catalog_urls,f"Missing retained map URL: {a['url']}")
            path=ROOT/a['source']
            check(path.is_file() and sha(path)==a['sha256'],f"Retained hash mismatch: {a['title']}")
            ver=parse_qs(urlsplit(a['url']).query).get('v')
            check(not ver or a['sha256'].startswith(ver[0]),f"Stale retained URL: {a['url']}")
        for c in release['collections']:
            for a in c['artworks']:
                check((ROOT/a['image']).is_file() and sha(ROOT/a['image'])==a['sha256'],f"Release asset changed: {a['title']}")
        families={f.stem:read(f) for f in (SOURCE/'families').glob('*.json')}
        check(len(families)==40 and all(len(v)==5 for v in families.values()),'Expected 40 families of five concepts')
        survey=read(BATCH/'sites.json')
        source=read(SOURCE/'source.json')
        check(plan['vectorRelease']==survey['release']==source['release'],'Survey release mismatch')
        for key,digest in plan['vectorHashes'].items():
            p=BATCH.parent/'vectors'/f'{key}.mvt'
            check(p.is_file() and sha(p)==digest,f'Changed vector parent {key}')
        sites={xy(s):s for s in survey['sites']}
        route={xy(s):s['region'] for s in read(SOURCE/'route.json')}
        groups=defaultdict(list)
        existing=Counter(xy(a) for a in retained)
        existing_families=defaultdict(set)
        for a in retained:existing_families[xy(a)].add(a.get('family'))
        rejected_titles={(xy(s),s['title']) for s in plan['excludedRejected']}
        prior={}
        for j in jobs:
            tile=xy(j);f=j['family'];groups[tile].append(j)
            check(j['z']==18 and j['reference'].endswith(f"/18-{tile[0]}-{tile[1]}.png") and (ROOT/j['reference']).is_file(),
                  f"{j['id']}: missing genuine z18 reference")
            check(f in families and 1<=j['concept']<=len(families[f]) and families[f][j['concept']-1]=={'name':j['name'],'prompt':j['prompt']},
                  f"{j['id']}: unknown family write-up")
            check((tile,j['name']) not in rejected_titles,f"{j['id']}: repeated locally rejected title")
            if f in prior:
                check(j['counterexample']==prior[f] and j['prompt']!=prior[f],f"{j['id']}: stale previous-family counterexample")
            prior[f]=j['prompt']
            if j['region'] in DISTRICTS:
                check(route.get(tile)==j['region'],f"{j['id']}: wrong Kowloon district")
            else:
                check(sites.get(tile,{}).get('region')==j['region'],f"{j['id']}: outside northern corridor or campus")
        refs=read(BATCH/'reference-audit.json')
        expected_refs={j['reference'] for j in jobs}
        check(expected_refs.issubset(refs),'Reference audit missing scheduled survey plates')
        for name in expected_refs & refs.keys():
            check(sha(ROOT/name)==refs[name]['sha256'], f'Registered genuine plate changed: {name}')
        self.report['queue']['verifiedReferenceHashes']=len(expected_refs & refs.keys())
        self.report['queue']['sceneFamiliesScheduled']=len(prior)
        self.report['queue']['distinctWriteupsScheduled']=len({(j['family'],j['concept']) for j in jobs})
        check(len(prior)==len(families),'Frozen selection omits scene families')
        selected=read(BATCH/'selected-sites.json')
        check(list(groups)==[xy(s) for s in selected],'Frozen cell order differs from surveyed selection')
        campus=[s for s in selected if s['region']=='HKU']
        check([s['ring'] for s in campus]==sorted(s['ring'] for s in campus),'Campus rings out of order')
        north=[xy(s) for s in selected if s['region']=='North Hong Kong Island']
        check(north==sorted(north,key=lambda c:(c[0],-c[1] if c[0]%2 else c[1])),'Northern corridor route is not a west-to-east zigzag')
        self.report['queue']['northernCheckerParity'] = dict(Counter((x+y)%2 for x,y in north))
        for s in selected:
            tile=xy(s);row=groups[tile]
            fs=[j['family'] for j in row]
            check(len(fs)==len(set(fs)) and not (set(fs)&existing_families[tile]),f'Repeated family on {tile}')
            check(s['existingOptions']==existing[tile] and [j['option'] for j in row]==list(range(existing[tile]+1,s['options']+1)),
                  f'Option slots mismatch on {tile}')
            if s['region']=='HKU':
                radius=ring(*tile)
                check(1<=radius<=4 and radius==s['ring'] and s['options']==5-radius,f'Wrong HKU radius/options on {tile}')
            else:check(s['options']==1,f'Unexpected repeat in corridor or district on {tile}')
        for tile,s in sites.items():
            if s['region']=='HKU':
                check(existing[tile]+len(groups.get(tile,[]))>=5-ring(*tile), f'Unfilled eligible HKU ring tile {tile}')
        for district in DISTRICTS:
            count=sum(len(group) for cell,group in groups.items() if route.get(cell)==district)
            count+=sum(n for cell,n in existing.items() if route.get(cell)==district)
            check(18<=count<=22,f'{district} expected about twenty, has {count}')
        centre=[a for a in retained if a['rows']==2 and xy(a)==(214184,114420)]
        check(len(centre)==5,'The two-tile HKU centre needs five retained alternatives')
        check(not any(tile in groups for tile in ((214184,114419),(214184,114420))),'Unexpected centre replacement')

    def check_job(self,j,folder):
        receipt=read(folder/'production.json')
        qa=read(folder/'qa.json')
        raw=folder/'image.png'
        generated=read(folder/'result.json')
        dispatch=read(folder/'dispatch.json')
        actual_reference=ROOT/dispatch['reference']
        overlay=folder/'overlay.webp'
        evidence=[overlay,raw,folder/'production.json',folder/'qa.json',folder/'result.json',folder/'dispatch.json',
                  ROOT/j['reference'],actual_reference,ROOT/dispatch['footprintReference']]
        if (folder/'reviewed-crossing.json').exists():evidence.append(folder/'reviewed-crossing.json')
        if dispatch.get('styleReference'):evidence.append(ROOT/dispatch['styleReference'])
        url=f"/atlas-v2/production/{j['id']}-{qa['sha256'][:16]}.webp"
        editorial=self.reviews.get(url,'pending')
        fingerprint=token([j,editorial,[stamp(p) for p in evidence]])
        if self.cache['jobs'].get(j['id'])==fingerprint:return qa
        require(qa['id']==generated['id']==receipt['id']==j['id'],'receipt IDs disagree')
        require(receipt['cell']==qa['tile']==[j['z'],*xy(j)] and
                receipt['family']==j['family'] and receipt['title']==j['name'],'receipt scene or cell mismatch')
        for k in ('id','x','y','z','family','concept','name','prompt'):
            require(dispatch[k]==j[k],f'dispatch differs from frozen {k}')
        require('registered' in dispatch.get('guideInstruction','').lower(),'missing registered guide instruction')
        require(sha(actual_reference)==generated['referenceSha256'] and sha(ROOT/j['reference'])==qa['referenceSha256'],'reference hash mismatch')
        require(sha(raw)==generated['sha256']==qa['imageSha256']==receipt['sourceSha256'],'source image hash mismatch')
        require(sha(overlay)==receipt['overlaySha256']==qa['sha256'],'overlay hash mismatch')
        with Image.open(raw) as image:
            require(image.format=='PNG' and image.size==(generated['width'],generated['height']) and
                    image.width==image.height and image.width>=512,'invalid generated source')
            image.verify()
        with Image.open(overlay) as image:
            require(image.format=='WEBP' and image.mode=='RGBA' and image.size==(1024,1024),'invalid overlay format')
            alpha=np.asarray(image.getchannel('A'))
            bbox=image.getchannel('A').getbbox()
        require(bbox is not None,'empty artwork')
        margins=[bbox[0],bbox[1],1024-bbox[2],1024-bbox[3]]
        # Editor-installed editions may include surveyed streets in a full-tile
        # painting. Only an explicit decision on this precise overlay can accept
        # that treatment. Still verify the actual bytes, tile and public card.
        if editorial=='accepted' and not {'outerClearance','coveredRoadPixels','coveredWaterPixels','parcelOccupancy'}.issubset(qa):
            require(any(r.get('url')==url and r.get('title')==j['name'] and xy(r)==xy(j)
                        and r['status']=='accepted' for r in read(ROOT/'releases/v2-reviews.json')),
                    'editorial edition lacks a matching review on this tile')
            if 'outerClearance' in qa:require(qa['outerClearance']==margins,'editorial margin receipt is stale')
            if 'paintedFraction' in qa:
                require(abs(np.mean(alpha>127)-qa['paintedFraction'])<.001,'editorial occupancy receipt is stale')
            return qa
        require(margins==qa['outerClearance'] and min(margins)>0,'clipped frame or stale clearance')
        _,grounds,roads,water=_layout(j)
        crossing=qa.get('reviewedPedestrianCrossing')
        allowed=grounds.copy()
        if qa.get('supplementaryPockets'):
            seeds=_minor_sites(j,np.asarray(_source(raw)),grounds)
            require(qa['supplementaryPockets']==[list(p) for p in seeds],'pocket lacks a registration anchor in the painting')
            _,allowed,_,_=_layout(j,seeds)
        road_cap=0
        if crossing:
            require(crossing==_reviewed_crossing(folder,j,qa['imageSha256'],qa['referenceSha256']),'unverified street crossing')
            l,t,r,b=crossing['bounds']
            allowed[t:b,l:r]|=roads[t:b,l:r]
            road_cap=crossing['reviewedRoadPixels']
            require(road_cap==qa['coveredRoadPixels'] and _crossing_digest(alpha,roads)==crossing['roadMaskSha256'],
                    'covered street pixels differ from the inspected crossing')
        require(not np.any((alpha>0)&~allowed) and np.count_nonzero(alpha[roads])==qa['coveredRoadPixels'] and
                np.count_nonzero(alpha[water])==qa['coveredWaterPixels'],'placement differs from registered zones')
        if j.get('waterfront'):
            check_waterfront(alpha>127,allowed,roads,water)
        else:
            require(qa['coveredRoadPixels']<=road_cap and qa['coveredWaterPixels']==0,'land artwork occupies protected ground')
        filled=np.count_nonzero(alpha>127)
        require(abs(filled/alpha.size-qa['paintedFraction'])<.00006 and
                abs(filled/grounds.sum()-qa['parcelOccupancy'])<.00006,'occupancy differs from actual pixels')
        if j.get('gridRefill') or dispatch.get('refillReview') or (BATCH/'editorial-rejections'/j['id']).is_dir():
            require(filled/grounds.sum()>=REFILL_MIN_PARCEL_OCCUPANCY,'replacement underfills the drawable parcels')
        require(qa['visualReview'] in ('pending','accepted','rejected'),'unknown visual review status')
        self.cache['jobs'][j['id']]=fingerprint
        return qa

    def check_gallery(self,plan,ready):
        jobs=plan['jobs']
        rejected={url for url,status in self.reviews.items() if status=='rejected'}
        retained=defaultdict(list)
        for a in plan['retained']:
            if a['url'] not in rejected:retained[xy(a)].append(a)
        groups=defaultdict(list)
        for j in jobs:groups[xy(j)].append(j)
        expected={}
        byfamily=defaultdict(list)
        cells=0
        published_count=0
        for (x,y),row in groups.items():
            if any(j['id'] not in ready and not (BATCH/'jobs'/j['id']/'production.json').exists() and not (BATCH/'editorial-rejections'/j['id']).exists()
                   and not (j.get('gridRefill') or j.get('waterfront')) for j in row):continue
            row=[j for j in row if j['id'] in ready]
            if not row and not retained[x,y]:continue
            row.sort(key=lambda j:j['option'])
            mixed=[dict(a,reference=f'generated-tiles/dream-atlas/revised/references/18-{x}-{y}.png') for a in retained[x,y]]
            row=[j for j in row if self.review_art(j,ready)[0]['url'] not in rejected]
            if mixed or row:expected[f'production-cell-18-{x}-{y}']=mixed+row
            cells+=1
            published_count+=len(row)
            for j in row:byfamily[j['family']].append(j)
        for (x,y),entries in retained.items():
            orphaned=[r for r in entries if not r.get('sheet')]
            if (x,y) not in groups and orphaned:
                expected[f'production-retained-18-{x}-{y}']=[dict(r,reference=r['source']) for r in orphaned]
        for family,row in byfamily.items():
            for offset in range(0,len(row),5):
                members=row[offset:offset+5]
                if len(members)==5 or len(ready)==len(jobs):
                    expected[f'production-{family}-{1+offset//5:02}']=members
        index=read(PUBLIC/'sheets.json') if (PUBLIC/'sheets.json').exists() else {'sheets':[],'cards':[]}
        catalog_path=ROOT/'public/atlas-v2/catalog.json'
        catalog=read(catalog_path)
        maps={s['id']:s for s in catalog['sheets'] if s['id'].startswith('production-')}
        sheets={s['id']:s for s in index['sheets']}
        entries={c['id']:c for c in index['cards']}
        urls=Links()
        urls.feed((GALLERY/'index.html').read_text())
        if set(entries)!=set(sheets) or maps!=sheets:self.issue('Contact index and map catalog have different production sheets')
        if len(sheets)!=len(index['sheets']) or len(entries)!=len(index['cards']):self.issue('Duplicate production sheet IDs')
        unexpected=sorted(sheets.keys()-expected.keys())
        if unexpected:self.issue('Incorrect or prematurely published sheets: '+', '.join(unexpected))
        missing=sorted(expected.keys()-sheets.keys())
        if missing:self.issue('Ready sheets awaiting verified publication: '+', '.join(missing))
        live_catalog=None
        if self.live:
            with urlopen(self.live+'/atlas-v2/catalog.json',timeout=15) as resp:live_catalog=json.load(resp)
            if live_catalog!=catalog:self.issue('Served map catalog differs from the local production catalog')
        live_urls=set()
        painted=set()
        for key in expected.keys()&sheets.keys():
            try:
                self.check_card(key,expected[key],sheets[key],entries[key],ready,urls,live_urls)
                if key.startswith('production-cell-'):
                    painted.update(j['id'] for j in expected[key] if 'id' in j)
            except (KeyError,OSError,IndexError,ValueError) as e:
                self.issue(f'{key}: {e}')
        available_urls=set()
        for group in catalog['sheets']:
            jpeg=group['id']+'.jpg'
            if jpeg in urls.images and jpeg in urls.hrefs and (GALLERY/jpeg).is_file():
                available_urls.update(a['url'] for a in group['art'])
        absent=[r for r in plan['retained'] if r['url'] not in available_urls]
        if self.live:
            for art in plan['retained']:
                if art['url'] not in available_urls:
                    continue
                try:
                    self.check_live_art(art['url'],art['sha256'],live_urls)
                except (OSError,ValueError) as error:
                    self.issue(f"{art['title']}: {error}")
        if len(ready)==len(jobs) and absent:
            self.issue('Retained paintings missing from final review gallery: '+', '.join(r['title'] for r in absent))
        self.report['gallery']=dict(registeredJobsInCompletedCells=published_count,publishedPaintings=len(painted),
            retainedInContactBook=len(plan['retained'])-len(absent),retainedAwaitingCard=[r['title'] for r in absent],
            plannedCells=len(groups),readyCells=cells,cellSheets=sum(k.startswith('production-cell-') for k in sheets),
            retainedOnlySheets=sum(k.startswith('production-retained-') for k in sheets),
            themeSheets=sum(not k.startswith(('production-cell-','production-retained-')) for k in sheets),liveAssetChecks=len(live_urls))

    def check_live_art(self,url,digest,live_urls):
        if url in live_urls:
            return
        with urlopen(self.live+url,timeout=20) as response:
            require(hashlib.file_digest(response,'sha256').hexdigest()==digest,'served painting does not match its source')
        live_urls.add(url)

    def review_art(self, j, ready):
        if 'id' not in j:
            return {k:j[k] for k in ('title','x','y','rows','url')},ROOT/j['source'],j['sha256']
        digest=ready[j['id']]['sha256']
        path=PUBLIC/(j['id']+'-'+digest[:16]+'.webp')
        return dict(title=j['name'],x=j['x'],y=j['y'],rows=1,url='/atlas-v2/production/'+path.name),path,digest

    def check_card(self,key,row,sheet,entry,ready,links,live_urls):
        require(sheet['isolated'] is True and not sheet.get('accepted'), 'review sheet leaked into release defaults')
        require(entry['section']==('Cells' if key.startswith(('production-cell-','production-retained-')) else 'Themes'),'wrong gallery section')
        require(entry['title']==sheet['title'] and entry['file']==key+'.jpg' and
                entry['file'] in links.hrefs and entry['file'] in links.images and
                any(f'/?{flag}&card={key}&painting=1' in links.hrefs for flag in ('review','review=true')),'missing or incorrect gallery link')
        evidence=[self.review_art(j,ready) for j in row]
        expected,paths,digests=zip(*evidence)
        require(sheet['art']==list(expected),'job titles, coordinates, order or artwork versions differ')
        if self.live:
            for art,_,digest in evidence:
                self.check_live_art(art['url'],digest,live_urls)
        path=GALLERY/entry['file']
        key_token=token([row,sheet,[stamp(p) for p in [path,*paths,*[ROOT/j['reference'] for j in row]]]])
        if self.cache['cards'].get(key)==key_token:return
        with Image.open(path) as card:
            require(card.format=='JPEG' and card.size==(400*len(row),480),'incorrect card dimensions')
            for i,(j,p,digest) in enumerate(zip(row,paths,digests)):
                require(sha(p)==digest,'public overlay hash differs from verified job')
                with Image.open(p) as art,Image.open(ROOT/j['reference']) as ref:
                    composite=ref.convert('RGBA').resize(art.size,Image.Resampling.LANCZOS)
                    composite.alpha_composite(art.convert('RGBA'))
                    reference=composite.resize((400,400),Image.Resampling.LANCZOS).convert('RGB')
                panel=card.crop((400*i,0,400*(i+1),400)).convert('RGB')
                # Compare low-frequency colour and native-scale luminance.
                # JPEG subsamples chroma and a correct detailed red/blue painting
                # can legitimately have >5 RGB MAE at full resolution.
                def diff(a,b):
                    return np.mean(np.abs(np.asarray(a,dtype='float32')-np.asarray(b,dtype='float32')))
                chroma=diff(reference.resize((100,100),Image.Resampling.BOX),panel.resize((100,100),Image.Resampling.BOX))
                luminance=diff(reference.convert('L'),panel.convert('L'))
                require(chroma<3 and luminance<5,f"contact image does not depict {expected[i]['title']}")
                caption=np.asarray(card.crop((400*i+4,403,400*(i+1)-4,474)).convert('L'))
                require(np.count_nonzero(caption<120)>50,'panel title/footprint caption missing')
        self.cache['cards'][key]=key_token


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',metavar='BASE_URL',help='also hash every production painting fetched from the running map')
    parser.add_argument('--fresh',action='store_true',help='ignore cached checks and reopen each image')
    parser.add_argument('--require-complete',action='store_true',help='exit unsuccessfully if generation/publication is incomplete')
    args=parser.parse_args()
    audit=Audit(args.live.rstrip('/') if args.live else None,args.fresh)
    try:
        report=audit.run()
    except (OSError,ValueError,KeyError,IndexError) as exc:
        audit.issue(str(exc));report=audit.report
    print(json.dumps(report,indent=2))
    if BATCH.is_dir():save(BATCH/'audit.json',report)
    raise SystemExit(1 if report['issues'] or (args.require_complete and not report['goalComplete']) else 0)
