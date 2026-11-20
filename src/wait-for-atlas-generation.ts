export async function waitForAtlasGeneration(response: Response, signal: AbortSignal, onProgress?: () => void) {
  if (response.status !== 202) return response
  const { statusUrl } = await response.json()
  if (typeof statusUrl !== 'string' || !/^\/api\/discovery-jobs\/[a-f0-9-]{36}$/.test(statusUrl))
    throw new Error('The generator returned an invalid job location.')
  do {
    await new Promise(resolve => window.setTimeout(resolve, 1500))
    response = await fetch(statusUrl, { signal, cache: 'no-store' })
    onProgress?.()
  } while (response.status === 202)
  return response
}
