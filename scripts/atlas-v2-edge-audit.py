#!/usr/bin/env python3
"""Screen current V2 silhouettes for cutoffs; generate a contextual human-review queue."""
import argparse
import hashlib
import html
import json
import math
from pathlib import Path
from urllib.parse import urlencode

import cv2
import numpy as np
from PIL import Image, ImageDraw

from atlas_v2_grid import BATCH, ROOT, decisions, effective_plan

OUT = ROOT / 'generated-tiles/dream-atlas/edge-audit'
ALGORITHM_VERSION = 2


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def screen(image):
    """Return geometric candidates, never a semantic defect verdict. Units: px at 1024 wide."""
    rgba = np.asarray(image.convert('RGBA').resize((1024, round(image.height*1024/image.width))))
    alpha = rgba[:, :, 3]
    solid = (alpha > 127).astype('uint8')
    if solid.mean() > .985:
        return dict(mode='opaque-manual-review', candidates=[], score=0,
                    reason='No reliable isolated silhouette; a rectangular image frame is not object evidence.')
    outline = cv2.morphologyEx(solid, cv2.MORPH_GRADIENT, np.ones((3,3), np.uint8)) * 255
    lines = cv2.HoughLinesP(outline, 1, np.pi/720, threshold=28,
                            minLineLength=48, maxLineGap=3)
    gray = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2GRAY).astype(float)
    candidates = []
    height, width = solid.shape
    for line in ([] if lines is None else lines[:,0]):
        x1,y1,x2,y2 = map(int,line)
        dx,dy=x2-x1,y2-y1
        length=math.hypot(dx,dy)
        if length < 48: continue
        # Require real silhouette support, not a line crossing unrelated objects.
        count=max(2,round(length))
        xs=np.linspace(x1,x2,count);ys=np.linspace(y1,y2,count)
        support=float(np.mean(outline[np.rint(ys).astype(int),np.rint(xs).astype(int)]>0))
        if support < .9: continue
        nx,ny=-dy/length,dx/length
        def samples(distance, data):
            xx=np.clip(np.rint(xs+nx*distance).astype(int),0,width-1)
            yy=np.clip(np.rint(ys+ny*distance).astype(int),0,height-1)
            return data[yy,xx]
        sign=1 if samples(4,solid).mean()>samples(-4,solid).mean() else -1
        # Detail intersecting a perfectly straight silhouette raises priority,
        # but joints on a legitimate wall can produce the same signal.
        inner=samples(sign*4,gray)
        detail=float(np.mean(np.abs(np.diff(inner))>18))
        side_change=float(np.mean(samples(sign*4,solid)!=samples(-sign*4,solid)))
        if side_change < .8: continue
        frame_distance=min(x1,x2,y1,y2,width-1-x1,width-1-x2,height-1-y1,height-1-y2)
        angle=math.degrees(math.atan2(dy,dx))%180
        candidate=dict(line=[x1,y1,x2,y2],length=round(length,1),angle=round(angle,1),
                       silhouetteSupport=round(support,3),detailTransitions=round(detail,3),
                       frameDistance=frame_distance,atActualFrame=frame_distance<=2,
                       score=round(length*(1+2*detail),1))
        # Collapse parallel detections of the same contour without discarding
        # independent sides or the boundaries around interior openings.
        midpoint=np.array([(x1+x2)/2,(y1+y2)/2])
        duplicate=False
        for old in candidates:
            a,b,c,d=old['line'];delta=abs(old['angle']-angle)
            if min(delta,180-delta)<3 and np.linalg.norm(midpoint-np.array([(a+c)/2,(b+d)/2]))<max(12,min(length,old['length'])*.35):
                if candidate['score']>old['score']: old.update(candidate)
                duplicate=True;break
        if not duplicate:candidates.append(candidate)
    candidates.sort(key=lambda c:-c['score'])
    distinct=[]
    for candidate in candidates:
        p=np.array(candidate['line'][:2],dtype=float)
        q=np.array(candidate['line'][2:],dtype=float)
        unit=(q-p)/np.linalg.norm(q-p)
        duplicate=False
        for old in distinct:
            a=np.array(old['line'][:2],dtype=float);b=np.array(old['line'][2:],dtype=float)
            delta=abs(candidate['angle']-old['angle'])
            if min(delta,180-delta)>2:continue
            perpendicular=np.array([-unit[1],unit[0]])
            if max(abs(np.dot(a-p,perpendicular)),abs(np.dot(b-p,perpendicular)))>4:continue
            lo,hi=sorted([np.dot(a-p,unit),np.dot(b-p,unit)])
            overlap=max(0,min(candidate['length'],hi)-max(0,lo))
            if overlap>.5*min(candidate['length'],old['length']):duplicate=True;break
        if not duplicate:distinct.append(candidate)
    candidates=distinct
    score=round(sum(c['score'] for c in candidates[:4]),1)
    return dict(mode='silhouette-screen',candidates=candidates,score=score,
                reason='Geometry flags require content and map review; absence of a flag is not a pass.')


