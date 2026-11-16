// The first-week screens, rendered for each computer the agent can run on: a Mac reads its sentences as before; a
// Windows PC, a Linux box and a computer not known yet (every first pairing) read no "Mac" (lib/hostWords.ts).
import { HOST_LINUX_FEATURE, HOST_MAC_FEATURE, HOST_WINDOWS_FEATURE, type Host } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OfflineBadge } from '../../src/features/agents/AgentsList.tsx'
import { EmptyState } from '../../src/features/schedules/Empty.tsx'
import { OfflineBanner } from '../../src/features/schedules/Health.tsx'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { hostFrom, PAIR_WAYS, rememberedHost, rememberHost } from '../../src/lib/hostWords.ts'
import { onReady } from '../../src/lib/socket-frames-catchup.ts'
import type { FrameContext } from '../../src/lib/socket-frames-context.ts'

const FEATURE: Record<Host, string> = {
  mac: HOST_MAC_FEATURE,
  windows: HOST_WINDOWS_FEATURE,
  linux: HOST_LINUX_FEATURE,
}
const HOSTS: Array<Host | null> = ['mac', 'windows', 'linux', null]
const MAC_WORD = /\bMac\b/

function on(
  host: Host | null,
  patch: (s: ReturnType<ReturnType<typeof createFakeClient>['store']['getState']>) => object = () => ({}),
) {
  const client = createFakeClient({ host: host ?? 'none' })
  const s = client.store.getState()
  const rest = (s.presence.features ?? []).filter((f) => !Object.values(FEATURE).includes(f))
  client.store.setState({ presence: { ...s.presence, features: host ? [FEATURE[host], ...rest] : rest } })
  client.store.setState(patch(client.store.getState()))
  return (ui: ReactNode) =>
    render(
      <ClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </ClientProvider>,
    ).container.textContent ?? ''
}

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe('rendered for each host', () => {
  it("the schedules screens: a Mac's words as before; elsewhere no Mac, and no Chronos command off a Mac", () => {
    for (const host of HOSTS) {
      const r = on(host)
      const empty = r(<EmptyState kind="not_installed" agent="Talos" snapshot={null} onTell={() => {}} />)
      cleanup()
      const offline = r(<EmptyState kind="mac_offline" agent="Talos" snapshot={null} onTell={() => {}} />)
      cleanup()
      const banner = r(<OfflineBanner asOf={null} />)
      cleanup()
      if (host === 'mac') {
        expect(empty).toContain('No scheduler on your Mac yet. Talos uses Chronos to run jobs on a schedule.')
        expect(offline).toContain('Your Mac is offline.Schedules show up here once your Mac is back.')
        expect(banner).toBe('Your Mac is offline. Changes and Run now need your Mac.')
        continue
      }
      for (const t of [empty, offline, banner]) expect(t, `${host}`).not.toMatch(MAC_WORD)
      // off a Mac: Chronos runs jobs in a Talos thread only; the PC's Setup installs it, so there it is a Setup to finish
      if (host === 'windows') expect(empty).toBe('Run Talos Setup again to set up scheduled jobs.')
      if (host === 'linux') {
        expect(empty).toContain('Install Chronos to schedule jobs here: jobs that run in a Talos thread work on Linux.')
        expect(empty).toContain('&& cd chronos && ./install.sh')
        expect(empty).toContain('Then run talos-app schedules adopt.')
      }
      // nothing on the PC says a job "works" until the after-sign-in check passes (Pantheon)
      if (host === 'windows') expect(empty).not.toMatch(/\bwork/i)
    }
  })

  it('the agents list badge', () => {
    for (const host of HOSTS) {
      const t = on(host)(<OfflineBadge offline="mac" />)
      cleanup()
      expect(t).toBe(host === 'mac' ? 'Mac offline' : host === 'windows' ? 'PC offline' : 'Computer offline')
    }
  })

  it('the pairing wait banner names a way that exists on that computer, and never Mac elsewhere', () => {
    for (const host of HOSTS) {
      const t = on(host, () => ({ connection: 'online', deviceId: 'd_test', devicePinned: false }))(<Banners />)
      cleanup()
      if (host === 'mac') {
        expect(t).toContain(
          "Waiting for your Mac to confirm this device.If your Mac isn't asking: run talos-app enroll on it, open the new link here, and answer y at the prompt. Your Mac needs to be on.",
        )
        continue
      }
      // a first pairing (unknown host) names every platform's way, a Mac's included; nothing else says Mac
      expect(t.replace(PAIR_WAYS, ''), `${host}`).not.toMatch(MAC_WORD)
      if (host === 'windows') expect(t).toMatch(/Pair a phone…/)
      if (host === 'windows') expect(t).not.toMatch(/talos-app|scan/)
      if (host === null) expect(t).toContain(PAIR_WAYS)
    }
  })
})

describe('the remembered host', () => {
  it('keeps only a known host, and the live one wins', () => {
    expect(rememberedHost()).toBeNull()
    rememberHost(null)
    expect(rememberedHost()).toBeNull()
    rememberHost('linux')
    expect(rememberedHost()).toBe('linux')
    expect(hostFrom(undefined)).toBe('linux') // before sign-in and while offline
    expect(hostFrom([HOST_MAC_FEATURE])).toBe('mac')
    localStorage.setItem('talos.host', 'amiga')
    expect(rememberedHost()).toBeNull()
  })
})

describe('learning the host', () => {
  it('a ready frame teaches it, not only a presence change (the relay sends presence only when it changes)', () => {
    const frame = { ...readyFixture, presence: { ...readyFixture.presence, features: [HOST_MAC_FEATURE] } }
    // every context call is a no-op: only what onReady remembers is read here
    const ctx = new Proxy({}, { get: () => () => 0 }) as unknown as FrameContext
    try {
      onReady(ctx, frame as never)
    } catch {
      // the stub context can't hold the rest of the catch-up; the host is learned first
    }
    expect(rememberedHost()).toBe('mac')
  })
})

describe('the schedule form off a Mac', () => {
  const BACKGROUND = /in the background \(no session needed\)|runs without your session/i
  it('a Mac keeps both runners, as before; elsewhere only a Talos thread, and the line says why', () => {
    for (const host of HOSTS) {
      const t = on(host)(<ScheduleForm mode="create" />)
      cleanup()
      if (host === 'mac') {
        expect(t).toContain('In my live session')
        expect(t).toContain('In the background (no session needed)')
        expect(t).toContain('Only the tools I list')
        continue
      }
      if (host === null) continue // not known yet: the Mac's form, as an older bridge has always had
      expect(t, `${host}`).not.toMatch(BACKGROUND)
      expect(t, `${host} form says Mac`).not.toMatch(/\bMac\b/)
      expect(t).toContain('In a Talos thread')
      expect(t, `${host} offers listed tools`).not.toContain('Only the tools I list')
      expect(t).toContain(
        host === 'windows'
          ? "Jobs that run by themselves in the background need a timer that isn't on a Windows PC yet."
          : "Jobs that run by themselves in the background need a timer that isn't on this computer yet.",
      )
    }
  })
})
