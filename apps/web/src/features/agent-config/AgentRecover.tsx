// Settings → Agent: Restart agent. It sends one signed `agent.recover` to the Mac, which hands it to the Mac app; the agent
// is not asked and does not need to be working. Putting back the last good setup is NOT here: the Mac cannot tell a
// restore the phone asked for from one the agent asked for, so it is done at the Mac, and a line says so.
// With the Mac offline the button stays where it is and says why nothing is sent: recovery needs the Mac app running.
import { type AgentRecoverActionT, type FrameOf, newUlid } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { passkeyErrorCopy } from '../../lib/passkeyGate.ts'
import { Button } from '../../ui/index.ts'

export const RECOVER_OFFLINE_TEXT = "Your Mac is offline. Recovery needs the Mac app running; try again when it's back."
const NO_ANSWER_TEXT = 'Your Mac did not answer. Check that it is awake and try again.'
const WAIT_MS = 30_000

type Outcome = { ok: boolean; text: string }

export function AgentRecover({ macOnline }: { macOnline: boolean }) {
  const client = useTalosClient()
  const [pending, setPending] = useState<AgentRecoverActionT | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const waiting = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const done = useRef<(o: Outcome) => void>(() => {})
  done.current = (o) => {
    const w = waiting.current
    if (w) clearTimeout(w.timer)
    waiting.current = null
    setPending(null)
    setOutcome(o)
  }

  useEffect(() => {
    const off = client.onFrame('agent.recover.result', (f: FrameOf<'agent.recover.result'>) => {
      if (waiting.current?.id === f.control_id) done.current({ ok: f.ok, text: f.text })
    })
    return () => {
      off()
      if (waiting.current) clearTimeout(waiting.current.timer)
    }
  }, [client])

  const run = async (action: AgentRecoverActionT) => {
    if (pending) return // never disabled while waiting: a disabled control drops keyboard focus on some phones
    setOutcome(null)
    if (!macOnline || !client.sendOwnerFrame) {
      setOutcome({ ok: false, text: macOnline ? 'This build cannot send that.' : RECOVER_OFFLINE_TEXT })
      return
    }
    const send = client.sendOwnerFrame.bind(client)
    const control_id = newUlid()
    setPending(action)
    waiting.current = {
      id: control_id,
      timer: setTimeout(() => done.current({ ok: false, text: NO_ANSWER_TEXT }), WAIT_MS),
    }
    try {
      await send({ type: 'agent.recover', control_id, action })
    } catch (e) {
      const text =
        passkeyErrorCopy(e) ??
        (e instanceof TalosClientError && e.code === 'mac_offline'
          ? RECOVER_OFFLINE_TEXT
          : e instanceof TalosClientError && e.message
            ? e.message
            : 'Couldn’t reach your Mac. Nothing was changed.')
      done.current({ ok: false, text })
    }
  }

  return (
    <div className="space-y-3" data-testid="agent-recover">
      <p className="m-0 text-sm text-text-2">
        If the agent stops answering, this asks your Mac to restart it. It doesn’t go through the agent.
      </p>
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="min-h-11 w-full"
          aria-busy={pending === 'restart'}
          onClick={() => void run('restart')}
        >
          Restart agent
        </Button>
      </div>
      <p data-testid="agent-recover-restore-note" className="m-0 text-sm text-text-2">
        To put back the last good setup, use the Talos menu on your Mac: Restore last good setup.
      </p>
      {!macOnline ? (
        <p data-testid="agent-recover-offline" className="m-0 text-sm text-text-2">
          {RECOVER_OFFLINE_TEXT}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="m-0 text-sm text-text-2">
          Asking your Mac…
        </p>
      ) : null}
      {outcome ? (
        <p role={outcome.ok ? 'status' : 'alert'} className={outcome.ok ? 'm-0 text-sm' : 'm-0 text-sm text-danger'}>
          {outcome.text}
        </p>
      ) : null}
    </div>
  )
}
