import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { PLATES } from './fields'
import { PALETTES } from './palettes'
import { generateRamp, randomRampOpts, type RampOpts } from './generate'
import {
  buildEdgePath,
  buildLayerPaths,
  levelsFor,
  paintScene,
  sampleField,
  type FieldData,
} from './render'

const MAIN_G = 140
const THUMB_G = 46
// Read the live device-pixel ratio at render time (zoom / monitor moves
// change it) and render the canvas backing store at that resolution so it
// stays crisp. Capped at 3 to bound paint cost on extreme displays.
const MAX_DPR = 3
function getDpr(): number {
  const d = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(Math.max(d, 1), MAX_DPR)
}

// Instagram destination. Change the handle here to repoint the share button.
const IG_HANDLE = 'grocerysushi'
const IG_PROFILE_URL = `https://www.instagram.com/${IG_HANDLE}/`

function slug(name: string): string {
  return name.toLowerCase().split(/\s+/)[0]
}

function seedHex(seed: number): string {
  return '0x' + (seed >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) ^ (Date.now() & 0xffff)) >>> 0
}

// Field cache keyed by plate|seed|scale|grid. Recolor / depth / edge reuse it.
function fieldKey(plate: number, seed: number, scale: number, G: number): string {
  return `${plate}|${seed}|${scale.toFixed(3)}|${G}`
}

