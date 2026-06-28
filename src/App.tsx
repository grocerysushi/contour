import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PLATES } from './fields'
import { PALETTES } from './palettes'
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
const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)

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
  const [layers, setLayers] = useState(16)
  const [depth, setDepth] = useState(1)
  const [scale, setScale] = useState(1)
  const [edge, setEdge] = useState(0.5)
  const [seed, setSeed] = useState(() => randomSeed())

  const mainRef = useRef<HTMLCanvasElement>(null)
  const bedRef = useRef<HTMLDivElement>(null)
  const fieldCache = useRef<Map<string, FieldData>>(new Map())
  const rafId = useRef<number>(0)
  const scaleDebounce = useRef<number>(0)
  const thumbDebounce = useRef<number>(0)
  const [sizeTick, setSizeTick] = useState(0)

  const stops = PALETTES[palette].stops

  const getField = useCallback(
    (plateIdx: number, G: number): FieldData => {
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
    },
    [seed, scale],
  )

  // --- Main canvas render -------------------------------------------------
  const renderMain = useCallback(() => {
    const canvas = mainRef.current
    const bed = bedRef.current
    if (!canvas || !bed) return
    const cssSize = Math.max(160, Math.floor(bed.clientWidth))
    const px = Math.round(cssSize * DPR)
    if (canvas.width !== px) {
      canvas.width = px
      canvas.height = px
    }
    canvas.style.width = cssSize + 'px'
    canvas.style.height = cssSize + 'px'
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const fd = getField(plate, MAIN_G)
    const levels = levelsFor(fd, layers)
    const paths = buildLayerPaths(fd, levels, px, px)
    const edgePath = edge > 0 ? buildEdgePath(fd, levels, px, px) : null
    paintScene(ctx, paths, edgePath, { W: px, H: px, dpr: DPR, stops, depth, edge })
  }, [getField, plate, layers, edge, stops, depth])

  const scheduleMain = useCallback(() => {
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(renderMain)
  }, [renderMain])

  // --- Thumbnails ---------------------------------------------------------
  const renderThumbs = useCallback(() => {
    for (let i = 0; i < PLATES.length; i++) {
      const canvas = document.getElementById(`thumb-${i}`) as HTMLCanvasElement | null
      if (!canvas) continue
      try {
        const cssSize = 132
        const px = Math.round(cssSize * DPR)
        if (canvas.width !== px) {
          canvas.width = px
          canvas.height = px
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        const fd = getField(i, THUMB_G)
        const levels = levelsFor(fd, layers)
        const paths = buildLayerPaths(fd, levels, px, px)
        paintScene(ctx, paths, null, {
          W: px,
          H: px,
          dpr: DPR,
          stops,
          depth: depth * 0.7,
          edge: 0,
        })
      } catch {
        // Never let a thumbnail break the main canvas.
      }
    }
  }, [getField, layers, stops, depth])

  // Render main immediately on relevant change; debounce thumbnails after.
  useEffect(() => {
    scheduleMain()
    window.clearTimeout(thumbDebounce.current)
    thumbDebounce.current = window.setTimeout(renderThumbs, 130)
    return () => window.clearTimeout(thumbDebounce.current)
  }, [scheduleMain, renderThumbs, sizeTick])

  // Resample is heavier on scale change — debounce it lightly.
  useEffect(() => {
    window.clearTimeout(scaleDebounce.current)
    scaleDebounce.current = window.setTimeout(scheduleMain, 50)
    return () => window.clearTimeout(scaleDebounce.current)
  }, [scale, scheduleMain])

  // Repaint on container resize.
  useEffect(() => {
    const bed = bedRef.current
    if (!bed || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSizeTick((t) => t + 1))
    ro.observe(bed)
    return () => ro.disconnect()
  }, [])

  const reroll = useCallback(() => setSeed(randomSeed()), [])

  const savePng = useCallback(() => {
    const canvas = mainRef.current
    if (!canvas) return
    const name = `contour-${slug(PLATES[plate].name)}-${seedHex(seed)}.png`
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }, [plate, seed])

  const activePlate = PLATES[plate]

  return (
    <div className="app">
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
            <span className="cap-num">{String(plate + 1).padStart(2, '0')}</span>
            <span className="cap-name">{activePlate.name}</span>
            <span className="cap-ink">ink · {PALETTES[palette].name}</span>
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
              {PALETTES.map((pal, i) => (
                <button
                  key={pal.name}
                  type="button"
                  aria-pressed={i === palette}
                  className={'swatch' + (i === palette ? ' active' : '')}
                  onClick={() => setPalette(i)}
                  title={pal.name}
                >
                  <span className="ramp">
                    {pal.stops.map((c, k) => (
                      <span key={k} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="swatch-name">{pal.name}</span>
                </button>
              ))}
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
              <button type="button" className="btn primary" onClick={savePng}>
                Save PNG
              </button>
            </div>
            <p className="howto">{activePlate.blurb} Sheets stack low→high; depth carves the grooves, edge lays the knife cut.</p>
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
}) {
  const { label, value, min, max, step, onChange, fmt } = props
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
