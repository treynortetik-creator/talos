// Shows the approval card for a change the owner asked for (docs/SCHEDULES.md S5.4): sends `schedule.patch`, then renders
// the bridge's card in place through CardView (no second component), matched by `payload.client_ref`. The card binds the
// revision; approving sends card.resolve with the hash of what is on screen, with step-up when the card is high-risk.
import { type CardT, ScheduleCardPayload, type ScheduleChangeT, type ScheduleT } from '@talos-app/protocol'
import { Suspense, useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { SlowPatch } from '../../lib/socketSchedules.ts'
import { Button, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../ui/index.ts'
import { CardView } from '../registry.ts'
import { COPY } from './constants.ts'
import { refusalWords } from './shared.tsx'
import { refreshSchedules } from './sync.ts'

export type ProposeError = {
  message: string
  fields: Array<{ path: string; message: string }>
  /** The Mac was slow, not gone: its card may still arrive under this client_ref. */
  clientRef?: string
}

export function proposeError(e: unknown): ProposeError {
  if (e instanceof SlowPatch) return { message: refusalWords(e), fields: [], clientRef: e.clientRef }
  if (e instanceof TalosClientError)
    return {
      message: e.code === 'schedule_invalid' ? 'Some fields need a change.' : refusalWords(e),
      fields: e.fields ?? [],
    }
  return { message: refusalWords(e), fields: [] }
}

/** The card the bridge minted for `clientRef`, if it has arrived. */
export function useCardFor(clientRef: string | null): CardT | undefined {
  return useTalos((s) =>
    clientRef
      ? s.cards.find(
          (c) => c.kind === 'schedule' && ScheduleCardPayload.safeParse(c.payload).data?.client_ref === clientRef,
        )
      : undefined,
  )
}

export function isConflict(card: CardT): boolean {
  return card.state === 'failed' && /changed on your Mac/i.test(card.result?.text ?? '')
}

/** Waits for, then renders, the card for `clientRef`. */
export function ProposalCard({
  clientRef,
  threadId,
  onReviewAgain,
  onDecided,
  slow = false,
}: {
  clientRef: string
  threadId: string
  onReviewAgain: () => void
  onDecided?: () => void
  /** The Mac has not acked yet; keep waiting for the card instead of reporting a failure. */
  slow?: boolean
}) {
  const card = useCardFor(clientRef)
  const threadName = useTalos((s) => s.threads.find((t) => t.id === threadId)?.name ?? threadId)
  const decided = card !== undefined && card.state !== 'pending'
  const told = useRef(false)
  useEffect(() => {
    if (decided && !told.current) {
      told.current = true
      onDecided?.()
    }
  }, [decided, onDecided])
  if (!card)
    return (
      <p role="status" className="py-4 text-sm text-text-2">
        {slow
          ? 'Your Mac is slow to answer. The card shows up here if it does.'
          : 'Waiting for the card from your Mac…'}
      </p>
    )
  if (isConflict(card))
    return (
      <div data-testid="card-conflict" className="space-y-2 rounded-card border border-warn p-3">
        <p role="alert" className="text-sm font-medium text-warn">
          {COPY.conflict}
        </p>
        <Button variant="outline" onClick={onReviewAgain}>
          Review again
        </Button>
      </div>
    )
  return (
    <Suspense fallback={null}>
      <CardView card={card} threadName={threadName} inline={false} />
    </Suspense>
  )
}

/** The same change drawn against the job as it is now (a stale etag or hash is refused at patch time). */
export function rebaseChange(change: ScheduleChangeT, row: ScheduleT | undefined): ScheduleChangeT | null {
  if (change.op === 'create') return change
  if (!row) return null
  if (change.op === 'adopt') return { ...change, content_hash: row.content_hash }
  return { ...change, base_etag: row.etag }
}

/** A sheet that proposes `change` as soon as it opens and shows its card. */
export function ProposalSheet({
  change,
  threadId,
  title,
  onClose,
}: {
  change: ScheduleChangeT
  threadId: string
  title: string
  onClose: () => void
}) {
  const client = useTalosClient()
  const [ref, setRef] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one proposal per open (or per Review again)
  useEffect(() => {
    let live = true
    setRef(null)
    setSlow(false)
    setErr(null)
    void (async () => {
      let current = change
      if (attempt > 0) {
        // Review again after a conflict: look at the job as the Mac has it NOW and rebuild the change from that
        await refreshSchedules(client)
        const row =
          change.op === 'create'
            ? undefined
            : client.store.getState().schedules.snapshot?.schedules.find((s) => s.id === change.id)
        const next = rebaseChange(change, row)
        if (!next) return live && setErr('That job is gone.')
        current = next
      }
      try {
        const r = await client.schedules.proposeScheduleChange(current, threadId)
        if (live) setRef(r.clientRef)
      } catch (e) {
        const pe = proposeError(e)
        if (!live) return
        if (pe.clientRef) {
          setSlow(true)
          setRef(pe.clientRef)
        } else setErr(pe.message)
      }
    })()
    return () => {
      live = false
    }
  }, [attempt])
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="proposal-desc" data-testid="proposal-sheet">
        <SheetTitle className="font-display text-lg font-semibold">{title}</SheetTitle>
        <SheetDescription id="proposal-desc" className="mt-1 text-sm text-text-2">
          Nothing is saved until you approve the card.
        </SheetDescription>
        <div className="mt-3">
          {err ? (
            <p role="alert" className="text-sm text-danger">
              {err}
            </p>
          ) : ref ? (
            <ProposalCard
              clientRef={ref}
              threadId={threadId}
              slow={slow}
              onReviewAgain={() => setAttempt((n) => n + 1)}
            />
          ) : (
            <p role="status" className="text-sm text-text-2">
              Asking your Mac…
            </p>
          )}
        </div>
        <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Close</SheetClose>
      </SheetContent>
    </Sheet>
  )
}
