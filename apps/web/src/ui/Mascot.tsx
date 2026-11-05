// Little Talos (spec 8.9), drawn as a tondo: the black-figure robot in a terracotta disc with a black ring, the medallion
// at the bottom of a kylix cup. Each state plays one of the animated clips from assets/mascot/web (copied to
// public/brand/mascot/): HEVC with alpha (.mov) on Apple WebKit, VP9 with alpha (.webm) everywhere else, and a
// transparent PNG still (a frame of the same clip) as the poster and the fallback.
//
// Motion rules: `prefers-reduced-motion: reduce` always shows the still; only ONE mascot on the page plays at a time
// (the largest visible one wins, ties go to the newest); a mascot that is offscreen or in a hidden tab shows its still.
// The state is always also given in words (`role="img"` + label, or `decorative` when the words are already next to it).
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from './cn.ts'

export type MascotState = 'pleased' | 'working' | 'beaming' | 'worried' | 'listening' | 'speaking'

const LABEL: Record<MascotState, string> = {
  pleased: 'is ready',
  working: 'is working',
  beaming: 'is delighted',
  worried: 'is worried',
  listening: 'is listening',
  speaking: 'is speaking',
}

type ClipName = 'idle' | 'working' | 'talking' | 'beaming' | 'worried'

/** The clip each state plays. `beaming` and `worried` play once and hold their last frame. */
const CLIP: Record<MascotState, ClipName> = {
  pleased: 'idle',
  listening: 'idle',
  working: 'working',
  speaking: 'talking',
  beaming: 'beaming',
  worried: 'worried',
}
const ONCE = new Set<ClipName>(['beaming', 'worried'])

const BASE = '/brand/mascot/talos'
export const mascotStill = (state: MascotState) => `${BASE}-${CLIP[state]}.png`

/** Apple WebKit (Safari, every iOS browser) plays HEVC with alpha but not VP9 alpha; everyone else the reverse. */
function appleWebKit(): boolean {
  try {
    return typeof navigator !== 'undefined' && /Apple/.test(navigator.vendor ?? '')
  } catch {
    return false
  }
}
export function mascotSource(state: MascotState, apple = appleWebKit()): { src: string; type: string } {
  const clip = CLIP[state]
  return apple
    ? { src: `${BASE}-${clip}.mov`, type: 'video/quicktime' }
    : { src: `${BASE}-${clip}.webm`, type: 'video/webm' }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---- one clip at a time -------------------------------------------------------------------------------------------
type Entry = { id: number; size: number; visible: boolean }
const entries = new Map<number, Entry>()
const listeners = new Set<() => void>()
let playing: number | null = null
let nextId = 1

function elect() {
  const hidden = typeof document !== 'undefined' && document.hidden
  let best: Entry | null = null
  if (!hidden)
    for (const e of entries.values())
      if (e.visible && (!best || e.size > best.size || (e.size === best.size && e.id > best.id))) best = e
  const winner = best?.id ?? null
  if (winner === playing) return
  playing = winner
  for (const l of listeners) l()
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', elect)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const current = () => playing

/** True while this mascot holds the page's single "play" slot. */
function useClipTurn(size: number, wants: boolean, el: React.RefObject<HTMLElement | null>): boolean {
  const [id] = useState(() => nextId++)
  useEffect(() => {
    if (!wants) return
    const entry: Entry = { id, size, visible: true }
    entries.set(id, entry)
    let io: IntersectionObserver | null = null
    if (typeof IntersectionObserver === 'function' && el.current) {
      io = new IntersectionObserver((list) => {
        for (const x of list) entry.visible = x.isIntersecting
        elect()
      })
      io.observe(el.current)
    }
    elect()
    return () => {
      io?.disconnect()
      entries.delete(id)
      elect()
    }
  }, [id, size, wants, el])
  return useSyncExternalStore(subscribe, current, current) === id && wants
}

export function Mascot({
  state = 'pleased',
  size = 32,
  name = 'Talos',
  level,
  className,
  decorative,
  animate = true,
}: {
  state?: MascotState
  size?: number
  /** Agent name for the accessible label. */
  name?: string
  /** 0..1 output loudness for `speaking`. */
  level?: number
  className?: string
  /** The state is already stated in words next to it. */
  decorative?: boolean
  /** false: always the still (banners, rows). */
  animate?: boolean
}) {
  const root = useRef<HTMLSpanElement | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const clip = CLIP[state]
  const wants = animate && failed !== clip && !prefersReducedMotion()
  const turn = useClipTurn(size, wants, root)
  const still = mascotStill(state)
  const style: CSSProperties & Record<string, string | number> = { width: size, height: size }
  if (state === 'speaking' && level !== undefined) style['--mascot-level'] = Math.max(0, Math.min(1, level))
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': `${name} ${LABEL[state]}` } as const)
  const source = mascotSource(state)
  return (
    <span
      ref={root}
      className={cn('mascot', size >= 64 && 'mascot-lg', `mascot-${state}`, className)}
      data-state={state}
      data-clip={turn ? clip : undefined}
      style={style}
      {...a11y}
    >
      {turn ? (
        <video
          key={source.src}
          poster={still}
          width={size}
          height={size}
          autoPlay
          loop={!ONCE.has(clip)}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          onError={() => setFailed(clip)}
        >
          <source src={source.src} type={source.type} onError={() => setFailed(clip)} />
        </video>
      ) : (
        <img src={still} alt="" width={size} height={size} draggable={false} />
      )}
    </span>
  )
}
