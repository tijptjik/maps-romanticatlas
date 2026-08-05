import { parseImageDataUrl } from './image-data-url.ts'

const openrouterImagesApiUrl = 'https://openrouter.ai/api/v1/images'

const parseGeneratedImage = (value, mediaType) => {
  if (mediaType && mediaType !== 'image/png') {
    throw new Error(`OpenRouter returned an unsupported image format (${mediaType}).`)
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('OpenRouter returned invalid image data.')
  }
  return parseImageDataUrl(
    `data:image/png;base64,${value}`,
    'OpenRouter returned invalid image data.',
  )
}

export const createOpenRouterClient = ({
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5.4-image-2',
} = {}) => {
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY. Set it in the server environment before generating images.')
  }

  const requestImage = async (prompt, sourceImage, referenceImages = []) => {
    const inputReferences = [sourceImage, ...referenceImages]
      .filter(Boolean)
      .map(image => ({ type: 'image_url', image_url: { url: image } }))

    const requestImage = () =>
      fetch(openrouterImagesApiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://romanticatlas.hype.hk',
          'x-title': 'Visionary Machines Map',
        },
        body: JSON.stringify({
          model,
          prompt,
          ...(inputReferences.length ? { input_references: inputReferences } : {}),
          aspect_ratio: '1:1',
          n: 1,
          output_format: 'png',
        }),
      })

    let response
    try {
      response = await requestImage()
    } catch {
      try {
        response = await requestImage()
      } catch {
        throw new Error(
          'The image-generation service could not be reached. Please try clearing this tile again shortly.',
        )
      }
    }

    if (!response.ok) {
      throw new Error(`OpenRouter image generation failed (${response.status}): ${await response.text()}`)
    }

    const result = await response.json()
    const image = result.data?.find(item => item?.b64_json)
    if (!image) throw new Error('OpenRouter returned no image for the requested prompt.')
    return parseGeneratedImage(image.b64_json, image.media_type)
  }

  return {
    generateImage: ({ prompt }) => requestImage(prompt, undefined),
    editImage: ({ prompt, sourceImage, referenceImages }) =>
      requestImage(prompt, sourceImage, referenceImages),
  }
}
