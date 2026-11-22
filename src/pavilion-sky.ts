// Keep each drawing surface stationary. Moving the texture lookup inside it lets
// the sampler blend neighbouring pixels even during very slow drift.
export function createPavilionSky(splash: HTMLElement) {
  const portrait = matchMedia('(max-aspect-ratio: 9/10)')
  const clouds = new Image()
  clouds.src = '/pavilion/whole-cloud-banks.webp'
  const surfaces = Array.from(
    splash.querySelectorAll<HTMLCanvasElement>(
      '.pavilion-sky canvas, .pavilion-aerostat canvas',
    ),
  ).map(canvas => {
    const context = canvas.getContext('2d')!
    const balloon = canvas.closest('.pavilion-aerostat')
    const west = balloon?.classList.contains('pavilion-aerostat--west')
    const distant = canvas.classList.contains('pavilion-sky__far')
    const image = balloon
      ? (canvas.parentElement?.querySelector('img') ?? clouds)
      : clouds
    let pattern: CanvasPattern | null = null
    let width = 0
    let height = 0
    let ratio = 1
    const matrix = new DOMMatrix()
    new ResizeObserver(([entry]) => {
      width = entry.contentRect.width
      height = entry.contentRect.height
      ratio = Math.min(devicePixelRatio, 2)
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      canvas.dispatchEvent(new Event('sky-ready', { bubbles: true }))
    }).observe(canvas)
    image.addEventListener('load', () =>
      canvas.dispatchEvent(new Event('sky-ready', { bubbles: true })),
    )
    return (time: number) => {
      if (!width || !height || !image.complete || !image.naturalWidth) return
      pattern ??= context.createPattern(image, balloon ? 'no-repeat' : 'repeat-x')
      if (!pattern) return
      const period = distant
        ? portrait.matches
          ? 1.1
          : 0.66
        : portrait.matches
          ? 2.3
          : 1.5
      const imageWidth = balloon ? width / 2 : width * period
      const imageHeight = balloon
        ? (imageWidth * image.naturalHeight) / image.naturalWidth
        : height
      const phase = time * (west ? 0.16 : 0.13) + (west ? 1 : 2)
      matrix.a = imageWidth / image.naturalWidth
      matrix.d = imageHeight / image.naturalHeight
      matrix.e = balloon
        ? (width - imageWidth) / 2 + imageWidth * 0.23 * Math.sin(phase)
        : distant
          ? imageWidth * (0.05 + (time % 710) / 710)
          : -imageWidth * ((time % 960) / 960)
      matrix.f = balloon
        ? (height - imageHeight) / 2 + imageHeight * 0.12 * Math.cos(phase * 1.3)
        : 0
      pattern.setTransform(matrix)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = pattern
      context.fillRect(0, 0, width, height)
      canvas.parentElement?.classList.add('has-sky-paint')
    }
  })
  return (time: number) =>
    surfaces.forEach(draw => {
      draw(time)
    })
}
