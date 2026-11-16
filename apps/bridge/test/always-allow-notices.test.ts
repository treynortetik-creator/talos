// An always-allowed pass is recorded in the thread but never buzzes the phone (owner 2026-11-15: "I got a lot of allowed deploy
// stuff"), and passes in one thread within ten minutes fold into one line with a count. The message store cannot edit a line, so
// the first pass posts its own line at once and the later ones in the window come as ONE summary line when the window ends.
import { afterEach, describe, expect, test } from 'bun:test'
import { CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { allowWithoutCard, PASS_RECORD_PREFIX } from '../src/always-allow.ts'
import { advanceSteps, type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const MIN = 60_000
const start = async (grants: string[]) => {
  const clock = fakeClock('2026-11-15T15:00:00.000Z')
  h = await startHarness({
    clock,
    relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
    config: (c) => ({ ...c, always_allow: grants.map((kind) => ({ kind, destination: null })) }) as typeof c,
  })
  return { x: h, clock }
}
const lines = (x: Harness, thread = 'general') =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'reply')
    .map((r) => r.raw as { message: { text: string; thread_id: string }; silent?: true; sent_always_allowed?: true })
    .filter((m) => m.message.thread_id === thread)
// The shared path of the agent's card call and the action-rule asks (a rule's push card is bridge-minted, so it cannot come
// through the agent's card tool): both end in allowWithoutCard.
const pass = (x: Harness, n: number, kind = 'push', thread = 'general') =>
  allowWithoutCard(x.bridge.ctx, { kind: kind as never, title: `${kind} ${n}`, thread_id: thread })

describe('always-allowed passes are silent and fold', () => {
  test('3 passes in 5 minutes: every line silent, the first at once, the other two as ONE counted line; a later pass starts a new window', async () => {
    const { x, clock } = await start(['push', 'deploy'])
    await pass(x, 1)
    await waitFor(() => lines(x).length === 1, 4000, 'first line')
    await advanceSteps(clock, 2 * MIN, 20_000, x.bridge.client)
    await pass(x, 2)
    await advanceSteps(clock, 3 * MIN, 20_000, x.bridge.client)
    await pass(x, 3, 'deploy')
    expect(lines(x)).toHaveLength(1) // held, not posted one by one
    // the window ends 10 min after the first line: one summary of what was held
    await advanceSteps(clock, 5 * MIN + 1000, 20_000, x.bridge.client)
    await waitFor(() => lines(x).length === 2, 4000, 'the summary line')
    expect(lines(x)[1]?.message.text).toContain('1 deploy and 1 push')
    // 11 minutes after the first pass: a fresh line, not folded into the old window
    await advanceSteps(clock, 2 * MIN, 20_000, x.bridge.client)
    await pass(x, 4)
    await waitFor(() => lines(x).length === 3, 4000, 'a new window')
    expect(lines(x)[2]?.message.text).toContain('push 4')
    // none of it may buzz: silent, and not the quiet-hours-proof flag either
    for (const l of lines(x)) {
      expect(l.silent).toBe(true)
      expect(l.sent_always_allowed).toBeUndefined()
    }
  })

  test('a window with one pass posts no summary; another thread has its own window', async () => {
    const { x, clock } = await start(['push'])
    await pass(x, 1)
    await waitFor(() => lines(x).length === 1, 4000, 'line')
    await advanceSteps(clock, 11 * MIN, 20_000, x.bridge.client)
    expect(lines(x)).toHaveLength(1)
    await pass(x, 2, 'push', 'general')
    await waitFor(() => lines(x).length === 2, 4000, 'second window')
    await pass(x, 3, 'push', 'general')
    expect(lines(x)).toHaveLength(2)
  })

  test('every pass is still recorded one by one in the bridge log', async () => {
    const logged: string[] = []
    const { x } = await start(['push'])
    const orig = x.bridge.ctx.log.info.bind(x.bridge.ctx.log)
    x.bridge.ctx.log.info = ((m: string, f?: Record<string, unknown>) => {
      if (m === 'card skipped: always allowed') logged.push(String(f?.kind))
      orig(m, f as never)
    }) as typeof x.bridge.ctx.log.info
    await pass(x, 1)
    await pass(x, 2)
    await pass(x, 3)
    expect(logged).toEqual(['push', 'push', 'push'])
  })

  test('a kind that is not granted is still a card, and posts no pass line', async () => {
    const { x } = await start(['deploy'])
    const r = await x.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'publish',
      title: 'Post it',
      destination: [{ label: 'Site', value: 'example.com' }],
      body: 'b',
      primary_label: 'Publish',
      kill_label: 'Deny',
      risk: 'high',
      origin: 'chat',
    })
    expect(r.content[0]?.text).toMatch(/card c_\S+ pending/)
    expect(lines(x)).toHaveLength(0)
  })

  test('the second pass in a window is recorded durably with its command, and the counted line names it (restart keeps the record)', async () => {
    const { x, clock } = await start(['push'])
    await allowWithoutCard(x.bridge.ctx, {
      kind: 'push',
      title: 'push-to-main: git push origin main',
      thread_id: 'general',
      rule: 'push-to-main',
    })
    await allowWithoutCard(x.bridge.ctx, {
      kind: 'push',
      title: `push-to-main: git push origin release-${'ab '.repeat(40)}`,
      thread_id: 'general',
      rule: 'push-to-main',
    })
    const recs = x.bridge.ctx.store
      .kvKeys(PASS_RECORD_PREFIX)
      .map((k) => JSON.parse(x.bridge.ctx.store.kvGet(k) as string))
    expect(recs).toHaveLength(2)
    expect(recs[1]).toMatchObject({ kind: 'push', thread: 'general', rule: 'push-to-main' })
    expect(recs[1].what).toContain('release-')
    expect(recs[1].at).toBe(new Date(clock.now()).toISOString())
    // restart before the window ends: a reopened store still has both
    const path = (x.bridge.ctx.store as unknown as { db: { filename: string } }).db.filename
    const { Database } = await import('bun:sqlite')
    const again = new Database(path, { readonly: true })
    const n = (
      again.query('SELECT COUNT(*) AS n FROM kv WHERE key LIKE ?').get(`${PASS_RECORD_PREFIX}%`) as { n: number }
    ).n
    again.close()
    expect(n).toBe(2)
    await advanceSteps(clock, 10 * MIN + 1000, 20_000, x.bridge.client)
    await waitFor(() => lines(x).length === 2, 4000, 'summary')
    const text = lines(x)[1]?.message.text ?? ''
    expect(text).toContain('1 push')
    expect(text).toContain('release-')
    expect(text).not.toContain('x'.repeat(100)) // each command cut to about 80 characters
  })

  test('the counted line lists at most 5 commands, then "and N more"', async () => {
    const { x, clock } = await start(['push'])
    for (let i = 0; i < 8; i++) await pass(x, i)
    await advanceSteps(clock, 10 * MIN + 1000, 20_000, x.bridge.client)
    await waitFor(() => lines(x).length === 2, 4000, 'summary')
    const text = lines(x)[1]?.message.text ?? ''
    expect(text).toContain('7 pushes')
    expect(text).toContain('push 1')
    expect(text).toContain('push 5')
    expect(text).not.toContain('push 6')
    expect(text).toContain('and 2 more')
  })
})

