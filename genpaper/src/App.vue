<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'

interface Layer { w: number[][]; b: number[] }
type Rng = () => number

// --- Settings ---
type Activation = 'smooth' | 'wave' | 'drift' | 'soft' | 'ring' | 'glow' | 'bend' | 'bell' | 'slope'
const ACT_CODES: Record<Activation, string> = {
  smooth: 'return tanh(x);',
  wave:   'return sin(x);',
  drift:  'return cos(x);',
  soft:   'return x>20.?x:log(1.+exp(x));',
  ring:   'return x==0.?1.:sin(x)/x;',
  glow:   'return exp(-x*x);',
  bend:   'return x/(1.+exp(-x));',
  bell:   'return 2./(exp(x)+exp(-x));',
  slope:  'return atan(x);',
}
const ACT_CODES_WGSL: Record<Activation, string> = {
  smooth: 'return tanh(x);',
  wave:   'return sin(x);',
  drift:  'return cos(x);',
  soft:   'if(x>20.0){return x;} return log(1.0+exp(x));',
  ring:   'if(x==0.0){return 1.0;} return sin(x)/x;',
  glow:   'return exp(-x*x);',
  bend:   'return x/(1.0+exp(-x));',
  bell:   'return 2.0/(exp(x)+exp(-x));',
  slope:  'return atan(x);',
}
const activation  = ref<Activation>('smooth')
const activation2 = ref<Activation>('wave')
const dualActivation = ref(false)
const networkType = ref<'cppn' | 'siren'>('cppn')
const sirenOmega = ref(70)
const _cppnDepth = ref(3)
const _sirenDepth = ref(7)
const layerCount = computed({
  get: () => networkType.value === 'siren' ? _sirenDepth.value : _cppnDepth.value,
  set: (v: number) => { if (networkType.value === 'siren') _sirenDepth.value = v; else _cppnDepth.value = v },
})
const colorMode = ref<'rgb' | 'bw' | 'palette'>('rgb')
const stops = ref(['#0d0221', '#9b1d6b', '#f5a623'])

const seedEnabled = ref(false)
const seedValue = ref(Math.floor(Math.random() * 0xFFFFFFFF))
const morphingEnabled = ref(false)
const grainEnabled = ref(false)
const grainLevel = ref(0.15)
const glassEnabled = ref(false)
const glassFrost = ref(0.45)
const glassRefraction = ref(0.8)
const glassSize = ref(0.55)
const glassBlobCount = ref(6)
const glassBlobSmooth = ref(0.25)
const aspectRatio = ref<'1:1' | '16:9' | '9:16'>('1:1')

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
const HIDDEN_SIZE = isWindows ? 16 : 32
const DISPLAY: Record<'1:1' | '16:9' | '9:16', [number, number]> = isWindows
  ? { '1:1': [512, 512], '16:9': [512, 288], '9:16': [288, 512] }
  : { '1:1': [512, 512], '16:9': [512, 288], '9:16': [288, 512] }
const MUSIC_DISPLAY: Record<'1:1' | '16:9' | '9:16', [number, number]> =
  { '1:1': [256, 256], '16:9': [256, 144], '9:16': [144, 256] }
const EXPORT  = { '1:1': [3840, 3840], '16:9': [3840, 2160], '9:16': [2160, 3840] } as const
const canvasW = computed(() => (appMode.value === 'music' ? MUSIC_DISPLAY : DISPLAY)[aspectRatio.value][0])
const canvasH = computed(() => (appMode.value === 'music' ? MUSIC_DISPLAY : DISPLAY)[aspectRatio.value][1])

const MAX_STOPS = 12

// --- Runtime state ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)
const transitionImg = ref('')
const showTransition = ref(false)
const downloading = ref(false)
const hasGenerated = ref(false)
const bgUrl = ref('')
const showSettings = ref(false)
const accentColor = ref('#8b5cf6')
const accentColor2 = ref('#ec4899')

// --- Color extraction ---
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else                h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  if      (h < 60)  { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else              { r = c; g = 0; b = x }
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function wcagLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function withWhiteContrast(h: number, s: number, l: number): string {
  // Darken until contrast ratio with white ≥ 4.0
  while (l > 0.05) {
    const hex = hslToHex(h, s, l)
    const n = parseInt(hex.slice(1), 16)
    const lum = wcagLuminance((n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
    if (1.05 / (lum + 0.05) >= 4.0) return hex
    l -= 0.02
  }
  return hslToHex(h, s, l)
}

function extractAccent() {
  const src = canvas.value!
  const tmp = document.createElement('canvas')
  tmp.width = 48; tmp.height = 48
  const ctx = tmp.getContext('2d')!
  ctx.drawImage(src, 0, 0, 48, 48)
  const { data } = ctx.getImageData(0, 0, 48, 48)

  let rAcc = 0, gAcc = 0, bAcc = 0, wTotal = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
    const max = Math.max(r, g, b)
    const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max
    const w = sat * sat
    rAcc += r * w; gAcc += g * w; bAcc += b * w; wTotal += w
  }

  if (colorMode.value === 'bw') {
    accentColor.value  = withWhiteContrast(0, 0, 0.6)
    accentColor2.value = withWhiteContrast(0, 0, 0.75)
    return
  }

  if (wTotal < 0.1) return  // near-greyscale, keep current accent

  const r = rAcc / wTotal, g = gAcc / wTotal, b = bAcc / wTotal
  const [h, s] = rgbToHsl(r, g, b)
  accentColor.value  = withWhiteContrast(h, Math.max(s, 0.65), 0.6)
  accentColor2.value = withWhiteContrast((h + 38) % 360, Math.max(s, 0.65), 0.6)
}

let gl: WebGL2RenderingContext | null = null
let vs: WebGLShader | null = null
let program: WebGLProgram | null = null
let glassProgram: WebGLProgram | null = null
let blurProg: WebGLProgram | null = null
let weightTex: WebGLTexture | null = null
let framebuffer: WebGLFramebuffer | null = null
let fbTexture: WebGLTexture | null = null
let fbBlurFb: WebGLFramebuffer | null = null
let fbBlurTex: WebGLTexture | null = null
let fbBlur2Fb: WebGLFramebuffer | null = null
let fbBlur2Tex: WebGLTexture | null = null
let fbWidth = 0
let fbHeight = 0
let texSize = 1
let khrExt: { COMPLETION_STATUS_KHR: number } | null = null

// --- WebGPU state ---
const gpuReady = ref(false)
let gpuDevice: GPUDevice | null = null
let gpuContext: GPUCanvasContext | null = null
let gpuCanvasFormat: GPUTextureFormat = 'bgra8unorm'
let gpuPipeline: GPURenderPipeline | null = null
let gpuUniformBuf: GPUBuffer | null = null
let gpuWeightTex: GPUTexture | null = null
let gpuBindGroup: GPUBindGroup | null = null
let gpuTexSize = 1
const GPU_UNIFORM_BYTES = 272 // +16 bytes for zoom/panx/pany/actblend at offset 256
let animating = false
let currentZ: number[] = []
let currentWeights: Layer[] = []
let prevWeights: Layer[] = []
let prevZ: number[] = []
const hasPrev = ref(false)
let glassBlobs: Float32Array = new Float32Array(36)

// --- Music mode ---
const appMode = ref<'visual' | 'music'>('visual')
const audioSource = ref<'mic' | 'system'>('mic')
const audioActive = ref(false)
const audioError = ref('')
let audioCtx: AudioContext | null = null
let audioAnalyser: AnalyserNode | null = null
let audioStream: MediaStream | null = null
let audioAnimId: number | null = null
let audioZa: number[] = []
let audioZb: number[] = []
let audioMorphT = 0
const audioVizCanvas = ref<HTMLCanvasElement | null>(null)
let savedLayerCount = 3
// Audio shader overrides (written each frame, read by setUniforms/drawGPU)
let audioGrainLevel = 0
let audioZoom       = 1
let audioPanX       = 0
let audioPanY       = 0
let audioActBlend   = 0
let prevBandSub  = 0  // previous-frame energies for onset detection
let prevBandMid  = 0
let prevBandHigh = 0
let kickCooldown  = 0  // frames until next kick can trigger
let snareCooldown = 0
let hatCooldown   = 0
let dispKick   = 0    // display values, decay each frame
let dispSnare  = 0
let dispHat    = 0
let dispBass   = 0
let dispMelody = 0
const audioBassSens  = ref(1.0)
const audioMidSens   = ref(1.0)
const audioHighSens  = ref(1.0)
const audioMorphSpeed = ref(4)

let cpuWorker: Worker | null = null

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
  if (!seedEnabled.value) seedValue.value = Math.floor(Math.random() * 0xFFFFFFFF)
  return mulberry32(seedValue.value)
}
function randn(rng: Rng): number {
  const u = 1 - rng(), v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- Network ---
const INPUT_SIZE = 11 // x,y,r + z×8

function makeWeights(rng: Rng): Layer[] {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [INPUT_SIZE, ...Array(layerCount.value).fill(HIDDEN_SIZE), outSize]
  return sizes.slice(1).map((o: number, i: number) => ({
    w: Array.from({ length: o }, () => Array.from({ length: sizes[i] as number }, () => randn(rng))),
    b: Array.from({ length: o }, () => randn(rng)),
  }))
}

function makeSirenWeights(rng: Rng): Layer[] {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [INPUT_SIZE, ...Array(layerCount.value).fill(HIDDEN_SIZE), outSize]
  return sizes.slice(1).map((o: number, i: number) => {
    const inSz = sizes[i] as number
    const wScale = i === 0 ? sirenOmega.value / inSz : Math.sqrt(6 / inSz)
    return {
      w: Array.from({ length: o }, () => Array.from({ length: inSz }, () => (rng() * 2 - 1) * wScale)),
      b: Array.from({ length: o }, () => (rng() * 2 - 1) * wScale),
    }
  })
}

function makeNetworkWeights(rng: Rng): Layer[] {
  return networkType.value === 'siren' ? makeSirenWeights(rng) : makeWeights(rng)
}
function makeZ(rng: Rng): number[] {
  return Array.from({ length: 8 }, () => randn(rng))
}
function lerpZ(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i]! - v) * t)
}
function smoothstep(t: number) { return t * t * t * (t * (t * 6 - 15) + 10) }

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: Parameters<T>) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }) as T
}

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
  const sizes = [layers[0]!.w[0]!.length, ...layers.map(l => l.b.length)]
  const N = layers.length

  const offsets: number[] = [0]
  for (let l = 0; l < N; l++)
    offsets.push(offsets[l]! + sizes[l]! * sizes[l + 1]! + sizes[l + 1]!)

  const isSiren = networkType.value === 'siren'
  const actCode1 = ACT_CODES[isSiren ? 'wave' : activation.value]
  const actCode2 = ACT_CODES[isSiren ? 'wave' : activation2.value]
  const effDual = !isSiren && dualActivation.value

  let fwd = `float inp[${sizes[0]}];
  inp[0]=x;inp[1]=y;inp[2]=r;
  for(int i=0;i<8;i++)inp[3+i]=u_z[i];
  `
  for (let l = 0; l < N; l++) {
    const inSz = sizes[l]!, outSz = sizes[l + 1]!
    const wOff = offsets[l]!, bOff = wOff + inSz * outSz
    const prev = l === 0 ? 'inp' : `h${l - 1}`
    const fn   = l === N - 1 ? 'sig' : (effDual && l % 2 !== 0 ? 'actB' : 'actA')
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
uniform float u_zoom;
uniform float u_panx;
uniform float u_pany;
uniform float u_actblend;
${paletteUniforms}
float W(int i){return texelFetch(u_w,ivec2(i%u_ts,i/u_ts),0).r;}
float act1(float x){${actCode1}}
float act2(float x){${actCode2}}
float actA(float x){return mix(act1(x),act2(x),u_actblend);}
float actB(float x){return mix(act2(x),act1(x),u_actblend);}
float sig(float x){return 1./(1.+exp(-x));}
float noise(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
${paletteFn}
void main(){
  vec2 c=gl_FragCoord.xy/u_res;
  float asp=u_res.x/u_res.y;
  float x=((c.x*2.-1.)*asp+u_panx)*u_zoom,y=((1.-c.y)*2.-1.+u_pany)*u_zoom,r=length(vec2(x,y));
  ${fwd}
  ${colLine}
  float g=(noise(gl_FragCoord.xy)-0.5)*u_grain;
  fragColor=vec4(clamp(col+g,0.,1.),1.);
}`
}

// --- Dynamic WGSL fragment shader ---
// Uniform buffer layout (272 bytes, matches GPU_UNIFORM_BYTES):
//   0:  res (vec2f)   8: ts (u32)   12: grain (f32)
//   16: z0 (vec4f, z[0..3])   32: z1 (vec4f, z[4..7])
//   48: nstops (u32)  52-60: padding
//   64: stops (array<vec4f,12>)
//   256: zoom (f32)  260: panx (f32)  264: pany (f32)  268: actblend (f32)
function makeFragWGSL(layers: Layer[]): string {
  const sizes = [layers[0]!.w[0]!.length, ...layers.map(l => l.b.length)]
  const N = layers.length

  const offsets: number[] = [0]
  for (let l = 0; l < N; l++)
    offsets.push(offsets[l]! + sizes[l]! * sizes[l + 1]! + sizes[l + 1]!)

  const isSiren = networkType.value === 'siren'
  const actCode1 = ACT_CODES_WGSL[isSiren ? 'wave' : activation.value]
  const actCode2 = ACT_CODES_WGSL[isSiren ? 'wave' : activation2.value]
  const effDual = !isSiren && dualActivation.value

  const inputSize = sizes[0]!

  // forward pass — WGSL uses i32 loop vars with unique names per layer
  let fwd = `var inp: array<f32, ${inputSize}>;
  inp[0]=x; inp[1]=y; inp[2]=r;
  inp[3]=u.z0.x; inp[4]=u.z0.y; inp[5]=u.z0.z; inp[6]=u.z0.w;
  inp[7]=u.z1.x; inp[8]=u.z1.y; inp[9]=u.z1.z; inp[10]=u.z1.w;
  `
  for (let l = 0; l < N; l++) {
    const inSz = sizes[l]!, outSz = sizes[l + 1]!
    const wOff = offsets[l]!, bOff = wOff + inSz * outSz
    const prev = l === 0 ? 'inp' : `h${l - 1}`
    const fn   = l === N - 1 ? 'sig' : (effDual && l % 2 !== 0 ? 'actB' : 'actA')
    fwd += `var h${l}: array<f32, ${outSz}>;
  for(var o${l}: i32=0; o${l}<${outSz}; o${l}++){
    var s${l}: f32=W(${bOff}+o${l});
    for(var i${l}: i32=0; i${l}<${inSz}; i${l}++){s${l}+=W(${wOff}+o${l}*${inSz}+i${l})*${prev}[i${l}];}
    h${l}[o${l}]=${fn}(s${l});
  }
  `
  }

  const mode = colorMode.value
  const last = `h${N - 1}`
  const colLine = mode === 'rgb'
    ? `var col: vec3f = vec3f(${last}[0], ${last}[1], ${last}[2]);`
    : mode === 'bw'
    ? `var col: vec3f = vec3f(${last}[0]);`
    : `var col: vec3f = palette(${last}[0]);`

  const paletteFn = mode === 'palette' ? `
fn palette(t: f32) -> vec3f {
  let ns: i32 = i32(u.nstops);
  for(var i: i32=0; i<ns-1; i++){
    let ns1: f32 = f32(ns-1);
    let t0: f32 = f32(i)/ns1;
    let t1: f32 = f32(i+1)/ns1;
    if(t<=t1){ return mix(u.stops[i].xyz, u.stops[i+1].xyz, (t-t0)/(t1-t0)); }
  }
  return u.stops[ns-1].xyz;
}` : ''

  return `struct Uniforms {
  res: vec2f, ts: u32, grain: f32,
  z0: vec4f, z1: vec4f,
  nstops: u32, _p0: u32, _p1: u32, _p2: u32,
  stops: array<vec4f, 12>,
  zoom: f32, panx: f32, pany: f32, actblend: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var u_w: texture_2d<f32>;

fn W(i: i32) -> f32 { return textureLoad(u_w, vec2i(i%i32(u.ts), i/i32(u.ts)), 0).r; }
fn act1(x: f32) -> f32 { ${actCode1} }
fn act2(x: f32) -> f32 { ${actCode2} }
fn actA(x: f32) -> f32 { return mix(act1(x), act2(x), u.actblend); }
fn actB(x: f32) -> f32 { return mix(act2(x), act1(x), u.actblend); }
fn sig(x: f32) -> f32 { return 1.0/(1.0+exp(-x)); }
fn noise(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898,78.233)))*43758.5453); }
${paletteFn}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f,4>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(1.,1.));
  return vec4f(pos[vi], 0., 1.);
}

