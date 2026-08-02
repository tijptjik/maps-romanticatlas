import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

import { createFalClient } from './fal-client.js'
import { describeTileGeometry } from './vector-tile-analysis.js'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const productionDirectory = path.join(rootDirectory, 'dist')
const atlasZoom = 18
const falModel = process.env.FAL_ATLAS_MODEL ?? 'fal-ai/fast-sdxl/image-to-image'
const isProduction = process.env.NODE_ENV === 'production'
const hypeOrigin = 'https://tiles.hype.hk'
const hypeProxyPrefix = '/map-assets/hype'
const hypeTileJsonPath = `${hypeProxyPrefix}/basemap/hongkong-latest.json`
const hypeVectorTilePattern = new RegExp(
  `^${hypeProxyPrefix}/basemap/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
)

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

const sendUpstreamResponse = async (response, upstreamResponse) => {
  const headers = {}
  for (const header of ['cache-control', 'content-type', 'etag', 'last-modified']) {
    const value = upstreamResponse.headers.get(header)
    if (value) headers[header] = value
  }

  response.writeHead(upstreamResponse.status, headers)
  response.end(Buffer.from(await upstreamResponse.arrayBuffer()))
}

const proxyHypeTileJson = async (request, response) => {
  const upstreamResponse = await fetch(`${hypeOrigin}/basemap/hongkong-latest.json`)
  if (!upstreamResponse.ok) {
    await sendUpstreamResponse(response, upstreamResponse)
    return
  }

  const tileJson = await upstreamResponse.json()
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const protocol = typeof forwardedProtocol === 'string' ? forwardedProtocol.split(',')[0] : 'http'
  const proxyOrigin = `${protocol}://${request.headers.host}`
  tileJson.tiles = tileJson.tiles.map(tileUrl =>
    tileUrl.startsWith(hypeOrigin)
      ? `${proxyOrigin}${hypeProxyPrefix}${tileUrl.slice(hypeOrigin.length)}`
      : tileUrl,
  )
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(tileJson))
}

const proxyHypeVectorTile = async (response, pathname) => {
  const upstreamResponse = await fetch(new URL(pathname.slice(hypeProxyPrefix.length), hypeOrigin))
  await sendUpstreamResponse(response, upstreamResponse)
}

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
  const match = pathname.match(/^\/(?:api\/atlas-tiles|generated-tiles)\/(\d+)\/(\d+)\/(\d+)$/)
  if (!match) return null

  const [, zoom, x, y] = match.map(Number)
  const tileCount = 2 ** zoom
  if (zoom !== atlasZoom || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    return null
  }

  return { zoom, x, y }
}

const tilePaths = tile => {
  const directory = path.join(cacheDirectory, String(tile.zoom), String(tile.x))
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

const imageUrlFromResult = result => {
  const data = result.data
  return data?.images?.[0]?.url ?? data?.image?.url ?? data?.url ?? null
}

const atlasPrompt = geometryBrief => `Retell this exact level-18 Hong Kong map tile as a hand-drawn romantic-era atlas. The supplied image is authoritative geometry: trace every coastline, road centreline, water edge, building footprint, and park boundary in the same position. Do not crop, rotate, change scale, add or remove streets, or invent landmarks. Use graceful copperplate-era ink linework, light watercolour washes, parchment shading, botanical green parks, and restrained rose and ochre buildings. No title, legend, border, compass rose, labels, or new text. Keep all four edges seamless with adjacent tiles. Vector geometry brief: ${geometryBrief}`

const generateTile = async (tile, sourceImage) => {
  const cached = await getCachedTile(tile)
  if (cached) return cached

  const falClient = createFalClient()
  const geometryBrief = await describeTileGeometry(tile)
  const result = await falClient.subscribe(falModel, {
    image_url: sourceImage,
    prompt: atlasPrompt(geometryBrief),
    strength: 0.25,
    guidance_scale: 8,
    image_size: { width: 512, height: 512 },
    format: 'png',
  })
  const outputUrl = imageUrlFromResult(result)
  if (!outputUrl) {
    throw new Error('Fal returned no image for the requested tile.')
  }

  const imageResponse = await fetch(outputUrl)
  if (!imageResponse.ok) {
    throw new Error('Could not download the generated tile from Fal.')
  }

  const { directory, image, metadata } = tilePaths(tile)
  const contentType = imageResponse.headers.get('content-type') ?? 'image/jpeg'
  const cacheEntry = { contentType, generatedAt: new Date().toISOString() }
  await mkdir(directory, { recursive: true })
  await writeFile(image, Buffer.from(await imageResponse.arrayBuffer()))
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

const generateAtlasTile = async (request, response, tile) => {
  if (request.method !== 'POST') return false

  const { sourceImage } = await readRequestBody(request)
  if (typeof sourceImage !== 'string' || !sourceImage.startsWith('data:image/')) {
    sendError(response, 400, 'A PNG or JPEG data URL is required as the tile source image.')
    return true
  }

  await generateTile(tile, sourceImage)
  sendJson(response, 200, { url: `/generated-tiles/${tile.zoom}/${tile.x}/${tile.y}` })
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
    const tile = parseTileRequest(pathname)

    if (request.method === 'GET' && pathname === hypeTileJsonPath) {
      await proxyHypeTileJson(request, response)
      return
    }

    if (request.method === 'GET' && hypeVectorTilePattern.test(pathname)) {
      await proxyHypeVectorTile(response, pathname)
      return
    }

    if (tile && pathname.startsWith('/generated-tiles/')) {
      await serveCachedTile(request, response, tile)
      return
    }

    if (tile && pathname.startsWith('/api/atlas-tiles/')) {
      await generateAtlasTile(request, response, tile)
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
