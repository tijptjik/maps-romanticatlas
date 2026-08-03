import type { AtlasScene } from './atlas-scenes.ts'

type AtlasAudioHooks = {
  playCameraFlash: () => void
  playFogLift: (scene?: AtlasScene) => void
  preloadScene: (scene: AtlasScene) => void
  start: () => void
  stop: () => void
}

const midiToFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

const themeChords = [
  [50, 57, 62, 65], // D minor
  [46, 53, 58, 62], // B-flat major
  [41, 48, 53, 57], // F major
  [48, 55, 60, 64], // C major
]

const themeMelody = [
  [69, -1, 74, 72, 69, -1, 67, -1],
  [65, -1, 69, 72, 74, -1, 72, -1],
  [69, -1, 72, 74, 77, -1, 74, -1],
  [72, -1, 69, 67, 65, -1, 62, -1],
]

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
  let scheduler: number | undefined
  let stopTimer: number | undefined
  let nextStepAt = 0
  let step = 0
  let musicEnabled = false
  let autoStartEnabled = !initiallyMuted
  let noiseBuffer: AudioBuffer | undefined
  let revealChimeIndex = 0
  const sceneAudio = new Map<AtlasScene, AudioBuffer>()
  const sceneAudioRequests = new Map<AtlasScene, Promise<AudioBuffer | undefined>>()

  const control = document.createElement('button')
  control.className = 'atlas-audio-control'
  control.type = 'button'
  control.setAttribute('aria-label', 'Play the atlas theme')
  control.setAttribute('aria-pressed', 'false')
  control.dataset.muted = 'true'
  control.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 10v4h3l4 3V7l-4 3H3Z" />
      <path class="atlas-audio-control__waves" d="M14 9.5a4 4 0 0 1 0 5M16.5 7a7.3 7.3 0 0 1 0 10" />
      <path class="atlas-audio-control__muted" d="m4 4 16 16" />
    </svg>
  `
  mapContainer.append(control)

  const updateControl = () => {
    control.setAttribute(
      'aria-label',
      musicEnabled ? 'Mute the atlas theme' : 'Play the atlas theme',
    )
    control.setAttribute('aria-pressed', `${musicEnabled}`)
    control.dataset.muted = `${!musicEnabled}`
  }

  const setMusicVolume = (volume: number, at: number) => {
    if (!musicGain) return
    musicGain.gain.cancelScheduledValues(at)
    musicGain.gain.setTargetAtTime(volume, at, 0.08)
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

  const schedulePad = (chord: number[], at: number, duration: number) => {
    chord.forEach((midi, index) => {
      scheduleTone(
        midiToFrequency(midi),
        at + index * 0.018,
        duration,
        0.03,
        index % 2 ? 'sine' : 'triangle',
      )
    })
  }

  const scheduleMusicStep = (at: number) => {
    if (!context || !musicGain) return
    const quarterNote = 60 / 72
    const eighthNote = quarterNote / 2
    const stepInLoop = step % 64
    const bar = Math.floor(stepInLoop / 8)
    const beatInBar = stepInLoop % 8
    const chord = themeChords[Math.floor(bar / 2)]

    if (beatInBar === 0) schedulePad(chord, at, quarterNote * 7.7)
    if (beatInBar === 0 || beatInBar === 4) {
      scheduleTone(
        midiToFrequency(chord[0] - 12),
        at,
        quarterNote * 1.7,
        0.07,
        'triangle',
      )
    }
    const melody = themeMelody[bar % themeMelody.length][beatInBar]
    // The lead has priority over the arpeggio: two treble notes landing on
    // the same beat read as a clash rather than as a single clear phrase.
    if (beatInBar % 2 === 0 && melody < 0) {
      const arpeggioNote = chord[(beatInBar / 2) % chord.length]
      scheduleTone(
        midiToFrequency(arpeggioNote + 12),
        at,
        eighthNote * 1.6,
        0.035,
        'sine',
      )
    }

    if (melody >= 0) {
      scheduleTone(midiToFrequency(melody), at, eighthNote * 1.65, 0.08, 'triangle')
    }
    step += 1
  }

  const scheduleAhead = () => {
    if (!context) return
    const horizon = context.currentTime + 0.18
    while (nextStepAt < horizon) {
      scheduleMusicStep(nextStepAt)
      nextStepAt += 60 / 72 / 2
    }
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

  const enable = () => {
    if (stopTimer !== undefined) {
      window.clearTimeout(stopTimer)
      stopTimer = undefined
    }
    if (!ensureContext() || !context) return
    if (scheduler === undefined) {
      nextStepAt = context.currentTime + 0.08
      scheduler = window.setInterval(scheduleAhead, 90)
      scheduleAhead()
    }
    musicEnabled = true
    // Keep the synth audible alongside normal desktop audio. The individual
    // voices remain intentionally soft, so this gain increase does not push
    // the combined sound into clipping.
    setMusicVolume(0.55, context.currentTime)
    updateControl()
  }

  const start = () => {
    // A user gesture must unlock the context even when the URL suppresses the
    // theme, otherwise later reveal effects would remain blocked by autoplay
    // policy.
    if (!ensureContext() || !autoStartEnabled) return
    enable()
  }

  const stop = () => {
    if (!context || !musicGain) return

    musicEnabled = false
    updateControl()
    const at = context.currentTime
    setMusicVolume(0.0001, at)
    if (stopTimer !== undefined) window.clearTimeout(stopTimer)
    stopTimer = window.setTimeout(() => {
      if (scheduler !== undefined) {
        window.clearInterval(scheduler)
        scheduler = undefined
      }
      stopTimer = undefined
    }, 500)
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
    if (!context || !musicEnabled) {
      autoStartEnabled = true
      enable()
      return
    }
    musicEnabled = false
    autoStartEnabled = false
    setMusicVolume(0.0001, context.currentTime)
    updateControl()
  })

  window.addEventListener('pagehide', () => {
    if (scheduler !== undefined) window.clearInterval(scheduler)
    if (stopTimer !== undefined) window.clearTimeout(stopTimer)
    void context?.close()
  })

  return { playCameraFlash, playFogLift, preloadScene, start, stop }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
