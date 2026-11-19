// HSBC Main Building, basemap buildings feature 35184667496179 in z15/26775/14302.
// Its mapped exterior encloses approximately 3,723 square metres.
export const minimumSkyscraperAreaM2 = 3723

export function skyscraperFootprintAreaM2(tileY: number, zoom: number, exterior: number[][], holes: number[][][] = [], spansNorthernTile = false) {
  const count = 2 ** zoom
  const metresPerTile = 40075016.68557849 / (count * Math.cosh(Math.PI * (1 - 2 * (tileY + 0.5) / count)))
  const area = (ring: number[][]) => {
    if (ring.length < 3 || !ring.every(([x,y]) => Number.isFinite(x) && x >= 0 && x <= 1 &&
      Number.isFinite(y) && y >= (spansNorthernTile ? -1 : 0) && y <= 1)) {
      throw Error('Expected a complete mapped ring inside the mapped site')
    }
    return Math.abs(ring.reduce((sum, [x,y], i) => {
      const next = ring[(i+1) % ring.length]
      return sum + x*next[1] - y*next[0]
    }, 0)) / 2
  }
  return (area(exterior) - holes.reduce((sum, ring) => sum + area(ring), 0)) * metresPerTile ** 2
}
