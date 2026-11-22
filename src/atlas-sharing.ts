import cameraFrameUrl from './assets/orchid-camera-frame.webp?url'
import shareFrameUrl from './assets/orchid-share-frame.webp?url'
import QRCode from 'qrcode'
import type { Map as MapLibreMap } from 'maplibre-gl'

const instagramRatio = 4 / 5
const exportPixelRatio = 2
const exportWidth = 1080 * exportPixelRatio
const exportHeight = 1350 * exportPixelRatio
const maximumShareImageBytes = 8_000_000
const maximumCapturePixelRatio = 4
const minimumReveals = 5
const cameraIcon = `<svg class="atlas-camera-icon" viewBox="0 0 36 26" fill="currentColor"
  aria-hidden="true" focusable="false">
  <path fill-rule="evenodd" d="M3 7h2V4h6v2h4l2-3h11l2 4h2a2 2 0 0 1 2 2v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a2 2 0 0 1 1-2Z
    M5 10v3h6v-3Z M27.5 15a6.5 6.5 0 1 0-13 0 6.5 6.5 0 1 0 13 0Z"/>
  <circle cx="21" cy="15" r="3.5"/>
</svg>`

const actionIcon = (paths: string) => `<svg viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false">${paths}</svg>`

const shareIcon = actionIcon('<path d="M12 15V3m-4 4 4-4 4 4M6 10H4v11h16V10h-2"/>')

const isMobileDevice = () => {
  const userAgentData = navigator as Navigator & {
    userAgentData?: { mobile?: boolean }
  }
  return (
    userAgentData.userAgentData?.mobile ??
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  )
}