@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = pos.xy / u.res;
  let asp = u.res.x / u.res.y;
  let x = ((c.x*2.0-1.0)*asp + u.panx) * u.zoom;
  let y = ((1.0-c.y)*2.0-1.0 + u.pany) * u.zoom;
  let r = length(vec2f(x, y));
  ${fwd}
  ${colLine}
  let gv = (noise(pos.xy)-0.5)*u.grain;
  return vec4f(clamp(col+gv, vec3f(0.0), vec3f(1.0)), 1.0);
}`
}

// --- Glass shader ---
const MAX_BLOBS = 12

function scaledBlobsArray(): number[] {
  const s = glassSize.value / 0.55
  const arr: number[] = []
  for (let i = 0; i < MAX_BLOBS; i++) {
    arr.push((glassBlobs[i * 3]     ?? 0) * s)
    arr.push((glassBlobs[i * 3 + 1] ?? 0) * s)
    arr.push((glassBlobs[i * 3 + 2] ?? 0) * s)
  }
  return arr
}

function makeGlassBlobs(rng: Rng): Float32Array {
  const asp = canvasW.value / canvasH.value
  const n = glassBlobCount.value
  const data = new Float32Array(MAX_BLOBS * 3)
  const cx = (rng() * 1.6 - 0.8) * asp
  const cy = rng() * 1.6 - 0.8
  for (let i = 0; i < n; i++) {
    const angle = rng() * Math.PI * 2
    const dist  = rng() * 0.45
    data[i*3]   = cx + Math.cos(angle) * dist * asp
    data[i*3+1] = cy + Math.sin(angle) * dist
    data[i*3+2] = 0.25 + rng() * 0.25
  }
  return data
}

// 11-tap horizontal Gaussian (sigma = 2*step), step in pixels
function makeBlurSrc(): string {
  return `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_step;
uniform vec2 u_dir;
void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  vec2 d=u_dir*u_step/u_res;
  vec3 c=texture(u_tex,uv).rgb*0.2006;
  c+=(texture(u_tex,clamp(uv+d*1.408,0.,1.))+texture(u_tex,clamp(uv-d*1.408,0.,1.))).rgb*0.2987;
  c+=(texture(u_tex,clamp(uv+d*3.294,0.,1.))+texture(u_tex,clamp(uv-d*3.294,0.,1.))).rgb*0.0922;
  c+=(texture(u_tex,clamp(uv+d*5.0,0.,1.))+texture(u_tex,clamp(uv-d*5.0,0.,1.))).rgb*0.0088;
  fragColor=vec4(c,1.);
}`
}

function makeGlassSrc(): string {
  return `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_scene;
uniform sampler2D u_hblurred;
uniform vec2 u_res;
uniform float u_frost;
uniform float u_grain;
uniform float u_smooth;
uniform int u_nblobs;
uniform vec3 u_blobs[12];
float noise(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}

