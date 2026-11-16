// Settings > Storage: how long this Mac keeps the attachments it downloaded (config `media_keep_days`; keep forever is the
// default). The owner's own setting, written through the signed config path like the rest; the agent can never change it.
// Shortening the time asks first, with what it would remove as the Mac counted it (the health beat's media_by_age), and
// the Mac waits an hour before it removes anything, so a mis-tap can be put back.
import { MEDIA_KEEP_CHOICES } from '@talos-app/protocol'
import { useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/index.ts'
import { useHealthStatus } from '../health/useHealthStatus.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import type { SectionProps } from './sections.tsx'

const label = (d: number | null) => (d === null ? 'Keep forever' : d === 365 ? '1 year' : `${d} days`)
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`

/** The confirm's words for a new setting of `days`, from the Mac's own count when it has sent one. */
export function removalWarning(
  days: number,
  byAge: ReadonlyArray<{ days: number; files: number; bytes: number }> | undefined,
) {
  const s = byAge?.find((x) => x.days === days)
  const what = s
    ? s.files === 0
      ? 'Nothing on this Mac is old enough to be removed yet.'
      : `This removes about ${s.files} file${s.files === 1 ? '' : 's'} (${size(s.bytes)}) older than ${days} days from this Mac.`
    : `This removes attachments older than ${days} days from this Mac.`
  return `${what} They can't be downloaded again. Files still in use are always kept, and nothing is removed for an hour, so you can change it back.`
}

export function MediaRetentionSection({ readOnly }: SectionProps) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const { state } = useHealthStatus()
  const byAge = state.status?.beat?.media_by_age
  const current = config?.media_keep_days ?? null
  const [asking, setAsking] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const apply = async (v: number | null) => {
    setNote(null)
    try {
      await client.patchConfig({ media_keep_days: v })
    } catch (e) {
      setNote(friendlyPatchError(e))
    }
  }
  // keeping longer (or forever) removes nothing more: no question. A shorter time asks first.
  const choose = (v: number | null) => {
    if (v === current) return
    if (v !== null && (current === null || v < current)) setAsking(v)
    else void apply(v)
  }
  return (
    <section aria-labelledby="storage" className="flex flex-col gap-3">
      <h2 id="storage" className="m-0 text-base font-semibold">
        Storage
      </h2>
      <div className="flex flex-col gap-1">
        <label htmlFor="media-keep" className="block">
          Keep message attachments on this Mac
        </label>
        <span className="block text-xs text-text-2">Files still in use are always kept.</span>
        <select
          id="media-keep"
          className="min-h-11 max-w-xs rounded-button border border-line bg-surface px-3"
          value={current === null ? 'forever' : String(current)}
          disabled={readOnly || !config}
          onChange={(e) => choose(e.target.value === 'forever' ? null : Number(e.target.value))}
        >
          <option value="forever">{label(null)}</option>
          {MEDIA_KEEP_CHOICES.map((d) => (
            <option key={d} value={String(d)}>
              {label(d)}
            </option>
          ))}
          {current !== null && !(MEDIA_KEEP_CHOICES as readonly number[]).includes(current) && (
            <option value={String(current)}>{label(current)}</option>
          )}
        </select>
      </div>
      {note && (
        <p role="alert" className="m-0 text-sm text-danger">
          {note}
        </p>
      )}
      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent>
          <DialogTitle>Keep attachments for {asking === null ? '' : label(asking)}?</DialogTitle>
          <DialogDescription>{asking === null ? '' : removalWarning(asking, byAge)}</DialogDescription>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const v = asking
                setAsking(null)
                if (v !== null) void apply(v)
              }}
            >
              Remove older files
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
