// The Terminal screen, inside the Mac app's own window: a strip of tabs (Main and every thread that has its own session) over the
// raw Claude CLI terminal. The terminal is a native view on this Mac that the app lays over the empty space under the strip: the
// page only says where the space is and which session it shows (`terminal_view`), and asks for a parked thread to start
// (`terminal_resume`). Nothing here touches the client or the relay; a browser or the phone app has no shell, so the route sends
// them back to Home.
import { TERMINAL_RECT_MAX, type TerminalSessionItemT } from '@talos-app/protocol'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router'
import type { ShellBridge } from '../../lib/native/bridge.ts'
import { getShell } from '../../lib/native/shell.ts'
import { Button } from '../../ui/button.tsx'
import { cn } from '../../ui/cn.ts'
import { rememberedTab, rememberTab, resumeSentence, useTerminalSessions } from './sessions.ts'

const whole = (n: number) => Math.min(TERMINAL_RECT_MAX, Math.max(0, Math.round(n)))

const MAIN: TerminalSessionItemT = {
  id: 'main',
  name: 'Main',
  state: 'unknown',
  key: '1',
  panel: 'terminal',
  action: null,
  detail: '',
}

/** The word beside a tab's dot, in the owner's words. */
const STATE_WORD: Record<TerminalSessionItemT['state'], string> = {
  live: 'live',
  idle: 'live',
  working: 'working',
  starting: 'starting',
  stopping: 'stopping',
  parked: 'parked',
  not_started: 'not started',
  failed: 'failed',
  needs_you: 'needs you',
  unknown: '',
}
const DOT: Record<TerminalSessionItemT['state'], string> = {
  live: 'bg-ok',
  idle: 'bg-ok',
  working: 'bg-info',
  starting: 'bg-info',
  stopping: 'bg-text-2',
  parked: 'bg-text-2',
  not_started: 'bg-text-2',
  failed: 'bg-danger',
  needs_you: 'bg-warn',
  unknown: 'bg-text-2',
}

/** Where the native terminal goes: the space under the tabs, reported in page pixels. `shown` false = the page has its own panel there. */
function Space({
  bridge,
  session,
  shown,
  children,
}: {
  bridge: ShellBridge
  session: string
  shown: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const want = useRef({ session, shown })
  want.current = { session, shown }
  const reportRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let last = ''
    const send = (rect: { x: number; y: number; width: number; height: number } | null) => {
      const { session: s } = want.current
      const key = JSON.stringify([rect, s])
      if (key === last) return
      last = key
      // Main is sent without a session: a Mac app that predates the tabs refuses a message with the field.
      bridge.send(s === 'main' ? { type: 'terminal_view', rect } : { type: 'terminal_view', rect, session: s })
    }
    // A sheet or dialog is page UI the terminal would sit over: while one is open the view is closed.
    const covered = () =>
      document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
    const report = () => {
      const r = el.getBoundingClientRect()
      const rect = { x: whole(r.left), y: whole(r.top), width: whole(r.width), height: whole(r.height) }
      send(want.current.shown && rect.width > 0 && rect.height > 0 && !covered() ? rect : null)
    }
    reportRef.current = report
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
      reportRef.current = () => {}
      last = ''
      want.current = { session: 'main', shown: false }
      send(null)
      // "No terminal" is not "left the screen": this is the one message that says the screen is gone.
      bridge.send({ type: 'terminal_leave' })
    }
  }, [bridge])
  // Switching tabs, or a panel taking the space, is told to the Mac at once: one message, no close-and-reopen in between.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session and shown are what this effect reacts to
  useLayoutEffect(() => reportRef.current(), [session, shown])
  return (
    <section
      aria-label="Terminal"
      data-testid="terminal-space"
      ref={ref}
      className="min-h-0 min-w-0 flex-1 overflow-auto text-sm text-text-2"
    >
      {children}
    </section>
  )
}

function Tab({
  item,
  selected,
  onPick,
  tabRef,
}: {
  item: TerminalSessionItemT
  selected: boolean
  onPick: () => void
  tabRef: (el: HTMLButtonElement | null) => void
}) {
  const word = STATE_WORD[item.state]
  return (
    <button
      type="button"
      role="tab"
      id={`term-tab-${item.id}`}
      ref={tabRef}
      aria-selected={selected}
      aria-controls="term-panel"
      aria-keyshortcuts={item.key ? `Control+${item.key}` : undefined}
      tabIndex={selected ? 0 : -1}
      data-testid={`terminal-tab-${item.id}`}
      data-state={item.state}
      onClick={onPick}
      className={cn(
        '-mb-px flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm text-text transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
        selected ? 'border-accent bg-bg font-semibold' : 'border-transparent',
      )}
    >
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-pill', DOT[item.state])} />
      <span className="max-w-40 truncate">{item.name}</span>
      {word && <span className="text-xs font-normal text-text-2">{word}</span>}
    </button>
  )
}

