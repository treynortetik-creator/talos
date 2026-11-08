// Shared test helpers for WP7's unit tests (jsdom). Everything runs against the in-memory fake client.
import { bindingFrom, Card, type CardT, InboxItem, type InboxItemT, payloadHash } from '@talos-app/protocol'
import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { ClientProvider, useTalos } from '../../src/lib/client.ts'
import { createFakeClient, type FakeClient, type FakeClientOptions } from '../../src/lib/fakeClient.ts'

// Vitest runs without globals, so Testing Library's automatic cleanup never registers.
afterEach(cleanup)

export const FUTURE = '2099-01-01T00:00:00.000Z'

let n = 0
const ulid = () => {
  n += 1
  return `01JBF3V7Q8K2M4N6P8R0S${String(n).padStart(5, '0')}`.slice(0, 26)
}

/** A valid pending card whose `payload_hash` really is the hash of its binding. */
export function makeCard(over: Record<string, unknown> = {}): CardT {
  const base = {
    id: `c_${ulid()}`,
    thread_id: 'general',
    kind: 'email',
    title: 'Reply to the venue',
    destination: [{ label: 'To', value: 'events@example.com' }],
    body: 'Hi, thanks for holding the room.',
    body_format: 'plain',
    fields: [
      { key: 'subject', label: 'Subj', value: 'Re: Saturday booking', editable: true, multiline: false },
      { key: 'cc', label: 'Cc', value: 'ops@example.com', editable: false, multiline: false },
    ],
    attachments: [],
    primary_label: 'Send',
    kill_label: 'Kill draft',
    allow_edit: true,
    allow_revise: true,
    risk: 'low',
    origin: 'chat',
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: '2026-10-28T15:00:00.000Z',
    expires_at: FUTURE,
    ...over,
  }
  const card = Card.parse(base)
  if (over.payload_hash === undefined) card.payload_hash = payloadHash(bindingFrom(card))
  return card
}

export function makeItem(over: Record<string, unknown> = {}): InboxItemT {
  n += 1
  return InboxItem.parse({
    id: `e_${ulid()}`,
    source: 'github',
    connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
    kind: 'github.review_requested',
    title: 'Review requested',
    summary: 'octocat requested your review',
    actor: { name: 'octocat' },
    ts: '2026-10-28T15:32:10.000Z',
    thread: 'inbox',
    work: false,
    priority: 'high',
    state: 'new',
    ...over,
  })
}

export function setup(opts: FakeClientOptions & { cards?: CardT[]; inbox?: InboxItemT[] } = {}): FakeClient {
  const client = createFakeClient(opts)
  client.store.setState((s) => ({
    ...s,
    cards: opts.cards ?? [],
    inbox: opts.inbox ?? [],
  }))
  return client
}

export function LocationProbe() {
  const l = useLocation()
  return (
    <div data-testid="location" data-state={JSON.stringify(l.state ?? null)}>
      {l.pathname}
    </div>
  )
}

export function renderWith(ui: ReactElement, client: FakeClient, route = '/', path = '*') {
  return render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </ClientProvider>,
  )
}

/** Renders the card currently in the store (as WP6's timeline does), so resolves show up in the view. */
export function LiveCard({
  id,
  threadName = 'General',
  highlighted,
}: {
  id: string
  threadName?: string
  highlighted?: boolean
}) {
  const card = useTalos((s) => s.cards.find((c) => c.id === id))
  return card ? <CardView card={card} threadName={threadName} {...(highlighted ? { highlighted } : {})} /> : null
}
