import { createIntroSplash } from './intro-splash'
import { installArtistStatement } from './artist-statement'
import { installAtlasAudio } from './atlas-audio'
import { revealedModeEnabled, reviewModeEnabled, adminModeEnabled, kioskModeEnabled, noMusicEnabled, noSplashEnabled } from './runtime-modes'
import './style.css'

export interface Pavilion {
  audio: ReturnType<typeof installAtlasAudio>
  intro: ReturnType<typeof createIntroSplash>
  directEntry: boolean
  returnToPavilion: () => void
  onMapVisible?: () => void
  onReturn?: () => void
}

const reviewMode = reviewModeEnabled()
const kioskMode = kioskModeEnabled()
const restoringMap = history.state?.atlasView === 'map' ||
  (!history.state?.atlasView && Boolean(history.state?.atlasModeCamera))
const directEntry = revealedModeEnabled() || reviewMode || kioskMode || noSplashEnabled() || restoringMap

if (directEntry) document.documentElement.classList.remove('atlas-boot')
if (reviewMode) {
  await import('./main')
} else {
  const container = document.getElementById('map')!
  const audio = installAtlasAudio(container, {
    initiallyMuted: noMusicEnabled() || kioskMode,
  })
  let mapReady: Promise<void>
  const enterMap = () => {
    if (history.state?.atlasView !== 'map') {
      history.replaceState({ ...history.state, atlasView: 'pavilion' }, '')
      history.pushState({ ...history.state, atlasView: 'map' }, '')
    }
    audio.unlock()
    return mapReady
  }
  const intro = createIntroSplash(container, enterMap, !directEntry, () => {
    audio.start()
    pavilion.onMapVisible?.()
  }, audio.playPavilionCue)
  const statement = installArtistStatement(container, {
    showMapTrigger: !adminModeEnabled(),
    onBookmarkPull: () => audio.playPavilionCue('book', 'pull'),
    onPavilionClose: () => audio.playPavilionCue('book', 'fall'),
  })
  const showPavilion = () => {
    void statement.close()
    void intro.show()
    audio.stop()
    pavilion.onReturn?.()
  }
  const returnToPavilion = () => {
    if (history.state?.atlasView === 'map') history.back()
    else showPavilion()
  }
  window.addEventListener('popstate', event => {
    if (event.state?.atlasView === 'pavilion') {
      showPavilion()
    } else if (event.state?.atlasView === 'map') {
      void statement.close()
      intro.dismiss()
    }
  })
  const pavilion: Pavilion = { audio, intro, directEntry, returnToPavilion }
  mapReady = intro.ready.then(async () => {
    const { startAtlas } = await import('./main')
    startAtlas(pavilion)
  })
}
