"""Build a parcel guide from a genuine z18 plate and register a generated overlay."""
import hashlib
import json
import os
import math
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from atlas_scene_layers import keyed_image


ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024
REFILL_MIN_PARCEL_OCCUPANCY = .40
LAND = [(234, 213, 171), (167, 174, 124), (217, 201, 151), (201, 144, 117), (158, 102, 87)]


def _replace(path, writer):
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=path.suffix, delete=False) as file:
        temporary = Path(file.name)
    try:
        writer(temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _disk(radius):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))


def _layout(job, minor_pockets=(), *, all_pockets=False):
    path = ROOT / job['reference']
    with Image.open(path) as image:
        if image.width != image.height or image.width < 512:
            raise ValueError(f'Invalid z18 reference plate: {path}')
        base = np.asarray(image.convert('RGB').resize((SIZE, SIZE), Image.Resampling.NEAREST))
    # dream-atlas-reference.ts uses this opaque palette and retains the road
    # network after short eligible connectors have been reclaimed. Keep building
    # footprints, courts and parks available as connected work sites.
    ground = np.zeros(base.shape[:2], np.uint8)
    for color in LAND:
        ground |= cv2.inRange(base, np.maximum(np.array(color)-4,0), np.minimum(np.array(color)+4,255))
    # Bridge only the hairline strokes between eaves and their own ground.
    ground = cv2.morphologyEx(ground, cv2.MORPH_CLOSE, _disk(3))
    road = cv2.inRange(base, (238,227,197), (255,247,217))
    road = cv2.dilate(road, _disk(2))
    water = cv2.inRange(base, (117,151,152), (133,167,168))
    if job.get('waterfront'):
        # The live waterfront compositor permits continuous gangways above a
        # shoreline or quay road. Keep offshore water and the 5% frame open.
        distance = cv2.distanceTransform((water != 0).astype('uint8'),cv2.DIST_L2,5)
        usable = distance <= SIZE*.5
        margin = math.ceil(SIZE*.05)
        usable[:margin] = usable[-margin:] = usable[:,:margin] = usable[:,-margin:] = False
        return base,usable,road != 0,water != 0
    ground[(road != 0) | (water != 0)] = 0
    ground[:8] = ground[-8:] = ground[:, :8] = ground[:, -8:] = 0
    ground = cv2.morphologyEx(ground, cv2.MORPH_OPEN, _disk(5))
    _, labels, stats, _ = cv2.connectedComponentsWithStats(ground)
    substantial = stats[:, cv2.CC_STAT_AREA] >= (200 if all_pockets else .003 * ground.size)
    # Some junctions contain small, real working islands. A registration may
    # use one for a secondary object whose original drawing landed there.
    # The guide and historical occupancy measures use only substantial sites.
    for x,y in minor_pockets:
        i=labels[y,x]
        if not i or stats[i,cv2.CC_STAT_AREA]<200:
            raise ValueError('Invalid supplementary pocket on the genuine tile')
        substantial[i]=True
    substantial[0] = False
    usable = substantial[labels]
    if usable.mean() < .045:
        raise ValueError(f'Insufficient drawable ground on registered plate {path.name} ({usable.mean():.1%})')
    return base, usable, road != 0, water != 0


