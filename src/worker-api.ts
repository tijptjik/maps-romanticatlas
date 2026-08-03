import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon/workerd'
import { atlasSeaScenes, atlasSceneNames, atlasScenes } from './atlas-scenes.ts'

const atlasZoom = 18
const atlasTileSize = 512
const generationVersion = 4
const readableCacheVersions = [2, 3, 4] as const
const maximumRequestBytes = 12_000_000
const maximumImageBytes = 4_000_000
const openrouterApiUrl = 'https://openrouter.ai/api/v1/chat/completions'
const atlasColourDirection = 'Keep the surrounding map and its Victorian-brown palette unchanged. Within the event, use a lively, carefully balanced storybook palette with warm parchment and sandy cream foundations, plus clear accents of cobalt blue, coral vermilion, marigold yellow, leafy sage green, dusty rose, and soft lilac. Keep the colours richly pigmented, crisp, and pleasantly contrasty so the event stands out, while remaining slightly softened and paper-printed rather than neon, fluorescent, garish, or oversaturated.'

type Scene = keyof typeof atlasScenes
type Tile = { scene: Scene; zoom: number; x: number; y: number }
type AtlasEnv = Env & { ATLAS_ADMIN_TOKEN?: string; ATLAS_LOCAL_DEV?: string }
type ContentBounds = { x: number; y: number; width: number; height: number } | null
type CachedTile = {
  tile: Tile
  version: number
  contentType: string
  contentBounds: ContentBounds
  imageKey: string
  metadataKey: string
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  })

const errorResponse = (status: number, error: string, headers?: Record<string, string>) =>
  json({ error }, status, headers)

const bearerToken = (request: Request) => {
  const value = request.headers.get('authorization')
  return value?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null
}

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

const hmac = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

const adminTokenIsValid = async (request: Request, env: AtlasEnv) => {
  const configuredToken = env.ATLAS_ADMIN_TOKEN?.trim()
  const suppliedToken = bearerToken(request)
  if (!configuredToken || !suppliedToken) return false
  const expected = await hmac(configuredToken, configuredToken)
  const actual = await hmac(configuredToken, suppliedToken)
  return constantTimeEqual(expected, actual)
}

const cookieValue = (request: Request, name: string) =>
  request.headers.get('cookie')
    ?.split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null

const csrfCookieName = 'atlas_csrf'
const csrfToken = async (secret: string) => {
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = [...nonceBytes].map(value => value.toString(16).padStart(2, '0')).join('')
  const signature = [...await hmac(secret, nonce)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  return `${nonce}.${signature}`
}

const csrfTokenIsValid = async (token: string | null, secret: string | undefined) => {
  if (!token || !secret) return false
  const match = token.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/)
  if (!match) return false
  const expected = await hmac(secret, match[1])
  const actual = Uint8Array.from(match[2].match(/../g) ?? [], value => Number.parseInt(value, 16))
  return constantTimeEqual(expected, actual)
}

const adminRequestIsAllowed = (request: Request, env: AtlasEnv, requireOrigin = false) => {
  return (!requireOrigin || Boolean(request.headers.get('origin'))) &&
    isAllowedApplicationRequest(request, env)
}

const tileKey = (tile: Tile, version = generationVersion) =>
  `atlas/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}.v${version}`

const imageKey = (tile: Tile, version = generationVersion) => `${tileKey(tile, version)}.image`
const metadataKey = (tile: Tile, version = generationVersion) => `${tileKey(tile, version)}.json`

const tileUrl = (tile: Tile, version: number) =>
  `/generated-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}?version=${version}`

const randomItem = <T>(items: T[]) => {
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  return items[random[0] % items.length]
}

const parseTilePath = (pathname: string): Tile | null => {
  const match = pathname.match(/^\/api\/atlas-tiles\/(\d+)\/(\d+)\/(\d+)\/([^/]+)$/)
  if (!match) return null
  const [, zoom, x, y, scene] = match
  const numericZoom = Number(zoom)
  const numericX = Number(x)
  const numericY = Number(y)
  const tileCount = 2 ** numericZoom
  if (
    numericZoom !== atlasZoom ||
    numericX < 0 ||
    numericY < 0 ||
    numericX >= tileCount ||
    numericY >= tileCount ||
    !atlasScenes[scene]
  ) return null
  return { scene: scene as Scene, zoom: numericZoom, x: numericX, y: numericY }
}

