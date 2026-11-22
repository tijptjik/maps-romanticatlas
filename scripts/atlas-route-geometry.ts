const n = 2 ** 18
const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n)
const tileY = (lat: number) =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) * n) / 2)
type Position = [number, number]
export type Tile = { x: number; y: number; region: string; options: number }
export const coordinate = (x: number, y: number): Position => [
  ((x + 0.5) / n) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI,
]
// Southern edge follows Kennedy Town, the HKU campus and the downhill streets
// through Sheung Wan, Central, Wan Chai and Causeway Bay. Northern edge tracks
// the shoreline including the Central waterfront and ends inside Victoria Park.
export const island: Position[] = [
  [114.118, 22.28],
  [114.126, 22.281],
  [114.132, 22.283],
  [114.135, 22.282],
  [114.141, 22.282],
  [114.145, 22.285],
  [114.15, 22.2835],
  [114.156, 22.2817],
  [114.163, 22.2777],
  [114.172, 22.2748],
  [114.181, 22.2755],
  [114.1902, 22.2805],
  [114.1919, 22.2844],
  [114.187, 22.286],
  [114.181, 22.285],
  [114.176, 22.285],
  [114.171, 22.2846],
  [114.166, 22.2835],
  [114.16, 22.2875],
  [114.154, 22.29],
  [114.143, 22.293],
  [114.133, 22.293],
  [114.125, 22.2875],
  [114.118, 22.285],
]
export const west: Position[] = [
  [114.148, 22.296],
  [114.1628, 22.296],
  [114.167, 22.309],
  [114.169, 22.322],
  [114.166, 22.333],
  [114.16, 22.339],
  [114.147, 22.342],
  [114.135, 22.341],
  [114.136, 22.333],
  [114.145, 22.327],
  [114.145, 22.317],
]
export const mongKok: Position[] = [
  [114.167, 22.314],
  [114.1745, 22.314],
  [114.176, 22.325],
  [114.1685, 22.325],
]
export const tst: Position[] = [
  [114.1678, 22.2917],
  [114.1785, 22.2917],
  [114.181, 22.3017],
  [114.166, 22.303],
]
export const contains = ([lon, lat]: Position, shape: Position[]) => {
  let inside = false
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [a, b] = shape[i],
      [c, d] = shape[j]
    if (b > lat !== d > lat && lon < ((c - a) * (lat - b)) / (d - b) + a)
      inside = !inside
  }
  return inside
}
export function serpentine(shape: Position[], region: string) {
  const xs = shape.map(p => tileX(p[0])),
    ys = shape.map(p => tileY(p[1]))
  const rows: Tile[] = []
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
    const strip: Tile[] = []
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      if (contains(coordinate(x, y), shape)) strip.push({ x, y, region, options: 1 })
    }
    rows.push(...(x % 2 ? strip.reverse() : strip))
  }
  return rows
}
