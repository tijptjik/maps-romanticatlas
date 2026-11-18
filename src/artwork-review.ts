export type Painting = { title: string; x: number; y: number; rows: number; url: string }
export type ArtworkReview = Painting & { status: 'accepted' | 'rejected' }
export const reviewEndpoint = '/api/artwork-reviews'

export function parseArtworkReview(value: unknown): ArtworkReview | null {
  if (!value || typeof value !== 'object') return null
  const { title, x, y, rows, url, status } = value as ArtworkReview
  if (typeof title !== 'string' || !title || title.length > 200 ||
      !Number.isInteger(x) || x < 0 || x >= 2 ** 18 ||
      !Number.isInteger(y) || y < 0 || y >= 2 ** 18 ||
      (rows !== 1 && rows !== 2) || y < rows - 1 ||
      typeof url !== 'string' || url.length > 500 ||
      !/^\/(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+(?:\?[a-z0-9_=&%-]+)?$/i.test(url) ||
      url.includes('/../') || (status !== 'accepted' && status !== 'rejected')) return null
  return { title, x, y, rows, url, status }
}