const parsePositionPath = (pathname: string) => {
  const match = pathname.match(/^\/api\/atlas-tiles\/cache-status\/(\d+)\/(\d+)\/(\d+)$/)
  if (!match) return null
  const [, zoom, x, y] = match
  const numericZoom = Number(zoom)
  const numericX = Number(x)
  const numericY = Number(y)
  const tileCount = 2 ** numericZoom
  if (
    numericZoom !== atlasZoom ||
    numericX < 0 ||
    numericY < 0 ||
    numericX >= tileCount ||
    numericY >= tileCount
  ) return null
  return { zoom: numericZoom, x: numericX, y: numericY }
}

const requestedVersion = (request: Request) => {
  const value = new URL(request.url).searchParams.get('version')
  if (value === null || !/^\d+$/.test(value)) return null
  const version = Number(value)
  return Number.isInteger(version) && version >= 1 && version <= generationVersion ? version : null
}

const normalizeContentBounds = (value: unknown): ContentBounds => {
  const candidate = value as Record<string, unknown> | null | undefined
  const x = Number(candidate?.x)
  const y = Number(candidate?.y)
  const width = Number(candidate?.width)
  const height = Number(candidate?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null

  const left = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(x)))
  const top = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(y)))
  const right = Math.max(left + 1, Math.min(atlasTileSize, Math.ceil(x + width)))
  const bottom = Math.max(top + 1, Math.min(atlasTileSize, Math.ceil(y + height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const readCachedTile = async (bucket: R2Bucket, tile: Tile, version: number) => {
  const imageObject = await bucket.head(imageKey(tile, version))
  if (!imageObject) return null
  const metadataObject = await bucket.get(metadataKey(tile, version))
  if (!metadataObject) return null
  try {
    const metadata = await metadataObject.json<{
      contentType?: string
      contentBounds?: unknown
    }>()
    return {
      tile,
      version,
      contentType: metadata.contentType ?? 'image/png',
      contentBounds: normalizeContentBounds(metadata.contentBounds),
      imageKey: imageKey(tile, version),
      metadataKey: metadataKey(tile, version),
    } satisfies CachedTile
  } catch {
    return null
  }
}

const getCachedTile = (bucket: R2Bucket, tile: Tile) =>
  readCachedTile(bucket, tile, generationVersion)

const getVersionedCachedTile = (bucket: R2Bucket, tile: Tile, version: number | null) =>
  version === null ? getCachedTile(bucket, tile) : readCachedTile(bucket, tile, version)

const findCachedTile = async (bucket: R2Bucket, position: Omit<Tile, 'scene'>) => {
  const candidates = await Promise.all(
    readableCacheVersions.flatMap(version =>
      atlasSceneNames.map(scene => readCachedTile(bucket, { ...position, scene }, version)),
    ),
  )
  const cached = candidates.filter((candidate): candidate is CachedTile => candidate !== null)
  return cached.length ? randomItem(cached) : null
}

const listCachedTiles = async (bucket: R2Bucket, requested: number | null = null) => {
  const latestVersions = new Map<string, { tile: Tile; version: number }>()
  let cursor: string | undefined
  do {
    const listing = await bucket.list({ prefix: `atlas/${atlasZoom}/`, cursor })
    for (const object of listing.objects) {
      const match = object.key.match(
        new RegExp(`^atlas/${atlasZoom}/(\\d+)/(\\d+)/(.+)\\.v(\\d+)\\.json$`),
      )
      if (!match) continue
      const [, x, y, scene, versionText] = match
      const version = Number(versionText)
      const numericX = Number(x)
      const numericY = Number(y)
      const tileCount = 2 ** atlasZoom
      if (!atlasScenes[scene] || version < 1 || version > generationVersion) continue
      if (numericX >= tileCount || numericY >= tileCount) continue
      const key = `${numericX}/${numericY}/${scene}`
      if (requested !== null && version !== requested) continue
      if (requested !== null || version > (latestVersions.get(key)?.version ?? 0)) {
        latestVersions.set(key, {
          tile: { scene: scene as Scene, zoom: atlasZoom, x: numericX, y: numericY },
          version,
        })
      }
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  const cached = await Promise.all(
    [...latestVersions.values()].map(({ tile, version }) =>
      readCachedTile(bucket, tile, version),
    ),
  )
  return cached.filter((entry): entry is CachedTile => entry !== null).map(entry => ({
    scene: entry.tile.scene,
    zoom: entry.tile.zoom,
    x: entry.tile.x,
    y: entry.tile.y,
    version: entry.version,
    url: tileUrl(entry.tile, entry.version),
    contentBounds: entry.contentBounds,
  }))
}

const atlasSceneGridRadius = 4
const atlasTileCount = 2 ** atlasZoom

const sceneGridPositions = (position: Omit<Tile, 'scene'>) => {
  const positions: Array<{ x: number; y: number }> = []
  for (let yOffset = -atlasSceneGridRadius; yOffset <= atlasSceneGridRadius; yOffset += 1) {
    const y = position.y + yOffset
    if (y < 0 || y >= atlasTileCount) continue
    for (let xOffset = -atlasSceneGridRadius; xOffset <= atlasSceneGridRadius; xOffset += 1) {
      positions.push({
        x: (position.x + xOffset + atlasTileCount) % atlasTileCount,
        y,
      })
    }
  }
  return positions
}

const cachedScenesInGrid = async (
  bucket: R2Bucket,
  position: Omit<Tile, 'scene'>,
) => {
  const sceneLists = await Promise.all(sceneGridPositions(position).map(async ({ x, y }) => {
    const scenes: Scene[] = []
    let cursor: string | undefined
    do {
      const listing = await bucket.list({ prefix: `atlas/${atlasZoom}/${x}/${y}/`, cursor })
      for (const object of listing.objects) {
        const match = object.key.match(new RegExp(`^atlas/${atlasZoom}/${x}/${y}/(.+)\\.v(\\d+)\\.json$`))
        const version = Number(match?.[2])
        const scene = match?.[1]
        if (scene && atlasScenes[scene] && readableCacheVersions.some(candidate => candidate === version)) {
          scenes.push(scene as Scene)
        }
      }
      cursor = listing.truncated ? listing.cursor : undefined
    } while (cursor)
    return scenes
  }))
  return [...new Set(sceneLists.flat())]
}

const imageDataUrl = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=]+)$/

const decodeDataUrl = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new Error(`${label} must be an image data URL.`)
  const match = value.match(imageDataUrl)
  if (!match) throw new Error(`${label} must be a PNG or JPEG data URL.`)
  const binary = atob(match[2])
  if (binary.length > maximumImageBytes) throw new Error(`${label} is too large.`)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return { bytes, contentType: match[1] }
}

const resizeToTile = (bytes: Uint8Array, label: string) => {
  const source = PhotonImage.new_from_byteslice(bytes)
  if (source.get_width() === atlasTileSize && source.get_height() === atlasTileSize) {
    return source
  }
  const resized = resize(source, atlasTileSize, atlasTileSize, SamplingFilter.Lanczos3)
  source.free()
  if (resized.get_width() !== atlasTileSize || resized.get_height() !== atlasTileSize) {
    resized.free()
    throw new Error(`${label} could not be resized to a 512px tile.`)
  }
  return resized
}

const blurMask = (input: Uint8Array) => {
  const radius = 5
  const size = atlasTileSize
  const horizontal = new Uint16Array(input.length)
  const output = new Uint8Array(input.length)

  for (let y = 0; y < size; y += 1) {
    let sum = 0
    for (let x = -radius; x <= radius; x += 1) {
      sum += input[y * size + Math.max(0, Math.min(size - 1, x))]
    }
    for (let x = 0; x < size; x += 1) {
      horizontal[y * size + x] = Math.round(sum / (radius * 2 + 1))
      const leaving = Math.max(0, x - radius)
      const entering = Math.min(size - 1, x + radius + 1)
      sum += input[y * size + entering] - input[y * size + leaving]
    }
  }

  for (let x = 0; x < size; x += 1) {
    let sum = 0
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.max(0, Math.min(size - 1, y)) * size + x]
    }
    for (let y = 0; y < size; y += 1) {
      output[y * size + x] = Math.round(sum / (radius * 2 + 1))
      const leaving = Math.max(0, y - radius)
      const entering = Math.min(size - 1, y + radius + 1)
      sum += horizontal[entering * size + x] - horizontal[leaving * size + x]
    }
  }
  return output
}

