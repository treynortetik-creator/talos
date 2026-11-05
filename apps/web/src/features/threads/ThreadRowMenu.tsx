// Quick actions on a thread row (D36): Mark read / Mark unread, Mute, Archive. A long press or a right-click opens the
// menu on any row (the Threads list and the phone's left menu); the Threads list rows also swipe (right: read or unread,
// left: Archive), copied from the inbox rows (inbox/EventRow.tsx).
//
// Mark read and Mark unread go through the relay and need only a connection. Mute and Archive are config patches
// (useThreadPatch), so they need the Mac online, and Archive keeps ThreadEditor's rule: not the default thread, not a system
// thread, not the last active one. Marking from INSIDE an open thread is not here: that screen is Timeline.tsx.
import type { ThreadT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/index.ts'
import { EDGE_PX } from '../phone/edgeSwipe.ts'
import { useThreadPatch } from './manage/useThreadPatch.ts'
import { notifyAfterUnmute, rememberNotify } from './prevNotify.ts'
import { readUpTo } from './readSeq.ts'

const PRESS_MS = 500
const PRESS_SLOP_PX = 10
/** After the finger lifts from a long press, the taps the browser fakes (mouse, focus, click) are not a dismissal or a tap. */
const LIFT_GRACE_MS = 600
const SWIPE_PX = 80
const SWIPE_START_PX = 8
/** A swipe starts clear of both screen edges, which belong to the edge swipes that open the menu and the session panel. */
const EDGE_CLEAR_PX = EDGE_PX + 12

/**
 * Why a thread cannot be archived, or null when it can. The same three rules ThreadEditor applies to its Archive button:
 * the default thread and a system thread stay, and so does the last active (non-inbox) thread.
 */
export function archiveBlockedReason(t: ThreadT, threads: readonly ThreadT[], defaultThread: string): string | null {
  if (t.archived) return null // restoring is always fine
  if (t.kind === 'system') return 'This thread cannot be archived.'
  if (t.id === defaultThread) return 'Pick another default thread first.'
  if (threads.filter((x) => !x.archived && x.id !== 'inbox').length <= 1) return 'Keep at least one active thread.'
  return null
}

export function ThreadRowMenu({
  thread,
  swipe = false,
  children,
  className,
}: {
  thread: ThreadT
  /** Swipe right for read or unread, left for Archive. The Threads list only. */
  swipe?: boolean
  children: ReactNode
  className?: string
}) {
  const client = useTalosClient()
  const unread = useTalos((s) => ownValue(s.unread, thread.id) ?? 0)
  const { threads, defaultThread, macOnline, busy, err, apply, setErr } = useThreadPatch()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null)
  const from = useRef<{ x: number; y: number } | null>(null)
  const touching = useRef(false)
  const armed = useRef(false) // the menu was opened by a finger that has not finished lifting
  const swiping = useRef(false)
  const suppressClick = useRef(false) // the click the browser makes after a long press or a swipe is not a tap on the link
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current)
      if (grace.current) clearTimeout(grace.current)
    },
    [],
  )

  const blocked = archiveBlockedReason(thread, threads, defaultThread)
  const muted = thread.notify === 'off'
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }
  const openMenu = (why: string | null = null) => {
    armed.current = touching.current
    if (armed.current) suppressClick.current = true
    setNote(why)
    setErr(null)
    setOpen(true)
  }
  const lifted = () => {
    touching.current = false
    cancelPress()
    from.current = null
    if (!armed.current && !suppressClick.current) return
    if (grace.current) clearTimeout(grace.current)
    grace.current = setTimeout(() => {
      armed.current = false
      suppressClick.current = false
      grace.current = null
    }, LIFT_GRACE_MS)
  }

  /** True when it worked. Read and unread both go through the relay: they need a live socket and a pinned device. */
  const toggleRead = (): boolean => {
    if (unread > 0) return client.markThreadRead(thread.id, readUpTo(client.store.getState()), { needConnection: true })
    return client.markThreadUnread(thread.id)
  }
  const unreadFailed = 'Could not reach the relay. Try again when you are back online.'
  const onToggleRead = () => {
    if (toggleRead()) setOpen(false)
    else setNote(unreadFailed)
  }
  const onMute = async () => {
    const before = thread.notify
    const to = muted ? notifyAfterUnmute(thread.id) : 'off'
    if (await apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, notify: to } : t)))) {
      if (!muted) rememberNotify(thread.id, before)
      setOpen(false)
    }
  }
  const onArchive = async (fromSwipe = false): Promise<boolean> => {
    const ok = await apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, archived: !t.archived } : t)))
    if (ok && !fromSwipe) setOpen(false)
    return ok
  }

  const swipeDown = (e: React.PointerEvent) => {
    if (!swipe || e.pointerType !== 'touch') return
    const w = window.innerWidth
    swiping.current = e.clientX >= EDGE_CLEAR_PX && e.clientX <= w - EDGE_CLEAR_PX
  }
  const swipeMove = (e: React.PointerEvent) => {
    if (!swiping.current || !from.current) return
    const x = e.clientX - from.current.x
    if (dxRef.current === 0 && (Math.abs(x) < SWIPE_START_PX || Math.abs(e.clientY - from.current.y) > Math.abs(x)))
      return
    cancelPress()
    suppressClick.current = true
    dxRef.current = Math.max(-160, Math.min(160, x))
    setDx(dxRef.current)
  }
  const swipeEnd = () => {
    if (!swiping.current) return
    swiping.current = false
    const final = dxRef.current
    dxRef.current = 0
    setDx(0)
    if (final >= SWIPE_PX) {
      if (!toggleRead()) openMenu(unreadFailed)
    } else if (final <= -SWIPE_PX) {
      if (blocked || !macOnline) openMenu(blocked ?? 'Your Mac has to be online to archive a thread.')
      // No popover is open on a swipe, so a failure (the Mac refused a second change made on the same base, it dropped
      // mid-way, a timeout) opens it, with the reason in it: the row must not just snap back and say nothing.
      else
        void onArchive(true).then((ok) => {
          if (ok) return
          armed.current = false
          setNote(null)
          setOpen(true)
        })
    }
  }

  const readLabel = unread > 0 ? 'Mark read' : 'Mark unread'
  const mac = 'Your Mac has to be online for this.'
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setNote(null)
      }}
    >
      <PopoverAnchor asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: long press, right-click and swipe are the touch and mouse routes; the keyboard route is the context-menu key on the link itself */}
        <div
          className={cn('relative overflow-hidden', className)}
          data-testid={`menu-wrap-${thread.id}`}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu()
          }}
          onClickCapture={(e) => {
            if (!suppressClick.current) return
            suppressClick.current = false
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== 'touch') return
            touching.current = true
            suppressClick.current = false
            cancelPress()
            from.current = { x: e.clientX, y: e.clientY }
            press.current = setTimeout(() => {
              press.current = null
              openMenu()
            }, PRESS_MS)
            swipeDown(e)
          }}
          onPointerMove={(e) => {
            const f = from.current
            if (!f) return
            if (Math.hypot(e.clientX - f.x, e.clientY - f.y) > PRESS_SLOP_PX) cancelPress()
            swipeMove(e)
          }}
          onPointerUp={(e) => {
            if (e.pointerType !== 'touch') return
            swipeEnd()
            lifted()
          }}
          onPointerCancel={(e) => {
            if (e.pointerType !== 'touch') return
            swiping.current = false
            dxRef.current = 0
            setDx(0)
            lifted()
          }}
        >
          {swipe && dx !== 0 && (
            <div
              aria-hidden
              className="absolute inset-0 flex items-center justify-between bg-surface-2 px-4 text-sm font-medium"
            >
              <span className="text-info">{readLabel}</span>
              <span className="text-danger">{thread.archived ? 'Restore' : 'Archive'}</span>
            </div>
          )}
          <div
            // iOS draws its own callout and selects text on a long press of a link; ours is the menu.
            className={cn(
              'relative select-none [-webkit-touch-callout:none]',
              swipe && 'touch-pan-y bg-bg',
              dx === 0 && 'transition-transform duration-[var(--dur-1)] ease-talos',
            )}
            style={dx === 0 ? undefined : { transform: `translateX(${dx}px)` }}
          >
            {children}
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="flex w-56 flex-col gap-1 p-1"
        align="end"
        data-testid="row-menu"
        // The finger that opened the menu is still down, or has only just lifted: the focus and click events the browser
        // makes up from it land outside the menu and must not close it.
        onInteractOutside={(e) => {
          if (armed.current) e.preventDefault()
        }}
      >
        <button
          type="button"
          data-testid="row-read"
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2"
          onClick={onToggleRead}
        >
          {readLabel}
        </button>
        <button
          type="button"
          data-testid="row-mute"
          disabled={!macOnline || busy}
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2 disabled:opacity-50"
          onClick={() => void onMute()}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          data-testid="row-archive"
          disabled={!macOnline || busy || blocked !== null}
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2 disabled:opacity-50"
          onClick={() => void onArchive()}
        >
          {thread.archived ? 'Restore' : 'Archive'}
        </button>
        {(note ?? err ?? blocked ?? (!macOnline ? mac : null)) && (
          <p role="status" data-testid="row-menu-note" className="m-0 px-3 pb-2 text-xs text-text-2">
            {note ?? err ?? blocked ?? mac}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