def prepare(job, work_dir):
    """Return the registered guide to pass alongside the genuine map."""
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    base, usable, _, water = _layout(job)
    if job.get('waterfront'):
        guide = np.full_like(base,(255,0,255))
        guide[usable & ~water] = (118,180,134)
        guide[usable & water] = (91,164,209)
        guide_y, guide_x = np.nonzero(usable)
        contours, _ = cv2.findContours(usable.astype('uint8'), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour = max(contours, key=cv2.contourArea)
        outline = cv2.approxPolyDP(contour, .003 * SIZE, True)
        boundary = ''
        if not cv2.isContourConvex(outline):
            points = ', '.join(f'({x*100/SIZE:.1f}%, {y*100/SIZE:.1f}%)'
                               for x,y in outline[:,0])
            boundary = (
                f' The main usable area is concave: its boundary follows {points}, then closes. '
                'Coordinates are across and down from the top left; the coloured guide is exact. '
                'Respect every inward corner, including all decking, lower supports and stairs. '
                'An outer wing must turn inward before the magenta cutout, not bridge across it. '
                'Reallocate that wing to the broad interior instead of shrinking the entire complex.'
            )
        shore = usable & ~water & cv2.dilate((usable & water).astype('uint8'), _disk(3)).astype(bool)
        shore_y, shore_x = np.nonzero(shore)
        landing = ''
        if len(shore_x):
            mid = len(shore_x)//2
            landing = (f' Put a continuous land-to-water landing near '
                       f'({shore_x[mid]*100/SIZE:.0f}% across, {shore_y[mid]*100/SIZE:.0f}% down), '
                       'on the actual green-blue boundary. Carry a broad working deck across that '
                       'boundary; a detached boat or separate waterfront ornament does not connect the site. ')
        def centre(mask):
            ys,xs = np.nonzero(mask)
            if not len(xs):
                return 'at the edge of the site'
            return f'near ({xs.mean()*100/SIZE:.0f}% across, {ys.mean()*100/SIZE:.0f}% down)'
        job['coastalPlacement'] = (
            f"The green land entrance is {centre(usable & ~water)}. The blue working decks belong "
            f"{centre(usable & water)}. These centres are measured from the top left. Fit the facility to "
            "the actual sloping junction between these colours. Use the width of both zones, bringing the "
            "main platform right up to the land entrance. Put open sea channels between platforms. "
            "Use broad green land for the scene's substantial shore activities and connected courts, "
            "not only a narrow path along the water. Spread the main experience across land and water. "
            "Keep every part including fittings inside the coloured zones. Do not paint lines from the map. "
            "The blue guide marks buildable water, not a colour to reproduce. Leave exposed sea and "
            "open channels uniform magenta for the original basemap to show through. Do not paint "
            "a blue water patch, wash or halo beneath boats or around piers; gain coverage with "
            "real working surfaces rather than painted background. "
            "Give the working decks substantial front-to-back depth as well as width. Aim for actual "
            "painted surfaces across three quarters of the coloured guide; the bounding box of a tall "
            "tower does not count as occupied ground. Extend complete workshops, handling decks and "
            "public working areas into the unused depth, with narrow open water channels between them. "
            "Where the guide has broad blue areas in both its upper and lower halves, distribute "
            "connected activity decks through both halves instead of leaving the upper half empty "
            "and crowding a single foreground pier against the bottom or right edge. Lay out the "
            "complete deck network inside the guide first, then place small buildings and fittings "
            "within it; preserve the measured street and shoreline positions. "
            f"The entire painted silhouette fits between {guide_x.min()*100/SIZE:.0f}% and "
            f"{(guide_x.max()+1)*100/SIZE:.0f}% across, and between {guide_y.min()*100/SIZE:.0f}% "
            f"and {(guide_y.max()+1)*100/SIZE:.0f}% down, inside the actual coloured outline. "
            "These limits include the highest lantern, finial, mast and flag, not just the foundations. "
            "They also include every detached boat, sail, bow, stern, oar and wake. Keep floating "
            "craft completely inside the blue guide, with clear water around their full silhouettes; "
            "do not place decorative boats in the magenta margin. "
            "Move tall elements toward the foreground or lower their height so their tops remain "
            "inside the guide. Keep the working decks broad rather than shrinking the whole facility."
        ) + landing + boundary
        path = work_dir/'guide.png'
        _replace(path,Image.fromarray(guide).save)
        return path
    image = Image.fromarray(base)
    # Distinct teal values and a warm route halo make a narrow cross-lane
    # legible at the worker's thumbnail scale. Only this second attachment
    # exaggerates the separator. The genuine plate and fitting mask stay exact.
    _, labels, stats, _ = cv2.connectedComponentsWithStats(usable.astype(np.uint8))
    inset = cv2.erode(usable.astype(np.uint8), _disk(4)).astype(bool)
    palette = np.array([(46,160,151),(105,191,173),(38,137,140),
                        (109,201,189),(53,172,161)],dtype=np.float32)
    colours = palette[(labels-1)%len(palette)]
    tinted = base*.42 + colours*.58
    guide = np.asarray(Image.blend(image, Image.new('RGB',image.size,'#fff3df'),.48)).copy()
    guide[usable & ~inset]=[253,239,204]
    guide[inset]=tinted[inset].astype(np.uint8)
    if 'keyedGuide' in job and len(stats)-1 >= 6:
        # Multiple narrow frontages are easiest to preserve when the worker
        # receives the exact final street-shaped gaps in its edit template.
        job['keyedGuide'] = True
    if job.get('keyedGuide'):
        # Provide the generator with its actual output background on redraws.
        # Preserve the pocket coordinates; the first attachment still carries
        # the streets, coastline and original neighbouring architecture.
        chosen = sorted(range(1,len(stats)),key=lambda i:stats[i,cv2.CC_STAT_AREA],reverse=True)[:8]
        guide[:]=[255,0,255]
        reserve=cv2.erode(usable.astype('uint8'),_disk(8)).astype(bool)
        mask=reserve & np.isin(labels,chosen)
        if mask.mean() < min(.10, .75 * usable.mean()):
            # Narrow coastal sites need their whole frontage to host a legible scene.
            mask=inset if inset.sum() >= .72 * usable.sum() else usable
        redraw_count = len(list((work_dir/'revisions').glob('*/image.png')))
        if redraw_count >= 3 and len(chosen) > 4 and not job.get('refillReview'):
            # Thin, parallel waterfront strips can merge in successive drawings.
            # Keep the largest four sites when they provide ample working area.
            broad_sites = mask & np.isin(labels,chosen[:4])
            if broad_sites.sum() >= max(.60 * mask.sum(), .07 * SIZE**2):
                mask = broad_sites
        if redraw_count >= 2 or (job.get('refillReview') and redraw_count):
            # A single court can wrap around a cul-de-sac. A painted plinth
            # enclosing that hole is very sensitive to small generator drift.
            # On repeated redraws show several independently placeable groups
            # inside the same court, with room for whole eaves and entrances.
            separated = mask.copy()
            for label in chosen:
                pocket = mask & (labels == label)
                # Long curved frontages can occupy less than 12% of the tile
                # yet still produce one rigid, unplaceable crescent. On late
                # retries give these sites independent working pads too.
                minimum_pocket = .04 if redraw_count >= 4 else .12
                if pocket.sum() < minimum_pocket * SIZE**2:
                    continue
                depth = cv2.distanceTransform(pocket.astype('uint8'), cv2.DIST_L2, 5)
                seeds = np.zeros_like(labels)
                yy,xx = np.ogrid[:SIZE,:SIZE]
                for index in range(1,5):
                    _,radius,_,(cx,cy) = cv2.minMaxLoc(depth)
                    if radius < (24 if redraw_count >= 4 else 35):
                        break
                    seeds[cy,cx] = index
                    depth[(xx-cx)**2+(yy-cy)**2 < max(130,radius*1.6)**2] = 0
                if seeds.max() < 2:
                    continue
                _,zones = cv2.distanceTransformWithLabels((seeds==0).astype('uint8'),
                             cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
                zones = zones.astype('uint8')
                seams = cv2.morphologyEx(zones,cv2.MORPH_GRADIENT,_disk(8)) != 0
                separated[pocket & seams] = False
            mask = separated
        if redraw_count >= 5:
            # Tiny leftover islands repeatedly attract whole buildings that
            # cannot fit. Prefer the substantial working pads on late retries;
            # this changes only the guide, never the surveyed fitting mask.
            _, pads, pad_stats, _ = cv2.connectedComponentsWithStats(mask.astype('uint8'))
            substantial = np.flatnonzero(pad_stats[:, cv2.CC_STAT_AREA] >= .015 * SIZE**2)
            substantial = substantial[substantial != 0]
            broad = mask & np.isin(pads, substantial)
            if broad.sum() >= .85 * mask.sum():
                mask = broad
        if redraw_count >= 5 and usable.mean() < .12:
            # Repeatedly merged slivers need individual level working pads. A
            # chain of pads follows a diagonal pier without turning it into one
            # rigid sprite whose placement depends on both distant endpoints.
            for label in chosen:
                pocket = mask & (labels == label)
                ys,xs = np.nonzero(pocket)
                if len(xs) < 300:
                    continue
                if len(xs) < 2400:
                    mask[pocket] = False
                    continue
                points = np.column_stack((xs,ys))
                _,axes = np.linalg.eigh(np.cov(points.T))
                along = points @ axes[:,-1]
                count = max(1,round(np.ptp(along)/125))
                for split in np.linspace(along.min(),along.max(),count+1)[1:-1]:
                    gap = np.abs(along-split) < 5
                    mask[ys[gap],xs[gap]] = False
        correction = work_dir/'revision.txt'
        if correction.is_file() and 'source frame' in correction.read_text():
            # Give the generator an unmistakable exterior margin on edge
            # redraws. Registration still uses the exact surveyed parcels.
            margin = SIZE//32
            mask[:margin] = mask[-margin:] = mask[:, :margin] = mask[:, -margin:] = False
            job['drawing'] += (' End every pipe, cable, rail and path belonging to the work inside '
                               'its coloured pocket. Show its cap, return bend or landing. Keep the '
                               'outer magenta band uninterrupted on all four sides, including corners.')
        guide[mask]=tinted[mask].astype(np.uint8)
    guide=Image.fromarray(guide)
    path = work_dir / 'guide.png'
    _replace(path, guide.save)
    return path


def working_pockets(job):
    """Describe the widest usable parts of this particular site in image coordinates."""
    _, usable, _, _ = _layout(job)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(usable.astype('uint8'))
    choices = sorted(range(1,len(stats)), key=lambda i: stats[i,cv2.CC_STAT_AREA], reverse=True)
    pockets = []
    for i in choices[:4]:
        x,y,w,h,area = stats[i]
        if area < .018 * SIZE**2:
            continue
        shape = (labels[y:y+h,x:x+w] == i).astype('uint8')
        depths = cv2.distanceTransform(cv2.copyMakeBorder(shape,1,1,1,1,cv2.BORDER_CONSTANT,value=0),cv2.DIST_L2,5)
        _,radius,_,(cx,cy) = cv2.minMaxLoc(depths)
        pockets.append(f"({(x+cx-1)*100/SIZE:.0f}% across, {(y+cy-1)*100/SIZE:.0f}% down; {radius*200/SIZE:.0f}% clear width)")
    return ", ".join(pockets)


def _source(path):
    with Image.open(path) as image:
        if image.width != image.height or image.width < 512:
            raise ValueError('A square full-resolution painting is required')
        if 'A' in image.getbands() and np.mean(np.asarray(image.getchannel('A')) < 16) > .025:
            layer = image.convert('RGBA')
        else:
            sample = np.array(image.convert('RGB').resize((128,128)), dtype=np.int16)
            r,g,b = sample.transpose(2,0,1)
            if np.mean((np.minimum(r,b)-g > 125) & (r>170) & (b>170)) < .025:
                raise ValueError('Painting needs a transparent or uniform magenta exterior')
            layer = keyed_image(path, crop=False)
    layer = layer.resize((SIZE,SIZE), Image.Resampling.LANCZOS)
    alpha = np.asarray(layer.getchannel('A'))
    if np.any(np.r_[alpha[0], alpha[-1], alpha[:,0], alpha[:,-1]] > 96):
        raise ValueError('Paint reaches the source frame; redraw complete object endings inside it')
    return layer


def _place(sprite, origin, available):
    """Translate and uniformly scale a whole painted group without cutting pixels."""
    x,y,w,h = cv2.boundingRect(available)
    local = available[y:y+h,x:x+w]
    left,top = origin
    initial = min(1, w/sprite.width, h/sprite.height)
    start = np.array(origin) + np.array(sprite.size)/2
    # Render first at the original scale. Correct small registration errors with
    # translation before reducing size. Nearby placement keeps entrances local.
    for scale in np.arange(initial, .41, -.03):
        sw,sh = max(1,round(sprite.width*scale)),max(1,round(sprite.height*scale))
        art = sprite if (sw,sh)==sprite.size else sprite.resize((sw,sh), Image.Resampling.LANCZOS)
        shape = np.asarray(art.getchannel('A')) > 0
        if scale == 1 and x<=left and y<=top and left+sw<=x+w and top+sh<=y+h:
            site=local[top-y:top-y+sh,left-x:left-x+sw]
            if site[shape].all():
                return art,(int(left),int(top)),float(scale)
        # Narrow junction islands can have just one legal pixel translation.
        # Subsampling by four used to skip those exact placements entirely.
        if local.size<90000 and shape.size<30000:
            loss=cv2.matchTemplate((1-local).astype(np.float32),shape.astype(np.float32),cv2.TM_CCORR)
            ys,xs=np.where(loss<.25)
            if len(xs):
                distances=(x+xs+sw/2-start[0])**2+(y+ys+sh/2-start[1])**2
                k=distances.argmin()
                dx,dy=xs[k],ys[k]
                if distances[k]<=(.16*SIZE)**2 and local[dy:dy+sh,dx:dx+sw][shape].all():
                    return art,(int(x+dx),int(y+dy)),float(scale)
            continue
        # Four-pixel search followed by a native-resolution silhouette check.
        small = cv2.resize(local.astype('float32'), ((w+3)//4,(h+3)//4),interpolation=cv2.INTER_AREA)
        thumb = cv2.resize(shape.astype('float32'), ((sw+3)//4,(sh+3)//4),interpolation=cv2.INTER_AREA)
        loss = cv2.matchTemplate(1-small,thumb,cv2.TM_CCORR)
        ys,xs = np.where(loss < max(4., .001 * thumb.sum()))
        xs=np.minimum(xs*4,w-sw)
        ys=np.minimum(ys*4,h-sh)
        dist=(x+xs+sw/2-start[0])**2+(y+ys+sh/2-start[1])**2
        for k in np.argsort(dist)[:150]:
            if dist[k] > (.16*SIZE)**2:
                break
            dx,dy=xs[k],ys[k]
            if local[dy:dy+sh,dx:dx+sw][shape].all():
                return art,(int(x+dx),int(y+dy)),float(scale)
    def percent(values):
        return [round(v*100/SIZE) for v in values]
    original = percent([left,top,left+sprite.width,top+sprite.height])
    parcel = percent([x,y,x+w,y+h])
    raise ValueError(f'The connected painted group at {original}% crosses incompatible parcels. '
                     f'Its main pocket is {parcel}% (left, top, right, bottom). '
                     'Split the activity into independently finished objects in the guide pockets; '
                     'carry clear magenta through each intervening street.')


def _painted_objects(alpha):
    # Lanczos can bridge a real gap with a 1/255-opacity ringing fringe.
    # Find separate painted cores first, then return their antialiased outlines
    # to the nearest core. The original RGBA values are used for composition.
    core = (alpha > 4).astype(np.uint8)
    count, labels, boxes, _ = cv2.connectedComponentsWithStats(core)
    if count == 1:
        raise ValueError('No painted object on the keyed layer')
    distance, nearest = cv2.distanceTransformWithLabels(1-core, cv2.DIST_L2, 5,
                                                       labelType=cv2.DIST_LABEL_CCOMP)
    group = np.zeros(nearest.max()+1, np.int32)
    group[nearest[core != 0]] = labels[core != 0]
    objects = group[nearest]
    objects[(alpha == 0) | (distance > 4)] = 0
    for k,(x,y,w,h,_) in enumerate(boxes[1:].copy(),1):
        left,top = max(0,x-5),max(0,y-5)
        select = (objects[top:y+h+5,left:x+w+5] == k).astype(np.uint8)
        dx,dy,width,height = cv2.boundingRect(select)
        boxes[k] = [left+dx,top+dy,width,height,int(select.sum())]
    return objects, boxes


def _reviewed_crossing(work_dir, job, image_sha, reference_sha):
    path=Path(work_dir)/'reviewed-crossing.json'
    if not path.exists():
        return None
    evidence=json.loads(path.read_text())
    if (evidence['tile']!=[job['z'],job['x'],job['y']] or evidence['imageSha256']!=image_sha or
            evidence['referenceSha256']!=reference_sha):
        return None
    if evidence['kind']!='pedestrian-arrival' or not evidence['inspection']:
        raise ValueError('Missing inspected pedestrian crossing evidence')
    return evidence


def _crossing_digest(alpha,road):
    return hashlib.sha256(np.packbits((alpha>0)&road).tobytes()).hexdigest()


def _placed_group(raw,objects,ids,available):
    selected=np.isin(objects,ids)
    x,y,w,h=cv2.boundingRect(selected.astype(np.uint8))
    pixels=raw[y:y+h,x:x+w].copy()
    pixels[~selected[y:y+h,x:x+w]]=0
    return _place(Image.fromarray(pixels),(x,y),available)


def _plot_placements(raw,objects,ids,boxes,available):
    combined=None
    try:
        combined=_placed_group(raw,objects,ids,available)
    except ValueError:
        if len(ids)==1:
            raise
    if combined is not None and combined[2]>=.85:
        return [combined]
    # Several separate working courts can share one connected land parcel
    # around a dead-end lane. Keep satellites with their nearest major object
    # and try an independent layout before shrinking the whole district.
    masses=sorted(ids,key=lambda k:boxes[k,4],reverse=True)
    # A pier landing can be a complete workstation on a very small parcel.
    # Keep its people and fittings attached when placing the workstations.
    main_area=max(min(6000, .025*available.sum()), boxes[masses[0],4]*.12)
    mains=[k for k in masses if boxes[k,4]>=main_area]
    if len(mains)>=2:
        groups={k:[k] for k in mains}
        for k in set(ids)-set(mains):
            x,y,w,h,_=boxes[k]
            cx,cy=x+w/2,y+h/2
            def distance(i):
                px,py,pw,ph,_=boxes[i]
                return max(px-cx,cx-px-pw,0)**2+max(py-cy,cy-py-ph,0)**2
            groups[min(mains,key=distance)].append(k)
        free=available.copy()
        placements=[]
        for k in mains:
            try:
                pic,(x,y),scale=_placed_group(raw,objects,groups[k],free)
            except ValueError:
                break
            free[y:y+pic.height,x:x+pic.width][np.asarray(pic.getchannel('A'))>0]=0
            placements.append((pic,(x,y),scale))
        if len(placements)==len(mains) and (combined is None or
                sum(np.count_nonzero(np.asarray(p)[:,:,3]>127) for p,_,_ in placements)>
                np.count_nonzero(np.asarray(combined[0])[:,:,3]>127)*1.06):
            return placements
    if combined is None:
        return [_placed_group(raw,objects,ids,available)]
    return [combined]


class UnplacedObject(ValueError):
    pass


def _minor_sites(job,raw,major):
    # Count only entire originally detached objects, never stray strokes of
    # long buildings, as evidence of intent to use a small surveyed island.
    _,all_ground,_,_=_layout(job,all_pockets=True)
    _,small,_,_=cv2.connectedComponentsWithStats((all_ground & ~major).astype(np.uint8))
    objects,boxes=_painted_objects(raw[:,:,3])
    centres=set()
    for k,(x,y,w,h,area) in enumerate(boxes[1:],1):
        if area<100:
            continue
        mask=objects[y:y+h,x:x+w]==k
        if np.any(major[y:y+h,x:x+w][mask]):
            continue
        seen=small[y:y+h,x:x+w]
        hits=np.bincount(seen[mask],minlength=2)[1:]
        idx=int(hits.argmax())+1
        if hits[idx-1]<max(30,area*.04):
            continue
        yy,xx=np.nonzero((seen==idx)&mask)
        centres.add((int(x+xx[0]),int(y+yy[0])))
    return sorted(centres)


def _detached_placement(raw,objects,k,box,plots,available):
    """Find a modest translation to a nearby free frontage; preserve its silhouette."""
    x,y,w,h,area=box
    left,top=max(0,x-32),max(0,y-32)
    candidates=np.unique(plots[top:y+h+32,left:x+w+32])
    best=None
    for label in candidates:
        if not label:continue
        free=(plots==label)&available
        if np.count_nonzero(free)<area*.5:continue
        try:
            pic,(dx,dy),scale=_placed_group(raw,objects,[k],free.astype(np.uint8))
        except ValueError:
            continue
        movement=math.hypot(dx+pic.width/2-x-w/2,dy+pic.height/2-y-h/2)
        if scale<.7 or movement>min(72,max(27,math.hypot(w,h)*.75)):continue
        score=scale-movement/300
        if best is None or score>best[0]:best=(score,pic,(dx,dy),scale)
    if best is None:
        raise UnplacedObject(f'Detached object at [{x},{y},{w},{h}] px has no plausible whole-object placement. '
                             'Place this complete secondary operation within a marked parcel beside the street.')
    return best[1:]


def _register(raw,usable):
    plot_count, plots, _, _ = cv2.connectedComponentsWithStats(usable.astype(np.uint8))
    objects, boxes = _painted_objects(raw[:,:,3])
    groups = {}
    detached=[]
    for k,(x,y,w,h,area) in enumerate(boxes[1:],1):
        if area < 4:
            continue
        pixels = objects[y:y+h,x:x+w] == k
        hits = np.bincount(plots[y:y+h,x:x+w][pixels], minlength=plot_count)[1:]
        if hits.max()==0:
            detached.append(k)
        else:
            groups.setdefault(int(hits.argmax())+1,[]).append(k)
    if not groups:
        raise ValueError('Painting has no identifiable working site on registered ground')
    # Attach small nearby details (e.g. a railing finial) to their painted group.
    # A substantial island entirely off-site requires another generation.
    separate=[]
    if detached:
        memberships = np.zeros(len(boxes), np.int32)
        for group, ids in groups.items():
            memberships[ids] = group
        occupied = memberships[objects]
        distance, nearest = cv2.distanceTransformWithLabels((occupied == 0).astype(np.uint8),
                            cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_CCOMP)
        to_group = np.zeros(nearest.max()+1, np.int32)
        locations = occupied != 0
        to_group[nearest[locations]] = occupied[locations]
        for k in detached:
            x,y,w,h,area = boxes[k]
            obj = objects[y:y+h,x:x+w] == k
            gaps = np.where(obj,distance[y:y+h,x:x+w],np.inf)
            dy,dx = np.unravel_index(gaps.argmin(), gaps.shape)
            if area > 500 or gaps[dy,dx] > 24:
                if area < 24:
                    continue
                separate.append(k)
                continue
            group = to_group[nearest[y+dy,x+dx]]
            groups[group].append(k)
    overlay = Image.new('RGBA',(SIZE,SIZE))
    scales=[]
    for group,ids in groups.items():
        try:
            placements=_plot_placements(raw,objects,ids,boxes,(plots==group).astype(np.uint8))
        except ValueError:
            # A diagonal lane can split a drawing between a long narrow strip
            # and a broad neighbouring island. Pixel overlap alone favours the
            # strip even when the intact silhouette fits only the other island.
            silhouette=np.isin(objects,ids)
            hits=np.bincount(plots[silhouette],minlength=plot_count)
            for alternative in np.argsort(hits)[::-1]:
                if not alternative or alternative in groups or hits[alternative]<.15*silhouette.sum():
                    continue
                free=(plots==alternative)&(np.asarray(overlay.getchannel('A'))==0)
                try:
                    placements=[_placed_group(raw,objects,ids,free.astype(np.uint8))]
                    break
                except ValueError:
                    continue
            else:
                raise
        for sprite,pos,scale in placements:
            overlay.alpha_composite(sprite,pos)
            scales.append(scale)
    for k in sorted(separate,key=lambda i:-boxes[i,4]):
        available=usable & (np.asarray(overlay.getchannel('A'))==0)
        pic,pos,scale=_detached_placement(raw,objects,k,boxes[k],plots,available)
        overlay.alpha_composite(pic,pos)
        scales.append(scale)
    return overlay,scales


def finish(job, work_dir):
    """Write a verified lossless overlay.webp and qa.json. Raise on redraw failures."""
    work_dir=Path(work_dir)
    source=work_dir/'image.png'
    _,usable,road,water=_layout(job)
    image_sha=_digest(source)
    reference_sha=_digest(ROOT/job['reference'])
    raw=np.asarray(_source(source))
    crossing=_reviewed_crossing(work_dir,job,image_sha,reference_sha)
    allowed=usable.copy()
    minor_sites=[]
    if crossing:
        overlay=Image.new('RGBA',(SIZE,SIZE))
        overlay.alpha_composite(Image.fromarray(raw),tuple(crossing['translation']))
        scales=[1.]
        l,t,r,b=crossing['bounds']
        allowed[t:b,l:r]|=road[t:b,l:r]
    else:
        try:
            overlay,scales=_register(raw,usable)
        except ValueError:
            minor_sites=_minor_sites(job,raw,usable)
            if not minor_sites:raise
            _,allowed,_,_=_layout(job,minor_sites)
            overlay,scales=_register(raw,allowed)
    alpha=np.asarray(overlay.getchannel('A'))
    solid=alpha>127
    coverage=float(solid.mean())
    use=float(solid.sum()/usable.sum())
    source_coverage=float(np.count_nonzero(raw[:,:,3]>127)/solid.size)
    retention=coverage/max(source_coverage,1e-6)
    if usable.mean()>.5 and source_coverage>.35 and retention<.48 and use<.3:
        raise ValueError(f'The subject lost most of its painted area during registration ({retention:.0%} retained). '
                         'Spread whole working groups over their matching pockets and give both sides of each lane clear access.')
    minimum_use = REFILL_MIN_PARCEL_OCCUPANCY if job.get('refillReview') else .14
    if job.get('waterfront'):
        try:
            check_waterfront(solid,usable,road,water)
        except ValueError as error:
            raise ValueError(
                f'{error} The original drawing painted {source_coverage:.1%} of the frame; '
                f'after fitting complete objects inside the surveyed guide it occupies {coverage:.1%}. '
                'Keep the full projected silhouette within the guide at drawing time, including '
                'roofs and deck supports, so fitting does not have to shrink the whole complex. '
                'Increase usable working surface inside that outline, not the size of its bounding box.'
            ) from error
    if coverage < .035 or use < minimum_use:
        raise ValueError(f'Underfilled composition: {coverage:.1%} of tile, {use:.1%} of workable parcels')
    if crossing and (_crossing_digest(alpha,road)!=crossing['roadMaskSha256'] or
                     np.count_nonzero(alpha[road])!=crossing['reviewedRoadPixels']):
        raise ValueError('Crossing differs from the inspected street pixels')
    if np.any((alpha>0)&~allowed):
        raise ValueError('Artwork obscures the protected network')
    bbox=overlay.getbbox()
    output=work_dir/'overlay.webp'
    _replace(output,lambda path:overlay.save(path,lossless=True,method=4))
    z = job.get('z',18)
    latitude = math.atan(math.sinh(math.pi*(1-2*(job['y']+.5)/2**z)))
    tile_metres = 40075016.69 * math.cos(latitude) / 2**z
    # Keep broad composition goals visible to reviewers; pixel counts cannot
    # establish the narrative, figure scale or whether access works in use.
    review_notes = []
    if coverage < .6 and use < .5:
        review_notes.append('Check whether the action can occupy more of the available parcels.')
    if min(scales) < .7:
        review_notes.append('Check the relative scale of people, furniture and paths after local registration.')
    receipt=dict(id=job['id'], tile=[job.get('z',18),job['x'],job['y']],
                 referenceSha256=reference_sha,imageSha256=image_sha,sha256=_digest(output),
                 paintedFraction=round(coverage,4),sourceCoverageRetained=round(retention,4),parcelOccupancy=round(use,4),
                 substantialGroundFraction=round(float(usable.mean()),4),groupScales=scales,
                 outerClearance=[bbox[0],bbox[1],SIZE-bbox[2],SIZE-bbox[3]],
                 coveredRoadPixels=int(np.count_nonzero(alpha[road])),
                 coveredWaterPixels=int(np.count_nonzero(alpha[water])),
                 expectedAdultHeightAt1024=round(1.7*.6*SIZE/tile_metres,2),
                 visualReview='pending', reviewNotes=review_notes)
    if minor_sites:receipt['supplementaryPockets']=minor_sites
    if crossing:receipt['reviewedPedestrianCrossing']=crossing
    _replace(work_dir/'qa.json',lambda path:path.write_text(json.dumps(receipt,indent=2)+'\n'))
    return output


def check_waterfront(solid,usable,road,water):
    wet = usable & water
    dry = usable & ~water & ~road
    _, groups = cv2.connectedComponents(solid.astype('uint8'))
    wet_counts = np.bincount(groups[wet],minlength=groups.max()+1)[1:]
    dry_counts = np.bincount(groups[dry],minlength=groups.max()+1)[1:]
    if wet.sum() > .01*solid.size and not np.any(
        (wet_counts >= max(16,.12*wet.sum())) & (dry_counts >= min(80,max(1,.02*dry.sum())))
    ):
        painted_wet=np.count_nonzero(solid & wet)/max(1,wet.sum())
        raise ValueError(f'Artwork covers {painted_wet:.1%} of the blue water zone, but no single '
                         'shore-connected group meets the waterfront requirement. Extend one broad '
                         'piled or floating working deck across at least one quarter of the blue zone '
                         'and join it continuously to a land entrance with a visible gangway. '
                         'Widen the landing at the green-blue boundary; detached boats do not count.')
    if wet.sum() > .05*solid.size and np.count_nonzero(wet & ~solid) < .05*wet.sum():
        raise ValueError('Keep open water channels around the ends and between the waterfront working decks.')
    if solid.sum() < min(.45*solid.size,.65*usable.sum()):
        target=min(.45,.65*usable.mean())
        raise ValueError(f'The registered waterfront occupies only {solid.mean():.1%} of the tile; '
                         f'it needs at least {target:.1%}. Broaden the working decks and add complete '
                         'shore-connected activity areas inside the guide, keeping open water channels '
                         'and the outer margin. Remove copied road outlines and map-line fragments; '
                         'the background must remain plain magenta between finished structures.')
