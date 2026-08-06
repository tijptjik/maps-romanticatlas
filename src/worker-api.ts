import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon/workerd'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import {
  fogEligibilityVersion,
  fogEligibilityChildSpan,
  fogEligibilitySourceZoom,
  classifyFogEligibility,
  fogEligibilitySourceTile,
  type FogEligibility,
} from './fog-eligibility.ts'
import {
  manifestShardName,
  manifestShardNamesForGrid,
  type AtlasManifestEntry,
} from './atlas-manifest.ts'
import { atlasScenes } from './atlas-scenes.ts'
import { atlasPrompt } from './atlas-prompt.ts'
import {
  adminAccessError,
  atlasErrorPayload,
  atlasImageKey,
  atlasMetadataKey,
  atlasTileCount,
  atlasTileSize,
  atlasTileUrl,
  atlasZoom,
  bearerToken,
  cacheStatusPayload,
  cachedTilePayload,
  cachedTilesPayload,
  cookieValue,
  csrfCookieName,
  defaultAtlasVariant,
  generationVersion,
  isAllowedApplicationRequest,
  isReadableCacheVersion,
  isSupportedCacheVersion,
  isValidAtlasPosition,
  modeEnabled,
  normalizeContentBounds,
  parseAtlasPositionPath,
  parseAtlasTilePath,
  requestedCacheVersion,
  requestedAtlasVariant,
  type AtlasTile,
  type CachedAtlasTile,
} from './atlas-protocol.ts'

const maximumRequestBytes = 12_000_000
const maximumCacheStatusBatchSize = 64
const maximumImageBytes = 4_000_000
const maximumGeneratedImageBytes = 8_000_000
const maximumShareImageBytes = 8_000_000
const openrouterImagesApiUrl = 'https://openrouter.ai/api/v1/images'
const tileOrigin = 'https://tiles.saanseoi.hk'
const fogIndexZoom = 15
const fogIndexTileSpan = fogEligibilityChildSpan
type Scene = keyof typeof atlasScenes
type Tile = AtlasTile<Scene>
type AtlasEnv = Env & {
  ATLAS_ADMIN_TOKEN?: string
  ATLAS_LOCAL_DEV?: string
  OPENROUTER_API_KEY?: string
  ATLAS_SHARE_ASSET_ORIGIN?: string
}
type CachedTile = CachedAtlasTile<Scene> & {
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

const errorResponse = (
  status: number,
  error: string,
  headers?: Record<string, string>,
) => json(atlasErrorPayload(error), status, headers)

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index] ^ right[index]
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
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  )
}

const adminTokenIsValid = async (request: Request, env: AtlasEnv) => {
  const configuredToken = env.ATLAS_ADMIN_TOKEN?.trim()
  const suppliedToken = bearerToken(request.headers.get('authorization'))
  if (!configuredToken || !suppliedToken) return false
  const expected = await hmac(configuredToken, configuredToken)
  const actual = await hmac(configuredToken, suppliedToken)
  return constantTimeEqual(expected, actual)
}

const csrfToken = async (secret: string) => {
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = [...nonceBytes]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  const signature = [...(await hmac(secret, nonce))]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  return `${nonce}.${signature}`
}

const csrfTokenIsValid = async (token: string | null, secret: string | undefined) => {
  if (!token || !secret) return false
  const match = token.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/)
  if (!match) return false
  const expected = await hmac(secret, match[1])
  const actual = Uint8Array.from(match[2].match(/../g) ?? [], value =>
    Number.parseInt(value, 16),
  )
  return constantTimeEqual(expected, actual)
}

const randomItem = <T>(items: T[]) => {
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  return items[random[0] % items.length]
}

const readCachedTile = async (
  bucket: R2Bucket,
  tile: Tile,
  version: number,
  variant = defaultAtlasVariant,
) => {
  const imageObject = await bucket.head(atlasImageKey(tile, version, variant))
  if (!imageObject) return null
  const metadataObject = await bucket.get(
    atlasMetadataKey(tile, version, variant),
  )
  if (!metadataObject) return null
  try {
    const metadata = await metadataObject.json<{
      contentType?: string
      contentBounds?: unknown
    }>()
    return {
      tile,
      version,
      variant,
      contentType: metadata.contentType ?? 'image/png',
      contentBounds: normalizeContentBounds(metadata.contentBounds),
      imageKey: atlasImageKey(tile, version, variant),
      metadataKey: atlasMetadataKey(tile, version, variant),
    } satisfies CachedTile
  } catch {
    return null
  }
}

const toCachedTile = (entry: AtlasManifestEntry): CachedTile | null => {
  if (!atlasScenes[entry.scene] || !isReadableCacheVersion(entry.version)) {
    return null
  }
  const tile = {
    scene: entry.scene as Scene,
    zoom: entry.zoom,
    x: entry.x,
    y: entry.y,
  }
  return {
    tile,
    version: entry.version,
    variant: entry.variant,
    contentType: entry.contentType,
    contentBounds: entry.contentBounds,
    imageKey: atlasImageKey(tile, entry.version, entry.variant),
    metadataKey: atlasMetadataKey(tile, entry.version, entry.variant),
  }
}

