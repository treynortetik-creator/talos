// The Run button, enforced by the Mac. A tap is a signed `message` with `intent: 'run'`; the bridge reads the thread (one with
// its own session refuses), the shape, the age (from the owner's first signing time, on this Mac's clock), the history reset
// and once-only, and only then sets `run="tap"` on the note. The agent trusts that flag and nothing the text says. The Mac
// does not check where the script came from. Real inbound, real signed frames, a real history file, real workers.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelMeta, CROCKFORD, newId, RUN_FEATURE, RUN_MAX_AGE_MS, RUN_PREFIX, runText } from '@talos-app/protocol'
import { FakeApp, type FakeClock, fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { bridgeFeatures } from '../src/handshake.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
let b2: Bridge | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
  await b2?.stop()
  b2 = undefined
  await h?.stop()
  h = undefined
})

const HOUR = 3600_000
const SCRIPT = 'echo hello\nls -la\n'
const hh = () => h as Harness

/** The block a tap is for: a message of the agent and a place in it. A fresh message each time unless a test says which. */
const blockRef = (index = 0, message_id: string = newId('m')) => ({ message_id, index })

/** A signed Run frame, built but not sent. By default it is for a block of its own. */
const runFrame = (x: Harness, script = SCRIPT, extra: Record<string, unknown> = {}, thread = 'general') =>
  x.app.buildMessage(thread, runText(script, 'sh') as string, { intent: 'run', run_block: blockRef(), ...extra })
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/**
 * Everything sent before this has been handled when it returns: frames are taken in order, so a note for a plain message sent
 * last means the ones before it are done. (A test that says "nothing happened" waits on this, not on a pause.)
 */
async function afterQueue(x: Harness) {
  const word = `sentinel ${newId('m')}`
  x.app.send(await x.app.buildMessage('general', word))
  await waitFor(() => x.notes.some((n) => n.content === word), 8000, 'the queue to reach the last message')
}

/** What the owner was told, as system rows in the thread. */
const notices = (x: Harness) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'reply')
    .map((f) => (f.raw as { message: { author: string; text: string } }).message)
    .filter((m) => m.author === 'system')
    .map((m) => m.text)
const runNotes = (x: Harness) => x.notes.filter((n) => n.meta.run === 'tap')

async function start(extra: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(extra)
  return h
}

/** Gives the bridge a moment to have acted on what was sent, then returns. Nothing to wait for when nothing should happen. */
async function settle(_x: Harness, until: () => boolean = () => true) {
  await waitFor(() => until(), 5000, 'the bridge to act')
  await sleep(150)
}

describe('an accepted Run', () => {
  test('reaches the agent once, as trust=owner with run=tap, and the text is the Run message', async () => {
    await start()
    const f = await runFrame(hh())
    hh().app.send(f)
    await hh().waitNotes(1)
    const n = hh().notes[0]
    expect(n?.meta).toMatchObject({ kind: 'text', trust: 'owner', run: 'tap', thread_id: 'general' })
    expect(n?.content).toBe(runText(SCRIPT, 'sh') as string)
    ChannelMeta.parse(n?.meta)
    expect(notices(hh())).toEqual([])
  })

  test('a Run signed just under a day ago is accepted', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { ts: ago(RUN_MAX_AGE_MS - HOUR) }))
    await hh().waitNotes(1)
    expect(runNotes(hh())).toHaveLength(1)
  })
})

