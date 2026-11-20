const decodedImages = new Map<string, Promise<HTMLImageElement>>()

export function forgetArtworkImage(url: string) {
  decodedImages.delete(url)
}

// Fetch explicitly so an HTML error page or a missing image does not surface as
// the browser's opaque "source image cannot be decoded" error. A fresh retry
// also replaces a failed response that may have been retained by the HTTP cache.
export async function loadArtworkImage(url: string) {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response | undefined
    let objectUrl: string | undefined
    try {
      response = await fetch(url, { cache: attempt ? 'reload' : 'default', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.size) throw Error('Empty image response')
      if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream')
        throw Error(`Unexpected image content type: ${blob.type}`)
      objectUrl = URL.createObjectURL(blob)
      const image = new Image()
      image.decoding = 'async'
      image.src = objectUrl
      await image.decode()
      return image
    } catch (error) {
      failure = error
      console.warn('[atlas] Artwork image load failed', {
        url, attempt: attempt + 1, status: response?.status,
        contentType: response?.headers.get('content-type'), ray: response?.headers.get('cf-ray'), error,
      })
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }
  throw new Error('The artwork could not load. Click the cloud to try again.', { cause: failure })
}

export function decodeArtworkImage(url: string): Promise<HTMLImageElement> {
  const cached = decodedImages.get(url)
  if (cached) return cached
  const request = loadArtworkImage(url)
  decodedImages.set(url, request)
  request.catch(() => {
    if (decodedImages.get(url) === request) decodedImages.delete(url)
  })
  return request
}
