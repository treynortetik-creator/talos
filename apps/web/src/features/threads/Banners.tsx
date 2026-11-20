// Top-of-screen state banners (8.7): network offline, relay unreachable, Mac offline, device not confirmed, and Claude not
// signed in on the agent's computer (presence.main, from the supervisor's state: the computer is on, but nothing answers).

import { useEffect, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { hostSteps, PAIR_WAYS, PC_PAIR, placeWords, useHost, useHostWords } from '../../lib/hostWords.ts'
import { useShownConnection, useShownMacOnline } from '../../lib/linkShown.ts'
import { Button } from '../../ui/index.ts'
import { HealthLink, useHealthBannerInfo } from '../health/HealthBanner.tsx'
import { useRelayLimits } from '../health/limits.ts'
import { macMessage, presenceMacState } from '../health/rows.ts'
import { type BannerEntry, BannerLine } from './BannerLine.tsx'

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
  const words = useHostWords()
  const host = useHost()
  // dropped turns into asleep with the clock, not only when a frame arrives
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // the health notice (a refused key, or gone for a while) already says what the Mac banner would: say it once
  const health = useHealthBannerInfo()
  const healthOwnsMac = health?.kind === 'key_refused' || health?.kind === 'bridge_offline'
  const entries: BannerEntry[] = []

  if (netOffline || connection === 'offline') {
    entries.push({
      key: 'net',
      icon: 'worried',
      cause: "You're offline. Messages will send when you're back.",
      action: retryButton('Retry', () => client.reconnect()),
    })
  } else if (connection === 'unreachable') {
    entries.push({
      key: 'relay',
      icon: 'worried',
      cause: "Can't reach your server.",
      detail: retryAt ? <Countdown at={retryAt} /> : undefined,
      action: retryButton('Retry now', () => client.reconnect()),
    })
  } else if (connection === 'online' && deviceId && !pinned) {
    entries.push({
      key: 'pin',
      icon: 'clock',
      cause: placeWords('Waiting for your Mac to confirm this device.', host),
      detail:
        host === 'windows' ? (
          <>If your PC isn't asking: {PC_PAIR} Your PC needs to be on.</>
        ) : host === null ? (
          <>
            If your computer isn't asking: {PAIR_WAYS}. Open the new link here, and answer y at the prompt. Your
            computer needs to be on.
          </>
        ) : (
          <>
            {placeWords("If your Mac isn't asking: run ", host)}
            <code>talos-app enroll</code>
            {placeWords(' on it, open the new link here, and answer y at the prompt. Your Mac needs to be on.', host)}
          </>
        ),
    })
  }
  const macState =
    connection === 'online'
      ? presenceMacState(presence.bridge_online, presence.last_seen, nowMs, presence.superseded === true)
      : null
  const { bufferDays } = useRelayLimits(macState !== null) // fetched only once the Mac banner has something to say
  if (macState && !healthOwnsMac) {
    const m = macMessage(macState, { lastSeen: presence.last_seen, bufferDays, host })
    entries.push({ key: 'mac', testId: 'mac-banner', kind: m.kind, icon: 'worried', cause: m.cause, detail: m.next })
  }
  if (connection === 'online' && presence.bridge_online && presence.main === 'signin' && words.signin) {
    entries.push({ key: 'signin', testId: 'signin-banner', icon: 'worried', cause: words.signin })
  }
  if (connection === 'online' && presence.bridge_online && presence.superseded) {
    entries.push({
      key: 'two-bridges',
      testId: 'bridge-notice',
      icon: 'clock',
      cause: "Talos on another computer took your Mac's place.",
      detail: hostSteps(host).rotate,
    })
  }
  if (health) {
    entries.push({
      key: 'health',
      testId: 'health-banner',
      kind: health.kind,
      icon: 'worried',
      cause: health.text,
      detail: health.next,
      action: <HealthLink className="inline-flex min-h-11 shrink-0 items-center px-1 font-semibold underline" />,
    })
  }
  return <BannerLine entries={entries} />
}

function retryButton(label: string, onClick: () => void) {
  return (
    <Button variant="outline" className="px-3" onClick={onClick}>
      {label}
    </Button>
  )
}
