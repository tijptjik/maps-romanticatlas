// Advect the painted wisps through two moving velocity fields. The far layer
// travels more slowly and evaporates as it mixes with the near layer.
const vertex = `
  attribute vec2 position;
  varying vec2 uv;
  void main() {
    uv = position * vec2(.5,-.5) + .5;
    gl_Position = vec4(position,0.,1.);
  }
`
const fragment = `
  precision highp float;
  varying vec2 uv;
  uniform sampler2D pigment;
  uniform float seconds;
  vec2 flow(vec2 p, float t) {
    return vec2(sin(5.4*p.y + 2.8*p.x + .22*t + .85*sin(12.*p.y-.15*t)),
                cos(8.*p.x - 3.*p.y - .18*t + 1.1*sin(4.2*p.x+.11*t)));
  }
  vec4 mist(vec2 p) {
    return texture2D(pigment,vec2(fract(p.x),clamp(p.y,0.,1.)));
  }
  void main() {
    vec2 p = vec2(uv.x/3., uv.y);
    vec2 current = flow(uv,seconds);
    vec2 eddy = flow(uv + .15*current,seconds*.73 + 7.);
    vec4 near = mist(p + vec2(-seconds/130.,0.) + current*vec2(.018,.056)
                     + eddy*vec2(.011,.032));
    vec4 far = mist(p*vec2(.89,.94) + vec2(.41-seconds/185.,.06)
                    + eddy*vec2(.025,.075));
    float a = near.a * (.60 + .18*eddy.x);
    float b = far.a * (.24 - .09*current.y) * (1.-a);
    gl_FragColor = vec4((near.rgb*a + far.rgb*b)/max(a+b,.001), a+b);
  }
`

export function createPageMist(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
  })
  if (!gl) return () => {}
  let uniforms: { seconds: WebGLUniformLocation | null } | undefined
  const plate = new Image()
  function initialize() {
    if (!plate.naturalWidth || gl.isContextLost()) return
    const program = gl.createProgram()!
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
      gl.deleteShader(shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('Page mist shader:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return
    }
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plate)
    for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, param, gl.LINEAR)
    for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE)
    uniforms = { seconds: gl.getUniformLocation(program, 'seconds') }
    canvas.dispatchEvent(new Event('mist-ready'))
  }
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    uniforms = undefined
    canvas.parentElement?.classList.remove('has-flow')
  })
  canvas.addEventListener('webglcontextrestored', initialize)
  plate.onload = initialize
  plate.src = '/pavilion/lavender-mist.webp'
  return (seconds: number) => {
    if (!uniforms) return
    const width = Math.max(1, canvas.clientWidth),
      height = Math.max(1, canvas.clientHeight)
    if (width !== canvas.width || height !== canvas.height) {
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    gl.uniform1f(uniforms.seconds, seconds)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    canvas.parentElement?.classList.add('has-flow')
  }
}
