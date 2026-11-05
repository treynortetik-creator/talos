// Top-of-screen state banners (8.7): network offline, relay unreachable, Mac offline, device not confirmed.

import { useEffect, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { IconClock } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { HealthBanner, MacMessageText } from '../health/HealthBanner.tsx'
import { useRelayLimits } from '../health/limits.ts'
import { macMessage, presenceMacState } from '../health/rows.ts'
import { useAgentName } from './useThreads.ts'

function Countdown({ at }: { at: number | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  if (!at) return null
  return <> Retrying in {Math.max(0, Math.ceil((at - now) / 1000))} s…</>
}

export function Banners() {
  const client = useTalosClient()
  const connection = useTalos((s) => s.connection)
  const presence = useTalos((s) => s.presence)
  const pinned = useTalos((s) => s.devicePinned)
  const deviceId = useTalos((s) => s.deviceId)
  const retryAt = useConnectionMeta((m) => m.retryAt)
  const netOffline = useConnectionMeta((m) => m.networkOffline)
  const agent = useAgentName()
  // dropped turns into asleep with the clock, not only when a frame arrives
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // what the health banner is already saying about the Mac (a refused key, or gone for a while): say it once
  const [healthKind, setHealthKind] = useState<string | null>(null)
  const healthOwnsMac = healthKind === 'key_refused' || healthKind === 'bridge_offline'
  const rows: React.ReactNode[] = []

  if (netOffline || connection === 'offline') {
    rows.push(
      <div key="net" role="status" className="flex items-center gap-3 bg-surface-2 px-4 py-2.5 text-sm">
        <Mascot state="worried" size={28} name={agent} decorative animate={false} />
        <span className="flex-1">You're offline. Messages will send when you're back.</span>
        <Button variant="outline" onClick={() => client.reconnect()}>
          Retry
        </Button>
      </div>,
    )
  } else if (connection === 'unreachable') {
    rows.push(
      <div key="relay" role="status" className="flex items-center gap-3 bg-surface-2 px-4 py-2.5 text-sm">
        <Mascot state="worried" size={28} name={agent} decorative animate={false} />
        <span className="flex-1">
          Can't reach your server.
          <Countdown at={retryAt} />
        </span>
        <Button variant="outline" onClick={() => client.reconnect()}>
          Retry now
        </Button>
      </div>,
    )
  } else if (connection === 'online' && deviceId && !pinned) {
    rows.push(
      <div key="pin" role="status" className="flex items-start gap-3 bg-surface-2 px-4 py-2.5 text-sm">
        <IconClock width={18} height={18} className="mt-0.5 shrink-0 text-text-2" />
        <div className="flex flex-col gap-1">
          <span>Waiting for your Mac to confirm this device.</span>
          <span className="text-text-2">
            If your Mac isn't asking: run <code>talos-app enroll</code> on it, open the new link here, and answer y at
            the prompt. Your Mac needs to be on.
          </span>
        </div>
      </div>,
    )
  }
  const macState = connection === 'online' ? presenceMacState(presence.bridge_online, presence.last_seen, nowMs) : null
  const { bufferDays } = useRelayLimits(macState !== null) // fetched only once the Mac banner has something to say
  if (macState && !healthOwnsMac) {
    const m = macMessage(macState, { lastSeen: presence.last_seen, bufferDays })
    rows.push(
      <div
        key="mac"
        role="status"
        data-testid="mac-banner"
        data-kind={m.kind}
        className="flex items-start gap-3 bg-surface-2 px-4 py-2.5 text-sm"
      >
        <Mascot state="worried" size={28} name={agent} decorative animate={false} />
        <MacMessageText cause={m.cause} next={m.next} />
      </div>,
    )
  }
  return (
    <div className={rows.length > 0 ? 'border-b border-line' : undefined}>
      {rows}
      <HealthBanner onShowing={setHealthKind} />
    </div>
  )
}
