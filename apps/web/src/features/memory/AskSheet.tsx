// [Ask {agent}] on a note (docs/V2-FEATURES.md V5.3): pick a thread, then a signed `message` with `refs`. The Mac
// re-checks the note before the agent sees it.
import { newId } from '@talos-app/protocol'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { Button, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, Textarea } from '../../ui/index.ts'
import { useVisibleThreads } from '../threads/useThreads.ts'

export function AskSheet({
  open,
  onOpenChange,
  agent,
  title,
  refInfo,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  agent: string
  title: string
  refInfo: { rootId: string; path: string; sha256: string }
}) {
  const client = useTalosClient()
  const nav = useNavigate()
  const threads = useVisibleThreads()
  const [thread, setThread] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = thread ?? threads[0]?.id ?? null

  const send = async () => {
    if (!pick || !client.sendOwnerFrame) return
    setBusy(true)
    setError(null)
    try {
      await client.sendOwnerFrame({
        type: 'message',
        thread_id: pick,
        client_msg_id: newId('m'),
        text: text.trim() || `Here is a note: ${title}`,
        attachments: [],
        refs: [{ kind: 'memory', root_id: refInfo.rootId, path: refInfo.path, sha256: refInfo.sha256 }],
      })
      onOpenChange(false)
      setText('')
      nav(`/t/${pick}`)
    } catch (e) {
      setError(
        e instanceof TalosClientError && e.code === 'mac_offline'
          ? 'Needs your Mac.'
          : "Couldn't send that. Try again.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} data-testid="memory-ask-sheet">
        <SheetTitle className="m-0 font-display text-lg font-semibold">Ask {agent} about this note</SheetTitle>
        <SheetDescription className="mt-1 text-sm text-text-2">
          {agent} can read “{title}” as it is now. Nothing else in your notes is shared.
        </SheetDescription>
        <fieldset className="mt-3 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Which thread?</legend>
          {threads.map((t) => (
            <label key={t.id} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="memory-thread" checked={pick === t.id} onChange={() => setThread(t.id)} />
              {t.name}
            </label>
          ))}
        </fieldset>
        <Textarea
          className="mt-3 min-h-20"
          aria-label="Your question (optional)"
          placeholder="Your question (optional)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <SheetClose asChild>
            <Button variant="ghost">Cancel</Button>
          </SheetClose>
          <Button onClick={() => void send()} disabled={busy || !pick} data-testid="memory-ask-send">
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