const composeTileImage = (
  sourceBytes: Uint8Array,
  generatedBytes: Uint8Array,
  safeMaskBytes: Uint8Array,
  lineOverlayBytes: Uint8Array,
) => {
  const source = resizeToTile(sourceBytes, 'The source image')
  const generated = resizeToTile(generatedBytes, 'The generated image')
  const mask = resizeToTile(safeMaskBytes, 'The safe-zone mask')
  const overlay = resizeToTile(lineOverlayBytes, 'The line overlay')

  try {
    const sourcePixels = source.get_raw_pixels()
    const generatedPixels = generated.get_raw_pixels()
    const maskPixels = mask.get_raw_pixels()
    const overlayPixels = overlay.get_raw_pixels()
    const safeAlpha = new Uint8Array(atlasTileSize * atlasTileSize)
    const lineAlpha = new Uint8Array(atlasTileSize * atlasTileSize)

    for (let pixel = 0, offset = 0; pixel < safeAlpha.length; pixel += 1, offset += 4) {
      safeAlpha[pixel] = Math.round((maskPixels[offset] * maskPixels[offset + 3]) / 255)
      lineAlpha[pixel] = overlayPixels[offset + 3]
    }

    const blurredAlpha = blurMask(safeAlpha)
    const outputPixels = new Uint8Array(sourcePixels.length)
    for (let pixel = 0, offset = 0; pixel < blurredAlpha.length; pixel += 1, offset += 4) {
      const generatedOpacity = (blurredAlpha[pixel] * generatedPixels[offset + 3]) / 65_025
      const sourceOpacity = 1 - generatedOpacity
      let red = sourcePixels[offset] * sourceOpacity + generatedPixels[offset] * generatedOpacity
      let green = sourcePixels[offset + 1] * sourceOpacity + generatedPixels[offset + 1] * generatedOpacity
      let blue = sourcePixels[offset + 2] * sourceOpacity + generatedPixels[offset + 2] * generatedOpacity
      const lineOpacity = lineAlpha[pixel] / 255
      red = red * (1 - lineOpacity) + overlayPixels[offset] * lineOpacity
      green = green * (1 - lineOpacity) + overlayPixels[offset + 1] * lineOpacity
      blue = blue * (1 - lineOpacity) + overlayPixels[offset + 2] * lineOpacity
      outputPixels[offset] = Math.round(red)
      outputPixels[offset + 1] = Math.round(green)
      outputPixels[offset + 2] = Math.round(blue)
      outputPixels[offset + 3] = 255
    }

    const result = new PhotonImage(outputPixels, atlasTileSize, atlasTileSize)
    const bytes = result.get_bytes()
    result.free()
    return bytes
  } finally {
    source.free()
    generated.free()
    mask.free()
    overlay.free()
  }
}

