import metadata from '../releases/artwork-presentation.json'

type Presentation = { edgeFade: boolean; waterFadeStart?: number; backgroundMask?: number[][] }

function identity(url: string) {
  const asset = new URL(url, 'https://atlas.invalid')
  asset.searchParams.sort()
  return asset.pathname + asset.search
}

const settings = new Map<string, Presentation>(
  Object.entries(metadata).map(([url, value]) => [identity(url), value]),
)

// Two paintings can share image bytes and have different presentation settings.
// Fragments identify the presentation locally and never enter the HTTP cache key.
export function publishedArtworkUrl(path: string, original: string) {
  const key = identity(original)
  return settings.get(key)?.edgeFade ? path + '#presentation=' + encodeURIComponent(key) : path
}

export function artworkPresentation(asset: URL) {
  const original = asset.pathname.startsWith('/release-assets/') &&
    new URLSearchParams(asset.hash.slice(1)).get('presentation')
  return settings.get(original || identity(asset.href))
}
