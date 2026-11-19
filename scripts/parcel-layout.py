"""Plan a north-up tile layout from captured open ground and export registered artwork."""
import argparse
import base64
import io
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from atlas_scene_layers import compose_layers

parser = argparse.ArgumentParser()
parser.add_argument("--tile", required=True)
parser.add_argument("--captures", type=Path, required=True)
parser.add_argument("--tile-pixels", type=int, required=True)
parser.add_argument("--reference", type=Path)
parser.add_argument("--render", type=Path)
parser.add_argument("--output", type=Path)
parser.add_argument("--composition", type=Path, help="Study manifest containing per-tile scene layers")
args = parser.parse_args()
composition = None
if args.composition:
    tiles = json.loads(args.composition.read_text())["tiles"]
    tile = next(t for t in tiles if f"{t['x']}-{t['y']}" == args.tile)
    composition = tile["composition"]
    args.captures = Path(composition["captures"])

if bool(args.render) != bool(args.output):
    parser.error("--render and --output must be supplied together")
captures = json.loads(args.captures.read_text())
capture = next((c["highResolution"] for c in captures
                if f"{c['tile']['x']}-{c['tile']['y']}" == args.tile), None)
if capture is None:
    raise ValueError(f"No capture for {args.tile}")


def decode(field, mode):
    data = base64.b64decode(capture[field].split(",", 1)[1])
    return np.asarray(Image.open(io.BytesIO(data)).convert(mode))


base = decode("sourceImage", "RGB")
ground = np.zeros(base.shape[:2], dtype=np.uint8)
for color in [(234, 213, 171), (167, 174, 124), (217, 201, 151)]:
    ground |= np.all(base == color, axis=2).astype("uint8")
# Older captures predate the vector footprint mask. The building layer uses a
# translucent terracotta fill, so its rendered colour varies with the ground.
if "buildingMask" in capture:
    buildings = decode("buildingMask", "RGBA")[:, :, 3] >= 128
else:
    buildings = np.zeros(base.shape[:2], dtype=bool)
    for color in [(201, 144, 117), (195, 147, 117), (201, 146, 117),
                  (183, 159, 120), (217, 178, 143), (202, 148, 119),
                  (208, 161, 129), (204, 152, 122)]:
        buildings |= np.all(base == color, axis=2)
ground |= buildings.astype("uint8")
ground &= (decode("safeMask", "RGBA")[:, :, 3] == 255)
ground &= (decode("lineOverlay", "RGBA")[:, :, 3] == 0)
# Set back from the mapped boundaries. Opening removes unworkably narrow
# corridors while preserving the actual outline of each courtyard or field.
unit = base.shape[1] / 1024


def disk(radius):
    diameter = 2 * max(1, round(radius * unit)) + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (diameter, diameter))


clear = cv2.erode(ground, disk(5), borderType=cv2.BORDER_CONSTANT, borderValue=0)
usable = cv2.morphologyEx(clear, cv2.MORPH_OPEN, disk(12))
_, labels, stats, _ = cv2.connectedComponentsWithStats(usable)
parts = sorted(range(1, len(stats)), key=lambda i: -stats[i, cv2.CC_STAT_AREA])
plan = np.zeros_like(ground)
regions = []
for i in parts:
    area = int(stats[i, cv2.CC_STAT_AREA])
    if area < ground.size * 0.006:
        break
    plan[labels == i] = 1
    x, y, w, h = map(int, stats[i, :4])
    regions.append(dict(bounds=[x, y, w, h], area=area, buildingPixels=int(np.count_nonzero(buildings[labels == i]))))
regions.sort(key=lambda r: (r["buildingPixels"], r["area"]), reverse=True)
if not regions and (args.reference or args.render):
    raise ValueError("No substantial drawable parcel")
report = dict(tile=args.tile, capturePixels=base.shape[1], regions=regions,
              usableFraction=round(float(plan.mean()), 5),
              buildingFraction=round(float(np.mean((plan > 0) & buildings)), 5),
              reclaimedConnectors=capture.get("reclaimedConnectors", 0))
if args.reference:
    # The underlying map is the guide. Saturated cyan shows the drawable ground.
    guide = base.copy()
    guide[plan > 0] = (146, 218, 207)
    guide[(plan > 0) & buildings] = (56, 198, 165)
    if "projectionMask" in capture:
        guide[decode("projectionMask", "RGBA")[:, :, 3] > 0] = (232, 169, 60)
        guide[decode("mooringMask", "RGBA")[:, :, 3] > 0] = (57, 152, 208)
    Image.fromarray(guide).save(args.reference)
