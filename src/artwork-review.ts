import { isAtlasScene } from './atlas-scenes'

export type Painting = {
  scene?: string
  title: string
  x: number
  y: number
  rows: number
  columns?: number
  url: string
  imageUrl?: string
  animation?: {
    loopUrl?: string
    pixelsPerTile: number
    glitterOrigin?: number[]
    auditoriumOriginPixels?: number[]
    motion?: { box: number[]; sprite: string }
    spriteUrl?: string
    folder?: string
    plate?: string
  }
}
export type ArtworkReview = Painting & { status: 'accepted' | 'rejected' }
export const reviewEndpoint = '/api/artwork-reviews'

export function parseArtworkReview(value: unknown): ArtworkReview | null {
  if (!value || typeof value !== 'object') return null
  const { title, x, y, rows, columns, url, scene, status } = value as ArtworkReview
  if (
    (scene !== undefined && !isAtlasScene(scene)) ||
    typeof title !== 'string' ||
    !title ||
    title.length > 200 ||
    !Number.isInteger(x) ||
    x < 0 ||
    x >= 2 ** 18 ||
    !Number.isInteger(y) ||
    y < 0 ||
    y >= 2 ** 18 ||
    (rows !== 1 && rows !== 2) ||
    y < rows - 1 ||
    (columns !== undefined &&
      ((columns !== 1 && columns !== 2 && columns !== 3) || x + columns > 2 ** 18)) ||
    typeof url !== 'string' ||
    url.length > 500 ||
    !/^\/(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+(?:\?[a-z0-9_=&%-]+)?$/i.test(url) ||
    url.includes('/../') ||
    (status !== 'accepted' && status !== 'rejected')
  )
    return null
  return {
    title,
    x,
    y,
    rows,
    ...(scene && { scene }),
    ...(columns === undefined ? {} : { columns }),
    url,
    status,
  }
}
