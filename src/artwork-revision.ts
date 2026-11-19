import { type Painting } from './artwork-review'

export const revisionEndpoint = '/api/artwork-revisions'
export const revisionImagePattern = /^\/artwork-revisions\/([0-9a-f]{32})\.png$/
export type RevisionMode = 'adjust' | 'spread'
export type Revision = {
  source: Painting
  mode: RevisionMode
  state: 'pending' | 'ready' | 'failed'
  candidate?: Painting
}
