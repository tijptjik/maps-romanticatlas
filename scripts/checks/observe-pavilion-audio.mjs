// Install before navigation so each real playback can be matched to its decoded file.
export function observePavilionAudio() {
  const names = new WeakMap()
  const state = { decoded: [], started: [], ended: [], firstClick: [] }
  window.pavilionPlayback = state
  let firstClick
  document.addEventListener(
    'click',
    event => {
      firstClick = event
    },
    { capture: true, once: true },
  )
  const read = Response.prototype.arrayBuffer
  Response.prototype.arrayBuffer = async function () {
    const data = await read.call(this)
    const file = this.url.split('?')[0].split('/').pop()
    if (/^petal-whoosh(?:-[\w-]+)?\.ogg$/.test(file))
      names.set(data, 'petal-whoosh.ogg')
    else if (this.url.includes('/pavilion/')) names.set(data, file)
    return data
  }
  const decode = BaseAudioContext.prototype.decodeAudioData
  BaseAudioContext.prototype.decodeAudioData = async function (data, ...args) {
    const buffer = await decode.call(this, data, ...args)
    if (names.has(data)) {
      const name = names.get(data)
      names.set(buffer, name)
      state.decoded.push(name)
    }
    return buffer
  }
  const start = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...args) {
    const name = names.get(this.buffer)
    if (name) {
      state.started.push(name)
      if (firstClick?.eventPhase) state.firstClick.push(name)
      this.addEventListener('ended', () => state.ended.push(name), { once: true })
    }
    return start.apply(this, args)
  }
}
