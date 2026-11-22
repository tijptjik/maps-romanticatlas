import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { atlasScenes, type AtlasScene } from '../src/atlas-scenes.ts'
import { parseImageDataUrl } from './image-data-url.ts'

// This adapter owns local execution. The map consumes the same completed tile
// payload whether a future worker runs the job here or on another machine.
export async function renderCodexTile(
  root: string,
  tile: { scene: AtlasScene; y: number },
  sourceImage: string,
) {
  const jobId = randomUUID()
  const directory = path.join(root, 'generated-tiles/dream-atlas/live/jobs', jobId)
  const source = parseImageDataUrl(sourceImage)
  const dimensions = await sharp(source.data, {
    limitInputPixels: 2048 ** 2,
  }).metadata()
  if (
    dimensions.format !== 'png' ||
    dimensions.width !== dimensions.height ||
    ![512, 1024, 2048].includes(dimensions.width)
  )
    throw new Error('Codex requires a square atlas PNG.')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'source.png'), source.data)
  const process = Bun.spawn(
    [
      'python3',
      'scripts/dream-atlas.py',
      'live-tile',
      jobId,
      tile.scene,
      String(tile.y),
    ],
    {
      cwd: root,
      stdin: new Blob([atlasScenes[tile.scene]]),
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const [exit, diagnostic] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  if (exit !== 0) {
    console.error('[atlas] Codex job', jobId, diagnostic.trim())
    throw new Error(
      'Codex could not finish this tile. ' +
        (diagnostic.match(/Codex image generation: [a-z-]+/)?.[0] ??
          'Check the local generator log.'),
    )
  }
  const receipt = JSON.parse(
    await readFile(path.join(directory, 'result.json'), 'utf8'),
  )
  return {
    data: await readFile(path.join(directory, 'image.png')),
    contentType: 'image/png',
    provider: 'codex',
    jobId,
    title: receipt.title,
    source: receipt.source,
    sha256: receipt.sha256,
    outputSize: { width: receipt.width, height: receipt.height },
  }
}
