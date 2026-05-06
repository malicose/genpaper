<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

interface Layer { w: number[][]; b: number[] }
type Rng = () => number

// --- Settings ---
const activation = ref<'tanh' | 'sin' | 'cos' | 'softplus'>('tanh')
const layerCount = ref(3)
const colorMode = ref<'rgb' | 'bw' | 'palette'>('rgb')
const stops = ref(['#0d0221', '#9b1d6b', '#f5a623'])

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

const MAX_STOPS = 6

// --- Runtime state ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)
const hasGenerated = ref(false)
const bgUrl = ref('')

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

// --- Pack weights ---
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

// --- Color stops → flat Float32Array for uniform vec3[MAX_STOPS] ---
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}
function stopsFlat(): Float32Array {
  const out = new Float32Array(MAX_STOPS * 3)
  stops.value.forEach((hex, i) => {
    const [r, g, b] = hexToRgb(hex)
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b
  })
  return out
}

// --- Dynamic GLSL fragment shader ---
function makeFragSrc(layers: Layer[]): string {
  const sizes = [11, ...layers.map(l => l.b.length)]
  const N = layers.length

  const offsets: number[] = [0]
  for (let l = 0; l < N; l++)
    offsets.push(offsets[l]! + sizes[l]! * sizes[l + 1]! + sizes[l + 1]!)

  const actCode = {
    tanh:     'return tanh(x);',
    sin:      'return sin(x);',
    cos:      'return cos(x);',

    softplus: 'return x>20.?x:log(1.+exp(x));',
  }[activation.value]

  let fwd = `float inp[${sizes[0]}];
  inp[0]=x;inp[1]=y;inp[2]=r;
  for(int i=0;i<8;i++)inp[3+i]=u_z[i];
  `
  for (let l = 0; l < N; l++) {
    const inSz = sizes[l]!, outSz = sizes[l + 1]!
    const wOff = offsets[l]!, bOff = wOff + inSz * outSz
    const prev = l === 0 ? 'inp' : `h${l - 1}`
    const fn   = l === N - 1 ? 'sig' : 'act'
    fwd += `float h${l}[${outSz}];
  for(int o=0;o<${outSz};o++){
    float s=W(${bOff}+o);
    for(int i=0;i<${inSz};i++)s+=W(${wOff}+o*${inSz}+i)*${prev}[i];
    h${l}[o]=${fn}(s);
  }
  `
  }

  const mode = colorMode.value
  const paletteUniforms = mode === 'palette'
    ? `uniform int u_nstops;\nuniform vec3 u_stops[${MAX_STOPS}];` : ''
  const paletteFn = mode === 'palette' ? `
vec3 palette(float t){
  for(int i=0;i<u_nstops-1;i++){
    float t0=float(i)/float(u_nstops-1);
    float t1=float(i+1)/float(u_nstops-1);
    if(t<=t1) return mix(u_stops[i],u_stops[i+1],(t-t0)/(t1-t0));
  }
  return u_stops[u_nstops-1];
}` : ''
  const last = `h${N - 1}`
  const colLine = mode === 'rgb'
    ? `vec3 col=vec3(${last}[0],${last}[1],${last}[2]);`
    : mode === 'bw'
    ? `vec3 col=vec3(${last}[0]);`
    : `vec3 col=palette(${last}[0]);`

  return `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_w;
uniform int u_ts;
uniform vec2 u_res;
uniform float u_z[8];
uniform float u_grain;
${paletteUniforms}
float W(int i){return texelFetch(u_w,ivec2(i%u_ts,i/u_ts),0).r;}
float act(float x){${actCode}}
float sig(float x){return 1./(1.+exp(-x));}
float noise(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
${paletteFn}
void main(){
  vec2 c=gl_FragCoord.xy/u_res;
  float asp=u_res.x/u_res.y;
  float x=(c.x*2.-1.)*asp,y=(1.-c.y)*2.-1.,r=length(vec2(x,y));
  ${fwd}
  ${colLine}
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
  const g = canvas.value!.getContext('webgl2', { preserveDrawingBuffer: true })
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

function setUniforms(g: WebGL2RenderingContext, prog: WebGLProgram, w: number, h: number, z: number[]) {
  g.uniform2f(g.getUniformLocation(prog, 'u_res'), w, h)
  g.uniform1i(g.getUniformLocation(prog, 'u_ts'), texSize)
  g.uniform1fv(g.getUniformLocation(prog, 'u_z'), new Float32Array(z))
  g.uniform1i(g.getUniformLocation(prog, 'u_w'), 0)
  g.uniform1f(g.getUniformLocation(prog, 'u_grain'), grainEnabled.value ? grainLevel.value : 0.0)
  if (colorMode.value === 'palette') {
    g.uniform1i(g.getUniformLocation(prog, 'u_nstops'), stops.value.length)
    g.uniform3fv(g.getUniformLocation(prog, 'u_stops'), stopsFlat())
  }
}

function draw(z: number[]) {
  if (!gl || !program) return
  const el = canvas.value!
  gl.viewport(0, 0, el.width, el.height)
  setUniforms(gl, program, el.width, el.height, z)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

function captureBg() {
  bgUrl.value = canvas.value!.toDataURL('image/jpeg', 0.6)
}

// --- Generate ---
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
    captureBg()
    generating.value = false
    hasGenerated.value = true
  }, 10)
}

// --- Morphing ---
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

// --- Download (offscreen 4K render) ---
function download() {
  const [w, h] = EXPORT[aspectRatio.value]
  const offscreen = document.createElement('canvas')
  offscreen.width = w; offscreen.height = h
  const g = offscreen.getContext('webgl2', { preserveDrawingBuffer: true })!

  function comp(type: number, src: string) {
    const s = g.createShader(type)!
    g.shaderSource(s, src); g.compileShader(s); return s
  }
  const prog = g.createProgram()!
  g.attachShader(prog, comp(g.VERTEX_SHADER, `#version 300 es\nin vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`))
  g.attachShader(prog, comp(g.FRAGMENT_SHADER, makeFragSrc(currentWeights)))
  g.linkProgram(prog); g.useProgram(prog)
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), g.STATIC_DRAW)
  const loc = g.getAttribLocation(prog, 'p')
  g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)

  const data = packWeights(currentWeights)
  const ts = Math.ceil(Math.sqrt(data.length))
  const padded = new Float32Array(ts * ts); padded.set(data)
  g.bindTexture(g.TEXTURE_2D, g.createTexture())
  g.texImage2D(g.TEXTURE_2D, 0, g.R32F, ts, ts, 0, g.RED, g.FLOAT, padded)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)

  g.viewport(0, 0, w, h)
  // override texSize temporarily for offscreen context
  const savedTs = texSize; texSize = ts
  setUniforms(g, prog, w, h, currentZ)
  texSize = savedTs
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)

  offscreen.toBlob(blob => {
    const url = URL.createObjectURL(blob!)
    const a = document.createElement('a')
    a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}.png`
    a.click(); URL.revokeObjectURL(url)
  })
}

// --- Restore previous ---
function restorePrev() {
  if (!hasPrev.value) return
  currentWeights = prevWeights; currentZ = prevZ; hasPrev.value = false
  uploadWeights(currentWeights)
  buildProgram(currentWeights)
  draw(currentZ)
  captureBg()
}

// --- Add / remove stops ---
function addStop() {
  if (stops.value.length < MAX_STOPS) stops.value.push('#ffffff')
}
function removeStop(i: number) {
  if (stops.value.length > 2) stops.value.splice(i, 1)
}

watch(colorMode, generate)
watch(morphingEnabled, (on) => (on ? startMorphing() : stopMorphing()))
watch([grainEnabled, grainLevel], () => { if (!animating) draw(currentZ) })
watch(aspectRatio, () => { if (!animating) draw(currentZ) })
watch(stops, () => { if (!animating) draw(currentZ) }, { deep: true })
onMounted(() => { initGL(); generate() })
onUnmounted(stopMorphing)
</script>

<template>
  <div class="app">
    <div v-if="bgUrl" class="bg-blur" :style="{ backgroundImage: `url(${bgUrl})` }" />
    <main class="canvas-wrap">
      <canvas ref="canvas" :width="canvasW" :height="canvasH" class="canvas" />
    </main>

    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">GenPaper</span>
      </div>

      <div class="sidebar-body">
        <section class="group">
          <div class="group-title">Network</div>
          <div class="field">
            <div class="field-label">Activation</div>
            <select v-model="activation" class="select">
              <option value="tanh">tanh</option>
              <option value="sin">sin</option>
              <option value="cos">cos</option>
              <option value="softplus">softplus</option>
            </select>
          </div>
          <div class="field">
            <div class="field-label">Layers <span class="field-value">{{ layerCount }}</span></div>
            <input type="range" v-model.number="layerCount" min="1" max="8" class="slider" />
          </div>
        </section>

        <section class="group">
          <div class="group-title">Color</div>
          <div class="segment-control">
            <button :class="['seg-btn', colorMode === 'rgb' && 'active']" @click="colorMode = 'rgb'">RGB</button>
            <button :class="['seg-btn', colorMode === 'bw' && 'active']" @click="colorMode = 'bw'">B&amp;W</button>
            <button :class="['seg-btn', colorMode === 'palette' && 'active']" @click="colorMode = 'palette'">Palette</button>
          </div>
          <div v-if="colorMode === 'palette'" class="stop-row">
            <div v-for="(_, i) in stops" :key="i" class="stop">
              <input type="color" v-model="stops[i]" class="color-swatch" />
              <button class="stop-remove" @click="removeStop(i)" :disabled="stops.length <= 2">×</button>
            </div>
            <button class="stop-add" @click="addStop" :disabled="stops.length >= MAX_STOPS">+</button>
          </div>
        </section>

        <section class="group">
          <div class="group-title">Effects</div>
          <div class="field row">
            <div class="field-label">Grain</div>
            <div class="toggle-wrap">
              <input type="checkbox" v-model="grainEnabled" id="grain-toggle" class="toggle-input" />
              <label for="grain-toggle" class="toggle"></label>
            </div>
          </div>
          <Transition name="fade">
            <div v-if="grainEnabled" class="field">
              <div class="field-label">Level <span class="field-value">{{ grainLevel.toFixed(2) }}</span></div>
              <input type="range" v-model.number="grainLevel" min="0.02" max="0.5" step="0.01" class="slider" />
            </div>
          </Transition>
          <div class="field row">
            <div class="field-label">Morph</div>
            <div class="toggle-wrap">
              <input type="checkbox" v-model="morphingEnabled" id="morph-toggle" class="toggle-input" />
              <label for="morph-toggle" class="toggle"></label>
            </div>
          </div>
        </section>

        <section class="group">
          <div class="group-title">Options</div>
          <div class="field">
            <div class="field-label">Aspect ratio</div>
            <div class="ratio-btns">
              <button :class="['ratio-btn', aspectRatio === '1:1' && 'active']" @click="aspectRatio = '1:1'" title="1:1">
                <svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="currentColor"/></svg>
              </button>
              <button :class="['ratio-btn', aspectRatio === '16:9' && 'active']" @click="aspectRatio = '16:9'" title="16:9">
                <svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="4" width="14" height="8" rx="1.5" fill="currentColor"/></svg>
              </button>
              <button :class="['ratio-btn', aspectRatio === '9:16' && 'active']" @click="aspectRatio = '9:16'" title="9:16">
                <svg viewBox="0 0 16 16" width="16" height="16"><rect x="4" y="1" width="8" height="14" rx="1.5" fill="currentColor"/></svg>
              </button>
            </div>
          </div>
          <div class="field row">
            <div class="field-label">Seed</div>
            <div class="toggle-wrap">
              <input type="checkbox" v-model="seedEnabled" id="seed-toggle" class="toggle-input" />
              <label for="seed-toggle" class="toggle"></label>
            </div>
          </div>
          <Transition name="fade">
            <div v-if="seedEnabled" class="field">
              <input type="number" v-model.number="seedValue" class="number-input" />
            </div>
          </Transition>
        </section>
      </div>

      <div class="actions">
        <div class="actions-row">
          <button class="btn-secondary" @click="restorePrev" :disabled="!hasPrev || morphingEnabled">↩ Back</button>
          <button class="btn-secondary" @click="download" :disabled="!hasGenerated">↓ Download</button>
        </div>
        <button class="btn-generate" @click="generate" :disabled="generating || morphingEnabled">
          <span v-if="generating" class="spinner"></span>
          {{ generating ? 'Generating…' : 'Generate' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.app {
  --bg: #0a0a0f;
  --surface: #111118;
  --surface2: #1a1a24;
  --border: #2a2a38;
  --text: #e0e0f0;
  --muted: #6b6b88;
  --accent: #8b5cf6;
  --accent-dim: rgba(139, 92, 246, 0.15);
  --accent-hover: #9d76f8;
  --radius: 8px;
  --radius-sm: 5px;
  --sidebar: 260px;

  display: flex;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  font-size: 14px;
}

/* ── Background blur ── */
.bg-blur {
  position: fixed;
  inset: -5%;
  background-size: cover;
  background-position: center;
  filter: blur(90px) brightness(0.22) saturate(1.4);
  z-index: 0;
  pointer-events: none;
}

/* ── Canvas ── */
.canvas-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  position: relative;
  z-index: 1;
}

.canvas {
  max-width: 100%;
  max-height: calc(100vh - 64px);
  width: auto;
  height: auto;
  border-radius: var(--radius);
  box-shadow: 0 0 80px rgba(139, 92, 246, 0.1), 0 8px 40px rgba(0, 0, 0, 0.7);
  display: block;
}

/* ── Sidebar ── */
.sidebar {
  width: var(--sidebar);
  flex-shrink: 0;
  background: rgba(17, 17, 24, 0.6);
  backdrop-filter: blur(24px) saturate(1.6);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: sticky;
  top: 0;
  z-index: 1;
}

.sidebar-header {
  padding: 18px 20px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.logo {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.3px;
  background: linear-gradient(135deg, #a78bfa 0%, #ec4899 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.sidebar-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.sidebar-body::-webkit-scrollbar { width: 3px; }
.sidebar-body::-webkit-scrollbar-track { background: transparent; }
.sidebar-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

/* ── Groups ── */
.group {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.group-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.3px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 14px;
}

/* ── Fields ── */
.field {
  margin-bottom: 12px;
}

.field:last-child { margin-bottom: 0; }

.field.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.field-label {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.field.row .field-label { margin-bottom: 0; }

.field-value {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

/* ── Select ── */
.select {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 7px 28px 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b6b88'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  transition: border-color 0.15s;
}

.select:focus { border-color: var(--accent); }

/* ── Slider ── */
.slider {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  cursor: pointer;
  outline: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  box-shadow: 0 0 0 3px var(--accent-dim);
  transition: box-shadow 0.15s;
}

.slider::-webkit-slider-thumb:hover { box-shadow: 0 0 0 5px var(--accent-dim); }

.slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: none;
}

/* ── Segment control ── */
.segment-control {
  display: flex;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.seg-btn {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--muted);
  padding: 6px 4px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.seg-btn:hover:not(.active) { color: var(--text); }

.seg-btn.active {
  background: var(--accent);
  color: #fff;
}

/* ── Color stops ── */
.stop-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.stop { position: relative; }

.color-swatch {
  display: block;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  background: none;
}

.stop-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s;
}

.stop-remove:hover:not(:disabled) { border-color: #f87171; color: #f87171; }
.stop-remove:disabled { opacity: 0.25; cursor: default; }

.stop-add {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s;
}

.stop-add:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.stop-add:disabled { opacity: 0.25; cursor: default; }

/* ── Toggle ── */
.toggle-wrap { display: flex; align-items: center; }

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle {
  display: block;
  width: 34px;
  height: 18px;
  background: var(--border);
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.2s;
  position: relative;
  flex-shrink: 0;
}

.toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform 0.2s, background 0.2s;
}

.toggle-input:checked + .toggle { background: var(--accent); }
.toggle-input:checked + .toggle::after { transform: translateX(16px); background: #fff; }

/* ── Ratio buttons ── */
.ratio-btns { display: flex; gap: 6px; }

.ratio-btn {
  width: 36px;
  height: 36px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: all 0.15s;
  padding: 0;
}

.ratio-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }

.ratio-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

/* ── Number input ── */
.number-input {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.number-input:focus { border-color: var(--accent); }

/* ── Actions ── */
.actions {
  padding: 16px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.actions-row { display: flex; gap: 8px; }

.btn-secondary {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--muted);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
.btn-secondary:disabled { opacity: 0.3; cursor: default; }

.btn-generate {
  width: 100%;
  background: var(--accent);
  border: none;
  color: #fff;
  padding: 11px 16px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  letter-spacing: 0.1px;
}

.btn-generate:hover:not(:disabled) { background: var(--accent-hover); }
.btn-generate:disabled { opacity: 0.45; cursor: default; }

/* ── Spinner ── */
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
  flex-shrink: 0;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ── Fade transition ── */
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── Mobile ── */
@media (max-width: 767px) {
  .app { flex-direction: column; }

  .canvas-wrap {
    padding: 16px 16px 12px;
    flex: none;
  }

  .canvas { max-height: 55vw; }

  .sidebar {
    width: 100%;
    height: auto;
    position: static;
    border-left: none;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .sidebar-header { padding: 14px 16px 12px; }

  .sidebar-body { overflow-y: visible; }

  .group { padding: 14px 16px; }

  .actions { padding: 14px 16px; }
}

@media (max-width: 400px) {
  .canvas { max-height: 70vw; }
}
</style>
