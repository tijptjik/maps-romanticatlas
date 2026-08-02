import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createOpenRouterClient } from '../server/openrouter-client.ts'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(rootDirectory, 'public', 'romantic-paper-texture.png')
const prompt = `A perfectly seamless, tileable romantic era paper texture for a nineteenth-century hand-drawn atlas. Uniform warm aged ivory rag-paper surface, fine cotton and linen fibres, subtle natural grain, very faint tiny foxing, and gentle tonal variation. Macro flat material texture only, evenly lit, no physical sheet boundaries.`

const client = createOpenRouterClient()
const generatedImage = await client.generateImage({ prompt })

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, generatedImage.data)
console.log(`Generated ${outputPath}`)
