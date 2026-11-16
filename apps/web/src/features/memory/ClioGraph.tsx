// Clio graph: every note in Memory and the links between them, in 3D (owner, 2026-11-15: "that 3D interactive setup where
// they can poke around and see how ideas are connected"). Ported from the owner's Portolan viewer: flat discs coloured by
// folder, sized by how linked a note is, a ring on the chosen one, text labels drawn on canvas, a slow turn (none with
// reduced motion), hover and choice light up a note's links, a search that keeps the matches and their neighbours, a folder
// legend that hides a folder. It fills the content area (owner, 2026-11-16): wheel and pinch zoom, drag to turn, right-drag to
// pan, and a chosen note slides in a panel from the right while the graph stays live behind it. Loaded only when opened
// (three.js and 3d-force-graph are its own chunk, from our bundle).
// Titles are note content: drawn as text on a canvas or set as textContent, never as HTML.
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import type { MemoryGraph } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { PHONE_QUERY } from '../phone/PhoneChrome.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { CLIO_TEXT, graphColors, labelled, linkedTo, matchesOf, type Shown, shownGraph } from './clioGraphLogic.ts'
import { baseName } from './logic.ts'
import { NoteView } from './NoteView.tsx'

type GNode = {
  id: number
  title: string
  root: number
  path: string
  degree: number
  x?: number
  y?: number
  z?: number
  __threeObj?: THREE.Object3D
}
type GLink = { source: number | GNode; target: number | GNode }
type Graph = ForceGraph3DInstance<GNode, GLink>

const endId = (e: number | GNode) => (typeof e === 'object' ? e.id : e)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const radius = (degree: number) => 1 + Math.cbrt(1.5 + Math.sqrt(degree)) * 3.2
const noRaycast = () => {} // a ring or a label is never what a click lands on: the disc is
const EMPTY: Shown = { nodes: [], edges: [], degree: new Map() }

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

/** A thin bar sliding along the top while the graph is asked for; still (no motion) when the owner prefers reduced motion. */
function LoadingLine() {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (reduced() || !bar.current?.animate) return
    const a = bar.current.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(300%)' }], {
      duration: 1400,
      iterations: Number.POSITIVE_INFINITY,
      easing: 'ease-in-out',
    })
    return () => a.cancel()
  }, [])
  return (
    <div
      role="progressbar"
      aria-label={CLIO_TEXT.loading}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      <div ref={bar} className="h-full w-1/3 bg-accent" />
    </div>
  )
}

type Ref<T> = { current: T }
/** What the scene shares with the component: it reads the note state through these, and calls back through the last two. */
type SceneRefs = {
  hover: Ref<number | null>
  chosenRef: Ref<number | null>
  shownRef: Ref<Shown>
  matchesRef: Ref<ReadonlySet<number>>
  neighboursRef: Ref<ReadonlySet<number>>
  labelSync: Ref<(() => void) | null>
  engine: Ref<Graph | null>
  openNode: Ref<(i: number) => void>
  backgroundClick: Ref<() => void>
}

