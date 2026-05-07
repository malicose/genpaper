export interface Layer { w: number[][]; b: number[] }

export type RenderMsg = {
  width: number
  height: number
  layers: Layer[]
  z: number[]
  activation: string
  activation2: string
  dualActivation: boolean
  colorMode: 'rgb' | 'bw' | 'palette'
  stops: [number, number, number][]
  grainSeed: number
  grainLevel: number
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

self.onmessage = (e: MessageEvent<RenderMsg>) => {
  const { width, height, layers, z, activation, activation2,
          dualActivation, colorMode, stops, grainSeed, grainLevel } = e.data

  const act1 = ACT_FNS[activation] ?? ACT_FNS['smooth']!
  const act2 = ACT_FNS[activation2] ?? ACT_FNS['wave']!
  const asp = width / height
  const buf = new Uint8ClampedArray(width * height * 4)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = (px / width * 2 - 1) * asp
      const y = (1 - py / height) * 2 - 1
      const r = Math.sqrt(x * x + y * y)
      const inp = [x, y, r, ...z]

      const out = forward(inp, layers, act1, act2, dualActivation)

      let R: number, G: number, B: number
      if (colorMode === 'rgb') {
        R = out[0]!; G = out[1]!; B = out[2]!
      } else if (colorMode === 'bw') {
        R = G = B = out[0]!
      } else {
        ;[R, G, B] = paletteLookup(out[0]!, stops)
      }

      const nx = Math.sin(px * 12.9898 + grainSeed + py * 78.233) * 43758.5453
      const g = (nx - Math.floor(nx) - 0.5) * grainLevel

      const idx = (py * width + px) * 4
      buf[idx]     = Math.min(255, Math.max(0, (R! + g) * 255))
      buf[idx + 1] = Math.min(255, Math.max(0, (G! + g) * 255))
      buf[idx + 2] = Math.min(255, Math.max(0, (B! + g) * 255))
      buf[idx + 3] = 255
    }
  }

  self.postMessage({ buffer: buf.buffer }, { transfer: [buf.buffer] })
}
