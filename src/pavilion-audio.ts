type PavilionItem = 'orb' | 'sun' | 'book' | 'leaf'
type Movement = 'rise' | 'fall' | 'activate' | 'pull'
export type PavilionCue = (item: PavilionItem, movement: Movement) => void

export function createPavilionSounds() {
  const recordings = {
    book: new Audio('/pavilion/book-open.ogg'),
    pull: new Audio('/pavilion/book-shelf-pull.ogg'),
    close: new Audio('/pavilion/book-close.ogg'),
    sun: new Audio('/pavilion/gear-click.ogg'),
    release: new Audio('/pavilion/gear-release.ogg'),
    leaf: new Audio('/pavilion/petal-touch.ogg'),
  }
  const connected = new Set<HTMLAudioElement>()
  return (
    ctx: AudioContext,
    output: AudioNode,
    item: PavilionItem,
    movement: Movement,
  ) => {
    if (item !== 'orb') {
      const bookClips = {
        rise: 'book',
        activate: 'book',
        fall: 'close',
        pull: 'pull',
      } as const
      const clipName =
        item === 'book'
          ? bookClips[movement]
          : item === 'sun' && movement === 'fall'
            ? 'release'
            : item
      const clip = recordings[clipName]
      if (!connected.has(clip)) {
        const source = ctx.createMediaElementSource(clip)
        if (item === 'book' || item === 'sun') {
          const gain = ctx.createGain()
          gain.gain.value = 0.7
          source.connect(gain).connect(output)
        } else {
          source.connect(output)
        }
        connected.add(clip)
      }
      clip.currentTime = 0
      void clip.play().catch(() => {})
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
}
