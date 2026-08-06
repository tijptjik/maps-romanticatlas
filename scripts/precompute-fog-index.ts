export {}

const origin = (process.env.ATLAS_FOG_INDEX_ORIGIN ?? 'https://romanticatlas.hype.hk')
  .replace(/\/$/, '')
const defaultBounds = [113.75, 22.1, 114.5, 22.6]
const requestedBounds = process.env.ATLAS_FOG_INDEX_BOUNDS
  ?.split(',')
  .map(Number)
const concurrency = Math.max(1, Math.min(16, Number(process.env.ATLAS_FOG_INDEX_CONCURRENCY ?? 4)))
const zoom = 15
const deploymentPropagationDelayMs = 2_000
const requestAttempts = Math.max(
  1,
  Math.min(10, Number(process.env.ATLAS_FOG_INDEX_REQUEST_ATTEMPTS ?? 5)),
)
const requestRetryDelayMs = 1_000

const wait = (milliseconds: number) =>
  new Promise<void>(resolve => setTimeout(resolve, milliseconds))

const isRetryableStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500

const retryDelay = (attempt: number) => requestRetryDelayMs * 2 ** (attempt - 1)

if (
  requestedBounds &&
  (requestedBounds.length !== 4 || requestedBounds.some(value => !Number.isFinite(value)))
) {
  throw new Error(
    'ATLAS_FOG_INDEX_BOUNDS must be west,south,east,north (for example 113.75,22.1,114.5,22.6).',
  )
}

const [west, south, east, north] = requestedBounds ?? defaultBounds
if (west < -180 || east > 180 || west >= east || south < -85 || north > 85 || south >= north) {
  throw new Error('The fog-index bounds are outside valid longitude/latitude ranges.')
}

const tileX = (longitude: number) =>
  Math.floor(((longitude + 180) / 360) * (2 ** zoom))
const tileY = (latitude: number) =>
  Math.floor(
    ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
      (2 ** zoom),
  )

const minimumX = tileX(west)
const maximumX = tileX(east)
const minimumY = tileY(north)
const maximumY = tileY(south)
const tiles = [] as Array<{ x: number; y: number }>
for (let y = minimumY; y <= maximumY; y += 1) {
  for (let x = minimumX; x <= maximumX; x += 1) tiles.push({ x, y })
}

let completed = 0
let cacheVersion: string | undefined
const start = performance.now()
const warm = async () => {
  while (tiles.length) {
    const tile = tiles.shift()
    if (!tile) return
    let response: Response | undefined
    for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
      try {
        response = await fetch(`${origin}/api/fog-index/${zoom}/${tile.x}/${tile.y}`)
      } catch (error) {
        if (attempt === requestAttempts) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `Fog index ${zoom}/${tile.x}/${tile.y} timed out or could not be requested after ${requestAttempts} attempts: ${detail}`,
          )
        }
        console.warn(
          `Fog index ${zoom}/${tile.x}/${tile.y} request failed; retrying in ${retryDelay(attempt)}ms (${attempt}/${requestAttempts}).`,
        )
        await wait(retryDelay(attempt))
        continue
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json') && !isRetryableStatus(response.status)) break
      if (attempt === requestAttempts) {
        throw new Error(
          contentType.includes('application/json')
            ? `Fog index ${zoom}/${tile.x}/${tile.y} failed with HTTP ${response.status} after ${requestAttempts} attempts.`
            : `Fog index ${zoom}/${tile.x}/${tile.y} did not return JSON (${contentType || 'no content-type'}). ` +
              `Deploy the Worker containing /api/fog-index before warming ${origin}.`,
        )
      }
      const delay = contentType.includes('application/json')
        ? retryDelay(attempt)
        : deploymentPropagationDelayMs
      console.warn(
        `Fog index ${zoom}/${tile.x}/${tile.y} returned ${
          contentType.includes('application/json') ? `HTTP ${response.status}` : contentType || 'no content-type'
        }; retrying in ${delay}ms (${attempt}/${requestAttempts}).`,
      )
      await wait(delay)
    }
    if (!response) throw new Error(`Fog index ${zoom}/${tile.x}/${tile.y} was not requested.`)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        body?.error ?? `Fog index ${zoom}/${tile.x}/${tile.y} failed with HTTP ${response.status}.`,
      )
    }
    if (!Array.isArray(body?.eligibility) || body.eligibility.length !== 64) {
      throw new Error(`Fog index ${zoom}/${tile.x}/${tile.y} returned an incomplete eligibility tile.`)
    }
    if (cacheVersion && cacheVersion !== body.version) {
      throw new Error('The basemap release changed while the fog index was being precomputed.')
    }
    cacheVersion = body.version
    completed += 1
    console.log(`Fog index ${completed}/${(maximumX - minimumX + 1) * (maximumY - minimumY + 1)}: ${zoom}/${tile.x}/${tile.y}`)
  }
}

await Promise.all(Array.from({ length: concurrency }, warm))
console.log(
  `Precomputed ${completed} z${zoom} fog indexes for ${cacheVersion ?? 'an unknown version'} in ${Math.round(performance.now() - start)}ms.`,
)
