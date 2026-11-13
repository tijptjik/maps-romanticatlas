// Share downloads across the basemap proxy and eligibility requests. Cache only
// immutable, versioned vector tiles; never retain failures or unversioned data.
export const createMapAssetCache = (
  fetchAsset: typeof fetch = fetch,
  maximumBytes = 32 * 1024 * 1024,
) => {
  const cached = new Map<
    string,
    { body: ArrayBuffer; headers: Headers; status: number }
  >()
  const pending = new Map<
    string,
    Promise<{ body: ArrayBuffer; headers: Headers; status: number }>
  >()
  let bytes = 0
  return async (url: string | URL) => {
    const key = String(url)
    const parsed = new URL(key)
    const cacheable =
      parsed.pathname.endsWith('.mvt') && Boolean(parsed.searchParams.get('v'))
    let entry = cached.get(key)
    if (entry) {
      cached.delete(key)
      cached.set(key, entry)
    } else {
      let request = pending.get(key)
      if (!request) {
        request = (async () => {
          const response = await fetchAsset(key, {
            headers: { Origin: 'https://romanticatlas.hype.hk' },
          })
          const value = {
            body: await response.arrayBuffer(),
            headers: new Headers(response.headers),
            status: response.status,
          }
          // fetch decoded the body. Do not advertise its upstream encoding/size.
          value.headers.delete('content-encoding')
          value.headers.delete('content-length')
          if (response.ok && cacheable && value.body.byteLength <= maximumBytes) {
            while (
              (bytes + value.body.byteLength > maximumBytes || cached.size >= 128) &&
              cached.size
            ) {
              const oldestEntry = cached.entries().next().value
              if (!oldestEntry) break
              const [oldest, previous] = oldestEntry
              bytes -= previous.body.byteLength
              cached.delete(oldest)
            }
            cached.set(key, value)
            bytes += value.body.byteLength
          }
          return value
        })()
        pending.set(key, request)
      }
      try {
        entry = await request
      } finally {
        if (pending.get(key) === request) pending.delete(key)
      }
    }
    return new Response(
      [204, 205, 304].includes(entry.status) ? null : entry.body.slice(0),
      {
        status: entry.status,
        headers: entry.headers,
      },
    )
  }
}
