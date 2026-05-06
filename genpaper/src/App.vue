<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'

interface Layer { w: number[][]; b: number[] }
type Rng = () => number

// --- Settings ---
const activation = ref<'tanh' | 'sin' | 'softplus'>('tanh')
const layerCount = ref(3)
const colorMode = ref<'rgb' | 'bw'>('rgb')

const seedEnabled = ref(false)
const seedValue = ref(42)
const morphingEnabled = ref(false)

// --- Runtime state ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)

let gl: WebGL2RenderingContext | null = null
let vs: WebGLShader | null = null
let program: WebGLProgram | null = null
let weightTex: WebGLTexture | null = null
let texSize = 1
let animating = false

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
    tanh: 'return tanh(x);',
    sin: 'return sin(x);',
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
  const colorOut = outSize === 3
    ? `fragColor=vec4(${last}[0],${last}[1],${last}[2],1.);`
    : `fragColor=vec4(${last}[0],${last}[0],${last}[0],1.);`

  return `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_w;
uniform int u_ts;
uniform vec2 u_res;
uniform float u_z[8];
float W(int i){return texelFetch(u_w,ivec2(i%u_ts,i/u_ts),0).r;}
float act(float x){${actCode}}
float sig(float x){return 1./(1.+exp(-x));}
void main(){
  vec2 c=gl_FragCoord.xy/u_res;
  float x=c.x*2.-1.,y=(1.-c.y)*2.-1.,r=length(vec2(x,y));
  ${fwd}
  ${colorOut}
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
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
}

// --- Generate (static) ---
function generate() {
  stopMorphing()
  morphingEnabled.value = false
  generating.value = true
  setTimeout(() => {
    const rng = makeRng()
    const weights = makeWeights(rng)
    uploadWeights(weights)
    buildProgram(weights)
    draw(makeZ(rng))
    generating.value = false
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

watch(morphingEnabled, (on) => (on ? startMorphing() : stopMorphing()))
onMounted(() => { initGL(); generate() })
onUnmounted(stopMorphing)
</script>

<template>
  <div class="app">
    <canvas ref="canvas" width="512" height="512" />

    <div class="controls">
      <label>
        Activation
        <select v-model="activation">
          <option value="tanh">tanh</option>
          <option value="sin">sin</option>
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

      <button @click="generate" :disabled="generating || morphingEnabled">
        {{ generating ? 'Generating…' : 'Generate' }}
      </button>
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
