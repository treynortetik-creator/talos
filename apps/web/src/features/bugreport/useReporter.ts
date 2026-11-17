// The state of the bug reporter form, shared by the desktop and the phone layouts: the marks, the words, what is attached, the
// report that Send posts (and the preview shows), and the send itself. The layouts only arrange it.
import { BUG_REPORT_LIMITS, type BugReportBodyT, type BugReportDestinationT } from '@talos-app/protocol'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation, useMatch } from 'react-router'
import { type TalosClient, TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import type { BugContext } from '../../lib/v2Client.ts'
import { fetchStatus } from '../health/useHealthStatus.ts'
import { appVersion, deviceKind } from '../problems/environment.ts'
import { routeName, routeTrail } from '../problems/routes.ts'
import { exportPicture } from './capture.ts'
import type { Mark, Tool } from './ink.ts'
import { buildReport, previewText, screenOf } from './payload.ts'
import { useBugReport } from './store.ts'
import { BUG_TEXT } from './text.ts'

/** The screens visited, with the one the report is sent from always last. */
function trailEndingHere(pathname: string): string[] {
  const trail = routeTrail()
  const here = routeName(pathname)
  return trail[trail.length - 1] === here ? trail : [...trail, here]
}

export type Phase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; text: string }
type Ctx = { state: 'loading' } | { state: 'ready'; ctx: BugContext } | { state: 'unavailable' }
/** The parts of the report the owner can leave out (the last five messages are off until asked for). */
export type AttachKey = 'versions' | 'thread' | 'errors' | 'logs' | 'messages'
const ALL_ON: Record<AttachKey, boolean> = { versions: true, thread: true, errors: true, logs: true, messages: false }

/** How long Send waits for the Mac's details before it goes without them. */
export const MAC_WAIT_MS = 10_000
export type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
/** The timer the wait uses; a test puts a fake clock here. */
export const bugTimers: { current: Timers } = { current: realTimers }

function useBugContext(
  client: TalosClient,
  open: boolean,
): { ctx: Ctx; relay: string; destination: BugReportDestinationT | null } {
  const [ctx, setCtx] = useState<Ctx>({ state: 'loading' })
  const [relay, setRelay] = useState('')
  const [destination, setDestination] = useState<BugReportDestinationT | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    setCtx({ state: 'loading' })
    setDestination(null)
    // where the report goes: only the relay knows (its environment and the address it keeps to itself)
    ;(client.bugs ? client.bugs.destination() : Promise.reject(new Error('none'))).then(
      (d) => alive && setDestination(d),
      () => undefined,
    )
    const ask = client.bugs ? client.bugs.context(BUG_REPORT_LIMITS.logLines) : Promise.reject(new Error('none'))
    // a Mac that has not answered in time is treated as away; a late answer still replaces that with the details
    const timers = bugTimers.current
    const wait = timers.setTimeout(
      () => alive && setCtx((c) => (c.state === 'loading' ? { state: 'unavailable' } : c)),
      MAC_WAIT_MS,
    )
    ask.then(
      (c) => alive && setCtx({ state: 'ready', ctx: c }),
      () => alive && setCtx({ state: 'unavailable' }),
    )
    ask.finally(() => timers.clearTimeout(wait)).catch(() => undefined)
    fetchStatus().then(
      (s) => alive && setRelay(s.relay.version),
      () => undefined,
    )
    return () => {
      alive = false
      timers.clearTimeout(wait)
      // a form opened again must not start from the last one's answer
      setCtx({ state: 'loading' })
      setDestination(null)
    }
  }, [client, open])
  return { ctx, relay, destination }
}

