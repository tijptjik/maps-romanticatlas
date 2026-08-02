const hypeOrigin = 'https://tiles.hype.hk'
const proxyPrefix = '/map-assets/hype'
const tileJsonPath = `${proxyPrefix}/basemap/hongkong-latest.json`
const vectorTilePattern = new RegExp(
  `^${proxyPrefix}/basemap/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
)

const upstreamUrl = pathname => new URL(pathname.slice(proxyPrefix.length), hypeOrigin)

const proxyTileJson = async request => {
  const response = await fetch(upstreamUrl('/map-assets/hype/basemap/hongkong-latest.json'))
  if (!response.ok) return response

  const tileJson = await response.json()
  const proxyOrigin = new URL(request.url).origin
  tileJson.tiles = tileJson.tiles.map(tileUrl => {
    if (!tileUrl.startsWith(hypeOrigin)) return tileUrl
    return `${proxyOrigin}${proxyPrefix}${tileUrl.slice(hypeOrigin.length)}`
  })

  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  return Response.json(tileJson, { headers })
}

const proxyVectorTile = request => fetch(upstreamUrl(new URL(request.url).pathname), request)

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)

    if (request.method === 'GET' && pathname === tileJsonPath) {
      return proxyTileJson(request)
    }

    if (request.method === 'GET' && vectorTilePattern.test(pathname)) {
      return proxyVectorTile(request)
    }

    return env.ASSETS.fetch(request)
  },
}
