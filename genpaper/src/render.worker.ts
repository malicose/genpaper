export interface Layer { w: number[][]; b: number[] }

export type RenderMsg = {
  width: number
  height: number
  // Partial render: only process rows [yStart, yEnd)
  yStart?: number
  yEnd?: number
  // Glass-composite-only mode: skip network, apply glass to pre-rendered scene
  rawScene?: ArrayBuffer
  layers?: Layer[]
  z?: number[]
  activation?: string
  activation2?: string
  dualActivation?: boolean
  colorMode?: 'rgb' | 'bw' | 'palette'
  stops?: [number, number, number][]
  grainSeed?: number
  grainLevel?: number
  glass?: {
    blobs: number[]
    nblobs: number
    smooth: number
    frost: number
    grainLevel: number
  }
}

const ACT_FNS: Record<string, (x: number) => number> = {
  smooth: x => Math.tanh(x),
  wave:   x => Math.sin(x),
  drift:  x => Math.cos(x),
  soft:   x => x > 20 ? x : Math.log(1 + Math.exp(x)),
  ring:   x => x === 0 ? 1 : Math.sin(x) / x,
  glow:   x => Math.exp(-x * x),
  bend:   x => x / (1 + Math.exp(-x)),
  bell:   x => 2 / (Math.exp(x) + Math.exp(-x)),
  slope:  x => Math.atan(x),
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

function forward(
  inp: number[],
  layers: Layer[],
  act1: (x: number) => number,
  act2: (x: number) => number,
  dual: boolean
): number[] {
  let h = inp
  for (let l = 0; l < layers.length; l++) {
    const { w, b } = layers[l]!
    const isLast = l === layers.length - 1
    const fn = isLast ? sigmoid : (dual && l % 2 !== 0 ? act2 : act1)
    const next: number[] = []
    for (let o = 0; o < b.length; o++) {
      let s = b[o]!
      for (let i = 0; i < h.length; i++) s += w[o]![i]! * h[i]!
      next.push(fn(s))
    }
    h = next
  }
  return h
}

function paletteLookup(
  t: number,
  stops: [number, number, number][]
): [number, number, number] {
  const n = stops.length
  for (let i = 0; i < n - 1; i++) {
    const t0 = i / (n - 1), t1 = (i + 1) / (n - 1)
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0)
      return [
        stops[i]![0]! + (stops[i + 1]![0]! - stops[i]![0]!) * f,
        stops[i]![1]! + (stops[i + 1]![1]! - stops[i]![1]!) * f,
        stops[i]![2]! + (stops[i + 1]![2]! - stops[i]![2]!) * f,
      ]
    }
  }
  return stops[n - 1]!
}

// --- Glass helpers ---

function sminFn(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k))
  return b * (1 - h) + a * h - k * h * (1 - h)
}

function blobField(px: number, py: number, blobs: number[], nblobs: number, smooth: number): number {
  let d = 1e9
  for (let i = 0; i < nblobs; i++) {
    const bx = blobs[i * 3]!, by = blobs[i * 3 + 1]!, br = blobs[i * 3 + 2]!
    const di = Math.sqrt((px - bx) ** 2 + (py - by) ** 2) - br
    d = sminFn(d, di, smooth)
  }
  return d
}

function smoothstepFn(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

const BLUR_OFFSETS = [0, 1.408, -1.408, 3.294, -3.294, 5.0, -5.0]
const BLUR_WEIGHTS = [0.2006, 0.2987, 0.2987, 0.0922, 0.0922, 0.0088, 0.0088]

// H-blur directly from RGBA Uint8ClampedArray (stride 4) → Float32Array RGB (stride 3)
function blurH(src: Uint8ClampedArray, width: number, height: number, step: number): Float32Array {
  const dst = new Float32Array(width * height * 3)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < 7; k++) {
        const sx = Math.max(0, Math.min(width - 1, Math.round(px + BLUR_OFFSETS[k]! * step)))
        const si = (py * width + sx) * 4
        const wk = BLUR_WEIGHTS[k]!
        r += src[si]!     / 255 * wk
        g += src[si + 1]! / 255 * wk
        b += src[si + 2]! / 255 * wk
      }
      const di = (py * width + px) * 3
      dst[di] = r; dst[di + 1] = g; dst[di + 2] = b
    }
  }
  return dst
}

// V-blur from Float32Array RGB (stride 3) → Float32Array RGB (stride 3)
function blurV(src: Float32Array, width: number, height: number, step: number): Float32Array {
  const dst = new Float32Array(width * height * 3)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < 7; k++) {
        const sy = Math.max(0, Math.min(height - 1, Math.round(py + BLUR_OFFSETS[k]! * step)))
        const si = (sy * width + px) * 3
        const wk = BLUR_WEIGHTS[k]!
        r += src[si]!     * wk
        g += src[si + 1]! * wk
        b += src[si + 2]! * wk
      }
      const di = (py * width + px) * 3
      dst[di] = r; dst[di + 1] = g; dst[di + 2] = b
    }
  }
  return dst
}