float smin(float a,float b,float k){
  float h=clamp(0.5+0.5*(b-a)/k,0.,1.);
  return mix(b,a,h)-k*h*(1.-h);
}
float blobField(vec2 p){
  float d=1e9;
  for(int i=0;i<12;i++){
    if(i>=u_nblobs)break;
    float di=length(p-u_blobs[i].xy)-u_blobs[i].z;
    d=smin(d,di,u_smooth);
  }
  return d;
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  uv.y=1.-uv.y;
  float asp=u_res.x/u_res.y;
  vec2 p=(uv-0.5)*2.*vec2(asp,1.);
  float d=blobField(p);
  if(d>0.04){
    vec3 sc=texture(u_scene,uv).rgb+(noise(gl_FragCoord.xy)-0.5)*u_grain;
    fragColor=vec4(clamp(sc,0.,1.),1.);return;
  }
  float inside=smoothstep(0.003,-0.001,d);
  float eps=0.005;
  float nx=blobField(p+vec2(eps,0.))-blobField(p-vec2(eps,0.));
  float ny=blobField(p+vec2(0.,eps))-blobField(p-vec2(0.,eps));
  vec2 nrm=normalize(vec2(nx,ny)+vec2(1e-6));
  vec2 nrmDir=normalize(nrm*vec2(1./asp,1.));
  vec3 glass=texture(u_hblurred,uv).rgb;
  glass*=vec3(1.01,1.02,1.06);
  glass+=0.025*(1.-u_frost*0.6);
  float rimBand=smoothstep(0.006,0.001,d)-smoothstep(0.001,-0.004,d);
  float rimDir=max(0.,dot(-nrmDir,normalize(vec2(1.,1.))));
  glass+=rimBand*(0.04+rimDir*0.38);
  float shadowDir=max(0.,dot(nrmDir,normalize(vec2(1.,1.))));
  glass-=rimBand*shadowDir*0.1;
  vec3 col=mix(texture(u_scene,uv).rgb,glass,inside);
  col+=(noise(gl_FragCoord.xy)-0.5)*u_grain;
  fragColor=vec4(clamp(col,0.,1.),1.);
}`
}

function buildGlassProgram() {
  const g = gl!
  if (glassProgram) g.deleteProgram(glassProgram)
  const gfs = compileShader(g.FRAGMENT_SHADER, makeGlassSrc())
  glassProgram = g.createProgram()!
  g.attachShader(glassProgram, vs!); g.attachShader(glassProgram, gfs)
  g.linkProgram(glassProgram); g.deleteShader(gfs)

  if (blurProg) g.deleteProgram(blurProg)
  const bfs = compileShader(g.FRAGMENT_SHADER, makeBlurSrc())
  blurProg = g.createProgram()!
  g.attachShader(blurProg, vs!); g.attachShader(blurProg, bfs)
  g.linkProgram(blurProg); g.deleteShader(bfs)
}

function makeFbTex(g: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const t = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, t)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
  return t
}

function makeFb(g: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fb = g.createFramebuffer()!
  g.bindFramebuffer(g.FRAMEBUFFER, fb)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  return fb
}

function ensureFramebuffer(w: number, h: number) {
  if (fbWidth === w && fbHeight === h && framebuffer) return
  const g = gl!
  if (fbTexture) g.deleteTexture(fbTexture)
  if (framebuffer) g.deleteFramebuffer(framebuffer)
  if (fbBlurTex) g.deleteTexture(fbBlurTex)
  if (fbBlurFb) g.deleteFramebuffer(fbBlurFb)
  fbTexture = makeFbTex(g, w, h); framebuffer = makeFb(g, fbTexture)
  fbBlurTex = makeFbTex(g, w, h); fbBlurFb = makeFb(g, fbBlurTex)
  fbBlur2Tex = makeFbTex(g, w, h); fbBlur2Fb = makeFb(g, fbBlur2Tex)
  fbWidth = w; fbHeight = h
}

function setGlassUniforms(g: WebGL2RenderingContext, prog: WebGLProgram, w: number, h: number) {
  g.uniform2f(g.getUniformLocation(prog, 'u_res'), w, h)
  g.uniform1i(g.getUniformLocation(prog, 'u_scene'), 0)
  g.uniform1i(g.getUniformLocation(prog, 'u_hblurred'), 1)
  g.uniform1f(g.getUniformLocation(prog, 'u_frost'), glassFrost.value)
  g.uniform1f(g.getUniformLocation(prog, 'u_grain'), grainEnabled.value ? grainLevel.value : 0.0)
  g.uniform1f(g.getUniformLocation(prog, 'u_smooth'), glassBlobSmooth.value)
  g.uniform1i(g.getUniformLocation(prog, 'u_nblobs'), glassBlobCount.value)
  const s = glassSize.value / 0.55
  const scaled = new Float32Array(MAX_BLOBS * 3)
  for (let i = 0; i < MAX_BLOBS; i++) {
    scaled[i * 3]     = (glassBlobs[i * 3]     ?? 0) * s
    scaled[i * 3 + 1] = (glassBlobs[i * 3 + 1] ?? 0) * s
    scaled[i * 3 + 2] = (glassBlobs[i * 3 + 2] ?? 0) * s
  }
  g.uniform3fv(g.getUniformLocation(prog, 'u_blobs'), scaled)
}

function setBlurUniforms(g: WebGL2RenderingContext, prog: WebGLProgram, w: number, h: number, dx: number, dy: number) {
  g.uniform1i(g.getUniformLocation(prog, 'u_tex'), 0)
  g.uniform2f(g.getUniformLocation(prog, 'u_res'), w, h)
  g.uniform1f(g.getUniformLocation(prog, 'u_step'), glassFrost.value * Math.min(w, h) * 0.04)
  g.uniform2f(g.getUniformLocation(prog, 'u_dir'), dx, dy)
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
  console.log(`[GP] initGL: canvas ${canvas.value!.width}×${canvas.value!.height}, HIDDEN_SIZE=${HIDDEN_SIZE}`)
  const t0 = performance.now()
  const g = canvas.value!.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!g) { if (!isWindows) alert('WebGL 2 not supported in this browser'); console.warn('[GP] initGL: WebGL2 context failed'); return }
  console.log(`[GP] initGL: context OK (${(performance.now()-t0).toFixed(1)}ms)`)
  gl = g
  khrExt = g.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null
  console.log(`[GP] initGL: KHR_parallel_shader_compile = ${khrExt ? 'YES' : 'NO'}`)
  const t1 = performance.now()
  vs = compileShader(g.VERTEX_SHADER,
    `#version 300 es\nlayout(location=0) in vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`)
  console.log(`[GP] initGL: vertex shader compiled (${(performance.now()-t1).toFixed(1)}ms)`)
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), g.STATIC_DRAW)
}

function buildProgram(layers: Layer[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const g = gl!
    if (program) g.deleteProgram(program)
    const t0 = performance.now()
    const fs = compileShader(g.FRAGMENT_SHADER, makeFragSrc(layers))
    program = g.createProgram()!
    g.attachShader(program, vs!)
    g.attachShader(program, fs)
    g.linkProgram(program)
    console.log(`[GP] buildProgram: shaders submitted (${(performance.now()-t0).toFixed(1)}ms), KHR=${khrExt ? 'YES' : 'NO'}`)

    if (!khrExt) {
      const t1 = performance.now()
      g.useProgram(program)
      console.log(`[GP] buildProgram: useProgram (no KHR, blocked ${(performance.now()-t1).toFixed(1)}ms), total=${(performance.now()-t0).toFixed(1)}ms`)
      const loc = g.getAttribLocation(program, 'p')
      g.enableVertexAttribArray(loc)
      g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
      resolve()
      return
    }

    let frames = 0
    function poll() {
      frames++
      if (g.getProgramParameter(program!, khrExt!.COMPLETION_STATUS_KHR) === true) {
        console.log(`[GP] buildProgram: KHR ready after ${frames} frames (${(performance.now()-t0).toFixed(1)}ms)`)
        g.useProgram(program!)
        const loc = g.getAttribLocation(program!, 'p')
        g.enableVertexAttribArray(loc)
        g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
        resolve()
      } else if (frames > 500) {
        console.warn(`[GP] buildProgram: KHR timeout after ${frames} frames, forcing useProgram`)
        g.useProgram(program!)
        const loc = g.getAttribLocation(program!, 'p')
        g.enableVertexAttribArray(loc)
        g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
        resolve()
      } else {
        requestAnimationFrame(poll)
      }
    }
    requestAnimationFrame(poll)
  })
}

function uploadWeights(layers: Layer[]) {
  const g = gl!
  const t0 = performance.now()
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
  console.log(`[GP] uploadWeights: ${data.length} floats, texSize=${texSize} (${(performance.now()-t0).toFixed(1)}ms)`)
}

function setUniforms(g: WebGL2RenderingContext, prog: WebGLProgram, w: number, h: number, z: number[]) {
  g.uniform2f(g.getUniformLocation(prog, 'u_res'), w, h)
  g.uniform1i(g.getUniformLocation(prog, 'u_ts'), texSize)
  g.uniform1fv(g.getUniformLocation(prog, 'u_z'), new Float32Array(z))
  g.uniform1i(g.getUniformLocation(prog, 'u_w'), 0)
  const au = audioActive.value
  g.uniform1f(g.getUniformLocation(prog, 'u_grain'), au ? audioGrainLevel : (grainEnabled.value && !glassEnabled.value) ? grainLevel.value : 0.0)
  g.uniform1f(g.getUniformLocation(prog, 'u_zoom'),     au ? audioZoom     : 1.0)
  g.uniform1f(g.getUniformLocation(prog, 'u_panx'),     au ? audioPanX     : 0.0)
  g.uniform1f(g.getUniformLocation(prog, 'u_pany'),     au ? audioPanY     : 0.0)
  g.uniform1f(g.getUniformLocation(prog, 'u_actblend'), au ? audioActBlend : 0.0)
  if (colorMode.value === 'palette') {
    g.uniform1i(g.getUniformLocation(prog, 'u_nstops'), stops.value.length)
    g.uniform3fv(g.getUniformLocation(prog, 'u_stops'), stopsFlat())
  }
}

function draw(z: number[]) {
  if (!gl || !program) return
  const el = canvas.value!
  const w = el.width, h = el.height
  const g = gl

  if (glassEnabled.value && glassProgram && blurProg) {
    ensureFramebuffer(w, h)
    // Pass 1: scene → fbTexture
    g.bindFramebuffer(g.FRAMEBUFFER, framebuffer)
    g.viewport(0, 0, w, h)
    g.useProgram(program)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, weightTex)
    setUniforms(g, program, w, h, z)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
    // Pass 2: H-blur fbTexture → fbBlurTex
    g.bindFramebuffer(g.FRAMEBUFFER, fbBlurFb)
    g.viewport(0, 0, w, h)
    g.useProgram(blurProg)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, fbTexture)
    setBlurUniforms(g, blurProg, w, h, 1, 0)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
    // Pass 3: V-blur fbBlurTex → fbBlur2Tex
    g.bindFramebuffer(g.FRAMEBUFFER, fbBlur2Fb)
    g.viewport(0, 0, w, h)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, fbBlurTex)
    setBlurUniforms(g, blurProg, w, h, 0, 1)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
    // Pass 4: glass composite → screen
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, w, h)
    g.useProgram(glassProgram)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, fbTexture)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, fbBlur2Tex)
    setGlassUniforms(g, glassProgram, w, h)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  } else {
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, w, h)
    g.useProgram(program)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, weightTex)
    setUniforms(g, program, w, h, z)
    const t0 = performance.now()
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
    console.log(`[GP] draw: drawArrays ${w}×${h} (${(performance.now()-t0).toFixed(1)}ms)`)
  }
}

