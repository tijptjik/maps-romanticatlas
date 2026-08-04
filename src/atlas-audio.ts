import type { AtlasScene } from './atlas-scenes.ts'

type AtlasAudioHooks = {
  playCameraFlash: () => void
  playFogLift: (scene?: AtlasScene) => void
  preloadScene: (scene: AtlasScene) => void
  start: () => void
  stop: () => void
}

type AudioMode = 'all-on' | 'music-off' | 'all-off'

const midiToFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

const revealChimeVariations = [
  {
    // A bright, upward opening.
    notes: [74, 78, 81, 86],
    offsets: [0, 0.18, 0.39, 0.61],
    duration: 0.12,
    volume: 0.12,
    type: 'sine' as OscillatorType,
  },
  {
    // A falling phrase that turns upward at the end.
    notes: [91, 86, 81, 83, 88],
    offsets: [0, 0.16, 0.33, 0.53, 0.7],
    duration: 0.1,
    volume: 0.1,
    type: 'triangle' as OscillatorType,
  },
  {
    // Wider, less regular leaps for a more distant shimmer.
    notes: [76, 88, 79, 91, 84],
    offsets: [0, 0.23, 0.38, 0.65, 0.82],
    duration: 0.14,
    volume: 0.11,
    type: 'sine' as OscillatorType,
  },
]

const createNoiseBuffer = (context: AudioContext, duration: number) => {
  const buffer = context.createBuffer(
    1,
    Math.floor(context.sampleRate * duration),
    context.sampleRate,
  )
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.random() * 2 - 1
  }
  return buffer
}

