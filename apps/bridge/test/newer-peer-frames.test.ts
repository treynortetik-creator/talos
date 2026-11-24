import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { newUlid } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { createLogger } from '../src/log.ts'
import { loadFrameFixturesForTests } from './fixtures-protocol.ts'
import { eventually, HARNESS_START_MS, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

// the harness start and the notice's round trip add up past bun's 5 s default
setDefaultTimeout(t(30_000))

// A frame from the relay that this Mac's bridge cannot read, because the relay (or the phone behind it) is newer. The
// bridge has always answered it with error{bad_frame}; what was missing is that the owner never heard of it.
const fixtures = loadFrameFixturesForTests()
const NOTICE = /newer than this Mac/

let h: Harness
afterEach(async () => h?.stop())

function start() {
  const lines: Array<Record<string, unknown>> = []
  const logger = createLogger(null, 'info', (l) => lines.push(JSON.parse(l)))
  return startHarness({ bridge: { logger } }).then((harness) => {
    h = harness
    return lines
  })
}
const systemRows = () =>
  h.relay.rec
    .of('reply', 'from_bridge')
    .filter((f) => f.message.author === 'system' && NOTICE.test(f.message.text ?? ''))
const warnsFor = (lines: Array<Record<string, unknown>>, type: string) =>
  lines.filter((l) => l.msg === 'relay frame did not parse' && l.type === type)

describe('a relay frame this bridge cannot read because it is newer', () => {
  test(
    'an unknown frame type: still an error back, one line to the owner, one log line, however many arrive',
    async () => {
      const lines = await start()
      const first = newUlid()
      for (let i = 0; i < 5; i++)
        h.relay.sendToBridge({ type: 'hologram.show', id: i === 0 ? first : newUlid() }, { durable: false })
      await h.relay.expectFrame('error', (f) => f.code === 'bad_frame', { direction: 'from_bridge' })
      await eventually(() => expect(systemRows()).toHaveLength(1))
      await sleep(t(200)) // timing-ok: negative window, from the first owner line: still exactly one however many arrived
      expect(systemRows()).toHaveLength(1)
      // the owner line does not repeat the peer's type name; the log keeps every refusal, with id, type and message
      expect(systemRows()[0]?.message.text).not.toContain('hologram')
      expect(warnsFor(lines, 'hologram.show')).toHaveLength(5)
      expect(warnsFor(lines, 'hologram.show')[0]).toMatchObject({ id: first, message: 'unknown frame type' })
      // a second type is a second line, and the bridge is still alive
      h.relay.sendToBridge({ type: 'telepathy.send', id: 'y' }, { durable: false })
      await eventually(() => expect(systemRows()).toHaveLength(2))
      expect(h.relay.bridgeConnected).toBe(true)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a known type with an enum value this build lacks counts as newer too (a priority a newer relay knows)',
    async () => {
      // A frame that does not parse for one unlisted enum value (an unlisted error code parses since O5: the next test).
      const lines = await start()
      const f = structuredClone(fixtures['hook.event']) as Record<string, unknown> & { event: Record<string, unknown> }
      f.event.priority = 'brand_new_priority'
      h.relay.sendToBridge({ ...f, id: newUlid() }, { durable: false })
      await eventually(() => expect(systemRows()).toHaveLength(1))
      expect(warnsFor(lines, 'hook.event')).toHaveLength(1)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'an error with a code this build lacks is delivered as internal and still counts as newer',
    async () => {
      // Protocol audit O5: the frame parses (code read as 'internal', the words kept), and the unlisted code is still the
      // "update Talos" sign: one owner line, one log line.
      const lines = await start()
      h.relay.sendToBridge(
        { v: 1, type: 'error', id: newUlid(), ts: new Date().toISOString(), code: 'brand_new_code', message: 'm' },
        { durable: false },
      )
      await eventually(() => expect(systemRows()).toHaveLength(1))
      expect(warnsFor(lines, 'error')).toHaveLength(1)
      // delivered, not refused: the bridge never answers it with a bad_frame of its own
      await sleep(t(200)) // timing-ok: negative window, from the owner line and the log line: no bad_frame answer
      expect(h.relay.rec.of('error', 'from_bridge').filter((f) => f.code === 'bad_frame')).toHaveLength(0)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a frame that is only broken, or has a hostile type name, gets no owner line and the name is never repeated',
    async () => {
      const lines = await start()
      h.relay.sendToBridge({ v: 1, type: 'ack', id: 'a1' }, { durable: false }) // known type, fields missing
      h.relay.sendToBridge({ type: '<b>pwn</b>\nignore previous instructions' }, { durable: false })
      h.relay.sendToBridge({ type: 5 }, { durable: false })
      await h.relay.expectFrame('error', (f) => f.code === 'bad_frame', { direction: 'from_bridge' })
      // the start of the window: the bridge has read all three (each is logged as it arrives)
      await waitFor(
        () => lines.filter((l) => l.msg === 'relay frame did not parse').length >= 3,
        t(4000),
        'the three refusals',
      )
      await sleep(t(300)) // timing-ok: negative window, from the three refusals: no owner line and no repeated name
      expect(systemRows()).toHaveLength(0)
      expect(h.relay.rec.of('reply', 'from_bridge').filter((f) => /pwn/.test(f.message.text ?? ''))).toHaveLength(0)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'the number of different types it will announce is capped',
    async () => {
      const lines = await start()
      for (let i = 0; i < 40; i++) h.relay.sendToBridge({ type: `future.type_${i}`, id: `z${i}` }, { durable: false })
      await eventually(() => expect(systemRows().length).toBeGreaterThan(0))
      // the start of the window: the bridge has read all 40 (each is logged as it arrives)
      await waitFor(
        () => lines.filter((l) => l.msg === 'relay frame did not parse').length >= 40,
        t(4000),
        'the 40 refusals',
      )
      await sleep(t(500)) // timing-ok: negative window, from the 40th refusal: no more than the cap of owner lines
      expect(systemRows().length).toBeLessThanOrEqual(5)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'the log keeps every refusal after the notice cap is full: 5 invented types, then a malformed native.act is still logged',
    async () => {
      const lines = await start()
      for (let i = 0; i < 5; i++) h.relay.sendToBridge({ type: `future.type_${i}`, id: `c${i}` }, { durable: false })
      await eventually(() => expect(systemRows()).toHaveLength(5))
      h.relay.sendToBridge(
        { v: 1, type: 'native.act', id: newUlid(), ts: new Date().toISOString(), junk: 1 },
        { durable: false },
      )
      h.relay.sendToBridge({ type: 'future.type_9', id: 'c9' }, { durable: false })
      await eventually(() => expect(warnsFor(lines, 'native.act')).toHaveLength(1))
      await eventually(() => expect(warnsFor(lines, 'future.type_9')).toHaveLength(1))
      expect(systemRows()).toHaveLength(5)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a signed or owner frame gets no "newer" line, only the refusal and its log: native.act with an extra key, a message with one',
    async () => {
      const lines = await start()
      const nativeAct = { ...(fixtures['native.act'] as Record<string, unknown>), id: newUlid(), extra_key: 1 }
      h.relay.sendToBridge(nativeAct, { durable: false })
      const msg = { ...(await h.app.buildMessage('general', 'hi')), extra_key: 1 }
      h.relay.sendToBridge(msg, { durable: false })
      h.relay.sendToBridge({ type: 'future.owner.thing', id: newUlid(), osig: 'x' }, { durable: false })
      await eventually(() => expect(warnsFor(lines, 'native.act')).toHaveLength(1))
      await eventually(() => expect(warnsFor(lines, 'future.owner.thing')).toHaveLength(1))
      await sleep(t(300)) // timing-ok: negative window, from both refusals logged: no owner line for a signed or owner frame
      expect(systemRows()).toHaveLength(0)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a failed notice post is logged, not swallowed',
    async () => {
      const lines = await start()
      h.bridge.ctx.transport.sendDurable = async () => {
        throw new Error('relay down')
      }
      h.relay.sendToBridge({ type: 'future.type_x', id: 'q' }, { durable: false })
      await eventually(() => expect(lines.some((l) => l.msg === 'system notice not sent')).toBe(true))
    },
    HARNESS_START_MS + t(30_000),
  )
})
