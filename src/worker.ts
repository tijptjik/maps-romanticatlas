import { handleAtlasApi } from './worker-api.ts'

export { AtlasManifest } from './atlas-manifest.ts'
export { FogEligibilityIndexCache } from './fog-eligibility-index-cache.ts'

const tileOrigin = 'https://tiles.saanseoi.hk'
const tileProxyPrefix = '/map-assets/saanseoi'
const tileJsonPath = `${tileProxyPrefix}/hongkong-latest.json`
const vectorTilePattern = new RegExp(
  `^${tileProxyPrefix}/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
)
const upstreamRequest = (pathname: string, search = '') => {
  const upstreamUrl = new URL(
    `${pathname.slice(tileProxyPrefix.length)}${search}`,
    tileOrigin,
  )
  return fetch(upstreamUrl, {
    headers: {
      // The basemap service authorizes the production application origin. The
      // browser still talks to this Worker same-origin during local dev.
      Origin: 'https://romanticatlas.hype.hk',
    },
  })
}

const proxyTileJson = async (request: Request, env: Env) => {
  const response = await upstreamRequest(tileJsonPath)
  if (!response.ok) return response

  const tileJson = await response.json<Record<string, unknown>>()
  const proxyOrigin = env.ATLAS_ALLOWED_ORIGIN
    ? new URL(env.ATLAS_ALLOWED_ORIGIN).origin
    : new URL(request.url).origin
  const tiles = Array.isArray(tileJson.tiles) ? tileJson.tiles : []
  tileJson.tiles = tiles.map(tileUrl => {
    if (typeof tileUrl !== 'string') return tileUrl
    const upstreamTileUrl = new URL(tileUrl, tileOrigin)
    if (upstreamTileUrl.origin !== tileOrigin) return tileUrl
    const tilePath = decodeURIComponent(upstreamTileUrl.pathname)
    return `${proxyOrigin}${tileProxyPrefix}${tilePath}${upstreamTileUrl.search}`
  })

  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(tileJson), { headers })
}

const proxyVectorTile = (request: Request) => {
  const url = new URL(request.url)
  return upstreamRequest(url.pathname, url.search)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      const apiResponse = await handleAtlasApi(request, env)
      if (apiResponse) return apiResponse

      if (request.method === 'GET' && url.pathname === tileJsonPath) {
        return proxyTileJson(request, env)
      }
      if (request.method === 'GET' && vectorTilePattern.test(url.pathname)) {
        return proxyVectorTile(request)
      }

      return env.ASSETS.fetch(request)
    } catch (error) {
      // Do not let an ordinary upstream, storage, or Durable Object exception
      // tear down the browser connection. The tile client can reconcile a
      // completed render from the cache when it receives a normal response.
      console.error(`[atlas] request failed for ${url.pathname}`, error)
      return new Response(
        JSON.stringify({ error: 'The atlas service could not complete this request. Please try again.' }),
        {
          status: 500,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          },
        },
      )
    }
  },
}