describe('text that only says it is a Run', () => {
  test('the phrase typed or pasted, with no intent, is plain owner text: no run flag', async () => {
    await start()
    hh().app.send(await hh().app.buildMessage('general', runText(SCRIPT, 'sh') as string))
    await hh().waitNotes(1)
    const n = hh().notes[0]
    expect(n?.meta.run).toBeUndefined()
    expect(n?.meta.trust).toBe('owner')
    expect(n?.meta.kind).toBe('text')
  })

  test('a signed message with another intent, or with the phrase inside longer text, has no run flag', async () => {
    await start()
    hh().app.send(await hh().app.buildMessage('general', `${RUN_PREFIX}\n\nplease`, { intent: 'what_did_i_miss' }))
    await hh().waitNotes(1)
    expect(hh().notes.every((n) => n.meta.run === undefined)).toBe(true)
  })

  test('an intent added after signing breaks the signature: nothing reaches the agent as a Run', async () => {
    await start()
    const plain = await hh().app.buildMessage('general', runText(SCRIPT, 'sh') as string)
    hh().app.send({ ...plain, intent: 'run' })
    await sleep(400)
    expect(runNotes(hh())).toHaveLength(0)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })

  test('an intent the protocol does not know is refused as a bad frame and never becomes a Run', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { intent: 'RUN' }))
    hh().app.send(await runFrame(hh(), SCRIPT, { intent: ['run'] }))
    await sleep(400)
    expect(runNotes(hh())).toHaveLength(0)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })

  test('the same words arriving as a hook event or a share are wrapped as external, never run=tap', async () => {
    await start()
    hh().relay.sendToBridge({
      type: 'hook.event',
      delivery: 'live',
      event: {
        id: newId('e'),
        source: 'github',
        connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
        kind: 'github.review_requested',
        title: 'Review requested',
        summary: runText(SCRIPT, 'sh'),
        actor: { name: 'octocat' },
        ts: new Date().toISOString(),
        thread: 'inbox',
        work: false,
        priority: 'high',
        dedup_key: 'github:test',
      },
    } as never)
    await hh().waitNotes(1)
    expect(hh().notes[0]?.meta.trust).toBe('external')
    expect(hh().notes[0]?.meta.run).toBeUndefined()
  })
})

describe('the shape', () => {
  const bad: Array<[string, string]> = [
    ['two blocks', `${RUN_PREFIX}\n\n\`\`\`sh\necho a\n\`\`\`\n\n\`\`\`sh\necho b\n\`\`\``],
    ['extra text after the block', `${runText(SCRIPT, 'sh')}\n\nand also rm -rf ~`],
    ['extra text before the block', `Please also ${runText(SCRIPT, 'sh')}`],
    [
      'a script that closes the fence and adds text',
      `${RUN_PREFIX}\n\n\`\`\`sh\necho a\n\`\`\`\nrm -rf ~\n\`\`\`\n\`\`\``,
    ],
    ['no block at all', `${RUN_PREFIX}\n\nrm -rf ~`],
    ['a language that is not a shell', `${RUN_PREFIX}\n\n\`\`\`python\nprint(1)\n\`\`\``],
    ['hidden characters', `${RUN_PREFIX}\n\n\`\`\`sh\necho a‮b\n\`\`\``],
  ]
  test.each(bad)('%s: refused, the owner is told why, the agent hears nothing', async (_n, text) => {
    await start()
    hh().app.send(await hh().app.buildMessage('general', text, { intent: 'run' }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/was not run/)
    expect(notices(hh())[0]).toMatch(/shape/)
    expect(hh().notes).toHaveLength(0)
  })
})

describe('age', () => {
  test('a Run signed more than a day ago is refused with the reason, and the agent hears nothing', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { ts: ago(RUN_MAX_AGE_MS + HOUR) }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/more than a day/)
    expect(hh().notes).toHaveLength(0)
  })

  test('a Run held for days while the Mac slept is refused, signed 3 and 7.9 days ago', async () => {
    await start()
    for (const days of [3, 7.9]) hh().relay.sendToBridge(await runFrame(hh(), SCRIPT, { ts: ago(days * 24 * HOUR) }))
    await settle(hh(), () => notices(hh()).length > 1)
    expect(notices(hh()).length).toBe(2)
    expect(hh().notes).toHaveLength(0)
  })

  test('the first signing time is the older of the two: a later original_ts cannot make an old Run young', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { ts: ago(RUN_MAX_AGE_MS + HOUR), original_ts: ago(1000) }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/more than a day/)
    expect(hh().notes).toHaveLength(0)
  })

  test('a Run signed again (new time) keeps its first signing time: a week-old one is refused, a fresh one is not', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { original_ts: ago(3 * 24 * HOUR) }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/more than a day/)
    expect(hh().notes).toHaveLength(0)
    hh().app.send(await runFrame(hh(), SCRIPT, { original_ts: ago(2 * HOUR) }))
    await hh().waitNotes(1)
    expect(runNotes(hh())).toHaveLength(1)
    // a re-signed Run does not get the "older words" line in front of the text: its age was checked, and the text stays whole
    expect(hh().notes[0]?.content).toBe(runText(SCRIPT, 'sh') as string)
  })
})

