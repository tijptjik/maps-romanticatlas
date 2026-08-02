import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = path.join(rootDirectory, 'generated-tiles')
const bucket = process.env.ATLAS_R2_BUCKET ?? 'maps-romanticatlas-atlas'
const concurrency = 6

const collectFiles = async directory => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath))
    else if (entry.isFile() && /\.(?:image|json)$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

const files = (await collectFiles(cacheDirectory)).sort()
if (!files.length) throw new Error(`No cache files found in ${cacheDirectory}`)

let completed = 0
let cursor = 0
const uploadNext = async () => {
  while (cursor < files.length) {
    const filePath = files[cursor]
    cursor += 1
    const relativePath = path.relative(rootDirectory, filePath).split(path.sep).join('/')
    const key = relativePath.replace(/^generated-tiles\//, 'atlas/')
    const contentType = filePath.endsWith('.image') ? 'image/png' : 'application/json; charset=utf-8'
    await execFileAsync('wrangler', [
      'r2', 'object', 'put', `${bucket}/${key}`,
      '--file', filePath,
      '--content-type', contentType,
      '--cache-control', 'public, max-age=31536000, immutable',
      '--remote', '--force',
    ], { cwd: rootDirectory, maxBuffer: 2_000_000 })
    completed += 1
    console.log(`[${completed}/${files.length}] uploaded ${key}`)
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, uploadNext))
console.log(`Uploaded ${files.length} cache files to R2 bucket ${bucket}`)
