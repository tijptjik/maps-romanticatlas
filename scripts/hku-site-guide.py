"""Draw editable in-place architectural studies on the surveyed two-tile map."""
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw

source = Path('releases/sources')
batch = Path('generated-tiles/dream-atlas')
work = batch / 'hku-in-place'
work.mkdir(exist_ok=True)
site = json.loads((source / 'hku-footprint.json').read_text())
zoom, x, y = site['baseTile']
size = 1024
metres = 40075016.68557849 / (2**zoom * math.cosh(math.pi*(1-2*(y+.5)/2**zoom)))
# An unrotated map crop gives detail at the site and room for the tallest mast.
crop = (210, 45, 1006, 1349)
map_image = Image.new('RGB', (size, size*2))
for row in range(2):
    path = batch / 'references' / f'{zoom}-{x}-{y+row}.png'
    map_image.paste(Image.open(path), (0,row*size))
base = map_image.crop(crop)
base.save(work / 'map.png')
(work / 'frame.json').write_text(json.dumps(dict(crop=crop, tileSize=size))+'\n')

def point(x,y,z=0):
    return round(x*size-crop[0]), round((y-z*.6/metres)*size-crop[1])

for option in json.loads((source / 'hku-selection.json').read_text()):
    directory = work / option['slug'] / option.get('edition', '')
    directory.mkdir(parents=True, exist_ok=True)
    plate = base.copy()
    draw = ImageDraw.Draw(plate)
    ground = Image.new('L', base.size)
    survey = ImageDraw.Draw(ground)
    def ring(points,z):
        return [point(*v,z) for v in points]
    survey.polygon(ring(site['coordinatesInBaseTile'],0),fill=255)
    for hole in (site['holes'] if option['number'] == 6 else []):
        survey.polygon(ring(hole,0),fill=0)
    tint = Image.new('RGB',base.size,'#c49b72')
    plate.paste(tint,mask=ground)
    def volume(loop,lo,hi,roof,wall):
        # Retain plan shapes at height. Paint the frontmost wall last.
        edges=sorted(zip(loop,loop[1:]+loop[:1]), key=lambda edge: sum(p[1] for p in edge))
        for a,b in edges:
            draw.polygon([point(*a,lo),point(*b,lo),point(*b,hi),point(*a,hi)], fill=wall,outline='#66574a')
        draw.polygon(ring(loop,hi), fill=roof,outline='#66574a',width=2)
    def box(l,t,r,b,lo,hi,roof,wall):
        volume([(l,t),(r,t),(r,b),(l,b)],lo,hi,roof,wall)
    # Only the retained Horizon design keeps the four ground-level gardens.
    dz=round(4*.6/metres*size)
    for dy in range(dz,0,-1):
        plate.paste(tint,(0,-(dz-dy)),ground)
    plate.paste(Image.new('RGB',base.size,'#e1c2a0'),(0,-dz),ground)
    for hole in (site['holes'] if option['number'] == 6 else []):
        draw.line(ring(hole,4),fill='#705944',width=2)
        coords=ring(hole,0)
        cx=sum(a for a,b in coords[:-1])//(len(coords)-1)
        cy=sum(b for a,b in coords[:-1])//(len(coords)-1)
        draw.ellipse((cx-9,cy-7,cx+9,cy+7),fill='#819567',outline='#54734f')
    h=option['heightMetres']
    n=option['number']
    if n==6:
        for i,(a,b) in enumerate([(.625,.757),(.674,.765),(.636,.81),(.68,.809)]):
            z=h-i*12
            box(a-.007,b-.007,a+.007,b+.007,4,z-2,'#9e9274','#9e9274')
            volume([(a-.044,b),(a-.012,b-.027),(a+.032,b-.014),(a+.009,b+.029)],z-2,z,'#bcd3d1','#678c91')
    elif n==16:
        volume(site['coordinatesInBaseTile'],0,12,'#c2b8a1','#a49783')
        box(.375,.765,.924,.866,12,h,'#bdb19e','#a1917e')
        box(.375,.87,.413,1.201,12,17,'#c9beaa','#ab9f8c')
        box(.881,.87,.923,1.201,12,17,'#c9beaa','#ab9f8c')
        basin=[(.43,.902),(.55,.91),(.62,.963),(.69,.94),(.742,.912),(.866,.899),
               (.867,1.14),(.78,1.12),(.712,1.14),(.62,1.125),(.53,1.15),(.43,1.17)]
        draw.polygon(ring(basin,12),fill='#709f9e',outline='#716f61',width=3)
    elif n==20:
        volume(site['coordinatesInBaseTile'],0,14,'#b2a491','#998976')
        for i in range(3):
            t=.759+i*.155
            z=h-i*34
            box(.377,t,.923,t+.141,14,z,'#cdbca0','#b59579')
            for j in range(7):
                left=.382+j*.072
                box(left,t+.01,left+.061,t+.077,z,z+8+j%3,
                    ['#a3a58b','#bb9986','#beb19a'][j%3],'#9a8c78')
    elif n==21:
        volume(site['coordinatesInBaseTile'],0,5,'#c7b39b','#a79176')
        for i in range(30):
            angle=(28+i*10)*math.pi/180
            end=angle+math.pi/18
            width=.07+.017*math.sin(angle)
            loop=[(.655+rx*math.cos(v),.986+ry*math.sin(v))
                  for rx,ry,v in [(.275,.213,angle),(.275,.213,end),
                      (.275-width,.213-width,end),(.275-width,.213-width,angle)]]
            volume(loop,5,23+(h-23)*(1-i/30),'#b5ae98','#a18e7c')
        box(.588,.941,.699,1.013,5,6,'#8fa7a1','#b7ad94')
    elif n==22:
        volume(site['coordinatesInBaseTile'],0,9,'#c2ae91','#a68d75')
        for i in range(19):
            t=.757+i*.024
            z=h*(.69+.23*math.sin(i*math.pi/18))
            rib=[point(.373+j*.018,t,9+z*math.sin(math.pi*j/30)**.82*(.65+j/60))
                 for j in range(31)]
            if i < 9:
                back=[(x,y-23) for x,y in rib]
                draw.polygon(back+rib[::-1],fill='#75948a',outline='#58766e')
            draw.line(rib, fill='#a78953',width=4)
    else:
        raise ValueError('Missing massing guide for '+option['slug'])
    plate.save(directory / 'guide.png')
