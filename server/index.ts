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

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const productionDirectory = path.join(rootDirectory, 'dist')
const atlasZoom = 18
const atlasTileSize = 512
const generationVersion = 4
const readableCacheVersions = [2, 3, 4]
const generationWindowMs = 180_000
const generationsPerClient = 3
const concurrentGenerationsPerClient = 3
const isProduction = process.env.NODE_ENV === 'production'
const isAdminModeEnabled = process.env.ATLAS_ADMIN_MODE === 'true'
const adminToken = process.env.ATLAS_ADMIN_TOKEN?.trim() || null
const csrfCookieName = 'atlas_csrf'
const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const allowedOrigin = process.env.ATLAS_ALLOWED_ORIGIN ?? 'https://romanticatlas.hype.hk'
const allowedHost = new URL(allowedOrigin).host
const isAllowedOrigin = origin =>
  origin === allowedOrigin || (!isProduction && localOriginPattern.test(origin ?? ''))
const atlasColourDirection = 'Keep the surrounding map and its Victorian-brown palette unchanged. Within the event, use a lively, carefully balanced storybook palette with warm parchment and sandy cream foundations, plus clear accents of cobalt blue, coral vermilion, marigold yellow, leafy sage green, dusty rose, and soft lilac. Keep the colours richly pigmented, crisp, and pleasantly contrasty so the event stands out, while remaining slightly softened and paper-printed rather than neon, fluorescent, garish, or oversaturated.'
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const tileLocks = new Map<string, Promise<void>>()
const clientGenerationState = new Map<string, { active: number; startedAt: number[] }>()

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
  const now = Date.now()
  const state = clientGenerationState.get(clientKey) ?? { active: 0, startedAt: [] }
  state.startedAt = state.startedAt.filter(startedAt => now - startedAt < generationWindowMs)

  if (state.active >= concurrentGenerationsPerClient) {
    clientGenerationState.set(clientKey, state)
    return {
      allowed: false,
      retryAfterMs: generationWindowMs,
      reason:
        'You already have an atlas tile clearing in progress.\n' +
        'Allow 3 minutes for its dramatic exit',
    }
  }

  if (state.startedAt.length >= generationsPerClient) {
    const retryAfterMs = Math.max(1, generationWindowMs - (now - state.startedAt[0]))
    clientGenerationState.set(clientKey, state)
    return {
      allowed: false,
      retryAfterMs,
      reason: 'Three tile clearings are complete. The fog is being cleared elsewhere in the city; please wait around three minutes.',
    }
  }

  state.active += 1
  state.startedAt.push(now)
  clientGenerationState.set(clientKey, state)
  return {
    allowed: true,
    release: () => {
      const current = clientGenerationState.get(clientKey)
      if (!current) return
      current.active = Math.max(0, current.active - 1)
      if (!current.active && !current.startedAt.length) clientGenerationState.delete(clientKey)
    },
  }
}

const sendRateLimit = (response, limit) => {
  const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000))
  response.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'retry-after': String(retryAfterSeconds),
    'x-ratelimit-limit': String(generationsPerClient),
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

const sendJson = (response, statusCode, data) => {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

const sendError = (response, statusCode, message) => sendJson(response, statusCode, { error: message })

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

const getBearerToken = request => {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string') return null
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] ?? null
}

const requireAdminAuthentication = (request, response) => {
  if (!adminToken) {
    sendError(response, 503, 'Atlas admin authentication is not configured.')
    return false
  }

  if (!tokensMatch(getBearerToken(request) ?? '', adminToken)) {
    response.setHeader('www-authenticate', 'Bearer realm="atlas-admin"')
    sendError(response, 401, 'Atlas admin authentication is required.')
    return false
  }

  return true
}

const getCookie = (request, name) => {
  const cookieHeader = request.headers.cookie
  if (typeof cookieHeader !== 'string') return null
  const cookie = cookieHeader.split(';').find(entry => entry.trim().startsWith(`${name}=`))
  return cookie ? cookie.trim().slice(name.length + 1) : null
}

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
  const existingToken = getCookie(request, csrfCookieName)
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
  const cookieToken = getCookie(request, csrfCookieName)
  return typeof headerToken === 'string' && isValidCsrfToken(cookieToken) &&
    tokensMatch(headerToken, cookieToken)
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

const parseTileRequest = pathname => {
  const match = pathname.match(/^\/(?:api\/atlas-tiles|generated-tiles)\/(\d+)\/(\d+)\/(\d+)\/([^/]+)$/)
  if (!match) return null

  const [, zoom, x, y, scene] = match
  if (!atlasScenes[scene]) return null
  const numericZoom = Number(zoom)
  const numericX = Number(x)
  const numericY = Number(y)
  const tileCount = 2 ** numericZoom
  if (numericZoom !== atlasZoom || numericX < 0 || numericY < 0 || numericX >= tileCount || numericY >= tileCount) {
    return null
  }

  return { scene, zoom: numericZoom, x: numericX, y: numericY }
}

