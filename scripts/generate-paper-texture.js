import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFalClient } from '../server/fal-client.js'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(rootDirectory, 'public', 'romantic-paper-texture.png')
const prompt = `A perfectly seamless, tileable romantic era paper texture for a nineteenth-century hand-drawn atlas. Uniform warm aged ivory rag-paper surface, fine cotton and linen fibres, subtle natural grain, very faint tiny foxing, and gentle tonal variation. Macro flat material texture only, evenly lit, no physical sheet boundaries.`

const client = createFalClient()
const result = await client.subscribe('fal-ai/flux/schnell', {
  prompt,
  image_size: { width: 1024, height: 1024 },
  num_inference_steps: 4,
  output_format: 'png',
})
const imageUrl = result.data?.images?.[0]?.url
if (!imageUrl) throw new Error('Fal returned no paper-texture image.')

const response = await fetch(imageUrl)
if (!response.ok) throw new Error('Could not download the generated paper texture.')

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
console.log(`Generated ${outputPath}`)