def inventory():
    plan,_=effective_plan(read(BATCH/'jobs.json'))
    reviews=decisions();seen=set()
    for job in plan['jobs']:
        folder=BATCH/'jobs'/job['id'];receipt=folder/'production.json'
        if not receipt.exists():continue
        entry=read(receipt);url=f"/atlas-v2/production/{job['id']}-{entry['overlaySha256'][:16]}.webp"
        if reviews.get(url)=='rejected':continue
        source=folder/'overlay.webp'
        if digest(source)!=entry['overlaySha256']:raise ValueError(f'Stale receipt: {job["id"]}')
        seen.add(url)
        yield dict(id=job['id'],title=job['name'],tile=[job['z'],job['x'],job['y']],
                   rows=1,url=url,image=str(source.relative_to(ROOT)),
                   reference=job['reference'],original=str((folder/'image.png').relative_to(ROOT)),
                   editorialStatus=reviews.get(url,'pending'))
    for art in plan['retained']:
        if art['url'] in seen or reviews.get(art['url'])=='rejected':continue
        seen.add(art['url']);source=ROOT/art['source']
        if digest(source)!=art['sha256']:raise ValueError(f'Stale retained edition: {art["title"]}')
        reference=ROOT/f'generated-tiles/dream-atlas/revised/references/18-{art["x"]}-{art["y"]}.png'
        yield dict(id='retained-'+art['sha256'][:16],title=art['title'],tile=[art.get('z',18),art['x'],art['y']],
                   rows=art.get('rows',1),url=art['url'],image=art['source'],original=None,
                   reference=str(reference.relative_to(ROOT)) if reference.exists() and art.get('rows',1)==1 else None,
                   editorialStatus=reviews.get(art['url'],art.get('status','pending')))


def diagnostic(entry, image, result):
    painting=image.convert('RGBA').resize((1024,round(image.height*1024/image.width)))
    if entry['reference']:
        with Image.open(ROOT/entry['reference']) as reference:
            base=reference.convert('RGBA').resize(painting.size)
    else:base=Image.new('RGBA',painting.size,'#fff9e9')
    base.alpha_composite(painting)
    marked=base.copy();draw=ImageDraw.Draw(marked)
    for number,candidate in enumerate(result['candidates'][:20],1):
        x1,y1,x2,y2=candidate['line']
        draw.line((x1,y1,x2,y2),fill='#ff2255',width=3)
        x,y=(x1+x2)//2,(y1+y2)//2
        draw.rectangle((x-3,y-3,x+21,y+13),fill='#fff9e9')
        draw.text((x,y),str(number),fill='#990022')
    canvas=Image.new('RGB',(2048,painting.height),'#fff9e9')
    canvas.paste(base.convert('RGB'),(0,0));canvas.paste(marked.convert('RGB'),(1024,0))
    canvas.thumbnail((1200,1200));canvas.save(OUT/f'{entry["id"]}.jpg',quality=86)


