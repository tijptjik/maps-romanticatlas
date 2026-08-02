const splashMarkup = `
  <div class="atlas-intro__curtain" aria-hidden="true"></div>
  <div class="atlas-intro__tent" aria-hidden="true">
    <div class="atlas-intro__tent-roof"></div>
    <div class="atlas-intro__tent-pole atlas-intro__tent-pole--left"></div>
    <div class="atlas-intro__tent-pole atlas-intro__tent-pole--right"></div>
    <div class="atlas-intro__tent-trim"></div>
  </div>
  <div class="atlas-intro__lights" aria-hidden="true">
    <div class="atlas-intro__light-arc atlas-intro__light-arc--one">
      <span></span><span></span><span></span><span></span><span></span>
      <span></span><span></span><span></span><span></span>
    </div>
    <div class="atlas-intro__light-arc atlas-intro__light-arc--two">
      <span></span><span></span><span></span><span></span><span></span>
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <div class="atlas-intro__light-arc atlas-intro__light-arc--three">
      <span></span><span></span><span></span><span></span><span></span>
      <span></span><span></span><span></span><span></span><span></span>
    </div>
  </div>
  <div class="atlas-intro__stage">
    <div class="atlas-intro__board atlas-intro__board--main">
      <span class="atlas-intro__nail atlas-intro__nail--top-left"></span>
      <span class="atlas-intro__nail atlas-intro__nail--top-right"></span>
      <span class="atlas-intro__nail atlas-intro__nail--bottom-left"></span>
      <span class="atlas-intro__nail atlas-intro__nail--bottom-right"></span>
      <p class="atlas-intro__board-kicker">An illustrated expedition</p>
      <h1><span>A Romantic's</span><em>Atlas</em><small>of Hong Kong</small></h1>
    </div>
    <div class="atlas-intro__board atlas-intro__board--sub">
      <span class="atlas-intro__board-star" aria-hidden="true">✦</span>
      <p>VENTURE INTO THE FOG<br />REIMAGINE HONG KONG</p>
      <span class="atlas-intro__board-star" aria-hidden="true">✦</span>
    </div>
    <button class="atlas-intro__enter" type="button">
      Enter the fog <span aria-hidden="true">↗</span>
    </button>
  </div>
  <p class="atlas-intro__credit">
    by TIJPTJIK
  </p>
`

export const createIntroSplash = mapContainer => {
  const splash = document.createElement('section')
  splash.className = 'atlas-intro is-visible is-entering'
  splash.setAttribute('aria-label', "A Romantic's Atlas of Hong Kong")
  splash.innerHTML = splashMarkup
  mapContainer.append(splash)

  const enterButton = splash.querySelector('.atlas-intro__enter')

  const dismiss = () => {
    if (!splash.classList.contains('is-visible')) return
    splash.classList.remove('is-visible', 'is-entering')
    splash.classList.add('is-exiting')
    window.setTimeout(() => {
      splash.classList.remove('is-exiting')
    }, 700)
  }

  const show = () => {
    splash.classList.remove('is-exiting', 'is-visible', 'is-entering')
    // Force a new animation cycle every time the idle reset returns the boards.
    void splash.offsetWidth
    splash.classList.add('is-visible', 'is-entering')
  }

  enterButton?.addEventListener('click', event => {
    event.stopPropagation()
    dismiss()
  })

  splash.addEventListener('click', dismiss)

  return { element: splash, dismiss, show }
}