const atlasPrompt = (scene: Scene, hasSea: boolean) => {
  const seaRule = atlasSeaScenes.has(scene)
    ? hasSea
      ? 'The tile contains visible sea or coastal water; place this sea-side event beside that water and include a small amount of the sea within the tile.'
      : 'This tile does not contain visible sea or coastal water. Do not create the sea-side event; preserve the map unchanged.'
    : ''

  return `Create ${atlasScenes[scene]} across the permitted land in this complete single z18 map tile, leaving a 10% safety margin. The first image is the source map. The second image is a zoning guide: green areas are safe to transform, while red areas are locked and must remain unchanged. Use the guide as an instruction, not as artwork. Preserve the exact tile size, orientation, scale, coastline, water, roads, paths, boundaries, and labels. Treat every existing road and path as hard pixel-registered infrastructure: trace its original centerline exactly, keep every junction and curve in the same position, and do not cover it with buildings, scenery, texture, or event artwork. Do not invent, move, bend, widen, recolour, or erase any locked path or road, and do not draw road-like lines in the green areas. Do not add text, shadows, gradients, lighting, borders, frames, or tile-shaped background patches. Use a flat, planimetric, strict overhead view integrated into the existing cartography. ${atlasColourDirection} ${seaRule}`
}

const openrouterImage = async (env: Env, prompt: string, sourceImage: string, guideImage: string) => {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter is not configured for this deployment.')
  }
  const response = await fetch(openrouterApiUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'http-referer': env.ATLAS_ALLOWED_ORIGIN,
      'x-title': 'Visionary Machines Map',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL ?? 'openai/gpt-5.4-image-2',
      modalities: ['text', 'image'],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: sourceImage } },
          { type: 'image_url', image_url: { url: guideImage } },
        ],
      }],
    }),
  })
  if (!response.ok) {
    throw new Error(`OpenRouter image generation failed (${response.status}).`)
  }
  const result = await response.json() as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: string } }>
        content?: Array<{ image_url?: { url?: string } }>
      }
    }>
  }
  const message = result.choices?.[0]?.message
  const imageUrl = message?.images?.find(image => image.image_url?.url)?.image_url?.url ??
    message?.content?.find(image => image.image_url?.url)?.image_url?.url
  const parsed = decodeDataUrl(imageUrl, 'OpenRouter image')
  return parsed.bytes
}

