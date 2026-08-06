import QRCode from 'qrcode'
import type { Map as MapLibreMap } from 'maplibre-gl'

const instagramRatio = 4 / 5
const exportPixelRatio = 2
const exportWidth = 1080 * exportPixelRatio
const exportHeight = 1350 * exportPixelRatio
const maximumCapturePixelRatio = 4
const minimumReveals = 5

const nextFrame = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not prepare the map image.'))
    })
    reader.addEventListener('error', () =>
      reject(new Error('Could not prepare the map image.')),
    )
    reader.readAsDataURL(blob)
  })

const canvasToPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Could not render the map image.'))
    }, 'image/png')
  })

const drawCanvasLayer = (
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frameBounds: DOMRect,
) => {
  const bounds = canvas.getBoundingClientRect()
  const opacity = Number.parseFloat(getComputedStyle(canvas).opacity)
  if (!bounds.width || !bounds.height || opacity <= 0) return

  context.save()
  context.globalAlpha = Number.isFinite(opacity) ? opacity : 1
  context.drawImage(
    canvas,
    0,
    0,
    canvas.width,
    canvas.height,
    bounds.left - frameBounds.left,
    bounds.top - frameBounds.top,
    bounds.width,
    bounds.height,
  )
  context.restore()
}

const letterSpacedWidth = (
  context: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
) =>
  [...text].reduce((width, letter) => width + context.measureText(letter).width, 0) +
  letterSpacing * Math.max(0, text.length - 1)

const wrapTitle = (
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number,
) => {
  const lines: string[] = []
  let line = ''

  for (const word of text.trim().split(/\s+/)) {
    const nextLine = line ? `${line} ${word}` : word
    if (line && letterSpacedWidth(context, nextLine, letterSpacing) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = nextLine
    }
  }
  if (line) lines.push(line)
  return lines
}

