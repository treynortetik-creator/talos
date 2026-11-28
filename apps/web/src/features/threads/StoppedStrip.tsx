// After a stop: "Stopped <agent>. Your message is kept." with Undo, above the message box for 8 seconds. Undo sends the
// owner's message again, but only when it plainly started this turn (stopUndo.ts); otherwise the strip says only "Stopped
// <agent>.". A stop that failed shows its error here too, in the same place: the working line goes with the turn, and an
// error that lands as the turn ends must outlive it. A separate strip from the inbox's UndoStrip (that one is inbox items).
// The strip goes on its own, when the owner sends anything else, when they leave the thread, and after one Undo.
import { type AttachmentRefT, ownValue } from '@talos-app/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { announce } from '../../lib/announce.ts'
import { ANNOUNCE, SOURCE, sendResultWords, stopped } from '../../lib/announceText.ts'
import { type TalosClient, useTalos, useTalosClient } from '../../lib/client.ts'
import { Button } from '../../ui/index.ts'
import { type UndoTarget, undoTarget } from './stopUndo.ts'
import { useAgentName } from './useThreads.ts'

export const STOPPED_MS = 8000
export const ERROR_MS = 10_000
export const RESEND_FAILED = "Couldn't send it again. Your message is still in the thread."

type Offer = {
  threadId: string
  kind: 'stopped' | 'error'
  text?: string
  target: UndoTarget | null
  /** Stop had keyboard focus when it was pressed: it is gone now, so focus moves here. */
  focus: boolean
  failed: boolean
}
const useStopped = create<{ offer: Offer | null; mounted: Record<string, number> }>(() => ({
  offer: null,
  mounted: {},
}))
const onThread = (threadId: string) => (useStopped.getState().mounted[threadId] ?? 0) > 0

/** Show the strip for `threadId`. Does nothing when the owner is not on that thread (no strip is mounted for it). */
export function offerStopped(client: Pick<TalosClient, 'store'>, threadId: string, opts: { focus?: boolean } = {}) {
  if (!onThread(threadId)) return
  const messages = ownValue(client.store.getState().messages, threadId) ?? []
  useStopped.setState({
    offer: {
      threadId,
      kind: 'stopped',
      target: undoTarget(messages, Date.now(), client.store.getState().clockOffset ?? 0),
      focus: opts.focus === true,
      failed: false,
    },
  })
}
/** A stop that failed: its error, above the message box, until the next send or ERROR_MS. */
export function offerStopError(threadId: string, text: string, opts: { focus?: boolean } = {}) {
  if (!onThread(threadId)) return
  useStopped.setState({
    offer: { threadId, kind: 'error', text, target: null, focus: opts.focus === true, failed: false },
  })
}
const clearStopped = () => useStopped.setState({ offer: null })
const messageBox = () => document.querySelector<HTMLElement>('.composer-box')

type Mark = { id: string | undefined; count: number }

