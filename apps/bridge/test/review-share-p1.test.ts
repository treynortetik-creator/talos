// Adversarial review of PR #52 (Share P1), bridge part: the agentOrigin() change in schedules/service.ts (real bridge in
// process + FakeRelay + FakeApp, the schedules harness) and the Shortcut label builder.
// Tests under "FAILS on PR #52" are defects; the rest held on the PR head (11e543e).
import { afterEach, describe, expect, test } from 'bun:test'
import { type CardT, newId, newUlid } from '@talos-app/protocol'
import { exportLabel, LABEL_MAX } from '../src/share/shortcut.ts'
import { longTimeouts, type SchedHarness, startSched } from './schedules/harness.ts'

longTimeouts()

let h: SchedHarness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const shareItem = (createdAt: string) => ({
  type: 'share.item',
  share_id: newUlid(),
  token_id: `sh_${newUlid()}`,
  token_label: 'iPhone',
  message: {
    id: newId('m'),
    thread_id: 'inbox',
    author: 'owner',
    kind: 'text',
    text: 'save this',
    format: 'plain',
    attachments: [],
    via: 'share',
    created_at: createdAt,
    share_content: { url: 'https://example.com/a', title: 'A page', text: 'shared body' },
  },
})

async function inboxProposalOrigin(s: SchedHarness, n: number): Promise<CardT['origin']> {
  const res = await s.bridge.callTool('schedule_propose', {
    op: 'create',
    thread_id: 'inbox',
    reason: 'The owner asked.',
    name: `Quiet ${n}`,
    id: `quiet-${n}`,
    when: { type: 'weekdays', time: '22:00' },
    prompt: 'Do the thing.\n',
  })
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26}) pending/.exec(res.content[0]?.text ?? '')?.[1]
  const cc = await s.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
  return (cc.card as CardT).origin
}

describe('held: agentOrigin still sees the owner when shares arrive after them', () => {
  test('owner speaks in Inbox, then one token share lands: the proposal is still a chat card', async () => {
    h = await startSched()
    await h.app.sendMessage('inbox', 'remind me about these every weeknight')
    await h.waitNotes(1)
    h.relay.sendToBridge(shareItem(new Date(h.clock.now()).toISOString()), { durable: true })
    await h.waitNotes(2)
    expect(await inboxProposalOrigin(h, 1)).toBe('chat')
  })
})

describe('FAILS on PR #52 (low): shares now hide the owner from agentOrigin', () => {
  // agentOrigin() still reads only the newest 20 rows, and now SKIPS share rows inside them. Before the PR a share
  // counted as the owner (B2); now 20 shares after a real owner message push it out of the window, so a proposal that
  // answers the owner a minute later is minted 'background' (30 min) instead of 'chat' (24 h). Anyone holding a share
  // token can do this on purpose. Fix: look for the newest owner row with via != 'share' (a store query, or page until
  // older than OWNER_SPOKE_MS), not "any of the last 20".
  test('owner speaks in Inbox, then 20 token shares land inside the 30 min window: still a chat card', async () => {
    h = await startSched()
    await h.app.sendMessage('inbox', 'remind me about these every weeknight')
    await h.waitNotes(1)
    for (let i = 0; i < 20; i++)
      h.relay.sendToBridge(shareItem(new Date(h.clock.now() + i).toISOString()), { durable: true })
    await h.waitNotes(21)
    expect(await inboxProposalOrigin(h, 2)).toBe('chat')
  })
})

describe('FAILS on PR #52 (low): exportLabel cuts inside a character', () => {
  // `clean.slice(0, room)` counts UTF-16 units, so a label with emoji can be cut between the two halves of a surrogate
  // pair. The lone half goes to the relay as `\ud83d`, passes zod (length only), and lands in the token row and in
  // Settings as a broken character. Fix: cut by code points (Array.from(clean).slice(...)) and re-check the length.
  test('a label of emoji is never cut into a lone surrogate', () => {
    const label = exportLabel(`a${'📱'.repeat(20)}`, '2026-10-29')
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX)
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})