const canShareImageFile = (image: Blob) => {
  if (!('share' in navigator) || !('canShare' in navigator)) return false
  try {
    const file = new File([image], 'romantic-atlas-map.png', { type: 'image/png' })
    return navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}
const retakeIcon = actionIcon(
  '<path d="M5 8h3l2-3h5l2 3h4v11h-6"/><circle cx="13" cy="12" r="3"/><path d="M2 16a5 5 0 1 1 1 5m-1-9v4h4"/>',
)

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

const wrapTitle = (
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) => {
  const lines: string[] = []
  let line = ''

  for (const word of text.trim().split(/\s+/)) {
    const nextLine = line ? `${line} ${word}` : word
    if (line && context.measureText(nextLine).width > maxWidth) {
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
  const scale = Number.parseFloat(getComputedStyle(card).scale) || 1
  context.scale(scale, scale)
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
    context.letterSpacing = titleStyle?.letterSpacing || '0px'
    const lines = wrapTitle(context, title.textContent || '', title.clientWidth)
    const lineHeight = Number.parseFloat(titleStyle?.lineHeight || '') || 16
    const titleCenter = title.offsetTop + title.offsetHeight / 2
    const firstLineCenter = titleCenter - ((lines.length - 1) * lineHeight) / 2
    lines.forEach((line, index) => {
      context.fillText(
        line,
        title.offsetLeft + title.clientWidth / 2,
        firstLineCenter + index * lineHeight,
      )
    })
  }
  context.restore()
}

const captureMap = async (map: MapLibreMap, frame: HTMLImageElement) => {
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
    // Rail centerlines in the 864 × 1080 artwork. Leave the outer filigree on transparent pixels.
    context.save()
    context.beginPath()
    context.rect(
      (frameBounds.width * 55) / 864,
      (frameBounds.height * 57) / 1080,
      (frameBounds.width * 750) / 864,
      (frameBounds.height * 952) / 1080,
    )
    context.clip()
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

    context.restore()
    const printFrame = new Image()
    printFrame.src = shareFrameUrl
    await printFrame.decode()
    context.drawImage(printFrame, 0, 0, frameBounds.width, frameBounds.height)
    const image = await canvasToPng(exportCanvas)
    if (image.size <= maximumShareImageBytes) return image

    // A detailed 2x capture can exceed the sharing endpoint's PNG limit.
    // At 1080 × 1350 even uncompressed RGBA pixels occupy less than 6 MB.
    const resized = document.createElement('canvas')
    resized.width = 1080
    resized.height = 1350
    const resizedContext = resized.getContext('2d')
    if (!resizedContext) throw new Error('Could not prepare the map image.')
    resizedContext.imageSmoothingQuality = 'high'
    resizedContext.drawImage(exportCanvas, 0, 0, resized.width, resized.height)
    return await canvasToPng(resized)
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
  shareButton.innerHTML = shareIcon
  shareButton.title = 'Share your map'
  shareButton.setAttribute('aria-label', 'Share your map')
  shareButton.hidden = true

  const frameMount = document.createElement('div')
  frameMount.className = 'atlas-share-frame'
  const frame = document.createElement('img')
  frame.src = cameraFrameUrl
  frame.alt = ''
  frameMount.append(frame)
  frameMount.hidden = true
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
  snapButton.innerHTML = cameraIcon
  const composeError = document.createElement('p')
  composeError.className = 'atlas-share-error'
  composeError.hidden = true
  const composeCloseButton = document.createElement('button')
  composeCloseButton.className = 'atlas-share-compose-close'
  composeCloseButton.type = 'button'
  composeCloseButton.setAttribute('aria-label', 'Exit map capture mode')
  composeCloseButton.title = 'Exit map capture mode'
  composeCloseButton.innerHTML = '<span aria-hidden="true">×</span>'
  frameMount.append(snapButton)
  composePanel.append(composeHint, composeError, composeCloseButton)

  const result = document.createElement('dialog')
  result.className = 'atlas-share-result'
  result.setAttribute('aria-label', 'Your map image is ready')
  const resultTitle = document.createElement('h2')
  resultTitle.textContent = 'Your map is ready'
  const resultCopy = document.createElement('p')
  resultCopy.innerHTML =
    'Scan to get the image on your phone,<br>then share it anywhere.'
  const qrImage = document.createElement('img')
  qrImage.className = 'atlas-share-qr'
  qrImage.alt = 'QR code for your map image'
  const previewLink = document.createElement('a')
  previewLink.textContent = 'Open image'
  previewLink.target = '_blank'
  previewLink.rel = 'noopener noreferrer'
  const devShareOrigin =
    import.meta.env.DEV && import.meta.env.VITE_ATLAS_DEV_SHARE_ORIGIN
  if (devShareOrigin) {
    resultCopy.textContent =
      'Scan or open the image on a device connected to your tailnet.'
  }
  const retakeButton = document.createElement('button')
  retakeButton.className = 'atlas-share-retake'
  retakeButton.type = 'button'
  retakeButton.title = 'Retake'
  retakeButton.setAttribute('aria-label', 'Retake')
  retakeButton.innerHTML = retakeIcon
  result.append(resultTitle, resultCopy, qrImage)
  if (devShareOrigin) result.append(previewLink)
  result.append(retakeButton)

  const flash = document.createElement('div')
  flash.className = 'atlas-share-flash'
  flash.setAttribute('aria-hidden', 'true')

  ui.append(shareButton, frameMount, composePanel, result, flash)
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
    frameMount.style.width = `${frameWidth}px`
    frameMount.style.height = `${Math.max(0, frameHeight)}px`
    composePanel.style.setProperty('--atlas-share-frame-top', `${frameTop}px`)
    composePanel.style.setProperty('--atlas-share-frame-height', `${frameHeight}px`)
    composePanel.style.setProperty(
      '--atlas-share-frame-right',
      `${(width + frameWidth) / 2}px`,
    )
  }

  const showCompose = () => {
    mode = 'compose'
    result.close()
    frameMount.hidden = false
    composePanel.hidden = false
    hideShareButton()
    composeError.hidden = true
    syncFrameSize()
    snapButton.focus({ preventScroll: true })
  }

  const showMap = () => {
    mode = 'map'
    frameMount.hidden = true
    composePanel.hidden = true
    result.close()
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
      if (isMobileDevice()) {
        mode = 'result'
        frameMount.hidden = true
        composePanel.hidden = true
        const file = new File([image], 'romantic-atlas-map.png', { type: 'image/png' })
        qrImage.hidden = true
        previewLink.hidden = true
        if (canShareImageFile(image)) {
          resultTitle.textContent = 'Your map is ready to share'
          resultCopy.textContent = 'Choose where to share your map image.'
          try {
            await navigator.share({ files: [file], title: 'My Romantic Atlas map' })
            resultCopy.textContent = 'Your map has been shared.'
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              resultCopy.textContent = 'Your map is ready to share whenever you are.'
            } else {
              throw error
            }
          }
          result.showModal()
        } else {
          const downloadUrl = URL.createObjectURL(image)
          const download = document.createElement('a')
          download.href = downloadUrl
          download.download = 'romantic-atlas-map.png'
          download.click()
          window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000)
          resultTitle.textContent = 'Your map was downloaded'
          resultCopy.textContent = 'It’s in your Downloads folder. Share it from there.'
          result.showModal()
        }
        return
      }

      const response = await fetch('/api/share-maps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: await blobToDataUrl(image) }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.url !== 'string') {
        throw new Error(body?.error ?? 'Could not save your map.')
      }
      const imageUrl = devShareOrigin
        ? new URL(new URL(body.url).pathname, devShareOrigin).href
        : body.url
      if (devShareOrigin) previewLink.href = imageUrl
      resultTitle.textContent = 'Your map is ready'
      resultCopy.textContent = devShareOrigin
        ? 'Scan or open the image on a device connected to your tailnet.'
        : 'Scan to get the image on your phone, then share it anywhere.'
      qrImage.hidden = false
      qrImage.src = await QRCode.toDataURL(imageUrl, {
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 720,
        color: { dark: '#173d35', light: '#fffdf4' },
      })
      mode = 'result'
      frameMount.hidden = true
      composePanel.hidden = true
      result.showModal()
    } catch (error) {
      if (mode === 'result') {
        mode = 'compose'
        frameMount.hidden = false
        composePanel.hidden = false
        result.close()
      }
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
  result.addEventListener('click', event => {
    if (event.target !== result) return
    const bounds = result.getBoundingClientRect()
    if (
      event.clientX < bounds.left ||
      event.clientX >= bounds.right ||
      event.clientY < bounds.top ||
      event.clientY >= bounds.bottom
    )
      showMap()
  })
  result.addEventListener('cancel', event => {
    event.preventDefault()
    showMap()
  })
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
