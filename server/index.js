import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

import { createOpenRouterClient } from './openrouter-client.js'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const productionDirectory = path.join(rootDirectory, 'dist')
const atlasZoom = 18
const isProduction = process.env.NODE_ENV === 'production'
const tileOrigin = 'https://tiles.saanseoi.hk'
const tileProxyPrefix = '/map-assets/saanseoi'
const tileJsonPath = `${tileProxyPrefix}/hongkong-latest.json`
const publicOrigin = 'https://visionarymachines.hype.hk'
const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const atlasPromptVersion = 'openai-edit-v1'
const atlasScenes = {
  circus: 'a Victorian circus',
  'balloon-festival': 'a balloon festival',
  'art-nouveau-palace': 'an elaborate Art Nouveau palace',
}
const tileVectorPattern = new RegExp(
  `^${tileProxyPrefix}/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
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

const proxyTileJson = async (request, response) => {
  const upstreamUrl = new URL('/hongkong-latest.json', tileOrigin)
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { Origin: request.headers.origin ?? publicOrigin },
  })
  if (!upstreamResponse.ok) {
    await sendUpstreamResponse(response, upstreamResponse)
    return
  }

  const tileJson = await upstreamResponse.json()
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const protocol = typeof forwardedProtocol === 'string' ? forwardedProtocol.split(',')[0] : 'http'
  const proxyOrigin = `${protocol}://${request.headers.host}`
  tileJson.tiles = tileJson.tiles.map(tileUrl =>
    (() => {
      const upstreamTileUrl = new URL(tileUrl, tileOrigin)
      return upstreamTileUrl.origin === tileOrigin
        ? `${proxyOrigin}${tileProxyPrefix}${decodeURIComponent(upstreamTileUrl.pathname)}${upstreamTileUrl.search}`
        : tileUrl
    })(),
  )
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(tileJson))
}

const proxyVectorTile = async (request, response, pathname) => {
  const upstreamUrl = new URL(pathname.slice(tileProxyPrefix.length), tileOrigin)
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { Origin: request.headers.origin ?? publicOrigin },
  })
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
  const match = pathname.match(/^\/(?:api\/atlas-tiles|generated-tiles)\/(circus|balloon-festival|art-nouveau-palace)\/(\d+)\/(\d+)\/(\d+)$/)
  if (!match) return null

  const [, scene, zoom, x, y] = match
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

const atlasPrompt = scene => `Create ${atlasScenes[scene]} that fits in the center of this tile. Preserve the entire surrounding map, its roads, labels, palette, scale, orientation, and top-down cartographic geometry. The result must be a planimetric, strict overhead view integrated into the map, not a poster or framed illustration. Keep the event centered and contained within the tile. Do not crop, rotate, add a border, or add new text.`

const generateTile = async (tile, sourceImage) => {
  const cached = await getCachedTile(tile)
  if (cached) return cached

  const generatedImage = await createOpenRouterClient().editImage({
    prompt: atlasPrompt(tile.scene),
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

const generateAtlasTile = async (request, response, tile) => {
  if (request.method !== 'POST') return false

  const origin = request.headers.origin
  const allowedOrigin = process.env.ATLAS_ALLOWED_ORIGIN ?? 'https://visionarymachines.hype.hk'
  const allowedHost = new URL(allowedOrigin).host
  const isLocalDevelopmentRequest = !isProduction && localOriginPattern.test(origin ?? '')
  const hostIsAllowed = request.headers.host === allowedHost ||
    (!isProduction && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(request.headers.host ?? ''))
  const originIsAllowed = !origin || origin === allowedOrigin || isLocalDevelopmentRequest
  if (!originIsAllowed || !hostIsAllowed) {
    sendError(response, 403, 'Image generation is restricted to the configured application domain.')
    return true
  }

  const { sourceImage } = await readRequestBody(request)
  if (typeof sourceImage !== 'string' || !sourceImage.startsWith('data:image/')) {
    sendError(response, 400, 'A PNG or JPEG data URL is required as the tile source image.')
    return true
  }

  await generateTile(tile, sourceImage)
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
    const tile = parseTileRequest(pathname)

    if (request.method === 'GET' && pathname === tileJsonPath) {
      await proxyTileJson(request, response)
      return
    }

    if (request.method === 'GET' && tileVectorPattern.test(pathname)) {
      await proxyVectorTile(request, response, pathname)
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
