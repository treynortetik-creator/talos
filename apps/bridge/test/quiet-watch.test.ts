// A thread session that read an owner message and has said nothing for 5 minutes while its pane is idle: the bridge posts ONE notice in
// that thread, with an Open terminal action. Plain checks on the bridge's own records and workers.json only: nothing here reads the
// pane, the transcript or any text. Real hub and bridge, workers.json as the supervisor writes it. No real claude.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type MessageT, QUIET_LINES_FEATURE } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import * as Q from '../src/router/quiet-words.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const MIN = 60_000
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function start(relayFeatures: string[] = []) {
  h = await startHarness({
    relay: { relayFeatures },
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
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  return h
}

type Over = Record<string, unknown>
/** workers.json: Trip's session is live, and was last active `idleMin` minutes ago (nothing: no last_active_at). */
let writes = 0
function writeWorkers(x: Harness, over: Over = {}, idleMin: number | null = 6, heartbeat = new Date().toISOString()) {
  const path = join(x.home, 'workers.json')
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: heartbeat, workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: SESSION,
          tmux: 't-trip',
          pane_pid: 0,
          cwd: '/home/alex/project',
          restarts: [],
          error: null,
          ...(idleMin === null ? {} : { last_active_at: new Date(Date.now() - idleMin * MIN).toISOString() }),
          ...over,
        },
      },
    }),
  )
  // every write must look new to the reader (it keeps what it read while the file's time and size are unchanged): a distinct time each
  writes++
  const t = new Date(Date.now() + writes * 2_000)
  utimesSync(path, t, t)
}

/** An owner message the session read `readMin` minutes ago (routed, then claimed by the session). */
function claimed(
  x: Harness,
  id: string,
  readMin: number,
  over: { kind?: string; thread?: string; trust?: string } = {},
) {
  const store = x.bridge.router?.store
  const at = Date.now() - readMin * MIN
  store?.addRoute({
    message_id: id,
    thread_id: 'trip',
    notification: {
      content: 'a question',
      meta: {
        message_id: id,
        thread_id: over.thread ?? 'trip',
        trust: over.trust ?? 'owner',
        kind: over.kind ?? 'text',
      },
    },
    woke_at: at - 1_000,
    deadline_at: at + MIN,
    cold: false,
  })
  store?.claim(id, 'worker:trip', at)
}

const noticesIn = (x: Harness, thread = 'trip'): MessageT[] =>
  x.bridge.ctx.store
    .page({ thread_id: thread, limit: 50 })
    .messages.filter((m) => m.author === 'system' && m.text === Q.QUIET.text('Trip'))
const tick = (x: Harness) => x.bridge.optionCTick()
const quiet = () => sleep(t(150)) // timing-ok: negative window: nothing is posted

