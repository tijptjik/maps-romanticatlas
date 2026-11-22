import creditPetalUrl from './assets/tijptjik-petal.webp?url'
import type { PavilionCue } from './pavilion-audio'
import { installPavilionScene } from './pavilion-scene'

const pavilionLights = Array.from({ length: 15 }, (_, index) => {
  const x = 4 + (index * 92) / 14
  const y = 10 + 5 * Math.cos((index * Math.PI) / 7)
  return `<i style="left:${x}%;top:${y}%;animation-delay:-${index * 0.41}s"></i>`
}).join('')

const airPetals = Array.from(
  { length: 6 },
  (_, i) => `<i style="--i:${i};--drift:${i % 2 ? 8 : -5}cqh"></i>`,
).join('')

const orbParticles = Array.from(
  { length: 14 },
  (_, i) =>
    `<i style="--angle:${i * 137.5}deg;--delay:-${i * 0.19}s;--hue:${i * 27}"></i>`,
).join('')

const splashMarkup = `
  <div class="pavilion-room">
    <div class="pavilion-garden" aria-hidden="true">
      <div class="pavilion-sky"><canvas class="pavilion-sky__far"></canvas><canvas></canvas></div>
      <canvas class="pavilion-water"></canvas>
      <span class="pavilion-aerostat pavilion-aerostat--west"><img data-piece="distant-coral" alt="" /><canvas></canvas></span>
      <span class="pavilion-aerostat pavilion-aerostat--east"><img data-piece="distant-jade" alt="" /><canvas></canvas></span>
      <img class="pavilion-plant pavilion-plant--vine" data-piece="bougainvillea" alt="" />
      <img class="pavilion-plant pavilion-plant--raceme" data-piece="wisteria" alt="" />
      <img class="pavilion-plant pavilion-plant--palm" data-piece="palms" alt="" />
      <img class="pavilion-plant pavilion-plant--orchid" data-piece="orchids" alt="" />
      <div class="pavilion-piers"></div>
    </div>
    <div class="pavilion-lamps" aria-hidden="true">${pavilionLights}</div>
    <div class="pavilion-air" aria-hidden="true">${airPetals}</div>
    <div class="pavilion-sun" aria-hidden="true"><i></i><i></i><i></i></div>
    <header class="pavilion-title">
      <p>The Cartographic Pavilion</p>
      <h1>A Romantic’s Atlas<small>of Hong Kong</small></h1>
    </header>
    <button class="pavilion-orrery" type="button" aria-label="Night mode" aria-pressed="false" title="Switch to night">
      <img data-piece="orrery" alt="" />
      <span class="pavilion-sun-glow" aria-hidden="true"></span>
    </button>
    <button class="pavilion-book" type="button" aria-label="Enter the Fog">
      <img class="pavilion-spread" data-piece="clear-harbour-atlas" alt="" width="1500" height="832" />
      <img class="pavilion-page-light" data-piece="clear-harbour-atlas" alt="" aria-hidden="true" />
      <span class="pavilion-page-mist" aria-hidden="true"><canvas></canvas></span>
      <img class="pavilion-reflected-light" data-piece="clear-harbour-atlas" alt="" aria-hidden="true" />
      <span class="pavilion-orb" aria-hidden="true">
        <canvas></canvas>
        <span class="pavilion-sparks">${orbParticles}</span>
      </span>
    </button>
    <button class="pavilion-notes" type="button" aria-controls="artist-statement" aria-expanded="false">
      <span class="pavilion-notes__cover">
        <img data-piece="field-notes" alt="" width="700" height="215" />
        <span>Cartographer’s Note</span>
      </span>
    </button>
    <a class="pavilion-credit" draggable="false" href="https://type.hk/" target="_blank" rel="noopener noreferrer" aria-label="By TIJPTJIK — Type.hk">
      <span class="pavilion-credit__petal">
        <span class="pavilion-credit__art"><img src="${creditPetalUrl}" alt="" /></span>
      </span>
    </a>
  </div>
`

