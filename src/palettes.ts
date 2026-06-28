export interface Palette {
  name: string
  stops: string[] // background -> top
}

export const PALETTES: Palette[] = [
  { name: 'Sandstone', stops: ['#3a2417', '#6b3f22', '#9c6230', '#c98a45', '#e3b06a', '#f1d199', '#faecc9'] },
  { name: 'Tide', stops: ['#0b2a3a', '#11475c', '#1d6b7d', '#2f9aa0', '#69c4bd', '#a9e0d6', '#ece4c8'] },
  { name: 'Riso', stops: ['#23123a', '#5a1f6b', '#a3248c', '#e23d7a', '#ff6f61', '#ffae6b', '#ffe3b3'] },
  { name: 'Graphite', stops: ['#161616', '#2e2e2e', '#474747', '#646464', '#8a8a8a', '#b8b4a8', '#e8e2d6'] },
  { name: 'Orchard', stops: ['#16301f', '#1f4d2a', '#3a7d3c', '#7fae3f', '#cfc24b', '#ecdd86', '#f7eec2'] },
  { name: 'Ember', stops: ['#1a0b14', '#4a0f24', '#8a1133', '#c62a2a', '#ef6a1f', '#f7a52a', '#ffe08a'] },
]

interface RGB {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function rgbToCss(c: RGB): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
}

// Sample the ramp at t in [0,1], interpolating in sRGB across the hex stops.
export function rampColor(stops: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  if (stops.length === 1) return stops[0]
  const x = clamped * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  const f = x - i
  const a = hexToRgb(stops[i])
  const b = hexToRgb(stops[i + 1])
  return rgbToCss({
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f,
  })
}
