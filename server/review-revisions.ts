import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { Revision } from '../src/artwork-revision'

const root = path.resolve(import.meta.dir, '..')
const jobsDirectory = 'generated-tiles/dream-atlas/review-revisions/jobs'
const jobs = path.join(root, jobsDirectory)
const script = path.join(root, 'scripts/review-revisions.py')

export async function revisionList(): Promise<Revision[]> {
  const entries = await readdir(jobs).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return Promise.all(entries.map(async id => JSON.parse(await readFile(path.join(jobs, id, 'revision.json'), 'utf8'))))
}
export const revisionFile = (id: string, projectRoot = root) =>
  path.join(projectRoot, jobsDirectory, id, 'candidate.png')

let running = false
let requested = false
export async function resumeRevisions() {
  requested = true
  if (running) return
  running = true
  try {
    while (requested) {
      requested = false
      if (!(await revisionList()).some(record => record.state === 'pending')) continue
      const worker = Bun.spawn(['python3', script, 'work'], { cwd: root, stdout: 'ignore', stderr: 'inherit' })
      if (await worker.exited) throw Error('Revision worker exited early')
    }
  } catch (error) {
    console.error('[atlas] revision worker', error)
  } finally {
    running = false
  }
}

export async function submitRevision(body: unknown) {
  const child = Bun.spawn(['python3', script, 'submit'], {
    cwd: root, stdin: new Blob([JSON.stringify(body)]), stdout: 'pipe', stderr: 'inherit',
  })
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code) throw Error('Could not queue the artwork revision.')
  void resumeRevisions()
  return JSON.parse(text)
}
