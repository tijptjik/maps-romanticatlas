export {}

const origin = (
  process.env.ATLAS_MANIFEST_ORIGIN ??
  process.env.ATLAS_ALLOWED_ORIGIN ??
  'https://romanticatlas.hype.hk'
).replace(/\/$/, '')
const token = (process.env.ATLAS_MANIFEST_TOKEN ?? process.env.ATLAS_ADMIN_TOKEN)?.trim()

if (!token) {
  throw new Error(
    'Set ATLAS_MANIFEST_TOKEN (or ATLAS_ADMIN_TOKEN) to a production cache-admin token before backfilling.',
  )
}

const response = await fetch(`${origin}/api/atlas-tiles/manifest/rebuild?admin=true`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    origin,
  },
})
const body = await response.json().catch(() => null)
if (!response.ok) {
  throw new Error(
    body?.error ?? `Atlas manifest backfill failed with HTTP ${response.status}.`,
  )
}

console.log(
  `Atlas manifest backfilled: ${body.indexed}/${body.scannedMetadata} assets across ${body.shards} shards.`,
)