describe('the quiet notice', () => {
  test('read 6 minutes ago, no answer, live and idle for 6: ONE notice in the thread, with the Open terminal action, once', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 6)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    const m = noticesIn(x)[0] as MessageT
    expect(m.text).toBe(
      "Trip has been quiet for 5 minutes and isn't doing anything. Open its terminal to see what's going on.",
    )
    expect(m.actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
    tick(x)
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(1)
  })

  test('not before 5 minutes: a message read 4 minutes ago, or a pane active 4 minutes ago, gets nothing', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 4)
    tick(x)
    writeWorkers(x, {}, 4)
    claimed(x, 'm2', 9)
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(0)
  })

  test('busy, needs you, a dialog, Claude Code’s own limit wait, no activity time, parked or a stale supervisor: nothing', async () => {
    const x = await start()
    claimed(x, 'm1', 9)
    const cases: [string, Over, number | null, string?][] = [
      ['busy', { state: 'busy' }, 9],
      // a long step: the screen above the box has not changed for a while, but a turn is running (turn_started_at), so it is not quiet
      ['turn in progress', { turn_started_at: new Date(Date.now() - 20 * MIN).toISOString() }, 9],
      // Claude Code's own permission question for a tool is waiting on the owner (needs_you, and the pane dialog)
      ['tool permission prompt (needs_you)', { needs_you: { kind: 'a prompt', since: new Date().toISOString() } }, 9],
      [
        'tool permission prompt (dialog)',
        {
          dialog: {
            id: 'p'.repeat(24),
            kind: 'tool_permission',
            subject: 'Bash command',
            options: ['Allow once', 'Deny'],
            cursor: 0,
            seen_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        9,
      ],
      ['needs_you', { needs_you: { kind: 'sign in', since: new Date().toISOString() } }, 9],
      [
        'dialog',
        {
          dialog: {
            id: 'd'.repeat(24),
            kind: 'trust',
            subject: null,
            options: ['Yes, I trust this folder', 'No, exit'],
            cursor: 0,
            seen_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        9,
      ],
      ['limit_wait', { limit_wait: { since: new Date().toISOString() } }, 9],
      ['no activity time', {}, null],
      ['parked', { state: 'parked' }, 9],
      ['stale supervisor', {}, 9, new Date(Date.now() - 600_000).toISOString()],
    ]
    for (const [, over, idle, heartbeat] of cases) {
      writeWorkers(x, over, idle, heartbeat)
      tick(x)
    }
    await quiet()
    expect(noticesIn(x)).toHaveLength(0)
    // and then NOTHING in the way: the same message, the same session, now posts. This proves every refusal above was the case's own
    // condition, not a cached or stale read of workers.json (each write is given a distinct time, as a real supervisor's are)
    // (the 'parked' case above ended the run, so the router settled that message: a message read now stands for it)
    claimed(x, 'm2', 9)
    writeWorkers(x, {}, 9)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
  })

  test('an agent message after the owner’s: it said something, so nothing', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 8)
    x.bridge.ctx.store.addMessage({
      id: 'm_agent_one',
      thread_id: 'trip',
      author: 'agent',
      kind: 'text',
      text: 'on it',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(Date.now() - 7 * MIN).toISOString(),
    } as MessageT)
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(0)
  })

  test('only an owner’s own text or file counts: a card tap, a wake, a hand-off or outside text gets nothing', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'c1', 9, { kind: 'card_action' })
    claimed(x, 'c2', 9, { kind: 'wake' })
    claimed(x, 'c3', 9, { kind: 'handoff' })
    claimed(x, 'c4', 9, { trust: 'external' })
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(0)
  })

  test('messages read at different times in ONE quiet stretch give one notice; after the pane has been active again and quiet again, a later message gets its own', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 12)
    claimed(x, 'm2', 7)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    tick(x)
    claimed(x, 'm3', 6) // read later, same quiet stretch (the pane's idle clock has not moved)
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(1)
    writeWorkers(x, {}, 6) // the pane changed and has been quiet again: a new stretch
    claimed(x, 'm4', 6)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(2))
  })

  test('a lead’s own thread and a sub-thread it serves, one session, one stretch: a row in EACH, and each later "stopped" line matches what that thread was shown', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 9) // asked in the session's own thread
    claimed(x, 'm2', 9, { thread: 'general' }) // asked in another thread the session serves
    tick(x)
    await eventually(() => {
      expect(noticesIn(x, 'trip')).toHaveLength(1)
      expect(noticesIn(x, 'general')).toHaveLength(1)
    })
    writeWorkers(x, { started_at: new Date(Date.now() - 60_000).toISOString() }) // the run ended
    tick(x)
    const later = (thread: string) =>
      x.bridge.ctx.store
        .page({ thread_id: thread, limit: 50 })
        .messages.filter((m) => m.author === 'system' && m.text === Q.QUIET.stoppedAfter('Trip'))
    await eventually(() => {
      expect(later('trip')).toHaveLength(1)
      expect(later('general')).toHaveLength(1)
    })
  })

  test('a voice note the session read counts as the owner’s words', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'v1', 6, { kind: 'voice_note' })
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
  })

  test('if the owner was told it was quiet, the later "stopped before it answered" line is the quieter one; without the first notice it is the old words', async () => {
    const OLD = "This thread's session stopped before it answered. Send the message again to carry on."
    const rowsWith = (x: Harness, text: string) =>
      x.bridge.ctx.store
        .page({ thread_id: 'trip', limit: 50 })
        .messages.filter((m) => m.author === 'system' && m.text === text)
    expect(Q.QUIET.stoppedAfter('Trip')).toBe(
      "Trip has stopped and still hasn't answered. Send your message again to carry on.",
    )
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 9)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    writeWorkers(x, { started_at: new Date(Date.now() - 60_000).toISOString() }) // the session restarted since: its run ended
    tick(x)
    await eventually(() => expect(rowsWith(x, Q.QUIET.stoppedAfter('Trip'))).toHaveLength(1))
    expect(rowsWith(x, OLD)).toHaveLength(0)
    await x.stop()
    h = undefined
    const y = await start()
    writeWorkers(y)
    claimed(y, 'm1', 9)
    writeWorkers(y, { started_at: new Date(Date.now() - 60_000).toISOString() })
    tick(y)
    await eventually(() => expect(rowsWith(y, OLD)).toHaveLength(1))
    expect(rowsWith(y, Q.QUIET.stoppedAfter('Trip'))).toHaveLength(0)
  })

  test('a restart of the bridge (a new watch with the same store) does not say it again', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 6)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    expect(x.bridge.ctx.store.kvGet('quiet_notice:m1')).toBeDefined()
    const watch = (x.bridge.router as unknown as { sessionErrors: { quiet: { forget(): void } } }).sessionErrors.quiet
    watch.forget() // what a restart loses: nothing but memory; the kv key is the record
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(1)
  })

  test('a message to a sub-thread the session serves: the notice is where the owner asked, the action opens the SESSION’s terminal', async () => {
    const x = await start()
    writeWorkers(x)
    claimed(x, 'm1', 6, { thread: 'general' })
    tick(x)
    await eventually(() => expect(noticesIn(x, 'general')).toHaveLength(1))
    expect((noticesIn(x, 'general')[0] as MessageT).actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
  })

  test('a session whose run already ended (restarted after the message) is the "stopped before it answered" notice’s job, not this one', async () => {
    const x = await start()
    claimed(x, 'm1', 9)
    writeWorkers(x, { started_at: new Date(Date.now() - 2 * MIN).toISOString() })
    tick(x)
    await quiet()
    expect(noticesIn(x)).toHaveLength(0)
  })

  test('the words are in the one table, not in the watch', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'router', 'quiet-watch.ts'), 'utf8')
    expect(src).not.toMatch(/has been quiet|isn't doing anything|Open its terminal/)
  })
})

