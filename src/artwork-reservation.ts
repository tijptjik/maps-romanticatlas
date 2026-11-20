import site from '../releases/sources/peak-maquette/site.json'

type Footprint = { x: number; y: number; columns?: number; rows?: number }

export function overlapsPeakMaquette(art: Footprint) {
  return art.x < site.x + site.columns && art.x + (art.columns ?? 1) > site.x &&
    art.y > site.y - site.rows && art.y - (art.rows ?? 1) < site.y
}

export function allowsArtwork(art: Footprint & { url: string }) {
  return !overlapsPeakMaquette(art) || (
    art.url === site.image && art.x === site.x && art.y === site.y &&
    (art.columns ?? 1) === site.columns && (art.rows ?? 1) === site.rows
  )
}
