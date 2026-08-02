const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/models'

const parseDataUrl = dataUrl => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s)
  if (!match) throw new Error('Gemini image inputs must be base64 image data URLs.')
  return { mimeType: match[1], data: match[2] }
}

export const createGeminiClient = ({ apiKey = process.env.GEMINI_API_KEY } = {}) => {
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Set it in the server environment before generating images.')
  }

  return {
    async generateImage({ prompt, sourceImage }) {
      const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-image'
      const contents = [{ text: prompt }]
      if (sourceImage) contents.push({ inlineData: parseDataUrl(sourceImage) })

      const response = await fetch(`${geminiApiBaseUrl}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          referer: 'https://visionarymachines.hype.hk/',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: contents }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      })

      if (!response.ok) {
        throw new Error(`Gemini image generation failed (${response.status}): ${await response.text()}`)
      }

      const result = await response.json()
      const imagePart = result.candidates?.flatMap(candidate => candidate.content?.parts ?? [])
        .find(part => part.inlineData?.data)
      if (!imagePart) throw new Error('Gemini returned no image for the requested prompt.')

      return {
        contentType: imagePart.inlineData.mimeType ?? 'image/png',
        data: Buffer.from(imagePart.inlineData.data, 'base64'),
      }
    },
  }
}
