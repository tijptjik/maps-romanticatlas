const openrouterApiUrl = 'https://openrouter.ai/api/v1/chat/completions'

const parseDataUrl = dataUrl => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s)
  if (!match) throw new Error('OpenRouter returned an invalid image data URL.')
  return { contentType: match[1], data: Buffer.from(match[2], 'base64') }
}

const findImageUrl = message => {
  const imagePart = message?.images?.find(part => part.image_url?.url)
    ?? message?.content?.find?.(part => part.image_url?.url)
  return imagePart?.image_url?.url
}

export const createOpenRouterClient = ({
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5.4-image-2',
} = {}) => {
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY. Set it in the server environment before generating images.')
  }

  const requestImage = async (prompt, sourceImage) => {
    const content = [{ type: 'text', text: prompt }]
    if (sourceImage) content.push({ type: 'image_url', image_url: { url: sourceImage } })

    const response = await fetch(openrouterApiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'http-referer': 'https://visionarymachines.hype.hk',
        'x-title': 'Visionary Machines Map',
      },
      body: JSON.stringify({
        model,
        modalities: ['text', 'image'],
        messages: [{ role: 'user', content }],
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenRouter image generation failed (${response.status}): ${await response.text()}`)
    }

    const result = await response.json()
    const imageUrl = findImageUrl(result.choices?.[0]?.message)
    if (!imageUrl) throw new Error('OpenRouter returned no image for the requested prompt.')
    return parseDataUrl(imageUrl)
  }

  return {
    generateImage: ({ prompt }) => requestImage(prompt),
    editImage: ({ prompt, sourceImage }) => requestImage(prompt, sourceImage),
  }
}
