const artistStatementMarkup = `
  <button class="artist-statement__trigger" type="button" aria-controls="artist-statement" aria-expanded="false">
    Cartographer's Note <span aria-hidden="true">↗</span>
  </button>
  <section class="artist-statement" id="artist-statement" hidden>
    <div class="artist-statement__dialog" role="dialog" aria-modal="true" aria-labelledby="artist-statement-title">
      <button class="artist-statement__close" type="button" aria-label="Close the artist statement">×</button>
      <p class="artist-statement__kicker">The cartographers' note</p>
      <h2 id="artist-statement-title">A Romantic’s<br /><span><em>Atlas</em> of Hong Kong</span></h2>
      <div class="artist-statement__rule" aria-hidden="true">✦</div>
      <div class="artist-statement__copy">
        <p>Our <em>Romantic’s Atlas</em> interrogates what becomes of wonder when no territory remains undiscovered.</p>
        <div class="artist-statement__columns">
          <div class="artist-statement__column">
            <p>For centuries, maps held blank spaces: <em>terra incognita</em>. Lands unknown where imagination could move ahead of measurement. Their lack of definition invited both seafaring and inward exploration; they were spaces for myth-making and speculation. Today, satellite imagery, LiDAR, and computational mapping offer the inverse condition: a world rendered in inescapable detail.</p>
            <p>These quiet acts of imaginative repurposing shape our response to technological progress. For some, its march is all boots and no fanfare. We take a generative approach to this advance, producing perspectives and critiques from the very playbook that risks rendering lived experience into precarity. Under the banners of safety and efficiency, even joy can become a resource to be economised from our environment.</p>
            <p>By allowing the improbable to surface within the measured city, <em>A Romantic’s Atlas</em> proposes that even the most precisely specified realm remains open to surprise, possibility, and imagination.</p>
          </div>
          <div class="artist-statement__column">
            <p>Our work reintroduces uncertainty into this mapped reality. Using the cartographic commons and frontier generative AI, we construct impossible sites within familiar Hong Kong settings: a circus draws a crowd in the dense fabric of Mong Kok; a balloon festival rises where usually towers stand; and fantasy inhabits the visual language of infrastructure, routes and parcels. Deliberately subtle, the intervention leans into the map’s contoured authority while gently unsettling its claim to be the final word on what the city is or can be.</p>
            <p>Planning and mapping tools organise the physical world through boundaries and permissible uses; AI tools increasingly shape civic and mental worlds through attention, discourse, and social relations. In both realms, leviathan machines sustained by towering abstractions and compute produce a world that appears fatalistic, exhausted, and foreclosed. Yet imagination retains an unfair advantage: fuelled by dreams, desires, and aspirations for a better world, it remains an infinitely renewable resource available to all.</p>
          </div>
        </div>
      </div>
      <p class="artist-statement__signature">— TIJPTJIK</p>
    </div>
  </section>
`

export const installArtistStatement = container => {
  const wrapper = document.createElement('div')
  wrapper.className = 'artist-statement-ui'
  wrapper.innerHTML = artistStatementMarkup
  container.append(wrapper)

  const trigger = wrapper.querySelector<HTMLButtonElement>('.artist-statement__trigger')
  const actions = container.querySelector('.atlas-intro__actions') as HTMLElement | null
  const statement = wrapper.querySelector<HTMLElement>('.artist-statement')
  const dialog = wrapper.querySelector<HTMLElement>('.artist-statement__dialog')
  const closeButton = wrapper.querySelector<HTMLButtonElement>('.artist-statement__close')
  let previouslyFocused: HTMLElement | null = null

  wrapper.addEventListener('pointerdown', event => event.stopPropagation())

  const close = () => {
    if (!statement || statement.hidden) return
    statement.hidden = true
    trigger?.setAttribute('aria-expanded', 'false')
    previouslyFocused?.focus()
  }

  const open = () => {
    if (!statement) return
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    statement.hidden = false
    trigger?.setAttribute('aria-expanded', 'true')
    closeButton?.focus()
  }

  if (actions && trigger) actions.prepend(trigger)
  trigger?.addEventListener('pointerdown', event => event.stopPropagation())
  trigger?.addEventListener('click', event => event.stopPropagation())
  trigger?.addEventListener('click', open)
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
    const focusable = dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
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