describe('the last pane lines, in the app only', () => {
  const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
  const sentLines = (x: Harness) =>
    x.relay.frames
      .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'quiet.lines')
      .map((f) => f.raw as { message_id: string; thread_id: string; lines: string[] })

  test('the notice is the fixed words only; the lines go in a separate ephemeral frame for that message, redacted and capped AGAIN by the bridge', async () => {
    const x = await start([QUIET_LINES_FEATURE])
    claimed(x, 'm_01HZ00000000000000000PL1', 6)
    writeWorkers(x, {
      quiet_lines: [
        'one',
        `export TOKEN=${GH}`,
        `mail jane@example.com ${'z'.repeat(150)}`,
        'zq-marker-four',
        'zq-marker-five',
      ],
    })
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    await eventually(() => expect(sentLines(x)).toHaveLength(1))
    const [frame] = sentLines(x)
    const notice = noticesIn(x)[0] as MessageT
    expect(frame?.message_id).toBe(notice.id)
    expect(frame?.thread_id).toBe('trip')
    expect(frame?.lines).toHaveLength(3)
    for (const l of frame?.lines ?? []) expect([...l].length).toBeLessThanOrEqual(100)
    const all = JSON.stringify(frame?.lines)
    expect(all).not.toContain(GH)
    expect(all).not.toContain('jane@example.com')
    // the notice carries none of it: not in its text, not in the stored copy, not in any durable frame the bridge sent
    expect(notice.text).toBe(Q.QUIET.text('Trip'))
    expect(JSON.stringify(notice)).not.toContain('zq-marker-four')
    const durable = x.relay.frames
      .filter((f) => f.direction === 'from_bridge' && f.raw.type !== 'quiet.lines')
      .map((f) => JSON.stringify(f.raw))
      .join(' ')
    expect(durable).not.toContain('zq-marker-five')
    expect(JSON.stringify(x.bridge.ctx.store.page({ thread_id: 'trip', limit: 50 }))).not.toContain('zq-marker-five')
  })

  test('a Mac without the Swift half: no quiet_lines on the entry, so the notice is as before and no lines frame is sent', async () => {
    const x = await start([QUIET_LINES_FEATURE])
    claimed(x, 'm_01HZ00000000000000000PL2', 6)
    writeWorkers(x)
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    await quiet()
    expect(sentLines(x)).toHaveLength(0)
  })

  test('a relay that does not list the feature: the notice goes, the lines are never sent (an older relay would refuse the frame)', async () => {
    const x = await start([])
    claimed(x, 'm_01HZ00000000000000000PL3', 6)
    writeWorkers(x, { quiet_lines: ['one', 'two'] })
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    await quiet()
    expect(sentLines(x)).toHaveLength(0)
  })

  test('lines that are not text, or only blanks, send nothing', async () => {
    const x = await start([QUIET_LINES_FEATURE])
    claimed(x, 'm_01HZ00000000000000000PL4', 6)
    writeWorkers(x, { quiet_lines: ['', '   '] })
    tick(x)
    await eventually(() => expect(noticesIn(x)).toHaveLength(1))
    await quiet()
    expect(sentLines(x)).toHaveLength(0)
  })
})