self.onmessage = (e: MessageEvent<RenderMsg>) => {
  const { width, height, rawScene, layers, z, activation, activation2,
          dualActivation, colorMode, stops, grainSeed = 0, grainLevel = 0, glass } = e.data
  const yStart = e.data.yStart ?? 0
  const yEnd   = e.data.yEnd   ?? height

  const asp = width / height

  // Glass-composite-only mode: receive full scene, apply blur + composite
  if (rawScene) {
    const buf = new Uint8ClampedArray(rawScene)
    applyGlass(buf, width, height, asp, glass!, grainSeed)
    self.postMessage({ buffer: buf.buffer }, { transfer: [buf.buffer] })
    return
  }

  const act1 = ACT_FNS[activation ?? 'smooth'] ?? ACT_FNS['smooth']!
  const act2 = ACT_FNS[activation2 ?? 'wave']  ?? ACT_FNS['wave']!

  // Partial render: allocate only the rows we own
  const rowCount = yEnd - yStart
  const buf = new Uint8ClampedArray(rowCount * width * 4)

  for (let py = yStart; py < yEnd; py++) {
    const localY = py - yStart
    for (let px = 0; px < width; px++) {
      const x = (px / width * 2 - 1) * asp
      const y = (1 - py / height) * 2 - 1
      const r = Math.sqrt(x * x + y * y)
      const inp = [x, y, r, ...(z ?? [])]

      const out = forward(inp, layers!, act1, act2, dualActivation ?? false)

      let R: number, G: number, B: number
      if (colorMode === 'rgb') {
        R = out[0]!; G = out[1]!; B = out[2]!
      } else if (colorMode === 'bw') {
        R = G = B = out[0]!
      } else {
        ;[R, G, B] = paletteLookup(out[0]!, stops ?? [])
      }

      const nx = Math.sin(px * 12.9898 + grainSeed + py * 78.233) * 43758.5453
      const g = (nx - Math.floor(nx) - 0.5) * grainLevel

      const idx = (localY * width + px) * 4
      buf[idx]     = Math.min(255, Math.max(0, (R! + g) * 255))
      buf[idx + 1] = Math.min(255, Math.max(0, (G! + g) * 255))
      buf[idx + 2] = Math.min(255, Math.max(0, (B! + g) * 255))
      buf[idx + 3] = 255
    }
  }

  // Full render (preview): apply glass composite inline
  if (glass && yStart === 0 && yEnd === height) {
    applyGlass(buf, width, height, asp, glass, grainSeed)
  }

  self.postMessage({ buffer: buf.buffer, yStart }, { transfer: [buf.buffer] })
}

function applyGlass(
  buf: Uint8ClampedArray, width: number, height: number, asp: number,
  glass: NonNullable<RenderMsg['glass']>, grainSeed: number
): void {
  const { blobs, nblobs, smooth, frost, grainLevel: glassGrain } = glass
  const step = frost * Math.min(width, height) * 0.04
  const blurred = blurV(blurH(buf, width, height, step), width, height, step)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const ndcx = ((px + 0.5) / width  - 0.5) * 2 * asp
      const ndcy = (1 - (py + 0.5) / height - 0.5) * 2

      const d = blobField(ndcx, ndcy, blobs, nblobs, smooth)
      const idx = (py * width + px) * 4

      const nx2 = Math.sin(px * 12.9898 + grainSeed + py * 78.233) * 43758.5453
      const gn = (nx2 - Math.floor(nx2) - 0.5) * glassGrain

      if (d > 0.04) {
        buf[idx]     = Math.min(255, Math.max(0, buf[idx]!     + gn * 255))
        buf[idx + 1] = Math.min(255, Math.max(0, buf[idx + 1]! + gn * 255))
        buf[idx + 2] = Math.min(255, Math.max(0, buf[idx + 2]! + gn * 255))
        continue
      }

      const inside = smoothstepFn(0.003, -0.001, d)
      const bi = (py * width + px) * 3
      const base = 0.025 * (1 - frost * 0.6)
      let gR = blurred[bi]!     * 1.01 + base
      let gG = blurred[bi + 1]! * 1.02 + base
      let gB = blurred[bi + 2]! * 1.06 + base

      if (d < 0.012) {
        const eps = 0.005
        const ddx = blobField(ndcx + eps, ndcy, blobs, nblobs, smooth) - blobField(ndcx - eps, ndcy, blobs, nblobs, smooth)
        const ddy = blobField(ndcx, ndcy + eps, blobs, nblobs, smooth) - blobField(ndcx, ndcy - eps, blobs, nblobs, smooth)
        const nlen = Math.sqrt(ddx * ddx + ddy * ddy) + 1e-6
        const nrmX = ddx / nlen, nrmY = ddy / nlen
        const ndX = nrmX / asp, ndY = nrmY
        const ndLen = Math.sqrt(ndX * ndX + ndY * ndY) + 1e-6
        const nrmDirX = ndX / ndLen, nrmDirY = ndY / ndLen
        const lx = 1 / Math.SQRT2, ly = 1 / Math.SQRT2
        const rimDir    = Math.max(0, -nrmDirX * lx - nrmDirY * ly)
        const shadowDir = Math.max(0,  nrmDirX * lx + nrmDirY * ly)
        const rimBand = smoothstepFn(0.010, 0.002, d) - smoothstepFn(0.002, -0.006, d)
        const rimAdd = rimBand * (0.04 + rimDir * 0.38)
        const rimSub = rimBand * shadowDir * 0.1
        gR += rimAdd - rimSub
        gG += rimAdd - rimSub
        gB += rimAdd - rimSub
      }

      const sR = buf[idx]!     / 255
      const sG = buf[idx + 1]! / 255
      const sB = buf[idx + 2]! / 255
      buf[idx]     = Math.min(255, Math.max(0, (sR * (1 - inside) + gR * inside + gn) * 255))
      buf[idx + 1] = Math.min(255, Math.max(0, (sG * (1 - inside) + gG * inside + gn) * 255))
      buf[idx + 2] = Math.min(255, Math.max(0, (sB * (1 - inside) + gB * inside + gn) * 255))
    }
  }
}