function captureBg() {
  // Defer toDataURL to next rAF: on Windows, reading GPU pixels synchronously
  // blocks the main thread even after gl.finish(), because the real GPU→CPU
  // transfer doesn't happen until the browser compositor releases the framebuffer.
  requestAnimationFrame(() => {
    if (!canvas.value) return
    console.log('[GP] captureBg: toDataURL...')
    const t0 = performance.now()
    bgUrl.value = canvas.value.toDataURL('image/jpeg', 0.6)
    console.log(`[GP] captureBg: done (${(performance.now()-t0).toFixed(1)}ms)`)
    extractAccent()
  })
}

// --- WebGPU ---
async function initGPU(): Promise<boolean> {
  if (!navigator.gpu) { console.log('[GP] WebGPU: navigator.gpu not available'); return false }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) { console.log('[GP] WebGPU: no adapter'); return false }
  try {
    gpuDevice = await adapter.requestDevice()
  } catch (e) { console.log('[GP] WebGPU: requestDevice failed', e); return false }
  const ctx = canvas.value!.getContext('webgpu') as GPUCanvasContext | null
  if (!ctx) { console.log('[GP] WebGPU: getContext failed'); gpuDevice = null; return false }
  gpuContext = ctx
  gpuCanvasFormat = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device: gpuDevice, format: gpuCanvasFormat, alphaMode: 'opaque' })
  gpuUniformBuf = gpuDevice.createBuffer({ size: GPU_UNIFORM_BYTES, usage: 0x40 | 0x08 /* UNIFORM | COPY_DST */ })
  gpuDevice.lost.then((info) => {
    console.warn(`[GP] WebGPU device lost: ${info.reason} — ${info.message}`)
    gpuDevice = null; gpuContext = null; gpuPipeline = null; gpuUniformBuf = null; gpuWeightTex = null; gpuBindGroup = null
    gpuReady.value = false
  })
  gpuReady.value = true
  console.log(`[GP] WebGPU: init OK, format=${gpuCanvasFormat}`)
  return true
}

async function buildPipelineGPU(layers: Layer[]): Promise<void> {
  const device = gpuDevice!
  const t0 = performance.now()
  // createShaderModule + createRenderPipelineAsync is the correct non-blocking path.
  // getCompilationInfo() before pipeline creation can synchronously block the main
  // thread on Windows D3D12 while WGSL→DXIL compiles — skip it here.
  const mod = device.createShaderModule({ code: makeFragWGSL(layers) })
  console.log(`[GP] buildPipelineGPU: module submitted (${(performance.now()-t0).toFixed(1)}ms)`)
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 0x2 /* FRAGMENT */, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 0x2 /* FRAGMENT */, texture: { sampleType: 'unfilterable-float' } },
  ]})
  gpuPipeline = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex:   { module: mod, entryPoint: 'vs_main' },
    fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: gpuCanvasFormat }] },
    primitive: { topology: 'triangle-strip' },
  })
  console.log(`[GP] buildPipelineGPU: pipeline ready (${(performance.now()-t0).toFixed(1)}ms)`)
  // Log any WGSL errors after pipeline is ready (already compiled, fast round-trip)
  const info = await mod.getCompilationInfo()
  for (const m of info.messages)
    if (m.type === 'error') console.error(`[GP] WGSL error line ${m.lineNum}: ${m.message}`)
}

function uploadWeightsGPU(layers: Layer[]): void {
  const device = gpuDevice!
  const data = packWeights(layers)
  gpuTexSize = Math.ceil(Math.sqrt(data.length))
  const padded = new Float32Array(gpuTexSize * gpuTexSize)
  padded.set(data)
  if (gpuWeightTex) gpuWeightTex.destroy()
  gpuWeightTex = device.createTexture({
    size: [gpuTexSize, gpuTexSize], format: 'r32float',
    usage: 0x04 | 0x02 /* TEXTURE_BINDING | COPY_DST */,
  })
  device.queue.writeTexture({ texture: gpuWeightTex }, padded, { bytesPerRow: gpuTexSize * 4 }, [gpuTexSize, gpuTexSize])
  gpuBindGroup = device.createBindGroup({
    layout: gpuPipeline!.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpuUniformBuf! } },
      { binding: 1, resource: gpuWeightTex.createView() },
    ],
  })
  console.log(`[GP] uploadWeightsGPU: ${data.length} floats, texSize=${gpuTexSize}`)
}

function drawGPU(z: number[]): void {
  const device = gpuDevice!
  const el = canvas.value!
  const w = el.width, h = el.height
  // pack uniform buffer
  const ab = new ArrayBuffer(GPU_UNIFORM_BYTES)
  const f = new Float32Array(ab)
  const u32 = new Uint32Array(ab)
  f[0] = w;  f[1] = h
  u32[2] = gpuTexSize
  const au = audioActive.value
  f[3] = au ? audioGrainLevel : (grainEnabled.value && !glassEnabled.value) ? grainLevel.value : 0.0
  f[4] = z[0]!; f[5] = z[1]!; f[6] = z[2]!; f[7] = z[3]!
  f[8] = z[4]!; f[9] = z[5]!; f[10] = z[6]!; f[11] = z[7]!
  u32[12] = colorMode.value === 'palette' ? stops.value.length : 0
  const sf = stopsFlat()
  for (let i = 0; i < MAX_STOPS; i++) { f[16+i*4]=sf[i*3]!; f[17+i*4]=sf[i*3+1]!; f[18+i*4]=sf[i*3+2]! }
  f[64] = au ? audioZoom     : 1.0
  f[65] = au ? audioPanX     : 0.0
  f[66] = au ? audioPanY     : 0.0
  f[67] = au ? audioActBlend : 0.0
  device.queue.writeBuffer(gpuUniformBuf!, 0, ab)
  // render pass
  const enc = device.createCommandEncoder()
  const pass = enc.beginRenderPass({ colorAttachments: [{
    view: gpuContext!.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
  }]})
  pass.setPipeline(gpuPipeline!)
  pass.setBindGroup(0, gpuBindGroup!)
  pass.draw(4)
  pass.end()
  device.queue.submit([enc.finish()])
}

// --- CPU Worker render ---
function renderWithWorker(layers: Layer[], z: number[]): Promise<void> {
  return new Promise(resolve => {
    if (!cpuWorker || !canvas.value) { resolve(); return }
    const w = canvas.value.width
    const h = canvas.value.height
    const stopsRgb = stops.value.map(hex => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255] as [number, number, number]
    })

    cpuWorker.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer }>) => {
      const ctx = canvas.value!.getContext('2d')!
      ctx.putImageData(new ImageData(new Uint8ClampedArray(e.data.buffer), w, h), 0, 0)
      captureBg()
      resolve()
    }

    cpuWorker.postMessage({
      width: w, height: h,
      layers, z,
      activation: networkType.value === 'siren' ? 'wave' : activation.value,
      activation2: networkType.value === 'siren' ? 'wave' : activation2.value,
      dualActivation: networkType.value === 'siren' ? false : dualActivation.value,
      colorMode: colorMode.value,
      stops: stopsRgb,
      grainSeed: Math.random() * 99999,
      grainLevel: grainEnabled.value && !glassEnabled.value ? grainLevel.value : 0,
      glass: glassEnabled.value ? {
        blobs: scaledBlobsArray(),
        nblobs: glassBlobCount.value,
        smooth: glassBlobSmooth.value,
        frost: glassFrost.value,
        grainLevel: grainEnabled.value ? grainLevel.value : 0,
      } : undefined,
    } satisfies import('./render.worker').RenderMsg)
  })
}

// --- Generate ---
async function generate() {
  if (generating.value) return
  stopMorphing()
  morphingEnabled.value = false
  const wasAudioActive = audioActive.value
  if (wasAudioActive && audioAnimId !== null) { cancelAnimationFrame(audioAnimId); audioAnimId = null }
  if (hasGenerated.value && canvas.value) {
    transitionImg.value = canvas.value.toDataURL('image/jpeg', 0.8)
    showTransition.value = true
  }
  generating.value = true
  await nextTick()

  const rng = makeRng()
  if (currentWeights.length) { prevWeights = currentWeights; prevZ = currentZ; hasPrev.value = true }
  const weights = makeNetworkWeights(rng)
  currentZ = makeZ(rng)
  glassBlobs = makeGlassBlobs(rng)
  currentWeights = weights

  try {
    if (gpuDevice) {
      await buildPipelineGPU(weights)
      uploadWeightsGPU(weights)
      drawGPU(currentZ)
      captureBg()
    } else if (gl) {
      await buildProgram(weights)
      uploadWeights(weights)
      draw(currentZ)
      captureBg()
    } else {
      await renderWithWorker(currentWeights, currentZ)
    }
  } catch (e) {
    console.error('[GP] render error:', e)
  }

  generating.value = false
  hasGenerated.value = true
  showTransition.value = false
  if (wasAudioActive) runAudioLoop()
}

// --- Morphing ---
async function startMorphing() {
  animating = true
  const weights = makeNetworkWeights(makeRng())
  if (gpuDevice) {
    await buildPipelineGPU(weights)
    uploadWeightsGPU(weights)
  } else {
    uploadWeights(weights)
    await buildProgram(weights)
  }
  if (!animating) return
  let zA = makeZ(Math.random), zB = makeZ(Math.random), t = 0
  function step() {
    if (!animating) return
    t += 0.004
    if (t >= 1) { t = 0; zA = zB; zB = makeZ(Math.random) }
    if (gpuDevice) drawGPU(lerpZ(zA, zB, smoothstep(t)))
    else draw(lerpZ(zA, zB, smoothstep(t)))
    requestAnimationFrame(step)
  }
  step()
}

function stopMorphing() { animating = false }

