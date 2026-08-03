export const atlasZoom = 18
export const atlasTileSize = 512
export const generationVersion = 4
export const defaultAtlasVariant = 'default'
// Keep the current write version stable while allowing every retained cache
// generation, including the pre-existing v5 set, to be replayed or selected.
export const readableCacheVersions = [1, 2, 3, 4, 5] as const
export const atlasSceneGridRadius = 4
export const csrfCookieName = 'atlas_csrf'

export type ContentBounds = {
  x: number
  y: number
  width: number
  height: number
} | null

export type AtlasPosition = { zoom: number; x: number; y: number }
export type AtlasTile<Scene extends string = string> = AtlasPosition & { scene: Scene }

export type CachedAtlasTile<Scene extends string = string> = {
  tile: AtlasTile<Scene>
  version: number
  variant: string
  contentType: string
  contentBounds: ContentBounds
}

export const atlasTileCount = (zoom = atlasZoom) => 2 ** zoom

export const isSupportedCacheVersion = (version: number) =>
  isReadableCacheVersion(version)

export const isReadableCacheVersion = (version: number) =>
  readableCacheVersions.some(candidate => candidate === version)

export const isValidAtlasPosition = ({ zoom, x, y }: AtlasPosition) =>
  Number.isInteger(zoom) &&
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  zoom === atlasZoom &&
  x >= 0 &&
  y >= 0 &&
  x < atlasTileCount(zoom) &&
  y < atlasTileCount(zoom)

const numericPathSegment = '(\\d+)'
const atlasTilePathPattern = new RegExp(
  `^/(?:api/atlas-tiles|generated-tiles)/${numericPathSegment}/${numericPathSegment}/${numericPathSegment}/([^/]+)$`,
)
const atlasPositionPathPattern = new RegExp(
  `^/api/atlas-tiles/cache-status/${numericPathSegment}/${numericPathSegment}/${numericPathSegment}$`,
)

export const parseAtlasTilePath = <Scene extends string>(
  pathname: string,
  isKnownScene: (scene: string) => scene is Scene,
): AtlasTile<Scene> | null => {
  const match = pathname.match(atlasTilePathPattern)
  if (!match) return null
  const [, zoom, x, y, scene] = match
  const tile = { zoom: Number(zoom), x: Number(x), y: Number(y), scene }
  return isValidAtlasPosition(tile) && isKnownScene(scene)
    ? { ...tile, scene }
    : null
}

export const parseAtlasPositionPath = (pathname: string): AtlasPosition | null => {
  const match = pathname.match(atlasPositionPathPattern)
  if (!match) return null
  const [, zoom, x, y] = match
  const position = { zoom: Number(zoom), x: Number(x), y: Number(y) }
  return isValidAtlasPosition(position) ? position : null
}

export const requestedCacheVersion = (searchParams: URLSearchParams) => {
  const value = searchParams.get('version')
  if (value === null || !/^\d+$/.test(value)) return null
  const version = Number(value)
  return isSupportedCacheVersion(version) ? version : null
}

export const requestedAtlasVariant = (searchParams: URLSearchParams) => {
  const value = searchParams.get('variant')
  return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : defaultAtlasVariant
}

export const atlasTileCacheKey = (
  tile: AtlasTile,
  version = generationVersion,
  variant = defaultAtlasVariant,
) => `atlas/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}.v${version}${
  variant === defaultAtlasVariant ? '' : `.${variant}`
}`

export const atlasImageKey = (
  tile: AtlasTile,
  version = generationVersion,
  variant = defaultAtlasVariant,
) => `${atlasTileCacheKey(tile, version, variant)}.image`

export const atlasMetadataKey = (
  tile: AtlasTile,
  version = generationVersion,
  variant = defaultAtlasVariant,
) => `${atlasTileCacheKey(tile, version, variant)}.json`

export const atlasTileUrl = (
  tile: AtlasTile,
  version = generationVersion,
  variant = defaultAtlasVariant,
) => {
  const params = new URLSearchParams({ version: String(version) })
  if (variant !== defaultAtlasVariant) params.set('variant', variant)
  return `/generated-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}?${params}`
}

