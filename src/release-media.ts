import { allowsArtwork } from './artwork-reservation'
import { publishedArtworkUrl } from './artwork-presentation'
import assets from '../releases/assets.json'
import type { Painting } from './artwork-review'
import catalog from '../releases/catalog.json'

export const releaseMediaKeys = new Map(Object.entries(assets))

// The catalog URL is also the identity in saved reviews and artwork presentation settings.
const artworkAliases = new Map<string, string>()
for (const sheet of catalog.sheets) {
  for (const art of sheet.art) {
    const [pathname] = art.url.split('?')
    if (!pathname.endsWith('.png')) continue
    const webp = `${pathname.slice(0, -4)}.webp`
    if (releaseMediaKeys.has(webp)) artworkAliases.set(pathname, webp)
  }
}

export const releaseMediaPath = (pathname: string) =>
  artworkAliases.get(pathname) ?? pathname

const publishedKeys = new Set(releaseMediaKeys.values())
export function releaseObjectKey(pathname: string) {
  const key = pathname.slice(1)
  if (/^release-assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(key) && publishedKeys.has(key))
    return key
  return releaseMediaKeys.get(releaseMediaPath(pathname))
}

export function mediaCacheControl(pathname: string, key: string, status: number) {
  if (status !== 200 && status !== 206 && status !== 304) return 'no-store'
  return pathname === `/${key}` ? 'public, max-age=31536000, immutable' : 'no-cache'
}

function publishedUrl(url: string) {
  const key = releaseMediaKeys.get(releaseMediaPath(url.split('?')[0]))
  if (!key && !url.startsWith('/generated-tiles/'))
    throw new Error(`Accepted artwork has no released media mapping: ${url}`)
  return key ? publishedArtworkUrl(`/${key}`, url) : url
}

// Keep the review identity in art.url while the renderer requests the released bytes.
function publishedPainting(art: Painting) {
  const animation = art.animation
  return {
    ...art,
    imageUrl: publishedUrl(art.url),
    ...(animation && {
      animation: {
        ...animation,
        ...(animation.loopUrl && { loopUrl: publishedUrl(animation.loopUrl) }),
        ...(animation.plate && { plate: publishedUrl(animation.plate) }),
        ...(animation.motion &&
          animation.folder && {
            spriteUrl: publishedUrl(
              `/${animation.folder}/${animation.motion.sprite}.webp`,
            ),
          }),
      },
    }),
  }
}

export const releaseCatalog = {
  ...catalog,
  sheets: catalog.sheets
    .map(sheet => ({
      ...sheet,
      art: sheet.art.filter(allowsArtwork).map(publishedPainting),
    }))
    .filter(sheet => sheet.art.length),
}
