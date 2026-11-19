import type { Map as AtlasMap } from 'maplibre-gl'

type Anchor = { lngLat: number[]; pixel: number[] }

export const hasCameraRegistration = (anchors: Anchor[] = []) => {
  if (anchors.length !== 3 || !anchors.every(anchor =>
    [anchor?.pixel, anchor?.lngLat].every(pair =>
      Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite)))) return false
  const [a, b, c] = anchors.map(anchor => anchor.pixel)
  return (b[0] - a[0]) * (c[1] - a[1]) !== (c[0] - a[0]) * (b[1] - a[1])
}

// Match three points at the feet of the illustrated building to their map
// positions. The artwork is already drawn in camera space.
export const installCameraPlate = (map: AtlasMap, url: string, anchors: Anchor[]) => {
  const image = document.createElement('img')
  image.className = 'study-camera-plate'
  image.alt = ''
  image.hidden = true
  image.src = url
  map.getCanvasContainer().append(image)
  const [origin, end, front] = anchors.map(a => a.pixel)
  const u = end[0] - origin[0], v = end[1] - origin[1]
  const s = front[0] - origin[0], t = front[1] - origin[1]
  const determinant = u * t - s * v
  const position = () => {
    if (image.hidden) return
    const [p, q, r] = anchors.map(({ lngLat }) => map.project([lngLat[0], lngLat[1]]))
    const a = ((q.x-p.x)*t - (r.x-p.x)*v) / determinant
    const b = ((q.y-p.y)*t - (r.y-p.y)*v) / determinant
    const c = ((r.x-p.x)*u - (q.x-p.x)*s) / determinant
    const d = ((r.y-p.y)*u - (q.y-p.y)*s) / determinant
    image.style.transform = `matrix(${a},${b},${c},${d},${p.x-a*origin[0]-c*origin[1]},${p.y-b*origin[0]-d*origin[1]})`
  }
  map.on('move', position)
  map.on('resize', position)
  map.once('remove', () => image.remove())
  return { image, setVisible(visible: boolean) { image.hidden = !visible; position() } }
}