const manifestEntriesForPosition = async (
  env: AtlasEnv,
  position: Omit<Tile, 'scene'>,
) =>
  (
    await env.ATLAS_MANIFEST.getByName(manifestShardName(position)).entriesForPosition(
      position,
    )
  )
    .map(toCachedTile)
    .filter((entry): entry is CachedTile => entry !== null)

const cachedTilesFromBucket = async (
  bucket: R2Bucket,
  position: Omit<Tile, 'scene'>,
) => {
  const listing = await bucket.list({
    prefix: `atlas/${position.zoom}/${position.x}/${position.y}/`,
  })
  const metadataPattern = new RegExp(
    `^atlas/${position.zoom}/${position.x}/${position.y}/(.+)\\.v(\\d+)(?:\\.([a-z0-9-]{1,64}))?\\.json$`,
  )
  const entries = listing.objects.flatMap(object => {
    const match = object.key.match(metadataPattern)
    if (!match) return []
    const [, scene, versionText, variantText] = match
    const version = Number(versionText)
    if (!atlasScenes[scene] || !isReadableCacheVersion(version)) return []
    return [
      {
        tile: { ...position, scene: scene as Scene },
        version,
        variant: variantText ?? defaultAtlasVariant,
      },
    ]
  })
  return (
    await Promise.all(
      entries.map(entry => readCachedTile(bucket, entry.tile, entry.version, entry.variant)),
    )
  ).filter((entry): entry is CachedTile => entry !== null)
}

const findCachedTile = async (env: AtlasEnv, position: Omit<Tile, 'scene'>) => {
  const cached = await manifestEntriesForPosition(env, position)
  if (cached.length) return randomItem(cached)
  if (!localDevelopmentEnabled(env)) return null
  const recovered = await cachedTilesFromBucket(env.ATLAS_BUCKET, position)
  return recovered.length ? randomItem(recovered) : null
}

const positionId = (position: Omit<Tile, 'scene'>) =>
  `${position.zoom}/${position.x}/${position.y}`

type SourceTileTemplate = { template: string; cacheVersion: string }
let sourceTileTemplateRequest: Promise<SourceTileTemplate> | undefined

const sourceTileTemplate = () => {
  if (sourceTileTemplateRequest) return sourceTileTemplateRequest
  sourceTileTemplateRequest = fetch(`${tileOrigin}/hongkong-latest.json`, {
    headers: { Origin: 'https://romanticatlas.hype.hk' },
  })
    .then(async response => {
      if (!response.ok) throw new Error('Could not load the map source definition.')
      const tileJson = await response.json<{ tiles?: unknown }>()
      const template = Array.isArray(tileJson.tiles) ? tileJson.tiles[0] : null
      if (typeof template !== 'string' || !template.includes('{z}')) {
        throw new Error('The map source did not provide a vector tile template.')
      }
      const release = new URL(template).searchParams.get('v') ?? 'unversioned'
      return { template, cacheVersion: `${fogEligibilityVersion}:${release}` }
    })
    .catch(error => {
      sourceTileTemplateRequest = undefined
      throw error
    })
  return sourceTileTemplateRequest
}

const sourceTileUrl = (template: string, position: Omit<Tile, 'scene'>) => {
  const source = fogEligibilitySourceTile(position)
  return template
    .replace('{z}', String(fogEligibilitySourceZoom))
    .replace('{x}', String(source.x))
    .replace('{y}', String(source.y))
}

const fogEligibilityForPositions = async (
  env: AtlasEnv,
  positions: Omit<Tile, 'scene'>[],
): Promise<{ cacheVersion: string; eligibilities: FogEligibility[] }> => {
  const source = await sourceTileTemplate()
  const bySourceTile = new Map<string, Omit<Tile, 'scene'>[]>()
  positions.forEach(position => {
    const parent = fogEligibilitySourceTile(position)
    const id = `${fogIndexZoom}/${parent.x}/${parent.y}`
    const group = bySourceTile.get(id) ?? []
    group.push(position)
    bySourceTile.set(id, group)
  })

  const entries = await Promise.all(
    [...bySourceTile.values()].map(async group => {
      const parent = fogEligibilitySourceTile(group[0])
      const indexed = await fogIndexEligibility(env, parent.x, parent.y)
      const requested = new Set(group.map(positionId))
      return indexed.eligibilities.filter(entry => requested.has(positionId(entry)))
    }),
  )
  const byPosition = new Map(entries.flat().map(entry => [positionId(entry), entry]))
  return {
    cacheVersion: source.cacheVersion,
    eligibilities: positions
      .map(position => byPosition.get(positionId(position)))
      .filter(Boolean),
  }
}

