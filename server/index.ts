import { createServer } from 'node:http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createServer as createViteServer } from 'vite'

import { parseImageDataUrl } from './image-data-url.ts'
import { createOpenRouterClient } from './openrouter-client.ts'
import { atlasSeaScenes, atlasSceneNames, atlasScenes } from '../src/atlas-scenes.ts'
import {
  adminAccessError,
  atlasErrorPayload,
  atlasImageKey,
  atlasMetadataKey,
  atlasSceneGridRadius,
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
  readableCacheVersions,
  requestedAtlasVariant,
  requestedCacheVersion as parseRequestedCacheVersion,
} from '../src/atlas-protocol.ts'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const sharedMapsDirectory = path.join(rootDirectory, 'shared-maps')
const productionDirectory = path.join(rootDirectory, 'dist')
const concurrentGenerationsPerClient = 3
const maximumCacheStatusBatchSize = 64
const isProduction = process.env.NODE_ENV === 'production'
const adminToken = process.env.ATLAS_ADMIN_TOKEN?.trim() || null
const allowedOrigin = process.env.ATLAS_ALLOWED_ORIGIN ?? 'https://romanticatlas.hype.hk'
const shareAssetOrigin = process.env.ATLAS_SHARE_ASSET_ORIGIN?.trim() || null
const tileOrigin = 'https://tiles.saanseoi.hk'
const tileProxyPrefix = '/map-assets/saanseoi'
const tileJsonPath = `${tileProxyPrefix}/hongkong-latest.json`
const vectorTilePattern = new RegExp(
  `^${tileProxyPrefix}/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
)
const atlasColourDirection = 'Keep the surrounding map and its Victorian-brown palette unchanged. Within the event, use a lively, carefully balanced storybook palette with warm parchment and sandy cream foundations, plus clear accents of cobalt blue, coral vermilion, marigold yellow, leafy sage green, dusty rose, and soft lilac. Keep the colours richly pigmented, crisp, and pleasantly contrasty so the event stands out, while remaining slightly softened and paper-printed rather than neon, fluorescent, garish, or oversaturated.'
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const tileLocks = new Map<string, Promise<void>>()
const clientGenerationState = new Map<string, { active: number }>()

const requestSearchParams = request =>
  new URL(request.url ?? '/', 'http://localhost').searchParams

const isAdminModeEnabled = request => modeEnabled(requestSearchParams(request), 'admin')

const diagnosticsModeEnabled = request =>
  modeEnabled(requestSearchParams(request), 'diagnostics')

const tileLockKey = tile => `${tile.zoom}/${tile.x}/${tile.y}`

const acquireTileLock = async tile => {
  const key = tileLockKey(tile)
  const previous = tileLocks.get(key)
  let releaseCurrent: () => void = () => {}
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve
  })
  tileLocks.set(key, current)
  if (previous) await previous

  return () => {
    releaseCurrent()
    if (tileLocks.get(key) === current) tileLocks.delete(key)
  }
}

const getClientKey = request => {
  const cloudflareAddress = request.headers['cf-connecting-ip']
  if (typeof cloudflareAddress === 'string' && cloudflareAddress) {
    return cloudflareAddress
  }
  const forwardedAddress = request.headers['x-forwarded-for']
  if (typeof forwardedAddress === 'string' && forwardedAddress) {
    return forwardedAddress.split(',')[0].trim()
  }
  return request.socket.remoteAddress ?? 'unknown'
}

const reserveGeneration = clientKey => {
  const state = clientGenerationState.get(clientKey) ?? { active: 0 }

  if (state.active >= concurrentGenerationsPerClient) {
    clientGenerationState.set(clientKey, state)
    return {
      allowed: false,
      retryAfterMs: 1,
      reason:
        'Three tile clearings are already in progress.\n' +
        'Wait for one to finish before clearing more fog.',
    }
  }

  state.active += 1
  clientGenerationState.set(clientKey, state)
  return {
    allowed: true,
    release: () => {
      const current = clientGenerationState.get(clientKey)
      if (!current) return
      current.active = Math.max(0, current.active - 1)
      if (!current.active) clientGenerationState.delete(clientKey)
    },
  }
}

const sendRateLimit = (response, limit) => {
  const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000))
  response.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'retry-after': String(retryAfterSeconds),
    'x-atlas-limit-reason': 'concurrent-generations',
    'x-ratelimit-limit': String(concurrentGenerationsPerClient),
    'x-ratelimit-remaining': '0',
  })
  response.end(JSON.stringify({
    error: limit.reason,
    retryAfterSeconds,
  }))
}

const atomicWriteFile = async (filePath, data) => {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, data)
    await rename(temporaryPath, filePath)
  } finally {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary file was renamed successfully or never created.
    }
  }
}

const sendJson = (response, statusCode, data, headers = {}) => {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(data))
}

const sendError = (response, statusCode, message) =>
  sendJson(response, statusCode, atlasErrorPayload(message))

const isPathWithin = (directory, candidate) => {
  const relativePath = path.relative(directory, candidate)
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

const tokensMatch = (left, right) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const adminTokenIsValid = request =>
  Boolean(adminToken) && tokensMatch(bearerToken(request.headers.authorization) ?? '', adminToken)

const createCsrfToken = () => {
  const nonce = randomBytes(32).toString('hex')
  const signature = createHmac('sha256', adminToken ?? '').update(nonce).digest('hex')
  return `${nonce}.${signature}`
}

const isValidCsrfToken = token => {
  if (!adminToken || typeof token !== 'string') return false
  const match = token.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/)
  if (!match) return false
  const [, nonce, signature] = match
  const expectedSignature = createHmac('sha256', adminToken).update(nonce).digest('hex')
  return tokensMatch(signature, expectedSignature)
}

const ensureCsrfCookie = (request, response) => {
  const existingToken = cookieValue(request.headers.cookie, csrfCookieName)
  if (isValidCsrfToken(existingToken)) return existingToken

  const token = createCsrfToken()
  const secureAttribute = isProduction ? '; Secure' : ''
  response.setHeader(
    'set-cookie',
    `${csrfCookieName}=${token}; Path=/; SameSite=Strict${secureAttribute}`,
  )
  return token
}

const hasValidCsrfRequest = request => {
  const headerToken = request.headers['x-atlas-csrf-token']
  const cookieToken = cookieValue(request.headers.cookie, csrfCookieName)
  return typeof headerToken === 'string' && isValidCsrfToken(cookieToken) &&
    tokensMatch(headerToken, cookieToken)
}

const rejectAdminAccess = (
  request,
  response,
  options: { requireOrigin?: boolean; requireCsrf?: boolean } = {},
) => {
  const error = adminAccessError({
    adminMode: isAdminModeEnabled(request),
    authenticationConfigured: Boolean(adminToken),
    authenticated: adminTokenIsValid(request),
    applicationRequestAllowed: applicationRequestIsAllowed(request, options.requireOrigin),
    csrfValid: !options.requireCsrf || hasValidCsrfRequest(request),
    requireCsrf: options.requireCsrf,
  })
  if (!error) return false
  if (error.authenticate)
    response.setHeader('www-authenticate', 'Bearer realm="atlas-admin"')
  sendError(response, error.status, error.error)
  return true
}

const readRequestBody = async request => {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > 12_000_000) {
      throw new Error('The tile generation payload is too large.')
    }
    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const localSharedMapPattern = /^\/shared-maps\/([0-9a-f-]{36})\.png$/

const shareAssetUrl = (request, key) => {
  if (!isProduction) {
    return new URL(`/shared-maps/${key}`, `http://${request.headers.host}`).toString()
  }
  if (!shareAssetOrigin) return null
  try {
    const origin = new URL(shareAssetOrigin)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return null
    return new URL(`shared-maps/${key}`, origin).toString()
  } catch {
    return null
  }
}

