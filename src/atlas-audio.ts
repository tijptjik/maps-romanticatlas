type AtlasAudioHooks = {
  playFogLift: () => void
  start: () => void
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

export const installAtlasAudio = (mapContainer: HTMLElement): AtlasAudioHooks => {
  let context: AudioContext | undefined
  let masterGain: GainNode | undefined
  let scheduler: number | undefined
  let nextStepAt = 0
  let step = 0
  let enabled = false
  let noiseBuffer: AudioBuffer | undefined

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
      enabled ? 'Mute the atlas theme' : 'Play the atlas theme',
    )
    control.setAttribute('aria-pressed', `${enabled}`)
    control.dataset.muted = `${!enabled}`
  }

  const setMasterVolume = (volume: number, at: number) => {
    if (!masterGain) return
    masterGain.gain.cancelScheduledValues(at)
    masterGain.gain.setTargetAtTime(volume, at, 0.08)
  }

  const scheduleTone = (
    frequency: number,
    at: number,
    duration: number,
    volume: number,
    type: OscillatorType = 'sine',
    destination = masterGain,
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
    if (!context || !masterGain) return
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
    if (beatInBar % 2 === 0) {
      const arpeggioNote = chord[(beatInBar / 2) % chord.length]
      scheduleTone(
        midiToFrequency(arpeggioNote + 12),
        at,
        eighthNote * 1.6,
        0.035,
        'sine',
      )
    }

    const melody = themeMelody[bar % themeMelody.length][beatInBar]
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

  const start = () => {
    if (!context) {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
      if (!AudioContextConstructor) return
      context = new AudioContextConstructor()
      masterGain = context.createGain()
      masterGain.gain.value = 0.0001
      masterGain.connect(context.destination)
      noiseBuffer = createNoiseBuffer(context, 2.2)
      nextStepAt = context.currentTime + 0.08
      scheduler = window.setInterval(scheduleAhead, 90)
      scheduleAhead()
    }
    if (context.state === 'suspended') void context.resume()
    enabled = true
    setMasterVolume(0.22, context.currentTime)
    updateControl()
  }

  const playFogLift = () => {
    start()
    if (!context || !masterGain || !enabled || !noiseBuffer) return
    const at = context.currentTime + 0.02

    const wind = context.createBufferSource()
    const windFilter = context.createBiquadFilter()
    const windGain = context.createGain()
    wind.buffer = noiseBuffer
    windFilter.type = 'lowpass'
    windFilter.frequency.setValueAtTime(420, at)
    windFilter.frequency.exponentialRampToValueAtTime(2200, at + 0.9)
    windFilter.frequency.exponentialRampToValueAtTime(700, at + 2.05)
    windGain.gain.setValueAtTime(0.0001, at)
    windGain.gain.linearRampToValueAtTime(0.075, at + 0.55)
    windGain.gain.exponentialRampToValueAtTime(0.0001, at + 2.1)
    wind.connect(windFilter).connect(windGain).connect(masterGain)
    wind.start(at)
    wind.stop(at + 2.15)

    ;[74, 81, 86, 89].forEach((midi, index) => {
      scheduleTone(midiToFrequency(midi), at + index * 0.13, 2.1, 0.1, 'sine')
    })
  }

  control.addEventListener('click', event => {
    event.stopPropagation()
    if (!context || !enabled) {
      start()
      return
    }
    enabled = false
    setMasterVolume(0.0001, context.currentTime)
    updateControl()
  })

  window.addEventListener('pagehide', () => {
    if (scheduler) window.clearInterval(scheduler)
    void context?.close()
  })

  return { playFogLift, start }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
