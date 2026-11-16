// The picture of the screen with the owner's marks over it. Pointer input makes marks; `render` in ink.ts draws them, for the
// screen and for the exported picture alike.
import { type PointerEvent, useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { type Mark, type Pt, render, type Tool, worthKeeping } from './ink.ts'
import { BUG_TEXT } from './text.ts'

export function Annotator({
  base,
  captured,
  marks,
  setMarks,
  tool,
  ink,
  fit,
}: {
  base: HTMLCanvasElement
  /** Whether the picture is a real capture of the page (false: the plain "no screenshot" canvas). */
  captured: boolean
  marks: Mark[]
  setMarks: (m: Mark[]) => void
  tool: Tool
  ink: number
  /** Shown whole and as large as the room allows (a phone's tall picture), centred in a full-width frame. */
  fit?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [live, setLive] = useState<Mark | null>(null)
  const [typing, setTyping] = useState<{ at: Pt } | null>(null)
  const [word, setWord] = useState('')
  const textId = useId()

  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    c.width = base.width
    c.height = base.height
    render(ctx, base, live ? [...marks, live] : marks)
  }, [base, marks, live])

  const point = (e: PointerEvent): Pt => {
    const r = (ref.current as HTMLCanvasElement).getBoundingClientRect()
    const k = base.width / (r.width || 1)
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }
  }
  const start = (e: PointerEvent) => {
    const p = point(e)
    if (tool === 'text') {
      // keep the click from moving focus off the field that is about to appear
      e.preventDefault()
      commitWord()
      setTyping({ at: p })
      setWord('')
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (tool === 'pen') setLive({ kind: 'pen', ink, pts: [p] })
    else if (tool === 'blur') setLive({ kind: 'blur', from: p, to: p })
    else setLive({ kind: tool, ink, from: p, to: p })
  }
  const move = (e: PointerEvent) => {
    if (!live) return
    const p = point(e)
    if (live.kind === 'pen') setLive({ ...live, pts: [...live.pts, p] })
    else if (live.kind !== 'text') setLive({ ...live, to: p })
  }
  const end = () => {
    if (live && worthKeeping(live)) setMarks([...marks, live])
    setLive(null)
  }
  const commitWord = () => {
    if (typing && word.trim())
      setMarks([...marks, { kind: 'text', ink, at: typing.at, text: word.trim().slice(0, 120) }])
    setTyping(null)
    setWord('')
  }

  const picture = (
    <div
      className={cn(
        'relative overflow-hidden',
        fit ? 'w-fit max-w-full' : 'w-full rounded-card border border-line bg-surface-2',
      )}
    >
      <canvas
        ref={ref}
        aria-label={BUG_TEXT.canvasLabel}
        role="img"
        data-testid="bug-canvas"
        data-capture={captured ? 'ok' : 'failed'}
        className={cn(
          'block h-auto touch-none cursor-crosshair',
          fit ? 'max-h-[min(330px,40dvh)] w-auto max-w-full' : 'w-full',
        )}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      {typing ? (
        <input
          id={textId}
          // biome-ignore lint/a11y/noAutofocus: the field exists because the owner just chose a spot for the words
          autoFocus
          data-bug-text
          aria-label={BUG_TEXT.textPrompt}
          value={word}
          maxLength={120}
          onChange={(e) => setWord(e.target.value)}
          onBlur={commitWord}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitWord()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setTyping(null)
            }
          }}
          // placed as a share of the picture, so it stays on the spot when the picture is resized (a phone keyboard opening);
          // on the right half it grows leftwards, so it is not cut off at the edge of a narrow picture
          style={fieldAt(typing.at, base)}
          className="absolute w-24 rounded-button border border-line bg-surface px-2 py-1 text-md text-text"
        />
      ) : null}
    </div>
  )
  if (!fit) return picture
  return (
    <div className="flex w-full justify-center overflow-hidden rounded-card border border-line bg-surface-2">
      {picture}
    </div>
  )
}

const pct = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`
/** Where the field for a word sits: at the spot, as wide as the room left on that side, and never below the picture. */
function fieldAt(at: Pt, base: HTMLCanvasElement) {
  const x = at.x / (base.width || 1)
  const top = `min(${pct(at.y / (base.height || 1))}, calc(100% - 2.5rem))`
  return x > 0.5 ? { right: pct(1 - x), top, maxWidth: pct(x) } : { left: pct(x), top, maxWidth: pct(1 - x) }
}