// --- Audio ---
async function startAudio() {
  audioError.value = ''
  if (!navigator.mediaDevices) {
    audioError.value = 'Требуется HTTPS или localhost — откройте через localhost:порт'
    return
  }
  try {
    let stream: MediaStream
    if (audioSource.value === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true })
      stream.getTracks().filter(t => t.kind === 'video').forEach(t => t.stop())
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach(t => t.stop())
        audioError.value = 'Нет звука — выбери "Весь экран" и включи чекбокс "Поделиться звуком системы"'
        return
      }
    }
    audioStream = stream
    audioCtx = new AudioContext()
    await audioCtx.resume()
    audioAnalyser = audioCtx.createAnalyser()
    audioAnalyser.fftSize = 256
    audioAnalyser.smoothingTimeConstant = 0.65
    const src = audioCtx.createMediaStreamSource(stream)
    src.connect(audioAnalyser)
    audioZa = Array.from({ length: 8 }, () => randn(Math.random.bind(Math)))
    audioZb = Array.from({ length: 8 }, () => randn(Math.random.bind(Math)))
    audioMorphT = 0
    audioActive.value = true
    runAudioLoop()
  } catch (e) {
    audioError.value = e instanceof Error ? e.message : 'Access denied'
  }
}

function stopAudio() {
  audioActive.value = false
  if (audioAnimId !== null) { cancelAnimationFrame(audioAnimId); audioAnimId = null }
  audioStream?.getTracks().forEach(t => t.stop())
  audioStream = null
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
  audioAnalyser = null
  audioGrainLevel = 0; audioZoom = 1; audioPanX = 0; audioPanY = 0; audioActBlend = 0
  prevBandSub = 0; prevBandMid = 0; prevBandHigh = 0
  kickCooldown = 0; snareCooldown = 0; hatCooldown = 0
  dispKick = 0; dispSnare = 0; dispHat = 0; dispBass = 0; dispMelody = 0
  if (canvas.value) canvas.value.style.filter = ''
}

function runAudioLoop() {
  if (!audioActive.value || !audioAnalyser) return
  const bins = new Uint8Array(audioAnalyser.frequencyBinCount)
  audioAnalyser.getByteFrequencyData(bins)
  const n = bins.length
  const band = (lo: number, hi: number) => {
    let s = 0
    const end = Math.min(hi, n)
    for (let i = lo; i < end; i++) s += bins[i]! / 255
    return s / Math.max(end - lo, 1)
  }

  // Band energies (172Hz/bin at 44.1kHz, 187Hz/bin at 48kHz)
  const subNow  = band(0, 5)   // 0–860Hz:  kick sub, bass guitar
  const midNow  = band(5, 40)  // 860–6880Hz: snare, melody, voice
  const highNow = band(40, n)  // 6880–22kHz: hi-hat, cymbals

  // Frame-to-frame onset: energy that appeared THIS frame
  const subOnset  = Math.max(0, subNow  - prevBandSub)
  const midOnset  = Math.max(0, midNow  - prevBandMid)
  const highOnset = Math.max(0, highNow - prevBandHigh)
  prevBandSub = subNow; prevBandMid = midNow; prevBandHigh = highNow

  if (kickCooldown  > 0) kickCooldown--
  if (snareCooldown > 0) snareCooldown--
  if (hatCooldown   > 0) hatCooldown--

  // Kick: dominant sub onset, sub must outweigh mid and high
  const isKick  = kickCooldown  === 0 && subOnset  > 0.07 && subOnset > midOnset * 1.3 && subOnset > highOnset * 2.0
  // Snare/clap: mid onset, not overshadowed by sub
  const isSnare = snareCooldown === 0 && midOnset  > 0.05 && midOnset > subOnset * 0.8
  // Hi-hat: high onset with no heavy bass beneath
  const isHat   = hatCooldown   === 0 && highOnset > 0.03 && highOnset > midOnset * 0.6 && subNow < 0.25

  if (isKick)  kickCooldown  = 12   // ~200ms at 60fps
  if (isSnare) snareCooldown = 8    // ~130ms
  if (isHat)   hatCooldown   = 4    // ~67ms

  // Decay display values; spike to 1.0 on hit
  dispKick   = isKick  ? 1.0 : Math.max(0, dispKick   - 0.10)
  dispSnare  = isSnare ? 1.0 : Math.max(0, dispSnare  - 0.10)
  dispHat    = isHat   ? 1.0 : Math.max(0, dispHat    - 0.10)
  // Bass and melody: sustained level-based
  dispBass   = subNow > 0.08 ? Math.min(1, dispBass   + 0.06) : Math.max(0, dispBass   - 0.025)
  dispMelody = midNow > 0.06 ? Math.min(1, dispMelody + 0.05) : Math.max(0, dispMelody - 0.025)

  const kickV  = dispKick   * audioBassSens.value
  const snareV = dispSnare  * audioHighSens.value
  const hatV   = dispHat    * audioHighSens.value
  const bassV  = dispBass   * audioBassSens.value
  const melV   = dispMelody * audioMidSens.value

  // Morph: kick accelerates hardest, snare adds a little
  audioMorphT += audioMorphSpeed.value * 0.001 + kickV * 0.08 + snareV * 0.02
  if (audioMorphT >= 1) {
    audioMorphT -= 1
    audioZa = audioZb
    audioZb = Array.from({ length: 8 }, () => randn(Math.random.bind(Math)))
  }
  const morphed = lerpZ(audioZa, audioZb, smoothstep(audioMorphT))

  // Each instrument drives distinct z components
  const push = [
    kickV * 6 - 0.5, kickV * 6 - 0.5,
    melV  * 3 - 0.3, melV  * 3 - 0.3, bassV * 3,
    snareV * 7,       hatV  * 6,        (snareV + hatV) * 4,
  ]
  const z = morphed.map((v, i) => v + push[i]! * 0.5)

  // Shader overrides
  const pt = performance.now() * 0.0003
  audioGrainLevel = (hatV + snareV) * 0.35
  audioZoom       = 1.0 + kickV * 0.28
  audioPanX       = Math.sin(pt * 0.7) * melV * 0.4
  audioPanY       = Math.cos(pt * 0.5) * melV * 0.4
  audioActBlend   = Math.min(snareV * 2.5, 1.0)

  if (gpuDevice) drawGPU(z)
  else if (gl) draw(z)

  // CSS: kick → brightness flash, melody → hue drift
  if (canvas.value) {
    canvas.value.style.filter =
      `brightness(${(1 + kickV * 2.5).toFixed(2)}) hue-rotate(${Math.round(melV * 180)}deg)`
  }

  // Visualizer
  const viz = audioVizCanvas.value
  if (viz) {
    const vctx = viz.getContext('2d')!
    const vw = viz.width, vh = viz.height
    const barVh = 48
    const instH = vh - barVh - 4
    vctx.clearRect(0, 0, vw, vh)

    // Frequency bars (power curve ^1.8 emphasises peaks)
    const numBars = 32
    const binsPerBar = Math.max(1, Math.floor(n / numBars))
    const barW = vw / numBars
    const hex2rgb = (hx: string) => [parseInt(hx.slice(1,3),16), parseInt(hx.slice(3,5),16), parseInt(hx.slice(5,7),16)] as const
    const [r1,g1,b1] = hex2rgb(accentColor.value)
    const [r2,g2,b2] = hex2rgb(accentColor2.value)
    for (let i = 0; i < numBars; i++) {
      let sum = 0
      for (let j = 0; j < binsPerBar; j++) sum += bins[i * binsPerBar + j]! / 255
      const barH = Math.ceil(Math.pow(sum / binsPerBar, 1.8) * barVh)
      const tc = i / (numBars - 1)
      vctx.fillStyle = `rgb(${Math.round(r1!+(r2!-r1!)*tc)},${Math.round(g1!+(g2!-g1!)*tc)},${Math.round(b1!+(b2!-b1!)*tc)})`
      vctx.fillRect(Math.floor(i * barW) + 1, barVh - barH, Math.max(Math.ceil(barW) - 2, 1), barH)
    }

    // Instrument indicators
    const insts: [string, number, string][] = [
      ['KICK',   dispKick,   accentColor.value],
      ['SNARE',  dispSnare,  accentColor2.value],
      ['HAT',    dispHat,    accentColor2.value],
      ['BASS',   dispBass,   accentColor.value],
      ['MELODY', dispMelody, '#cccccc'],
    ]
    const instW = vw / insts.length
    const instY = barVh + 4
    vctx.font = 'bold 7px sans-serif'
    vctx.textAlign = 'center'
    vctx.textBaseline = 'middle'
    for (const [i, [label, val, col]] of insts.entries()) {
      const x = i * instW
      vctx.globalAlpha = 0.12 + val * 0.88
      vctx.fillStyle = col
      vctx.fillRect(x + 1, instY, instW - 2, instH)
      vctx.globalAlpha = 1
      vctx.fillStyle = val > 0.5 ? '#000' : '#fff'
      vctx.fillText(label, x + instW / 2, instY + instH / 2)
    }
    vctx.globalAlpha = 1
  }

  audioAnimId = requestAnimationFrame(runAudioLoop)
}