export const normalizeContentBounds = (value: unknown): ContentBounds => {
  const candidate = value as Record<string, unknown> | null | undefined
  const x = Number(candidate?.x)
  const y = Number(candidate?.y)
  const width = Number(candidate?.width)
  const height = Number(candidate?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    return null

  const left = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(x)))
  const top = Math.max(0, Math.min(atlasTileSize - 1, Math.floor(y)))
  const right = Math.max(left + 1, Math.min(atlasTileSize, Math.ceil(x + width)))
  const bottom = Math.max(top + 1, Math.min(atlasTileSize, Math.ceil(y + height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export const bearerToken = (authorization: unknown) =>
  typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null
    : null

export const cookieValue = (cookieHeader: unknown, name: string) =>
  (typeof cookieHeader === 'string' ? cookieHeader : '')
    .split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null

export const modeEnabled = (searchParams: URLSearchParams, mode: 'admin' | 'diagnostics') =>
  searchParams.get(mode) === 'true'

const localHostPattern = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const isLocalHost = (host: string) => localHostPattern.test(host)

export const isAllowedApplicationRequest = ({
  requestHost,
  origin,
  allowedOrigin,
  localDevelopment = false,
  requireOrigin = false,
}: {
  requestHost: string | null | undefined
  origin: string | null | undefined
  allowedOrigin: string | null | undefined
  localDevelopment?: boolean
  requireOrigin?: boolean
}) => {
  if (!allowedOrigin) return false
  let allowedHost: string
  try {
    allowedHost = new URL(allowedOrigin).host
  } catch {
    return false
  }

  const hostMatches = requestHost === allowedHost ||
    (localDevelopment && isLocalHost(requestHost ?? ''))
  const originMatches = requireOrigin
    ? origin === allowedOrigin || (localDevelopment && isLocalOrigin(origin))
    : !origin || origin === allowedOrigin || (localDevelopment && isLocalOrigin(origin))
  return hostMatches && originMatches
}

const isLocalOrigin = (origin: string | null | undefined) => {
  if (!origin) return false
  try {
    return isLocalHost(new URL(origin).host)
  } catch {
    return false
  }
}

export const atlasAdminErrors = {
  disabled: 'Atlas admin mode is disabled.',
  unconfigured: 'Atlas admin authentication is not configured.',
  unauthenticated: 'Atlas admin authentication is required.',
  forbidden: 'Cache management is restricted to the configured application domain.',
} as const

export type AtlasProtocolError = {
  status: number
  error: string
  authenticate?: boolean
}

export const adminAccessError = ({
  adminMode,
  authenticationConfigured,
  authenticated,
  applicationRequestAllowed,
  csrfValid = true,
  requireCsrf = false,
}: {
  adminMode: boolean
  authenticationConfigured: boolean
  authenticated: boolean
  applicationRequestAllowed: boolean
  csrfValid?: boolean
  requireCsrf?: boolean
}): AtlasProtocolError | null => {
  if (!adminMode) return { status: 403, error: atlasAdminErrors.disabled }
  if (!authenticationConfigured)
    return { status: 503, error: atlasAdminErrors.unconfigured }
  if (!authenticated)
    return { status: 401, error: atlasAdminErrors.unauthenticated, authenticate: true }
  if (!applicationRequestAllowed || (requireCsrf && !csrfValid))
    return { status: 403, error: atlasAdminErrors.forbidden }
  return null
}

export const atlasErrorPayload = (error: string) => ({ error })

export const cacheStatusPayload = <Scene extends string>({
  cached,
  scenes,
}: {
  cached: CachedAtlasTile<Scene> | null
  scenes: Scene[]
}) => ({
  cached: Boolean(cached),
  url: cached ? atlasTileUrl(cached.tile, cached.version, cached.variant) : null,
  scene: cached?.tile.scene ?? null,
  scenes,
  contentBounds: cached?.contentBounds ?? null,
})

export const cachedTilePayload = <Scene extends string>(cached: CachedAtlasTile<Scene>) => ({
  url: atlasTileUrl(cached.tile, cached.version, cached.variant),
  scene: cached.tile.scene,
  version: cached.version,
  variant: cached.variant,
  contentBounds: cached.contentBounds ?? null,
})

export const cachedTilesPayload = <Tile>(params: {
  adminMode: boolean
  diagnosticsMode: boolean
  version: number | null
  tiles: Tile[]
}) => ({
  adminMode: params.adminMode,
  diagnosticsMode: params.diagnosticsMode,
  version: params.version,
  preRenderedCount: params.tiles.length,
  tiles: params.tiles,
})
