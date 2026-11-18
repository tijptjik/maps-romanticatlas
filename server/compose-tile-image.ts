import sharp from 'sharp'
import { composeWaterfrontPixels } from '../src/waterfront-composition.ts'
import { parseImageDataUrl } from './image-data-url.ts'
import { atlasTileSize } from '../src/atlas-protocol.ts'

export const composeTileImage = async (
  sourceImage,
  generatedImage,
  safeMask,
  lineOverlay,
  pixelSize = atlasTileSize,
  waterfront = false,
) => {
  const source = parseImageDataUrl(
    sourceImage,
    'The tile source image must be a valid image data URL.',
  )
  const generated = generatedImage.data
  if (waterfront) {
    const rgba = (data: Buffer) => sharp(data)
      .resize(pixelSize, pixelSize, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer()
    const [base, art] = await Promise.all([rgba(source.data), rgba(generated)])
    const pixels = composeWaterfrontPixels(base, art, pixelSize)
    const data = await sharp(pixels, { raw: { width: pixelSize, height: pixelSize, channels: 4 } }).png().toBuffer()
    return { contentType: 'image/png', data }
  }
  const mask = parseImageDataUrl(
    safeMask,
    'The tile safe mask must be a valid image data URL.',
  )
  const overlay = parseImageDataUrl(
    lineOverlay,
    'The tile line overlay must be a valid image data URL.',
  )
  const alpha = await sharp(mask.data)
    .resize(pixelSize, pixelSize, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .greyscale()
    .blur((10 * pixelSize) / atlasTileSize)
    .raw()
    .toBuffer()
  const lockedLineAlpha = await sharp(overlay.data)
    .ensureAlpha()
    .extractChannel(3)
    .resize(pixelSize, pixelSize, { fit: 'fill' })
    .raw()
    .toBuffer()
  for (let index = 0; index < alpha.length; index += 1) {
    if (lockedLineAlpha[index] > 0) alpha[index] = 0
  }
  const maskedGenerated = await sharp(generated)
    .flatten({ background: '#000000' })
    .resize(pixelSize, pixelSize, { fit: 'fill' })
    .joinChannel(alpha, {
      raw: { width: pixelSize, height: pixelSize, channels: 1 },
    })
    .png()
    .toBuffer()
  const tile = await sharp(source.data)
    .resize(pixelSize, pixelSize, { fit: 'fill' })
    .composite([
      { input: maskedGenerated, left: 0, top: 0 },
      {
        input: await sharp(overlay.data).resize(pixelSize, pixelSize).png().toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer()
  return { contentType: 'image/png', data: tile }
}
