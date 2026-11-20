const artistStatementMarkup = `
  <button class="artist-statement__map-trigger" type="button" aria-label="Cartographer's Note" aria-controls="artist-statement" aria-expanded="false">
    <span class="artist-statement__map-trigger-compass" aria-hidden="true"></span>
    <span class="artist-statement__map-trigger-label">Cartographer's Note</span>
  </button>
  <section class="artist-statement" id="artist-statement" hidden>
    <div class="artist-statement__dialog" role="dialog" aria-modal="true" aria-labelledby="artist-statement-title">
      <div class="note-pages">
        <div class="note-page-controls">
          <button class="artist-statement__close" type="button" aria-label="Close the artist statement">×</button>
        </div>
      <div class="note-spread">
        <article class="note-leaf">
          <p class="artist-statement__kicker">The cartographers' note</p>
      <h2 id="artist-statement-title">A Romantic’s<br /><span><em>Atlas</em> of Hong Kong</span></h2>
      <div class="artist-statement__rule" aria-hidden="true">✦</div>
          <div class="artist-statement__copy">
            <p>Our <em>Romantic’s Atlas</em> interrogates what becomes of wonder when no territory remains undiscovered.</p>
            <p>For centuries, maps held blank spaces: <em>terra incognita</em>. Lands unknown where imagination could move ahead of measurement. Their lack of definition invited both seafaring and inward exploration; they were spaces for myth-making and speculation. Today, satellite imagery, LiDAR, and computational mapping offer the inverse condition: a world rendered in inescapable detail.</p>
            <p>Our work reintroduces uncertainty into this mapped reality. Using the cartographic commons and frontier generative AI, we construct impossible sites within familiar Hong Kong settings: a circus draws a crowd in the dense fabric of Mong Kok; a balloon festival rises where usually towers stand; and fantasy inhabits the visual language of infrastructure, routes and parcels. Deliberately subtle, the intervention leans into the map’s contoured authority while gently unsettling its claim to be the final word on what the city is or can be.</p>
          </div>
        </article>
        <article class="note-leaf">
          <div class="artist-statement__copy">
            <p>These quiet acts of imaginative repurposing shape our response to technological progress. For some, its march is all boots and no fanfare. We take a generative approach to this advance, producing perspectives and critiques from the very playbook that risks rendering lived experience into precarity. Under the banners of safety and efficiency, even joy can become a resource to be economised from our environment.</p>
            <p>Planning and mapping tools organise the physical world through boundaries and permissible uses; AI tools increasingly shape civic and mental worlds through attention, discourse, and social relations. In both realms, leviathan machines sustained by towering abstractions and compute produce a world that appears fatalistic, exhausted, and foreclosed. Yet imagination retains an unfair advantage: fuelled by dreams, desires, and aspirations for a better world, it remains an infinitely renewable resource available to all.</p>
            <p>By allowing the improbable to surface within the measured city, <em>A Romantic’s Atlas</em> proposes that even the most precisely specified realm remains open to surprise, possibility, and imagination.</p>
          </div>
          <p class="artist-statement__signature">— TIJPTJIK</p>
        </article>
      </div>
      </div>
      <div class="note-board" aria-hidden="true"></div>
    </div>
  </section>
`

// Place the bookmark on the same moving plane as the painted cover, with its
// cord entering the book beside the spine. Its dimensions start in map pixels.
function tieBookmark(button: HTMLButtonElement, board: HTMLElement, scale: number) {
  const plane = document.createElement('div')
  plane.className = 'note-bookmark-plane'
  plane.inert = true
  const knot = document.createElement('div')
  knot.className = 'note-bookmark-knot'
  knot.style.transform = `scale(${1 / scale})`
  const cord = document.createElement('div')
  cord.className = 'note-bookmark-cord'
  const tag = button.cloneNode(true) as HTMLButtonElement
  tag.removeAttribute('aria-controls')
  tag.removeAttribute('aria-expanded')
  tag.tabIndex = -1
  knot.append(cord, tag)
  plane.append(knot)
  board.append(plane)
  return { plane, cord, tag }
}

const coverTurnStart = 0.08
const closeRecordingImpactMs = 135