const parseTilePositionRequest = pathname => {
  const match = pathname.match(/^\/api\/atlas-tiles\/cache-status\/(\d+)\/(\d+)\/(\d+)$/)
  if (!match) return null

  const [, zoom, x, y] = match
  const numericZoom = Number(zoom)
  const numericX = Number(x)
  const numericY = Number(y)
  const tileCount = 2 ** numericZoom
  if (numericZoom !== atlasZoom || numericX < 0 || numericY < 0 || numericX >= tileCount || numericY >= tileCount) {
    return null
  }

  return { zoom: numericZoom, x: numericX, y: numericY }
}

const tilePaths = tile => {
  return versionedTilePaths(tile, generationVersion)
}

const versionedTilePaths = (tile, version) => {
  const directory = path.join(cacheDirectory, String(tile.zoom), String(tile.x), String(tile.y))
  return {
    directory,
    image: path.join(directory, `${tile.scene}.v${version}.image`),
    metadata: path.join(directory, `${tile.scene}.v${version}.json`),
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
const getVersionedCachedTile = async (tile, version) => {
  if (!Number.isInteger(version) || version < 1 || version > generationVersion) return null
  const cached = await readCachedTile(versionedTilePaths(tile, version))
  return cached ? { ...cached, version } : null
}

const cachedTileUrl = (tile, version = generationVersion) =>
  `/generated-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}?version=${version}`

const requestedCacheVersion = request => {
  const value = new URL(request.url, 'http://localhost').searchParams.get('version')
  return value === null ? null : Number(value)
}

const findCachedTile = async tile => {
  const cachedTiles = (await Promise.all(
    readableCacheVersions.flatMap(version => atlasSceneNames.map(async scene => {
      const candidate = { ...tile, scene }
      const cached = await getVersionedCachedTile(candidate, version)
      return cached ? { ...cached, tile: candidate } : null
    })),
  )).filter(Boolean)
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
              /^(.+)\.v(\d+)\.json$/,
            )
            if (!currentMatch) continue
            const scene = currentMatch[1]
            const version = Number(currentMatch[2])
            if (version <= generationVersion)
              versionedTiles.push({ scene, zoom: atlasZoom, x, y, version })
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
      const cached = await getVersionedCachedTile(tile, tile.version)
      if (cached) {
        cachedTiles.add(JSON.stringify({
          ...tile,
          url: cachedTileUrl(tile, tile.version),
          contentBounds: cached.contentBounds ?? null,
        }))
      }
    }
  } catch {
    // An empty cache is expected on a fresh development server.
  }

  return [...cachedTiles].map(entry => JSON.parse(entry))
}

const atlasPrompt = (scene, hasSea) => {
  const seaRule = atlasSeaScenes.has(scene)
    ? hasSea
      ? 'The tile contains visible sea or coastal water; place this sea-side event beside that water and include a small amount of the sea within the tile.'
      : 'This tile does not contain visible sea or coastal water. Do not create the sea-side event; preserve the map unchanged.'
    : ''

  return `Create ${atlasScenes[scene]} across the permitted land in this complete single z18 map tile, leaving a 10% safety margin. The first image is the source map. The second image is a zoning guide: green areas are safe to transform, while red areas are locked and must remain unchanged. Use the guide as an instruction, not as artwork. Preserve the exact tile size, orientation, scale, coastline, water, roads, paths, boundaries, and labels. Treat every existing road and path as hard pixel-registered infrastructure: trace its original centerline exactly, keep every junction and curve in the same position, and do not cover it with buildings, scenery, texture, or event artwork. Do not invent, move, bend, widen, recolour, or erase any locked path or road, and do not draw road-like lines in the green areas. Do not add text, shadows, gradients, lighting, borders, frames, or tile-shaped background patches. Use a flat, planimetric, strict overhead view integrated into the existing cartography. ${atlasColourDirection} ${seaRule}`
}

