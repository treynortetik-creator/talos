// First run on screen: the gate that opens the Setup thread once (firstRun.ts), and the card at the top of that thread.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button } from '../../ui/index.ts'
import { firstRunReady, runFirstRun, setCard, useFirstRun } from './firstRun.ts'
import { SETUP_KICKOFF, SETUP_SKIP, SETUP_THREAD_ID, skipSetup } from './setupThread.ts'

/** In the app shell: when first run is pending and the app is ready, it runs once and opens the Setup thread. */
export function FirstRunGate() {
  const client = useTalosClient()
  const nav = useNavigate()
  const due = useFirstRun((s) => s.stage !== null)
  const ready = useTalos(() => firstRunReady(client))
  useEffect(() => {
    if (!due || !ready) return
    void runFirstRun(client)
      .then((opened) => {
        if (opened) nav(`/t/${SETUP_THREAD_ID}`)
      })
      .catch(() => {
        // offline or refused: nothing to show; Settings → Agent still starts it
      })
  }, [due, ready, client, nav])
  return null
}

/** At the top of the Setup thread that first run opened: what this is, and a one-tap Skip. */
export function FirstRunCard() {
  const client = useTalosClient()
  const card = useFirstRun((s) => s.card)
  // done with once the owner is answering (a message after the kickoff), or the thread was archived
  const over = useTalos((s) => {
    const msgs = s.messages[SETUP_THREAD_ID] ?? []
    const answered = msgs.some((m) => m.author === 'owner' && m.text !== SETUP_KICKOFF && m.text !== SETUP_SKIP)
    return answered || s.threads.find((t) => t.id === SETUP_THREAD_ID)?.archived === true
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (card && over) setCard(false)
  }, [card, over])
  if (!card || over) return null
  const skip = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await skipSetup(client)
      setCard(false)
    } catch {
      setError("That didn't go through. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-testid="first-run-card"
      aria-label="Setting up your agent"
      className="mx-3 my-2 space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-sm"
    >
      <p className="m-0 font-medium">Your agent is asking a few questions to set itself up.</p>
      <p className="m-0 text-text-2">
        Answer here, one short round at a time, and stop whenever you like. It takes about 25 minutes in all. You can
        skip it: your agent already works.
      </p>
      <Button variant="outline" onClick={skip} aria-busy={busy} data-testid="first-run-skip" className="w-full">
        Skip for now
      </Button>
      <p className="m-0 text-xs text-text-2">You can start setup any time from Settings → Agent.</p>
      {error ? (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}
