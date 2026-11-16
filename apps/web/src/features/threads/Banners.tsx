// Top-of-screen state banners (8.7): network offline, relay unreachable, Mac offline, device not confirmed, and Claude not
// signed in on the agent's computer (presence.main, from the supervisor's state: the computer is on, but nothing answers).

import { useEffect, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { hostSteps, PAIR_WAYS, PC_PAIR, placeWords, useHost, useHostWords } from '../../lib/hostWords.ts'
import { useShownConnection, useShownMacOnline } from '../../lib/linkShown.ts'
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
  // a short drop shows nothing (lib/linkShown.ts): the banners follow the link as shown, not as it is this second
  const connection = useShownConnection()
  const realPresence = useTalos((s) => s.presence)
  const macShown = useShownMacOnline()
  const presence = macShown === realPresence.bridge_online ? realPresence : { ...realPresence, bridge_online: macShown }
  const pinned = useTalos((s) => s.devicePinned)
  const deviceId = useTalos((s) => s.deviceId)
  const retryAt = useConnectionMeta((m) => m.retryAt)
  const netDown = useConnectionMeta((m) => m.networkOffline)
  const netOffline = netDown && connection !== 'online'
  const agent = useAgentName()
  const words = useHostWords()
  const host = useHost()
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
          <span>{placeWords('Waiting for your Mac to confirm this device.', host)}</span>
          {host === 'windows' ? (
            <span className="text-text-2">If your PC isn't asking: {PC_PAIR} Your PC needs to be on.</span>
          ) : host === null ? (
            <span className="text-text-2">
              If your computer isn't asking: {PAIR_WAYS}. Open the new link here, and answer y at the prompt. Your
              computer needs to be on.
            </span>
          ) : (
            <span className="text-text-2">
              {placeWords("If your Mac isn't asking: run ", host)}
              <code>talos-app enroll</code>
              {placeWords(' on it, open the new link here, and answer y at the prompt. Your Mac needs to be on.', host)}
            </span>
          )}
        </div>
      </div>,
    )
  }
  const macState =
    connection === 'online'
      ? presenceMacState(presence.bridge_online, presence.last_seen, nowMs, presence.superseded === true)
      : null
  const { bufferDays } = useRelayLimits(macState !== null) // fetched only once the Mac banner has something to say
  if (macState && !healthOwnsMac) {
    const m = macMessage(macState, { lastSeen: presence.last_seen, bufferDays, host })
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
  if (connection === 'online' && presence.bridge_online && presence.main === 'signin' && words.signin) {
    rows.push(
      <div
        key="signin"
        role="status"
        data-testid="signin-banner"
        className="flex items-start gap-3 bg-surface-2 px-4 py-2.5 text-sm"
      >
        <Mascot state="worried" size={28} name={agent} decorative animate={false} />
        <span className="flex-1">{words.signin}</span>
      </div>,
    )
  }
  if (connection === 'online' && presence.bridge_online && presence.superseded) {
    rows.push(
      <div
        key="two-bridges"
        role="status"
        data-testid="bridge-notice"
        className="flex items-start gap-3 bg-surface-2 px-4 py-2.5 text-sm"
      >
        <IconClock width={18} height={18} className="mt-0.5 shrink-0 text-text-2" />
        <MacMessageText
          cause="Another bridge connected with your key and replaced an earlier one."
          next={hostSteps(host).rotate}
        />
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
