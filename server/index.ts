import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

import { createOpenRouterClient } from './openrouter-client.ts'
import { atlasScenes } from '../src/atlas-scenes.ts'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const productionDirectory = path.join(rootDirectory, 'dist')
const atlasZoom = 18
const isProduction = process.env.NODE_ENV === 'production'
const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const atlasPromptVersion = 'openai-edit-v1'
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
    if (size > 4_000_000) {
      throw new Error('The tile source image is too large.')
    }
    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const parseTileRequest = pathname => {
  const match = pathname.match(/^\/(?:api\/atlas-tiles|generated-tiles)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/)
  if (!match) return null

  const [, scene, zoom, x, y] = match
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

const tilePaths = tile => {
  const directory = path.join(cacheDirectory, atlasPromptVersion, tile.scene, String(tile.zoom), String(tile.x))
  return {
    directory,
    image: path.join(directory, `${tile.y}.image`),
    metadata: path.join(directory, `${tile.y}.json`),
  }
}

const getCachedTile = async tile => {
  try {
    const { metadata } = tilePaths(tile)
    return JSON.parse(await readFile(metadata, 'utf8'))
  } catch {
    return null
  }
}

const listCachedTiles = async () => {
  const cachedTiles = new Set<string>()
  try {
    const scenes = await readdir(path.join(cacheDirectory, atlasPromptVersion), { withFileTypes: true })
    for (const scene of scenes) {
      if (!scene.isDirectory() || !atlasScenes[scene.name]) continue
      const zooms = await readdir(path.join(cacheDirectory, atlasPromptVersion, scene.name), { withFileTypes: true })
      for (const zoom of zooms) {
        if (!zoom.isDirectory() || Number(zoom.name) !== atlasZoom) continue
        const xDirectories = await readdir(path.join(cacheDirectory, atlasPromptVersion, scene.name, zoom.name), { withFileTypes: true })
        for (const xDirectory of xDirectories) {
          if (!xDirectory.isDirectory() || !/^\d+$/.test(xDirectory.name)) continue
          const x = Number(xDirectory.name)
          const metadataFiles = await readdir(path.join(cacheDirectory, atlasPromptVersion, scene.name, zoom.name, xDirectory.name))
          for (const metadataFile of metadataFiles) {
            if (!metadataFile.endsWith('.json') || !/^\d+\.json$/.test(metadataFile)) continue
            const y = Number(metadataFile.slice(0, -5))
            const tileCount = 2 ** atlasZoom
            if (x < tileCount && y < tileCount) cachedTiles.add(`${atlasZoom}/${x}/${y}`)
          }
        }
      }
    }
  } catch {
    // An empty cache is expected on a fresh development server.
  }

  return [...cachedTiles].map(id => {
    const [zoom, x, y] = id.split('/').map(Number)
    return { zoom, x, y }
  })
}

const atlasPrompt = (scene, hasSea) => {
  const seaRule = scene === 'lighthouse'
    ? hasSea
      ? 'The tile contains visible sea or coastal water; place the lighthouse beside that water and include a small amount of the sea within the tile.'
      : 'This tile does not contain visible sea or coastal water. Do not create a lighthouse; preserve the map unchanged.'
    : ''

  return `Create ${atlasScenes[scene]} that fits this tile leaving a 10% safety margin. Preserve the entire surrounding map, its roads, labels, palette, scale, orientation, and top-down cartographic geometry. The result must be a planimetric, strict overhead view integrated into the map, not a poster or framed illustration. Keep the event strictly contained within the tile. Do not crop, rotate, add a border, or add new text. ${seaRule}`
}

const generateTile = async (tile, sourceImage) => {
  const cached = await getCachedTile(tile)
  if (cached) return cached

  const generatedImage = await createOpenRouterClient().editImage({
    prompt: atlasPrompt(tile.scene, tile.hasSea),
    sourceImage,
  })

  const { directory, image, metadata } = tilePaths(tile)
  const contentType = generatedImage.contentType
  const cacheEntry = { contentType, generatedAt: new Date().toISOString() }
  await mkdir(directory, { recursive: true })
  await writeFile(image, generatedImage.data)
  await writeFile(metadata, JSON.stringify(cacheEntry))
  return cacheEntry
}

const serveCachedTile = async (request, response, tile) => {
  if (request.method !== 'GET') return false
  const cached = await getCachedTile(tile)
  if (!cached) {
    sendError(response, 404, 'This atlas tile has not been generated yet.')
    return true
  }

  const image = await readFile(tilePaths(tile).image)
  response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': cached.contentType,
  })
  response.end(image)
  return true
}

const serveAtlasTileRequest = async (request, response, tile) => {
  if (request.method === 'GET') {
    const cached = await getCachedTile(tile)
    if (cached) {
      await serveCachedTile(request, response, tile)
    } else {
      sendError(response, 404, 'This atlas tile has not been generated yet. Click the fogged tile in the map to start generation.')
    }
    return true
  }

  return generateAtlasTile(request, response, tile)
}

const generateAtlasTile = async (request, response, tile) => {
  if (request.method !== 'POST') return false

  // A client may retry generation for a tile that was generated by an earlier
  // request. Resolve that case before validating the generation request so a
  // cached tile never depends on OpenRouter configuration.
  if (await getCachedTile(tile)) {
    sendJson(response, 200, { url: `/generated-tiles/${tile.scene}/${tile.zoom}/${tile.x}/${tile.y}` })
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

  const { sourceImage, hasSea } = await readRequestBody(request)
  if (typeof sourceImage !== 'string' || !sourceImage.startsWith('data:image/')) {
    sendError(response, 400, 'A PNG or JPEG data URL is required as the tile source image.')
    return true
  }

  await generateTile({ ...tile, hasSea: hasSea === true }, sourceImage)
  sendJson(response, 200, { url: `/generated-tiles/${tile.scene}/${tile.zoom}/${tile.x}/${tile.y}` })
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
      sendJson(response, 200, { tiles: await listCachedTiles() })
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
