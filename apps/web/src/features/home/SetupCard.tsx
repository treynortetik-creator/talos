// One dismissible Home card after pairing: notifications are off on this device. Nothing here prompts by itself; the
// permission dialog only ever comes from the tap on "Turn on notifications". The share sheet lives in Settings.
import { useEffect, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { Button } from '../../ui/index.ts'
import { enableNativePush, refreshNativePush, useNativePush } from '../pwa/nativePush.ts'
import { enablePush, usePushState } from '../pwa/push.ts'

export const SETUP_DISMISSED_KEY = 'talos.setupCard.dismissed'

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function SetupCard({ onSettings }: { onSettings: () => void }) {
  const client = useTalosClient()
  const [dismissed, setDismissed] = useState(wasDismissed)
  const web = usePushState()
  const native = useNativePush()
  const [tried, setTried] = useState(false)
  // Read the truth when the card mounts: the iPhone app's native state starts at "checking" and only Settings used to
  // refresh it; the web permission starts at "default" until the open-time refresh lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
  useEffect(() => {
    usePushState.getState().refresh()
    if (useNativePush.getState().view.kind === 'checking') void refreshNativePush({ client })
  }, [])
  // In the iPhone app the native state decides; in a browser the web permission does.
  const inApp = native.view.kind !== 'hidden'
  const v = native.view
  const off = inApp ? v.kind === 'off' : web.permission === 'default'
  // After a tap that failed, the card stays and says why instead of vanishing.
  const failed = inApp && tried && (v.kind === 'error' || v.kind === 'needs_setup' || v.kind === 'blocked')
  if (dismissed || (!off && !failed)) return null
  const busy = inApp ? native.busy : web.busy
  const failure =
    v.kind === 'error'
      ? v.message
      : v.kind === 'blocked'
        ? 'Notifications are blocked for Talos in iOS Settings.'
        : v.kind === 'needs_setup'
          ? "Notifications aren't set up on this phone or server yet."
          : null
  const message = inApp ? (failed ? failure : native.note) : web.message
  return (
    <section
      aria-label="Set up this device"
      data-testid="setup-card"
      className="incised flex flex-col gap-2 rounded-card bg-surface p-4"
    >
      <p className="m-0 font-medium text-text">Get pinged when Talos needs you</p>
      <p className="m-0 text-sm text-text-2">
        Notifications are off on this device.
        {inApp ? ' You can also add Talos to your share sheet in Settings.' : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            setTried(true)
            void (inApp ? enableNativePush({ client }) : enablePush())
          }}
          data-testid="setup-enable"
        >
          Turn on notifications
        </Button>
        <Button variant="outline" onClick={onSettings}>
          Open Settings
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            try {
              localStorage.setItem(SETUP_DISMISSED_KEY, '1')
            } catch {
              /* it hides for this visit; it may return next open */
            }
            setDismissed(true)
          }}
        >
          Not now
        </Button>
      </div>
      {message ? (
        <p role="status" className="m-0 text-sm text-text-2">
          {message}
        </p>
      ) : null}
    </section>
  )
}