export function useReporter() {
  const { open, capture, capturing, takenAt, returnTo, close, setPicture } = useBugReport()
  const client = useTalosClient()
  const loc = useLocation()
  const onThread = useMatch('/t/:thread')
  const threadId = onThread?.params.thread ?? null
  const threadMessages = useTalos((s) => (threadId ? s.messages[threadId] : undefined))
  const { ctx, relay, destination } = useBugContext(client, open)

  const [marks, setMarks] = useState<Mark[]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [ink, setInk] = useState(0)
  const [wentWrong, setWentWrong] = useState('')
  const [expected, setExpected] = useState('')
  const [attach, setAttach] = useState<Record<AttachKey, boolean>>(ALL_ON)
  const [showPreview, setShowPreview] = useState(false)
  const [asked, setAsked] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [pictureInfo, setPictureInfo] = useState<{ type: string; bytes: number } | null>(null)
  const ids = { w: useId(), e: useId(), m: useId() }
  /** Counts opens and sends, so the answer to a send from an earlier form never lands on a new one. */
  const round = useRef(0)

  useEffect(() => {
    if (!open) return
    round.current++
    setMarks([])
    setTool('pen')
    setInk(0)
    setWentWrong('')
    setExpected('')
    setAttach(ALL_ON)
    setShowPreview(false)
    setAsked(false)
    setPhase({ kind: 'idle' })
    setPictureInfo(null)
  }, [open])

  // marks belong to the picture they were drawn on: a new one (the capture landing, or one the owner added) starts clean
  // biome-ignore lint/correctness/useExhaustiveDependencies: capture is the trigger
  useEffect(() => setMarks([]), [capture])

  const messages = useMemo(
    () =>
      (threadMessages ?? [])
        .filter((m) => m.kind === 'text' && m.text)
        .map((m) => ({ author: m.author, text: m.text as string })),
    [threadMessages],
  )
  const report: BugReportBodyT = useMemo(
    () =>
      buildReport({
        wentWrong,
        expected,
        includeMessages: attach.messages,
        attach,
        versions: { app: appVersion(), relay },
        context: ctx.state === 'ready' ? ctx.ctx : null,
        macMissing: ctx.state === 'unavailable',
        threadId,
        screen: screenOf(loc.pathname),
        client: deviceKind() as 'browser' | 'mac_app' | 'iphone_app',
        routes: trailEndingHere(loc.pathname),
        messages,
      }),
    [wentWrong, expected, attach, relay, ctx, threadId, loc.pathname, messages],
  )

  // the preview shows the picture's real size, so it exports once when the preview opens
  useEffect(() => {
    if (!showPreview || !capture) return
    let alive = true
    exportPicture(capture.canvas, marks).then(
      (p) => alive && setPictureInfo({ type: p.type, bytes: p.blob.size }),
      () => alive && setPictureInfo(null),
    )
    return () => {
      alive = false
    }
  }, [showPreview, capture, marks])

  const undo = useCallback(() => setMarks((m) => m.slice(0, -1)), [])
  const send = async () => {
    setAsked(true)
    if (ctx.state === 'loading' || !report.what_went_wrong || !capture) return
    const mine = ++round.current
    setPhase({ kind: 'sending' })
    try {
      if (!client.bugs) throw new TalosClientError('internal', BUG_TEXT.failed)
      const pic = await exportPicture(capture.canvas, marks)
      await client.bugs.send(report, { type: pic.type, bytes: new Uint8Array(await pic.blob.arrayBuffer()) })
      if (round.current === mine) setPhase({ kind: 'sent' })
    } catch (e) {
      if (round.current !== mine) return
      setPhase({
        kind: 'failed',
        text: e instanceof TalosClientError && e.code === 'rate_limited' ? BUG_TEXT.rateLimited : BUG_TEXT.failed,
      })
    }
  }

  return {
    open,
    close,
    returnTo,
    capture,
    capturing,
    setPicture,
    marks,
    setMarks,
    tool,
    setTool,
    ink,
    setInk,
    wentWrong,
    setWentWrong,
    expected,
    setExpected,
    attach,
    toggle: (k: AttachKey) => setAttach((a) => ({ ...a, [k]: !a[k] })),
    showPreview,
    togglePreview: () => setShowPreview((v) => !v),
    previewBody: previewText(report, pictureInfo),
    phase,
    /** Send waits (up to 10 seconds) for the Mac's details, so the report does not go out without them by accident. */
    gathering: ctx.state === 'loading' || capturing,
    sending: phase.kind === 'sending',
    sent: phase.kind === 'sent',
    missing: asked && !report.what_went_wrong,
    ids,
    ctxState: ctx.state,
    /** null while the Mac has not answered yet or cannot. */
    errorCount: ctx.state === 'ready' ? ctx.ctx.recentErrors.length : null,
    hasThread: threadId !== null,
    where: screenOf(loc.pathname),
    /** The "Goes to" line: what the relay said about where a report goes. */
    goesTo: BUG_TEXT.goesTo(destination),
    time: takenAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '',
    undo,
    send,
  }
}

export type Reporter = ReturnType<typeof useReporter>
