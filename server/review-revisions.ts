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
  const records = await Promise.all(entries.map(async id => JSON.parse(await readFile(path.join(jobs, id, 'revision.json'), 'utf8'))))
  return records.filter(record => record.state !== 'withdrawn')
}
export const revisionFile = (id: string, projectRoot = root) =>
  path.join(projectRoot, jobsDirectory, id, 'candidate.png')

let running = false
let requested = false
let wakeup: ReturnType<typeof setTimeout> | undefined
export async function resumeRevisions() {
  requested = true
  if (running) return
  clearTimeout(wakeup)
  running = true
  try {
    while (requested) {
      requested = false
      if (!(await revisionList()).some(record => record.state === 'pending')) continue
      const worker = Bun.spawn(['python3', script, 'work'], { cwd: root, stdout: 'pipe', stderr: 'inherit' })
      const [code, output] = await Promise.all([worker.exited, new Response(worker.stdout).text()])
      if (code) throw Error('Revision worker exited early')
      const retryAt = JSON.parse(output)
      if (!requested && typeof retryAt === 'number') {
        wakeup = setTimeout(() => void resumeRevisions(), Math.max(0, retryAt * 1000 - Date.now()))
      }
    }
  } catch (error) {
    console.error('[atlas] revision worker', error)
    wakeup = setTimeout(() => void resumeRevisions(), 30_000)
  } finally {
    running = false
  }
}

export async function changeRevision(command: 'submit' | 'withdraw', body: unknown) {
  const child = Bun.spawn(['python3', script, command], {
    cwd: root, stdin: new Blob([JSON.stringify(body)]), stdout: 'pipe', stderr: 'inherit',
  })
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code) throw Error('Could not ' + command + ' the artwork revision.')
  if (command === 'submit') void resumeRevisions()
  return JSON.parse(text)
}
