import { bindingFrom, Card, payloadHash, verifyOwnerFrame } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Suspense } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CallBar,
  CallScreen,
  CardView,
  EventRow,
  HomeScreen,
  InboxScreen,
  IntegrationsScreen,
  LiveCallButton,
  settingsSections,
} from '../src/features/registry.ts'
import { ClientProvider, useTalos, useTalosClient } from '../src/lib/client.ts'
import { createFakeClient } from '../src/lib/fakeClient.ts'
import { getPlatform, webPlatform } from '../src/lib/platform.ts'
import { Badge, Button, Input, Switch } from '../src/ui/index.ts'

function Threads() {
  const names = useTalos((s) => s.threads.map((t) => t.name).join(','))
  const online = useTalos((s) => s.presence.bridge_online)
  return (
    <p>
      {names}|{String(online)}
    </p>
  )
}

describe('fakeClient', () => {
  it('seeds threads, a pending high-risk card and an inbox item from the fixtures', () => {
    const c = createFakeClient()
    const s = c.store.getState()
    expect(s.threads.map((t) => t.id)).toEqual(['general', 'inbox'])
    expect(s.cards[0]?.state).toBe('pending')
    expect(s.cards[0]?.risk).toBe('high')
    expect(s.inbox).toHaveLength(1)
    const card = Card.parse(s.cards[0])
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
  })

  it('sendMessage signs the raw frame (explicit attachments: []) and the fake agent echoes', async () => {
    const c = createFakeClient()
    const res = await c.sendMessage({ threadId: 'general', text: 'hi' })
    expect(res.state).toBe('sent')
    const frame = c.sent[0] as Record<string, unknown>
    expect(frame.attachments).toEqual([])
    expect(await verifyOwnerFrame(frame, await c.publicJwk())).toBe(true)
    await waitFor(() => expect(c.store.getState().messages.general?.at(-1)?.text).toBe('echo: hi'))
  })

  it('signOwnerFrame output verifies over the raw object', async () => {
    const c = createFakeClient()
    const signed = await c.signOwnerFrame({ v: 1, type: 'message', thread_id: 'general', text: 'x', attachments: [] })
    expect(signed.device_id).toMatch(/^d_/)
    expect(await verifyOwnerFrame(signed, await c.publicJwk())).toBe(true)
    expect(await verifyOwnerFrame({ ...signed, text: 'y' }, await c.publicJwk())).toBe(false)
  })

  it('sends are judged by the socket, not the Mac: sent while the relay is up, queued while it is down, held while unpinned', async () => {
    const c = createFakeClient({ macOffline: true })
    expect((await c.sendMessage({ threadId: 'general', text: 'later' })).state).toBe('sent')
    c.store.setState({ connection: 'offline' })
    expect((await c.sendMessage({ threadId: 'general', text: 'later' })).state).toBe('queued')
    c.store.setState({ connection: 'online', devicePinned: false })
    expect((await c.sendMessage({ threadId: 'general', text: 'later' })).state).toBe('held_unpinned')
  })

  it('resolves cards with the hash it is given', async () => {
    const c = createFakeClient({ macOffline: true })
    const card = c.store.getState().cards[0] as NonNullable<ReturnType<typeof c.store.getState>['cards'][0]>
    await c.resolveCard(card.id, { action: 'kill', payloadHash: payloadHash(bindingFrom(card)) })
    expect(c.store.getState().cards[0]?.state).toBe('done')
    expect((c.sent.at(-1) as { payload_hash: string }).payload_hash).toBe(payloadHash(bindingFrom(card)))
  })

  it('patchConfig applies a merge patch against the current rev', async () => {
    const c = createFakeClient()
    await c.patchConfig({ quiet_window: { start: '22:00', end: '06:00' }, agent: { name: 'Atlas' } })
    const cfg = c.store.getState().config
    expect(cfg?.rev).toBe(1)
    expect(cfg?.agent.name).toBe('Atlas')
    expect(cfg?.agent.voice).toBe('meridian')
    expect(cfg?.quiet_window).toEqual({ start: '22:00', end: '06:00' })
    expect((c.sent.at(-1) as { base_rev: number }).base_rev).toBe(0)
  })
})