describe('a tap carries nothing but the script', () => {
  const att = () => ({
    media_id: newId('md'),
    kind: 'file',
    role: 'attachment',
    mime: 'text/plain',
    name: 'a.txt',
    size: 3,
    sha256: 'a'.repeat(64),
  })
  const extras: Array<[string, Record<string, unknown>]> = [
    ['an attachment', { attachments: [att()] }],
    ['an attached memory note', { refs: [{ kind: 'memory', root_id: 'r_1', path: 'a.md', sha256: 'a'.repeat(64) }] }],
    ['shared material', { share_content: { text: 'x' } }],
    ['a reply', { reply_to: newId('m') }],
  ]
  test.each(extras)('%s: refused, the owner is told, the agent hears nothing', async (_n, extra) => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, extra))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/shape/)
    expect(hh().notes).toHaveLength(0)
  })
})

describe('the bridge says it can take a Run', () => {
  test('it lists run/1 in its hello, which is what makes the app show a Run button', async () => {
    await start()
    const hello = hh().relay.frames.find((f) => f.direction === 'from_bridge' && f.raw.type === 'hello')
    expect(hello).toBeDefined()
    expect((hello as unknown as { raw: { client: { features: string[] } } }).raw.client.features).toContain(RUN_FEATURE)
    expect(bridgeFeatures({})).toContain(RUN_FEATURE)
  })
})

