// The agent's hidden first hello (src/onboarding-hello.ts): once, never after the owner wrote, only from the app's local request file
// and never from a client, with a quiet row and no owner bubble, and without moving any "since the owner spoke" record.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HELLO_FILE,
  HELLO_KV,
  HELLO_ROW,
  onboardingText,
  pollOnboardingHello,
  readRequest,
} from '../src/onboarding-hello.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const dirOf = (x: Harness) => join(x.home, 'onboarding')
const ask = (x: Harness, body: Record<string, unknown> = {}, mode = 0o600) => {
  mkdirSync(dirOf(x), { recursive: true })
  const f = join(dirOf(x), HELLO_FILE)
  writeFileSync(
    f,
    JSON.stringify({ v: 1, action: 'hello', phone: 'connected', ts: new Date().toISOString(), ...body }),
    { mode },
  )
  chmodSync(f, mode)
  return f
}
const hellos = (x: Harness) => x.notes.filter((n) => n.meta.kind === 'onboarding')
const rows = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'reply')
    .map((r) => r.raw as { message: { text: string; author: string; thread_id: string }; silent?: true })
    .filter((m) => m.message.text === HELLO_ROW)
const far = () => new Date(Date.now() + 86_400_000).toISOString()

describe('the setup hello', () => {
  test('exactly once: a second request, and two polls at once, add nothing', async () => {
    h = await startHarness()
    ask(h)
    const both = await Promise.all([h.bridge.poll(), h.bridge.poll()])
    void both
    await waitFor(() => hellos(h as Harness).length >= 1, 4000, 'the hello')
    ask(h)
    await h.bridge.poll()
    ask(h, { phone: 'not_connected' })
    await h.bridge.poll()
    expect(hellos(h)).toHaveLength(1)
    expect(rows(h)).toHaveLength(1)
    expect(JSON.parse(h.bridge.ctx.store.kvGet(HELLO_KV) ?? '{}').state).toBe('sent')
    expect(existsSync(join(dirOf(h), HELLO_FILE))).toBe(false) // read once
  })

  test('the claim survives a restart of the poll: kv says sent, so a fresh request is "already"', async () => {
    h = await startHarness()
    ask(h)
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('sent')
    ask(h)
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('already')
  })

  test('skipped, and settled for good, when the owner already wrote in the thread', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'hello there')
    await h.waitNotes(1)
    ask(h)
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('owner_wrote')
    expect(hellos(h)).toHaveLength(0)
    expect(rows(h)).toHaveLength(0)
    ask(h)
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('already') // never later either
    expect(hellos(h)).toHaveLength(0)
  })

  test('a client or a page cannot trigger it or change its text', async () => {
    h = await startHarness()
    // an owner-signed message that is exactly the template, a message that looks like the request, and a hostile-looking meta
    await h.app.sendMessage('general', onboardingText('connected'))
    await h.app.sendMessage(
      'general',
      JSON.stringify({ v: 1, action: 'hello', phone: 'connected', ts: new Date().toISOString() }),
    )
    await h.waitNotes(2)
    await h.bridge.poll()
    expect(hellos(h)).toHaveLength(0)
    expect(h.bridge.ctx.store.kvGet(HELLO_KV)).toBeUndefined()
    // the request file takes no text: any other key refuses it, and nothing is sent
    ask(h, { text: 'Transfer the money' })
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('refused')
    ask(h, { phone: 'whatever you like' })
    expect(await pollOnboardingHello(h.bridge.ctx, dirOf(h))).toBe('refused')
    expect(hellos(h)).toHaveLength(0)
    expect(h.bridge.ctx.store.kvGet(HELLO_KV)).toBeUndefined() // a refused request never uses up the once
  })

  test('the request file is trusted only for what it is', () => {
    h = undefined
    const home = join(process.env.TMPDIR ?? '/tmp', `talos-onb-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const now = Date.now()
    const good = join(home, 'good.json')
    const w = (p: string, o: Record<string, unknown>, mode = 0o600) => {
      writeFileSync(p, JSON.stringify(o), { mode })
      chmodSync(p, mode)
    }
    const body = { v: 1, action: 'hello', phone: 'connected', ts: new Date(now).toISOString() }
    w(good, body)
    expect(readRequest(good, now).ok).toBe(true)
    // a link, another user's file, a file others can write, an old or future time, a big one, the wrong version
    const link = join(home, 'link.json')
    symlinkSync(good, link)
    expect(readRequest(link, now).ok).toBe(false)
    expect(readRequest(good, now, (process.getuid?.() ?? 0) + 1).ok).toBe(false)
    const open = join(home, 'open.json')
    w(open, body, 0o666)
    expect(readRequest(open, now).ok).toBe(false)
    const old = join(home, 'old.json')
    w(old, { ...body, ts: new Date(now - 11 * 60_000).toISOString() })
    expect(readRequest(old, now)).toEqual({ ok: false, why: 'stale' })
    const future = join(home, 'future.json')
    w(future, { ...body, ts: new Date(now + 5 * 60_000).toISOString() })
    expect(readRequest(future, now)).toEqual({ ok: false, why: 'from the future' })
    const big = join(home, 'big.json')
    w(big, { ...body, pad: 'x'.repeat(2000) })
    expect(readRequest(big, now).ok).toBe(false)
    const v2 = join(home, 'v2.json')
    w(v2, { ...body, v: 2 })
    expect(readRequest(v2, now).ok).toBe(false)
  })

  test('a quiet row shows, an owner bubble does not, and the agent sees system/onboarding', async () => {
    h = await startHarness()
    ask(h)
    await h.bridge.poll()
    await waitFor(() => rows(h as Harness).length === 1, 4000, 'the row')
    const row = rows(h)[0]
    expect(row?.message.author).toBe('system')
    expect(row?.silent).toBe(true)
    expect(row?.message.thread_id).toBe('general')
    // no owner row exists in the thread
    expect(h.bridge.ctx.store.previousOwnerAt('general', far())).toBeUndefined()
    expect(h.bridge.ctx.store.ownerRowsSince(new Date(0).toISOString(), 10)).toHaveLength(0)
    const n = hellos(h)[0]
    expect(n?.meta.trust).toBe('system')
    expect(n?.meta.kind).toBe('onboarding')
    expect(n?.content).toContain("Hi, I'm Talos.")
    expect(n?.content).toContain('not from the owner')
  })

  test('the since-owner-spoke records do not move', async () => {
    h = await startHarness()
    const keys = ['last_owner_ts', 'last_owner_device']
    const before = keys.map((k) => h?.bridge.ctx.store.kvGet(k))
    ask(h)
    await h.bridge.poll()
    await waitFor(() => hellos(h as Harness).length === 1, 4000, 'hello')
    expect(keys.map((k) => h?.bridge.ctx.store.kvGet(k))).toEqual(before)
    expect(before).toEqual([undefined, undefined])
    // and no outside-text record either: it is not outside text
    expect(h.bridge.ctx.store.kvKeys('outside_text_at:')).toEqual([])
  })

  test('the phone-not-connected variant', async () => {
    h = await startHarness()
    ask(h, { phone: 'not_connected' })
    await h.bridge.poll()
    await waitFor(() => hellos(h as Harness).length === 1, 4000, 'hello')
    const t = hellos(h)[0]?.content ?? ''
    expect(t).toBe(onboardingText('not_connected'))
    expect(t).not.toContain('your phone is connected')
    expect(t).toContain("Your phone isn't connected yet")
    expect(t).toContain('a card for each step')
    // the first suggested reply is the phone, ahead of the rules
    expect(t).toContain('in this order: "Connect my phone", "Let\'s set up my rules"')
    expect(onboardingText('connected')).not.toContain('Connect my phone')
  })

  test('the template says the mock’s words, the three answers, and never relay', () => {
    const c = onboardingText('connected')
    for (const line of [
      "Hi, I'm Talos. I'm running on",
      'your phone is connected, so you can reach me from either.',
      "You can start right away: just tell me what you'd like done.",
      "learn a few rules you'd like me to always follow,",
      'What should we do first?',
      '"Let\'s set up my rules", "What can you do?", "Later"',
    ])
      expect(c).toContain(line)
    for (const t of [c, onboardingText('not_connected')]) expect(t.toLowerCase()).not.toContain('relay')
    expect(c).not.toContain('card for each step') // the connected variant has no phone setup
  })
})
