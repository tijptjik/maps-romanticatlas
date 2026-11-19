import { parseArtworkReview, type Painting } from './artwork-review'

export const revisionEndpoint = '/api/artwork-revisions'
export const revisionImagePattern = /^\/artwork-revisions\/([0-9a-f]{32})\.png$/
export type RevisionMode = 'adjust' | 'spread'
export type Revision = {
  source: Painting
  mode: RevisionMode
  state: 'pending' | 'ready' | 'failed'
  candidate?: Painting
}

export function revisionRequest(body: any) {
  if (body?.mode !== 'adjust' && body?.mode !== 'spread') return null
  const art = parseArtworkReview({ ...body.source, status: 'rejected' })
  if (!art || ![body.mapImage, body.previousImage].every(value =>
    typeof value === 'string' && value.length <= 4_500_000 && value.startsWith('data:image/png;base64,'))) return null
  const { status, ...source } = art
  return { mode: body.mode as RevisionMode, source, mapImage: body.mapImage, previousImage: body.previousImage }
}