export const installAtlasAudio = (
  mapContainer: HTMLElement,
  { initiallyMuted = false }: { initiallyMuted?: boolean } = {},
): AtlasAudioHooks => {
  let context: AudioContext | undefined
  let masterGain: GainNode | undefined
  let musicGain: GainNode | undefined
  let stopTimer: number | undefined
  let musicEnabled = false
  let audioMode: AudioMode = initiallyMuted ? 'music-off' : 'all-on'
  let noiseBuffer: AudioBuffer | undefined
  let revealChimeIndex = 0
  let themeAudio: AudioBuffer | undefined
  let themeAudioRequest: Promise<AudioBuffer | undefined> | undefined
  let themeSource: AudioBufferSourceNode | undefined
  const sceneAudio = new Map<AtlasScene, AudioBuffer>()
  const sceneAudioRequests = new Map<AtlasScene, Promise<AudioBuffer | undefined>>()

  const control = document.createElement('button')
  control.className = 'atlas-audio-control'
  control.type = 'button'
  control.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 10v4h3l4 3V7l-4 3H3Z" />
      <path class="atlas-audio-control__waves" d="M14 9.5a4 4 0 0 1 0 5M16.5 7a7.3 7.3 0 0 1 0 10" />
      <path class="atlas-audio-control__muted" d="m4 4 16 16" />
    </svg>
  `
  mapContainer.append(control)

  const updateControl = () => {
    const labels: Record<AudioMode, string> = {
      'all-on': 'All atlas sounds on. Activate to turn off music only.',
      'music-off': 'Atlas music off; sound effects remain on. Activate to turn off all sounds.',
      'all-off': 'All atlas sounds off. Activate to turn on music and sound effects.',
    }
    control.setAttribute('aria-label', labels[audioMode])
    control.setAttribute('aria-pressed', `${audioMode === 'all-on'}`)
    control.dataset.audioMode = audioMode
  }

  const setMusicVolume = (volume: number, at: number) => {
    if (!musicGain) return
    musicGain.gain.cancelScheduledValues(at)
    musicGain.gain.setTargetAtTime(volume, at, 0.08)
  }

  const setEffectsVolume = (volume: number, at: number) => {
    if (!masterGain) return
    masterGain.gain.cancelScheduledValues(at)
    if (volume === 0.0001) {
      masterGain.gain.setValueAtTime(volume, at)
      return
    }
    masterGain.gain.setTargetAtTime(volume, at, 0.08)
  }

  const scheduleTone = (
    frequency: number,
    at: number,
    duration: number,
    volume: number,
    type: OscillatorType = 'sine',
    destination = musicGain,
  ) => {
    if (!context || !destination) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.035)
    gain.gain.setTargetAtTime(0.0001, at + duration * 0.55, duration * 0.2)
    oscillator.connect(gain).connect(destination)
    oscillator.start(at)
    oscillator.stop(at + duration + 0.12)
  }

  const scheduleSceneAudio = (buffer: AudioBuffer, at: number) => {
    if (!context || !masterGain) return
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = buffer
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.04)
    gain.gain.setTargetAtTime(0.0001, at + buffer.duration * 0.72, 0.12)
    source.connect(gain).connect(masterGain)
    source.start(at)
    source.stop(at + buffer.duration + 0.12)
  }

  const loadSceneAudio = (scene: AtlasScene): Promise<AudioBuffer | undefined> => {
    const cached = sceneAudio.get(scene)
    if (cached) return Promise.resolve(cached)
    const existingRequest = sceneAudioRequests.get(scene)
    if (existingRequest) return existingRequest
    if (!context) return Promise.resolve(undefined)

    const decodingContext = context
    const request = fetch(
      new URL(`/atlas-audio/${encodeURIComponent(scene)}.ogg`, window.location.origin),
    )
      .then(async response => {
        if (!response.ok) throw new Error(`Could not load the ${scene} scene cue.`)
        return decodingContext.decodeAudioData(await response.arrayBuffer())
      })
      .then(buffer => {
        sceneAudio.set(scene, buffer)
        return buffer
      })
      .catch(() => {
        // The synthesized chime remains the resilient fallback for a missing
        // or unsupported cue. Do not make an audio fetch failure visible.
        return undefined
      })
      .finally(() => {
        sceneAudioRequests.delete(scene)
      })
    sceneAudioRequests.set(scene, request)
    return request
  }

  const preloadScene = (scene: AtlasScene) => {
    if (!context) return
    void loadSceneAudio(scene)
  }

  const ensureContext = () => {
    if (!context) {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
      if (!AudioContextConstructor) return false
      context = new AudioContextConstructor()
      masterGain = context.createGain()
      musicGain = context.createGain()
      masterGain.gain.value = 0.55
      musicGain.gain.value = 0.0001
      musicGain.connect(masterGain)
      masterGain.connect(context.destination)
      noiseBuffer = createNoiseBuffer(context, 2.2)
    }
    if (context.state === 'suspended') void context.resume()
    return true
  }

  const loadThemeAudio = (): Promise<AudioBuffer | undefined> => {
    if (themeAudio) return Promise.resolve(themeAudio)
    if (themeAudioRequest) return themeAudioRequest
    if (!context) return Promise.resolve(undefined)

    const decodingContext = context
    themeAudioRequest = fetch(new URL('/atlas-audio/awestruck.ogg', window.location.origin))
      .then(async response => {
        if (!response.ok) throw new Error('Could not load the atlas theme.')
        return decodingContext.decodeAudioData(await response.arrayBuffer())
      })
      .then(buffer => {
        themeAudio = buffer
        return buffer
      })
      .catch(() => undefined)
      .finally(() => {
        themeAudioRequest = undefined
      })
    return themeAudioRequest
  }

  const startTheme = async () => {
    if (!context || !musicGain || !musicEnabled || themeSource) return
    const buffer = await loadThemeAudio()
    if (!context || !musicGain || !musicEnabled || themeSource || !buffer) return

    const source = context.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.connect(musicGain)
    source.addEventListener('ended', () => {
      if (themeSource === source) themeSource = undefined
    })
    themeSource = source
    source.start()
    setMusicVolume(0.13, context.currentTime)
  }

  const stopTheme = () => {
    if (!themeSource) return
    themeSource.stop()
    themeSource = undefined
  }

  const enable = () => {
    if (stopTimer !== undefined) {
      window.clearTimeout(stopTimer)
      stopTimer = undefined
    }
    if (!ensureContext() || !context) return
    musicEnabled = true
    // This is deliberately tucked beneath the map's reveal cues: it should
    // feel like atmosphere, not demand the listener's attention.
    if (themeSource) setMusicVolume(0.13, context.currentTime)
    else void startTheme()
  }

  const stop = () => {
    musicEnabled = false
    if (!context || !musicGain) return
    const at = context.currentTime
    setMusicVolume(0.0001, at)
    if (stopTimer !== undefined) window.clearTimeout(stopTimer)
    stopTimer = window.setTimeout(() => {
      stopTheme()
      stopTimer = undefined
    }, 500)
  }

  const syncAudioMode = () => {
    // A user gesture must unlock the context even with music disabled, so
    // reveal effects can play in the music-off state.
    if (!ensureContext() || !context) return

    setEffectsVolume(audioMode === 'all-off' ? 0.0001 : 0.55, context.currentTime)
    if (audioMode === 'all-on') enable()
    else stop()
  }

  const start = () => {
    syncAudioMode()
  }

  const cycleAudioMode = () => {
    audioMode =
      audioMode === 'all-on'
        ? 'music-off'
        : audioMode === 'music-off'
          ? 'all-off'
          : 'all-on'
    updateControl()
    syncAudioMode()
  }

  const scheduleFallbackChime = (at: number) => {
    if (!masterGain) return
    const chime = revealChimeVariations[revealChimeIndex]
    revealChimeIndex = (revealChimeIndex + 1) % revealChimeVariations.length
    chime.notes.forEach((midi, index) => {
      scheduleTone(
        midiToFrequency(midi),
        at + chime.offsets[index],
        chime.duration,
        chime.volume,
        chime.type,
        masterGain,
      )
    })
  }

  const playFogLift = (scene?: AtlasScene) => {
    start()
    if (!ensureContext() || !context || !masterGain || !noiseBuffer) return
    const at = context.currentTime + 0.02

    const wind = context.createBufferSource()
    const windFilter = context.createBiquadFilter()
    const windGain = context.createGain()
    wind.buffer = noiseBuffer
    windFilter.type = 'lowpass'
    windFilter.frequency.setValueAtTime(420, at)
    windFilter.frequency.exponentialRampToValueAtTime(1500, at + 0.9)
    windFilter.frequency.exponentialRampToValueAtTime(700, at + 2.05)
    windGain.gain.setValueAtTime(0.0001, at)
    windGain.gain.linearRampToValueAtTime(0.045, at + 0.55)
    windGain.gain.exponentialRampToValueAtTime(0.0001, at + 2.1)
    wind.connect(windFilter).connect(windGain).connect(masterGain)
    wind.start(at)
    wind.stop(at + 2.15)

    const chimeAt = at + 1.1
    const sceneCue = scene ? sceneAudio.get(scene) : undefined
    if (sceneCue) {
      // The cue belongs to the revealed site; it answers the fog as the tile
      // artwork becomes visible rather than becoming a second background track.
      scheduleSceneAudio(sceneCue, chimeAt)
      return
    }

    if (scene) {
      // Do not replace a valid, still-decoding scene cue with the generic
      // chime. Cache hits commonly reach this point before their preloader
      // finishes. Keep the fog swell going and play the dedicated cue as soon
      // as decoding completes instead.
      void loadSceneAudio(scene).then(cue => {
        if (!context || !masterGain) return
        const cueAt = Math.max(chimeAt, context.currentTime + 0.02)
        if (cue) {
          scheduleSceneAudio(cue, cueAt)
          return
        }
        scheduleFallbackChime(cueAt)
      })
      return
    }

    // Let the clearing swell peak before the generic chime answers it. This
    // is used only when there is no dedicated scene cue to play.
    scheduleFallbackChime(chimeAt)
  }

  const playCameraFlash = () => {
    start()
    if (!ensureContext() || !context || !masterGain || !noiseBuffer) return
    const at = context.currentTime + 0.01

    // A short, warm mechanical click: the noise is the shutter and the
    // pitched tail gives it the small pop of an old flash bulb.
    const shutter = context.createBufferSource()
    const shutterFilter = context.createBiquadFilter()
    const shutterGain = context.createGain()
    shutter.buffer = noiseBuffer
    shutterFilter.type = 'highpass'
    shutterFilter.frequency.setValueAtTime(1400, at)
    shutterGain.gain.setValueAtTime(0.0001, at)
    shutterGain.gain.exponentialRampToValueAtTime(0.11, at + 0.006)
    shutterGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.075)
    shutter.connect(shutterFilter).connect(shutterGain).connect(masterGain)
    shutter.start(at)
    shutter.stop(at + 0.08)

    const bulb = context.createOscillator()
    const bulbGain = context.createGain()
    bulb.type = 'triangle'
    bulb.frequency.setValueAtTime(1040, at)
    bulb.frequency.exponentialRampToValueAtTime(380, at + 0.09)
    bulbGain.gain.setValueAtTime(0.0001, at)
    bulbGain.gain.exponentialRampToValueAtTime(0.045, at + 0.008)
    bulbGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11)
    bulb.connect(bulbGain).connect(masterGain)
    bulb.start(at)
    bulb.stop(at + 0.12)
  }

  control.addEventListener('click', event => {
    event.stopPropagation()
    cycleAudioMode()
  })

  window.addEventListener('pagehide', () => {
    if (stopTimer !== undefined) window.clearTimeout(stopTimer)
    stopTheme()
    void context?.close()
  })

  updateControl()

  return { playCameraFlash, playFogLift, preloadScene, start, stop }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