const createSharedMap = async (request, response) => {
  if (!applicationRequestIsAllowed(request, true)) {
    sendError(response, 403, 'Map sharing is restricted to the application.')
    return
  }
  const assetUrl = shareAssetUrl(request, 'placeholder.png')
  if (!assetUrl) {
    sendError(response, 503, 'Map sharing is not configured with a public R2 asset origin.')
    return
  }
  try {
    const body = await readRequestBody(request)
    const image = parseImageDataUrl(
      body.image,
      'The shared map image must be a valid PNG data URL.',
    )
    if (image.contentType !== 'image/png' || image.data.length > 8_000_000) {
      sendError(response, 400, 'The shared map image must be a PNG smaller than 8 MB.')
      return
    }
    const key = `${randomUUID()}.png`
    await mkdir(sharedMapsDirectory, { recursive: true })
    await atomicWriteFile(path.join(sharedMapsDirectory, key), image.data)
    sendJson(response, 200, { url: shareAssetUrl(request, key) })
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : 'Could not save the shared map image.',
    )
  }
}

const serveSharedMap = async (response, filename) => {
  try {
    const image = await readFile(path.join(sharedMapsDirectory, filename))
    response.writeHead(200, {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': 'inline',
      'content-type': 'image/png',
    })
    response.end(image)
  } catch {
    sendError(response, 404, 'Shared map image not found.')
  }
}

