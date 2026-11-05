// One row of Settings, Account, Devices. The name wraps (a long name is shown whole), the badges sit on their own line so
// "This device" can never be pushed out or cut, and a device the relay has no use time for says so instead of "never used".
import type { RouteRes } from '@talos-app/protocol'
import { fingerprintWords } from '@talos-app/protocol'
import type { MouseEvent } from 'react'
import { ago } from '../../lib/format.ts'
import { Badge, Button } from '../../ui/index.ts'

type Device = RouteRes<'devicesList'>[number]

/** "used 3 min ago", or "last used unknown" when the relay has no time (older rows were never stamped) or an unreadable one. */
export function lastUsedText(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'last used unknown'
  return `used ${ago(iso, nowMs)}`
}

/** The four fingerprint words for an id, or nothing for an id that does not parse: one odd row never takes the list down. */
function wordsOf(id: string): string {
  try {
    return `${fingerprintWords(id).join(' ')} · `
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
                Revoked
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
        <div className="break-words font-mono text-xs text-text-2">
          {wordsOf(d.id)}
          {lastUsedText(d.last_used_at)}
        </div>
      </div>
      {!d.revoked && (
        <Button variant="danger" className="shrink-0" onClick={onRevoke} aria-label={`Revoke ${d.name}`}>
          Revoke
        </Button>
      )}
    </div>
  )
}