async function preparePavilion(pieces: NodeListOf<HTMLImageElement>) {
  const portrait = matchMedia('(max-aspect-ratio: 9/10)')
  let tall: boolean
  do {
    tall = portrait.matches
    const room = tall ? 'glasshouse-portrait' : 'glasshouse'
    const layers = [
      room,
      'whole-cloud-banks',
      'lavender-mist',
      ...['piers', 'water'].map(layer => `${room}-${layer}`),
    ]
    const plates = layers.map(layer => {
      const image = new Image()
      image.src = `/pavilion/${layer}.webp`
      return image
    })
    await Promise.allSettled([
      ...[...pieces, ...plates].map(image => image.decode()),
      document.fonts.ready,
    ])
    // Allow image-load callbacks and the canvas renderers to paint behind the curtain.
    await new Promise<void>(done =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    )
  } while (tall !== portrait.matches)
}

export const createIntroSplash = (
  mapContainer: HTMLElement,
  onEnter: () => void | Promise<void> = () => {},
  initiallyVisible = true,
  onMapVisible = () => {},
  playCue: PavilionCue = () => {},
) => {
  const splash = document.createElement('section')
  splash.className = 'atlas-intro'
  splash.setAttribute('aria-label', 'A Romantic’s Atlas of Hong Kong')
  splash.innerHTML = splashMarkup
  mapContainer.append(splash)
  // Some browsers report a long press as a mouse event, and the opening curtain makes the pavilion inert.
  document.addEventListener(
    'contextmenu',
    event => {
      if (splash.classList.contains('is-visible')) event.preventDefault()
    },
    { capture: true },
  )
  // Native image and link previews can start before the browser emits contextmenu.
  // Handle a single tap on an illustrated control, leaving a hold unassigned.
  let tap: { control: HTMLElement; x: number; y: number; started: number } | undefined
  splash.addEventListener(
    'touchstart',
    event => {
      tap = undefined
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('button, a[href]')
          : null
      if (!control || event.touches.length !== 1 || !event.cancelable) return
      event.preventDefault()
      const touch = event.touches[0]
      tap = { control, x: touch.clientX, y: touch.clientY, started: event.timeStamp }
    },
    { passive: false },
  )
  splash.addEventListener('touchmove', event => {
    const touch = event.touches[0]
    if (tap && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10)
      tap = undefined
  })
  splash.addEventListener('touchcancel', () => {
    tap = undefined
  })
  splash.addEventListener('touchend', event => {
    const released = tap
    tap = undefined
    if (released && event.timeStamp - released.started < 500) released.control.click()
  })
  const pieces = splash.querySelectorAll<HTMLImageElement>('img')
  const book = splash.querySelector<HTMLButtonElement>('.pavilion-book')!
  book
    .querySelector('img')
    ?.addEventListener('error', () => splash.classList.add('without-illustrations'))
  splash.tabIndex = -1
  let setSceneVisible: ReturnType<typeof installPavilionScene> | undefined
  let transitionTimer: number | undefined
  let lightTimer: number | undefined
  const transitionDuration = () =>
    matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1550
  const aimAtBook = () => {
    const bounds = book.getBoundingClientRect()
    const frame = splash.getBoundingClientRect()
    splash.style.transformOrigin = `${bounds.left - frame.left + bounds.width / 2}px ${bounds.top - frame.top + bounds.height * 0.48}px`
  }

  let opening = initiallyVisible
  let preparing = false

  let entering = false
  const show = async () => {
    entering = false
    if (preparing || splash.classList.contains('is-visible')) return
    window.clearTimeout(transitionTimer)
    for (const piece of pieces) {
      piece.draggable = false
      if (!piece.hasAttribute('src'))
        piece.src = `/pavilion/${piece.dataset.piece}.webp`
    }
    splash.hidden = false
    setSceneVisible ??= installPavilionScene(splash)
    setSceneVisible(true)
    splash.classList.remove('is-exiting')
    splash.classList.add('is-visible')
    splash.scrollTop = 0
    const ready = () => {
      splash.classList.remove('is-returning')
      splash.inert = false
      splash.focus({ preventScroll: true })
      scheduleLightChange()
    }
    if (opening) {
      preparing = true
      mapContainer.inert = true
      await preparePavilion(pieces)
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      const curtain = document.createElement('div')
      curtain.className = 'pavilion-curtain'
      splash.append(curtain)
      document.documentElement.classList.remove('atlas-boot')
      const reveal = curtain.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: reduced ? 0 : 1100,
        easing: 'ease-in-out',
        fill: 'forwards',
      })
      await reveal.finished
      curtain.remove()
      mapContainer.inert = false
      opening = preparing = false
      ready()
    } else {
      aimAtBook()
      splash.inert = true
      splash.classList.add('is-returning')
      transitionTimer = window.setTimeout(ready, transitionDuration())
    }
  }

  const dismiss = async () => {
    if (entering || preparing || !splash.classList.contains('is-visible')) return
    entering = true
    await onEnter()
    if (!entering) return
    entering = false
    window.clearTimeout(lightTimer)
    window.clearTimeout(transitionTimer)
    splash.classList.remove('is-returning')
    aimAtBook()
    splash.classList.replace('is-visible', 'is-exiting')
    splash.inert = true
    mapContainer
      .querySelector<HTMLElement>('.maplibregl-canvas')
      ?.focus({ preventScroll: true })
    transitionTimer = window.setTimeout(() => {
      setSceneVisible?.(false)
      splash.hidden = true
      onMapVisible()
      splash.classList.remove('is-exiting')
    }, transitionDuration())
  }

  const orrery = splash.querySelector<HTMLButtonElement>('.pavilion-orrery')!
  const notes = splash.querySelector<HTMLButtonElement>('.pavilion-notes')!
  const leaf = splash.querySelector<HTMLAnchorElement>('.pavilion-credit')!
  for (const [button, item] of [
    [book, 'orb'],
    [notes, 'book'],
    [leaf, 'leaf'],
  ] as const) {
    button.addEventListener('click', () => {
      if (button.matches('button, a[href]')) playCue(item, 'activate')
    })
    if (item !== 'orb') continue
    let hovered = false
    let selected = false
    const update = () => {
      const next = hovered || button.matches(':focus-visible')
      if (next === selected) return
      selected = next
      if (
        splash.matches('.is-visible') &&
        !mapContainer.inert &&
        button.getAttribute('aria-expanded') !== 'true'
      ) {
        playCue(item, next ? 'rise' : 'fall')
      }
    }
    button.addEventListener('pointerenter', event => {
      hovered = event.pointerType !== 'touch'
      update()
    })
    button.addEventListener('pointerleave', () => {
      hovered = false
      update()
    })
    button.addEventListener('focus', update)
    button.addEventListener('blur', update)
  }
  const toggleLight = (manual: boolean) => {
    const night = splash.classList.toggle('is-night')
    if (manual) playCue('sun', night ? 'rise' : 'fall')
    setSceneVisible?.(true)
    orrery.setAttribute('aria-pressed', String(night))
    orrery.title = night ? 'Switch to day' : 'Switch to night'
    scheduleLightChange()
  }
  const scheduleLightChange = () => {
    window.clearTimeout(lightTimer)
    lightTimer = window.setTimeout(() => toggleLight(false), 5 * 60_000)
  }
  orrery.addEventListener('click', () => toggleLight(true))
  book.addEventListener('click', dismiss)
  splash.hidden = !initiallyVisible
  const ready = initiallyVisible ? show() : Promise.resolve()

  return { element: splash, dismiss, show, ready }
}