const composeTileImage = async (sourceImage, generatedImage, safeMask, lineOverlay) => {
  const source = parseImageDataUrl(sourceImage, 'The tile source image must be a valid image data URL.')
  const generated = generatedImage.data
  const mask = parseImageDataUrl(safeMask, 'The tile safe mask must be a valid image data URL.')
  const overlay = parseImageDataUrl(lineOverlay, 'The tile line overlay must be a valid image data URL.')
  const alpha = await sharp(mask.data)
    .resize(atlasTileSize, atlasTileSize, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .greyscale()
    .blur(10)
    .raw()
    .toBuffer()
  const lockedLineAlpha = await sharp(overlay.data)
    .ensureAlpha()
    .extractChannel(3)
    .resize(atlasTileSize, atlasTileSize, { fit: 'fill' })
    .raw()
    .toBuffer()
  for (let index = 0; index < alpha.length; index += 1) {
    if (lockedLineAlpha[index] > 0) alpha[index] = 0
  }
  const maskedGenerated = await sharp(generated)
    .flatten({ background: '#000000' })
    .resize(atlasTileSize, atlasTileSize, { fit: 'fill' })
    .joinChannel(alpha, {
      raw: { width: atlasTileSize, height: atlasTileSize, channels: 1 },
    })
    .png()
    .toBuffer()
  const tile = await sharp(source.data)
    .resize(atlasTileSize, atlasTileSize, { fit: 'fill' })
    .composite([
      { input: maskedGenerated, left: 0, top: 0 },
      { input: overlay.data, left: 0, top: 0 },
    ])
    .png()
    .toBuffer()
  return { contentType: 'image/png', data: tile }
}

const tilePaths = (tile, variant = defaultAtlasVariant) => {
  return versionedTilePaths(tile, generationVersion, variant)
}

const versionedTilePaths = (tile, version, variant = defaultAtlasVariant) => {
  const directory = path.join(cacheDirectory, String(tile.zoom), String(tile.x), String(tile.y))
  return {
    directory,
    image: path.join(directory, path.basename(atlasImageKey(tile, version, variant))),
    metadata: path.join(directory, path.basename(atlasMetadataKey(tile, version, variant))),
  }
}

const legacyTilePaths = tile => {
  const directory = path.join(cacheDirectory, String(tile.zoom), String(tile.x), String(tile.y))
  return {
    directory,
    image: path.join(directory, `${tile.scene}.image`),
    metadata: path.join(directory, `${tile.scene}.json`),
  }
}

const readCachedTile = async (paths) => {
  try {
    const cached = JSON.parse(await readFile(paths.metadata, 'utf8'))
    const imageMetadata = await sharp(paths.image).metadata()
    if (!imageMetadata.width || !imageMetadata.height) return null
    return { ...cached, paths }
  } catch {
    return null
  }
}

const getCachedTile = async tile => {
  const cached = await readCachedTile(tilePaths(tile))
  return cached ? { ...cached, version: generationVersion } : null
}
const getLegacyCachedTile = tile => readCachedTile(legacyTilePaths(tile))
const getVersionedCachedTile = async (tile, version, variant = defaultAtlasVariant) => {
  if (!isSupportedCacheVersion(version)) return null
  const cached = await readCachedTile(versionedTilePaths(tile, version, variant))
  return cached ? { ...cached, version, variant } : null
}
const getVersionedCachedTiles = async (tile, version) => {
  const directory = versionedTilePaths(tile, version).directory
  const scenePattern = tile.scene.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const files = await readdir(directory)
    const variants = files.flatMap(file => {
      const match = file.match(new RegExp(`^${scenePattern}\\.v${version}(?:\\.([a-z0-9-]{1,64}))?\\.json$`))
      return match ? [match[1] ?? defaultAtlasVariant] : []
    })
    return (await Promise.all(variants.map(async variant => {
      const cached = await getVersionedCachedTile(tile, version, variant)
      return cached ? { ...cached, tile } : null
    }))).filter(Boolean)
  } catch {
    return []
  }
}