/** What stands in place of the terminal for a session that has none: Resume, the error, or a plain line. */
function Panel({ item, bridge }: { item: TerminalSessionItemT; bridge: ShellBridge }) {
  const mine = useTerminalSessions((s) => s.resume[item.id]) ?? null
  const clearResume = useTerminalSessions((s) => s.clearResume)
  const [pending, setPending] = useState(false)
  const [silent, setSilent] = useState(false)
  const verb = item.action === 'start' ? 'start' : 'resume'
  // This panel is mounted per tab (keyed by id). What the last press said is cleared when the owner leaves this tab, and goes
  // stale by itself when the tab changes state (the store drops it); another tab's answer is never touched here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the id is the trigger
  useEffect(() => () => clearResume(item.id), [item.id, clearResume])
  useEffect(() => {
    if (mine) setPending(false)
  }, [mine])
  // An older Mac app never answers: that must read as "no answer", not as nothing happening.
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => {
      setPending(false)
      setSilent(true)
    }, 6000)
    return () => clearTimeout(t)
  }, [pending])
  const press = () => {
    if (pending) return
    setSilent(false)
    clearResume(item.id)
    const sent = bridge.send({ type: 'terminal_resume', thread_id: item.id })
    if (sent) setPending(true)
    else setSilent(true)
  }
  const shows = item.panel === 'resume' && item.action !== null
  return (
    <div
      data-testid="terminal-panel"
      data-panel={item.panel}
      className="flex h-full min-h-48 flex-col items-start justify-center gap-3 p-6"
    >
      <h2 className="text-base font-semibold text-text">
        {item.panel === 'error' ? `${item.name} failed` : item.name}
      </h2>
      {item.detail && <p className={cn('max-w-prose', item.panel === 'error' && 'text-danger')}>{item.detail}</p>}
      {shows && (
        // aria-disabled, not disabled: a button that disables itself under a keyboard press drops the focus on the page
        <Button
          type="button"
          onClick={press}
          aria-disabled={pending}
          data-testid="terminal-resume"
          className={pending ? 'opacity-60' : undefined}
        >
          {pending ? 'Asking…' : item.action === 'start' ? 'Start' : 'Resume'}
        </Button>
      )}
      <p role="status" aria-live="polite" data-testid="terminal-resume-note" className="max-w-prose">
        {mine && resumeSentence(mine.outcome, verb)}
        {!mine && silent && `The Mac app didn't answer. Update it, or send the thread a message to wake it.`}
      </p>
    </div>
  )
}

function Screen({ bridge }: { bridge: ShellBridge }) {
  const listed = useTerminalSessions((s) => s.items)
  // No list yet (an older Mac app, or the first moment): Main alone, as this screen always was, and no strip.
  const items = useMemo(() => (listed && listed.length > 0 ? listed : [MAIN]), [listed])
  const hasStrip = listed !== null && listed.length > 0
  const [picked, setPicked] = useState(rememberedTab)
  // A remembered tab that is gone (the thread was archived) falls back to Main without forgetting the owner's last pick.
  const current = items.find((i) => i.id === picked) ?? items.find((i) => i.id === 'main') ?? items[0] ?? MAIN
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const pick = useCallback((id: string, focus = false) => {
    setPicked(id)
    rememberTab(id)
    if (focus) queueMicrotask(() => tabs.current.get(id)?.focus())
  }, [])
  // Main keeps its native notes (not started, no tmux) in the native view; a thread's panels are the page's.
  const shown = current.id === 'main' || current.panel === 'terminal'

  // The Mac switched the tab itself (Ctrl+digit while its terminal had the keyboard): follow it.
  const selectRequest = useTerminalSessions((s) => s.selectRequest)
  const seenSelect = useRef(selectRequest?.n ?? 0) // a request from before this screen opened is not for it
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request counts, not a new list
  useEffect(() => {
    if (!selectRequest || selectRequest.n <= seenSelect.current) return
    seenSelect.current = selectRequest.n
    if (items.some((i) => i.id === selectRequest.id)) pick(selectRequest.id)
  }, [selectRequest])

  // Ctrl+1..9 pick a tab. This screen's own chord: it runs before (and instead of) "open thread N", which the same keys do elsewhere.
  useEffect(() => {
    if (!hasStrip) return
    const onKey = (e: KeyboardEvent) => {
      // the physical key, like the Mac's own rule: the digit row or the keypad, whatever the layout prints on it
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
      if (!digit || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      const target = items.find((i) => i.key === digit[1])
      if (target) pick(target.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hasStrip, items, pick])

  const onTabKeys = (e: React.KeyboardEvent) => {
    const at = items.findIndex((i) => i.id === current.id)
    const to =
      e.key === 'ArrowRight'
        ? (at + 1) % items.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : -1
    const next = items[to]
    if (!next) return
    e.preventDefault()
    pick(next.id, true)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {hasStrip && (
        // biome-ignore lint/a11y/useSemanticElements: a tab strip is a tablist; the arrows move between the tabs
        <div
          role="tablist"
          aria-label="Sessions"
          data-testid="terminal-tabs"
          onKeyDown={onTabKeys}
          className="flex h-11 shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface"
        >
          {items.map((i) => (
            <Tab
              key={i.id}
              item={i}
              selected={i.id === current.id}
              onPick={() => pick(i.id)}
              tabRef={(el) => {
                if (el) tabs.current.set(i.id, el)
                else tabs.current.delete(i.id)
              }}
            />
          ))}
        </div>
      )}
      <div
        id="term-panel"
        {...(hasStrip ? { role: 'tabpanel', 'aria-labelledby': `term-tab-${current.id}` } : {})}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Space bridge={bridge} session={current.id} shown={shown}>
          {shown ? (
            <p className="p-6">
              The terminal shows in this space when there is room for 80 columns and 24 rows. Make the window bigger if
              it does not. If it still does not, this Mac app is older than this page: update the Mac app.
            </p>
          ) : (
            <Panel key={current.id} item={current} bridge={bridge} />
          )}
        </Space>
        {hasStrip && shown && (
          <p className="shrink-0 border-t border-line bg-surface px-4 py-2 text-xs text-text-2">
            Typing here goes to {current.name}&apos;s session. Ctrl+1 to 9 switch tabs.
          </p>
        )}
      </div>
    </div>
  )
}

export function TerminalScreen() {
  const shell = getShell()
  if (!shell) return <Navigate to="/" replace />
  return <Screen bridge={shell.bridge} />
}
