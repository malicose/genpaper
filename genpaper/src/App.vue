<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

interface Layer { w: number[][]; b: number[] }
type Rng = () => number

// --- Settings ---
const activation = ref<'tanh' | 'sin' | 'cos' | 'abs' | 'gaussian' | 'sinc' | 'softplus'>('tanh')
const layerCount = ref(3)
const colorMode = ref<'rgb' | 'bw'>('rgb')

const seedEnabled = ref(false)
const seedValue = ref(42)
const morphingEnabled = ref(false)
const grainEnabled = ref(false)
const grainLevel = ref(0.15)
const aspectRatio = ref<'1:1' | '16:9' | '9:16'>('1:1')

const DISPLAY = { '1:1': [512, 512], '16:9': [512, 288], '9:16': [288, 512] } as const
const EXPORT  = { '1:1': [3840, 3840], '16:9': [3840, 2160], '9:16': [2160, 3840] } as const
const canvasW = computed(() => DISPLAY[aspectRatio.value][0])
const canvasH = computed(() => DISPLAY[aspectRatio.value][1])

// --- Runtime state ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)
const hasGenerated = ref(false)

let gl: WebGL2RenderingContext | null = null
let vs: WebGLShader | null = null
let program: WebGLProgram | null = null
let weightTex: WebGLTexture | null = null
let texSize = 1
let animating = false
let currentZ: number[] = []
let currentWeights: Layer[] = []
let prevWeights: Layer[] = []
let prevZ: number[] = []
const hasPrev = ref(false)

// --- PRNG ---
function mulberry32(s: number): Rng {
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function makeRng(): Rng {
  return seedEnabled.value ? mulberry32(seedValue.value) : Math.random
}
function randn(rng: Rng): number {
  const u = 1 - rng(), v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- Network ---
function makeWeights(rng: Rng): Layer[] {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [11, ...Array(layerCount.value).fill(32), outSize]
  return sizes.slice(1).map((o: number, i: number) => ({
    w: Array.from({ length: o }, () => Array.from({ length: sizes[i] as number }, () => randn(rng))),
    b: Array.from({ length: o }, () => randn(rng)),
  }))
}
function makeZ(rng: Rng): number[] {
  return Array.from({ length: 8 }, () => randn(rng))
}
function lerpZ(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i]! - v) * t)
}
function smoothstep(t: number) { return t * t * (3 - 2 * t) }

// --- Pack weights into a flat Float32Array ---
function packWeights(layers: Layer[]): Float32Array {
  const count = layers.reduce((s, l) => s + l.w.length * l.w[0]!.length + l.b.length, 0)
  const data = new Float32Array(count)
  let i = 0
  for (const { w, b } of layers) {
    for (const row of w) for (const v of row) data[i++] = v
    for (const v of b) data[i++] = v
  }
  return data
}

// --- Dynamic GLSL fragment shader ---
// The shader is generated from the layer architecture so all loop bounds
// are compile-time integer literals — valid in GLSL ES 3.00.
function makeFragSrc(layers: Layer[]): string {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [11, ...layers.map(l => l.b.length)]
  const N = layers.length

  // Weight offsets per layer [w0 ... wN, b0 ... bN] packed contiguously
  const offsets: number[] = [0]
  for (let l = 0; l < N; l++) {
    offsets.push(offsets[l]! + sizes[l]! * sizes[l + 1]! + sizes[l + 1]!)
  }

  const actCode = {
    tanh:     'return tanh(x);',
    sin:      'return sin(x);',
    cos:      'return cos(x);',
    abs:      'return abs(x);',
    gaussian: 'return exp(-x*x);',
    sinc:     'return x==0.?1.:sin(x)/x;',
    softplus: 'return x>20.?x:log(1.+exp(x));',
  }[activation.value]

  let fwd = `float inp[${sizes[0]}];
  inp[0]=x;inp[1]=y;inp[2]=r;
  for(int i=0;i<8;i++)inp[3+i]=u_z[i];
  `
  for (let l = 0; l < N; l++) {
    const inSz  = sizes[l]!
    const outSz = sizes[l + 1]!
    const wOff  = offsets[l]!
    const bOff  = wOff + inSz * outSz
    const prev  = l === 0 ? 'inp' : `h${l - 1}`
    const fn    = l === N - 1 ? 'sig' : 'act'
    fwd += `float h${l}[${outSz}];
  for(int o=0;o<${outSz};o++){
    float s=W(${bOff}+o);
    for(int i=0;i<${inSz};i++)s+=W(${wOff}+o*${inSz}+i)*${prev}[i];
    h${l}[o]=${fn}(s);
  }
  `
  }

  const last = `h${N - 1}`
  const colAssign = outSize === 3
    ? `vec3 col=vec3(${last}[0],${last}[1],${last}[2]);`
    : `vec3 col=vec3(${last}[0]);`

  return `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_w;
uniform int u_ts;
uniform vec2 u_res;
uniform float u_z[8];
uniform float u_grain;
float W(int i){return texelFetch(u_w,ivec2(i%u_ts,i/u_ts),0).r;}
float act(float x){${actCode}}
float sig(float x){return 1./(1.+exp(-x));}
float noise(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 c=gl_FragCoord.xy/u_res;
  float asp=u_res.x/u_res.y;
  float x=(c.x*2.-1.)*asp,y=(1.-c.y)*2.-1.,r=length(vec2(x,y));
  ${fwd}
  ${colAssign}
  float g=(noise(gl_FragCoord.xy)-0.5)*u_grain;
  fragColor=vec4(clamp(col+g,0.,1.),1.);
}`
}