const requestedCacheVersion = request =>
  parseRequestedCacheVersion(requestSearchParams(request))

const findCachedTile = async tile => {
  const cachedTiles = (await Promise.all(
    readableCacheVersions.flatMap(version => atlasSceneNames.map(async scene =>
      getVersionedCachedTiles({ ...tile, scene }, version),
    )),
  )).flat()
  if (!cachedTiles.length) return null
  return cachedTiles[Math.floor(Math.random() * cachedTiles.length)]
}

const listCachedTiles = async (requestedVersion = generationVersion) => {
  const cachedTiles = new Set<string>()
  const versionedTiles = []
  try {
    const zooms = await readdir(cacheDirectory, { withFileTypes: true })
    for (const zoom of zooms) {
      if (!zoom.isDirectory() || Number(zoom.name) !== atlasZoom) continue
      const xDirectories = await readdir(path.join(cacheDirectory, zoom.name), { withFileTypes: true })
      for (const xDirectory of xDirectories) {
        if (!xDirectory.isDirectory() || !/^\d+$/.test(xDirectory.name)) continue
        const x = Number(xDirectory.name)
        const yDirectories = await readdir(path.join(cacheDirectory, zoom.name, xDirectory.name), { withFileTypes: true })
        for (const yDirectory of yDirectories) {
          if (!yDirectory.isDirectory() || !/^\d+$/.test(yDirectory.name)) continue
          const y = Number(yDirectory.name)
          const directory = path.join(cacheDirectory, zoom.name, xDirectory.name, yDirectory.name)
          const metadataFiles = await readdir(directory)
          for (const metadataFile of metadataFiles) {
            const currentMatch = metadataFile.match(
              /^(.+)\.v(\d+)(?:\.([a-z0-9-]{1,64}))?\.json$/,
            )
            if (!currentMatch) continue
            const scene = currentMatch[1]
            const version = Number(currentMatch[2])
            const variant = currentMatch[3] ?? defaultAtlasVariant
            if (isSupportedCacheVersion(version))
              versionedTiles.push({ scene, zoom: atlasZoom, x, y, version, variant })
          }
        }
      }
    }

    const tileCount = 2 ** atlasZoom
    for (const tile of versionedTiles) {
      if (
        tile.version !== requestedVersion ||
        !atlasScenes[tile.scene] ||
        tile.x >= tileCount ||
        tile.y >= tileCount
      ) continue
      const cached = await getVersionedCachedTile(tile, tile.version, tile.variant)
      if (cached) {
        cachedTiles.add(JSON.stringify({
          ...tile,
          url: atlasTileUrl(tile, tile.version, tile.variant),
          contentBounds: cached.contentBounds ?? null,
        }))
      }
    }
  } catch {
    // An empty cache is expected on a fresh development server.
  }

  return [...cachedTiles].map(entry => JSON.parse(entry))
}

const atlasTilesAtZoom = atlasTileCount()

