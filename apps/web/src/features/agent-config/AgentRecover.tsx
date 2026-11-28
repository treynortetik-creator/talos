// Settings → Agent: Restart agent. It sends one signed `agent.recover` to the Mac, which hands it to the Mac app; the agent
// is not asked and does not need to be working. Putting back the last good setup is NOT here: the Mac cannot tell a
// restore the phone asked for from one the agent asked for, so it is done at the computer (the Mac's menu, the PC's tray),
// and a line says where (hostWords.restore).
// With the Mac offline the button stays where it is and says why nothing is sent: recovery needs the Mac app running.
import { type AgentRecoverActionT, type FrameOf, newUlid, ownValue } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { capital, type HostWords, useHostWords } from '../../lib/hostWords.ts'
import { Button } from '../../ui/index.ts'
import { NOT_CONNECTED_LINE, useWriteBlock } from '../settings/offline.ts'
import { connectionRefusal } from '../threads/manage/useThreadPatch.ts'

export const recoverOfflineText = (w: HostWords) =>
  `${capital(w.computer)} is offline. Recovery needs ${w.app} running; try again when it's back.`
const noAnswerText = (w: HostWords) => `${capital(w.computer)} did not answer. Check that it is awake and try again.`
const WAIT_MS = 30_000

type Outcome = { ok: boolean; text: string }

export function AgentRecover() {
  const block = useWriteBlock()
  const words = useHostWords()
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
    if (block !== null || !client.sendOwnerFrame) {
      const text =
        block === 'link'
          ? NOT_CONNECTED_LINE
          : block === 'mac'
            ? recoverOfflineText(words)
            : 'This build cannot send that.'
      setOutcome({ ok: false, text })
      return
    }
    const send = client.sendOwnerFrame.bind(client)
    const control_id = newUlid()
    setPending(action)
    waiting.current = {
      id: control_id,
      timer: setTimeout(() => done.current({ ok: false, text: noAnswerText(words) }), WAIT_MS),
    }
    try {
      await send({ type: 'agent.recover', control_id, action })
    } catch (e) {
      const text =
        connectionRefusal(e) ??
        (e instanceof TalosClientError && e.code === 'mac_offline'
          ? recoverOfflineText(words)
          : e instanceof TalosClientError && e.message
            ? e.message
            : `Couldn’t reach ${words.computer}. Nothing was changed.`)
      done.current({ ok: false, text })
    }
  }

  // Mid-task the owner is asked first: a thread the agent is working on. Only the Mac's own status counts; nothing here guesses
  // that a long-running row has gone stale. Idle (or a thread that needs the owner) restarts at once.
  const busy = useTalos((s) => s.threads.some((t) => !t.archived && ownValue(s.statuses, t.id)?.state === 'working'))
  const [asking, setAsking] = useState(false)

  return (
    <div className="space-y-3" data-testid="agent-recover">
      <p className="m-0 text-sm text-text-2">
        If the agent stops answering, this asks {words.computer} to restart it. It doesn’t go through the agent.
      </p>
      <div className="flex flex-col gap-2">
        {asking && !pending ? (
          <>
            <p role="status" className="m-0 text-sm">
              The agent is working on a task. Restarting now stops it.
            </p>
            <Button
              variant="outline"
              className="min-h-11 w-full"
              onClick={() => {
                setAsking(false)
                void run('restart')
              }}
            >
              Restart now
            </Button>
            <Button variant="ghost" className="min-h-11 w-full" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            className="min-h-11 w-full"
            aria-busy={pending === 'restart'}
            onClick={() => (busy && !pending ? setAsking(true) : void run('restart'))}
          >
            Restart agent
          </Button>
        )}
      </div>
      <p data-testid="agent-recover-restore-note" className="m-0 text-sm text-text-2">
        {words.restore}
      </p>
      {block === 'mac' ? (
        <p data-testid="agent-recover-offline" className="m-0 text-sm text-text-2">
          {recoverOfflineText(words)}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="m-0 text-sm text-text-2">
          Asking {words.computer}…
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
