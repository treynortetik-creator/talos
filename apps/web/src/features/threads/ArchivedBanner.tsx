// An archived thread opened by link, search or a card still looks live. This says so and offers Restore (owner call O19).
// The composer below stays on: writing to an archived thread is allowed, it just does not un-archive it. Delete does not
// exist and is not added here.
//
// Restore is the same config patch ThreadRowMenu uses (`useThreadPatch`, owner-signed, applied by the Mac), so it needs the
// Mac online and says so when it is not, exactly as the row menu does.
import type { ThreadT } from '@talos-app/protocol'
import { Button } from '../../ui/index.ts'
import { useThreadPatch } from './manage/useThreadPatch.ts'

export function ArchivedBanner({ thread }: { thread: ThreadT }) {
  const { macOnline, busy, err, apply } = useThreadPatch()
  const restore = () => void apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, archived: false } : t)))
  const note = err ?? (!macOnline ? 'Your Mac has to be online for this.' : null)
  return (
    <section
      aria-label="Archived thread"
      data-testid="archived-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm"
    >
      <span className="font-medium text-text">Archived</span>
      <span className="min-w-0 flex-1 text-text-2">This thread is hidden from your list.</span>
      <Button variant="outline" data-testid="archived-restore" disabled={!macOnline || busy} onClick={restore}>
        Restore
      </Button>
      {note ? (
        <p role={err ? 'alert' : 'status'} data-testid="archived-note" className="m-0 basis-full text-sm text-text-2">
          {note}
        </p>
      ) : null}
    </section>
  )
}