describe('one block, one Run: kept by the Mac, keyed on the block', () => {
  const noted = (x: Harness) => runNotes(x).length

  test('a Run without the block it is for is refused, and the agent hears nothing', async () => {
    await start()
    hh().app.send(await hh().app.buildMessage('general', runText(SCRIPT, 'sh') as string, { intent: 'run' }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())[0]).toMatch(/does not say which block/)
    expect(noted(hh())).toBe(0)
  })

  test('the block named in the frame is signed: changing it after signing breaks the signature', async () => {
    await start()
    const ref = blockRef(0)
    const f = await runFrame(hh(), SCRIPT, { run_block: ref })
    hh().app.send({ ...f, run_block: { ...ref, index: 1 } })
    await afterQueue(hh())
    expect(noted(hh())).toBe(0)
    expect(hh().bridge.ctx.store.hasSeen(`run:${ref.message_id}:1`)).toBe(false)
  })

  test('a block that is not a block (a negative or fractional place, an odd id) is refused as a bad frame', async () => {
    await start()
    for (const bad of [
      { message_id: newId('m'), index: -1 },
      { message_id: newId('m'), index: 1.5 },
      { message_id: 'x', index: 0 },
    ])
      hh().app.send(await runFrame(hh(), SCRIPT, { run_block: bad }))
    await afterQueue(hh())
    expect(noted(hh())).toBe(0)
  })

  test('the Run marks its block in the seen store before the agent hears of it', async () => {
    await start()
    const ref = blockRef(2)
    const key = `run:${ref.message_id}:2`
    const seenAtEmit: boolean[] = []
    hh().bridge.setEmit(async (n) => {
      seenAtEmit.push(hh().bridge.ctx.store.hasSeen(key))
      hh().notes.push(n)
    })
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await hh().waitNotes(1)
    expect(seenAtEmit).toEqual([true])
  })

  test('two identical posts are two blocks: each runs once, and a second tap on either is refused', async () => {
    await start()
    const a1 = blockRef(0)
    const a2 = blockRef(0)
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: a1 }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: a1 }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: a2 }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: a2 }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: a1 }))
    await afterQueue(hh())
    expect(noted(hh())).toBe(2)
    expect(notices(hh())).toHaveLength(3)
    for (const n of notices(hh())) expect(n).toMatch(/already tried/)
  })

  test('two blocks in one message are two Runs; tapping the first again is refused', async () => {
    await start()
    const id = newId('m')
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: blockRef(0, id) }))
    hh().app.send(await runFrame(hh(), 'echo second\n', { run_block: blockRef(1, id) }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: blockRef(0, id) }))
    await afterQueue(hh())
    expect(noted(hh())).toBe(2)
    expect(notices(hh())).toHaveLength(1)
  })

  test('two devices tapping the same block are one Run', async () => {
    await start()
    const second = new FakeApp({ relayWs: hh().relay.wsBase })
    await second.connect()
    expect(
      hh().bridge.ctx.devices.pin(
        { id: second.device.deviceId, name: 'Second', pubkey_jwk: second.device.publicJwk },
        new Date().toISOString(),
      ).ok,
    ).toBe(true)
    const ref = blockRef()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    hh().relay.sendToBridge(
      (await second.buildMessage('general', runText(SCRIPT, 'sh') as string, {
        intent: 'run',
        run_block: ref,
      })) as never,
    )
    await afterQueue(hh())
    expect(noted(hh())).toBe(1)
    expect(notices(hh())[0]).toMatch(/already tried/)
    await second.close()
  })

  test('a second tap is refused whatever the app shows: a deleted "may have run" row, a search context view, a reload', async () => {
    await start()
    const ref = blockRef()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await hh().waitNotes(1)
    // the app deleted its row, or opened the message in a context view, or reloaded: it sends the same block again, as a new message
    for (let i = 0; i < 3; i++) hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await afterQueue(hh())
    expect(noted(hh())).toBe(1)
    expect(notices(hh())).toHaveLength(3)
    expect(notices(hh())[0]).toBe(
      'That Run was not run: that block was already tried. Ask your agent to post the script again to run it again.',
    )
  })

  test('a Run that was refused does not use up its block', async () => {
    await start()
    const ref = blockRef()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref, ts: ago(RUN_MAX_AGE_MS + HOUR) })) // too old
    await settle(hh(), () => notices(hh()).length > 0)
    expect(hh().bridge.ctx.store.hasSeen(`run:${ref.message_id}:0`)).toBe(false)
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await hh().waitNotes(1)
    expect(noted(hh())).toBe(1)
  })
})

/** A message id made at a given time: the ULID's first ten characters are the time in milliseconds (Crockford base32). */
function idAt(ms: number, rest = 'ABCDEFGHJKMNPQRS'): string {
  let t = ''
  let n = ms
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[n % 32] + t
    n = Math.floor(n / 32)
  }
  return `m_${t}${rest}`
}
const WEEK = 7 * 24 * HOUR
const OLD_LINE = 'That script is over a week old. Ask me to post it again.'

