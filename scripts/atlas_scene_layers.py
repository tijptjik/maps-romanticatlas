"""Place separate ground, architectural and maritime cutouts against registered masks."""
import cv2
import numpy as np
from PIL import Image


def keyed_image(path, crop=True):
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype="float32")
    r, g, b = rgb.transpose(2, 0, 1)
    matte = np.clip((np.minimum(r, b) - g - 12) / 210, 0, 1)
    alpha = 1 - matte
    clean = np.clip((rgb - matte[:, :, None] * [255, 0, 255])
                    / np.maximum(alpha[:, :, None], .001), 0, 255)
    # The generated chroma field can contain very faint compression noise.
    alpha[alpha < .09] = 0
    _, components, stats, _ = cv2.connectedComponentsWithStats((alpha > 0).astype("uint8"))
    keep = stats[:, cv2.CC_STAT_AREA] >= 12
    keep[0] = False
    alpha[~keep[components]] = 0
    image = Image.fromarray(np.dstack([clean, alpha * 255]).astype("uint8"))
    return image.crop(image.getbbox()) if crop else image


def fit_layer(layer, size, allowed, ground):
    sprite = keyed_image(layer["source"])
    cx, bottom = np.array(layer["baseCenter"]) * size
    # Search near the intended berth or footprint, keeping the largest feasible
    # whole silhouette. Coarse matching proposes locations; native alpha decides.
    step = 4
    reduced = lambda mask: cv2.resize(mask.astype("float32"), None, fx=1/step, fy=1/step,
                                       interpolation=cv2.INTER_AREA)
    search = reduced(cv2.erode(allowed.astype("uint8"), np.ones((7, 7), "uint8")))
    safe_ground = reduced(ground)
    for fraction in np.arange(layer["width"], layer["width"] * .54, -.0125):
        width = round(fraction * size)
        height = round(width * sprite.height / sprite.width)
        if height > size:
            continue
        image = sprite.resize((width, height), Image.Resampling.LANCZOS)
        shape = np.asarray(image)[:, :, 3] > 0
        pattern = reduced(shape)
        # For a tower, each occupied image column has its own foot. A roof
        # over a street is allowed only with solid ground directly to its south.
        support = np.zeros_like(shape)
        cols = np.flatnonzero(shape.any(axis=0))
        support[height - 1 - shape[::-1, cols].argmax(axis=0), cols] = True
        loss = cv2.matchTemplate(1-search, pattern, cv2.TM_CCORR)
        if layer["role"] == "building":
            loss += cv2.matchTemplate(1-safe_ground, reduced(support), cv2.TM_CCORR)
        rows, xs = np.nonzero(loss < .05)
        xs, ys = xs * step, rows * step
        distance = (xs + width / 2 - cx)**2 + (ys + height - bottom)**2
        for k in np.argsort(distance):
            if distance[k] > (.15 * size)**2:
                break
            x, y = xs[k], ys[k]
            if x + width > size or y + height > size:
                continue
            if not allowed[y:y+height, x:x+width][shape].all():
                continue
            if layer["role"] == "building" and not ground[y:y+height, x:x+width][support].all():
                continue
            return image, (int(x), int(y))
    raise ValueError(f"No whole, supported placement for {layer['source']}")


def compose_layers(artwork, layers, decode):
    size = artwork.width
    def mask(key):
        pixels = decode(key, "RGBA")[:, :, 3]
        return cv2.resize(pixels, (size, size), interpolation=cv2.INTER_NEAREST) == 255
    ground = mask("safeMask")
    projection = mask("projectionMask")
    mooring = mask("mooringMask")
    footprints = mask("buildingMask")
    lines = mask("lineOverlay")
    # Draw a new tower behind existing foreground buildings which stand closer
    # to the south camera. Reuse their original alpha so the street and roof
    # edges are visible through the gaps between objects.
    base = np.array(artwork)
    _, component, boxes, _ = cv2.connectedComponentsWithStats((base[:, :, 3] > 0).astype("uint8"))
    front_y = (boxes[:, cv2.CC_STAT_TOP] + boxes[:, cv2.CC_STAT_HEIGHT])[component]
    placements = []
    for layer in layers:
        role = layer["role"]
        allowed = {"yard": ground, "building": ground | projection, "vessel": mooring, "quay": mask("deckMask")}[role]
        image, (x, y) = fit_layer(layer, size, allowed, ground & footprints)
        if role == "building":
            foreground = (base[:, :, 3] > 0) & (front_y > y + image.height)
            # Split the original base into back and front layers. Alpha-compose
            # each pixel once, including antialiased edges.
            front = base.copy()
            front[~foreground] = 0
            back = np.array(artwork)
            back[foreground] = 0
            artwork.paste(Image.fromarray(back))
            artwork.alpha_composite(image, (x,y))
            artwork.alpha_composite(Image.fromarray(front))
        else:
            artwork.alpha_composite(image, (x,y))
        region = np.s_[y:y+image.height, x:x+image.width]
        visible = np.asarray(image)[:, :, 3] >= 128
        placements.append(dict(role=role, bounds=[x,y,image.width,image.height],
                               occludedLinePixels=int((visible & lines[region]).sum()),
                               mooringPixels=int((visible & mooring[region]).sum())))
    alpha = np.asarray(artwork)[:, :, 3]
    return dict(placements=placements, artworkFraction=round(float((alpha >= 128).mean()), 5),
                protectedOverlapPixels=int(((alpha != 0) & ~(ground | projection | mooring)).sum()))
