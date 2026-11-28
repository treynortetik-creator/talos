// The Terminal screen in a browser and in the iPhone app (the Mac app keeps its native terminal; TerminalScreen routes here when
// it is not in that app). Piece 1 of the remote terminal: a read-only view of the agent's tmux pane, Main's or a thread's own.
//
// The card is FIXED app UI. Nothing an agent writes can make, fill in or point at it: there is no agent card, no deep link and no
// notification button that opens it, and one tap on Watch is one view. Before the tap nothing is asked of the Mac. After it the
// terminal is xterm.js, read-only; closing it, leaving the screen, or losing the connection ends the view.
import { TERM_VIEW_FEATURE } from '@talos-app/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../../lib/client.ts'
import { Button } from '../../../ui/button.tsx'
import { cn } from '../../../ui/cn.ts'
import { useWorkersStatus } from '../../thread-sessions/store.ts'
import { bufferedSink } from './buffered.ts'
import { secondsLeft, TermSession, type TermView } from './session.ts'
import { TERM_WORDS, terminalTitle, timeLeft } from './words.ts'
import { type MountedTerminal, mountTerminal } from './xtermMount.ts'

type Target = { id: string; name: string }

/** Main, and every thread whose own session is running (a thread on the shared session has no pane of its own to show). */
function useTargets(): Target[] {
  const status = useWorkersStatus()
  const threads = useTalos((s) => s.threads)
  return useMemo(() => {
    const live = new Set(
      (status?.threads ?? []).filter((t) => t.state === 'live' || t.state === 'busy').map((t) => t.thread_id),
    )
    return [
      { id: 'main', name: TERM_WORDS.main },
      ...threads.filter((t) => live.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
    ]
  }, [status, threads])
}

/** Why the card cannot be used now, in words; null when it can. */
function useUnavailable(): string | null {
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const macHas = useTalos((s) => s.presence.features?.includes(TERM_VIEW_FEATURE) === true)
  const known = useTalos((s) => s.presence.features !== undefined)
  const relayHas = useTalos((s) => s.relayFeatures.includes(TERM_VIEW_FEATURE))
  const pinned = useTalos((s) => s.devicePinned)
  const readySeq = useTalos((s) => s.readySeq ?? 0)
  if (!pinned) return TERM_WORDS.unpinned
  if (readySeq > 0 && !relayHas) return TERM_WORDS.relayNeedsUpdate
  if (!macOnline) return TERM_WORDS.macAway
  if (known && !macHas) return TERM_WORDS.needsUpdate
  return null
}

function Card({
  targets,
  words,
  unavailable,
  onWatch,
  busy,
}: {
  targets: Target[]
  words: string | null
  unavailable: string | null
  onWatch: (target: string) => void
  busy: boolean
}) {
  const [target, setTarget] = useState('main')
  const chosen = targets.some((t) => t.id === target) ? target : 'main'
  return (
    <section
      data-testid="terminal-card"
      aria-labelledby="remote-term-title"
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-6"
    >
      <h1 id="remote-term-title" className="text-lg font-semibold text-text">
        {TERM_WORDS.cardTitle}
      </h1>
      <p className="text-md text-text-2">{TERM_WORDS.cardLine}</p>
      {words && (
        <p role="status" data-testid="terminal-ended" className="text-md text-text">
          {words}
        </p>
      )}
      {targets.length > 1 && (
        <label className="flex flex-col gap-1 text-sm text-text-2">
          {TERM_WORDS.pickerLabel}
          <select
            data-testid="terminal-target"
            value={chosen}
            onChange={(e) => setTarget(e.target.value)}
            className="min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {unavailable && (
        <p data-testid="terminal-unavailable" className="text-sm text-text-2">
          {unavailable}
        </p>
      )}
      <Button
        data-testid="terminal-watch"
        onClick={() => onWatch(chosen)}
        aria-disabled={busy || unavailable !== null}
        className={cn((busy || unavailable !== null) && 'opacity-50')}
      >
        {busy ? TERM_WORDS.opening : words ? TERM_WORDS.watchAgain : TERM_WORDS.watch}
      </Button>
    </section>
  )
}

export default function RemoteTerminalScreen() {
  const client = useTalosClient()
  const targets = useTargets()
  const unavailable = useUnavailable()
  const connection = useTalos((s) => s.connection)
  const [view, setView] = useState<TermView>({ phase: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  // what the Mac sends before xterm has loaded is held, up to 1 MiB: past that, or if xterm never loads, the view ends with words
  const sink = useMemo(() => bufferedSink(1024 * 1024, () => abortRef.current(TERM_WORDS.loadFailed)), [])
  const abortRef = useRef<(words: string) => void>(() => {})
  const session = useMemo(
    () =>
      new TermSession({
        client,
        sink: sink.sink,
        onView: setView,
        visible: () => document.visibilityState === 'visible',
      }),
    [client, sink],
  )
  abortRef.current = (w) => session.abort(w)
  const boxRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const mounted = useRef<MountedTerminal | null>(null)
  const [loadError, setLoadError] = useState(false)

  // Leaving the screen ends the view; the control client on the Mac goes with its last viewer.
  useEffect(() => () => session.dispose(), [session])
  // The relay closes a view with its socket, and a closed view is never reopened by itself: watching again is a new tap.
  useEffect(() => {
    if (connection !== 'online') session.connectionLost()
  }, [connection, session])

  // xterm is loaded when the screen opens, and put in the page when a view starts.
  const watching = view.phase === 'watching' || view.phase === 'opening'
  const size = view.phase === 'watching' ? { cols: view.cols, rows: view.rows } : { cols: 80, rows: 24 }
  const sizeRef = useRef(size)
  sizeRef.current = size
  useEffect(() => {
    const host = hostRef.current
    if (!watching || !host) return
    let gone = false
    let m: MountedTerminal | null = null
    setLoadError(false)
    mountTerminal(host, sizeRef.current)
      .then((t) => {
        if (gone) return t.dispose()
        m = t
        mounted.current = t
        sink.attach(t.sink)
        const width = boxRef.current?.clientWidth
        if (width) t.fitTo(width)
      })
      .catch(() => {
        if (gone) return
        setLoadError(true)
        session.abort(TERM_WORDS.loadFailed)
      })
    return () => {
      gone = true
      sink.detach()
      mounted.current = null
      m?.dispose()
    }
  }, [watching, sink, session])

  // fit the pane's columns to the box, whenever the box or the pane changes
  const cols = view.phase === 'watching' ? view.cols : 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pane's size is what asks for a new fit
  useEffect(() => {
    const box = boxRef.current
    if (!box || !watching) return
    const fit = () => mounted.current?.fitTo(box.clientWidth)
    fit()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [watching, cols])

  // the header's time left follows the clock, a few times a minute
  useEffect(() => {
    if (view.phase !== 'watching') return
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [view.phase])

  const onWatch = useCallback(
    (target: string) => {
      if (unavailable) return
      setNow(Date.now())
      void session.start(target)
    },
    [session, unavailable],
  )

  if (view.phase !== 'watching' && view.phase !== 'opening') {
    return (
      <Card
        targets={targets}
        words={view.phase === 'ended' ? view.words : null}
        unavailable={unavailable}
        onWatch={onWatch}
        busy={false}
      />
    )
  }

  const name = targets.find((t) => t.id === view.target)?.name ?? TERM_WORDS.main
  const left = view.phase === 'watching' ? timeLeft(secondsLeft(view, now)) : ''
  return (
    <div data-testid="remote-terminal" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-text">{terminalTitle(name)}</h1>
          <p data-testid="terminal-status" className="truncate text-xs text-text-2">
            {view.phase === 'opening'
              ? TERM_WORDS.opening
              : `${view.lagging ? TERM_WORDS.catchingUp : TERM_WORDS.watching} · read-only · ${left}`}
          </p>
        </div>
        <Button variant="outline" data-testid="terminal-close" onClick={() => session.close()}>
          {TERM_WORDS.close}
        </Button>
      </header>
      {loadError && (
        <p role="alert" className="px-4 py-3 text-sm text-danger">
          {TERM_WORDS.loadFailed}
        </p>
      )}
      <section
        ref={boxRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        aria-label={TERM_WORDS.terminalLabel}
        data-testid="terminal-box"
        className="min-h-0 min-w-0 flex-1 overflow-auto bg-[#0a0e10] p-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <div ref={hostRef} data-testid="terminal-host" className="w-fit" />
      </section>
      <p className="shrink-0 border-t border-line bg-surface px-4 py-3 text-sm text-text-2">{TERM_WORDS.footer}</p>
    </div>
  )
}
