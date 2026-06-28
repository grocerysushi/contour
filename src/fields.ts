import { Simplex, mulberry32 } from './noise'

// A field sampler: maps normalized coords in [-1,1] to a scalar.
export type Sampler = (nx: number, ny: number) => number

export interface Plate {
  name: string
  blurb: string
  build: (seed: number, scale: number) => Sampler
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

// Per-plate deterministic sources. Feature points and noise are seeded from
// the same master seed but offset differently per plate so the seven plates
// stay distinct under one seed.
function sources(seed: number, idx: number) {
  const rng = mulberry32((seed ^ (idx * 131 + 17)) >>> 0)
  const noise = new Simplex((seed + idx * 101) >>> 0)
  const S = (x: number, y: number) => noise.noise2D(x, y)
  // offset vector landing in a distinct region of noise space
  const off = () => [rng() * 220 - 110, rng() * 220 - 110] as [number, number]
  return { rng, S, off }
}

const TAU = Math.PI * 2

export const PLATES: Plate[] = [
  {
    name: 'Eroded Disc',
    blurb: 'A signed-distance circle chewed by two octaves of simplex noise.',
    build(seed, f) {
      const { S, off } = sources(seed, 0)
      const [ox, oy] = off()
      return (nx, ny) => {
        const len = Math.hypot(nx, ny)
        return (
          len -
          0.52 +
          0.3 * S(nx * 1.7 * f + ox, ny * 1.7 * f + oy) +
          0.1 * S(nx * 3.4 * f + ox, ny * 3.4 * f + oy)
        )
      }
    },
  },
  {
    name: 'Domain Warp',
    blurb: 'Simplex noise pushed through two stages of self-distortion.',
    build(seed, f) {
      const { S, off } = sources(seed, 1)
      const [o1x, o1y] = off()
      const [o2x, o2y] = off()
      const [ax, ay] = off()
      const [bx, by] = off()
      return (nx, ny) => {
        const qx = S(nx * f + o1x, ny * f + o1y)
        const qy = S(nx * f + o2x, ny * f + o2y)
        const wx = nx + 0.9 * qx
        const wy = ny + 0.9 * qy
        const rx = S(wx * 1.5 * f + ax, wy * 1.5 * f + ay)
        const ry = S(wx * 1.5 * f + bx, wy * 1.5 * f + by)
        return S((nx + 1.4 * rx) * 1.1 * f, (ny + 1.4 * ry) * 1.1 * f)
      }
    },
  },
  {
    name: 'Interference',
    blurb: 'Three to five offset ring emitters summed into moiré fringes.',
    build(seed, f) {
      const { rng } = sources(seed, 2)
      const count = 3 + Math.floor(rng() * 3)
      const rings: { cx: number; cy: number; k: number; ph: number }[] = []
      for (let i = 0; i < count; i++) {
        rings.push({
          cx: rng() * 1.6 - 0.8,
          cy: rng() * 1.6 - 0.8,
          k: 4 + rng() * 6,
          ph: rng() * TAU,
        })
      }
      return (nx, ny) => {
        let v = 0
        for (const r of rings) {
          v += Math.sin(Math.hypot(nx - r.cx, ny - r.cy) * r.k * f + r.ph)
        }
        return v
      }
    },
  },
  {
    name: 'Fractal Terrain',
    blurb: 'Five octaves of simplex fBm — classic rolling height noise.',
    build(seed, f) {
      const { S, off } = sources(seed, 3)
      const [ox, oy] = off()
      return (nx, ny) => {
        let v = 0
        let amp = 1
        let freq = f
        for (let o = 0; o < 5; o++) {
          v += amp * S(nx * freq + ox, ny * freq + oy)
          freq *= 2
          amp *= 0.5
        }
        return v
      }
    },
  },
  {
    name: 'Voronoi Cells',
    blurb: 'Distance to the nearest of a dozen warped seed points.',
    build(seed, f) {
      const { rng, S, off } = sources(seed, 4)
      const count = 12 + Math.floor(rng() * 7)
      const pts: [number, number][] = []
      for (let i = 0; i < count; i++) pts.push([rng() * 2 - 1, rng() * 2 - 1])
      const [wx, wy] = off()
      return (nx, ny) => {
        const px = nx + 0.18 * S(nx * 1.5 * f + wx, ny * 1.5 * f + wy)
        const py = ny + 0.18 * S(nx * 1.5 * f + wy, ny * 1.5 * f + wx)
        let best = Infinity
        for (const p of pts) {
          const dx = px - p[0]
          const dy = py - p[1]
          const d = dx * dx + dy * dy
          if (d < best) best = d
        }
        return Math.sqrt(best)
      }
    },
  },
  {
    name: 'Concentric',
    blurb: 'A single off-center sine ring stack — clean repeating bands.',
    build(seed, f) {
      const { rng } = sources(seed, 5)
      const cx = rng() * 0.8 - 0.4
      const cy = rng() * 0.8 - 0.4
      const k = 7 + rng() * 2
      return (nx, ny) => Math.sin(Math.hypot(nx - cx, ny - cy) * k * f)
    },
  },
  {
    name: 'Merged Islands',
    blurb: 'Three or four noisy blobs fused with a smooth minimum.',
    build(seed, f) {
      const { rng, S, off } = sources(seed, 6)
      const count = 3 + Math.floor(rng() * 2)
      const blobs: { bx: number; by: number; r: number; sx: number; sy: number }[] = []
      for (let i = 0; i < count; i++) {
        const [sx, sy] = off()
        blobs.push({
          bx: rng() * 1.2 - 0.6,
          by: rng() * 1.2 - 0.6,
          r: 0.34 + rng() * 0.18,
          sx,
          sy,
        })
      }
      return (nx, ny) => {
        let field = Infinity
        for (const b of blobs) {
          const dx = nx - b.bx
          const dy = ny - b.by
          const dd = Math.hypot(dx, dy) - b.r + 0.18 * S(dx * 2.3 * f + b.sx, dy * 2.3 * f + b.sy)
          field = field === Infinity ? dd : smin(field, dd, 0.4)
        }
        return field
      }
    },
  },
]