const sceneGridPositions = position => {
  const positions = []
  for (let yOffset = -atlasSceneGridRadius; yOffset <= atlasSceneGridRadius; yOffset += 1) {
    const y = position.y + yOffset
    if (y < 0 || y >= atlasTilesAtZoom) continue
    for (let xOffset = -atlasSceneGridRadius; xOffset <= atlasSceneGridRadius; xOffset += 1) {
      positions.push({
        x: (position.x + xOffset + atlasTilesAtZoom) % atlasTilesAtZoom,
        y,
      })
    }
  }
  return positions
}

const cachedScenesInGrid = async position => {
  const sceneLists = await Promise.all(sceneGridPositions(position).map(async ({ x, y }) => {
    try {
      const files = await readdir(path.join(cacheDirectory, String(atlasZoom), String(x), String(y)))
      return files.flatMap(fileName => {
        const match = fileName.match(/^(.+)\.v(\d+)\.json$/)
        const version = Number(match?.[2])
        const scene = match?.[1]
        return scene && atlasScenes[scene] && isReadableCacheVersion(version)
          ? [scene]
          : []
      })
    } catch {
      return []
    }
  }))
  return [...new Set(sceneLists.flat())]
}

const atlasPrompt = (scene, hasSea) => {
  const seaRule = atlasSeaScenes.has(scene)
    ? hasSea
      ? 'The tile contains visible sea or coastal water; place this sea-side event beside that water and include a small amount of the sea within the tile.'
      : 'This tile does not contain visible sea or coastal water. Do not create the sea-side event; preserve the map unchanged.'
    : ''

  const tileRule = `Create ${atlasScenes[scene]} across the permitted land in this single z18 map tile, leaving a 10% safety margin.`
  const continuityRule =
    'This image is a cropped window onto one continuous world map, never a complete, framed illustration: neighbouring map tiles continue beyond every edge.'
  const referenceRule =
    'The first image is the source map. The second image is a zoning guide: green areas are safe to transform, while red areas are locked and must remain unchanged. Use the guide as an instruction, not as artwork.'
  const preservationRule =
    'Preserve the exact tile size, orientation, scale, coastline, water, roads, paths, boundaries, and labels.'
  const edgeRule =
    'At each image edge, preserve the source map and make any partial terrain, tree canopy, vegetation cluster, building, or event detail read as naturally continuing beyond the crop; never deliberately terminate an object, tree row, field, or vignette at the tile boundary.'
  const infrastructureRule =
    'Treat every existing road and path as hard pixel-registered infrastructure: trace its original centerline exactly, keep every junction and curve in the same position, and do not cover it with buildings, scenery, texture, or event artwork.'
  const roadRestrictionRule =
    'Do not invent, move, bend, widen, recolour, or erase any locked path or road, and do not draw road-like lines in the green areas.'
  const avoidRule =
    'Do not add text, shadows, gradients, lighting, borders, frames, or tile-shaped background patches.'
  const styleRule =
    'Use a flat, planimetric, strict overhead view integrated into the existing cartography.'

  return [
    tileRule,
    continuityRule,
    referenceRule,
    preservationRule,
    edgeRule,
    infrastructureRule,
    roadRestrictionRule,
    avoidRule,
    styleRule,
    atlasColourDirection,
    seaRule,
  ]
    .filter(Boolean)
    .join(' ')
}

const generateTile = async (tile, sourceImage, guideImage, safeMask, lineOverlay, contentBounds) => {
  const startedAt = performance.now()
  const generatedImage = await createOpenRouterClient().editImage({
    prompt: atlasPrompt(tile.scene, tile.hasSea),
    sourceImage,
    referenceImages: [guideImage],
  })
  const generatedAt = performance.now()

  const variant = randomUUID()
  const { directory, image, metadata } = tilePaths(tile, variant)
  const composedImage = await composeTileImage(
    sourceImage,
    generatedImage,
    safeMask,
    lineOverlay,
  )
  const contentType = composedImage.contentType
  const cacheEntry = {
    contentType,
    generationVersion,
    generatedAt: new Date().toISOString(),
    contentBounds: normalizeContentBounds(contentBounds),
    mask: 'vector-safe-zones',
    outputSize: { width: atlasTileSize, height: atlasTileSize },
  }
  await mkdir(directory, { recursive: true })
  // Replace each cache artifact atomically so readers never observe a
  // truncated image or metadata document.
  await atomicWriteFile(image, composedImage.data)
  await atomicWriteFile(metadata, JSON.stringify(cacheEntry))
  console.info(
    `[atlas] ${tile.scene}/${tile.zoom}/${tile.x}/${tile.y} generated in ` +
      `${Math.round(generatedAt - startedAt)}ms; cached in ` +
      `${Math.round(performance.now() - generatedAt)}ms`,
  )
  return { ...cacheEntry, tile, variant }
}