// --- Download (offscreen 4K render) ---
async function downloadWithGPU() {
  if (!gpuDevice || !gpuPipeline || !gpuWeightTex) return
  downloading.value = true
  const [w, h] = EXPORT[aspectRatio.value]
  const device = gpuDevice

  const offscreen = new OffscreenCanvas(w, h)
  const dlCtx = offscreen.getContext('webgpu') as GPUCanvasContext | null
  if (!dlCtx) { downloading.value = false; return }
  dlCtx.configure({ device, format: gpuCanvasFormat, alphaMode: 'opaque' })

  const dlUniformBuf = device.createBuffer({ size: GPU_UNIFORM_BYTES, usage: 0x40 | 0x08 })
  const ab = new ArrayBuffer(GPU_UNIFORM_BYTES)
  const f32 = new Float32Array(ab); const u32 = new Uint32Array(ab)
  f32[0] = w; f32[1] = h; u32[2] = gpuTexSize
  f32[3] = (grainEnabled.value && !glassEnabled.value) ? grainLevel.value : 0.0
  f32[4] = currentZ[0]!; f32[5] = currentZ[1]!; f32[6] = currentZ[2]!; f32[7] = currentZ[3]!
  f32[8] = currentZ[4]!; f32[9] = currentZ[5]!; f32[10] = currentZ[6]!; f32[11] = currentZ[7]!
  u32[12] = colorMode.value === 'palette' ? stops.value.length : 0
  const sf = stopsFlat()
  for (let i = 0; i < MAX_STOPS; i++) { f32[16+i*4]=sf[i*3]!; f32[17+i*4]=sf[i*3+1]!; f32[18+i*4]=sf[i*3+2]! }
  f32[64] = 1.0; f32[65] = 0.0; f32[66] = 0.0; f32[67] = 0.0 // zoom/pan/actblend — neutral for export
  device.queue.writeBuffer(dlUniformBuf, 0, ab)

  const dlBindGroup = device.createBindGroup({
    layout: gpuPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: dlUniformBuf } },
      { binding: 1, resource: gpuWeightTex.createView() },
    ],
  })

  const enc = device.createCommandEncoder()
  const pass = enc.beginRenderPass({ colorAttachments: [{
    view: dlCtx.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
  }]})
  pass.setPipeline(gpuPipeline)
  pass.setBindGroup(0, dlBindGroup)
  pass.draw(4)
  pass.end()
  device.queue.submit([enc.finish()])
  await device.queue.onSubmittedWorkDone()
  dlUniformBuf.destroy()

  const blob = await offscreen.convertToBlob({ type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}-${Date.now()}.png`
  a.click(); URL.revokeObjectURL(url)
  downloading.value = false
}

function download() {
  if (gpuDevice) { downloadWithGPU(); return }
  if (isWindows) {
    downloading.value = true
    const [w, h] = EXPORT[aspectRatio.value]
    const nWorkers = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))
    const chunkSize = Math.ceil(h / nWorkers)
    const stopsRgb = stops.value.map(hex => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255] as [number, number, number]
    })
    const grainSeed = Math.random() * 99999
    const glassParams = glassEnabled.value ? {
      blobs: scaledBlobsArray(), nblobs: glassBlobCount.value,
      smooth: glassBlobSmooth.value, frost: glassFrost.value,
      grainLevel: grainEnabled.value ? grainLevel.value : 0,
    } : undefined
    const baseMsg = {
      width: w, height: h,
      layers: currentWeights, z: currentZ,
      activation: networkType.value === 'siren' ? 'wave' : activation.value,
      activation2: networkType.value === 'siren' ? 'wave' : activation2.value,
      dualActivation: networkType.value === 'siren' ? false : dualActivation.value,
      colorMode: colorMode.value,
      stops: stopsRgb, grainSeed,
      grainLevel: grainEnabled.value && !glassEnabled.value ? grainLevel.value : 0,
    } satisfies import('./render.worker').RenderMsg

    // Phase 1: parallel scene render across nWorkers strips
    const fullBuf = new Uint8ClampedArray(w * h * 4)
    let done = 0
    const workers: Worker[] = []

    const finalize = () => {
      workers.forEach(wk => wk.terminate())
      if (!glassParams) {
        // No glass — write directly to canvas and download
        const offscreen = document.createElement('canvas')
        offscreen.width = w; offscreen.height = h
        offscreen.getContext('2d')!.putImageData(new ImageData(fullBuf, w, h), 0, 0)
        offscreen.toBlob(blob => {
          const url = URL.createObjectURL(blob!)
          const a = document.createElement('a')
          a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}-${Date.now()}.png`
          a.click(); URL.revokeObjectURL(url)
          downloading.value = false
        })
      } else {
        // Phase 2: glass composite in a single worker (needs full scene buffer)
        const glassWorker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
        const sceneBuf = fullBuf.buffer.slice(0) as ArrayBuffer
        glassWorker.onmessage = (ev: MessageEvent<{ buffer: ArrayBuffer }>) => {
          glassWorker.terminate()
          const offscreen = document.createElement('canvas')
          offscreen.width = w; offscreen.height = h
          offscreen.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(ev.data.buffer), w, h), 0, 0)
          offscreen.toBlob(blob => {
            const url = URL.createObjectURL(blob!)
            const a = document.createElement('a')
            a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}-${Date.now()}.png`
            a.click(); URL.revokeObjectURL(url)
            downloading.value = false
          })
        }
        glassWorker.postMessage(
          { width: w, height: h, rawScene: sceneBuf, grainSeed, glass: glassParams } satisfies import('./render.worker').RenderMsg,
          { transfer: [sceneBuf] }
        )
      }
    }

    for (let i = 0; i < nWorkers; i++) {
      const yStart = i * chunkSize
      const yEnd = Math.min(yStart + chunkSize, h)
      const wk = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
      workers.push(wk)
      wk.onmessage = (ev: MessageEvent<{ buffer: ArrayBuffer, yStart: number }>) => {
        const chunk = new Uint8ClampedArray(ev.data.buffer)
        fullBuf.set(chunk, ev.data.yStart * w * 4)
        if (++done === nWorkers) finalize()
      }
      wk.postMessage({ ...baseMsg, yStart, yEnd } satisfies import('./render.worker').RenderMsg)
    }
    return
  }

  const [w, h] = EXPORT[aspectRatio.value]
  const offscreen = document.createElement('canvas')
  offscreen.width = w; offscreen.height = h
  const g = offscreen.getContext('webgl2', { preserveDrawingBuffer: true })!

  function comp(type: number, src: string) {
    const s = g.createShader(type)!
    g.shaderSource(s, src); g.compileShader(s); return s
  }
  const vsrc = `#version 300 es\nlayout(location=0) in vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`
  const dlVs = comp(g.VERTEX_SHADER, vsrc)

  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), g.STATIC_DRAW)
  g.enableVertexAttribArray(0)
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0)

  const prog = g.createProgram()!
  g.attachShader(prog, dlVs)
  g.attachShader(prog, comp(g.FRAGMENT_SHADER, makeFragSrc(currentWeights)))
  g.linkProgram(prog)

  const data = packWeights(currentWeights)
  const ts = Math.ceil(Math.sqrt(data.length))
  const padded = new Float32Array(ts * ts); padded.set(data)
  const wTex = g.createTexture()
  g.bindTexture(g.TEXTURE_2D, wTex)
  g.texImage2D(g.TEXTURE_2D, 0, g.R32F, ts, ts, 0, g.RED, g.FLOAT, padded)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)

  const savedTs = texSize; texSize = ts

  if (glassEnabled.value) {
    const dlSceneTex = makeFbTex(g, w, h)
    const dlSceneFb = makeFb(g, dlSceneTex)
    const dlBlurTex = makeFbTex(g, w, h)
    const dlBlurFb = makeFb(g, dlBlurTex)

    // Pass 1: scene → dlSceneTex
    g.bindFramebuffer(g.FRAMEBUFFER, dlSceneFb)
    g.viewport(0, 0, w, h)
    g.useProgram(prog)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, wTex)
    setUniforms(g, prog, w, h, currentZ)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)

    const dlBlur2Tex = makeFbTex(g, w, h)
    const dlBlur2Fb = makeFb(g, dlBlur2Tex)
    const bProg = g.createProgram()!
    g.attachShader(bProg, dlVs)
    g.attachShader(bProg, comp(g.FRAGMENT_SHADER, makeBlurSrc()))
    g.linkProgram(bProg)

    // Pass 2: H-blur dlSceneTex → dlBlurTex
    g.bindFramebuffer(g.FRAMEBUFFER, dlBlurFb)
    g.viewport(0, 0, w, h)
    g.useProgram(bProg)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, dlSceneTex)
    setBlurUniforms(g, bProg, w, h, 1, 0)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)

    // Pass 3: V-blur dlBlurTex → dlBlur2Tex
    g.bindFramebuffer(g.FRAMEBUFFER, dlBlur2Fb)
    g.viewport(0, 0, w, h)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, dlBlurTex)
    setBlurUniforms(g, bProg, w, h, 0, 1)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)

    // Pass 4: glass composite → canvas
    const gProg = g.createProgram()!
    g.attachShader(gProg, dlVs)
    g.attachShader(gProg, comp(g.FRAGMENT_SHADER, makeGlassSrc()))
    g.linkProgram(gProg)
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, w, h)
    g.useProgram(gProg)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, dlSceneTex)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, dlBlur2Tex)
    setGlassUniforms(g, gProg, w, h)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  } else {
    g.viewport(0, 0, w, h)
    g.useProgram(prog)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, wTex)
    setUniforms(g, prog, w, h, currentZ)
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  }

  texSize = savedTs

  downloading.value = true
  offscreen.toBlob(blob => {
    const url = URL.createObjectURL(blob!)
    const a = document.createElement('a')
    a.href = url; a.download = `wallpaper-${aspectRatio.value.replace(':', 'x')}-${Date.now()}.png`
    a.click(); URL.revokeObjectURL(url)
    downloading.value = false
  })
}

// --- Restore previous ---
async function restorePrev() {
  if (!hasPrev.value) return
  currentWeights = prevWeights; currentZ = prevZ; hasPrev.value = false
  generating.value = true

  if (gpuDevice) {
    await buildPipelineGPU(currentWeights)
    uploadWeightsGPU(currentWeights)
    drawGPU(currentZ)
    captureBg()
  } else if (gl) {
    await buildProgram(currentWeights)
    uploadWeights(currentWeights)
    draw(currentZ)
    captureBg()
  } else {
    await renderWithWorker(currentWeights, currentZ)
  }

  generating.value = false
}

// --- Add / remove stops ---
function addStop() {
  if (stops.value.length < MAX_STOPS) stops.value.push('#ffffff')
}
function removeStop(i: number) {
  if (stops.value.length > 2) stops.value.splice(i, 1)
}

// --- Extract palette from uploaded image ---
const imageInput = ref<HTMLInputElement | null>(null)

type RGB = [number, number, number]

function kMeans(pixels: RGB[], k: number): RGB[] {
  const step = Math.floor(pixels.length / k)
  let centers: RGB[] = Array.from({ length: k }, (_, i) => {
    const p = pixels[Math.min(i * step, pixels.length - 1)] ?? [0, 0, 0]
    return [p[0], p[1], p[2]]
  })
  for (let iter = 0; iter < 25; iter++) {
    const sums: RGB[] = Array.from({ length: k }, (): RGB => [0, 0, 0])
    const counts: number[] = new Array<number>(k).fill(0)
    for (const p of pixels) {
      let best = 0, bestDist = Infinity
      for (let j = 0; j < k; j++) {
        const c = centers[j] ?? [0, 0, 0]
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bestDist) { bestDist = d; best = j }
      }
      const s = sums[best] ?? [0, 0, 0]
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]
      counts[best] = (counts[best] ?? 0) + 1
    }
    centers = centers.map((c, j): RGB => {
      const n = counts[j] ?? 0
      const s = sums[j] ?? [0, 0, 0]
      return n > 0 ? [s[0] / n, s[1] / n, s[2] / n] : c
    })
  }
  return centers
}

function onImageUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    const size = 120
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, size, size)
    URL.revokeObjectURL(url)
    const raw = ctx.getImageData(0, 0, size, size).data
    const pixels: RGB[] = []
    for (let i = 0; i < raw.length; i += 4) {
      if ((raw[i + 3] ?? 255) < 128) continue
      pixels.push([raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0])
    }
    const k = MAX_STOPS
    const centers = kMeans(pixels, k)
    stops.value = centers.map(([r, g, b]) =>
      '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
    )
    colorMode.value = 'palette'

    // derive accent from the most saturated cluster
    let bestSat = -1, bestR = 0, bestG = 0, bestB = 0
    for (const [r, g, b] of centers) {
      const rn = r / 255, gn = g / 255, bn = b / 255
      const max = Math.max(rn, gn, bn)
      const sat = max === 0 ? 0 : (max - Math.min(rn, gn, bn)) / max
      if (sat > bestSat) { bestSat = sat; bestR = rn; bestG = gn; bestB = bn }
    }
    if (bestSat > 0.1) {
      const [h, s] = rgbToHsl(bestR, bestG, bestB)
      accentColor.value  = withWhiteContrast(h, Math.max(s, 0.65), 0.6)
      accentColor2.value = withWhiteContrast((h + 38) % 360, Math.max(s, 0.65), 0.6)
    }

    ;(e.target as HTMLInputElement).value = ''
  }
  img.src = url
}

watch(colorMode, () => { morphingEnabled.value ? (stopMorphing(), startMorphing()) : generate() })

watch([activation, activation2, dualActivation], async () => {
  if (morphingEnabled.value) { stopMorphing(); startMorphing() }
  else if (hasGenerated.value) {
    generating.value = true
    if (gpuDevice) {
      await buildPipelineGPU(currentWeights)
      uploadWeightsGPU(currentWeights)
      drawGPU(currentZ)
      captureBg()
    } else if (gl) {
      await buildProgram(currentWeights)
      uploadWeights(currentWeights)
      draw(currentZ)
      captureBg()
    } else {
      await renderWithWorker(currentWeights, currentZ)
    }
    generating.value = false
  }
})

watch(layerCount, (n) => {
  if (n > 3) glassEnabled.value = false
  if (morphingEnabled.value) { stopMorphing(); startMorphing() }
  else if (hasGenerated.value) generate()
})

watch(networkType, () => {
  if (morphingEnabled.value) { stopMorphing(); startMorphing() }
  else generate()
})

watch(sirenOmega, () => {
  if (networkType.value === 'siren') generate()
})

watch(morphingEnabled, (on) => (on ? startMorphing() : stopMorphing()))

watch(glassBlobCount, () => {
  glassBlobs = makeGlassBlobs(Math.random)
})

watch([glassEnabled, glassFrost, glassRefraction, glassSize, glassBlobCount, glassBlobSmooth], debounce(async () => {
  if (glassEnabled.value) {
    if (!isWindows && !glassProgram) buildGlassProgram()
    if (glassBlobs[2] === 0) glassBlobs = makeGlassBlobs(Math.random)
  }
  if (animating || !hasGenerated.value) return
  if (gpuDevice) { drawGPU(currentZ); captureBg() }
  else if (gl) { draw(currentZ); captureBg() }
  else { await renderWithWorker(currentWeights, currentZ) }
}, 150))

watch([grainEnabled, grainLevel], debounce(async () => {
  if (animating) return
  if (gpuDevice) { drawGPU(currentZ) }
  else if (gl) { draw(currentZ) }
  else { await renderWithWorker(currentWeights, currentZ) }
}, 150))

watch(aspectRatio, generate, { flush: 'post' })

watch(appMode, async (mode) => {
  if (mode === 'music') {
    if (morphingEnabled.value) { stopMorphing(); morphingEnabled.value = false }
    savedLayerCount = layerCount.value
    if (layerCount.value > 5) layerCount.value = 5
    await generate()
  } else {
    stopAudio()
    if (layerCount.value !== savedLayerCount) layerCount.value = savedLayerCount
    await generate()
  }
})

watch(audioSource, () => {
  if (audioActive.value) { stopAudio(); startAudio() }
})

watch(stops, debounce(async () => {
  if (animating || !hasGenerated.value) return
  if (gpuDevice) { drawGPU(currentZ) }
  else if (gl) { draw(currentZ) }
  else { await renderWithWorker(currentWeights, currentZ) }
}, 150), { deep: true })

const isMobile = ref(typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false)
let mq: MediaQueryList

onMounted(async () => {
  mq = window.matchMedia('(max-width: 767px)')
  isMobile.value = mq.matches
  mq.addEventListener('change', (e) => { isMobile.value = e.matches })

  if (isWindows) {
    cpuWorker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
    const gpuOk = await initGPU()
    if (!gpuOk) initGL()
  } else {
    initGL()
  }
  generate()
})

onUnmounted(() => {
  stopMorphing()
  stopAudio()
  cpuWorker?.terminate()
  if (gpuDevice) {
    gpuUniformBuf?.destroy()
    gpuWeightTex?.destroy()
    gpuDevice.destroy()
  }
  if (gl) {
    if (framebuffer) gl.deleteFramebuffer(framebuffer)
    if (fbTexture) gl.deleteTexture(fbTexture)
    if (fbBlurFb) gl.deleteFramebuffer(fbBlurFb)
    if (fbBlurTex) gl.deleteTexture(fbBlurTex)
    if (fbBlur2Fb) gl.deleteFramebuffer(fbBlur2Fb)
    if (fbBlur2Tex) gl.deleteTexture(fbBlur2Tex)
    if (glassProgram) gl.deleteProgram(glassProgram)
    if (blurProg) gl.deleteProgram(blurProg)
  }
})
</script>

