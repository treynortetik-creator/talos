// "Undo to here" in an owner message's menu: asks the Mac for the undo card of this message (one signed `undo.request`).
// Nothing is put back from here: the Mac answers with an undo card the owner approves, or says why not,
// and that answer is a line under the menu, never a line in the thread. Shown only when the relay says undo/1 and the
// message carries its undo point, which only a Mac that can undo sets: no new bridge feature (the hello is at its cap).
// The wait ends with the menu: closing it stops listening, and a late answer is dropped.
import { type FrameOf, type MessageT, newUlid, UNDO_FEATURE } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { capital, useHostWords } from '../../lib/hostWords.ts'
import { useFeature } from '../../lib/v2Client.ts'

const WAIT_MS = 30_000

const ITEM = 'flex min-h-11 items-center rounded-button px-3 text-left'

export function UndoToHere({ m, onCard }: { m: MessageT; onCard: () => void }) {
  const words = useHostWords()
  const client = useTalosClient()
  const feature = useFeature(UNDO_FEATURE)
  const [asking, setAsking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const waiting = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const done = useRef<(r: { ok: boolean; text: string }) => void>(() => {})
  done.current = (r) => {
    if (waiting.current) clearTimeout(waiting.current.timer)
    waiting.current = null
    setAsking(false)
    if (r.ok) onCard()
    else setSaid(r.text || `${capital(words.computer)} couldn't undo that. Nothing was changed.`)
  }

  useEffect(() => {
    const off = client.onFrame('undo.request.result', (f: FrameOf<'undo.request.result'>) => {
      if (waiting.current?.id === f.control_id) done.current({ ok: f.ok, text: f.text })
    })
    // the menu closed: no more waiting, and a late answer finds nobody
    return () => {
      off()
      if (waiting.current) clearTimeout(waiting.current.timer)
      waiting.current = null
    }
  }, [client])

  if (feature !== 'on' || !m.undo) return null
  if (m.undo.state !== 'ready')
    return (
      <span data-testid="msg-undo-off" className={`${ITEM} text-sm text-text-2`}>
        {m.undo.state === 'too_large' ? 'Too large to undo' : 'No undo point was saved'}
      </span>
    )

  const ask = async () => {
    if (waiting.current) return // never disabled while waiting: a disabled control drops keyboard focus on some phones
    setSaid(null)
    if (!client.sendOwnerFrame) {
      setSaid('This build cannot send that.')
      return
    }
    const send = client.sendOwnerFrame.bind(client)
    const control_id = newUlid()
    setAsking(true)
    waiting.current = {
      id: control_id,
      timer: setTimeout(
        () =>
          done.current({
            ok: false,
            text: `${capital(words.computer)} has not answered yet. If an undo card comes, use it; otherwise try again.`,
          }),
        WAIT_MS,
      ),
    }
    try {
      await send({ type: 'undo.request', control_id, thread_id: m.thread_id, message_id: m.id })
    } catch (e) {
      if (waiting.current?.id !== control_id) return // an earlier ask, already answered: not this one's to end
      const text =
        e instanceof TalosClientError && e.code === 'mac_offline'
          ? `${capital(words.computer)} is offline. Try again when it's back.`
          : e instanceof TalosClientError && e.message
            ? e.message
            : `Couldn't reach ${words.computer}.`
      done.current({ ok: false, text })
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="msg-undo"
        className={`${ITEM} hover:bg-surface-2`}
        aria-busy={asking}
        onClick={() => void ask()}
      >
        {asking ? 'Asking…' : 'Undo to here'}
      </button>
      {/* always there, so a screen reader hears the line when it is filled */}
      <p role="status" data-testid="msg-undo-said" className="m-0 px-3 text-sm text-text-2 empty:hidden">
        {said ?? ''}
      </p>
    </>
  )
}