export function StoppedStrip({ threadId }: { threadId: string }) {
  const client = useTalosClient()
  const agent = useAgentName()
  const offer = useStopped((s) => (s.offer?.threadId === threadId ? s.offer : null))
  const messages = useTalos((s) => ownValue(s.messages, threadId))
  const owners = messages?.filter((m) => m.author === 'owner') ?? []
  const last = owners.at(-1)
  const mark = useRef<Mark | null>(null)
  const used = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const undoButton = useRef<HTMLButtonElement>(null)

  // Registered while on screen; leaving the thread (or the screen) takes the offer with it.
  useEffect(() => {
    useStopped.setState((s) => ({ mounted: { ...s.mounted, [threadId]: (s.mounted[threadId] ?? 0) + 1 } }))
    return () => {
      useStopped.setState((s) => ({
        mounted: { ...s.mounted, [threadId]: Math.max(0, (s.mounted[threadId] ?? 1) - 1) },
        offer: s.offer?.threadId === threadId ? null : s.offer,
      }))
    }
  }, [threadId])

  /** Takes the strip away; focus that was inside it goes to the message box (the button it was on is about to be gone). */
  const dismiss = useCallback(() => {
    const had = root.current?.contains(document.activeElement) === true
    clearStopped()
    if (had) messageBox()?.focus({ preventScroll: true })
  }, [])

  // What the thread held when the strip came up: anything the owner sends after that ends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, when the offer appears
  useLayoutEffect(() => {
    if (!offer) {
      mark.current = null
      return
    }
    mark.current = { id: last?.id, count: owners.length }
    used.current = false
  }, [offer])
  // Stop had focus and went with the turn: Undo takes it, or the message box when there is no Undo.
  useLayoutEffect(() => {
    if (!offer?.focus) return
    // only if focus is still where Stop left it (on Stop, or nowhere): an owner who started typing meanwhile is left alone
    const a = document.activeElement
    if (a && a !== document.body && a.getAttribute('data-testid') !== 'stop-line-button') return
    const el = undoButton.current ?? messageBox()
    el?.focus({ preventScroll: true })
  }, [offer])
  const kind = offer?.kind
  useEffect(() => {
    if (!offer) return
    const t = setTimeout(
      () => {
        if (useStopped.getState().offer === offer) dismiss()
      },
      kind === 'error' ? ERROR_MS : STOPPED_MS,
    )
    return () => clearTimeout(t)
  }, [offer, kind, dismiss])
  useEffect(() => {
    const m = mark.current
    // a newer owner message AND more of them: a page of older messages or a row getting its stored id is not a send
    if (offer && m && owners.length > m.count && last?.id !== m.id) clearStopped()
  }, [offer, owners.length, last?.id])

  // The strip appears already filled, which a screen reader skips: the announcer says it instead (so the strip has no live role).
  useEffect(() => {
    if (offer?.kind === 'stopped' && !offer.failed) announce(stopped(agent, offer.target !== null), SOURCE.stop)
  }, [offer, agent])

  if (!offer) return null
  if (offer.kind === 'error') {
    return (
      <p role="alert" data-testid="stop-line-error" className="m-0 mx-3 mt-2 text-sm text-danger">
        {offer.text}
      </p>
    )
  }
  const { target, failed } = offer
  const undo = async () => {
    if (used.current || !target) return
    used.current = true
    const had = root.current?.contains(document.activeElement) === true
    try {
      const attachments: AttachmentRefT[] = target.attachments
      const sent = await client.sendMessage({
        threadId,
        text: target.text,
        attachments,
        ...(target.replyTo ? { replyTo: target.replyTo } : {}),
      })
      announce(sendResultWords(sent.state, ANNOUNCE.messageSentAgain), SOURCE.stop)
      if (useStopped.getState().offer === offer) clearStopped()
    } catch {
      // Nothing was sent: keep the strip, say so, and offer no second try (the message is still in the thread).
      if (useStopped.getState().offer === offer)
        useStopped.setState({ offer: { ...offer, failed: true, focus: false } })
    }
    if (had) messageBox()?.focus({ preventScroll: true })
  }
  const box =
    'mx-3 mt-2 flex items-center gap-3 rounded-card border border-line bg-surface-2 p-2 pl-3 text-sm text-text'
  if (failed) {
    return (
      <div key="failed" ref={root} role="alert" data-testid="stopped-strip" className={box}>
        <span className="min-w-0 flex-1">{RESEND_FAILED}</span>
      </div>
    )
  }
  return (
    <div key="stopped" ref={root} data-testid="stopped-strip" className={box}>
      <span className="min-w-0 flex-1">{target ? `Stopped ${agent}. Your message is kept.` : `Stopped ${agent}.`}</span>
      {target && (
        <Button ref={undoButton} variant="outline" onClick={() => void undo()}>
          Undo
        </Button>
      )}
    </div>
  )
}
