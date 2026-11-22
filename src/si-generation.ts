import {
  atlasImageKey,
  atlasMetadataKey,
  cachedTilePayload,
  generationVersion,
  type AtlasTile,
} from './atlas-protocol'
import type { AtlasScene } from './atlas-scenes'
import { manifestShardName } from './atlas-manifest'

type GeneratorEnv = Env & {
  ATLAS_GENERATOR_ORIGIN?: string
  ATLAS_GENERATOR_TOKEN?: string
}
type Job = {
  id: string
  tile: AtlasTile<AtlasScene>
  variant: string
  createdAt: string
  status: 'pending' | 'complete' | 'failed'
  title?: string
  error?: string
}
const jobKey = (id: string) => `generation-jobs/${id}.json`
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export async function generator(
  env: GeneratorEnv,
  path: string,
  options: RequestInit = {},
) {
  if (!env.ATLAS_GENERATOR_ORIGIN || !env.ATLAS_GENERATOR_TOKEN)
    throw Error('SI generation is not configured.')
  return fetch(env.ATLAS_GENERATOR_ORIGIN + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.ATLAS_GENERATOR_TOKEN}`,
    },
    signal: AbortSignal.timeout(30_000),
  })
}

export async function startSiGeneration(
  env: GeneratorEnv,
  tile: Job['tile'],
  sourceImage: string,
  discovery?: string,
  jobId?: string,
) {
  if (!env.ATLAS_GENERATOR_ORIGIN || !env.ATLAS_GENERATOR_TOKEN)
    return reply({ error: 'Si image generation is not configured.' }, 503)
  const id = jobId ?? crypto.randomUUID()
  const previous = jobId ? await env.ATLAS_BUCKET.get(jobKey(id)) : null
  const job: Job = previous
    ? await previous.json<Job>()
    : {
        id,
        tile,
        createdAt: new Date().toISOString(),
        status: 'pending',
        variant: discovery ? `${discovery}-${id.slice(-12)}` : id,
      }
  // Persist before dispatch so even an immediate completion can publish safely.
  if (job.status !== 'pending')
    return reply({ statusUrl: `/api/discovery-jobs/${id}` }, 202)
  if (!previous) await env.ATLAS_BUCKET.put(jobKey(id), JSON.stringify(job))
  let response: Response
  try {
    response = await generator(env, `/jobs/${id}`, {
      method: 'POST',
      body: JSON.stringify({ scene: tile.scene, y: tile.y, sourceImage }),
    })
  } catch {
    // Submission can have succeeded despite a lost response. Keep the same job
    // available for polling and the SI completion callback.
    return reply({ statusUrl: `/api/discovery-jobs/${id}` }, 202)
  }
  if (!response.ok) {
    job.status = 'failed'
    job.error =
      response.status === 429
        ? 'The image queue is full. Please try again shortly.'
        : 'SI could not accept this clearing. Please try again.'
    await env.ATLAS_BUCKET.put(jobKey(id), JSON.stringify(job))
    return reply({ error: job.error }, response.status === 429 ? 429 : 503)
  }
  return reply({ statusUrl: `/api/discovery-jobs/${id}` }, 202)
}

export async function siGenerationStatus(
  request: Request,
  env: GeneratorEnv,
  id: string,
) {
  if (request.method === 'POST') {
    const supplied = new TextEncoder().encode(
      request.headers.get('authorization') ?? '',
    )
    const expected = new TextEncoder().encode(
      `Bearer ${env.ATLAS_GENERATOR_TOKEN ?? ''}`,
    )
    const key = await crypto.subtle.importKey(
      'raw',
      expected,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, expected)
    if (
      !env.ATLAS_GENERATOR_TOKEN ||
      !(await crypto.subtle.verify('HMAC', key, signature, supplied))
    )
      return reply({ error: 'Generator authentication required.' }, 403)
  } else if (request.method !== 'GET') {
    return reply({ error: 'Unsupported method.' }, 405)
  }
  const object = await env.ATLAS_BUCKET.get(jobKey(id))
  if (!object) return reply({ error: 'Unknown generation job.' }, 404)
  const job = await object.json<Job>()
  if (job.status === 'failed') return reply({ error: job.error, failed: true }, 502)
  const payload = () =>
    cachedTilePayload({
      tile: job.tile,
      title: job.title,
      version: generationVersion,
      variant: job.variant,
      contentType: 'image/png',
      contentBounds: null,
    })
  if (job.status === 'complete') return reply(payload())
  const remote = await generator(env, `/jobs/${id}`)
  if (remote.status === 202 || remote.status === 404) {
    if (Date.now() - Date.parse(job.createdAt) < 35 * 60_000)
      return reply({ pending: true }, 202)
    job.status = 'failed'
    job.error = 'Generation timed out. Please try this clearing again.'
    await env.ATLAS_BUCKET.put(jobKey(id), JSON.stringify(job))
    return reply({ error: job.error, failed: true }, 502)
  }
  if (remote.status === 502) {
    job.status = 'failed'
    job.error = 'SI could not complete the artwork. Please retry this clearing.'
    await env.ATLAS_BUCKET.put(jobKey(id), JSON.stringify(job))
    return reply({ error: job.error, failed: true }, 502)
  }
  if (!remote.ok) return reply({ pending: true }, 202)
  const receipt = await remote.json<{
    sha256: string
    width: number
    height: number
    source: string
    title?: string
  }>()
  const image = await generator(env, `/jobs/${id}/image`)
  if (!image.ok) throw Error('The SI artwork is not available yet.')
  const size = Number(image.headers.get('content-length'))
  if (!Number.isInteger(size) || size < 24 || size > 16_000_000)
    throw Error('Invalid SI artwork size.')
  const bytes = await image.arrayBuffer()
  if (
    bytes.byteLength > 16_000_000 ||
    bytes.byteLength < 8 ||
    new Uint8Array(bytes).slice(0, 8).join() !== '137,80,78,71,13,10,26,10'
  )
    throw Error('SI returned an invalid PNG.')
  const header = new DataView(bytes)
  if (
    header.getUint32(16) !== receipt.width ||
    header.getUint32(20) !== receipt.height ||
    receipt.width !== receipt.height ||
    receipt.width < 512 ||
    receipt.width > 4096
  )
    throw Error('SI artwork dimensions do not match the receipt.')
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  if (hash !== receipt.sha256) throw Error('SI artwork checksum mismatch.')
  job.title = receipt.title
  const imageKey = atlasImageKey(job.tile, generationVersion, job.variant)
  const metadataKey = atlasMetadataKey(job.tile, generationVersion, job.variant)
  await env.ATLAS_BUCKET.put(imageKey, bytes, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })
  await env.ATLAS_BUCKET.put(
    metadataKey,
    JSON.stringify({
      contentType: 'image/png',
      contentBounds: null,
      generationVersion,
      generatedAt: job.createdAt,
      provider: 'codex-si',
      title: job.title,
      jobId: id,
      source: receipt.source,
      sha256: hash,
      outputSize: { width: receipt.width, height: receipt.height },
    }),
  )
  // Every retry publishes the same immutable variant. Publish the index last.
  await env.ATLAS_MANIFEST.getByName(manifestShardName(job.tile)).upsert([
    {
      ...job.tile,
      title: job.title,
      version: generationVersion,
      variant: job.variant,
      contentType: 'image/png',
      contentBounds: null,
    },
  ])
  job.status = 'complete'
  await env.ATLAS_BUCKET.put(jobKey(id), JSON.stringify(job))
  return reply(payload())
}
