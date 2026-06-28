import type { Sampler } from './fields'
import { rampColor } from './palettes'

export interface FieldData {
  data: Float32Array
  G: number
  vmin: number
  vmax: number
}

// Evaluate the field on a (G+1)x(G+1) vertex grid.
export function sampleField(sampler: Sampler, G: number): FieldData {
  const n = G + 1
  const data = new Float32Array(n * n)
  let vmin = Infinity
  let vmax = -Infinity
  for (let j = 0; j < n; j++) {
    const ny = -1 + (2 * j) / G
    const row = j * n
    for (let i = 0; i < n; i++) {
      const nx = -1 + (2 * i) / G
      const v = sampler(nx, ny)
      data[row + i] = v
      if (v < vmin) vmin = v
      if (v > vmax) vmax = v
    }
  }
  return { data, G, vmin, vmax }
}

export function levelsFor(fd: FieldData, N: number): Float32Array {
  const lv = new Float32Array(N)
  const span = fd.vmax - fd.vmin
  for (let i = 0; i < N; i++) lv[i] = fd.vmin + (i / N) * span
  return lv
}

// Build one Path2D per threshold (iso-band fill) in a single pass over cells.
export function buildLayerPaths(fd: FieldData, levels: Float32Array, W: number, H: number): Path2D[] {
  const { data, G } = fd
  const n = G + 1
  const N = levels.length
  const cellW = W / G
  const cellH = H / G
  const paths: Path2D[] = []
  for (let i = 0; i < N; i++) paths.push(new Path2D())

  for (let cy = 0; cy < G; cy++) {
    const top = cy * n
    const bot = top + n
    const y0 = cy * cellH
    const y1 = y0 + cellH
    for (let cx = 0; cx < G; cx++) {
      const tl = data[top + cx]
      const tr = data[top + cx + 1]
      const bl = data[bot + cx]
      const br = data[bot + cx + 1]
      const x0 = cx * cellW
      const x1 = x0 + cellW

      let cellMin = tl
      if (tr < cellMin) cellMin = tr
      if (bl < cellMin) cellMin = bl
      if (br < cellMin) cellMin = br
      let cellMax = tl
      if (tr > cellMax) cellMax = tr
      if (bl > cellMax) cellMax = bl
      if (br > cellMax) cellMax = br

      for (let i = 0; i < N; i++) {
        const level = levels[i]
        // Outside for this and every higher threshold.
        if (level > cellMax) break
        const p = paths[i]
        if (level <= cellMin) {
          // Whole cell inside: full quad.
          p.moveTo(x0, y0)
          p.lineTo(x1, y0)
          p.lineTo(x1, y1)
          p.lineTo(x0, y1)
          p.closePath()
          continue
        }
        // Mixed cell: walk boundary clockwise.
        const inTL = tl >= level
        const inTR = tr >= level
        const inBR = br >= level
        const inBL = bl >= level
        let started = false
        const add = (x: number, y: number) => {
          if (started) p.lineTo(x, y)
          else {
            p.moveTo(x, y)
            started = true
          }
        }
        if (inTL) add(x0, y0)
        if (inTL !== inTR) add(x0 + cellW * ((level - tl) / (tr - tl)), y0)
        if (inTR) add(x1, y0)
        if (inTR !== inBR) add(x1, y0 + cellH * ((level - tr) / (br - tr)))
        if (inBR) add(x1, y1)
        if (inBR !== inBL) add(x0 + cellW * ((level - bl) / (br - bl)), y1)
        if (inBL) add(x0, y1)
        if (inBL !== inTL) add(x0, y0 + cellH * ((level - tl) / (bl - tl)))
        if (started) p.closePath()
      }
    }
  }
  return paths
}