describe('a credential in a passed command is never kept', () => {
  test('curl -u user:pass and ?api_key= are gone from the stored record, the log, the first line and the folded line', async () => {
    const { x, clock } = await start(['push'])
    const logged: string[] = []
    const warn = x.bridge.ctx.log.warn.bind(x.bridge.ctx.log)
    x.bridge.ctx.log.warn = ((m: string, f?: Record<string, unknown>) => {
      logged.push(JSON.stringify([m, f]))
      return warn(m, f)
    }) as typeof warn
    const cmd = 'curl -u alex:hunter2 "https://api.example.com/x?api_key=abc123zz&n=1"'
    await allowWithoutCard(x.bridge.ctx, { kind: 'push', title: cmd, thread_id: 'general' })
    await allowWithoutCard(x.bridge.ctx, { kind: 'push', title: cmd, thread_id: 'general' })
    await advanceSteps(clock, 10 * MIN + 1000, 20_000, x.bridge.client)
    await waitFor(() => lines(x).length === 2, 4000, 'both lines')
    const everything = [
      ...x.bridge.ctx.store.kvKeys(PASS_RECORD_PREFIX).map((k) => x.bridge.ctx.store.kvGet(k) as string),
      ...logged,
      ...lines(x).map((l) => l.message.text),
    ].join('\n')
    expect(everything).not.toContain('hunter2')
    expect(everything).not.toContain('abc123zz')
    expect(everything).toContain('alex:[redacted]')
    expect(everything).toContain('api_key=[redacted]&n=1')
    expect(logged.some((l) => l.includes('always-allow pass'))).toBe(true)
  })
})