<template>
  <div class="app" :style="{
    '--accent': accentColor,
    '--accent2': accentColor2,
    '--accent-dim': accentColor + '26',
    '--accent-hover': accentColor + 'dd',
  }">
    <div v-if="bgUrl" class="bg-blur" :style="{ backgroundImage: `url(${bgUrl})` }" />
    <main class="canvas-wrap">
      <div class="canvas-container">
        <div class="canvas-frame">
          <canvas ref="canvas" :width="canvasW*2" :height="canvasH*2" class="canvas" />
          <Transition name="cross-fade">
            <img v-if="showTransition" :src="transitionImg" class="canvas canvas-overlay" :key="transitionImg" />
          </Transition>
        </div>
        <div class="canvas-meta">{{ aspectRatio }} · seed {{ seedValue }}</div>
      </div>
    </main>

    <Transition name="backdrop">
      <div v-if="showSettings" class="mobile-backdrop" @click="showSettings = false" />
    </Transition>

    <Transition name="sheet">
      <aside v-if="!isMobile || showSettings" class="sidebar">
      <div class="sheet-handle" @click="showSettings = false">
        <div class="handle-bar" />
      </div>
      <div class="sidebar-header">
        <span class="logo" :style="{ backgroundImage: `linear-gradient(135deg, ${accentColor} 0%, ${accentColor2} 100%)` }">GenPaper</span>
        <div class="segment-control mode-seg">
          <button :class="['seg-btn', appMode === 'visual' && 'active']" @click="appMode = 'visual'">Visual</button>
          <button :class="['seg-btn', appMode === 'music' && 'active']" @click="appMode = 'music'">Music</button>
        </div>
      </div>

      <div v-if="appMode === 'visual'" class="sidebar-body">
        <section class="group">
          <div class="group-title">Shape</div>
          <div class="field">
            <div class="field-label">Style</div>
            <div class="segment-control">
              <button :class="['seg-btn', networkType === 'cppn' && 'active']" @click="networkType = 'cppn'">Organic</button>
              <button :class="['seg-btn', networkType === 'siren' && 'active']" @click="networkType = 'siren'">Fluid</button>
            </div>
          </div>
          <template v-if="networkType === 'cppn'">
          <div class="field">
            <div class="field-label">
              Style
              <button class="act-add-btn" @click="dualActivation = !dualActivation" :title="dualActivation ? 'Remove blend' : 'Add blend'">{{ dualActivation ? '−' : '+' }}</button>
            </div>
            <select v-model="activation" class="select">
              <option value="smooth">smooth</option>
              <option value="wave">wave</option>
              <option value="drift">drift</option>
              <option value="soft">soft</option>
              <option value="ring">ring</option>
              <option value="glow">glow</option>
              <option value="bend">bend</option>
              <option value="bell">bell</option>
              <option value="slope">slope</option>
            </select>
          </div>
          <Transition name="fade">
            <div v-if="dualActivation" class="field">
              <div class="field-label">Blend</div>
              <select v-model="activation2" class="select">
                <option value="smooth">smooth</option>
                <option value="wave">wave</option>
                <option value="drift">drift</option>
                <option value="soft">soft</option>
                <option value="ring">ring</option>
                <option value="glow">glow</option>
                <option value="bend">bend</option>
                <option value="bell">bell</option>
                <option value="slope">slope</option>
                </select>
            </div>
          </Transition>
          </template>
          <Transition name="fade">
            <div v-if="networkType === 'siren'" class="field">
              <div class="field-label">Frequency <span class="field-value">{{ sirenOmega }}</span></div>
              <input type="range" v-model.number="sirenOmega" min="5" max="80" step="1" class="slider" />
            </div>
          </Transition>
          <div class="field">
            <div class="field-label">Depth <span class="field-value">{{ layerCount }}</span></div>
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
          <div v-if="colorMode === 'palette'" class="palette-wrap">
            <button class="upload-img-btn" @click="imageInput?.click()">Upload image</button>
            <input ref="imageInput" type="file" accept="image/*" style="display:none" @change="onImageUpload" />
            <div class="stop-row">
              <div v-for="(_, i) in stops" :key="i" class="stop">
                <input type="color" v-model="stops[i]" class="color-swatch" />
                <button class="stop-remove" @click="removeStop(i)" :disabled="stops.length <= 2">×</button>
              </div>
              <button class="stop-add" @click="addStop" :disabled="stops.length >= MAX_STOPS">+</button>
            </div>
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
          <div v-if="!isWindows || gpuReady" class="field row">
            <div class="field-label">Morph</div>
            <div class="toggle-wrap">
              <input type="checkbox" v-model="morphingEnabled" id="morph-toggle" class="toggle-input" />
              <label for="morph-toggle" class="toggle"></label>
            </div>
          </div>
          <div v-if="layerCount <= 3" class="field row">
            <div class="field-label">Glass</div>
            <div class="toggle-wrap">
              <input type="checkbox" v-model="glassEnabled" id="glass-toggle" class="toggle-input" />
              <label for="glass-toggle" class="toggle"></label>
            </div>
          </div>
          <Transition name="fade">
            <div v-if="glassEnabled && layerCount <= 3">
              <div class="field">
                <div class="field-label">Frost <span class="field-value">{{ glassFrost.toFixed(2) }}</span></div>
                <input type="range" v-model.number="glassFrost" min="0" max="1" step="0.01" class="slider" />
              </div>
              <div class="field">
                <div class="field-label">Size <span class="field-value">{{ glassSize.toFixed(2) }}</span></div>
                <input type="range" v-model.number="glassSize" min="0.1" max="2.0" step="0.01" class="slider" />
              </div>
              <div class="field">
                <div class="field-label">Count <span class="field-value">{{ glassBlobCount }}</span></div>
                <input type="range" v-model.number="glassBlobCount" min="1" max="12" step="1" class="slider" />
              </div>
              <div class="field">
                <div class="field-label">Smooth <span class="field-value">{{ glassBlobSmooth.toFixed(2) }}</span></div>
                <input type="range" v-model.number="glassBlobSmooth" min="0.02" max="0.6" step="0.01" class="slider" />
              </div>
            </div>
          </Transition>
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

      <div v-else class="sidebar-body">
        <section class="group">
          <div class="group-title">Color</div>
          <div class="segment-control">
            <button :class="['seg-btn', colorMode === 'rgb' && 'active']" @click="colorMode = 'rgb'">RGB</button>
            <button :class="['seg-btn', colorMode === 'bw' && 'active']" @click="colorMode = 'bw'">B&amp;W</button>
            <button :class="['seg-btn', colorMode === 'palette' && 'active']" @click="colorMode = 'palette'">Palette</button>
          </div>
          <div class="field" style="margin-top:14px">
            <div class="field-label">Depth <span class="field-value">{{ layerCount }}</span></div>
            <input type="range" v-model.number="layerCount" min="1" max="5" class="slider" />
          </div>
        </section>
        <section class="group">
          <div class="group-title">Audio</div>
          <div class="segment-control">
            <button :class="['seg-btn', audioSource === 'mic' && 'active']" @click="audioSource = 'mic'">Mic</button>
            <button :class="['seg-btn', audioSource === 'system' && 'active']" @click="audioSource = 'system'">System</button>
          </div>
          <p v-if="audioSource === 'system'" class="audio-hint">Windows + Chrome only — check "Share system audio" in the picker</p>
          <div class="field row" style="margin-top:14px">
            <div class="field-label">Listen</div>
            <div class="toggle-wrap">
              <input type="checkbox" :checked="audioActive" @change="audioActive ? stopAudio() : startAudio()" id="audio-toggle" class="toggle-input" />
              <label for="audio-toggle" class="toggle"></label>
            </div>
          </div>
          <div v-if="audioError" class="audio-error">{{ audioError }}</div>
          <div v-if="audioActive" class="audio-status">● Listening</div>
          <canvas v-if="audioActive" ref="audioVizCanvas" class="audio-viz" width="200" height="80" />
          <template v-if="audioActive">
            <div class="field" style="margin-top:14px">
              <div class="field-label">Sub <span class="field-value">{{ audioBassSens.toFixed(1) }}</span></div>
              <input type="range" v-model.number="audioBassSens" min="0" max="3" step="0.1" class="slider" />
            </div>
            <div class="field">
              <div class="field-label">Melody <span class="field-value">{{ audioMidSens.toFixed(1) }}</span></div>
              <input type="range" v-model.number="audioMidSens" min="0" max="3" step="0.1" class="slider" />
            </div>
            <div class="field">
              <div class="field-label">Perc <span class="field-value">{{ audioHighSens.toFixed(1) }}</span></div>
              <input type="range" v-model.number="audioHighSens" min="0" max="3" step="0.1" class="slider" />
            </div>
            <div class="field">
              <div class="field-label">Speed <span class="field-value">{{ audioMorphSpeed }}</span></div>
              <input type="range" v-model.number="audioMorphSpeed" min="1" max="10" step="1" class="slider" />
            </div>
          </template>
        </section>
      </div>

      <div class="actions">
        <div class="actions-row">
          <button v-if="appMode === 'visual'" class="btn-secondary" @click="restorePrev" :disabled="!hasPrev || morphingEnabled">↩ Back</button>
          <button class="btn-secondary" @click="download" :disabled="!hasGenerated || downloading">
            <span v-if="downloading" class="spinner"></span>
            {{ downloading ? 'Preparing…' : '↓ Download' }}
          </button>
        </div>
        <button class="btn-generate" @click="generate" :disabled="generating || (appMode === 'visual' && morphingEnabled) || downloading">
          <span v-if="generating" class="spinner"></span>
          {{ generating ? 'Generating…' : appMode === 'music' ? 'New Pattern' : 'Generate' }}
        </button>
      </div>
      <button class="btn-close-sheet" @click="showSettings = false">Close</button>
    </aside>
    </Transition>

    <div class="mobile-bar">
      <button class="mbar-btn" @click="restorePrev" :disabled="!hasPrev || morphingEnabled">↩</button>
      <button class="mbar-generate" @click="generate" :disabled="generating || morphingEnabled || downloading">
        <span v-if="generating" class="spinner"></span>
        {{ generating ? '…' : 'Generate' }}
      </button>
      <button class="mbar-btn" @click="download" :disabled="!hasGenerated || downloading">
        <span v-if="downloading" class="spinner"></span>
        <span v-else>↓</span>
      </button>
      <button class="mbar-btn mbar-settings" @click="showSettings = !showSettings" :class="{ active: showSettings }">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.app {
  --bg: #0a0a0f;
  --surface: #111118;
  --surface2: #1a1a24a3;
  --border: #2a2a3899;
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
  font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
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

.canvas-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: 50%;
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

.canvas-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  letter-spacing: 0.03em;
  user-select: none;
}

.canvas-frame {
  position: relative;
  line-height: 0;
  overflow: hidden;
  border-radius: var(--radius);
}

.canvas-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  box-shadow: none;
}

.cross-fade-leave-active {
  transition: opacity 0.45s ease, filter 0.45s ease;
}
.cross-fade-leave-to {
  opacity: 0;
  filter: blur(12px);
}

/* ── Sidebar ── */
.sidebar {
  width: var(--sidebar);
  flex-shrink: 0;
  background: rgba(17, 17, 24, 0.6);
  backdrop-filter: blur(40px) saturate(1.6);
  -webkit-backdrop-filter: blur(40px) saturate(1.6);
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
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  transition: background-image 0.6s ease;
}

.mode-seg { margin-top: 10px; }

.audio-hint {
  margin-top: 10px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}

.audio-error {
  margin-top: 10px;
  font-size: 12px;
  color: #f87171;
  line-height: 1.4;
}

.audio-status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}

.audio-viz {
  display: block;
  width: 100%;
  height: 80px;
  margin-top: 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
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

.act-add-btn {
  margin-left: auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.15s;
}

.act-add-btn:hover { border-color: var(--accent); color: var(--accent); }

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
  gap: 12px;
  flex-wrap: wrap;
}

.stop { position: relative; }

.color-swatch {
  display: block;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  background: none;
}

.stop-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
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
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s;
}

.palette-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.upload-img-btn {
  width: 100%;
  height: 38px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.15s;
}
.upload-img-btn:hover { border-color: var(--accent); color: var(--accent); }

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
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
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

/* ── Accent transitions ── */
.btn-generate,
.seg-btn.active,
.toggle-input:checked + .toggle,
.ratio-btn.active,
.slider::-webkit-slider-thumb { transition: background 0.5s ease, border-color 0.5s ease; }

/* ── Fade transition ── */
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── Mobile bar (hidden on desktop) ── */
.mobile-bar { display: none; }

.mobile-backdrop { display: none; }

.sheet-handle { display: none; }

.btn-close-sheet { display: none; }

/* ── Mobile ── */
@media (max-width: 767px) {
  .app {
    flex-direction: column;
    padding-bottom: 72px;
  }

  .canvas-wrap {
    padding: 16px 16px 12px;
    flex: none;
  }

  .canvas { max-height: 150vw; }

  /* Sidebar becomes a bottom sheet */
  .sidebar {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100vh;
    border-left: none;
    border-top: none;
    border-radius: 0;
    z-index: 100;
    overflow: hidden;
  }

  .sheet-enter-active,
  .sheet-leave-active {
    transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
  }

  .sheet-enter-from,
  .sheet-leave-to {
    transform: translateY(100%);
  }

  .sheet-handle { display: none; }

  .sidebar-header { padding: 10px 16px 12px; }

  .sidebar-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    flex: 1;
  }

  .group { padding: 14px 16px; }

  .actions { display: none; }

  .btn-close-sheet {
    display: block;
    width: calc(100% - 32px);
    margin: 0 16px 64px;
    padding: 14px;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius-sm);
    font-size: 15px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
  }

  .color-swatch { width: 48px; height: 48px; }

  .stop-add { width: 48px; height: 48px; font-size: 22px; }

  .stop-remove { width: 22px; height: 22px; font-size: 13px; top: -7px; right: -7px; }

  /* Backdrop */
  .mobile-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 99;
  }

  .backdrop-enter-active, .backdrop-leave-active { transition: opacity 0.25s; }
  .backdrop-enter-from, .backdrop-leave-to { opacity: 0; }

  /* Mobile action bar */
  .mobile-bar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 64px;
    background: rgb(0 0 0 / 25%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 12px;
    margin: 8px;
    padding: 10px 12px;
    gap: 8px;
    align-items: center;
    z-index: 98;
  }

  .mbar-btn {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--radius-sm);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .mbar-btn:disabled { opacity: 0.3; cursor: default; }
  .mbar-btn:not(:disabled):active { opacity: 0.7; }

  .mbar-settings.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .mbar-generate {
    flex: 1;
    height: 44px;
    background: var(--accent);
    border: none;
    color: #fff;
    border-radius: var(--radius-sm);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    transition: background 0.15s;
    font-family: inherit;
  }

  .mbar-generate:disabled { opacity: 0.45; cursor: default; }
  .mbar-generate:not(:disabled):active { opacity: 0.8; }
}

@media (max-width: 400px) {
  .canvas { max-height: 70vw; }
}
</style>
