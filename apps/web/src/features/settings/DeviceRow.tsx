// One row of Settings, Account, Your devices. The name wraps (a long name is shown whole), the badges sit on their own line so
// "This device" can never be pushed out or cut, and a device the relay has no use time for says so instead of "never".
import type { RouteRes } from '@talos-app/protocol'
import { fingerprintWords } from '@talos-app/protocol'
import type { MouseEvent } from 'react'
import { ago } from '../../lib/format.ts'
import { Badge, Button } from '../../ui/index.ts'

type Device = RouteRes<'devicesList'>[number]

/** "Last seen 3 min ago", or "Last seen: not known" when the relay has no time (older rows were never stamped) or an unreadable one. */
export function lastUsedText(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'Last seen: not known'
  return `Last seen ${ago(iso, nowMs)}`
}

const ADDED = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** "Added Oct 1, 2026" in the local zone, or nothing when the time is missing or unreadable. */
export function addedText(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '' : `Added ${ADDED.format(ms)}`
}

/** The four fingerprint words for an id, or nothing for an id that does not parse: one odd row never takes the list down. */
function wordsOf(id: string): string {
  try {
    return fingerprintWords(id).join(' ')
  } catch {
    return ''
  }
}

export function DeviceRow({
  device: d,
  isThisDevice,
  onRevoke,
}: {
  device: Device
  isThisDevice: boolean
  onRevoke: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const unconfirmed = !d.pinned && !d.revoked
  const keyUnverified = d.pinned && !d.revoked && d.login_proven_at === null
  return (
    <div
      data-testid="device-row"
      className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{d.name}</div>
        {(isThisDevice || d.revoked || unconfirmed || keyUnverified) && (
          <div className="my-1 flex flex-wrap gap-1">
            {isThisDevice && (
              <Badge tone="accent" className="shrink-0 whitespace-nowrap">
                This device
              </Badge>
            )}
            {d.revoked && (
              <Badge tone="danger" className="whitespace-nowrap">
                Removed
              </Badge>
            )}
            {unconfirmed && (
              <Badge tone="warn" className="whitespace-nowrap">
                Not confirmed
              </Badge>
            )}
            {keyUnverified && (
              <Badge tone="warn" className="whitespace-nowrap">
                Key not verified
              </Badge>
            )}
          </div>
        )}
        {/* when, in plain words, on its own line; the fingerprint words (to match the Mac's list) below it, smaller */}
        <div data-testid="device-when" className="break-words text-sm text-text-2">
          {[addedText(d.created_at), lastUsedText(d.last_used_at)].filter(Boolean).join(' · ')}
        </div>
        <div className="break-words font-mono text-xs text-text-2">{wordsOf(d.id)}</div>
      </div>
      {!d.revoked && (
        <Button variant="danger" className="shrink-0" onClick={onRevoke} aria-label={`Remove ${d.name}`}>
          Remove
        </Button>
      )}
    </div>
  )
}