const fogIndexPositions = (x: number, y: number) =>
  Array.from({ length: fogIndexTileSpan * fogIndexTileSpan }, (_, offset) => ({
    zoom: atlasZoom,
    x: x * fogIndexTileSpan + (offset % fogIndexTileSpan),
    y: y * fogIndexTileSpan + Math.floor(offset / fogIndexTileSpan),
  }))

const fogIndexEligibility = async (env: AtlasEnv, x: number, y: number) => {
  const source = await sourceTileTemplate()
  const sourceId = `${fogIndexZoom}/${x}/${y}`
  const cache = env.FOG_ELIGIBILITY_INDEX_CACHE.getByName(sourceId)
  const indexed = await cache.fogIndex(source.cacheVersion)
  if (indexed) return { cacheVersion: source.cacheVersion, eligibilities: indexed }

  const positions = fogIndexPositions(x, y)
  const response = await fetch(sourceTileUrl(source.template, positions[0]), {
    headers: { Origin: 'https://romanticatlas.hype.hk' },
  })
  if (!response.ok) throw new Error(`Could not load source map tile ${sourceId}.`)
  const vectorTile = new VectorTile(new Pbf(await response.arrayBuffer()))
  const eligibilities = positions.map(position =>
    classifyFogEligibility(vectorTile, position),
  )
  await cache.putFogIndex(source.cacheVersion, eligibilities)
  return { cacheVersion: source.cacheVersion, eligibilities }
}

const fogIndexForTile = async (env: AtlasEnv, x: number, y: number) => {
  const positions = fogIndexPositions(x, y)
  const [eligibility, manifestEntries] = await Promise.all([
    fogIndexEligibility(env, x, y),
    Promise.all(
      [...new Set(positions.map(manifestShardName))].map(name =>
        env.ATLAS_MANIFEST.getByName(name).entriesForTileArea(
          atlasZoom,
          positions[0].x,
          positions[0].y,
          positions.at(-1).x,
          positions.at(-1).y,
        ),
      ),
    ).then(entries => entries.flat()),
  ])
  const cached = manifestEntries
    .map(toCachedTile)
    .filter((entry): entry is CachedTile => entry !== null)
    .map(entry => ({
      x: entry.tile.x,
      y: entry.tile.y,
      scene: entry.tile.scene,
      url: atlasTileUrl(entry.tile, entry.version, entry.variant),
      version: entry.version,
      variant: entry.variant,
      contentBounds: entry.contentBounds,
    }))
  return {
    x,
    y,
    zoom: fogIndexZoom,
    version: eligibility.cacheVersion,
    eligibility: eligibility.eligibilities,
    cached,
  }
}

const positionsFromCacheStatusRequest = (body: Record<string, unknown>) => {
  if (!Array.isArray(body.tiles) || !body.tiles.length)
    throw new Error('At least one atlas tile is required.')
  if (body.tiles.length > maximumCacheStatusBatchSize)
    throw new Error(
      `At most ${maximumCacheStatusBatchSize} atlas tiles can be checked at once.`,
    )

  const positions = new Map<string, Omit<Tile, 'scene'>>()
  body.tiles.forEach(value => {
    const candidate = value as Record<string, unknown>
    const position = {
      zoom: Number(candidate?.zoom),
      x: Number(candidate?.x),
      y: Number(candidate?.y),
    }
    if (!isValidAtlasPosition(position))
      throw new Error('The cache-status request contains an invalid atlas tile.')
    positions.set(positionId(position), position)
  })
  return [...positions.values()]
}

const cachedTileFromManifest = async (
  env: AtlasEnv,
  tile: Tile,
  version: number | null,
  variant = defaultAtlasVariant,
) => {
  const expectedVersion = version ?? generationVersion
  const cached = await manifestEntriesForPosition(env, tile)
  const manifestEntry = cached.find(
    entry =>
      entry.tile.scene === tile.scene &&
      entry.version === expectedVersion &&
      entry.variant === variant,
  )
  if (manifestEntry) return manifestEntry

  // Existing R2 tiles predate the manifest. A local Wrangler instance also
  // starts with an empty Durable Object, even when it uses the remote bucket.
  // Keep their stable, versioned image URLs valid until a manifest rebuild has
  // indexed them.
  return readCachedTile(env.ATLAS_BUCKET, tile, expectedVersion, variant)
}

const publishManifestEntry = async (env: AtlasEnv, cached: CachedTile) => {
  const entry: AtlasManifestEntry = {
    zoom: cached.tile.zoom,
    x: cached.tile.x,
    y: cached.tile.y,
    scene: cached.tile.scene,
    version: cached.version,
    variant: cached.variant,
    contentType: cached.contentType,
    contentBounds: cached.contentBounds,
  }
  await env.ATLAS_MANIFEST.getByName(manifestShardName(entry)).upsert([entry])
}

