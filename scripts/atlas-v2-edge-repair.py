#!/usr/bin/env python3
"""Stage and install contextually reviewed whole-perimeter V2 artwork repairs."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import time

from PIL import Image
from atlas_v2_registration import finish
from atlas_v2_grid import ROOT, BATCH, decisions

REPAIRS=ROOT/'generated-tiles/dream-atlas/edge-repairs/dataset'

def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,d):
    tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(d,indent=2)+'\n');os.replace(tmp,p)
def link_or_copy(source,target):
    try:os.link(source,target)
    except OSError:shutil.copy2(source,target)

def stage(args):
    folder=BATCH/'jobs'/args.id
    receipt=read(folder/'production.json')
    if receipt['overlaySha256']!=args.expected_sha or sha(folder/'overlay.webp')!=args.expected_sha:
        raise ValueError('Current artwork changed since inspection; re-review the new edition')
    dest=REPAIRS/args.id/str(time.time_ns());dest.mkdir(parents=True)
    shutil.copy2(args.image,dest/'image.png')
    shutil.copy2(REPAIRS/args.id/'prompt.txt',dest/'prompt.txt')
    job=read(folder/'dispatch.json')
    write(dest/'provenance.json',dict(id=args.id,previousOverlaySha256=args.expected_sha,
         previousSourceSha256=sha(folder/'image.png'),referenceSha256=sha(ROOT/job['reference']),
         generatedSource=str(Path(args.image).resolve()),status='registering'))
    finish(job,dest)
    before=read(folder/'qa.json');after=read(dest/'qa.json')
    ratio=after['paintedFraction']/max(before['paintedFraction'],.0001)
    status='awaiting-whole-perimeter-review' if ratio>=.9 else 'coverage-regression'
    evidence=read(dest/'provenance.json');evidence.update(status=status,coverageRatio=round(ratio,4));write(dest/'provenance.json',evidence)
    spec=importlib.util.spec_from_file_location('cards',ROOT/'scripts/atlas-v2-production-cards.py')
    cards=importlib.util.module_from_spec(spec);spec.loader.exec_module(cards)
    panels=[]
    for label,path in [('Before',folder/'overlay.webp'),('Repair candidate',dest/'overlay.webp')]:
        panels.append(dict(job,image=path,art=dict(title=label+' · '+job['name'],x=job['x'],y=job['y'])))
    cards.draw_card(dest/'comparison.jpg',panels)
    print(json.dumps(dict(stage=str(dest.relative_to(ROOT)),status=status,coverageRatio=round(ratio,4))))

def promote(args):
    dest=Path(args.stage).resolve();meta=read(dest/'provenance.json');id=meta['id'];folder=BATCH/'jobs'/id
    if not dest.is_relative_to(REPAIRS):raise ValueError('Not a staged edge repair')
    review=read(dest/'review.json');qa=read(dest/'qa.json')
    required={'top','right','bottom','left','internalOpenings','accessConnections','basemapContinuations','coverageAndScale'}
    if review.get('status')!='pass' or set(review.get('checks',{}))!=required or not all(review['checks'].values()):
        raise ValueError('Whole-perimeter evidence is required for all eight checks')
    if review.get('overlaySha256')!=qa['sha256'] or qa['sha256']!=sha(dest/'overlay.webp'):
        raise ValueError('Review is not for these exact pixels')
    if meta['coverageRatio']<.9:raise ValueError('Repair lost more than 10% of useful coverage; redraw locally')
    with (BATCH.parent/'city-context/master.lock').open('a') as master, (BATCH/'publication.lock').open('a') as publication:
        fcntl.flock(master,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(publication,fcntl.LOCK_EX)
        receipt=read(folder/'production.json');job=read(folder/'dispatch.json')
        if sha(folder/'overlay.webp')!=meta['previousOverlaySha256'] or sha(folder/'image.png')!=meta['previousSourceSha256']:
            raise ValueError('Artwork changed during repair; preserve newer edition')
        if sha(ROOT/job['reference'])!=meta['referenceSha256']:raise ValueError('Map reference changed during repair')
        old_url=f"/atlas-v2/production/{id}-{meta['previousOverlaySha256'][:16]}.webp"
        if decisions().get(old_url)=='rejected':raise ValueError('Edition was rejected during repair; do not silently restore its slot')
        archive=folder/'revisions'/('whole-perimeter-'+str(time.time_ns()));archive.mkdir(parents=True)
        for name in ['image.png','overlay.webp','qa.json','result.json','production.json','dispatch.json']:
            link_or_copy(folder/name,archive/name)
        result=read(folder/'result.json');result.update(source='built-in imagegen whole-perimeter repair',sha256=qa['imageSha256'])
        with Image.open(dest/'image.png') as im:result.update(width=im.width,height=im.height)
        if sha(dest/'image.png')!=qa['imageSha256']:raise ValueError('Source image changed after registration')
        receipt.update(sourceSha256=qa['imageSha256'],overlaySha256=qa['sha256'],finished=int(time.time()),edgeRepairOf=meta['previousOverlaySha256'])
        qa['edgeReview']=dict(status='whole-perimeter-reviewed',review=str((dest/'review.json').relative_to(ROOT)),previousOverlaySha256=meta['previousOverlaySha256'])
        for name in ['image.png','overlay.webp']:
            temp=folder/(name+'.repair-tmp');temp.unlink(missing_ok=True);link_or_copy(dest/name,temp);os.replace(temp,folder/name)
        write(folder/'qa.json',qa);write(folder/'result.json',result);write(folder/'production.json',receipt)
        meta.update(status='installed',newOverlaySha256=qa['sha256']);write(dest/'provenance.json',meta)
        ledger_path=BATCH.parent/'edge-audit/repair-ledger.json';ledger=read(ledger_path)
        ledger[id].update(state='repaired-awaiting-editorial-review',previousSha256=meta['previousOverlaySha256'],sha256=qa['sha256'],
                          previousUrl=old_url,url=f"/atlas-v2/production/{id}-{qa['sha256'][:16]}.webp",stage=str(dest.relative_to(ROOT)))
        write(ledger_path,ledger)
    print(json.dumps(dict(id=id,sha256=qa['sha256'],status='installed; publish contact cards next')))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='action',required=True)
    prepare=sub.add_parser('stage');prepare.add_argument('id');prepare.add_argument('--image',required=True);prepare.add_argument('--expected-sha',required=True)
    install=sub.add_parser('promote');install.add_argument('stage')
    args=parser.parse_args();stage(args) if args.action=='stage' else promote(args)
