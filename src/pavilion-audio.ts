type PavilionItem = 'orb' | 'sun' | 'book' | 'leaf'
type Movement = 'rise' | 'fall' | 'activate' | 'pull'
export type PavilionCue = (item: PavilionItem, movement: Movement) => void

export function createPavilionSounds() {
  const bookClips = {
    rise: 'book-open',
    activate: 'book-open',
    fall: 'book-close',
    pull: 'book-shelf-pull',
  } as const
  const clips = [
    'gear-click',
    'gear-release',
    ...new Set(Object.values(bookClips)),
    'petal-touch',
  ]
  const buffers = new Map<string, AudioBuffer>()
  const playing = new Map<string, AudioBufferSourceNode>()
  const fallback = new Map<string, HTMLAudioElement>()
  const url = (clip: string) => `/pavilion/${clip}.ogg`

  const preload = async (ctx?: AudioContext) => {
    if (!ctx) return
    await Promise.allSettled(
      clips.map(async clip => {
        const response = await fetch(url(clip), { signal: AbortSignal.timeout(4000) })
        if (response.ok)
          buffers.set(clip, await ctx.decodeAudioData(await response.arrayBuffer()))
      }),
    )
  }

  const play = (
    ctx: AudioContext,
    output: AudioNode,
    item: PavilionItem,
    movement: Movement,
  ) => {
    if (item !== 'orb') {
      const clip =
        item === 'book'
          ? bookClips[movement]
          : item === 'leaf'
            ? 'petal-touch'
            : movement === 'fall'
              ? 'gear-release'
              : 'gear-click'
      // Skip the quiet lead-in before the first page rustle.
      const offset = clip === 'book-open' ? 0.065 : 0
      const buffer = buffers.get(clip)
      let media = fallback.get(clip)
      if (buffer) {
        media?.pause()
        playing.get(clip)?.stop()
        const source = ctx.createBufferSource()
        source.buffer = buffer
        const gain = ctx.createGain()
        gain.gain.value = item === 'leaf' ? 1 : 0.7
        source.connect(gain).connect(output)
        playing.set(clip, source)
        source.start(0, offset)
      } else {
        // Direct map entry and failed preloads can reach a cue before it is decoded.
        if (!media) {
          media = new Audio(url(clip))
          const gain = ctx.createGain()
          gain.gain.value = item === 'leaf' ? 1 : 0.7
          ctx.createMediaElementSource(media).connect(gain).connect(output)
          fallback.set(clip, media)
        }
        media.currentTime = offset
        void media.play().catch(() => {})
      }
      return
    }

    const at = ctx.currentTime
    const activating = movement === 'activate'
    const falling = movement === 'fall'
    const duration = activating ? 0.46 : 0.24
    const tone = ctx.createOscillator()
    const gain = ctx.createGain()
    tone.frequency.setValueAtTime(falling ? 392 : 329.63, at)
    tone.frequency.exponentialRampToValueAtTime(
      activating ? 493.88 : falling ? 329.63 : 392,
      at + duration * 0.7,
    )
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(activating ? 0.041 : 0.028, at + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    tone.connect(gain).connect(output)
    tone.start(at)
    tone.stop(at + duration)
  }
  return { play, preload }
}