const serveCachedTile = async (request, response, tile) => {
  if (request.method !== 'GET') return false
  const requestedVersion = requestedCacheVersion(request)
  const variant = requestedAtlasVariant(requestSearchParams(request))
  const cached = Number.isInteger(requestedVersion)
    ? await getVersionedCachedTile(tile, requestedVersion, variant)
    : await getCachedTile(tile) ?? await getLegacyCachedTile(tile)
  if (!cached) {
    sendError(response, 404, 'This atlas tile has not been generated yet.')
    return true
  }

  const image = await readFile(cached.paths.image)
  response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': cached.contentType,
  })
  response.end(image)
  return true
}

const serveCacheStatus = async (request, response, tile) => {
  if (request.method !== 'GET') {
    sendError(response, 405, 'Cache status only supports GET requests.')
    return true
  }
  const [cached, scenes] = await Promise.all([
    findCachedTile(tile),
    cachedScenesInGrid(tile),
  ])
  sendJson(
    response,
    200,
    cacheStatusPayload({ cached, scenes }),
    { 'cache-control': 'public, max-age=10, stale-while-revalidate=30' },
  )
  return true
}

const serveCacheStatusBatch = async (request, response) => {
  if (request.method !== 'POST') return false
  try {
    const body = await readRequestBody(request)
    if (!Array.isArray(body.tiles) || !body.tiles.length)
      throw new Error('At least one atlas tile is required.')
    if (body.tiles.length > maximumCacheStatusBatchSize)
      throw new Error(`At most ${maximumCacheStatusBatchSize} atlas tiles can be checked at once.`)

    const positions = new Map()
    body.tiles.forEach(value => {
      const position = {
        zoom: Number(value?.zoom),
        x: Number(value?.x),
        y: Number(value?.y),
      }
      if (!isValidAtlasPosition(position))
        throw new Error('The cache-status request contains an invalid atlas tile.')
      positions.set(`${position.zoom}/${position.x}/${position.y}`, position)
    })
    const statuses = await Promise.all(
      [...positions.values()].map(async position => {
        const [cached, scenes] = await Promise.all([
          findCachedTile(position),
          cachedScenesInGrid(position),
        ])
        return cacheStatusPayload({ cached, scenes })
      }),
    )
    sendJson(response, 200, { statuses })
  } catch (error) {
    sendError(
      response,
      400,
      error instanceof Error ? error.message : 'Could not read the cache-status request.',
    )
  }
  return true
}

const applicationRequestIsAllowed = (request, requireOrigin = false) =>
  isAllowedApplicationRequest({
    requestHost: request.headers.host,
    origin: request.headers.origin,
    allowedOrigin,
    localDevelopment: !isProduction,
    requireOrigin,
  })

const deleteCachedTile = async (request, response, tile) => {
  if (request.method !== 'DELETE') return false
  if (rejectAdminAccess(request, response, { requireOrigin: true, requireCsrf: true })) return true

  const releaseTileLock = await acquireTileLock(tile)
  try {
    const requestedVersion = requestedCacheVersion(request)
    const variant = requestedAtlasVariant(requestSearchParams(request))
    const cached = Number.isInteger(requestedVersion)
      ? await getVersionedCachedTile(tile, requestedVersion, variant)
      : await getCachedTile(tile) ?? await getLegacyCachedTile(tile)
    if (!cached) {
      sendError(response, 404, 'This atlas tile is not cached.')
      return true
    }

    const { directory, image, metadata } = cached.paths
    await unlink(image)
    await unlink(metadata)
    try {
      await rmdir(directory)
    } catch {
      // Keep the tile directory when another scene is still cached there.
    }
    sendJson(response, 200, { deleted: true, tile })
    console.info(`[atlas] deleted ${tile.scene}/${tile.zoom}/${tile.x}/${tile.y}`)
    return true
  } finally {
    releaseTileLock()
  }
}