export default function App() {
  const [plate, setPlate] = useState(1)
  const [palette, setPalette] = useState(0)
  const [inkMode, setInkMode] = useState<'preset' | 'custom'>('preset')
  const [gen, setGen] = useState<RampOpts>(() => randomRampOpts(Math.random))
  const [layers, setLayers] = useState(16)
  const [depth, setDepth] = useState(1)
  const [scale, setScale] = useState(1)
  const [edge, setEdge] = useState(0.5)
  const [seed, setSeed] = useState(() => randomSeed())
  const [toast, setToast] = useState<string | null>(null)

  const appRef = useRef<HTMLDivElement>(null)
  const capNumRef = useRef<HTMLSpanElement>(null)
  const customSwatchRef = useRef<HTMLButtonElement>(null)
  const reduceMotion = useRef(false)
  const firstStamp = useRef(true)
  const toastTimer = useRef<number>(0)
  const mainRef = useRef<HTMLCanvasElement>(null)
  const bedRef = useRef<HTMLDivElement>(null)
  const fieldCache = useRef<Map<string, FieldData>>(new Map())
  const rafId = useRef<number>(0)
  const scaleDebounce = useRef<number>(0)
  const thumbDebounce = useRef<number>(0)
  // Cached layer/edge geometry; only rebuilt when structure changes. The edge
  // path is built lazily — skipped entirely while Edge is 0.
  const pathCache = useRef<{
    key: string
    px: number
    fd: FieldData
    levels: Float32Array
    paths: Path2D[]
    edgePath: Path2D | null
  } | null>(null)
  const thumbPathCache = useRef<Map<string, Path2D[]>>(new Map())
  const [sizeTick, setSizeTick] = useState(0)

  const customRamp = useMemo(() => generateRamp(gen), [gen])
  const stops = inkMode === 'custom' ? customRamp : PALETTES[palette].stops
  const inkName = inkMode === 'custom' ? 'Custom' : PALETTES[palette].name

  // Latest render inputs, read by the stable render callbacks below. Keeping
  // the callbacks identity-stable means scheduling is driven explicitly by the
  // effects (immediate vs debounced) rather than by closure churn.
  const params = useRef({ plate, seed, scale, layers, depth, edge, stops })
  params.current = { plate, seed, scale, layers, depth, edge, stops }

  const getField = useCallback((plateIdx: number, seed: number, scale: number, G: number): FieldData => {
    const key = fieldKey(plateIdx, seed, scale, G)
    const cache = fieldCache.current
    let fd = cache.get(key)
    if (!fd) {
      const sampler = PLATES[plateIdx].build(seed, scale)
      fd = sampleField(sampler, G)
      if (cache.size > 64) cache.clear()
      cache.set(key, fd)
    }
    return fd
  }, [])

  // --- Main canvas render (stable) ---------------------------------------
  const renderMain = useCallback(() => {
    const canvas = mainRef.current
    const bed = bedRef.current
    if (!canvas || !bed) return
    const { plate, seed, scale, layers, depth, edge, stops } = params.current
    const dpr = getDpr()
    const cssSize = Math.max(160, Math.floor(bed.clientWidth))
    const px = Math.round(cssSize * dpr)
    if (canvas.width !== px) {
      canvas.width = px
      canvas.height = px
    }
    canvas.style.width = cssSize + 'px'
    canvas.style.height = cssSize + 'px'
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Geometry depends only on plate/seed/scale/layers/size — not on ink,
    // depth, or edge. Rebuild only when one of those changes; recolor / depth
    // / edge tweaks just repaint the cached paths.
    const structKey = `${plate}|${seed}|${scale.toFixed(3)}|${layers}|${px}`
    let cached = pathCache.current
    if (!cached || cached.key !== structKey) {
      const fd = getField(plate, seed, scale, MAIN_G)
      const levels = levelsFor(fd, layers)
      cached = {
        key: structKey,
        px,
        fd,
        levels,
        paths: buildLayerPaths(fd, levels, px, px),
        edgePath: null,
      }
      pathCache.current = cached
    }
    // Build the edge geometry only when the knife cut is actually on.
    let edgePath: Path2D | null = null
    if (edge > 0) {
      if (!cached.edgePath) cached.edgePath = buildEdgePath(cached.fd, cached.levels, cached.px, cached.px)
      edgePath = cached.edgePath
    }
    paintScene(ctx, cached.paths, edgePath, {
      W: px,
      H: px,
      dpr,
      stops,
      depth,
      edge,
    })
  }, [getField])

  const scheduleMain = useCallback(() => {
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(renderMain)
  }, [renderMain])

  // --- Thumbnails (stable) -----------------------------------------------
  const renderThumbs = useCallback(() => {
    const { seed, scale, layers, stops } = params.current
    const dpr = getDpr()
    for (let i = 0; i < PLATES.length; i++) {
      const canvas = document.getElementById(`thumb-${i}`) as HTMLCanvasElement | null
      if (!canvas) continue
      try {
        // Match the chip's actual rendered width so the thumbnail isn't upscaled.
        const cssSize = Math.max(96, Math.round(canvas.getBoundingClientRect().width) || 132)
        const px = Math.round(cssSize * dpr)
        if (canvas.width !== px) {
          canvas.width = px
          canvas.height = px
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        const key = `${i}|${seed}|${scale.toFixed(3)}|${layers}|${px}`
        const cache = thumbPathCache.current
        let paths = cache.get(key)
        if (!paths) {
          const fd = getField(i, seed, scale, THUMB_G)
          const levels = levelsFor(fd, layers)
          paths = buildLayerPaths(fd, levels, px, px)
          if (cache.size > 32) cache.clear()
          cache.set(key, paths)
        }
        // Fixed depth so the depth slider never re-renders thumbnails.
        paintScene(ctx, paths, null, { W: px, H: px, dpr, stops, depth: 0.6, edge: 0 })
      } catch {
        // Never let a thumbnail break the main canvas.
      }
    }
  }, [getField])

  // Immediate repaint on visual changes that are cheap (paths cached) — but
  // NOT scale, which resamples the field and is debounced separately.
  useEffect(() => {
    scheduleMain()
  }, [scheduleMain, plate, seed, layers, depth, edge, stops, sizeTick])

  // Scale resamples the whole field; coalesce rapid drags before rendering.
  useEffect(() => {
    window.clearTimeout(scaleDebounce.current)
    scaleDebounce.current = window.setTimeout(scheduleMain, 60)
    return () => window.clearTimeout(scaleDebounce.current)
  }, [scale, scheduleMain])

  // Thumbnails react only to structure/ink (not depth/edge), debounced.
  useEffect(() => {
    window.clearTimeout(thumbDebounce.current)
    thumbDebounce.current = window.setTimeout(renderThumbs, 140)
    return () => window.clearTimeout(thumbDebounce.current)
  }, [renderThumbs, seed, scale, layers, stops, sizeTick])

  // Repaint on container resize.
  useEffect(() => {
    const bed = bedRef.current
    if (!bed || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSizeTick((t) => t + 1))
    ro.observe(bed)
    return () => ro.disconnect()
  }, [])

  // Re-render when the device-pixel ratio changes (browser zoom, or dragging
  // the window to a monitor with different density) so the canvas stays sharp.
  // Also repaint when the tab becomes visible: a first paint scheduled via rAF
  // is skipped while the tab is in the background, leaving a stretched canvas.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    let mql: MediaQueryList | null = null
    const bump = () => setSizeTick((t) => t + 1)
    const onChange = () => {
      bump()
      arm()
    }
    const arm = () => {
      mql?.removeEventListener('change', onChange)
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onChange)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump()
    }
    arm()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mql?.removeEventListener('change', onChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // --- GSAP: respect reduced motion, then choreograph the intro ----------
  useLayoutEffect(() => {
    reduceMotion.current =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion.current) return
    const root = appRef.current
    if (!root) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      tl.from('.topbar', { opacity: 0, y: -12, duration: 0.5 })
        .from('.bed', { opacity: 0, y: 18, duration: 0.6 }, '-=0.3')
        .from('.caption', { opacity: 0, duration: 0.4 }, '-=0.2')
        .from('.controls > .block', { opacity: 0, y: 18, duration: 0.5, stagger: 0.08 }, '-=0.45')
    }, root)
    return () => ctx.revert()
  }, [])

  // Thematic "press stamp" when the printed plate changes (plate or seed).
  useEffect(() => {
    if (firstStamp.current) {
      firstStamp.current = false
      return
    }
    if (reduceMotion.current) return
    if (bedRef.current) {
      gsap.fromTo(
        bedRef.current,
        { scale: 0.975 },
        { scale: 1, duration: 0.5, ease: 'power3.out', clearProps: 'scale' },
      )
    }
    if (capNumRef.current) {
      gsap.fromTo(
        capNumRef.current,
        { y: -10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.4, ease: 'back.out(2)' },
      )
    }
  }, [plate, seed])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])

  const reroll = useCallback(() => setSeed(randomSeed()), [])

  // Generate a fresh random ink ramp and switch to it, with a little pulse.
  const rollInk = useCallback(() => {
    setGen(randomRampOpts(Math.random))
    setInkMode('custom')
    if (!reduceMotion.current && customSwatchRef.current) {
      gsap.fromTo(
        customSwatchRef.current,
        { scale: 0.92 },
        { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.5)', clearProps: 'scale' },
      )
    }
  }, [])

  // Edit one generator parameter; editing always activates the custom ramp.
  const editInk = useCallback((patch: Partial<RampOpts>) => {
    setGen((g) => ({ ...g, ...patch }))
    setInkMode('custom')
  }, [])

  const exportName = useCallback(
    () => `contour-${slug(PLATES[plate].name)}-${seedHex(seed)}.png`,
    [plate, seed],
  )

  const withBlob = useCallback(
    (cb: (blob: Blob, name: string) => void) => {
      const canvas = mainRef.current
      if (!canvas) return
      const name = exportName()
      canvas.toBlob((blob) => {
        if (blob) cb(blob, name)
      }, 'image/png')
    },
    [exportName],
  )

  const downloadBlob = useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  const savePng = useCallback(() => withBlob(downloadBlob), [withBlob, downloadBlob])

  // Post to @grocerysushi. On mobile the Web Share API hands the PNG to the
  // native share sheet (Instagram, Stories, etc.). Desktop browsers can't push
  // an image into Instagram directly, so fall back to saving the PNG and
  // opening the profile, where a new post can be started.
  const shareImage = useCallback(() => {
    withBlob(async (blob, name) => {
      const file = new File([blob], name, { type: 'image/png' })
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean
        share?: (data?: ShareData) => Promise<void>
      }
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        try {
          await nav.share({
            files: [file],
            title: 'Contour Press',
            text: `Printed with Contour Press — @${IG_HANDLE}`,
          })
          flash('Shared. Pick Instagram from the share sheet.')
        } catch {
          // User dismissed the share sheet — nothing to do.
        }
      } else {
        downloadBlob(blob, name)
        window.open(IG_PROFILE_URL, '_blank', 'noopener')
        flash(`Saved the PNG — opening @${IG_HANDLE} to start a new post.`)
      }
    })
  }, [withBlob, downloadBlob, flash])

  const activePlate = PLATES[plate]

  return (
    <div className="app" ref={appRef}>
      <Grain />
      <header className="topbar">
        <div className="brand">
          <h1>CONTOUR&nbsp;PRESS</h1>
          <p className="tagline">marching-squares cut-paper studio</p>
        </div>
        <dl className="meta">
          <div>
            <dt>grid</dt>
            <dd>{MAIN_G}²</dd>
          </div>
          <div>
            <dt>layers</dt>
            <dd>{layers}</dd>
          </div>
          <div>
            <dt>seed</dt>
            <dd>{seedHex(seed)}</dd>
          </div>
        </dl>
      </header>

      <main className="grid">
        <section className="press" aria-label="Press bed">
          <div className="bed">
            <div className="bed-inner" ref={bedRef}>
              <Corners />
              <canvas ref={mainRef} className="paper" aria-label={`${activePlate.name} contour print`} />
            </div>
          </div>
          <div className="caption">
            <span className="cap-num" ref={capNumRef}>
              {String(plate + 1).padStart(2, '0')}
            </span>
            <span className="cap-name">{activePlate.name}</span>
            <span className="cap-ink">ink · {inkName}</span>
          </div>
        </section>

        <aside className="controls">
          <fieldset className="block">
            <legend>Plates · contact sheet</legend>
            <div className="rail" role="radiogroup" aria-label="Field plate">
              {PLATES.map((pl, i) => (
                <button
                  key={pl.name}
                  type="button"
                  role="radio"
                  aria-checked={i === plate}
                  className={'chip' + (i === plate ? ' active' : '')}
                  onClick={() => setPlate(i)}
                  title={pl.blurb}
                >
                  <canvas id={`thumb-${i}`} className="thumb" />
                  <span className="chip-meta">
                    <span className="chip-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="chip-name">{pl.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="block">
            <legend>Ink set</legend>
            <div className="swatches">
              {PALETTES.map((pal, i) => {
                const on = inkMode === 'preset' && i === palette
                return (
                  <button
                    key={pal.name}
                    type="button"
                    aria-pressed={on}
                    className={'swatch' + (on ? ' active' : '')}
                    onClick={() => {
                      setPalette(i)
                      setInkMode('preset')
                    }}
                    title={pal.name}
                  >
                    <span className="ramp">
                      {pal.stops.map((c, k) => (
                        <span key={k} style={{ background: c }} />
                      ))}
                    </span>
                    <span className="swatch-name">{pal.name}</span>
                  </button>
                )
              })}
            </div>

            <div className="gen">
              <div className="gen-head">
                <button
                  type="button"
                  ref={customSwatchRef}
                  aria-pressed={inkMode === 'custom'}
                  className={'swatch custom' + (inkMode === 'custom' ? ' active' : '')}
                  onClick={() => setInkMode('custom')}
                  title="Use the generated ink ramp"
                >
                  <span className="ramp">
                    {customRamp.map((c, k) => (
                      <span key={k} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="swatch-name">Custom</span>
                </button>
                <button type="button" className="btn gen-btn" onClick={rollInk}>
                  ⟳ Generate
                </button>
              </div>
              <Slider
                label="Hue"
                value={gen.hue}
                min={0}
                max={360}
                step={1}
                onChange={(v) => editInk({ hue: v })}
                fmt={(v) => Math.round(v) + '°'}
                track="hue"
              />
              <Slider
                label="Spread"
                value={gen.spread}
                min={-160}
                max={160}
                step={1}
                onChange={(v) => editInk({ spread: v })}
                fmt={(v) => Math.round(v) + '°'}
              />
              <Slider
                label="Warmth"
                value={gen.warm}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => editInk({ warm: v })}
                fmt={(v) => Math.round(v * 100) + '%'}
              />
            </div>
          </fieldset>

          <fieldset className="block">
            <legend>Press</legend>
            <Slider label="Layers" value={layers} min={6} max={30} step={1} onChange={setLayers} fmt={(v) => String(v)} />
            <Slider label="Depth" value={depth} min={0} max={2} step={0.05} onChange={setDepth} fmt={(v) => v.toFixed(2) + '×'} />
            <Slider label="Scale" value={scale} min={0.5} max={2.2} step={0.02} onChange={setScale} fmt={(v) => v.toFixed(2) + '×'} />
            <Slider label="Edge" value={edge} min={0} max={1.6} step={0.05} onChange={setEdge} fmt={(v) => (v === 0 ? 'off' : v.toFixed(2) + 'px')} />
          </fieldset>

          <fieldset className="block">
            <legend>Output</legend>
            <div className="seedrow">
              <span className="seed-label">seed</span>
              <code className="seed-val">{seedHex(seed)}</code>
              <button type="button" className="btn" onClick={reroll}>
                Reroll
              </button>
            </div>
            <div className="actions">
              <button type="button" className="btn" onClick={savePng}>
                Save PNG
              </button>
              <button
                type="button"
                className="btn primary ig"
                onClick={shareImage}
                title={`Share to Instagram (@${IG_HANDLE})`}
                aria-label={`Post to Instagram, @${IG_HANDLE}`}
              >
                <IgGlyph />
                <span className="ig-label">
                  Post to <span className="ig-handle">@{IG_HANDLE}</span>
                </span>
              </button>
            </div>
            <p className="howto" role="status" aria-live="polite">
              {toast ?? (
                <>
                  {activePlate.blurb} Sheets stack low→high; depth carves the grooves, edge lays the knife
                  cut.
                </>
              )}
            </p>
          </fieldset>
        </aside>
      </main>
    </div>
  )
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt: (v: number) => string
  track?: 'hue'
}) {
  const { label, value, min, max, step, onChange, fmt, track } = props
  const id = useMemo(() => 'sl-' + label.toLowerCase(), [label])
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <span className="val">{fmt(value)}</span>
      </label>
      <input
        id={id}
        type="range"
        className={track === 'hue' ? 'hue-track' : undefined}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ ['--pct' as string]: pct + '%' }}
      />
    </div>
  )
}

function IgGlyph() {
  return (
    <svg className="ig-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.6" cy="6.4" r="1.4" fill="currentColor" />
    </svg>
  )
}

function Corners() {
  return (
    <>
      <span className="reg tl" aria-hidden />
      <span className="reg tr" aria-hidden />
      <span className="reg bl" aria-hidden />
      <span className="reg br" aria-hidden />
    </>
  )
}

function Grain() {
  return (
    <svg className="grain" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <filter id="grainf">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grainf)" />
    </svg>
  )
}