const readJsonBody = async (request: Request) => {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maximumRequestBytes) throw new Error('The tile generation payload is too large.')
  if (!request.body) throw new Error('A JSON request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumRequestBytes) throw new Error('The tile generation payload is too large.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  chunks.forEach(chunk => {
    body.set(chunk, offset)
    offset += chunk.byteLength
  })
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
}

const isAllowedApplicationRequest = (request: Request, env: AtlasEnv) => {
  const allowedOrigin = env.ATLAS_ALLOWED_ORIGIN
  if (!allowedOrigin) return false
  const origin = request.headers.get('origin')
  const requestUrl = new URL(request.url)
  const allowedUrl = new URL(allowedOrigin)
  const isLocalHost = (host: string) => /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)
  const localDevelopment = env.ATLAS_LOCAL_DEV === 'true'
  // A Wrangler dev server is always loopback, even when its configured origin
  // is inherited from the production config. The production Worker cannot
  // receive a loopback request, so accepting loopback here does not weaken the
  // deployed host check.
  const hostMatches = requestUrl.host === allowedUrl.host ||
    (localDevelopment && (isLocalHost(requestUrl.host) || isLocalHost(allowedUrl.host)))
  const originMatches = !origin || origin === allowedOrigin ||
    (localDevelopment && (() => {
      try {
        return isLocalHost(new URL(origin).host)
      } catch {
        return false
      }
    })())
  return hostMatches && originMatches
}

const serveCachedTile = async (request: Request, env: Env, tile: Tile) => {
  const cached = await getVersionedCachedTile(env.ATLAS_BUCKET, tile, requestedVersion(request))
  if (!cached) return errorResponse(404, 'This atlas tile has not been generated yet.')
  const object = await env.ATLAS_BUCKET.get(cached.imageKey)
  if (!object) return errorResponse(404, 'This atlas tile has not been generated yet.')
  return new Response(object.body, {
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': cached.contentType,
      etag: object.httpEtag,
    },
  })
}

const generateTile = async (request: Request, env: Env, tile: Tile) => {
  const existing = await findCachedTile(env.ATLAS_BUCKET, tile)
  if (existing) {
    return json({
      url: tileUrl(existing.tile, existing.version),
      scene: existing.tile.scene,
      contentBounds: existing.contentBounds,
    })
  }
  if (!isAllowedApplicationRequest(request, env)) {
    return errorResponse(403, 'Image generation is restricted to the configured application domain.')
  }

  let body: Record<string, unknown>
  try {
    body = await readJsonBody(request)
    const source = decodeDataUrl(body.sourceImage, 'The tile source image')
    decodeDataUrl(body.guideImage, 'The guide image')
    const mask = decodeDataUrl(body.safeMask, 'The safe-zone mask')
    const overlay = decodeDataUrl(body.lineOverlay, 'The line overlay')
    const hasSea = body.hasSea === true
    const contentBounds = normalizeContentBounds(body.contentBounds)
    const generated = await openrouterImage(
      env,
      atlasPrompt(tile.scene, hasSea),
      String(body.sourceImage),
      String(body.guideImage),
    )
    const composed = composeTileImage(source.bytes, generated, mask.bytes, overlay.bytes)
    const entry = {
      contentType: 'image/png',
      generationVersion,
      generatedAt: new Date().toISOString(),
      contentBounds,
      mask: 'vector-safe-zones',
      outputSize: { width: atlasTileSize, height: atlasTileSize },
    }
    const versionedImageKey = imageKey(tile)
    const versionedMetadataKey = metadataKey(tile)
    await env.ATLAS_BUCKET.put(versionedImageKey, composed, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    })
    await env.ATLAS_BUCKET.put(versionedMetadataKey, JSON.stringify(entry), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    return json({
      url: tileUrl(tile, generationVersion),
      scene: tile.scene,
      contentBounds,
    })
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : 'Could not generate this atlas tile.')
  }
}

