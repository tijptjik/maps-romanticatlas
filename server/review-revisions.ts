import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { Revision } from '../src/artwork-revision'

const root = path.resolve(import.meta.dir, '..')
const jobs = path.join(root, 'generated-tiles/dream-atlas/review-revisions/jobs')

export async function revisionList(): Promise<Revision[]> {
  const entries = await readdir(jobs).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return Promise.all(entries.map(async id => JSON.parse(await readFile(path.join(jobs, id, 'revision.json'), 'utf8'))))
}
export const revisionFile = (id: string) => path.join(jobs, id, 'candidate.png')