const listCachedTiles = async (bucket: R2Bucket, requested: number | null = null) => {
  const cachedVariants = new Map<
    string,
    { tile: Tile; version: number; variant: string }
  >()
  let cursor: string | undefined
  do {
    const listing = await bucket.list({ prefix: `atlas/${atlasZoom}/`, cursor })
    for (const object of listing.objects) {
      const match = object.key.match(
        new RegExp(
          `^atlas/${atlasZoom}/(\\d+)/(\\d+)/(.+)\\.v(\\d+)(?:\\.([a-z0-9-]{1,64}))?\\.json$`,
        ),
      )
      if (!match) continue
      const [, x, y, scene, versionText, variantText] = match
      const version = Number(versionText)
      const variant = variantText ?? defaultAtlasVariant
      const numericX = Number(x)
      const numericY = Number(y)
      const tileCount = atlasTileCount()
      if (!atlasScenes[scene] || !isSupportedCacheVersion(version)) continue
      if (numericX >= tileCount || numericY >= tileCount) continue
      const key = `${numericX}/${numericY}/${scene}/${version}/${variant}`
      if (requested !== null && version !== requested) continue
      cachedVariants.set(key, {
        tile: { scene: scene as Scene, zoom: atlasZoom, x: numericX, y: numericY },
        version,
        variant,
      })
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  const cached = await Promise.all(
    [...cachedVariants.values()].map(({ tile, version, variant }) =>
      readCachedTile(bucket, tile, version, variant),
    ),
  )
  return cached
    .filter((entry): entry is CachedTile => entry !== null)
    .map(entry => ({
      scene: entry.tile.scene,
      zoom: entry.tile.zoom,
      x: entry.tile.x,
      y: entry.tile.y,
      version: entry.version,
      variant: entry.variant,
      url: atlasTileUrl(entry.tile, entry.version, entry.variant),
      contentBounds: entry.contentBounds,
    }))
}

const imageDataUrl = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=]+)$/

const decodeDataUrl = (
  value: unknown,
  label: string,
  maximumBytes = maximumImageBytes,
) => {
  if (typeof value !== 'string') throw new Error(`${label} must be an image data URL.`)
  const match = value.match(imageDataUrl)
  if (!match) throw new Error(`${label} must be a PNG or JPEG data URL.`)
  const binary = atob(match[2])
  if (binary.length > maximumBytes) throw new Error(`${label} is too large.`)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return { bytes, contentType: match[1] }
}

const decodeGeneratedImage = (value: unknown, mediaType: unknown) => {
  if (mediaType && mediaType !== 'image/png') {
    throw new Error(`OpenRouter returned an unsupported image format (${mediaType}).`)
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('OpenRouter returned invalid image data.')
  }
  try {
    return decodeDataUrl(
      `data:image/png;base64,${value}`,
      'OpenRouter returned invalid image data.',
      maximumGeneratedImageBytes,
    )
  } catch {
    throw new Error('OpenRouter returned invalid image data.')
  }
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
    for (
      let pixel = 0, offset = 0;
      pixel < blurredAlpha.length;
      pixel += 1, offset += 4
    ) {
      const generatedOpacity =
        (blurredAlpha[pixel] * generatedPixels[offset + 3]) / 65_025
      const sourceOpacity = 1 - generatedOpacity
      let red =
        sourcePixels[offset] * sourceOpacity +
        generatedPixels[offset] * generatedOpacity
      let green =
        sourcePixels[offset + 1] * sourceOpacity +
        generatedPixels[offset + 1] * generatedOpacity
      let blue =
        sourcePixels[offset + 2] * sourceOpacity +
        generatedPixels[offset + 2] * generatedOpacity
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

const openrouterImage = async (
  env: AtlasEnv,
  prompt: string,
  sourceImage: string,
  guideImage: string,
) => {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter is not configured for this deployment.')
  }
  const requestImage = () =>
    fetch(openrouterImagesApiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'http-referer': env.ATLAS_ALLOWED_ORIGIN,
        'x-title': 'Visionary Machines Map',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL ?? 'openai/gpt-5.4-image-2',
        prompt,
        input_references: [
          { type: 'image_url', image_url: { url: sourceImage } },
          { type: 'image_url', image_url: { url: guideImage } },
        ],
        aspect_ratio: '1:1',
        n: 1,
        output_format: 'png',
      }),
    })

  let response: Response
  try {
    response = await requestImage()
  } catch {
    try {
      // A request can occasionally fail before it reaches the provider. Retry
      // once: no image has been accepted or charged until OpenRouter responds.
      response = await requestImage()
    } catch {
      throw new Error(
        'The image-generation service could not be reached. Please try clearing this tile again shortly.',
      )
    }
  }
  if (!response.ok) {
    throw new Error(`OpenRouter image generation failed (${response.status}).`)
  }
  const result = (await response.json()) as {
    data?: Array<{ b64_json?: unknown; media_type?: unknown }>
  }
  const image = result.data?.find(item => item.b64_json)
  if (!image) throw new Error('OpenRouter returned no image for the requested prompt.')
  const parsed = decodeGeneratedImage(image.b64_json, image.media_type)
  return parsed.bytes
}