// Classic marching-squares line pass: one Path2D of all iso-segments.
export function buildEdgePath(fd: FieldData, levels: Float32Array, W: number, H: number): Path2D {
  const { data, G } = fd
  const n = G + 1
  const N = levels.length
  const cellW = W / G
  const cellH = H / G
  const path = new Path2D()

  for (let cy = 0; cy < G; cy++) {
    const top = cy * n
    const bot = top + n
    const y0 = cy * cellH
    const y1 = y0 + cellH
    for (let cx = 0; cx < G; cx++) {
      const tl = data[top + cx]
      const tr = data[top + cx + 1]
      const bl = data[bot + cx]
      const br = data[bot + cx + 1]
      const x0 = cx * cellW
      const x1 = x0 + cellW

      let cellMin = Math.min(tl, tr, bl, br)
      let cellMax = Math.max(tl, tr, bl, br)

      for (let i = 0; i < N; i++) {
        const level = levels[i]
        if (level <= cellMin || level > cellMax) continue
        const code = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0)
        if (code === 0 || code === 15) continue
        // Crossings: T(top), R(right), B(bottom), L(left)
        const Tx = x0 + cellW * ((level - tl) / (tr - tl))
        const Ty = y0
        const Rx = x1
        const Ry = y0 + cellH * ((level - tr) / (br - tr))
        const Bx = x0 + cellW * ((level - bl) / (br - bl))
        const By = y1
        const Lx = x0
        const Ly = y0 + cellH * ((level - tl) / (bl - tl))
        const seg = (ax: number, ay: number, bx: number, by: number) => {
          path.moveTo(ax, ay)
          path.lineTo(bx, by)
        }
        switch (code) {
          case 1: seg(Lx, Ly, Bx, By); break
          case 2: seg(Bx, By, Rx, Ry); break
          case 3: seg(Lx, Ly, Rx, Ry); break
          case 4: seg(Tx, Ty, Rx, Ry); break
          case 5: seg(Lx, Ly, Tx, Ty); seg(Bx, By, Rx, Ry); break
          case 6: seg(Tx, Ty, Bx, By); break
          case 7: seg(Lx, Ly, Tx, Ty); break
          case 8: seg(Tx, Ty, Lx, Ly); break
          case 9: seg(Tx, Ty, Bx, By); break
          case 10: seg(Tx, Ty, Rx, Ry); seg(Lx, Ly, Bx, By); break
          case 11: seg(Tx, Ty, Rx, Ry); break
          case 12: seg(Lx, Ly, Rx, Ry); break
          case 13: seg(Bx, By, Rx, Ry); break
          case 14: seg(Lx, Ly, Bx, By); break
        }
      }
    }
  }
  return path
}

export interface PaintOpts {
  W: number
  H: number
  dpr: number
  stops: string[]
  depth: number
  edge: number
}

// Paint the stacked-paper scene, low threshold to high.
export function paintScene(
  ctx: CanvasRenderingContext2D,
  paths: Path2D[],
  edgePath: Path2D | null,
  opts: PaintOpts,
): void {
  const { W, H, dpr, stops, depth, edge } = opts
  const N = paths.length
  ctx.clearRect(0, 0, W, H)

  // Base sheet color covers antialiased seams beneath the stack.
  ctx.fillStyle = rampColor(stops, 0)
  ctx.fillRect(0, 0, W, H)

  for (let i = 0; i < N; i++) {
    const color = rampColor(stops, N > 1 ? i / (N - 1) : 0)

    // Body + groove: a single fill so the drop shadow rides only the silhouette.
    ctx.save()
    if (depth > 0) {
      ctx.shadowColor = 'rgba(18, 10, 4, 0.42)'
      ctx.shadowBlur = 7 * depth * dpr
      ctx.shadowOffsetX = 3.2 * depth * dpr
      ctx.shadowOffsetY = 3.7 * depth * dpr
    }
    ctx.fillStyle = color
    ctx.fill(paths[i])
    ctx.restore()

    // Highlight rim: same path nudged up-left, faint near-white.
    ctx.save()
    ctx.translate(-1.6 * dpr, -1.6 * dpr)
    ctx.globalAlpha = 0.3
    ctx.fillStyle = 'rgb(255, 250, 240)'
    ctx.fill(paths[i])
    ctx.restore()
  }

  if (edge > 0 && edgePath) {
    ctx.save()
    ctx.strokeStyle = 'rgba(20, 12, 6, 0.55)'
    ctx.lineWidth = edge * dpr
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.stroke(edgePath)
    ctx.restore()
  }
}