// --- WebGL setup ---
function compileShader(type: number, src: string): WebGLShader {
  const s = gl!.createShader(type)!
  gl!.shaderSource(s, src)
  gl!.compileShader(s)
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS))
    throw new Error(gl!.getShaderInfoLog(s) ?? 'shader compile error')
  return s
}

function initGL() {
  const g = canvas.value!.getContext('webgl2')
  if (!g) { alert('WebGL 2 not supported in this browser'); return }
  gl = g
  vs = compileShader(g.VERTEX_SHADER,
    `#version 300 es\nin vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`)
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), g.STATIC_DRAW)
}

function buildProgram(layers: Layer[]) {
  const g = gl!
  if (program) g.deleteProgram(program)
  const fs = compileShader(g.FRAGMENT_SHADER, makeFragSrc(layers))
  program = g.createProgram()!
  g.attachShader(program, vs!)
  g.attachShader(program, fs)
  g.linkProgram(program)
  g.useProgram(program)
  const loc = g.getAttribLocation(program, 'p')
  g.enableVertexAttribArray(loc)
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
}

function uploadWeights(layers: Layer[]) {
  const g = gl!
  const data = packWeights(layers)
  texSize = Math.ceil(Math.sqrt(data.length))
  const padded = new Float32Array(texSize * texSize)
  padded.set(data)
  if (weightTex) g.deleteTexture(weightTex)
  weightTex = g.createTexture()
  g.bindTexture(g.TEXTURE_2D, weightTex)
  g.texImage2D(g.TEXTURE_2D, 0, g.R32F, texSize, texSize, 0, g.RED, g.FLOAT, padded)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
}

function draw(z: number[]) {
  if (!gl || !program) return
  const g = gl, el = canvas.value!
  g.viewport(0, 0, el.width, el.height)
  g.uniform2f(g.getUniformLocation(program, 'u_res'), el.width, el.height)
  g.uniform1i(g.getUniformLocation(program, 'u_ts'), texSize)
  g.uniform1fv(g.getUniformLocation(program, 'u_z'), new Float32Array(z))
  g.uniform1i(g.getUniformLocation(program, 'u_w'), 0)
  g.uniform1f(g.getUniformLocation(program, 'u_grain'), grainEnabled.value ? grainLevel.value : 0.0)
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
}

// --- Generate (static) ---
function generate() {
  stopMorphing()
  morphingEnabled.value = false
  generating.value = true
  setTimeout(() => {
    const rng = makeRng()
    if (currentWeights.length) { prevWeights = currentWeights; prevZ = currentZ; hasPrev.value = true }
    const weights = makeWeights(rng)
    uploadWeights(weights)
    buildProgram(weights)
    currentZ = makeZ(rng)
    currentWeights = weights
    draw(currentZ)
    generating.value = false
    hasGenerated.value = true
  }, 10)
}

// --- Morphing ---
// After setup, each frame only updates the z uniform (8 floats) → runs at 60fps on GPU
function startMorphing() {
  animating = true
  const weights = makeWeights(makeRng())
  uploadWeights(weights)
  buildProgram(weights)
  let zA = makeZ(Math.random), zB = makeZ(Math.random), t = 0
  function step() {
    if (!animating) return
    t += 0.015
    if (t >= 1) { t = 0; zA = zB; zB = makeZ(Math.random) }
    draw(lerpZ(zA, zB, smoothstep(t)))
    requestAnimationFrame(step)
  }
  step()
}

function stopMorphing() { animating = false }

