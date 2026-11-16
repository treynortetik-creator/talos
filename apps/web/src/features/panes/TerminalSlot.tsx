// The Terminal pane's slot (docs/TERMINAL-PANE.md): the Mac app lays the owner's own shell, a native view, over this box. The
// page only says WHERE the box is and for WHICH thread (`shell_pane`), or that it is not showing (`rect: null`), and that the
// owner closed the pane (`shell_pane_close`). Nothing else crosses: no folder, no command, no text. Without the Mac app's
// `shell-pane` feature the box keeps its words: "Terminal is available in the Talos Mac app".
import { SHELL_FEATURE_SHELL_PANE, TERMINAL_RECT_MAX } from '@talos-app/protocol'
import { useEffect, useRef } from 'react'
import { getShell, shellFeatures } from '../../lib/native/shell.ts'
import { onShellReady } from '../native/shellReady.ts'

export const TERMINAL_TEXT = {
  elsewhere: 'Terminal is available in the Talos Mac app',
  here: "Your Mac's shell, in this thread's folder",
} as const

/** Whether this page can show the owner's shell: the Mac app, with the pane feature in its user agent. */
export function shellPaneHere(): boolean {
  return getShell()?.kind === 'desktop' && shellFeatures().includes(SHELL_FEATURE_SHELL_PANE)
}

/** Something drawn over the page that the native view (opaque, on top) would hide: a dialog, a sheet, a menu or popover. */
const covered = () =>
  document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"], [data-radix-popper-content-wrapper]',
  ) !== null

const clamp = (n: number) => Math.min(TERMINAL_RECT_MAX, Math.max(0, Math.round(n)))

/**
 * Tells the Mac app where the slot is for `threadId`: on mount, on every move or resize, after every `ready`, and `null`
 * while `showing` is false or something covers it. Switching threads is one message with the new id; leaving (the pane
 * closed by layout, the route left) is one `null` for the thread it was showing.
 */
export function TerminalSlot({ threadId, showing }: { threadId: string; showing: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const thread = useRef(threadId)
  const live = useRef(showing)
  const sent = useRef<string | null>(null)
  const here = shellPaneHere()

  const send = useRef((force = false) => {
    const shell = getShell()
    const el = box.current
    if (!shell || !el) return
    const r = el.getBoundingClientRect()
    const rect =
      live.current && !covered() && r.width > 0 && r.height > 0
        ? { x: clamp(r.left), y: clamp(r.top), width: clamp(r.width), height: clamp(r.height) }
        : null
    const key = JSON.stringify([thread.current, rect])
    if (!force && key === sent.current) return
    sent.current = key
    shell.bridge.send({ type: 'shell_pane', thread_id: thread.current, rect })
  })

  // the thread or visibility changed: one message with what is true now
  useEffect(() => {
    thread.current = threadId
    live.current = showing
    if (here) send.current()
  }, [threadId, showing, here])

  useEffect(() => {
    if (!here) return
    let frame = 0
    const soon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => send.current())
    }
    const ro = new ResizeObserver(soon)
    if (box.current) ro.observe(box.current)
    window.addEventListener('resize', soon)
    window.addEventListener('scroll', soon, true)
    // a dialog, sheet or menu opening anywhere covers the slot; its closing uncovers it
    const mo = new MutationObserver(soon)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
    const offReady = onShellReady(() => send.current(true))
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', soon)
      window.removeEventListener('scroll', soon, true)
      offReady()
      // the pane went away without the owner closing it (layout, route): hidden, the shells keep running
      getShell()?.bridge.send({ type: 'shell_pane', thread_id: thread.current, rect: null })
    }
  }, [here])

  return (
    <div
      ref={box}
      data-testid="terminal-slot"
      className="grid min-h-[110px] min-w-[180px] flex-1 place-items-center bg-[#0b0c0e] p-4 text-center text-sm text-white/70"
    >
      {here ? TERMINAL_TEXT.here : TERMINAL_TEXT.elsewhere}
    </div>
  )
}

/** The owner's own close of the Terminal pane: its shells end (never sent for a hidden tab or a route change). */
export function closeShellPane(threadId: string): void {
  if (shellPaneHere()) getShell()?.bridge.send({ type: 'shell_pane_close', thread_id: threadId })
}
