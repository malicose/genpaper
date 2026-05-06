<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'

// --- Types ---
interface Layer { w: number[][]; b: number[] }
type Rng = () => number

// --- Settings ---
const activation = ref<'tanh' | 'sin' | 'softplus'>('tanh')
const layerCount = ref(3)
const colorMode = ref<'rgb' | 'bw'>('rgb')
const symmetry = ref<'none' | 'mirror' | 'radial'>('none')
const seedEnabled = ref(false)
const seedValue = ref(42)
const morphingEnabled = ref(false)

// --- State ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)
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
  const u = 1 - rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- Network ---
const activations: Record<string, (x: number) => number> = {
  tanh: Math.tanh,
  sin: Math.sin,
  softplus: (x) => (x > 20 ? x : Math.log(1 + Math.exp(x))),
}

function makeWeights(rng: Rng): Layer[] {
  const outputSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [11, ...Array(layerCount.value).fill(32), outputSize]
  return sizes.slice(1).map((outSize: number, i: number) => ({
    w: Array.from({ length: outSize }, () =>
      Array.from({ length: sizes[i] as number }, () => randn(rng)),
    ),
    b: Array.from({ length: outSize }, () => randn(rng)),
  }))
}

function makeZ(rng: Rng): number[] {
  return Array.from({ length: 8 }, () => randn(rng))
}

function lerpZ(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i]! - v) * t)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

// --- Rendering ---
function pixelInput(x: number, y: number, r: number, z: number[]): number[] {
  if (symmetry.value === 'mirror') return [Math.abs(x), Math.abs(y), r, ...z]
  if (symmetry.value === 'radial') return [r, r, r, ...z]
  return [x, y, r, ...z]
}

function renderFrame(weights: Layer[], z: number[]) {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')!
  const W = el.width
  const H = el.height
  const act = activations[activation.value]!
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
  const img = ctx.createImageData(W, H)

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const nx = (px / W) * 2 - 1
      const ny = (py / H) * 2 - 1
      const r = Math.sqrt(nx * nx + ny * ny)

      let signal = pixelInput(nx, ny, r, z)

      for (let l = 0; l < weights.length; l++) {
        const { w, b } = weights[l]!
        const isOutput = l === weights.length - 1
        signal = w.map((row: number[], i: number) => {
          const sum = row.reduce((acc: number, wij: number, j: number) => acc + wij * signal[j]!, b[i]!)
          return isOutput ? sigmoid(sum) : act(sum)
        })
      }

      const idx = (py * W + px) * 4
      if (colorMode.value === 'rgb') {
        img.data[idx] = signal[0]! * 255
        img.data[idx + 1] = signal[1]! * 255
        img.data[idx + 2] = signal[2]! * 255
      } else {
        const v = signal[0]! * 255
        img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = v
      }
      img.data[idx + 3] = 255
    }
  }

  ctx.putImageData(img, 0, 0)
}

// --- Static generate ---
function generate() {
  stopMorphing()
  morphingEnabled.value = false
  generating.value = true
  setTimeout(() => {
    const rng = makeRng()
    renderFrame(makeWeights(rng), makeZ(rng))
    generating.value = false
  }, 10)
}

// --- Morphing ---
function startMorphing() {
  animating = true
  // weights are seeded (or random), z always drifts randomly for endless variation
  const weights = makeWeights(makeRng())
  let zFrom = makeZ(Math.random)
  let zTo = makeZ(Math.random)
  let t = 0

  function step() {
    if (!animating) return
    t += 0.04
    if (t >= 1) {
      t = 0
      zFrom = zTo
      zTo = makeZ(Math.random)
    }
    renderFrame(weights, lerpZ(zFrom, zTo, smoothstep(t)))
    setTimeout(step, 0)
  }
  step()
}

function stopMorphing() {
  animating = false
}

watch(morphingEnabled, (on) => (on ? startMorphing() : stopMorphing()))
onMounted(generate)
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
        Symmetry
        <select v-model="symmetry">
          <option value="none">None</option>
          <option value="mirror">Mirror</option>
          <option value="radial">Radial</option>
        </select>
      </label>

      <label>
        <input type="checkbox" v-model="seedEnabled" />
        Seed
        <input
          type="number"
          v-model.number="seedValue"
          :disabled="!seedEnabled"
          style="width: 64px"
        />
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

canvas {
  border: 1px solid #ccc;
}

.controls {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  justify-content: center;
}

label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

select,
button,
input[type='number'] {
  padding: 5px 10px;
  font-size: 14px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
