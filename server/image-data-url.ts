export const parseImageDataUrl = (
  dataUrl,
  errorMessage = 'The image must be a valid image data URL.',
) => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s)
  if (!match) throw new Error(errorMessage)
  return { contentType: match[1], data: Buffer.from(match[2], 'base64') }
}
