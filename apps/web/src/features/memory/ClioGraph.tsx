// Clio graph: every note in Memory and the links between them, in 3D (owner, 2026-11-15: "that 3D interactive setup where
// they can poke around and see how ideas are connected"). Ported from the owner's Portolan viewer: flat discs coloured by
// folder, sized by how linked a note is, a ring on the chosen one, text labels drawn on canvas, a slow turn (none with
// reduced motion), hover and choice light up a note's links, a search that keeps the matches and their neighbours, a folder
// legend that hides a folder. Loaded only when opened (three.js and 3d-force-graph are its own chunk, from our bundle).
// Titles are note content: drawn as text on a canvas or set as textContent, never as HTML.
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import type { MemoryGraph } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { CLIO_TEXT, graphColors, linkedTo, matchesOf, type Shown, shownGraph } from './clioGraphLogic.ts'

type GNode = { id: number; title: string; root: number; path: string; degree: number; x?: number; y?: number }
type GLink = { source: number | GNode; target: number | GNode }
type Graph = ForceGraph3DInstance<GNode, GLink>

const endId = (e: number | GNode) => (typeof e === 'object' ? e.id : e)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function circle(color: string, ring = false): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.beginPath()
  g.arc(32, 32, ring ? 28 : 30, 0, Math.PI * 2)
  if (ring) {
    g.lineWidth = 4
    g.strokeStyle = color
    g.stroke()
  } else {
    g.fillStyle = color
    g.fill()
  }
  return new THREE.CanvasTexture(c)
}

function label(text: string, color: string): { tex: THREE.Texture; w: number; h: number } {
  const c = document.createElement('canvas')
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const font = '500 28px system-ui, sans-serif'
  g.font = font
  const t = text.length > 40 ? `${text.slice(0, 39)}…` : text
  c.width = Math.ceil(g.measureText(t).width) + 8
  c.height = 36
  g.font = font
  g.fillStyle = color
  g.textBaseline = 'middle'
  g.fillText(t, 4, 18)
  return { tex: new THREE.CanvasTexture(c), w: c.width, h: c.height }
}