const serveAtlasTileRequest = async (request, response, tile) => {
  if (request.method === 'DELETE') return deleteCachedTile(request, response, tile)

  if (request.method === 'GET') {
    await serveCachedTile(request, response, tile)
    return true
  }

  const rerender = new URL(request.url, 'http://localhost').searchParams.get('rerender') === 'true'
  if (rerender) {
    if (rejectAdminAccess(request, response, { requireOrigin: true, requireCsrf: true })) return true
  }
  return generateAtlasTile(request, response, tile, rerender)
}

const generateAtlasTile = async (request, response, tile, force = false) => {
  if (request.method !== 'POST') return false

  // A client may retry generation for a tile that was generated by an earlier
  // request. Resolve that case before validating the generation request so a
  // cached tile never depends on OpenRouter configuration.
  const cached = force ? null : await findCachedTile(tile)
  if (cached) {
    sendJson(response, 200, cachedTilePayload(cached))
    return true
  }

  if (!applicationRequestIsAllowed(request)) {
    sendError(response, 403, 'Image generation is restricted to the configured application domain.')
    return true
  }

  const { sourceImage, guideImage, safeMask, lineOverlay, contentBounds, hasSea } = await readRequestBody(request)
  if (typeof sourceImage !== 'string' || !sourceImage.startsWith('data:image/')) {
    sendError(response, 400, 'A PNG or JPEG data URL is required as the tile source image.')
    return true
  }
  if ([guideImage, safeMask, lineOverlay].some(value => typeof value !== 'string' || !value.startsWith('data:image/'))) {
    sendError(response, 400, 'A guide image, safe-zone mask, and path overlay are required.')
    return true
  }

  // Serialize the cache re-check and generation. A concurrent request for
  // this position waits and then receives the newly cached result.
  const releaseTileLock = await acquireTileLock(tile)
  try {
    const lockedCached = force ? null : await findCachedTile(tile)
    if (lockedCached) {
      sendJson(response, 200, cachedTilePayload(lockedCached))
      return true
    }

    const reservation = reserveGeneration(getClientKey(request))
    if (!reservation.allowed) {
      sendRateLimit(response, reservation)
      return true
    }

    try {
      const generated = await generateTile(
        { ...tile, hasSea: hasSea === true },
        sourceImage,
        guideImage,
        safeMask,
        lineOverlay,
        contentBounds,
      )
      sendJson(response, 200, cachedTilePayload({
        tile: generated.tile,
        version: generated.generationVersion,
        variant: generated.variant,
        contentType: generated.contentType,
        contentBounds: generated.contentBounds,
      }))
      return true
    } finally {
      reservation.release()
    }
  } finally {
    releaseTileLock()
  }
}

const serveProductionAsset = async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1)
  const filePath = path.resolve(productionDirectory, requestedFile)

  if (isPathWithin(productionDirectory, filePath)) {
    try {
      const file = await readFile(filePath)
      response.writeHead(200, {
        'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
      })
      response.end(file)
      return
    } catch {
      // Serve the single-page app below.
    }
  }

  const app = await readFile(path.join(productionDirectory, 'index.html'))
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(app)
}