def run():
    OUT.mkdir(parents=True,exist_ok=True)
    reviews=read(OUT/'content-reviews.json') if (OUT/'content-reviews.json').exists() else {}
    previous=read(OUT/'report.json') if (OUT/'report.json').exists() else {}
    cached={e['id']:e for e in previous.get('items',[])} if previous.get('algorithmVersion')==ALGORITHM_VERSION else {}
    ledger=read(OUT/'repair-ledger.json') if (OUT/'repair-ledger.json').exists() else {}
    items=[]
    for entry in inventory():
        path=ROOT/entry['image'];entry['sha256']=digest(path)
        entry['referenceSha256']=digest(ROOT/entry['reference']) if entry['reference'] else None
        old=cached.get(entry['id'],{})
        if old.get('sha256')==entry['sha256'] and old.get('referenceSha256')==entry['referenceSha256'] and (OUT/f'{entry["id"]}.jpg').exists():
            result={key:old[key] for key in ('mode','candidates','score','reason')}
        else:
            with Image.open(path) as image:
                result=screen(image)
                diagnostic(entry,image,result)
        entry.update(result)
        entry['contentReview']='pending'
        if entry['sha256'] in reviews:
            entry['contentReview']=reviews[entry['sha256']]['status']
            entry['reviewNotes']=reviews[entry['sha256']]['notes']
            entry['userReported']=reviews[entry['sha256']].get('userReported',False)
        repair=ledger.get(entry['id'],{})
        if repair.get('sha256')==entry['sha256'] and repair.get('state')=='repaired-awaiting-editorial-review':
            entry['contentReview']='whole-perimeter-repaired; editorial review pending'
            entry['reviewNotes']='Inspected repair evidence: '+repair['stage']+'/review.json'
        if not entry['reference']:entry['contextWarning']='Registered multi-tile or original map context must be loaded before judging continuation.'
        items.append(entry)
    items.sort(key=lambda e:(e['contentReview'].startswith('whole-perimeter-repaired'),not e.get('userReported',False),-e['score']))
    catalog=read(ROOT/'public/atlas-v2/catalog.json')
    links={}
    for sheet in sorted(catalog['sheets'],key=lambda s:not s['id'].startswith('production-cell-')):
        for index,art in enumerate(sheet['art'],1):
            links.setdefault(art['url'],'/?review&'+urlencode(dict(card=sheet['id'],painting=index)))
    for entry in items:
        entry['reviewUrl']=links.get(entry['url'])
    report=dict(algorithmVersion=ALGORITHM_VERSION,method='all exposed alpha boundaries, including interior gaps, at 1024px normalized width',
                thresholds=dict(minimumSegment=48,strongLength=96,maximumGap=3,minimumSupport=.9),
                limits=['Long straight walls and quays can be legitimate.',
                        'Opaque assets require manual review; alpha cannot reveal their object boundaries.',
                        'Short, curved or feathered damage can evade screening.',
                        'No rejection, artistic acceptance or repair is inferred from geometry.'],
                total=len(items),flagged=sum(bool(e['candidates']) for e in items),
                manualOpaque=sum(e['mode']=='opaque-manual-review' for e in items),items=items)
    (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    parts=['<!doctype html><meta charset="utf-8"><title>Atlas V2 · Boundary review queue</title>',
           '<style>body{background:#fff9e9;color:#342719;font:16px system-ui;margin:28px}main{max-width:1250px;margin:auto}img{width:100%;height:auto}article{margin:32px 0;padding:16px;border:1px solid #baa}a{color:#745029}summary{cursor:pointer}p{line-height:1.5}</style><main>',
           '<h1>Boundary review queue</h1>',
           f'<p>{len(items)} current paintings screened. Ranked candidates, not confirmed defects. Left: mapped artwork. Right: up to twenty numbered boundary candidates. Inspect all sides and internal openings; retain only continuations supported by the map.</p>',
           '<p>Candidate floor: 48 px at 1024-wide scale. Long segments and intersecting detail rank first. Opaque assets and images with no candidates remain unreviewed.</p>']
    for number,e in enumerate(items,1):
        parts.append(f'<article id="{e["id"]}"><h2>{number}. {html.escape(e["title"])} · {e["id"]}</h2><p>{len(e["candidates"])} candidates · priority {e["score"]} · {e["mode"]} · {html.escape(e["contentReview"])}</p><img loading="lazy" src="{e["id"]}.jpg" alt="Artwork and marked boundaries"><p>')
        if e.get('reviewNotes'):parts.append('<p>'+html.escape(e['reviewNotes'])+'</p>')
        if e['reviewUrl']:parts.append(f'<a href="{html.escape(e["reviewUrl"])}">Open exact painting on map</a> · ')
        parts.append(f'<a href="{html.escape(e["url"])}">Exact overlay</a>')
        if e['original']:parts.append(f' · <a href="/{e["original"]}">Original drawing</a>')
        if e['reference']:parts.append(f' · <a href="/{e["reference"]}">Registered map</a>')
        if e.get('contextWarning'):parts.append('<p>'+e['contextWarning']+'</p>')
        parts.append('</p><details><summary>All candidate measurements</summary><pre>'+html.escape(json.dumps(e['candidates'],indent=2))+'</pre></details></article>')
    (OUT/'index.html').write_text('\n'.join(parts+['</main>']))
    print(json.dumps({k:report[k] for k in ('total','flagged','manualOpaque')}))
    print('Review: generated-tiles/dream-atlas/edge-audit/index.html')


if __name__=='__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    run()
