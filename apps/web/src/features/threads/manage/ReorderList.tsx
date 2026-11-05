// A reorderable list (docs/THREADS.md). Drag the handle with a mouse, finger or pen (pointer events, so it works on
// iOS and Android without a library), or focus it and press Space to pick up, arrows to move, Space to drop, Escape to
// cancel. Optional Move up / Move down buttons for phones. The parent saves the new order; while that is in flight the
// list shows it, and it snaps back if the save fails.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../../../ui/cn.ts'
import { moveItem, slotShift, targetIndex } from './reorder.ts'

type Item = { id: string; label: string }

export function ReorderList<T extends Item>({
  items,
  onCommit,
  renderRow,
  moveButtons = false,
  disabled = false,
  tone = 'surface',
  label,
  testId,
}: {
  items: readonly T[]
  /** Resolves true when saved; false snaps the list back. */
  onCommit: (ids: string[]) => Promise<boolean>
  renderRow: (item: T) => ReactNode
  moveButtons?: boolean
  disabled?: boolean
  tone?: 'surface' | 'chrome'
  label: string
  testId?: string
}) {
  const ids = items.map((i) => i.id).join('|')
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id))
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number; to: number } | null>(null)
  const [grabbed, setGrabbed] = useState<{ id: string; before: string[] } | null>(null)
  const [say, setSay] = useState('')
  const rects = useRef<DOMRect[]>([])
  const startY = useRef(0)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const moving = useRef(false) // a keyed move blurs the focused handle; that blur must not cancel the pick-up

  // Saves run one at a time (each needs the Mac to confirm the last rev); moves made meanwhile are coalesced into one
  // more save of the latest order. A refused save snaps the list back to what the store holds.
  const saving = useRef(false)
  const queued = useRef<string[] | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const itemsRef = useRef(items)
  itemsRef.current = items
  const persist = async (next: string[]) => {
    if (saving.current) {
      queued.current = next
      return
    }
    saving.current = true
    let target: string[] | null = next
    let ok = true
    while (target) {
      queued.current = null
      ok = await commitRef.current(target)
      if (!ok) break
      target = queued.current
    }
    saving.current = false
    queued.current = null
    if (!ok) setOrder(itemsRef.current.map((i) => i.id))
  }

  // follow the store unless the owner is mid-move or a save is still in flight
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` is the stable key for `items`
  useEffect(() => {
    if (!drag && !grabbed && !saving.current) setOrder(items.map((i) => i.id))
  }, [ids])

  const byId = new Map(items.map((i) => [i.id, i]))
  const shown = order.map((id) => byId.get(id)).filter((x): x is T => x !== undefined)
  const name = (id: string) => byId.get(id)?.label ?? id

  const commit = (next: string[]) => {
    const before = order
    setOrder(next)
    if (next.join('|') !== before.join('|')) void persist(next)
  }

  const start = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || e.button > 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    rects.current = order.map((x) => rows.current.get(x)?.getBoundingClientRect() ?? new DOMRect())
    startY.current = e.clientY
    const from = order.indexOf(id)
    setDrag({ id, from, dy: 0, to: from })
  }
  const move = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return
    const dy = e.clientY - startY.current
    setDrag({ ...drag, dy, to: targetIndex(rects.current, drag.from, dy) })
  }
  const end = () => {
    if (!drag) return
    const next = moveItem(order, drag.from, drag.to)
    setDrag(null)
    if (drag.to !== drag.from) {
      setSay(`${name(drag.id)} moved to position ${drag.to + 1} of ${order.length}.`)
      commit(next)
    }
  }

  const key = (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (disabled) return
    const i = order.indexOf(id)
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (!grabbed) {
        setGrabbed({ id, before: order })
        setSay(`${name(id)} picked up, position ${i + 1} of ${order.length}. Arrow keys move it, Space drops it.`)
      } else {
        const changed = grabbed.before.join('|') !== order.join('|')
        setGrabbed(null)
        setSay(`${name(id)} dropped at position ${i + 1} of ${order.length}.`)
        if (changed) void persist(order)
      }
      return
    }
    if (e.key === 'Escape' && grabbed) {
      e.preventDefault()
      setOrder(grabbed.before)
      setGrabbed(null)
      setSay(`Move cancelled. ${name(id)} is back at position ${grabbed.before.indexOf(id) + 1}.`)
      return
    }
    if (grabbed && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1
      if (j < 0 || j >= order.length) return
      moving.current = true
      setOrder(moveItem(order, i, j))
      setSay(`${name(id)}, position ${j + 1} of ${order.length}.`)
      requestAnimationFrame(() => {
        handles.current.get(id)?.focus()
        moving.current = false
      })
    }
  }

  const moveBtns = useRef(new Map<string, HTMLButtonElement>())
  const step = (id: string, d: -1 | 1) => {
    const i = order.indexOf(id)
    const j = i + d
    if (j < 0 || j >= order.length) return
    setSay(`${name(id)} moved to position ${j + 1} of ${order.length}.`)
    commit(moveItem(order, i, j))
    // the keyed row moves in the DOM, which drops focus: put it back on the same arrow (or the other one at an edge)
    requestAnimationFrame(() => {
      const same = moveBtns.current.get(`${id}:${d}`)
      const other = moveBtns.current.get(`${id}:${-d}`)
      const target = same && !same.disabled ? same : other && !other.disabled ? other : handles.current.get(id)
      target?.focus()
    })
  }
  const btnRef = (id: string, d: -1 | 1) => (el: HTMLButtonElement | null) => {
    if (el) moveBtns.current.set(`${id}:${d}`, el)
    else moveBtns.current.delete(`${id}:${d}`)
  }

  const chrome = tone === 'chrome'
  const iconBtn = cn(
    'grid size-11 shrink-0 place-items-center rounded-button disabled:opacity-40',
    chrome ? 'text-on-chrome-2 hover:bg-chrome-hover' : 'text-text-2 hover:bg-surface-2',
  )
  const hint = `reorder-hint-${testId ?? 'list'}`
  return (
    <>
      <p id={hint} className="sr-only">
        Drag the handle, or focus it and press Space, then the arrow keys, then Space again.
      </p>
      <ul aria-label={label} data-testid={testId} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {shown.map((item, i) => {
          const isDrag = drag?.id === item.id
          const h = drag ? (rects.current[drag.from]?.height ?? 0) : 0
          const shift = drag && !isDrag ? slotShift(drag.from, drag.to, order.indexOf(item.id), h + 2) : 0
          return (
            <li
              key={item.id}
              ref={(el) => {
                if (el) rows.current.set(item.id, el)
                else rows.current.delete(item.id)
              }}
              data-reorder-row={item.id}
              style={
                isDrag
                  ? { transform: `translateY(${drag.dy}px)`, zIndex: 2, position: 'relative' }
                  : shift
                    ? { transform: `translateY(${shift}px)` }
                    : undefined
              }
              className={cn(
                'flex min-h-11 items-center gap-1 rounded-button',
                !isDrag && 'transition-transform duration-[var(--dur-2)] ease-talos',
                isDrag && (chrome ? 'bg-chrome-active shadow-lg' : 'bg-surface-2 shadow-lg'),
                grabbed?.id === item.id && 'outline-2 outline-focus',
              )}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) handles.current.set(item.id, el)
                  else handles.current.delete(item.id)
                }}
                aria-label={`Reorder ${item.label}`}
                aria-describedby={hint}
                aria-pressed={grabbed?.id === item.id}
                disabled={disabled}
                data-testid={`reorder-handle-${item.id}`}
                onPointerDown={(e) => start(e, item.id)}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onKeyDown={(e) => key(e, item.id)}
                onBlur={() => {
                  if (grabbed?.id === item.id && !moving.current) {
                    setOrder(grabbed.before)
                    setGrabbed(null)
                  }
                }}
                className={cn(iconBtn, 'cursor-grab touch-none active:cursor-grabbing')}
              >
                <Grip />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">{renderRow(item)}</div>
              {moveButtons && (
                <>
                  <button
                    type="button"
                    ref={btnRef(item.id, -1)}
                    aria-label={`Move ${item.label} up`}
                    disabled={disabled || i === 0}
                    onClick={() => step(item.id, -1)}
                    className={iconBtn}
                  >
                    <Arrow up />
                  </button>
                  <button
                    type="button"
                    ref={btnRef(item.id, 1)}
                    aria-label={`Move ${item.label} down`}
                    disabled={disabled || i === shown.length - 1}
                    onClick={() => step(item.id, 1)}
                    className={iconBtn}
                  >
                    <Arrow />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <p aria-live="assertive" className="sr-only" data-testid="reorder-announce">
        {say}
      </p>
    </>
  )
}

function Grip() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[6, 12, 18].map((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.6} />))}
    </svg>
  )
}

function Arrow({ up }: { up?: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={up ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'} />
    </svg>
  )
}
