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
const seedValue = ref(42)
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

const DISPLAY = { '1:1': [512, 512], '16:9': [512, 288], '9:16': [288, 512] } as const
const EXPORT  = { '1:1': [3840, 3840], '16:9': [3840, 2160], '9:16': [2160, 3840] } as const
const canvasW = computed(() => DISPLAY[aspectRatio.value][0])
const canvasH = computed(() => DISPLAY[aspectRatio.value][1])

const MAX_STOPS = 6

// --- Runtime state ---
const canvas = ref<HTMLCanvasElement | null>(null)
const generating = ref(false)
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
let animating = false
let currentZ: number[] = []
let currentWeights: Layer[] = []
let prevWeights: Layer[] = []
let prevZ: number[] = []
const hasPrev = ref(false)
let glassBlobs: Float32Array = new Float32Array(36)

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
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
  return seedEnabled.value ? mulberry32(seedValue.value) : Math.random
}
function randn(rng: Rng): number {
  const u = 1 - rng(), v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- Network ---
const INPUT_SIZE = 11 // x,y,r + z×8

function makeWeights(rng: Rng): Layer[] {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [INPUT_SIZE, ...Array(layerCount.value).fill(32), outSize]
  return sizes.slice(1).map((o: number, i: number) => ({
    w: Array.from({ length: o }, () => Array.from({ length: sizes[i] as number }, () => randn(rng))),
    b: Array.from({ length: o }, () => randn(rng)),
  }))
}

function makeSirenWeights(rng: Rng): Layer[] {
  const outSize = colorMode.value === 'rgb' ? 3 : 1
  const sizes = [INPUT_SIZE, ...Array(layerCount.value).fill(32), outSize]
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
    const fn   = l === N - 1 ? 'sig' : (effDual && l % 2 !== 0 ? 'act2' : 'act1')
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
float act1(float x){${actCode1}}
float act2(float x){${actCode2}}
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
  const g = canvas.value!.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!g) { alert('WebGL 2 not supported in this browser'); return }
  gl = g
  vs = compileShader(g.VERTEX_SHADER,
    `#version 300 es\nlayout(location=0) in vec2 p;\nvoid main(){gl_Position=vec4(p,0,1);}`)
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
  g.uniform1f(g.getUniformLocation(prog, 'u_grain'), (grainEnabled.value && !glassEnabled.value) ? grainLevel.value : 0.0)
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
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  }
}

function captureBg() {
  bgUrl.value = canvas.value!.toDataURL('image/jpeg', 0.6)
  extractAccent()
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
  generating.value = true
  await nextTick()

  const rng = makeRng()
  if (currentWeights.length) { prevWeights = currentWeights; prevZ = currentZ; hasPrev.value = true }
  const weights = makeNetworkWeights(rng)
  currentZ = makeZ(rng)
  glassBlobs = makeGlassBlobs(rng)
  currentWeights = weights

  if (isWindows) {
    await renderWithWorker(currentWeights, currentZ)
  } else {
    buildProgram(weights)
    uploadWeights(weights)
    draw(currentZ)
    captureBg()
  }

  generating.value = false
  hasGenerated.value = true
}

// --- Morphing ---
function startMorphing() {
  animating = true
  const weights = makeNetworkWeights(makeRng())
  uploadWeights(weights)
  buildProgram(weights)
  let zA = makeZ(Math.random), zB = makeZ(Math.random), t = 0
  function step() {
    if (!animating) return
    t += 0.004
    if (t >= 1) { t = 0; zA = zB; zB = makeZ(Math.random) }
    draw(lerpZ(zA, zB, smoothstep(t)))
    requestAnimationFrame(step)
  }
  step()
}

function stopMorphing() { animating = false }

// --- Download (offscreen 4K render) ---
function download() {
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

  if (isWindows) {
    await renderWithWorker(currentWeights, currentZ)
  } else {
    buildProgram(currentWeights)
    uploadWeights(currentWeights)
    draw(currentZ)
    captureBg()
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

watch(colorMode, () => { morphingEnabled.value ? (stopMorphing(), startMorphing()) : generate() })

watch([activation, activation2, dualActivation], async () => {
  if (morphingEnabled.value) { stopMorphing(); startMorphing() }
  else if (hasGenerated.value) {
    generating.value = true
    if (isWindows) {
      await renderWithWorker(currentWeights, currentZ)
    } else {
      buildProgram(currentWeights)
      uploadWeights(currentWeights)
      draw(currentZ)
      captureBg()
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

watch([glassEnabled, glassFrost, glassRefraction, glassSize, glassBlobCount, glassBlobSmooth], async () => {
  if (glassEnabled.value) {
    if (!isWindows && !glassProgram) buildGlassProgram()
    if (glassBlobs[2] === 0) glassBlobs = makeGlassBlobs(Math.random)
  }
  if (animating || !hasGenerated.value) return
  if (isWindows) {
    await renderWithWorker(currentWeights, currentZ)
  } else {
    draw(currentZ)
    captureBg()
  }
})

watch([grainEnabled, grainLevel], async () => {
  if (animating) return
  if (isWindows) {
    await renderWithWorker(currentWeights, currentZ)
  } else {
    draw(currentZ)
  }
})

watch(aspectRatio, generate, { flush: 'post' })

watch(stops, async () => {
  if (animating || !hasGenerated.value) return
  if (isWindows) {
    await renderWithWorker(currentWeights, currentZ)
  } else {
    draw(currentZ)
  }
}, { deep: true })

const isMobile = ref(typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false)
let mq: MediaQueryList

onMounted(() => {
  mq = window.matchMedia('(max-width: 767px)')
  isMobile.value = mq.matches
  mq.addEventListener('change', (e) => { isMobile.value = e.matches })

  if (isWindows) {
    cpuWorker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
  } else {
    initGL()
  }
  generate()
})

onUnmounted(() => {
  stopMorphing()
  cpuWorker?.terminate()
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
      <canvas ref="canvas" :width="canvasW" :height="canvasH" class="canvas" />
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
      </div>

      <div class="sidebar-body">
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
          <div v-if="!isWindows" class="field row">
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

      <div class="actions">
        <div class="actions-row">
          <button class="btn-secondary" @click="restorePrev" :disabled="!hasPrev || morphingEnabled">↩ Back</button>
          <button class="btn-secondary" @click="download" :disabled="!hasGenerated || downloading">
            <span v-if="downloading" class="spinner"></span>
            {{ downloading ? 'Preparing…' : '↓ Download' }}
          </button>
        </div>
        <button class="btn-generate" @click="generate" :disabled="generating || morphingEnabled || downloading">
          <span v-if="generating" class="spinner"></span>
          {{ generating ? 'Generating…' : 'Generate' }}
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
  margin-top: 10px;
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

  .canvas { max-height: 100vw; }

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