/** Builds the 3D scene in `el` (one WebGL context for the screen's life) and returns what tears it down. */
function makeScene(el: HTMLDivElement, r: SceneRefs): () => void {
  const { hover, chosenRef, shownRef, matchesRef, neighboursRef, labelSync, engine, openNode, backgroundClick } = r
  const colors = graphColors()
  const lit = (l: GLink) => {
    const s = endId(l.source)
    const t = endId(l.target)
    return [hover.current, chosenRef.current].some((id) => id !== null && (id === s || id === t))
  }
  // one texture and material per folder colour, one for the ring: never a canvas per note
  const discs = new Map<number, THREE.SpriteMaterial>()
  const disc = (root: number) => {
    let m = discs.get(root)
    if (!m) {
      m = new THREE.SpriteMaterial({ map: circle(colors.folder(root)), transparent: true, depthWrite: false })
      discs.set(root, m)
    }
    return m
  }
  const ring = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: circle(colors.ring, true), transparent: true, depthWrite: false }),
  )
  ring.raycast = noRaycast
  // labels are made the first time a note needs one, then only shown or hidden
  const labels = new Map<number, THREE.Sprite>()
  let wanted = new Set<number>()
  const labelOf = (n: GNode, r: number) => {
    let s = labels.get(n.id)
    if (!s) {
      const t = label(n.title, colors.ink)
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.tex, transparent: true, depthWrite: false }))
      s.scale.set(t.w * 0.12, t.h * 0.12, 1)
      s.position.set(r * 1.3 + (t.w * 0.12) / 2, r * 1.1, 0)
      s.raycast = noRaycast
      labels.set(n.id, s)
    }
    return s
  }
  const want = () => {
    wanted = labelled(shownRef.current, {
      hovered: hover.current,
      chosen: chosenRef.current,
      matches: matchesRef.current,
      neighbours: neighboursRef.current,
      top: 30,
    })
  }
  const sync = () => {
    want()
    for (const n of g.graphData().nodes as GNode[]) {
      const obj = n.__threeObj
      if (!obj) continue
      const r = radius(n.degree)
      const have = labels.get(n.id)
      if (wanted.has(n.id)) {
        const s = labelOf(n, r)
        if (s.parent !== obj) obj.add(s)
        s.visible = true
      } else if (have) have.visible = false
      if (n.id === chosenRef.current) {
        ring.scale.set(r * 2.7, r * 2.7, 1)
        if (ring.parent !== obj) obj.add(ring)
      }
    }
    if (chosenRef.current === null) ring.removeFromParent()
  }
  const g = (new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as Graph)
    .width(el.clientWidth)
    .height(el.clientHeight)
    .backgroundColor(colors.ground)
    .showNavInfo(false)
    .graphData({ nodes: [], links: [] })
    .nodeId('id')
    .nodeVal((n: GNode) => 1.5 + Math.sqrt(n.degree))
    .nodeLabel(() => '') // the label is the canvas text beside the disc, never HTML
    .nodeThreeObject((n: GNode) => {
      const r = radius(n.degree)
      const group = new THREE.Group()
      const d = new THREE.Sprite(disc(n.root))
      d.scale.set(r * 2, r * 2, 1)
      group.add(d)
      if (wanted.has(n.id)) {
        const l = labelOf(n, r)
        l.visible = true
        group.add(l)
      }
      if (n.id === chosenRef.current) {
        ring.scale.set(r * 2.7, r * 2.7, 1)
        group.add(ring)
      }
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
      sync()
      g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
    })
    .onNodeClick((n: GNode) => openNode.current(n.id))
    .onBackgroundClick(() => backgroundClick.current())
  g.d3Force('link')?.distance(60)
  g.d3Force('charge')?.strength(-140)
  // the first settle frames the whole graph; a later search must not yank the camera
  let fitted = false
  g.cooldownTicks(200).onEngineStop(() => {
    if (fitted) return
    fitted = true
    g.zoomToFit(400, 40)
  })
  g.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  engine.current = g
  labelSync.current = sync

  // orbit controls: wheel and pinch zoom, drag turns, right-drag or shift-drag pans, one finger turns and two pinch and pan
  const c = g.controls() as OrbitControls
  c.enableDamping = true
  c.dampingFactor = 0.12
  c.zoomSpeed = 1.2
  c.screenSpacePanning = true
  c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
  // a slow turn round the middle (none with reduced motion); the owner touching the graph stops it for good
  c.autoRotate = !reduced()
  c.autoRotateSpeed = 0.4
  const stop = () => {
    c.autoRotate = false
  }
  c.addEventListener('start', stop)
  // the wheel is the graph's: no page scroll or browser zoom may take it (OrbitControls does the zoom itself)
  const noScroll = (e: WheelEvent) => e.preventDefault()
  el.addEventListener('wheel', noScroll, { passive: false })

  // test hooks for the fake client only (Playwright reads the camera and where a note is on screen)
  const hooks = window as unknown as {
    __clioGraphCamera?: () => number
    __clioGraphNodeScreen?: (i: number) => { x: number; y: number } | null
  }
  if (import.meta.env.VITE_FAKE === '1') {
    hooks.__clioGraphCamera = () => g.camera().position.distanceTo(c.target)
    hooks.__clioGraphNodeScreen = (i) => {
      const n = (g.graphData().nodes as GNode[]).find((m) => m.id === i)
      if (!n || n.x === undefined) return null
      const p = g.graph2ScreenCoords(n.x, n.y ?? 0, n.z ?? 0)
      const r = el.getBoundingClientRect()
      return { x: r.left + p.x, y: r.top + p.y }
    }
  }

  const ro = new ResizeObserver(() => g.width(el.clientWidth).height(el.clientHeight))
  ro.observe(el)
  return () => {
    ro.disconnect()
    c.removeEventListener('start', stop)
    el.removeEventListener('wheel', noScroll)
    if (import.meta.env.VITE_FAKE === '1') {
      hooks.__clioGraphCamera = undefined
      hooks.__clioGraphNodeScreen = undefined
    }
    for (const m of discs.values()) {
      m.map?.dispose()
      m.dispose()
    }
    for (const s of labels.values()) {
      s.material.map?.dispose()
      s.material.dispose()
    }
    ring.material.map?.dispose()
    ring.material.dispose()
    labelSync.current = null
    g.renderer?.().forceContextLoss?.()
    g._destructor?.()
    engine.current = null
    el.replaceChildren()
  }
}

