// Sample only the painted harbour surface. Reapply the stationary alpha mask
// after refraction so shorelines, hulls, reflections' origins and mullions stay put.
export function createHarbourWater(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')!
  const portrait = matchMedia('(max-aspect-ratio: 9/10)')
  const plates = new Map<string, HTMLImageElement>()
  return (time: number, night: boolean) => {
    const tall = portrait.matches
    const key = 'glasshouse' + (tall ? '-portrait' : '') + (night ? '-night' : '')
    let plate = plates.get(key)
    if (!plate) {
      plate = new Image()
      plate.onload = () => canvas.dispatchEvent(new Event('water-ready'))
      plate.src = '/pavilion/' + key + '-water.webp'
      plates.set(key, plate)
    }
    if (!plate.complete || !plate.naturalWidth) return
    const light = night ? 'night' : 'day'
    if (canvas.dataset.light !== light) canvas.dataset.light = light
    const w = plate.naturalWidth
    const h = plate.naturalHeight
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    // Night reflections stay close to the vertical strokes in the painted water.
    const phase = night ? time * 1.65 : time
    const amplitude = night ? .48 : 1
    context.clearRect(0, 0, w, h)
    for (let y = 0; y < h; y++) {
      const depth = y / h
      const drift =
        (1 + depth * 2.4) * Math.sin(phase * 0.72 + y * 0.19) +
        Math.sin(phase * 0.41 - y * 0.32)
      const lift = (0.3 + depth * 0.7) * Math.sin(y * 0.28 + phase * 0.8)
      context.drawImage(
        plate,
        0,
        Math.max(0, Math.min(h - 1, y + lift * amplitude)),
        w,
        1,
        drift * amplitude,
        y,
        w,
        1,
      )
    }
    context.globalCompositeOperation = 'destination-in'
    context.drawImage(plate, 0, 0)
    context.globalCompositeOperation = 'source-over'
  }
}