const readJsonBody = async (request: Request) => {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maximumRequestBytes)
    throw new Error('The tile generation payload is too large.')
  if (!request.body) throw new Error('A JSON request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumRequestBytes)
        throw new Error('The tile generation payload is too large.')
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

const requestedVersion = (request: Request) =>
  requestedCacheVersion(new URL(request.url).searchParams)

const adminModeEnabled = (request: Request) =>
  modeEnabled(new URL(request.url).searchParams, 'admin')

const diagnosticsModeEnabled = (request: Request) =>
  modeEnabled(new URL(request.url).searchParams, 'diagnostics')

const localDevelopmentEnabled = (env: AtlasEnv) =>
  String(env.ATLAS_LOCAL_DEV) === 'true'

const applicationRequestIsAllowed = (
  request: Request,
  env: AtlasEnv,
  requireOrigin = false,
) => {
  // Wrangler's remote-binding proxy presents the configured production route
  // to the local Worker. ATLAS_LOCAL_DEV is set only by the local dev command,
  // so it is the reliable boundary for accepting those localhost requests.
  if (localDevelopmentEnabled(env)) return true

  return isAllowedApplicationRequest({
    requestHost: request.headers.get('host') ?? new URL(request.url).host,
    origin: request.headers.get('origin'),
    allowedOrigin: env.ATLAS_ALLOWED_ORIGIN,
    localDevelopment: false,
    requireOrigin,
  })
}

const shareAssetUrl = (env: AtlasEnv, key: string) => {
  const configuredOrigin = env.ATLAS_SHARE_ASSET_ORIGIN?.trim()
  if (!configuredOrigin) return null
  try {
    const origin = new URL(configuredOrigin)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return null
    return new URL(key, origin).toString()
  } catch {
    return null
  }
}

const createShareMap = async (request: Request, env: AtlasEnv) => {
  if (!applicationRequestIsAllowed(request, env, true)) {
    return errorResponse(403, 'Map sharing is restricted to the application.')
  }
  const assetOrigin = shareAssetUrl(env, 'shared-maps/')
  if (!assetOrigin) {
    return errorResponse(
      503,
      'Map sharing is not configured with a public R2 asset origin.',
    )
  }
  try {
    const body = await readJsonBody(request)
    const image = decodeDataUrl(
      body.image,
      'The shared map image',
      maximumShareImageBytes,
    )
    if (image.contentType !== 'image/png') {
      return errorResponse(400, 'The shared map image must be a PNG.')
    }
    const key = `shared-maps/${crypto.randomUUID()}.png`
    await env.maps_romanticatlas_assets.put(key, image.bytes, {
      httpMetadata: {
        contentType: 'image/png',
        contentDisposition: 'inline',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
    return json({ url: shareAssetUrl(env, key) })
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : 'Could not save the shared map image.',
    )
  }
}

const serveCachedTile = async (request: Request, env: AtlasEnv, tile: Tile) => {
  const cached = await cachedTileFromManifest(
    env,
    tile,
    requestedVersion(request),
    requestedAtlasVariant(new URL(request.url).searchParams),
  )
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

const generateTile = async (
  request: Request,
  env: AtlasEnv,
  tile: Tile,
  force = false,
) => {
  const existing = force ? null : await findCachedTile(env, tile)
  if (existing) return json(cachedTilePayload(existing))
  if (!applicationRequestIsAllowed(request, env)) {
    return errorResponse(
      403,
      'Image generation is restricted to the configured application domain.',
    )
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
    const composed = composeTileImage(
      source.bytes,
      generated,
      mask.bytes,
      overlay.bytes,
    )
    const entry = {
      contentType: 'image/png',
      generationVersion,
      generatedAt: new Date().toISOString(),
      contentBounds,
      mask: 'vector-safe-zones',
      outputSize: { width: atlasTileSize, height: atlasTileSize },
    }
    const variant = crypto.randomUUID()
    const versionedImageKey = atlasImageKey(tile, generationVersion, variant)
    const versionedMetadataKey = atlasMetadataKey(tile, generationVersion, variant)
    await env.ATLAS_BUCKET.put(versionedImageKey, composed, {
      httpMetadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
    await env.ATLAS_BUCKET.put(versionedMetadataKey, JSON.stringify(entry), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    await publishManifestEntry(env, {
      tile,
      version: generationVersion,
      variant,
      contentType: entry.contentType,
      contentBounds,
      imageKey: versionedImageKey,
      metadataKey: versionedMetadataKey,
    })
    return json(
      cachedTilePayload({
        tile,
        version: generationVersion,
        variant,
        contentType: entry.contentType,
        contentBounds,
      }),
    )
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : 'Could not generate this atlas tile.',
    )
  }
}

const adminMutationIsAllowed = async (request: Request, env: AtlasEnv) => {
  const csrfHeader = request.headers.get('x-atlas-csrf-token')
  const csrfCookie = cookieValue(request.headers.get('cookie'), csrfCookieName)
  return adminAccessError({
    adminMode: adminModeEnabled(request),
    authenticationConfigured: Boolean(env.ATLAS_ADMIN_TOKEN?.trim()),
    authenticated: await adminTokenIsValid(request, env),
    applicationRequestAllowed: applicationRequestIsAllowed(request, env, true),
    csrfValid:
      (await csrfTokenIsValid(csrfCookie, env.ATLAS_ADMIN_TOKEN)) &&
      (await csrfTokenIsValid(csrfHeader, env.ATLAS_ADMIN_TOKEN)) &&
      csrfHeader === csrfCookie,
    requireCsrf: true,
  })
}

const rerenderCachedTile = async (request: Request, env: AtlasEnv, tile: Tile) => {
  const error = await adminMutationIsAllowed(request, env)
  if (error) {
    return errorResponse(
      error.status,
      error.error,
      error.authenticate
        ? { 'www-authenticate': 'Bearer realm="atlas-admin"' }
        : undefined,
    )
  }
  return generateTile(request, env, tile, true)
}

const serveCacheStatus = async (env: AtlasEnv, position: Omit<Tile, 'scene'>) => {
  const [cached, sceneLists] = await Promise.all([
    findCachedTile(env, position),
    Promise.all(
      manifestShardNamesForGrid(position).map(shardName =>
        env.ATLAS_MANIFEST.getByName(shardName).scenesInGrid(position),
      ),
    ),
  ])
  const scenes = [...new Set(sceneLists.flat())].filter((scene): scene is Scene =>
    Boolean(atlasScenes[scene]),
  )
  return json(
    cacheStatusPayload({ cached, scenes }),
    200,
    // A short TTL makes cache hits cheap without making a freshly published
    // tile take long to appear to a visitor who previously saw a cache miss.
    { 'cache-control': 'public, max-age=10, stale-while-revalidate=30' },
  )
}

const serveCacheStatusBatch = async (
  env: AtlasEnv,
  positions: Omit<Tile, 'scene'>[],
) => {
  const positionsByShard = new Map<string, Omit<Tile, 'scene'>[]>()
  const scenePositionsByShard = new Map<string, Omit<Tile, 'scene'>[]>()
  positions.forEach(position => {
    const shard = manifestShardName(position)
    const shardPositions = positionsByShard.get(shard) ?? []
    shardPositions.push(position)
    positionsByShard.set(shard, shardPositions)

    manifestShardNamesForGrid(position).forEach(sceneShard => {
      const scenePositions = scenePositionsByShard.get(sceneShard) ?? []
      scenePositions.push(position)
      scenePositionsByShard.set(sceneShard, scenePositions)
    })
  })

  const cachedByPosition = new Map<string, CachedTile[]>()
  await Promise.all(
    [...positionsByShard].map(async ([shard, shardPositions]) => {
      const entries =
        await env.ATLAS_MANIFEST.getByName(shard).entriesForPositions(shardPositions)
      entries.map(toCachedTile).forEach(entry => {
        if (!entry) return
        const id = positionId(entry.tile)
        const cached = cachedByPosition.get(id) ?? []
        cached.push(entry)
        cachedByPosition.set(id, cached)
      })
    }),
  )

  if (localDevelopmentEnabled(env)) {
    await Promise.all(
      positions.map(async position => {
        const id = positionId(position)
        if (cachedByPosition.has(id)) return
        const recovered = await cachedTilesFromBucket(env.ATLAS_BUCKET, position)
        if (recovered.length) cachedByPosition.set(id, recovered)
      }),
    )
  }

  const scenesByPosition = new Map<string, Set<Scene>>()
  await Promise.all(
    [...scenePositionsByShard].map(async ([shard, shardPositions]) => {
      const sceneLists =
        await env.ATLAS_MANIFEST.getByName(shard).scenesInGrids(shardPositions)
      sceneLists.forEach(({ zoom, x, y, scenes }) => {
        const id = positionId({ zoom, x, y })
        const collected = scenesByPosition.get(id) ?? new Set<Scene>()
        scenes.forEach(scene => {
          if (atlasScenes[scene]) collected.add(scene as Scene)
        })
        scenesByPosition.set(id, collected)
      })
    }),
  )

  return json({
    statuses: positions.map(position => {
      const cached = cachedByPosition.get(positionId(position))
      return cacheStatusPayload({
        cached: cached?.length ? randomItem(cached) : null,
        scenes: [...(scenesByPosition.get(positionId(position)) ?? [])],
      })
    }),
  })
}

const manifestMetadataKeyPattern =
  /^atlas\/(\d+)\/(\d+)\/(\d+)\/(.+)\.v(\d+)(?:\.([a-z0-9-]{1,64}))?\.json$/

const manifestEntryFromMetadata = async (
  bucket: R2Bucket,
  key: string,
): Promise<AtlasManifestEntry | null> => {
  const match = key.match(manifestMetadataKeyPattern)
  if (!match) return null
  const [, zoomText, xText, yText, scene, versionText, variantText] = match
  const zoom = Number(zoomText)
  const x = Number(xText)
  const y = Number(yText)
  const version = Number(versionText)
  const variant = variantText ?? defaultAtlasVariant
  const tileCount = 2 ** zoom
  if (
    zoom !== atlasZoom ||
    x < 0 ||
    y < 0 ||
    x >= tileCount ||
    y >= tileCount ||
    !atlasScenes[scene] ||
    !isReadableCacheVersion(version)
  )
    return null

  const tile = { scene: scene as Scene, zoom, x, y }
  const [metadataObject, imageObject] = await Promise.all([
    bucket.get(key),
    bucket.head(atlasImageKey(tile, version, variant)),
  ])
  if (!metadataObject || !imageObject) return null
  try {
    const metadata = await metadataObject.json<{
      contentType?: string
      contentBounds?: unknown
    }>()
    return {
      zoom,
      x,
      y,
      scene,
      version,
      variant,
      contentType:
        metadata.contentType ?? imageObject.httpMetadata?.contentType ?? 'image/png',
      contentBounds: normalizeContentBounds(metadata.contentBounds),
    }
  } catch {
    return null
  }
}

const mapConcurrently = async <Input, Output>(
  values: Input[],
  limit: number,
  mapper: (value: Input) => Promise<Output>,
) => {
  const results: Output[] = []
  let cursor = 0
  const next = async () => {
    while (cursor < values.length) {
      const value = values[cursor]
      cursor += 1
      results.push(await mapper(value))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, next))
  return results
}

const rebuildManifest = async (env: AtlasEnv) => {
  // Entries published after this point may not appear in the R2 listing below.
  // The Durable Object uses this timestamp to preserve those live writes while
  // replacing stale rows from each rebuilt shard.
  const rebuildStartedAt = Date.now()
  const metadataKeys: string[] = []
  let cursor: string | undefined
  do {
    const listing = await env.ATLAS_BUCKET.list({
      prefix: `atlas/${atlasZoom}/`,
      cursor,
    })
    metadataKeys.push(
      ...listing.objects
        .map(object => object.key)
        .filter(key => manifestMetadataKeyPattern.test(key)),
    )
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  const entries = (
    await mapConcurrently(metadataKeys, 16, key =>
      manifestEntryFromMetadata(env.ATLAS_BUCKET, key),
    )
  ).filter((entry): entry is AtlasManifestEntry => entry !== null)
  const entriesByShard = new Map<string, AtlasManifestEntry[]>()
  entries.forEach(entry => {
    const shard = manifestShardName(entry)
    const shardEntries = entriesByShard.get(shard) ?? []
    shardEntries.push(entry)
    entriesByShard.set(shard, shardEntries)
  })
  await Promise.all(
    [...entriesByShard].map(async ([shard, shardEntries]) => {
      const stub = env.ATLAS_MANIFEST.getByName(shard)
      for (let offset = 0; offset < shardEntries.length; offset += 100) {
        await stub.replaceFromRebuild(
          shardEntries.slice(offset, offset + 100),
          rebuildStartedAt,
          offset === 0,
        )
      }
    }),
  )
  return {
    scannedMetadata: metadataKeys.length,
    indexed: entries.length,
    shards: entriesByShard.size,
  }
}

const deleteCachedTile = async (request: Request, env: AtlasEnv, tile: Tile) => {
  const error = await adminMutationIsAllowed(request, env)
  if (error) {
    return errorResponse(
      error.status,
      error.error,
      error.authenticate
        ? { 'www-authenticate': 'Bearer realm="atlas-admin"' }
        : undefined,
    )
  }

  const version = requestedVersion(request) ?? generationVersion
  const variant = requestedAtlasVariant(new URL(request.url).searchParams)
  const cached = await readCachedTile(env.ATLAS_BUCKET, tile, version, variant)
  if (!cached) return errorResponse(404, 'This atlas tile is not cached.')
  await env.ATLAS_BUCKET.delete([cached.imageKey, cached.metadataKey])
  await env.ATLAS_MANIFEST.getByName(manifestShardName(tile)).remove({
    zoom: tile.zoom,
    x: tile.x,
    y: tile.y,
    scene: tile.scene,
    version,
    variant,
  })
  return json({ deleted: true, tile })
}

const manifestBackfillIsAllowed = async (request: Request, env: AtlasEnv) =>
  !adminAccessError({
    adminMode: adminModeEnabled(request),
    authenticationConfigured: Boolean(env.ATLAS_ADMIN_TOKEN?.trim()),
    authenticated: await adminTokenIsValid(request, env),
    applicationRequestAllowed: applicationRequestIsAllowed(request, env, true),
  })

export const handleAtlasApi = async (
  request: Request,
  env: AtlasEnv,
): Promise<Response | null> => {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/share-maps') {
    return createShareMap(request, env)
  }
  if (
    request.method === 'POST' &&
    url.pathname === '/api/atlas-tiles/manifest/rebuild'
  ) {
    if (!(await manifestBackfillIsAllowed(request, env))) {
      return errorResponse(
        403,
        'Atlas manifest backfill is restricted to cache administrators.',
      )
    }
    return json(await rebuildManifest(env))
  }
  if (request.method === 'GET' && url.pathname === '/api/atlas-tiles/cached') {
    const adminMode = adminModeEnabled(request)
    if (!adminMode && !diagnosticsModeEnabled(request)) {
      return json(
        cachedTilesPayload({
          adminMode: false,
          diagnosticsMode: false,
          version: null,
          tiles: [],
        }),
      )
    }
    if (adminMode) {
      const error = adminAccessError({
        adminMode,
        authenticationConfigured: Boolean(env.ATLAS_ADMIN_TOKEN?.trim()),
        authenticated: await adminTokenIsValid(request, env),
        applicationRequestAllowed: applicationRequestIsAllowed(request, env),
      })
      if (error)
        return errorResponse(
          error.status,
          error.error,
          error.authenticate
            ? { 'www-authenticate': 'Bearer realm="atlas-admin"' }
            : undefined,
        )
    }
    const version = adminMode
      ? requestedVersion(request)
      : requestedVersion(request) ?? generationVersion
    const tiles = await listCachedTiles(env.ATLAS_BUCKET, version)
    const csrf = adminMode ? await csrfToken(env.ATLAS_ADMIN_TOKEN as string) : null
    const secureCookie = url.protocol === 'https:' ? '; Secure' : ''
    return json(
      cachedTilesPayload({
        adminMode,
        diagnosticsMode: diagnosticsModeEnabled(request),
        version,
        tiles,
      }),
      200,
      csrf
        ? {
            'set-cookie': `${csrfCookieName}=${csrf}; Path=/; SameSite=Strict${secureCookie}`,
          }
        : undefined,
    )
  }

  if (request.method === 'POST' && url.pathname === '/api/atlas-tiles/cache-status') {
    try {
      return serveCacheStatusBatch(
        env,
        positionsFromCacheStatusRequest(await readJsonBody(request)),
      )
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error
          ? error.message
          : 'Could not read the cache-status request.',
      )
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/atlas-eligibility') {
    if (!applicationRequestIsAllowed(request, env, true)) {
      return errorResponse(
        403,
        'Eligibility lookup is restricted to the map application.',
      )
    }
    try {
      const body = await readJsonBody(request)
      const eligibility = await fogEligibilityForPositions(
        env,
        positionsFromCacheStatusRequest(body),
      )
      return json({
        version: eligibility.cacheVersion,
        eligibilities: eligibility.eligibilities,
      })
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error
          ? error.message
          : 'Could not read the eligibility request.',
      )
    }
  }

  const fogIndexMatch = url.pathname.match(/^\/api\/fog-index\/15\/(\d+)\/(\d+)$/)
  if (request.method === 'GET' && fogIndexMatch) {
    const x = Number(fogIndexMatch[1])
    const y = Number(fogIndexMatch[2])
    const tileCount = 2 ** fogIndexZoom
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= tileCount ||
      y >= tileCount
    ) {
      return errorResponse(400, 'The fog index tile is invalid.')
    }
    try {
      return json(await fogIndexForTile(env, x, y))
    } catch (error) {
      return errorResponse(
        500,
        error instanceof Error ? error.message : 'Could not load the fog index.',
      )
    }
  }

  const position = parseAtlasPositionPath(url.pathname)
  if (position && request.method === 'GET') return serveCacheStatus(env, position)

  if (url.pathname.startsWith('/generated-tiles/')) {
    const tile = parseAtlasTilePath(url.pathname, (scene): scene is Scene =>
      Boolean(atlasScenes[scene]),
    )
    if (!tile || request.method !== 'GET')
      return errorResponse(404, 'Atlas tile not found.')
    return serveCachedTile(request, env, tile)
  }

  if (url.pathname.startsWith('/api/atlas-tiles/')) {
    const tile = parseAtlasTilePath(url.pathname, (scene): scene is Scene =>
      Boolean(atlasScenes[scene]),
    )
    if (!tile) return errorResponse(404, 'Atlas tile not found.')
    if (request.method === 'GET') return serveCachedTile(request, env, tile)
    if (request.method === 'POST') {
      return new URL(request.url).searchParams.get('rerender') === 'true'
        ? rerenderCachedTile(request, env, tile)
        : generateTile(request, env, tile)
    }
    if (request.method === 'DELETE') return deleteCachedTile(request, env, tile)
    return errorResponse(405, 'This atlas endpoint does not support that method.')
  }

  return null
}