function download() {
  const [w, h] = EXPORT[aspectRatio.value]
  const offscreen = document.createElement('canvas')
  offscreen.width = w; offscreen.height = h
  const g = offscreen.getContext('webgl2', { preserveDrawingBuffer: true })!

  const vsSrc = `#version 300 es\nin vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`
  function comp(type: number, src: string) {
    const s = g.createShader(type)!
    g.shaderSource(s, src); g.compileShader(s); return s
  }
  const prog = g.createProgram()!
  g.attachShader(prog, comp(g.VERTEX_SHADER, vsSrc))
  g.attachShader(prog, comp(g.FRAGMENT_SHADER, makeFragSrc(currentWeights)))
  g.linkProgram(prog); g.useProgram(prog)
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), g.STATIC_DRAW)
  const loc = g.getAttribLocation(prog, 'p')
  g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)

  const data = packWeights(currentWeights)
  const ts = Math.ceil(Math.sqrt(data.length))
  const padded = new Float32Array(ts * ts); padded.set(data)
  const tex = g.createTexture()
  g.bindTexture(g.TEXTURE_2D, tex)
  g.texImage2D(g.TEXTURE_2D, 0, g.R32F, ts, ts, 0, g.RED, g.FLOAT, padded)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)

  g.viewport(0, 0, w, h)
  g.uniform2f(g.getUniformLocation(prog, 'u_res'), w, h)
  g.uniform1i(g.getUniformLocation(prog, 'u_ts'), ts)
  g.uniform1fv(g.getUniformLocation(prog, 'u_z'), new Float32Array(currentZ))
  g.uniform1i(g.getUniformLocation(prog, 'u_w'), 0)
  g.uniform1f(g.getUniformLocation(prog, 'u_grain'), grainEnabled.value ? grainLevel.value : 0.0)
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)

  offscreen.toBlob(blob => {
    const url = URL.createObjectURL(blob!)
    const a = document.createElement('a')
    a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}.png`
    a.click(); URL.revokeObjectURL(url)
  })
}

function restorePrev() {
  if (!hasPrev.value) return
  currentWeights = prevWeights; currentZ = prevZ; hasPrev.value = false
  uploadWeights(currentWeights)
  buildProgram(currentWeights)
  draw(currentZ)
}

watch(morphingEnabled, (on) => (on ? startMorphing() : stopMorphing()))
watch([grainEnabled, grainLevel], () => { if (!animating) draw(currentZ) })
watch(aspectRatio, () => { if (!animating) draw(currentZ) })
onMounted(() => { initGL(); generate() })
onUnmounted(stopMorphing)
</script>

<template>
  <div class="app">
    <canvas ref="canvas" :width="canvasW" :height="canvasH" />

    <div class="controls">
      <label>
        Activation
        <select v-model="activation">
          <option value="tanh">tanh</option>
          <option value="sin">sin</option>
          <option value="cos">cos</option>
          <option value="abs">abs</option>
          <option value="gaussian">gaussian</option>
          <option value="sinc">sinc</option>
          <option value="softplus">softplus</option>
        </select>
      </label>

      <label>
        Layers: {{ layerCount }}
        <input type="range" v-model.number="layerCount" min="1" max="8" />
      </label>

      <label>
        Color
        <select v-model="colorMode">
          <option value="rgb">RGB</option>
          <option value="bw">B&amp;W</option>
        </select>
      </label>

      <label>
        <input type="checkbox" v-model="seedEnabled" />
        Seed
        <input type="number" v-model.number="seedValue" :disabled="!seedEnabled" style="width:64px" />
      </label>

      <label>
        <input type="checkbox" v-model="morphingEnabled" />
        Morph
      </label>

      <label>
        <input type="checkbox" v-model="grainEnabled" />
        Grain
        <input type="range" v-model.number="grainLevel" min="0.02" max="0.5" step="0.01" :disabled="!grainEnabled" />
      </label>

      <label>
        Ratio
        <select v-model="aspectRatio">
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
        </select>
      </label>

      <button @click="restorePrev" :disabled="!hasPrev || morphingEnabled">Back</button>
      <button @click="generate" :disabled="generating || morphingEnabled">
        {{ generating ? 'Generating…' : 'Generate' }}
      </button>
      <button @click="download" :disabled="!hasGenerated">Download</button>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 24px;
}
canvas { border: 1px solid #ccc; }
.controls {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  justify-content: center;
}
label { display: flex; align-items: center; gap: 6px; font-size: 14px; }
select, button, input[type='number'] { padding: 5px 10px; font-size: 14px; cursor: pointer; }
button:disabled { opacity: 0.4; cursor: default; }
</style>