function Bare() {
  useTalosClient()
  return null
}

// The suite renders without Vitest globals, so Testing Library's automatic cleanup never registers.
afterEach(cleanup)

describe('React wiring', () => {
  it('useTalos reads through ClientProvider and useTalosClient throws outside it', () => {
    const c = createFakeClient()
    render(
      <ClientProvider client={c}>
        <Threads />
      </ClientProvider>,
    )
    expect(screen.getByText('General,Inbox|true')).toBeTruthy()
    expect(() => render(<Bare />)).toThrow(/ClientProvider/)
  })

  it('every registry placeholder renders (lazy, so the shell can mount WP4/WP7 features later)', async () => {
    const c = createFakeClient()
    const card = c.store.getState().cards[0] as NonNullable<ReturnType<typeof c.store.getState>['cards'][0]>
    const item = c.store.getState().inbox[0] as NonNullable<ReturnType<typeof c.store.getState>['inbox'][0]>
    render(
      <ClientProvider client={c}>
        <Suspense fallback="loading">
          <CardView card={card} threadName="General" />
          <HomeScreen />
          <InboxScreen />
          <EventRow item={item} />
          <IntegrationsScreen />
          <LiveCallButton threadId="general" />
          <CallBar threadId="general" onEnd={() => {}} />
          <CallScreen threadId="general" onEnd={() => {}} />
        </Suspense>
      </ClientProvider>,
    )
    // Every lazy entry resolves and mounts the real component: nothing in the registry renders a placeholder any more.
    await waitFor(() => expect(screen.queryByText('loading')).toBeNull(), { timeout: 15_000 }) // waitFor's 1 s default only covers a warm import
    expect(document.querySelectorAll('[data-placeholder]')).toHaveLength(0)
    // 'session' = CC-C3, 'thread-sessions' = Option C OC3, 'share' = WP-V4, 'health' = V2 WP-V1
    expect(settingsSections.map((s) => s.id)).toEqual([
      'agent',
      'session',
      'thread-sessions',
      'voice',
      'integrations',
      'share',
      'health',
    ])
    expect(settingsSections.map((s) => s.order)).toEqual([3, 3.5, 3.6, 4, 5, 5.5, 6.5])
    // Integrations and Health are their own screens: no inline Component, a route instead
    const own = settingsSections.filter((s) => s.href).map((s) => [s.id, s.href, s.Component])
    expect(own).toEqual([
      ['integrations', '/settings/integrations', undefined],
      ['health', '/settings/health', undefined],
    ])
  }, 20_000) // five lazy feature groups import for the first time inside a jsdom worker; the wait below is the real condition
})

describe('ui primitives', () => {
  it('Button defaults to type=button and primary styling; Input and Badge render; Switch toggles', async () => {
    let on = false
    render(
      <div>
        <Button>Send</Button>
        <Input aria-label="name" />
        <Badge tone="accent">Live</Badge>
        <Switch aria-label="notify" onCheckedChange={(v) => (on = v)} />
      </div>,
    )
    const btn = screen.getByRole('button', { name: 'Send' })
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.className).toContain('bg-accent')
    await userEvent.click(screen.getByRole('switch', { name: 'notify' }))
    expect(on).toBe(true)
    expect(screen.getByLabelText('name')).toBeTruthy()
  })
})

describe('platform adapter', () => {
  it('openExternal refuses non-http(s) URLs', () => {
    expect(webPlatform.openExternal('javascript:alert(1)')).toBe(false)
    expect(webPlatform.openExternal('data:text/html,hi')).toBe(false)
    expect(getPlatform()).toBe(webPlatform)
  })
  it('reports push as unsupported without a service worker (jsdom)', () => {
    expect(webPlatform.push.permission()).toBe('unsupported')
  })
})
