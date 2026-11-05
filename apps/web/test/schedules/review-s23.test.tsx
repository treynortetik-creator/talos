// Review S2+S3 (merged): failing tests for bugs found in the Schedules tab, driven by the real-bridge captures.
import type { CardT, ScheduleChangeT } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickBanner } from '../../src/features/schedules/logic.ts'
import { ProposalSheet } from '../../src/features/schedules/Proposal.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { cards, snapshots } from './captured.ts'

afterEach(() => cleanup())

describe('B1: a real TCC stall leaves no way to Retry background runs', () => {
  // 15-background-stalled is what the REAL bridge reports for a stalled headless run: tcc_suspected AND headless_blocked.
  // The banner shows only the worst issue (tcc_suspected), whose fix text ends "4. Tap Retry background runs." But only
  // a headless_blocked banner carries `retry`, so the sheet the owner can open has no Retry button anywhere.
  it('the banner the owner actually sees for the captured stall offers Retry', () => {
    const stalled = snapshots('15-background-stalled')[0]
    if (!stalled) throw new Error('capture missing')
    const b = pickBanner(stalled)
    expect(b?.code).toBe('tcc_suspected')
    expect(b?.fix?.some((s) => /Retry background runs/.test(s))).toBe(true) // the steps tell the owner to tap it
    expect(b?.retry).toBe(true) // FAILS: retry is only set for headless_blocked
  })
})

describe('B3: "Review again" after a conflict re-sends the identical stale change', () => {
  // A ProposalSheet (Delete, Turn on, Adopt) captures `change` when it opens. After the bridge fails the card with
  // "The job changed on your Mac ... Nothing was saved", [Review again] proposes the SAME change again, base_etag and
  // all. The bridge refuses a stale base_etag at patch time (capture 11, "schedule_conflict: a stale etag"), so the
  // button can never produce a fresh card. It must re-propose against the job as it is now.
  it('the second proposal is drawn against the current etag, not the one the sheet opened with', async () => {
    const client = createFakeClient()
    const snap = snapshots('02-list-three-jobs')[0]
    if (!snap) throw new Error('capture missing')
    const OLD = snap.schedules[0]?.etag as string
    const id = snap.schedules[0]?.id as string
    client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, snapshot: snap, status: 'ready' } }))
    const calls: ScheduleChangeT[] = []
    const refs = ['01JAAAAAAAAAAAAAAAAAAAAAA1', '01JAAAAAAAAAAAAAAAAAAAAAA2']
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      calls.push(change)
      return { clientRef: refs[calls.length - 1] as string }
    })
    render(
      <ClientProvider client={client}>
        <ProposalSheet
          title="Delete"
          threadId="general"
          change={{ op: 'delete', id, base_etag: OLD }}
          onClose={() => {}}
        />
      </ClientProvider>,
    )
    await waitFor(() => expect(calls).toHaveLength(1))
    // the Mac changed the job (new etag in the list) and failed the card as the real bridge does (capture 16)
    const NEW = `sha256:${'e'.repeat(64)}`
    const captured = cards('16-apply-conflict')[0] as CardT
    const failed: CardT = {
      ...captured,
      payload: { ...(captured.payload as object), client_ref: refs[0] },
      state: 'failed',
      result: {
        ok: false,
        text: 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
        at: new Date().toISOString(),
      },
    }
    // the fake Mac holds the new revision too: Review again re-fetches it from there
    client.schedules.setData({ ...snap, schedules: snap.schedules.map((x) => (x.id === id ? { ...x, etag: NEW } : x)) })
    act(() => {
      client.store.setState((s) => ({
        ...s,
        cards: [...s.cards, failed],
        schedules: {
          ...s.schedules,
          snapshot: { ...snap, schedules: snap.schedules.map((x) => (x.id === id ? { ...x, etag: NEW } : x)) },
        },
      }))
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Review again' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    const second = calls[1] as Extract<ScheduleChangeT, { op: 'delete' }>
    expect(second.base_etag).toBe(NEW) // FAILS: it is OLD again, so the bridge answers schedule_conflict
  })
})

describe('B2 (UI): a slow Mac is not an error while its card still arrives', () => {
  it('keeps watching under the patch id, then shows the late card', async () => {
    const { SlowPatch } = await import('../../src/lib/socketSchedules.ts')
    const client = createFakeClient()
    const snap = snapshots('02-list-three-jobs')[0]
    if (!snap) throw new Error('capture missing')
    client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, snapshot: snap, status: 'ready' } }))
    const ref = '01JAAAAAAAAAAAAAAAAAAAAAA9'
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockRejectedValue(new SlowPatch(ref))
    const id = snap.schedules[0]?.id as string
    render(
      <ClientProvider client={client}>
        <ProposalSheet
          title="Delete"
          threadId="general"
          change={{ op: 'delete', id, base_etag: snap.schedules[0]?.etag as string }}
          onClose={() => {}}
        />
      </ClientProvider>,
    )
    expect(await screen.findByText(/slow to answer/i)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    const captured = cards('06-patch-delete')[0] as CardT
    act(() => {
      client.store.setState((s) => ({
        ...s,
        cards: [...s.cards, { ...captured, payload: { ...(captured.payload as object), client_ref: ref } }],
      }))
    })
    expect(await screen.findByText(captured.title)).toBeTruthy()
  })
})