const proxyMapAsset = async (request, response, pathname, search = '') => {
  const proxyOrigin = new URL(
    request.url,
    `http://${request.headers.host ?? 'localhost'}`,
  ).origin
  const upstreamUrl = new URL(
    `${pathname.slice(tileProxyPrefix.length)}${search}`,
    tileOrigin,
  )
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: {
      // The basemap service authorizes the production application origin. The
      // browser still talks to this server same-origin during local dev.
      Origin: 'https://romanticatlas.hype.hk',
    },
  })

  if (pathname === tileJsonPath && upstreamResponse.ok) {
    const tileJson = await upstreamResponse.json()
    const tiles = Array.isArray(tileJson.tiles) ? tileJson.tiles : []
    tileJson.tiles = tiles.map(tileUrl => {
      if (typeof tileUrl !== 'string') return tileUrl
      const upstreamTileUrl = new URL(tileUrl, tileOrigin)
      if (upstreamTileUrl.origin !== tileOrigin) return tileUrl
      const tilePath = decodeURIComponent(upstreamTileUrl.pathname)
      return `${proxyOrigin}${tileProxyPrefix}${tilePath}${upstreamTileUrl.search}`
    })

    response.writeHead(upstreamResponse.status, {
      'cache-control': upstreamResponse.headers.get('cache-control') ?? 'no-cache',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(tileJson))
    return
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer())
  const contentType = upstreamResponse.headers.get('content-type')
  const cacheControl = upstreamResponse.headers.get('cache-control')
  response.writeHead(upstreamResponse.status, {
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(cacheControl ? { 'cache-control': cacheControl } : {}),
  })
  response.end(body)
}

const vite = isProduction
  ? null
  : await createViteServer({ root: rootDirectory, server: { middlewareMode: true } })

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname

    if (request.method === 'POST' && pathname === '/api/share-maps') {
      await createSharedMap(request, response)
      return
    }

    const sharedMapMatch = pathname.match(localSharedMapPattern)
    if (request.method === 'GET' && sharedMapMatch) {
      await serveSharedMap(response, `${sharedMapMatch[1]}.png`)
      return
    }

    if (request.method === 'GET' && pathname === '/api/atlas-tiles/cached') {
      response.setHeader('cache-control', 'no-store')
      const adminMode = isAdminModeEnabled(request)
      const diagnosticsMode = diagnosticsModeEnabled(request)
      if (!adminMode && !diagnosticsMode) {
        sendJson(response, 200, cachedTilesPayload({
          adminMode: false,
          diagnosticsMode: false,
          version: null,
          tiles: [],
        }))
        return
      }
      if (adminMode && rejectAdminAccess(request, response)) return
      if (adminMode) ensureCsrfCookie(request, response)
      const version = requestedCacheVersion(request) ?? generationVersion
      const tiles = await listCachedTiles(version)
      sendJson(response, 200, cachedTilesPayload({
        adminMode,
        diagnosticsMode,
        version,
        tiles,
      }))
      return
    }

    if (pathname === '/api/atlas-tiles/cache-status') {
      await serveCacheStatusBatch(request, response)
      return
    }

    const tilePosition = parseAtlasPositionPath(pathname)
    if (tilePosition) {
      await serveCacheStatus(request, response, tilePosition)
      return
    }

    const tile = parseAtlasTilePath(
      pathname,
      (scene): scene is keyof typeof atlasScenes => Boolean(atlasScenes[scene]),
    )

    if (tile && pathname.startsWith('/generated-tiles/')) {
      await serveCachedTile(request, response, tile)
      return
    }

    if (tile && pathname.startsWith('/api/atlas-tiles/')) {
      await serveAtlasTileRequest(request, response, tile)
      return
    }

    if (request.method === 'GET' && pathname === tileJsonPath) {
      await proxyMapAsset(request, response, pathname)
      return
    }

    if (request.method === 'GET' && vectorTilePattern.test(pathname)) {
      await proxyMapAsset(request, response, pathname, new URL(request.url, 'http://localhost').search)
      return
    }

    if (isProduction) {
      await serveProductionAsset(request, response)
      return
    }

    vite.middlewares(request, response, error => {
      if (error) {
        vite.ssrFixStacktrace(error)
        sendError(response, 500, error.message)
      }
    })
  } catch (error) {
    console.error(error)
    sendError(response, 500, error instanceof Error ? error.message : 'Unexpected server error.')
  }
})

const port = Number(process.env.PORT ?? 5173)
server.listen(port, '127.0.0.1', () => {
  console.log(`Hong Kong Map is running at http://127.0.0.1:${port}`)
})
