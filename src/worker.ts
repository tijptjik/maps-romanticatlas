const tileOrigin = 'https://tiles.saanseoi.hk'
const proxyPrefix = '/map-assets/saanseoi'
const tileJsonPath = `${proxyPrefix}/hongkong-latest.json`
const vectorTilePattern = new RegExp(
  `^${proxyPrefix}/hongkong-latest/(\\d+)/(\\d+)/(\\d+)\\.mvt$`,
)

const upstreamUrl = pathname => new URL(pathname.slice(proxyPrefix.length), tileOrigin)
const upstreamRequestInit = request => ({
  headers: {
    Origin: request.headers.get('Origin') ?? 'https://romanticatlas.hype.hk',
  },
})

const proxyTileJson = async request => {
  const response = await fetch(
    upstreamUrl(tileJsonPath),
    upstreamRequestInit(request),
  )
  if (!response.ok) return response

  const tileJson = await response.json()
  const proxyOrigin = new URL(request.url).origin
  tileJson.tiles = tileJson.tiles.map(tileUrl => {
    const upstreamTileUrl = new URL(tileUrl, tileOrigin)
    if (upstreamTileUrl.origin !== tileOrigin) return tileUrl
    const tilePath = decodeURIComponent(upstreamTileUrl.pathname)
    return `${proxyOrigin}${proxyPrefix}${tilePath}${upstreamTileUrl.search}`
  })

  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  return Response.json(tileJson, { headers })
}

const proxyVectorTile = request =>
  fetch(upstreamUrl(new URL(request.url).pathname), upstreamRequestInit(request))

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