describe('the age of the block', () => {
  test('a block made 7 days minus a minute ago runs', async () => {
    await start()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: blockRef(0, idAt(Date.now() - WEEK + 60_000)) }))
    await hh().waitNotes(1)
    expect(runNotes(hh())).toHaveLength(1)
    expect(notices(hh())).toEqual([])
  })

  test('a block made 7 days plus a minute ago is refused with the plain line, and its mark is not set', async () => {
    await start()
    const ref = blockRef(0, idAt(Date.now() - WEEK - 60_000))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())).toEqual([OLD_LINE])
    expect(runNotes(hh())).toHaveLength(0)
    expect(hh().bridge.ctx.store.hasSeen(`run:${ref.message_id}:0`)).toBe(false) // a refused Run does not use up its block
  })

  test('a message id whose time will not parse is refused the same way', async () => {
    await start()
    // 26 characters that pass the id pattern, but start above 7: more than 48 bits of time
    const bad = `m_8${'Z'.repeat(25)}`
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: { message_id: bad, index: 0 } }))
    await settle(hh(), () => notices(hh()).length > 0)
    expect(notices(hh())).toEqual([OLD_LINE])
    expect(runNotes(hh())).toHaveLength(0)
    expect(hh().bridge.ctx.store.hasSeen(`run:${bad}:0`)).toBe(false)
  })
})

describe('what is kept of a Run', () => {
  test('an accepted Run and a refused one are both in the history, so a reloaded app sees the owner row', async () => {
    await start()
    const ok = await runFrame(hh())
    hh().app.send(ok)
    await hh().waitNotes(1)
    const bad = await hh().app.buildMessage('general', `${RUN_PREFIX}\n\nnothing`, { intent: 'run' })
    hh().app.send(bad)
    await settle(hh(), () => notices(hh()).length > 0)
    for (const f of [ok, bad]) {
      const row = hh().bridge.ctx.store.getMessage(f.client_msg_id as string)
      expect(row?.author).toBe('owner')
      expect(row?.text).toBe(f.text as string)
    }
    expect(
      hh()
        .bridge.ctx.store.page({ thread_id: 'general', limit: 50 })
        .messages.filter((m) => m.author === 'owner').length,
    ).toBe(2)
  })

  test('a refused Run is remembered by its message id: the same Run signed again is not refused a second time', async () => {
    await start()
    const old = ago(RUN_MAX_AGE_MS + HOUR)
    const first = await runFrame(hh(), SCRIPT, { ts: old })
    hh().app.send(first)
    await settle(hh(), () => notices(hh()).length > 0)
    expect(hh().bridge.ctx.store.hasSeen(first.client_msg_id as string)).toBe(true)
    hh().relay.sendToBridge((await runFrame(hh(), SCRIPT, { ts: old, client_msg_id: first.client_msg_id })) as never)
    await afterQueue(hh())
    expect(notices(hh())).toHaveLength(1)
    expect(runNotes(hh())).toHaveLength(0)
  })
})

describe('once only', () => {
  test('the note is sent after the Run is marked seen, never before', async () => {
    await start()
    const f = await runFrame(hh())
    const seenAtEmit: boolean[] = []
    hh().bridge.setEmit(async (n) => {
      seenAtEmit.push(
        hh().bridge.ctx.store.hasSeen(f.client_msg_id as string) && hh().bridge.ctx.store.hasSeen(f.id as string),
      )
      hh().notes.push(n)
    })
    hh().app.send(f)
    await hh().waitNotes(1)
    expect(seenAtEmit).toEqual([true])
  })

  test('a hand-over that fails (a crash after the mark) loses the Run: the replay does not run it', async () => {
    await start()
    const f = await runFrame(hh())
    let boom = true
    hh().bridge.setEmit(async (n) => {
      if (boom) throw new Error('the agent link broke')
      hh().notes.push(n)
    })
    hh().app.send(f)
    await waitFor(() => hh().bridge.ctx.store.hasSeen(f.client_msg_id as string), 5000, 'the mark')
    boom = false
    hh().relay.sendToBridge(f as never) // the relay never saw it consumed, so it sends it again
    hh().relay.sendToBridge((await runFrame(hh(), SCRIPT, { client_msg_id: f.client_msg_id })) as never) // and signed again, same message
    await sleep(400)
    expect(hh().notes).toHaveLength(0)
  })

  test('a replayed Run, and the same Run under a new frame id, reach the agent once', async () => {
    await start()
    const f = await runFrame(hh())
    hh().app.send(f)
    await hh().waitNotes(1)
    hh().relay.sendToBridge(f as never)
    hh().relay.sendToBridge({ ...(await runFrame(hh())), client_msg_id: f.client_msg_id } as never)
    await sleep(400)
    expect(runNotes(hh())).toHaveLength(1)
  })

  test('two taps on one block are one Run: the second is refused, and the agent hears it once', async () => {
    await start()
    const ref = blockRef()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await settle(hh(), () => notices(hh()).length > 0)
    await afterQueue(hh())
    expect(runNotes(hh())).toHaveLength(1)
    expect(notices(hh())).toHaveLength(1)
  })
})

