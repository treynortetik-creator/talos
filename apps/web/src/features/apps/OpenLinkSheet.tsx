// `ui/open-link` (M2.3): the view never leaves the device by itself. The owner sees the whole URL in mono and
// chooses; only [Open] reaches `platform.openExternal`.
import { useEffect, useState } from 'react'
import { Button } from '../../ui/index.ts'
import { BoxSheet } from './BoxSheet.tsx'
import { OPEN_ARM_MS } from './limits.ts'

export function OpenLinkSheet({
  url,
  label,
  container,
  onDecide,
}: {
  url: string | null
  label: string
  container: HTMLElement | null
  onDecide: (open: boolean) => void
}) {
  // [Open] is dead for a moment: a view can ask for the link on a tap and hope the next tap lands where [Open] appears.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setArmed(false)
    if (url === null) return
    const t = setTimeout(() => setArmed(true), OPEN_ARM_MS)
    return () => clearTimeout(t)
  }, [url])
  return (
    <BoxSheet
      open={url !== null}
      onOpenChange={(o) => !o && onDecide(false)}
      container={container}
      title={`Open a link from ${label}?`}
      description="This opens outside Talos, in your browser."
    >
      <p
        data-testid="open-link-url"
        className="m-0 rounded-card border border-line bg-surface-2 p-3 font-mono text-sm [overflow-wrap:anywhere]"
      >
        {url}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" onClick={() => onDecide(false)}>
          Cancel
        </Button>
        <Button disabled={!armed} onClick={() => armed && onDecide(true)}>
          Open
        </Button>
      </div>
    </BoxSheet>
  )
}