const drawTitleCard = (
  context: CanvasRenderingContext2D,
  card: HTMLElement,
  containerBounds: DOMRect,
  frameBounds: DOMRect,
) => {
  const opacity = Number.parseFloat(getComputedStyle(card).opacity)
  if (card.hidden || opacity <= 0) return

  const width = card.offsetWidth
  const height = card.offsetHeight
  if (!width || !height) return

  const title = card.querySelector<HTMLElement>('.atlas-title-card__title')
  const titleStyle = title && getComputedStyle(title)
  const transform = getComputedStyle(card).transform
  const matrix = transform === 'none' ? undefined : new DOMMatrix(transform)
  const left = containerBounds.left + card.offsetLeft - frameBounds.left
  const top = containerBounds.top + card.offsetTop - frameBounds.top

  context.save()
  context.globalAlpha = Number.isFinite(opacity) ? opacity : 1
  context.translate(left + width / 2, top + height / 2)
  if (matrix) {
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
  }
  context.translate(-width / 2, -height / 2)

  const background = context.createLinearGradient(0, 0, 0, height)
  background.addColorStop(0, 'rgba(248, 237, 207, 0.94)')
  background.addColorStop(1, 'rgba(239, 220, 175, 0.94)')
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  context.strokeStyle = 'rgba(125, 92, 67, 0.82)'
  context.lineWidth = 1
  context.strokeRect(0.5, 0.5, width - 1, height - 1)

  context.fillStyle = '#e1aa62'
  context.strokeStyle = '#9e6657'
  for (const x of [5.5, width - 5.5]) {
    context.beginPath()
    context.arc(x, 5.5, 2.55, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  }

  if (title) {
    context.fillStyle = titleStyle?.color || '#3b2518'
    context.font = titleStyle?.font || "400 16px 'IM Fell English SC', Georgia, serif"
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const letterSpacing = Number.parseFloat(titleStyle?.letterSpacing || '') || 0
    const lines = wrapTitle(
      context,
      title.textContent || '',
      title.clientWidth,
      letterSpacing,
    )
    const lineHeight = Number.parseFloat(titleStyle?.lineHeight || '') || 16
    const titleCenter = title.offsetTop + title.offsetHeight / 2
    const firstLineCenter = titleCenter - ((lines.length - 1) * lineHeight) / 2
    lines.forEach((line, index) => {
      drawLetterSpacedText(
        context,
        line,
        title.offsetLeft + title.clientWidth / 2,
        firstLineCenter + index * lineHeight,
        letterSpacing,
      )
    })
  }
  context.restore()
}

const drawLetterSpacedText = (
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  baseline: number,
  letterSpacing: number,
) => {
  const letters = [...text]
  const textWidth = letterSpacedWidth(context, text, letterSpacing)
  let x = centerX - textWidth / 2
  for (const letter of letters) {
    context.fillText(letter, x, baseline)
    x += context.measureText(letter).width + letterSpacing
  }
}

const drawCredit = (context: CanvasRenderingContext2D, frameBounds: DOMRect) => {
  const fontSize = Math.max(17, Math.min(frameBounds.width * 0.018, 23))
  const text = 'by TIJPTJIK'
  context.save()
  context.font = `${fontSize}px 'IM Fell English SC', Georgia, serif`
  context.textAlign = 'left'
  context.textBaseline = 'bottom'
  context.fillStyle = '#74343c'
  drawLetterSpacedText(
    context,
    text,
    frameBounds.width / 2,
    frameBounds.height - 28.8,
    fontSize * 0.14,
  )
  context.restore()
}

const captureMap = async (map: MapLibreMap, frame: HTMLElement) => {
  const frameBounds = frame.getBoundingClientRect()
  if (!frameBounds.width || !frameBounds.height) {
    throw new Error('The map is not ready to be captured.')
  }

  const normalPixelRatio = map.getPixelRatio()
  const capturePixelRatio = Math.min(
    maximumCapturePixelRatio,
    Math.max(
      normalPixelRatio,
      exportWidth / frameBounds.width,
      exportHeight / frameBounds.height,
    ),
  )
  const changedPixelRatio = capturePixelRatio > normalPixelRatio

  try {
    if (changedPixelRatio) map.setPixelRatio(capturePixelRatio)
    map.triggerRepaint()
    await nextFrame()

    const mapCanvas = map.getCanvas()
    const canvasBounds = mapCanvas.getBoundingClientRect()
    if (!canvasBounds.width || !canvasBounds.height) {
      throw new Error('The map is not ready to be captured.')
    }

    const cropLeft = frameBounds.left - canvasBounds.left
    const cropTop = frameBounds.top - canvasBounds.top
    const scale = mapCanvas.width / canvasBounds.width
    const exportCanvas = document.createElement('canvas')
    exportCanvas.width = exportWidth
    exportCanvas.height = exportHeight
    const context = exportCanvas.getContext('2d')
    if (!context) throw new Error('Could not prepare the map image.')

    // Work in CSS pixels so the WebGL map, canvas clouds, and DOM title cards
    // use the same coordinates. The export canvas preserves the 2x resolution.
    context.scale(exportWidth / frameBounds.width, exportHeight / frameBounds.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      mapCanvas,
      cropLeft * scale,
      cropTop * scale,
      frameBounds.width * scale,
      frameBounds.height * scale,
      0,
      0,
      frameBounds.width,
      frameBounds.height,
    )

    const container = map.getContainer()
    const containerBounds = container.getBoundingClientRect()
    container.querySelectorAll<HTMLElement>('.atlas-title-card').forEach(card => {
      drawTitleCard(context, card, containerBounds, frameBounds)
    })

    // The fog is kept in separate canvases so it can animate independently of
    // MapLibre. Draw them in their screen stacking order over the title cards.
    for (const selector of [
      '.atlas-fog',
      '.atlas-fog-loading',
      '.atlas-fog-cached-mist',
    ]) {
      const canvas = container.querySelector<HTMLCanvasElement>(selector)
      if (canvas) drawCanvasLayer(context, canvas, frameBounds)
    }

    drawCredit(context, frameBounds)
    return await canvasToPng(exportCanvas)
  } finally {
    if (changedPixelRatio) {
      map.setPixelRatio(normalPixelRatio)
      map.triggerRepaint()
    }
  }
}

export const installAtlasSharing = (
  map: MapLibreMap,
  audio?: { playCameraFlash: () => void },
) => {
  const container = map.getContainer()
  const ui = document.createElement('section')
  ui.className = 'atlas-share-ui'
  ui.setAttribute('aria-live', 'polite')

  const shareButton = document.createElement('button')
  shareButton.className = 'atlas-share-button atlas-share-button--trigger'
  shareButton.type = 'button'
  shareButton.innerHTML = `
    <span class="atlas-share-button__ornament" aria-hidden="true">✦</span>
    <span class="atlas-share-button__label">Share your map</span>
    <span class="atlas-share-button__arrow" aria-hidden="true">↗</span>
  `
  shareButton.setAttribute('aria-label', 'Share your map')
  shareButton.hidden = true

  const frame = document.createElement('div')
  frame.className = 'atlas-share-frame'
  frame.hidden = true
  frame.setAttribute('aria-hidden', 'true')

  const composePanel = document.createElement('div')
  composePanel.className = 'atlas-share-compose'
  composePanel.hidden = true
  const composeHint = document.createElement('p')
  composeHint.className = 'atlas-share-compose__hint'
  composeHint.textContent = 'Arrange your discoveries inside the frame.'
  const snapButton = document.createElement('button')
  snapButton.className = 'atlas-share-button atlas-share-button--snap'
  snapButton.type = 'button'
  snapButton.setAttribute('aria-label', 'Snap this map')
  snapButton.title = 'Snap this map'
  snapButton.innerHTML = `
    <svg class="atlas-camera-obscura" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <circle class="atlas-camera-obscura__rim" cx="48" cy="48" r="43" />
      <circle class="atlas-camera-obscura__beading" cx="48" cy="48" r="37" />
      <path class="atlas-camera-obscura__filigree" d="M48 14c4 7 10 9 17 7-2 7 0 13 7 17-7 4-9 10-7 17-7-2-13 0-17 7-4-7-10-9-17-7 2-7 0-13-7-17 7-4 9-10 7-17 7 2 13 0 17-7Z" />
      <path class="atlas-camera-obscura__body" d="M27 39h11l5-7h10l5 7h11v22H27Z" />
      <path class="atlas-camera-obscura__top" d="M39 32v-5h18v5" />
      <circle class="atlas-camera-obscura__lens-ring" cx="48" cy="50" r="13" />
      <circle class="atlas-camera-obscura__lens" cx="48" cy="50" r="8" />
      <path class="atlas-camera-obscura__shine" d="M44 46c2-3 6-4 9-2" />
      <path class="atlas-camera-obscura__rays" d="m48 17 2 5m18 4-4 4m15 18-5 2m-6 20-4-4M48 83l-2-5M28 70l4-4m-15-18 5-2m6-20 4 4" />
    </svg>
  `
  const composeError = document.createElement('p')
  composeError.className = 'atlas-share-error'
  composeError.hidden = true
  const composeCloseButton = document.createElement('button')
  composeCloseButton.className = 'atlas-share-compose-close'
  composeCloseButton.type = 'button'
  composeCloseButton.setAttribute('aria-label', 'Exit map capture mode')
  composeCloseButton.title = 'Exit map capture mode'
  composeCloseButton.innerHTML = '<span aria-hidden="true">×</span>'
  composePanel.append(composeHint, snapButton, composeError, composeCloseButton)

  const result = document.createElement('div')
  result.className = 'atlas-share-result'
  result.hidden = true
  result.setAttribute('role', 'dialog')
  result.setAttribute('aria-modal', 'true')
  result.setAttribute('aria-label', 'Map image ready to scan')
  const resultTitle = document.createElement('h2')
  resultTitle.textContent = 'Your map was pressed'
  const resultCopy = document.createElement('p')
  resultCopy.innerHTML =
    'Scan to get the image on your phone,<br>then share it anywhere.'
  const qrImage = document.createElement('img')
  qrImage.className = 'atlas-share-qr'
  qrImage.alt = 'QR code for your map image'
  const retakeButton = document.createElement('button')
  retakeButton.className = 'atlas-share-retake'
  retakeButton.type = 'button'
  retakeButton.textContent = 'Retake'
  const closeButton = document.createElement('button')
  closeButton.className = 'atlas-share-close'
  closeButton.type = 'button'
  closeButton.textContent = 'Back to map'
  result.append(resultTitle, resultCopy, qrImage, retakeButton, closeButton)

  const flash = document.createElement('div')
  flash.className = 'atlas-share-flash'
  flash.setAttribute('aria-hidden', 'true')

  ui.append(shareButton, frame, composePanel, result, flash)
  container.append(ui)

  let revealCount = 0
  let mode: 'map' | 'compose' | 'result' = 'map'

  const showShareButton = () => {
    shareButton.hidden = false
    // Restart the entrance after returning from the share flow as well as on
    // the first reveal.
    requestAnimationFrame(() => shareButton.classList.add('is-visible'))
  }

  const hideShareButton = () => {
    shareButton.classList.remove('is-visible')
    shareButton.hidden = true
  }

  const syncFrameSize = () => {
    const width = container.clientWidth
    const height = container.clientHeight
    const availableWidth = Math.max(0, width - 40)
    const availableHeight = Math.max(0, height - 160)
    const frameHeight = Math.min(availableHeight, availableWidth / instagramRatio)
    const frameTop = Math.max(0, (height - frameHeight) / 2)
    const frameWidth = Math.max(0, frameHeight * instagramRatio)
    frame.style.width = `${frameWidth}px`
    frame.style.height = `${Math.max(0, frameHeight)}px`
    composePanel.style.setProperty('--atlas-share-frame-top', `${frameTop}px`)
    composePanel.style.setProperty('--atlas-share-frame-height', `${frameHeight}px`)
    composePanel.style.setProperty(
      '--atlas-share-frame-right',
      `${(width + frameWidth) / 2}px`,
    )
  }

  const showCompose = () => {
    mode = 'compose'
    result.hidden = true
    frame.hidden = false
    composePanel.hidden = false
    hideShareButton()
    composeError.hidden = true
    syncFrameSize()
  }

  const showMap = () => {
    mode = 'map'
    frame.hidden = true
    composePanel.hidden = true
    result.hidden = true
    if (revealCount >= minimumReveals) showShareButton()
    else hideShareButton()
  }

  const setError = (error: unknown) => {
    composeError.textContent =
      error instanceof Error ? error.message : 'Could not save your map.'
    composeError.hidden = false
  }

  const snap = async () => {
    snapButton.disabled = true
    snapButton.classList.add('is-saving')
    snapButton.setAttribute('aria-label', 'Saving your map')
    snapButton.title = 'Saving your map'
    composeError.hidden = true
    flash.classList.remove('is-flashing')
    void flash.offsetWidth
    flash.classList.add('is-flashing')
    audio?.playCameraFlash()
    try {
      const image = await captureMap(map, frame)
      const response = await fetch('/api/share-maps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: await blobToDataUrl(image) }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.url !== 'string') {
        throw new Error(body?.error ?? 'Could not save your map.')
      }
      qrImage.src = await QRCode.toDataURL(body.url, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 720,
        color: { dark: '#6e3540', light: '#f8edcf' },
      })
      mode = 'result'
      frame.hidden = true
      composePanel.hidden = true
      result.hidden = false
    } catch (error) {
      setError(error)
    } finally {
      snapButton.disabled = false
      snapButton.classList.remove('is-saving')
      snapButton.setAttribute('aria-label', 'Snap this map')
      snapButton.title = 'Snap this map'
    }
  }

  shareButton.addEventListener('click', showCompose)
  snapButton.addEventListener('click', snap)
  composeCloseButton.addEventListener('click', showMap)
  retakeButton.addEventListener('click', showCompose)
  closeButton.addEventListener('click', showMap)
  map.on('resize', syncFrameSize)

  return {
    setRevealCount: (count: number) => {
      revealCount = count
      if (mode === 'map') {
        const isAvailable = count >= minimumReveals
        if (isAvailable) showShareButton()
        else hideShareButton()
      }
    },
    reset: showMap,
  }
}