describe('a backlog', () => {
  const settleReplay = async (clock: FakeClock, ids: string[]) => {
    for (const id of ids)
      await hh().relay.expectFrame('ack', (a) => a.ref === id && a.stage === 'delivered', { direction: 'from_bridge' })
    clock.advance(1000)
    await hh().bridge.inbound?.idle()
  }

  test('a Run in a replayed batch of old messages is never folded into the backlog note; it is judged on its own', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ startBridge: false, clock })
    const old = new Date(clock.now() - 20 * 60_000).toISOString()
    const q = async (frame: Record<string, unknown>, seq: number) =>
      hh().relay.sendToBridge({ ...frame, relay: { seq, received_at: old } } as never)
    const frames = [
      await q(await hh().app.buildMessage('general', 'first owner message'), 1),
      await q(await runFrame(hh()), 2),
      await q(await hh().app.buildMessage('general', 'second owner message'), 3),
    ]
    hh().bridge.start()
    await settleReplay(
      clock,
      frames.map((f) => f.id as string),
    )
    await hh().waitNotes(2)
    const backlog = hh().notes.find((n) => n.meta.kind === 'backlog')
    expect(backlog?.meta.batch_count).toBe('2')
    expect(backlog?.content).not.toContain('echo hello')
    const run = runNotes(hh())
    expect(run).toHaveLength(1)
    expect(run[0]?.content).toBe(runText(SCRIPT, 'sh') as string)
    expect(run[0]?.meta.kind).toBe('text')
  })

  test('an old Run in that batch is refused by age, not delivered with a fresh time', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ startBridge: false, clock })
    const old = new Date(clock.now() - 20 * 60_000).toISOString()
    const q = async (frame: Record<string, unknown>, seq: number) =>
      hh().relay.sendToBridge({ ...frame, relay: { seq, received_at: old } } as never)
    const frames = [
      await q(await hh().app.buildMessage('general', 'first owner message'), 1),
      await q(await runFrame(hh(), SCRIPT, { ts: new Date(clock.now() - 2 * 24 * HOUR).toISOString() }), 2),
      await q(await hh().app.buildMessage('general', 'second owner message'), 3),
    ]
    hh().bridge.start()
    await settleReplay(
      clock,
      frames.map((f) => f.id as string),
    )
    await hh().waitNotes(1)
    expect(hh().notes.every((n) => n.meta.run === undefined)).toBe(true)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })
})

// ---- a history that was kept aside ---------------------------------------------------------------------------------------

const PAGE = 4096
function smashRoot(path: string, table: string) {
  const db = new Database(path)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const root = (db.query('SELECT rootpage AS r FROM sqlite_master WHERE name = ?').get(table) as { r: number }).r
  db.close()
  const fd = openSync(path, 'r+')
  writeSync(fd, Buffer.alloc(PAGE, 0xff), 0, PAGE, (root - 1) * PAGE)
  closeSync(fd)
}

