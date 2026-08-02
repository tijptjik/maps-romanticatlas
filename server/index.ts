import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createServer as createViteServer } from 'vite'

import { createOpenRouterClient } from './openrouter-client.ts'
import { atlasSeaScenes, atlasSceneNames, atlasScenes } from '../src/atlas-scenes.ts'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const productionDirectory = path.join(rootDirectory, 'dist')
const atlasZoom = 18
const atlasTileSize = 512
const generationVersion = 3
const isProduction = process.env.NODE_ENV === 'production'
const isAdminModeEnabled = process.env.ATLAS_ADMIN_MODE === 'true'
const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const atlasColourDirection = 'Keep the surrounding map and its Victorian-brown palette unchanged. Within the event, use a lively, carefully balanced storybook palette with warm parchment and sandy cream foundations, plus clear accents of cobalt blue, coral vermilion, marigold yellow, leafy sage green, dusty rose, and soft lilac. Keep the colours richly pigmented, crisp, and pleasantly contrasty so the event stands out, while remaining slightly softened and paper-printed rather than neon, fluorescent, garish, or oversaturated.'
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const sendJson = (response, statusCode, data) => {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

const sendError = (response, statusCode, message) => sendJson(response, statusCode, { error: message })

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

const parseImageDataUrl = dataUrl => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s)
  if (!match) throw new Error('The tile source image must be a valid image data URL.')
  return { contentType: match[1], data: Buffer.from(match[2], 'base64') }
}

const composeTileImage = async (sourceImage, generatedImage, safeMask, lineOverlay) => {
  const source = parseImageDataUrl(sourceImage)
  const generated = generatedImage.data
  const mask = parseImageDataUrl(safeMask)
  const overlay = parseImageDataUrl(lineOverlay)
  const alpha = await sharp(mask.data)
    .resize(atlasTileSize, atlasTileSize, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .greyscale()
    .blur(10)
    .raw()
    .toBuffer()
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
  const directory = path.join(cacheDirectory, String(tile.zoom), String(tile.x), String(tile.y))
  return {
    directory,
    image: path.join(directory, `${tile.scene}.v${generationVersion}.image`),
    metadata: path.join(directory, `${tile.scene}.v${generationVersion}.json`),
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

const getCachedTile = tile => readCachedTile(tilePaths(tile))
const getLegacyCachedTile = tile => readCachedTile(legacyTilePaths(tile))

const cachedTileUrl = tile =>
  `/generated-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}`

const findCachedTile = async tile => {
  const cachedTiles = []
  for (const scene of atlasSceneNames) {
    const candidate = { ...tile, scene }
    const cached = await getCachedTile(candidate)
    if (cached) cachedTiles.push({ ...cached, tile: candidate })
  }
  if (!cachedTiles.length) return null
  return cachedTiles[Math.floor(Math.random() * cachedTiles.length)]
}

const listCachedTiles = async () => {
  const cachedTiles = new Set<string>()
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
          const scenes = new Set<string>()
          for (const metadataFile of metadataFiles) {
            const currentMatch = metadataFile.match(/^(.+)\.v\d+\.json$/)
            const legacyMatch = metadataFile.match(/^(.+)\.json$/)
            const scene = currentMatch?.[1] ?? legacyMatch?.[1]
            if (scene) scenes.add(scene)
          }
          for (const scene of scenes) {
            const tileCount = 2 ** atlasZoom
            if (!atlasScenes[scene] || x >= tileCount || y >= tileCount) continue
            const tile = { scene, zoom: atlasZoom, x, y }
            const cached = await getCachedTile(tile) ?? await getLegacyCachedTile(tile)
            if (cached) {
              cachedTiles.add(JSON.stringify({
                scene,
                zoom: atlasZoom,
                x,
                y,
                url: cachedTileUrl({ scene, zoom: atlasZoom, x, y }),
                contentBounds: cached.contentBounds ?? null,
              }))
            }
          }
        }
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
  await writeFile(image, composedImage.data)
  await writeFile(metadata, JSON.stringify(cacheEntry))
  console.info(
    `[atlas] ${tile.scene}/${tile.zoom}/${tile.x}/${tile.y} generated in ` +
      `${Math.round(generatedAt - startedAt)}ms; cached in ` +
      `${Math.round(performance.now() - generatedAt)}ms`,
  )
  return { ...cacheEntry, tile }
}

const serveCachedTile = async (request, response, tile) => {
  if (request.method !== 'GET') return false
  const cached = await getCachedTile(tile) ?? await getLegacyCachedTile(tile)
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
    url: cached ? cachedTileUrl(cached.tile) : null,
    scene: cached?.tile.scene ?? null,
    contentBounds: cached?.contentBounds ?? null,
  })
  return true
}

const isAllowedApplicationRequest = request => {
  const origin = request.headers.origin
  const allowedOrigin = process.env.ATLAS_ALLOWED_ORIGIN ?? 'https://romanticatlas.hype.hk'
  const allowedHost = new URL(allowedOrigin).host
  const isLocalDevelopmentRequest = !isProduction && localOriginPattern.test(origin ?? '')
  const hostIsAllowed = request.headers.host === allowedHost ||
    (!isProduction && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(request.headers.host ?? ''))
  const originIsAllowed = !origin || origin === allowedOrigin || isLocalDevelopmentRequest
  return originIsAllowed && hostIsAllowed
}

const deleteCachedTile = async (request, response, tile) => {
  if (request.method !== 'DELETE') return false
  if (!isAdminModeEnabled) {
    sendError(response, 403, 'Atlas admin mode is disabled.')
    return true
  }
  if (!isAllowedApplicationRequest(request)) {
    sendError(response, 403, 'Cache management is restricted to the configured application domain.')
    return true
  }

  const cached = await getCachedTile(tile) ?? await getLegacyCachedTile(tile)
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
      url: cachedTileUrl(cached.tile),
      scene: cached.tile.scene,
      contentBounds: cached.contentBounds ?? null,
    })
    return true
  }

  const origin = request.headers.origin
  const allowedOrigin = process.env.ATLAS_ALLOWED_ORIGIN ?? 'https://romanticatlas.hype.hk'
  const allowedHost = new URL(allowedOrigin).host
  const isLocalDevelopmentRequest = !isProduction && localOriginPattern.test(origin ?? '')
  const hostIsAllowed = request.headers.host === allowedHost ||
    (!isProduction && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(request.headers.host ?? ''))
  const originIsAllowed = !origin || origin === allowedOrigin || isLocalDevelopmentRequest
  if (!originIsAllowed || !hostIsAllowed) {
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

  const generated = await generateTile(
    { ...tile, hasSea: hasSea === true },
    sourceImage,
    guideImage,
    safeMask,
    lineOverlay,
    contentBounds,
  )
  sendJson(response, 200, {
    url: cachedTileUrl(generated.tile),
    scene: generated.tile.scene,
    contentBounds: generated.contentBounds,
  })
  return true
}

const serveProductionAsset = async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1)
  const filePath = path.resolve(productionDirectory, requestedFile)

  if (filePath.startsWith(productionDirectory)) {
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
      const tiles = await listCachedTiles()
      sendJson(response, 200, {
        adminMode: isAdminModeEnabled,
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