const serveCacheStatus = async (env: AtlasEnv, position: Omit<Tile, 'scene'>) => {
  const [cached, scenes] = await Promise.all([
    findCachedTile(env.ATLAS_BUCKET, position),
    cachedScenesInGrid(env.ATLAS_BUCKET, position),
  ])
  return json({
    cached: Boolean(cached),
    url: cached ? tileUrl(cached.tile, cached.version) : null,
    scene: cached?.tile.scene ?? null,
    scenes,
    contentBounds: cached?.contentBounds ?? null,
  })
}

const deleteCachedTile = async (request: Request, env: AtlasEnv, tile: Tile) => {
  if (env.ATLAS_ADMIN_MODE !== 'true') return errorResponse(403, 'Atlas admin mode is disabled.')
  if (!await adminTokenIsValid(request, env)) {
    return errorResponse(401, 'Atlas admin authentication is required.', {
      'www-authenticate': 'Bearer realm="atlas-admin"',
    })
  }
  const csrfHeader = request.headers.get('x-atlas-csrf-token')
  if (!adminRequestIsAllowed(request, env, true) ||
    !await csrfTokenIsValid(cookieValue(request, csrfCookieName), env.ATLAS_ADMIN_TOKEN) ||
    !await csrfTokenIsValid(csrfHeader, env.ATLAS_ADMIN_TOKEN) ||
    csrfHeader !== cookieValue(request, csrfCookieName)) {
    return errorResponse(403, 'Cache management is restricted to the configured application domain.')
  }

  const version = requestedVersion(request) ?? generationVersion
  const cached = await readCachedTile(env.ATLAS_BUCKET, tile, version)
  if (!cached) return errorResponse(404, 'This atlas tile is not cached.')
  await env.ATLAS_BUCKET.delete([cached.imageKey, cached.metadataKey])
  return json({ deleted: true, tile })
}

export const handleAtlasApi = async (request: Request, env: AtlasEnv): Promise<Response | null> => {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/atlas-tiles/cached') {
    if (env.ATLAS_ADMIN_MODE !== 'true') {
      return json({ adminMode: false, preRenderedCount: 0, tiles: [] })
    }
    if (!await adminTokenIsValid(request, env)) {
      return errorResponse(401, 'Atlas admin authentication is required.', {
        'www-authenticate': 'Bearer realm="atlas-admin"',
      })
    }
    if (!adminRequestIsAllowed(request, env)) {
      return errorResponse(403, 'Cache administration is restricted to the configured application domain.')
    }
    const version = requestedVersion(request)
    const tiles = await listCachedTiles(env.ATLAS_BUCKET, version)
    const csrf = await csrfToken(env.ATLAS_ADMIN_TOKEN as string)
    const secureCookie = url.protocol === 'https:' ? '; Secure' : ''
    return json({ adminMode: true, version, preRenderedCount: tiles.length, tiles }, 200, {
      'set-cookie': `${csrfCookieName}=${csrf}; Path=/; SameSite=Strict${secureCookie}`,
    })
  }

  const position = parsePositionPath(url.pathname)
  if (position && request.method === 'GET') return serveCacheStatus(env, position)

  if (url.pathname.startsWith('/generated-tiles/')) {
    const tile = parseTilePath(url.pathname.replace('/generated-tiles/', '/api/atlas-tiles/'))
    if (!tile || request.method !== 'GET') return errorResponse(404, 'Atlas tile not found.')
    return serveCachedTile(request, env, tile)
  }

  if (url.pathname.startsWith('/api/atlas-tiles/')) {
    const tile = parseTilePath(url.pathname)
    if (!tile) return errorResponse(404, 'Atlas tile not found.')
    if (request.method === 'GET') return serveCachedTile(request, env, tile)
    if (request.method === 'POST') return generateTile(request, env, tile)
    if (request.method === 'DELETE') return deleteCachedTile(request, env, tile)
    return errorResponse(405, 'This atlas endpoint does not support that method.')
  }

  return null
}
