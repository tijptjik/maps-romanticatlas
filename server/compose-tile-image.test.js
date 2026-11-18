import { test, expect } from 'bun:test'
import sharp from 'sharp'
import { composeTileImage } from './compose-tile-image.ts'

const png = (width, background) =>
  sharp({ create: { width, height: width, channels: 4, background } })
    .png()
    .toBuffer()
const url = data => `data:image/png;base64,${data.toString('base64')}`

test('native-resolution composition preserves source under locked lines and black mask', async () => {
  const source = await png(512, '#ff0000')
  const generated = { data: await png(1024, '#00ff00') }
  const overlay = await sharp(await png(512, '#00000000'))
    .composite([
      {
        input: await sharp({
          create: { width: 512, height: 24, channels: 4, background: '#0000ff' },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 244,
      },
    ])
    .png()
    .toBuffer()
  for (const size of [512, 1024]) {
    const result = await composeTileImage(
      url(source),
      generated,
      url(await png(512, '#000000')),
      url(overlay),
      size,
    )
    const { data, info } = await sharp(result.data)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(size)
    expect(info.height).toBe(size)
    expect([...data.subarray(0, 3)]).toEqual([255, 0, 0])
    const center = ((size / 2) * size + size / 2) * 3
    expect([...data.subarray(center, center + 3)]).toEqual([0, 0, 255])
  }
})

test('waterfront artwork crosses a protected line and joins the basemap at the tile edge', async () => {
  const result = await composeTileImage(
    url(await png(512, '#ff0000')),
    { data: await png(512, '#00ff00') },
    url(await png(512, '#000000')),
    url(await png(512, '#0000ff')),
    512,
    true,
  )
  const data = await sharp(result.data).removeAlpha().raw().toBuffer()
  const center = (256 * 512 + 256) * 3
  expect([...data.subarray(center, center + 3)]).toEqual([0, 255, 0])
  expect([...data.subarray(0, 3)]).toEqual([255, 0, 0])
})
