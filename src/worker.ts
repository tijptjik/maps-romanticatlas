export default {
  fetch(request, env) {
    const pathname = new URL(request.url).pathname
    if (pathname.startsWith('/api/atlas-tiles/') || pathname.startsWith('/generated-tiles/')) {
      return new Response(
        JSON.stringify({
          error: 'The production deployment is static-only; atlas generation is available on the local Bun server.',
        }),
        {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      )
    }

    return env.ASSETS.fetch(request)
  },
}