/** The folders, each a button that hides or shows its notes. */
function FolderLegend({
  roots,
  hidden,
  setHidden,
}: {
  roots: MemoryGraph['roots']
  hidden: ReadonlySet<number>
  setHidden: (f: (h: Set<number>) => Set<number>) => void
}) {
  const colors = graphColors()
  return (
    <ul aria-label={CLIO_TEXT.legend} className="m-0 flex list-none flex-wrap gap-2 p-0">
      {roots.map((r, i) => (
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
              'pointer-events-auto flex min-h-11 items-center gap-2 rounded-pill border border-line bg-surface/80 px-3 text-sm backdrop-blur',
              hidden.has(i) && 'text-text-2 line-through',
            )}
          >
            <span aria-hidden="true" className="size-3 rounded-pill" style={{ background: colors.folder(i) }} />
            {r.label}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** What is said over the graph: no match for the search, why it could not be drawn, or that there are no notes yet. */
function GraphNotes({ noMatch, error, empty }: { noMatch: boolean; error: string | null; empty: boolean }) {
  return (
    <>
      {noMatch && (
        <p className="pointer-events-none absolute top-3 left-1/2 m-0 -translate-x-1/2 rounded-button bg-surface px-3 py-2 text-sm">
          {CLIO_TEXT.noMatch}
        </p>
      )}
      {error ? (
        <p
          role="alert"
          className="pointer-events-none absolute inset-0 m-0 grid place-items-center p-4 text-sm text-text-2"
        >
          {error}
        </p>
      ) : empty ? (
        <p
          role="status"
          className="pointer-events-none absolute inset-0 m-0 grid place-items-center p-4 text-sm text-text-2"
        >
          {CLIO_TEXT.empty}
        </p>
      ) : null}
    </>
  )
}

export function ClioGraph() {
  const client = useTalosClient()
  const nav = useNavigate()
  const agent = useAgentName()
  const phone = useMediaQuery(PHONE_QUERY)
  const box = useRef<HTMLDivElement>(null)
  const engine = useRef<Graph | null>(null)
  const [data, setData] = useState<MemoryGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [chosen, setChosen] = useState<number | null>(null)
  const hover = useRef<number | null>(null)
  const chosenRef = useRef<number | null>(null)
  // the note open in the panel, and the notes opened before it (Back). The panel can browse past the graph: a linked note
  // that is not drawn opens there too, with nothing ringed.
  type Open = { rootId: string; path: string }
  const [note, setNote] = useState<Open | null>(null)
  const [trail, setTrail] = useState<Open[]>([])
  const lastNote = useRef<Open | null>(null) // the panel keeps its note while it slides out
  const shownRef = useRef<Shown>(EMPTY)
  const matchesRef = useRef<ReadonlySet<number>>(new Set())
  const neighboursRef = useRef<ReadonlySet<number>>(new Set())
  const labelSync = useRef<(() => void) | null>(null) // set by the scene: which notes show a label, and the ring

  const indexOf = (rootId: string, path: string) =>
    data ? data.nodes.findIndex((m) => data.roots[m.root]?.id === rootId && m.path === path) : -1
  /** Opens a note in the panel; with `from`, the note open now goes on the Back trail. */
  const open = (to: Open, from: Open | null) => {
    if (from) setTrail((t) => [...t, from])
    setNote(to)
    lastNote.current = to
    const i = indexOf(to.rootId, to.path)
    setChosen(i >= 0 ? i : null)
  }
  const close = () => {
    setNote(null)
    setTrail([])
    setChosen(null)
  }
  const back = () => {
    const prev = trail.at(-1)
    if (!prev) return
    setTrail((t) => t.slice(0, -1))
    open(prev, null)
  }
  // the scene is built once, so its clicks call through refs that always hold this render's functions
  const openNode = useRef<(i: number) => void>(() => {})
  openNode.current = (i) => {
    const n = data?.nodes[i]
    if (!data || !n) return
    open({ rootId: data.roots[n.root]?.id ?? '', path: n.path }, null)
    setTrail([])
  }
  // beside the graph (a wide screen) the panel stays while the owner moves around; the phone's sheet covers the graph, so a
  // tap on the graph closes it
  const backgroundClick = useRef<() => void>(() => {})
  backgroundClick.current = () => {
    if (phone) close()
  }

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
    return makeScene(el, {
      hover,
      chosenRef,
      shownRef,
      matchesRef,
      neighboursRef,
      labelSync,
      engine,
      openNode,
      backgroundClick,
    })
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
      const big = nodes.length > 1000
      shownRef.current = shown
      labelSync.current?.() // which notes are labelled, before the scene builds them
      g.linkOpacity(nodes.length > 800 ? 0.25 : 0.35)
        .cooldownTicks(big ? 120 : 200)
        .warmupTicks(0)
        .graphData({ nodes, links: shown.edges.map(([a, b]) => ({ source: a, target: b })) })
    }, 150)
    return () => clearTimeout(t)
  }, [shown, data])

  // search matches get labels while there are few of them
  useEffect(() => {
    matchesRef.current = matches
    labelSync.current?.()
  }, [matches])

  // the chosen note: its ring, its lit links (the scene reads it from chosenRef), and the camera looks at it
  useEffect(() => {
    chosenRef.current = chosen
    neighboursRef.current = data && chosen !== null ? new Set(linkedTo(data, chosen)) : new Set()
    const g = engine.current
    if (!g) return
    labelSync.current?.()
    g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
    if (chosen === null || reduced()) return
    const n = (g.graphData().nodes as GNode[]).find((m) => m.id === chosen)
    if (!n || n.x === undefined) return
    // keep the distance and the angle; only what the camera looks at moves
    const c = g.controls() as OrbitControls
    const at = new THREE.Vector3(n.x, n.y ?? 0, n.z ?? 0)
    const dir = g.camera().position.clone().sub(c.target)
    g.cameraPosition(at.clone().add(dir), at, 600)
  }, [chosen, data])

  // Escape closes the panel while a note is open
  useEffect(() => {
    if (note === null) return
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNote(null)
        setTrail([])
        setChosen(null)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [note])

  const isOpen = note !== null
  const panelNote = note ?? lastNote.current
  const panelIndex = panelNote ? indexOf(panelNote.rootId, panelNote.path) : -1
  const node = data && panelIndex >= 0 ? data.nodes[panelIndex] : undefined
  const folder = (i: number) => data?.roots[i]?.label ?? ''
  const openInClio = (rootId: string, path: string) =>
    nav(`/memory?r=${encodeURIComponent(rootId)}&n=${encodeURIComponent(path)}`)
  const chip = 'pointer-events-auto rounded-card bg-surface/80 backdrop-blur'
  const title = node?.title ?? (panelNote ? baseName(panelNote.path) : '')
  // kept mounted so it can slide out (it keeps its last note meanwhile)
  const panel = (place: string, state: string) => (
    <aside
      aria-label={CLIO_TEXT.panel}
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={cn(
        'flex flex-col border-line bg-surface duration-200 motion-reduce:transition-none',
        phone && 'transition-transform',
        place,
        state,
      )}
    >
      {panelNote && data && (
        <div className={cn('flex h-full min-h-0 flex-col', !phone && 'w-[min(32rem,45vw)]')}>
          <div className="flex items-start gap-2 border-b border-line p-3">
            {trail.length > 0 && (
              <button
                type="button"
                onClick={back}
                className="min-h-11 rounded-pill border border-line px-3 text-sm hover:bg-surface-2"
              >
                {CLIO_TEXT.backNote}
              </button>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="m-0 break-words text-base font-semibold">{title}</h2>
              {node && (
                <p className="m-0 text-xs text-text-2">
                  {folder(node.root)} · {CLIO_TEXT.links(linkedTo(data, panelIndex).length)}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => openInClio(panelNote.rootId, panelNote.path)}
              className="min-h-11 rounded-pill border border-line px-3 text-sm hover:bg-surface-2"
            >
              {CLIO_TEXT.open}
            </button>
            <button
              type="button"
              aria-label={CLIO_TEXT.close}
              onClick={close}
              className="min-h-11 min-w-11 rounded-pill border border-line text-lg hover:bg-surface-2"
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoteView
              key={`${panelNote.rootId}/${panelNote.path}`}
              rootId={panelNote.rootId}
              path={panelNote.path}
              agent={agent}
              onOpen={(rootId, path) => open({ rootId, path }, panelNote)}
            />
          </div>
        </div>
      )}
    </aside>
  )

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="clio-graph">
      <div className="relative min-w-0 flex-1 overflow-hidden" data-testid="clio-graph-area">
        <div
          ref={box}
          className="absolute inset-0 touch-none overscroll-contain"
          aria-label={CLIO_TEXT.canvas}
          role="img"
        />
        {!data && !error && <LoadingLine />}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-3">
          <div className={cn(chip, 'flex flex-wrap items-center gap-2 px-2')}>
            <Link to="/memory" className="min-h-11 content-center px-2 text-sm text-accent hover:underline">
              {CLIO_TEXT.back}
            </Link>
            <h1 className="m-0 font-display text-xl font-semibold">{CLIO_TEXT.title}</h1>
            {data && (
              <span className="text-sm text-text-2" data-testid="clio-graph-meta">
                {CLIO_TEXT.meta(data.nodes.length, data.total, data.edges.length)}
              </span>
            )}
          </div>
          <span className="flex-1" />
          <input
            type="search"
            aria-label={CLIO_TEXT.search}
            placeholder={CLIO_TEXT.search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pointer-events-auto min-h-11 w-48 rounded-pill border border-line bg-surface px-3 text-sm"
          />
        </div>
        <GraphNotes
          noMatch={!!q && !!shown && matches.size === 0}
          error={error}
          empty={!!data && data.nodes.length === 0}
        />
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-col gap-2">
          {data && data.roots.length > 1 && <FolderLegend roots={data.roots} hidden={hidden} setHidden={setHidden} />}
          {data?.truncated && (
            <p className={cn(chip, 'm-0 px-2 py-1 text-xs text-text-2')} data-testid="clio-graph-truncated">
              {CLIO_TEXT.truncated(data.nodes.length, data.total)}
            </p>
          )}
        </div>
        {phone &&
          panel(
            'absolute inset-x-0 bottom-0 z-20 h-[60%] border-t shadow-lg',
            isOpen ? 'translate-y-0' : 'translate-y-full',
          )}
      </div>
      {/* on a wide screen the panel opens beside the graph, which narrows to make room and stays live */}
      {!phone &&
        panel(
          'relative z-20 h-full shrink-0 overflow-hidden transition-[width]',
          isOpen ? 'w-[min(32rem,45vw)] border-l' : 'w-0',
        )}
    </div>
  )
}
