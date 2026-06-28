// Procedural ink-ramp generator. Builds a 7-stop ramp from dark background
// to light top in HSL, mirroring the hand-picked ink sets: saturated darks,
// vivid mids, and a warm washed-out highlight (the paper-cream top stop).

const STOPS = 7

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// Shortest-path hue interpolation on the 0..360 wheel.
function lerpHue(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180
  return (a + d * t + 360) % 360
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  s = clamp01(s)
  l = clamp01(l)
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}

export interface RampOpts {
  hue: number // 0..360 base hue
  spread: number // 0..160 hue drift across the ramp
  warm: number // 0..1 pull of highlights toward warm cream
}

// Warm paper-cream hue the highlights drift toward.
const CREAM_HUE = 46

export function generateRamp(opts: RampOpts): string[] {
  const { hue, spread, warm } = opts
  const stops: string[] = []
  for (let i = 0; i < STOPS; i++) {
    const t = i / (STOPS - 1)
    // Hue: linear drift across the ramp, then pulled warm near the top.
    let h = hue + spread * (t - 0.5)
    const w = smoothstep(0.5, 1, t) * warm
    h = lerpHue(h, CREAM_HUE, w * 0.7)
    // Lightness: monotonic dark -> light so the stack reads bottom-to-top.
    const l = 0.1 + 0.82 * Math.pow(t, 0.92)
    // Saturation: bell peaking in the mids, washed out toward the top.
    const bell = Math.sin(Math.PI * clamp01(t * 0.86 + 0.07))
    let s = 0.32 + 0.56 * bell
    s *= 1 - w * 0.6
    stops.push(hslToHex(h, s, l))
  }
  return stops
}

export function randomRampOpts(rng: () => number): RampOpts {
  const modes = [14, 40, 70, 120] // mono, analogous, broad, wide
  return {
    hue: Math.floor(rng() * 360),
    spread: modes[Math.floor(rng() * modes.length)] * (rng() < 0.5 ? 1 : -1),
    warm: 0.55 + rng() * 0.45,
  }
}