export const installArtistStatement = (container: HTMLElement, { showMapTrigger = true, onPavilionClose = () => {}, onBookmarkPull = () => {} } = {}) => {
  const wrapper = document.createElement('div')
  wrapper.className = 'artist-statement-ui'
  wrapper.innerHTML = artistStatementMarkup
  if (!showMapTrigger) wrapper.querySelector('.artist-statement__map-trigger')?.remove()
  container.append(wrapper)

  const trigger = container.querySelector<HTMLButtonElement>('.pavilion-notes')
  const mapTrigger = wrapper.querySelector<HTMLButtonElement>('.artist-statement__map-trigger')
  const triggers = [trigger, mapTrigger].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
  )
  const statement = wrapper.querySelector<HTMLElement>('.artist-statement')
  const dialog = wrapper.querySelector<HTMLElement>('.artist-statement__dialog')
  const closeButton = wrapper.querySelector<HTMLButtonElement>('.artist-statement__close')
  const board = wrapper.querySelector<HTMLElement>('.note-board')!
  const pages = wrapper.querySelector<HTMLElement>('.note-pages')!
  const cover = trigger?.querySelector<HTMLElement>('.pavilion-notes__cover')
  let bookmark: ReturnType<typeof tieBookmark> | undefined
  let paperFaces: HTMLElement[] = []
  let movement: Animation[] = []
  let coverTurn: Animation | undefined
  let closing = false
  let previouslyFocused: HTMLElement | null = null

  wrapper.addEventListener('pointerdown', event => event.stopPropagation())

  const close = async () => {
    if (!statement || statement.hidden || closing) return
    closing = true
    const fromPavilion = statement.classList.contains('from-pavilion')
    if (movement.length) pages.scrollTop = 0
    if (movement.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const animation of movement) animation.reverse()
      let cueFrame = 0
      let played = false
      if (fromPavilion && coverTurn) {
        const turn = coverTurn
        const { duration } = turn.effect!.getComputedTiming()
        // In reverse the cover meets the pages at the first hinge keyframe.
        const contact = Number(duration) * coverTurnStart
        const followCover = () => {
          if (Number(turn.currentTime) <= contact + closeRecordingImpactMs) {
            onPavilionClose()
            played = true
          } else {
            cueFrame = requestAnimationFrame(followCover)
          }
        }
        followCover()
      }
      await Promise.allSettled(movement.map(animation => animation.finished))
      cancelAnimationFrame(cueFrame)
      if (fromPavilion && !played) onPavilionClose()
    } else if (fromPavilion) {
      onPavilionClose()
    }
    for (const animation of movement) animation.cancel()
    movement = []
    coverTurn = undefined
    bookmark?.plane.remove()
    bookmark = undefined
    paperFaces.forEach(face => face.remove())
    paperFaces = []
    if (cover && trigger && board.contains(cover)) trigger.append(cover)
    statement.hidden = true
    triggers.forEach(button => button.setAttribute('aria-expanded', 'false'))
    previouslyFocused?.focus({ preventScroll: true })
    closing = false
  }

  const open = (source?: HTMLElement) => {
    if (!statement || !statement.hidden || !dialog) return
    previouslyFocused = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    statement.classList.toggle('from-pavilion', source === trigger)
    statement.classList.toggle('is-night', source === trigger && !!trigger?.closest('.atlas-intro.is-night'))
    const fromMap = !!mapTrigger && source === mapTrigger
    if (fromMap) onBookmarkPull()
    const tab = fromMap ? mapTrigger.getBoundingClientRect() : undefined
    let desk = cover?.getBoundingClientRect()
    if (tab && cover) {
      const image = cover.querySelector('img')!
      if (!image.hasAttribute('src')) image.src = `/pavilion/${image.dataset.piece}.webp`
      const width = Math.min(320, Math.max(180, tab.width * 1.32))
      const height = width * Number(image.getAttribute('height')) / Number(image.getAttribute('width'))
      desk = new DOMRect(tab.right - width * .05, tab.top + tab.height / 2 - height * .8, width, height)
    }
    statement.hidden = false
    pages.scrollTop = 0
    triggers.forEach(button => button.setAttribute('aria-expanded', 'true'))
    if ((fromMap || source === trigger) && cover && desk && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const page = dialog.getBoundingClientRect()
      // The painted spine is centred at row 172 of the 215px desk image.
      // Its transparent bottom margin must sit outside the paper hinge.
      const spineRow = 172 / 215
      const angle = fromMap || !trigger ? 0 : parseFloat(getComputedStyle(trigger).rotate) || 0
      // Measure the flat cover, then rotate its hinge around the cover centre.
      const coverWidth = angle ? cover.offsetWidth : desk.width
      const coverHeight = angle ? cover.offsetHeight : desk.height
      const hingeOffset = coverHeight * (spineRow - .5)
      const radians = angle * Math.PI / 180
      const scale = coverWidth / page.height
      const dx = desk.left + desk.width / 2 - hingeOffset * Math.sin(radians) - (page.left + page.width / 2)
      const dy = desk.top + desk.height / 2 + hingeOffset * Math.cos(radians) - (page.top + page.height / 2)
      const boardWidth = coverHeight / scale
      board.style.width = `${boardWidth}px`
      board.style.setProperty('--spine-inset', `${boardWidth * (1 - spineRow)}px`)
      board.append(cover)

      // Each moving face owns its paper and three outer edges. The shared
      // scrollable spread takes over once both faces have landed.
      const spread = pages.querySelector<HTMLElement>('.note-spread')!
      const singleColumn = getComputedStyle(spread).display === 'block'
      paperFaces = ['left', 'right'].map((side, index) => {
        const face = document.createElement('div')
        face.className = `note-face note-face--${side}`
        face.inert = true
        face.setAttribute('aria-hidden', 'true')
        const print = (singleColumn ? spread : spread.children[index]).cloneNode(true) as HTMLElement
        print.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
        face.append(print)
        if (index === 1 && closeButton) face.append(closeButton.cloneNode(true))
        dialog.append(face)
        return face
      })
      const [leftFace, rightFace] = paperFaces

      const tug = fromMap ? 420 : 0
      const duration = tug + 1500
      const timing: KeyframeAnimationOptions = { duration: 1500, delay: tug, fill: 'both' }
      const edge = .54
      const land = .98
      const lifted = `translate(${dx}px,${dy}px) rotate(${angle - 90}deg) scale(${scale})`
      const start = fromMap ? `translate(${dx - 50}px,${dy + 4}px) rotate(-90deg) scale(${scale})` : lifted
      coverTurn = board.animate([
        {transform: 'perspective(1800px) rotateY(0deg)', opacity: 1},
        {transform: 'perspective(1800px) rotateY(0deg)', opacity: 1, offset: coverTurnStart, easing: 'ease-in'},
        {transform: 'perspective(1800px) rotateY(-90deg)', opacity: 1, offset: edge, easing: 'steps(1, start)'},
        {transform: 'perspective(1800px) rotateY(-90deg)', opacity: 0},
      ], timing)
      movement = [
        statement.animate([
          {backgroundColor: 'transparent'},
          {backgroundColor: getComputedStyle(statement).backgroundColor},
        ], {duration, easing: 'ease-in-out', fill: 'both'}),
        dialog.animate([
          ...(fromMap ? [{transform: lifted, offset: 0, easing: 'cubic-bezier(.55,.02,.9,.55)'}] : []),
          {transform: start, offset: tug / duration, easing: 'cubic-bezier(.25,.6,.28,1)' },
          {transform: 'translate(0,0) rotate(0deg) scale(1)'},
        ], {duration, fill: 'both'}),
        coverTurn,
        leftFace.animate([
          {transform: 'perspective(1800px) rotateY(90deg)', visibility: 'hidden'},
          {transform: 'perspective(1800px) rotateY(90deg)', visibility: 'visible', offset: edge, easing: 'ease-out'},
          {transform: 'perspective(1800px) rotateY(0deg)', visibility: 'visible', offset: land, easing: 'steps(1, start)'},
          {transform: 'perspective(1800px) rotateY(0deg)', visibility: 'hidden'},
        ], timing),
        rightFace.animate([
          {transform: 'perspective(1800px) rotateY(90deg)', opacity: 0},
          {transform: 'perspective(1800px) rotateY(90deg)', opacity: 1, offset: coverTurnStart, easing: 'ease-out'},
          {transform: 'perspective(1800px) rotateY(0deg)', opacity: 1, offset: land, easing: 'steps(1, start)'},
          {transform: 'none', opacity: 0},
        ], timing),
        pages.animate([
          {opacity: 0},
          {opacity: 0, offset: land, easing: 'steps(1, start)'},
          {opacity: 1},
        ], timing),
      ]
      if (fromMap) {
        bookmark = tieBookmark(mapTrigger, board, scale)
        const pull = {duration, fill: 'both' as const}
        movement.push(
          bookmark.tag.animate([
            {translate: '0', easing: 'ease-out'},
            {translate: '-38px', offset: tug / duration},
            {translate: '-38px'},
          ], pull),
          bookmark.cord.animate([
            {scale: '0 1', easing: 'ease-out'},
            {scale: '1 1', offset: tug / duration},
            {scale: '1 1'},
          ], pull),
          bookmark.plane.animate([
            {opacity: 1}, {opacity: 1, offset: .37}, {opacity: 0, offset: .55}, {opacity: 0},
          ], pull),
        )
      }
    }
    closeButton?.focus({ preventScroll: true })
  }

  triggers.forEach(button => {
    button.addEventListener('pointerdown', event => event.stopPropagation())
    button.addEventListener('click', event => {
      event.stopPropagation()
      open(button)
    })
  })
  closeButton?.addEventListener('click', close)
  statement?.addEventListener('click', event => {
    if (event.target === statement) close()
  })
  statement?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }

    if (event.key !== 'Tab' || !dialog) return
    const focusable = pages.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  return { open, close }
}
