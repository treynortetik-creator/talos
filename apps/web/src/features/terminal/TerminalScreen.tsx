// The agent's terminal, inside the Mac app's own window. The terminal is a native view on this Mac that the app lays over
// this empty space: the page only says where the space is (`terminal_view`) and nothing else. Nothing here touches the
// client or the relay; a browser or the phone app has no shell, so the route sends them back to Home.
import { TERMINAL_RECT_MAX } from '@talos-app/protocol'
import { useLayoutEffect, useRef } from 'react'
import { Navigate } from 'react-router'
import type { ShellBridge } from '../../lib/native/bridge.ts'
import { getShell } from '../../lib/native/shell.ts'

const whole = (n: number) => Math.min(TERMINAL_RECT_MAX, Math.max(0, Math.round(n)))

function Space({ bridge }: { bridge: ShellBridge }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let last = ''
    const send = (rect: { x: number; y: number; width: number; height: number } | null) => {
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      bridge.send({ type: 'terminal_view', rect })
    }
    // A sheet or dialog is page UI the terminal would sit over: while one is open the view is closed.
    const covered = () =>
      document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
    const report = () => {
      const r = el.getBoundingClientRect()
      const rect = { x: whole(r.left), y: whole(r.top), width: whole(r.width), height: whole(r.height) }
      send(rect.width > 0 && rect.height > 0 && !covered() ? rect : null)
    }
    report()
    const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null
    watcher?.observe(el)
    window.addEventListener('resize', report)
    // Dialogs mount in a portal on the body.
    const dialogs = new MutationObserver(report)
    dialogs.observe(document.body, { childList: true })
    return () => {
      watcher?.disconnect()
      dialogs.disconnect()
      window.removeEventListener('resize', report)
      last = ''
      send(null)
    }
  }, [bridge])
  return (
    <section
      aria-label="Terminal"
      data-testid="terminal-space"
      ref={ref}
      className="h-full min-w-0 p-6 text-sm text-text-2"
    >
      <p>
        The agent's terminal shows in this space when there is room for 80 columns and 24 rows. Make the window bigger
        if it does not. If it still does not, this Mac app is older than this page: update the Mac app.
      </p>
    </section>
  )
}

export function TerminalScreen() {
  const shell = getShell()
  if (!shell) return <Navigate to="/" replace />
  return <Space bridge={shell.bridge} />
}