export function ClioGraph() {
  const client = useTalosClient()
  const nav = useNavigate()
  const box = useRef<HTMLDivElement>(null)
  const engine = useRef<Graph | null>(null)
  const [data, setData] = useState<MemoryGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [chosen, setChosen] = useState<number | null>(null)
  const [turning, setTurning] = useState(!reduced())
  const hover = useRef<number | null>(null)
  const chosenRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const graph = client.memory?.graph
    if (!graph) {
      setError(CLIO_TEXT.unavailable)
      return
    }
    graph().then(
      (g) => alive && setData(g),
      (e) =>
        alive &&
        setError(e instanceof TalosClientError && e.code === 'mac_offline' ? CLIO_TEXT.offline : CLIO_TEXT.failed),
    )
    return () => {
      alive = false
    }
  }, [client])

  const shown: Shown | null = useMemo(() => (data ? shownGraph(data, hidden, q) : null), [data, hidden, q])
  const matches = useMemo(() => (data ? matchesOf(data, q) : new Set<number>()), [data, q])

  // the scene is made once, when the graph arrives; a search or a hidden folder only gives it new data (below), so typing
  // never makes a second WebGL context
  useEffect(() => {
    const el = box.current
    if (!el || !data) return
    const colors = graphColors()
    const lit = (l: GLink) => {
      const s = endId(l.source)
      const t = endId(l.target)
      return [hover.current, chosenRef.current].some((id) => id !== null && (id === s || id === t))
    }
    const g = (new ForceGraph3D(el) as unknown as Graph)
      .width(el.clientWidth)
      .height(el.clientHeight)
      .backgroundColor(colors.ground)
      .showNavInfo(false)
      .graphData({ nodes: [], links: [] })
      .nodeId('id')
      .nodeVal((n: GNode) => 1.5 + Math.sqrt(n.degree))
      .nodeLabel(() => '') // the label is the canvas text beside the disc, never HTML
      .nodeThreeObject((n: GNode) => {
        const r = 1 + Math.cbrt(1.5 + Math.sqrt(n.degree)) * 3.2
        const group = new THREE.Group()
        const disc = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: circle(colors.folder(n.root)), transparent: true, depthWrite: false }),
        )
        disc.scale.set(r * 2, r * 2, 1)
        group.add(disc)
        const ring = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: circle(colors.ring, true), transparent: true, depthWrite: false }),
        )
        ring.scale.set(r * 2.7, r * 2.7, 1)
        ring.name = 'ring'
        ring.visible = n.id === chosenRef.current
        group.add(ring)
        const t = label(n.title, colors.ink)
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.tex, transparent: true, depthWrite: false }))
        s.scale.set(t.w * 0.12, t.h * 0.12, 1)
        s.position.set(r * 1.3 + (t.w * 0.12) / 2, r * 1.1, 0)
        group.add(s)
        return group
      })
      .linkColor((l: GLink) => (lit(l) ? colors.accent : colors.link))
      .linkOpacity(0.35)
      .linkWidth((l: GLink) => (lit(l) ? 1.2 : 0))
      .linkDirectionalParticles((l: GLink) => (lit(l) ? 2 : 0))
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.004)
      .onNodeHover((n: GNode | null) => {
        hover.current = n ? n.id : null
        el.style.cursor = n ? 'pointer' : 'default'
        g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
      })
      .onNodeClick((n: GNode) => setChosen(n.id))
      .onBackgroundClick(() => setChosen(null))
    g.d3Force('link')?.distance(60)
    g.d3Force('charge')?.strength(-140)
    g.cooldownTicks(200).onEngineStop(() => g.zoomToFit(400, 40))
    engine.current = g
    const ro = new ResizeObserver(() => g.width(el.clientWidth).height(el.clientHeight))
    ro.observe(el)
    // a touch or a drag is the owner turning it: the slow turn stops for good
    const stop = () => setTurning(false)
    el.addEventListener('pointerdown', stop)
    return () => {
      ro.disconnect()
      el.removeEventListener('pointerdown', stop)
      g.renderer?.().forceContextLoss?.()
      g._destructor?.()
      engine.current = null
      el.replaceChildren()
    }
  }, [data])

  // what is shown, a moment after the last key, into the one scene; a chosen note no longer shown is let go
  useEffect(() => {
    if (!shown || !data) return
    if (chosenRef.current !== null && !shown.nodes.includes(chosenRef.current)) setChosen(null)
    const t = setTimeout(() => {
      const g = engine.current
      if (!g) return
      const nodes: GNode[] = shown.nodes.map((i) => {
        const n = data.nodes[i] as MemoryGraph['nodes'][number]
        return { id: i, title: n.title, root: n.root, path: n.path, degree: shown.degree.get(i) ?? 0 }
      })
      g.graphData({ nodes, links: shown.edges.map(([a, b]) => ({ source: a, target: b })) })
    }, 150)
    return () => clearTimeout(t)
  }, [shown, data])

  // the chosen note: its ring, its lit links (the scene reads it from chosenRef)
  useEffect(() => {
    chosenRef.current = chosen
    const g = engine.current
    if (!g) return
    for (const n of g.graphData().nodes as Array<GNode & { __threeObj?: THREE.Object3D }>) {
      const ring = n.__threeObj?.getObjectByName('ring')
      if (ring) ring.visible = n.id === chosen
    }
    g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
  }, [chosen])

  // a slow turn round the middle, paused on request and never with reduced motion
  useEffect(() => {
    if (!turning || reduced()) return
    let id = 0
    let last = 0
    const step = (t: number) => {
      const g = engine.current
      if (g && last) {
        const p = g.cameraPosition()
        const a = ((t - last) / 1000) * 0.08
        g.cameraPosition({ x: p.x * Math.cos(a) - p.z * Math.sin(a), y: p.y, z: p.x * Math.sin(a) + p.z * Math.cos(a) })
      }
      last = t
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [turning])

  const node = data && chosen !== null ? data.nodes[chosen] : undefined
  const folder = (i: number) => data?.roots[i]?.label ?? ''
  const colors = graphColors()

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="clio-graph">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/memory" className="min-h-11 content-center px-2 text-sm text-accent hover:underline">
          {CLIO_TEXT.back}
        </Link>
        <h1 className="m-0 font-display text-xl font-semibold">{CLIO_TEXT.title}</h1>
        {data && (
          <span className="text-sm text-text-2" data-testid="clio-graph-meta">
            {CLIO_TEXT.meta(data.nodes.length, data.total, data.edges.length)}
          </span>
        )}
        <span className="flex-1" />
        <input
          type="search"
          aria-label={CLIO_TEXT.search}
          placeholder={CLIO_TEXT.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-h-11 w-48 rounded-pill border border-line bg-surface px-3 text-sm"
        />
        {!reduced() && (
          <button
            type="button"
            onClick={() => setTurning((t) => !t)}
            className="min-h-11 rounded-pill border border-line px-3 text-sm hover:bg-surface-2"
          >
            {turning ? CLIO_TEXT.pause : CLIO_TEXT.turn}
          </button>
        )}
      </div>
      {data && data.roots.length > 1 && (
        <ul aria-label={CLIO_TEXT.legend} className="m-0 flex list-none flex-wrap gap-2 p-0">
          {data.roots.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={!hidden.has(i)}
                onClick={() =>
                  setHidden((h) => {
                    const next = new Set(h)
                    if (next.has(i)) next.delete(i)
                    else next.add(i)
                    return next
                  })
                }
                className={cn(
                  'flex min-h-11 items-center gap-2 rounded-pill border border-line px-3 text-sm',
                  hidden.has(i) && 'text-text-2 line-through',
                )}
              >
                <span aria-hidden="true" className="size-3 rounded-pill" style={{ background: colors.folder(i) }} />
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="m-0 p-4 text-sm text-text-2">
          {error}
        </p>
      ) : !data ? (
        <p role="status" className="m-0 p-4 text-sm text-text-2">
          {CLIO_TEXT.loading}
        </p>
      ) : data.nodes.length === 0 ? (
        <p role="status" className="m-0 p-4 text-sm text-text-2">
          {CLIO_TEXT.empty}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card border border-line">
        <div ref={box} className="absolute inset-0" aria-label={CLIO_TEXT.canvas} role="img" />
        {q && shown && matches.size === 0 && (
          <p className="absolute top-3 left-3 m-0 rounded-button bg-surface px-3 py-2 text-sm">{CLIO_TEXT.noMatch}</p>
        )}
        {node && chosen !== null && data && (
          <aside
            aria-label={CLIO_TEXT.panel}
            className="absolute top-3 right-3 flex w-72 max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-card border border-line bg-surface p-3 shadow-sm"
          >
            <h2 className="m-0 text-base font-semibold">{node.title}</h2>
            <p className="m-0 text-xs text-text-2">
              {folder(node.root)} · {CLIO_TEXT.links(linkedTo(data, chosen).length)}
            </p>
            <button
              type="button"
              onClick={() =>
                nav(
                  `/memory?r=${encodeURIComponent(data.roots[node.root]?.id ?? '')}&n=${encodeURIComponent(node.path)}`,
                )
              }
              className="mt-1 min-h-11 self-start rounded-pill border border-line px-3 text-sm hover:bg-surface-2"
            >
              {CLIO_TEXT.open}
            </button>
          </aside>
        )}
      </div>
      {data?.truncated && (
        <p className="m-0 text-xs text-text-2" data-testid="clio-graph-truncated">
          {CLIO_TEXT.truncated(data.nodes.length, data.total)}
        </p>
      )}
    </div>
  )
}