async function restartWithResetHistory(x: Harness) {
  await x.bridge.stop()
  Bun.gc(true)
  smashRoot(join(x.home, 'history.sqlite'), 'messages')
  const clock = fakeClock(new Date().toISOString())
  const env = loadEnv({
    TALOS_APP_HOME: x.home,
    TALOS_APP_RELAY_URL: x.relay.httpUrl,
    TALOS_APP_BRIDGE: '1',
  })
  const b = await Bridge.create({ env, logger: nullLogger, clock, inbound: { settleMs: 20, maxSettleMs: 200 } })
  const notes: Array<{ content: string; meta: Record<string, string> }> = []
  b.setEmit(async (n) => void notes.push(n))
  b2 = b
  b.start()
  const t0 = Date.now()
  while (!b.client?.connected) {
    if (Date.now() - t0 > 20_000) throw new Error('the second bridge did not connect')
    clock.advance(50)
    await sleep(20)
  }
  return { b, clock, notes }
}

async function ticking(clock: FakeClock, cond: () => boolean, what: string) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > 20_000) throw new Error(`timed out waiting for ${what}`)
    clock.advance(50)
    await sleep(20)
  }
}

describe('a Run replayed after the history was kept aside', () => {
  test('the new history has forgotten it was handed over, so it is refused, not run again', async () => {
    await start()
    const f = await runFrame(hh())
    hh().app.send(f)
    await hh().waitNotes(1)
    const { b, clock, notes } = await restartWithResetHistory(hh())
    expect(b.ctx.store.kvGet('history_reset_at')).toBeDefined()
    const before = notices(hh()).length
    hh().relay.sendToBridge(f as never)
    // wait for the refusal itself: the restarted bridge's own startup notice can land in this window and is not it
    await ticking(
      clock,
      () =>
        notices(hh())
          .slice(before)
          .some((n) => /history was reset/.test(n)),
      'the refusal',
    )
    expect(notes.filter((n) => n.meta.run !== undefined || n.content.includes('echo hello'))).toHaveLength(0)
  })

  test('a Run signed after the reset but first written before it is refused too (its first signing time counts)', async () => {
    await start()
    const { b, clock, notes } = await restartWithResetHistory(hh())
    expect(b.ctx.store.kvGet('history_reset_at')).toBeDefined()
    const app = hh().app as unknown as { sign: (f: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const realSign = app.sign.bind(hh().app)
    app.sign = (f) => realSign({ ...f, ts: new Date(clock.now()).toISOString() })
    await advanceSteps(clock, 180_000, 20_000, b.client) // the signing time is now past the reset and its margin
    const before = notices(hh()).length
    hh().app.send(await runFrame(hh(), SCRIPT, { original_ts: ago(10 * 60_000) })) // but the words were written before it
    // wait for the refusal itself: the restarted bridge's own startup notice can land in this window and is not it
    await ticking(
      clock,
      () =>
        notices(hh())
          .slice(before)
          .some((n) => /history was reset/.test(n)),
      'the refusal',
    )
    expect(notes.filter((n) => n.meta.run !== undefined)).toHaveLength(0)
  })

  test('a block that ran before the reset can run once more after it: the marks went with the history', async () => {
    await start()
    const ref = blockRef()
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await hh().waitNotes(1)
    const { b, clock, notes } = await restartWithResetHistory(hh())
    const app = hh().app as unknown as { sign: (f: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const realSign = app.sign.bind(hh().app)
    app.sign = (f) => realSign({ ...f, ts: new Date(clock.now()).toISOString() })
    await advanceSteps(clock, 180_000, 20_000, b.client)
    expect(b.ctx.store.hasSeen(`run:${ref.message_id}:0`)).toBe(false)
    hh().app.send(await runFrame(hh(), SCRIPT, { run_block: ref }))
    await ticking(clock, () => notes.some((n) => n.meta.run === 'tap'), 'the note')
  })

  test('a Run signed after the reset is accepted', async () => {
    await start()
    const { b, clock, notes } = await restartWithResetHistory(hh())
    const app = hh().app as unknown as { sign: (f: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const realSign = app.sign.bind(hh().app)
    // three minutes after the reset: past the two minutes of phone clock the Mac allows for
    app.sign = (f) => realSign({ ...f, ts: new Date(clock.now()).toISOString() })
    await advanceSteps(clock, 180_000, 20_000, b.client)
    const f = await runFrame(hh())
    hh().app.send(f)
    await ticking(clock, () => notes.some((n) => n.meta.run === 'tap'), 'the note')
  })
})

// ---- a worker holds the thread -------------------------------------------------------------------------------------------

const NONCE = 'test-nonce-0123456789abcdef'

/** A thread with its own session (`dedicated`), a worker running for it or not. */
async function dedicatedTrip(workerLive: boolean) {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          voice_context: 'recent',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  if (!workerLive) return
  await waitFor(() => existsSync(join(hh().home, 'hub.sock')))
  writeFileSync(
    join(hh().home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pgidOf(process.pid),
          cwd: hh().home,
          error: null,
        },
      },
    }),
  )
  mkdirSync(join(hh().home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(hh().home, 'workers', 'trip', 'nonce'), NONCE)
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hh().home,
      TALOS_APP_RELAY_URL: hh().relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  expect(await worker.startWorker()).toBe(true)
}

/** What the worker is handed, once the queue has reached a message sent after everything else. */
async function readWorker() {
  type Got = { content: string; meta: Record<string, string> }
  const read = async () =>
    JSON.parse(((await worker?.callTool('read_inbound', {}))?.content[0]?.text as string) ?? '{}') as {
      messages: Got[]
    }
  await afterQueue(hh())
  return (await read()).messages as Got[]
}

describe('a Run in a thread with its own session', () => {
  test('is refused with a plain line: nothing reaches main or the worker, and the Run is marked seen', async () => {
    await dedicatedTrip(true)
    const typed = await hh().app.sendMessage('trip', runText(SCRIPT, 'sh') as string) // same words, no intent: ordinary text
    const tap = await runFrame(hh(), SCRIPT, {}, 'trip')
    hh().app.send(tap)
    await waitFor(() => notices(hh()).length > 0, 5000, 'the refusal')
    // a re-post cannot run in such a thread either, so the line does not suggest one
    expect(notices(hh())[0]).toBe("That Run was not run: this thread has its own session, so Run isn't available here.")
    const got = await readWorker()
    expect(got.map((m) => m.meta.message_id)).toEqual([typed.client_msg_id as string]) // only the typed words reached the worker
    expect(runNotes(hh())).toHaveLength(0) // and nothing reached main
    // Marked seen, both ids: a replay is consumed silently and the owner is not told twice.
    expect(hh().bridge.ctx.store.hasSeen(tap.client_msg_id as string)).toBe(true)
    expect(hh().bridge.ctx.store.hasSeen(tap.id as string)).toBe(true)
    hh().relay.sendToBridge(tap as never)
    await afterQueue(hh())
    expect(notices(hh())).toHaveLength(1)
  })

  test('is refused whether or not a worker is running: a switched-off thread refuses too', async () => {
    await dedicatedTrip(false)
    const tap = await runFrame(hh(), SCRIPT, {}, 'trip')
    hh().app.send(tap)
    await waitFor(() => notices(hh()).length > 0, 5000, 'the refusal')
    expect(notices(hh())[0]).toMatch(/has its own session/)
    await afterQueue(hh())
    expect(runNotes(hh())).toHaveLength(0)
    expect(hh().notes.some((n) => n.content.includes('echo hello'))).toBe(false)
  })

  test('a shared thread on the same Mac still takes a Run', async () => {
    await dedicatedTrip(false)
    hh().app.send(await runFrame(hh(), SCRIPT, {}, 'general'))
    await hh().waitNotes(1)
    expect(runNotes(hh())).toHaveLength(1)
  })
})