if args.render:
    size = args.tile_pixels
    raw = Image.open(args.render).convert("RGB")
    if raw.size != (size, size):
        raise ValueError(f"Expected native {size}-pixel tile, got {raw.size}")
    allowed = cv2.resize(plan, (size, size), interpolation=cv2.INTER_NEAREST).astype(bool)
    if composition and composition["base"] == "empty":
        artwork = Image.new("RGBA", (size, size))
        report["registeredIslands"] = 0
    else:
        rgb = np.asarray(raw).astype("float32")
        r, g, b = rgb.transpose(2, 0, 1)
        matte = np.clip((np.minimum(r, b) - g - 12) / 210, 0, 1)
        alpha = 1 - matte
        clean = np.clip((rgb - matte[:, :, None] * [255, 0, 255])
                        / np.maximum(alpha[:, :, None], .001), 0, 255)
        # Export in original map coordinates. Restrict the plate to its actual
        # parcel polygons, retaining the protected network and water through holes.
        report["outsideBeforeMaskFraction"] = round(float(alpha[~allowed].sum() / max(alpha.sum(), 1)), 5)
        # Match each generated island to the parcel it actually overlaps. Fit the
        # silhouette locally, including on top of existing building footprints.
        target = cv2.resize(labels, (size, size), interpolation=cv2.INTER_NEAREST)
        n, islands, boxes, _ = cv2.connectedComponentsWithStats((alpha * 255 >= 1).astype("uint8"))
        pixels = np.zeros((size, size, 4), dtype="uint8")
        occupied = np.zeros_like(allowed)
        registered = 0
        for index in sorted(range(1, n), key=lambda k: -boxes[k, cv2.CC_STAT_AREA]):
            sx, sy, sw, sh, area = boxes[index]
            if area < size * size * .001:
                continue
            island = islands[sy:sy+sh, sx:sx+sw] == index
            hits = target[sy:sy+sh, sx:sx+sw][island & allowed[sy:sy+sh, sx:sx+sw]]
            if len(hits) < area * .45:
                continue
            label = np.bincount(hits).argmax()
            available = ((target == label) & allowed & ~occupied).astype("uint8")
            tx, ty, tw, th = cv2.boundingRect(available)
            if not tw or not th:
                continue
            patch = available[ty:ty+th, tx:tx+tw]
            # Keep changes local and preserve the drawn aspect ratio. Matching the
            # actual alpha silhouette accommodates diagonal lots and interior holes.
            shrink = min(tw / sw, th / sh, 1)
            rgba = np.dstack([clean[sy:sy+sh, sx:sx+sw],
                              255 * alpha[sy:sy+sh, sx:sx+sw] * island]).astype("uint8")
            source = Image.fromarray(rgba)
            # Reserve a coarse search cell around holes and parcel edges. Accept
            # a placement only if the complete resampled alpha fits at native size.
            inset = cv2.erode(patch, disk(4), borderType=cv2.BORDER_CONSTANT, borderValue=0)
            thumb = cv2.resize(inset.astype("float32"), (max(1, tw//4), max(1, th//4)), interpolation=cv2.INTER_AREA)
            for scale in np.arange(shrink, shrink * .35, -.025):
                w, h = max(1, round(sw * scale)), max(1, round(sh * scale))
                mw, mh = max(1, round(w * thumb.shape[1] / tw)), max(1, round(h * thumb.shape[0] / th))
                shape = cv2.resize(island.astype("float32"), (mw, mh), interpolation=cv2.INTER_AREA)
                overlap = cv2.matchTemplate(thumb, shape, cv2.TM_CCORR)
                _, peak, _, _ = cv2.minMaxLoc(overlap)
                if peak < shape.sum() * .995:
                    continue
                rows, cols = np.nonzero(overlap >= peak - .1)
                xs = tx + np.minimum(tw-w, np.rint(cols * tw / thumb.shape[1]).astype(int))
                ys = ty + np.minimum(th-h, np.rint(rows * th / thumb.shape[0]).astype(int))
                nearest = np.argmin((xs + w/2 - sx - sw/2)**2 + (ys + h/2 - sy - sh/2)**2)
                x, y = xs[nearest], ys[nearest]
                art = np.asarray(source.resize((w, h), Image.Resampling.LANCZOS))
                visible = art[:, :, 3] > 0
                if np.all(available[y:y+h, x:x+w][visible]):
                    break
            else:
                continue
            pixels[y:y+h, x:x+w][visible] = art[visible]
            occupied[y:y+h, x:x+w] |= visible
            registered += 1
        report["registeredIslands"] = registered
        report["protectedOverlapPixels"] = int(np.count_nonzero(pixels[:, :, 3][~allowed]))
        filled = pixels[:, :, 3] >= 128
        report["artworkFraction"] = round(float(filled.mean()), 5)
        report["usableGroundFilled"] = round(float(filled.sum() / allowed.sum()), 5)
        if not filled.any():
            raise ValueError("Empty tile")
        artwork = Image.fromarray(pixels)
    if composition:
        report.update(compose_layers(artwork, composition["layers"], decode))
        report["registeredIslands"] += len(composition["layers"])
        report["usableGroundFilled"] = round(float(((np.asarray(artwork)[:, :, 3] >= 128) & allowed).sum() / allowed.sum()), 5)
    if capture.get("roadCleanup"):
        cleanup = Image.fromarray(decode("roadCleanup", "RGBA")).resize((size, size), Image.Resampling.NEAREST)
        cleanup.alpha_composite(artwork)
        artwork = cleanup
    artwork.save(args.output, lossless=True)
print(json.dumps(report))