const normalizeContentBounds = value => {
  const x = Number(value?.x)
  const y = Number(value?.y)
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null

  const left = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(x)))
  const top = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(y)))
  const right = Math.max(left + 1, Math.min(atlasTileSize, Math.ceil(x + width)))
  const bottom = Math.max(top + 1, Math.min(atlasTileSize, Math.ceil(y + height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const generateTile = async (tile, sourceImage, guideImage, safeMask, lineOverlay, contentBounds) => {
  const cached = await findCachedTile(tile)
  if (cached) return cached

  const startedAt = performance.now()
  const generatedImage = await createOpenRouterClient().editImage({
    prompt: atlasPrompt(tile.scene, tile.hasSea),
    sourceImage,
    referenceImages: [guideImage],
  })
  const generatedAt = performance.now()

  const { directory, image, metadata } = tilePaths(tile)
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
  return { ...cacheEntry, tile }
}

const serveCachedTile = async (request, response, tile) => {
  if (request.method !== 'GET') return false
  const requestedVersion = requestedCacheVersion(request)
  const cached = Number.isInteger(requestedVersion)
    ? await getVersionedCachedTile(tile, requestedVersion)
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
  const cached = await findCachedTile(tile)
  sendJson(response, 200, {
    cached: Boolean(cached),
    url: cached ? cachedTileUrl(cached.tile, cached.version) : null,
    scene: cached?.tile.scene ?? null,
    contentBounds: cached?.contentBounds ?? null,
  })
  return true
}

const isAllowedApplicationRequest = (request, requireOrigin = false) => {
  const origin = request.headers.origin
  const hostIsAllowed = request.headers.host === allowedHost ||
    (!isProduction && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(request.headers.host ?? ''))
  const originIsAllowed = requireOrigin
    ? isAllowedOrigin(origin)
    : !origin || isAllowedOrigin(origin)
  return originIsAllowed && hostIsAllowed
}

const deleteCachedTile = async (request, response, tile) => {
  if (request.method !== 'DELETE') return false
  if (!isAdminModeEnabled) {
    sendError(response, 403, 'Atlas admin mode is disabled.')
    return true
  }
  if (!requireAdminAuthentication(request, response)) return true
  if (!isAllowedApplicationRequest(request, true) || !hasValidCsrfRequest(request)) {
    sendError(response, 403, 'Cache management is restricted to the configured application domain.')
    return true
  }

  const releaseTileLock = await acquireTileLock(tile)
  try {
    const requestedVersion = requestedCacheVersion(request)
    const cached = Number.isInteger(requestedVersion)
      ? await getVersionedCachedTile(tile, requestedVersion)
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

  return generateAtlasTile(request, response, tile)
}

const generateAtlasTile = async (request, response, tile) => {
  if (request.method !== 'POST') return false

  // A client may retry generation for a tile that was generated by an earlier
  // request. Resolve that case before validating the generation request so a
  // cached tile never depends on OpenRouter configuration.
  const cached = await findCachedTile(tile)
  if (cached) {
    sendJson(response, 200, {
      url: cachedTileUrl(cached.tile, cached.version),
      scene: cached.tile.scene,
      contentBounds: cached.contentBounds ?? null,
    })
    return true
  }

  if (!isAllowedApplicationRequest(request)) {
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
    const lockedCached = await findCachedTile(tile)
    if (lockedCached) {
      sendJson(response, 200, {
        url: cachedTileUrl(lockedCached.tile, lockedCached.version),
        scene: lockedCached.tile.scene,
        contentBounds: lockedCached.contentBounds ?? null,
      })
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
      sendJson(response, 200, {
        url: cachedTileUrl(generated.tile, generated.generationVersion),
        scene: generated.tile.scene,
        contentBounds: generated.contentBounds,
      })
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

const vite = isProduction
  ? null
  : await createViteServer({ root: rootDirectory, server: { middlewareMode: true } })

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname

    if (request.method === 'GET' && pathname === '/api/atlas-tiles/cached') {
      response.setHeader('cache-control', 'no-store')
      if (isAdminModeEnabled && !requireAdminAuthentication(request, response)) return
      if (isAdminModeEnabled) ensureCsrfCookie(request, response)
      const requestedVersion = requestedCacheVersion(request)
      const version = Number.isInteger(requestedVersion) && requestedVersion >= 1 && requestedVersion <= generationVersion
        ? requestedVersion
        : generationVersion
      const tiles = await listCachedTiles(version)
      sendJson(response, 200, {
        adminMode: isAdminModeEnabled,
        version,
        preRenderedCount: tiles.length,
        tiles,
      })
      return
    }

    const tilePosition = parseTilePositionRequest(pathname)
    if (tilePosition) {
      await serveCacheStatus(request, response, tilePosition)
      return
    }

    const tile = parseTileRequest(pathname)

    if (tile && pathname.startsWith('/generated-tiles/')) {
      await serveCachedTile(request, response, tile)
      return
    }

    if (tile && pathname.startsWith('/api/atlas-tiles/')) {
      await serveAtlasTileRequest(request, response, tile)
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
