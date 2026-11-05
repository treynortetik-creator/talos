// @vitest-environment node
// Races in the offline message queue. Each case injects the failure for real, in the storage object or the upload the
// client uses, at the one await where the old code lost a message, resurrected a deleted one, or let order change.
import { newId } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteDeviceKey } from '../src/lib/deviceKey.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'
import { keepsUnsent } from '../src/lib/unsent.ts'

const DAY = 24 * 3600_000
let relay: FakeRelay
let bridge: FakeBridge
let storage: Storage
let skew = 0
let online = false
let client: SocketClient
let uploadStatus = 0 // 0: reach the relay; anything else: answer with that status
let uploads = 0 // upload requests the client made
/** Decides one upload by the recording's file name: a Response answers it, a throw is a network error, nothing lets it through. */
let uploadFault: ((name: string) => Promise<Response | undefined> | Response | undefined) | undefined

type Row = { id: string; clientMsgId: string; bytes: string; writtenAt?: number | null; order: number; kind?: string }
type Hooks = {
  beforePut?: (store: string, key: string, value: unknown) => Promise<void> | void
  afterDel?: (store: string, key: string) => Promise<void> | void
}
let hooks: Hooks = {}

function hookedStorage(): Storage {
  const inner = createMemoryStorage()
  return {
    ...inner,
    async put(store, key, value) {
      await hooks.beforePut?.(store, key, value)
      return inner.put(store, key, value)
    },
    async del(store, key) {
      await inner.del(store, key)
      await hooks.afterDel?.(store, key)
    },
  }
}

/** A socket that swallows the frames `lose` picks: the client believes they went out, the relay never sees them. */
let lose: ((frame: string) => boolean) | undefined
class LossyWS extends WebSocket {
  override send(data: string | BufferSource | Blob) {
    if (typeof data === 'string' && lose?.(data)) return
    super.send(data)
  }
}

const make = (voiceRetryMs = 60) =>
  createSocketClient({
    storage,
    WebSocketImpl: LossyWS as unknown as typeof WebSocket,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => online,
    now: () => Date.now() + skew,
    voiceRetryMs,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      uploads++
      const name = decodeURIComponent(String((init?.headers as Record<string, string> | undefined)?.['X-Talos-Name']))
      const fault = await uploadFault?.(name)
      if (fault) return fault
      return uploadStatus
        ? new Response(JSON.stringify({ error: 'down' }), { status: uploadStatus })
        : fetch(`${relay.httpUrl}${url}`, init)
    }) as typeof fetch,
  })

beforeEach(async () => {
  hooks = {}
  uploadStatus = 0
  uploads = 0
  uploadFault = undefined
  lose = undefined
  relay = await new FakeRelay().start()
  storage = hookedStorage()
  skew = 0
  online = false
  client = make()
  const key = await client.ensureDevice()
  bridge = await new FakeBridge({
    relayWs: relay.wsBase,
    key: relay.bridgeKey,
    now: () => Date.now() + skew,
    pinnedDevices: { [key.deviceId]: key.publicJwk },
  }).connect()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const rows = () => storage.all<Row>('outbox')
const fromApp = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gate = () => {
  let open!: () => void
  const wait = new Promise<void>((r) => {
    open = r
  })
  let hit!: () => void
  const hitP = new Promise<void>((r) => {
    hit = r
  })
  return { wait, open, hit, hitP }
}

async function reopen(voiceRetryMs?: number) {
  client.close()
  online = true
  client = make(voiceRetryMs)
  await client.start({ pinned: true })
}
const voiceAtt = () => ({
  media_id: newId('md'),
  kind: 'voice_note' as const,
  role: 'attachment' as const,
  mime: 'audio/webm',
  name: 'v.webm',
  size: 3,
  sha256: 'a'.repeat(64),
})

describe('a close that lands while a message is being marked as written', () => {
  it('keeps the only copy when the session only expired', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') client.close({ keepQueue: true })
    }
    const res = await client.sendMessage({ threadId: 'general', text: 'do not lose me' })
    expect(res.state).toBe('queued')
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left[0]?.clientMsgId).toBe(res.clientMsgId)
  })

  it('still takes it back out when the owner signed out', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') client.close()
    }
    await client.sendMessage({ threadId: 'general', text: 'gone with the sign-out' })
    expect(await rows()).toHaveLength(0)
  })
})

describe('a close that lands while a message is first being saved', () => {
  /** The close arrives during the one write that saves the signed message (the one with no write time yet). */
  const closeDuringFirstSave = (keepQueue: boolean) => {
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && (v as Row).writtenAt === null) client.close(keepQueue ? { keepQueue: true } : undefined)
    }
  }

  it.each([['expired'], ['signed_in_again']])(
    'reason %s: the row stays, the caller is told it is queued, and it goes out once after sign-in with the same key',
    async (reason) => {
      closeDuringFirstSave(keepsUnsent(reason))
      const res = await client.sendMessage({ threadId: 'general', text: 'pressed as it expired' })
      expect(res.state).toBe('queued') // not a failure: the words are not handed back as well
      const left = await rows()
      expect(left).toHaveLength(1)
      expect(left[0]?.clientMsgId).toBe(res.clientMsgId)
      hooks = {}
      await reopen() // signed back in on the same device key
      await waitFor(() => fromApp('message').length === 1, 6000, 'sent after sign-in')
      await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
      expect(fromApp('message')).toHaveLength(1)
    },
  )

  it('with the device key replaced meanwhile, the row is removed with a notice and nothing is sent', async () => {
    closeDuringFirstSave(true)
    await client.sendMessage({ threadId: 'general', text: 'under the old key' })
    expect(await rows()).toHaveLength(1)
    hooks = {}
    await deleteDeviceKey(storage)
    await make().ensureDevice() // a new key
    await reopen()
    await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
    const notice = Object.values(client.store.getState().messages)
      .flat()
      .find((m) => m.author === 'system')
    expect(notice?.text).toMatch(/1 message that was waiting was removed/)
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(fromApp('message')).toHaveLength(0)
  })

  it('a sign-out takes the row back out and the caller gets a failure', async () => {
    closeDuringFirstSave(false)
    await expect(client.sendMessage({ threadId: 'general', text: 'gone with the sign-out' })).rejects.toThrow()
    expect(await rows()).toHaveLength(0)
  })
})

/**
 * Holds the next signing until the gate opens. The signing input is a hash, so a signing is told apart by who asked for it:
 * `from` is a function name that must be on the call stack (the flush signs a queued voice note in signAndStore).
 */
function holdSigning(from?: string) {
  const g = gate()
  const real = crypto.subtle.sign.bind(crypto.subtle)
  let held = false
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (alg, key, data) => {
    if (!held && (from === undefined || new Error().stack?.includes(from))) {
      held = true
      g.hit()
      await g.wait
    }
    return real(alg as never, key, data as BufferSource)
  })
  return g
}

describe('a close that lands while a message is being signed', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([['expired'], ['signed_in_again']])(
    'reason %s: the row is saved, the caller is told it is queued, and it goes out once after sign-in',
    async (reason) => {
      const g = holdSigning()
      const sent = client.sendMessage({ threadId: 'general', text: 'pressed as the session ended' })
      await g.hitP
      client.close({ keepQueue: keepsUnsent(reason) })
      g.open()
      const res = await sent // not a throw: the words are not handed back as well
      expect(res.state).toBe('queued')
      expect(await rows()).toHaveLength(1)
      vi.restoreAllMocks()
      await reopen()
      await waitFor(() => fromApp('message').length === 1, 6000, 'sent after sign-in')
      await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
      expect(fromApp('message')).toHaveLength(1)
    },
  )
})

describe('a voice note caught by a close that keeps the queue', () => {
  const blobs = () => storage.all('blobs')

  /** An offline client with a note and a text behind it; the close lands where `at` says when the flush signs the note. */
  async function noteWithTextBehind() {
    client.close()
    client = make(600_000)
    await client.start({ pinned: true })
    const note = await client.queueVoiceNote(webm())
    const text = await client.sendMessage({ threadId: 'general', text: 'behind the note' })
    return { note, text }
  }
  /** Eight days on, signed in again on the same key: the relay's copy of the upload is gone, so the recording is needed. */
  async function eightDaysLater(ids: string[]) {
    hooks = {}
    vi.restoreAllMocks()
    skew = 8 * DAY
    await reopen(600_000)
    await waitFor(() => sentOrder().length === 2, 8000, 'both went out')
    expect(sentOrder()).toEqual(['voice_note', 'message'])
    for (const id of ids) expect(failedAs(id)).toBeUndefined()
    await vi.waitFor(async () => expect(await blobs()).toHaveLength(0), { timeout: 6000 })
  }
  afterEach(() => vi.restoreAllMocks())

  it("closed during the note's first save: the recording stays, no row points at the old upload, and both go out later", async () => {
    const { note, text } = await noteWithTextBehind()
    const closed = gate()
    const dropped = gate()
    hooks.afterDel = (st) => {
      if (st === 'outbox') dropped.hit()
    }
    hooks.beforePut = (st, _k, v) => {
      if (st === 'outbox' && (v as Row).kind === 'voice_note' && (v as Row).writtenAt === null) {
        client.close({ keepQueue: true })
        closed.hit()
      }
    }
    online = true
    client.reconnect()
    await closed.hitP
    await dropped.hitP // the note's row was saved and then taken back out
    expect((await rows()).map((r) => r.kind)).toEqual(['message'])
    expect(await blobs()).toHaveLength(1)
    await eightDaysLater([note.clientMsgId, text.clientMsgId])
  })

  it('closed while the note is being signed: the recording stays too', async () => {
    const { note, text } = await noteWithTextBehind()
    const g = holdSigning('signAndStore')
    online = true
    client.reconnect()
    await g.hitP
    const dropped = gate()
    hooks.afterDel = (st) => {
      if (st === 'outbox') dropped.hit()
    }
    client.close({ keepQueue: true })
    g.open()
    await dropped.hitP // the note's row was saved and then taken back out
    expect((await rows()).map((r) => r.kind)).toEqual(['message'])
    expect(await blobs()).toHaveLength(1)
    await eightDaysLater([note.clientMsgId, text.clientMsgId])
  })
})

describe('a recording saved after the session closed', () => {
  it('leaves nothing behind after a real sign-out', async () => {
    client.close() // sign-out
    await expect(client.queueVoiceNote(webm())).rejects.toThrow()
    expect(await storage.all('blobs')).toHaveLength(0)
  })

  it.each([['expired'], ['signed_in_again']])('is kept after reason %s, and sent after sign-in', async (reason) => {
    client.close({ keepQueue: keepsUnsent(reason) })
    await client.queueVoiceNote(webm())
    expect(await storage.all('blobs')).toHaveLength(1)
    await goOnline()
    await waitFor(() => fromApp('voice_note').length === 1, 6000, 'sent')
  })
})

describe('a sign-out during the last await of a re-sign', () => {
  it('writes nothing back to the queue afterwards', async () => {
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'old news' })
    skew = 0
    let fired = false
    hooks.afterDel = async (s) => {
      if (s !== 'outbox' || fired) return
      fired = true
      client.close() // the sign-out, then its wipe
      await storage.clear('outbox')
    }
    await reopen()
    await waitFor(() => fired, 6000, 'the re-sign finished its swap')
    await sleep(150)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
  })
})

describe('a close that lands while a message is being signed again', () => {
  it('keeps the message, in its new signature, when the session only expired', async () => {
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'old but wanted' })
    skew = 0
    const [orig] = await rows()
    let fired = false
    hooks.beforePut = (s, k) => {
      if (s !== 'outbox' || k === orig?.id || fired) return
      fired = true
      client.close({ keepQueue: true })
    }
    await reopen()
    await waitFor(() => fired, 6000, 'the re-sign began')
    await sleep(150)
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left[0]?.id).not.toBe(orig?.id) // the old signature is past what the Mac accepts; the new one stays
    expect(fromApp('message')).toHaveLength(0)
  })
})

describe('a discard while the queue is flushing', () => {
  it('is not undone in storage by a write that was already in flight, and the message is not sent', async () => {
    await client.sendMessage({ threadId: 'general', text: 'changed my mind' })
    const g = gate()
    hooks.beforePut = async (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') {
        g.hit()
        await g.wait
      }
    }
    const id = (await rows())[0]?.clientMsgId as string
    await reopen()
    await g.hitP
    const discarded = client.discardMessage(id)
    g.open()
    await discarded
    await sleep(150)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
  })

  it('does not let a message go out that was discarded while it was being signed again', async () => {
    skew = -10 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'old, then dropped' })
    skew = 0
    const [orig] = await rows()
    const g = gate()
    hooks.beforePut = async (s, k) => {
      if (s === 'outbox' && k !== orig?.id) {
        g.hit()
        await g.wait
      }
    }
    await reopen()
    await g.hitP
    const discarded = client.discardMessage(sent.clientMsgId)
    g.open()
    await discarded
    await sleep(200)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
    expect(bridge.notified).toHaveLength(0)
  })
})

describe('a retry that races the flush', () => {
  it('leaves one row for the message, not an orphan from the second re-sign', async () => {
    skew = -10 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'once only' })
    skew = 0
    relay.swallowAcks = true // rows stay, so an orphan can be seen
    const [orig] = await rows()
    const g = gate()
    let held = false
    hooks.beforePut = async (s, k) => {
      if (s === 'outbox' && k !== orig?.id && !held) {
        held = true
        g.hit()
        await g.wait
      }
    }
    await reopen()
    await g.hitP
    client.retryMessage(sent.clientMsgId) // taps while the flush is half way through its re-sign
    await sleep(80)
    g.open()
    await waitFor(() => fromApp('message').length >= 1, 6000, 'sent')
    await sleep(200)
    expect(await rows()).toHaveLength(1)
  })
})

describe('a message from an older build, which did not record when it was written', () => {
  it('keeps counting from when it was signed, not from the first resend', async () => {
    skew = -6.5 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'from the old build' })
    const signedAt = Date.now() + skew
    const [row] = await rows()
    if (!row) throw new Error('no row')
    const { writtenAt: _w, ...legacy } = row
    await storage.put('outbox', row.id, legacy)
    skew = 0
    relay.swallowAcks = true // the row stays: it is never acked
    await reopen()
    await waitFor(() => fromApp('message').length === 1, 6000, 'sent once')
    await sleep(100)
    const [after] = await rows()
    expect(typeof after?.writtenAt).toBe('number')
    expect(Math.abs((after?.writtenAt as number) - signedAt)).toBeLessThan(DAY) // not "now"

    client.close()
    skew = 1.5 * DAY // eight days since it was signed: the Mac and the relay have forgotten its id
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'retry', 6000, 'held for the owner')
    expect(fromApp('message')).toHaveLength(1)
  })
})

describe('a failed save of the written mark', () => {
  it('still sends the message soon, without waiting for a reconnect', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    let failed = false
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number' && !failed) {
        failed = true
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
    }
    const res = await client.sendMessage({ threadId: 'general', text: 'try me again' })
    expect(res.state).toBe('queued')
    await waitFor(() => fromApp('message').length === 1, 4000, 'sent by itself')
  })
})

describe('a voice note that waited past what the relay keeps', () => {
  it('is not sent pointing at deleted audio: it shows as failed and stays to be discarded', async () => {
    skew = -8 * DAY
    const sent = await client.sendVoiceNote({ threadId: 'general', attachment: voiceAtt() })
    skew = 0
    await reopen()
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'final', 6000, 'shown as failed')
    await sleep(100)
    expect(fromApp('voice_note')).toHaveLength(0)
    expect(await rows()).toHaveLength(1) // still there, so the owner can see it and discard it
    const system = Object.values(client.store.getState().messages)
      .flat()
      .filter((m) => m.author === 'system')
    expect(system.some((m) => /voice note/i.test(m.text ?? ''))).toBe(true)
  })
})

const webm = (name = 'v.webm') => ({
  threadId: 'general',
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
  name,
})
async function goOnline(voiceRetryMs?: number) {
  online = true
  await reopen(voiceRetryMs)
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
}
const failedAs = (id: string) => client.meta.getState().failed[id]
const sentOrder = (thread = 'general') =>
  relay.frames
    .filter((f) => f.direction === 'from_app' && (f.raw.type === 'voice_note' || f.raw.type === 'message'))
    .filter((f) => f.raw.thread_id === thread)
    .map((f) => String(f.raw.type))

describe('a voice note whose upload fails for a little while', () => {
  it('holds the text sent after it in the same thread, and sends both in the order they were made', async () => {
    await goOnline()
    uploadFault = () => (uploads <= 2 ? new Response('{}', { status: 503 }) : undefined) // two refusals, then fine
    await client.queueVoiceNote(webm())
    await client.sendMessage({ threadId: 'general', text: 'after the voice note' })
    await client.sendMessage({ threadId: 'other', text: 'another thread is free to go' })
    await waitFor(() => fromApp('message').some((f) => f.raw.thread_id === 'other'), 4000, 'other thread sent')
    await waitFor(() => uploads >= 2, 4000, 'a second try')
    expect(fromApp('message').filter((f) => f.raw.thread_id === 'general')).toHaveLength(0)

    await waitFor(() => fromApp('voice_note').length === 1 && fromApp('message').length === 2, 6000, 'all sent')
    expect(sentOrder()).toEqual(['voice_note', 'message'])
  })
})

describe('voice notes queued while another one is uploading', () => {
  it('are uploaded too, and the text typed meanwhile follows them in order', async () => {
    await goOnline(600_000) // no timed retry: the running flush itself has to pick the second note up
    const g = gate()
    let firstWhenSecondUploads: number | null | undefined = -1
    uploadFault = async (name) => {
      if (name === 'a.webm') {
        g.hit()
        await g.wait
      }
      if (name === 'b.webm') firstWhenSecondUploads = (await rows()).find((r) => r.kind === 'voice_note')?.writtenAt
      return undefined
    }
    await client.queueVoiceNote(webm('a.webm'))
    await g.hitP // the first upload is in flight, the flush is running
    await client.queueVoiceNote(webm('b.webm'))
    const typed = await client.sendMessage({ threadId: 'general', text: 'typed meanwhile' })
    expect(typed.state).toBe('queued')
    g.open()
    await waitFor(() => fromApp('voice_note').length === 2 && fromApp('message').length === 1, 6000, 'all sent')
    expect(sentOrder()).toEqual(['voice_note', 'voice_note', 'message'])
    // The same flush read the queue again: the second note was uploaded before the first one was written. A flush that
    // only ran a second time afterwards would find the first one already written (a number).
    expect(firstWhenSecondUploads).toBeNull()
  })
})

describe('a voice note that was stored but not yet written to the socket', () => {
  it('is not overtaken by text typed in that moment', async () => {
    await goOnline()
    let typed = false
    hooks.afterDel = async (s) => {
      if (s !== 'blobs' || typed) return
      typed = true // the note has left the voice queue and sits in the outbox, unwritten
      await client.sendMessage({ threadId: 'general', text: 'typed in between' })
    }
    await client.queueVoiceNote(webm())
    await waitFor(() => fromApp('voice_note').length === 1 && fromApp('message').length === 1, 6000, 'both sent')
    expect(sentOrder()).toEqual(['voice_note', 'message'])
  })
})

describe('text typed while a voice note is being written to the socket', () => {
  it('is sent right after it, without waiting for a reconnect', async () => {
    await goOnline()
    let typed = false
    hooks.beforePut = async (s, _k, v) => {
      if (s !== 'outbox' || typed || (v as Row & { kind: string }).kind !== 'voice_note') return
      if (typeof (v as Row).writtenAt !== 'number') return
      typed = true // the note's written mark is being saved: its frame is not on the socket yet
      const res = await client.sendMessage({ threadId: 'general', text: 'typed while it was written' })
      expect(res.state).toBe('queued')
    }
    await client.queueVoiceNote(webm())
    await waitFor(() => fromApp('voice_note').length === 1 && fromApp('message').length === 1, 6000, 'both sent')
    expect(sentOrder()).toEqual(['voice_note', 'message'])
  })
})

describe('a voice note that cannot be uploaded', () => {
  const faults: Array<[string, () => Response]> = [
    ['the relay refuses with 503', () => new Response('{}', { status: 503 })],
    ['the daily upload budget is used up (429)', () => new Response('{}', { status: 429 })],
    [
      'the network drops the request',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
  ]

  it.each(faults)('when %s, it is marked failed after repeated tries and the text goes ahead', async (_n, fault) => {
    await goOnline()
    uploadFault = fault
    const v = await client.queueVoiceNote(webm())
    await client.sendMessage({ threadId: 'general', text: 'sent behind the stuck note' })
    expect(fromApp('message')).toHaveLength(0)
    await waitFor(() => failedAs(v.clientMsgId) === 'retry', 6000, 'marked failed')
    expect(uploads).toBeGreaterThan(1) // one failure is not enough to give up
    await waitFor(() => fromApp('message').length === 1, 4000, 'text released')
    expect(fromApp('voice_note')).toHaveLength(0)
    expect((await storage.all('blobs')).length).toBe(1) // the recording is kept
    const at = uploads
    await sleep(200) // it does not keep trying on its own
    expect(uploads).toBe(at)
  })

  it('on an unreadable recording, is marked failed and keeps the recording', async () => {
    await goOnline()
    const blob = Object.assign(new Blob([new Uint8Array([1])], { type: 'audio/webm' }), {
      arrayBuffer: () => Promise.reject(new DOMException('cannot read', 'NotReadableError')),
    })
    const v = await client.queueVoiceNote({ threadId: 'general', blob, name: 'v.webm' })
    await client.sendMessage({ threadId: 'general', text: 'behind the unreadable one' })
    await waitFor(() => failedAs(v.clientMsgId) === 'retry', 6000, 'marked failed')
    await waitFor(() => fromApp('message').length === 1, 4000, 'text released')
    expect((await storage.all('blobs')).length).toBe(1)
  })

  it('is sent by a tap on retry once uploads work again, and Delete removes the recording', async () => {
    await goOnline()
    uploadFault = () => new Response('{}', { status: 429 })
    const v = await client.queueVoiceNote(webm('retry.webm'))
    const w = await client.queueVoiceNote(webm('delete.webm'))
    await waitFor(() => failedAs(v.clientMsgId) === 'retry' && failedAs(w.clientMsgId) === 'retry', 6000, 'both failed')

    await client.discardMessage(w.clientMsgId)
    expect((await storage.all('blobs')).length).toBe(1)
    expect(failedAs(w.clientMsgId)).toBeUndefined()

    uploadFault = undefined
    client.retryMessage(v.clientMsgId)
    expect(failedAs(v.clientMsgId)).toBeUndefined()
    await waitFor(() => fromApp('voice_note').length === 1, 6000, 'sent after the tap')
    await waitFor(() => client.outboxSize() === 0, 4000, 'queue empty')
    expect((await storage.all('blobs')).length).toBe(0)
  })

  it('does not use up its tries on the texts typed behind it', async () => {
    await goOnline(600_000) // no timed retry within this test: only what the texts themselves set off can try again
    uploadFault = () => new Response('{}', { status: 503 })
    const v = await client.queueVoiceNote(webm())
    await waitFor(() => uploads === 1, 4000, 'first try')
    for (let i = 0; i < 6; i++) await client.sendMessage({ threadId: 'general', text: `typed ${i}` })
    expect(uploads).toBe(1)
    expect(failedAs(v.clientMsgId)).toBeUndefined()
  })

  it('is not tried again by a reconnect once it is marked failed', async () => {
    await goOnline()
    uploadFault = (name) => (name === 'failed.webm' ? new Response('{}', { status: 503 }) : undefined)
    const v = await client.queueVoiceNote(webm('failed.webm'))
    await waitFor(() => failedAs(v.clientMsgId) === 'retry', 6000, 'marked failed')
    const before = uploads
    online = false
    client.reconnect() // the connection is gone
    await client.queueVoiceNote({ ...webm('later.webm'), threadId: 'other' })
    online = true
    client.reconnect() // and back: the flush meets the failed note first, then the new one
    await waitFor(() => fromApp('voice_note').length === 1, 6000, 'the new note sent')
    expect(uploads).toBe(before + 1) // only the new note was uploaded
    expect(failedAs(v.clientMsgId)).toBe('retry')
  })

  it('counts only tries on one connection: a reconnect starts the count again', async () => {
    await goOnline()
    uploadFault = () => new Response('{}', { status: 503 })
    const first = await client.queueVoiceNote(webm('first.webm'))
    await waitFor(() => failedAs(first.clientMsgId) === 'retry', 6000, 'first marked failed')
    const tries = uploads // how many tries one connection allows
    await client.discardMessage(first.clientMsgId)

    const second = await client.queueVoiceNote(webm('second.webm'))
    await waitFor(() => uploads === tries + (tries - 1), 6000, 'one try short of giving up')
    relay.dropApps()
    await waitFor(() => failedAs(second.clientMsgId) === 'retry', 6000, 'second marked failed')
    expect(uploads).toBeGreaterThanOrEqual(tries + (tries - 1) + tries)
  })

  it('does not stop a note in another thread, and does not hold a live call question', async () => {
    uploadFault = (name) => (name === 'stuck.webm' ? new Response('{}', { status: 503 }) : undefined)
    client.close()
    client = make(600_000) // no timed retry here: the other note has to get through in the very flush that meets the stuck one
    await client.start({ pinned: true })
    // Both wait offline, so one flush meets the stuck note first and the other thread's note second
    const stuck = await client.queueVoiceNote(webm('stuck.webm'))
    await client.queueVoiceNote({ ...webm('free.webm'), threadId: 'other' })
    online = true
    client.reconnect()
    await waitFor(() => fromApp('voice_note').some((f) => f.raw.thread_id === 'other'), 4000, 'other thread note sent')
    expect(uploads).toBe(2) // each note tried once
    const ask = {
      voiceSessionId: 'v_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      delegationId: 'dl_1',
      threadId: 'general',
      question: 'what is next?',
      transcriptTail: [],
    }
    expect((await client.sendVoiceAsk(ask)).state).toBe('sent')
    await waitFor(() => fromApp('voice.ask').length === 1, 4000, 'question sent while the note is stuck')
    expect(failedAs(stuck.clientMsgId)).not.toBe('final')
  })

  it('does not hold a live call question that was queued while offline either', async () => {
    uploadFault = () => new Response('{}', { status: 503 })
    client.close()
    client = make(600_000) // no timed retry: the question must not wait for the note to give up
    await client.start({ pinned: true })
    const note = await client.queueVoiceNote(webm()) // offline: waits
    const asked = await client.sendVoiceAsk({
      voiceSessionId: 'v_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      delegationId: 'dl_1',
      threadId: 'general',
      question: 'still there?',
      transcriptTail: [],
    })
    expect(asked.state).toBe('queued')
    online = true
    client.reconnect()
    await waitFor(() => fromApp('voice.ask').length === 1, 4000, 'question sent behind the stuck note')
    expect(failedAs(note.clientMsgId)).toBeUndefined()
  })
})

describe('a voice note written to a socket that was lost with it', () => {
  it('is not overtaken by text typed on the new connection while its flush is busy elsewhere', async () => {
    await goOnline(600_000)
    let marked = false
    hooks.beforePut = (store, _k, v) => {
      if (store === 'outbox' && (v as Row).kind === 'voice_note' && typeof (v as Row).writtenAt === 'number')
        marked = true
    }
    lose = (frame) => frame.includes('"type":"voice_note"') // written, and gone with the socket
    await client.sendVoiceNote({ threadId: 'general', attachment: voiceAtt() })
    await waitFor(() => marked, 4000, 'the note was written')
    online = false
    client.reconnect() // the connection is gone
    lose = undefined
    const g = gate()
    uploadFault = async () => {
      g.hit()
      await g.wait
      return undefined
    }
    await client.queueVoiceNote({ ...webm('other.webm'), threadId: 'other' }) // another thread's note: it keeps the next flush busy before the outbox
    online = true
    client.reconnect()
    await g.hitP // the flush on the new connection is uploading, and has not yet written the lost note again
    const typed = await client.sendMessage({ threadId: 'general', text: 'typed after the reconnect' })
    expect(typed.state).toBe('queued')
    g.open()
    await waitFor(() => sentOrder().length === 2, 6000, 'both on the wire')
    expect(sentOrder()).toEqual(['voice_note', 'message'])
  })
})

describe('a voice note discarded while it is being written', () => {
  it('lets the text typed behind it go out', async () => {
    client.close()
    client = make(600_000)
    await client.start({ pinned: true })
    const note = await client.queueVoiceNote(webm()) // offline
    await client.sendMessage({ threadId: 'general', text: 'behind the note' })
    const g = gate()
    let held = false
    hooks.beforePut = async (store, _k, v) => {
      if (store === 'outbox' && (v as Row).kind === 'voice_note' && typeof (v as Row).writtenAt === 'number' && !held) {
        held = true
        g.hit()
        await g.wait
      }
    }
    online = true
    client.reconnect()
    await g.hitP // the note's written mark is being saved
    const discarded = client.discardMessage(note.clientMsgId)
    g.open()
    await discarded
    await waitFor(() => fromApp('message').length === 1, 6000, 'the text went out')
    expect(fromApp('voice_note')).toHaveLength(0)
  })
})

describe('a session that ended and began again while the queue was flushing', () => {
  it('still sends the voice note that was uploading, on the new connection', async () => {
    await goOnline(40)
    const g = gate()
    uploadFault = async (name) => {
      if (name === 'a.webm') {
        g.hit()
        await g.wait
      }
      return undefined
    }
    await client.queueVoiceNote(webm('a.webm'))
    await g.hitP // the upload is in flight
    client.close({ keepQueue: true }) // the session ran out of time
    uploadFault = undefined
    await client.start({ pinned: true }) // and the owner signed back in
    // `online` is set in the same step that asks for the flush, which finds the old one still running
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online again')
    g.open()
    await waitFor(() => fromApp('voice_note').length === 1, 6000, 'sent')
  })
})

describe('a voice note written a second time on one socket', () => {
  it('is written once when a flush starts while its first write is being saved', async () => {
    await goOnline(600_000)
    let typed = false
    hooks.beforePut = async (store, _k, v) => {
      if (store !== 'outbox' || typed || (v as Row).kind !== 'voice_note' || typeof (v as Row).writtenAt !== 'number')
        return
      typed = true // the first write is part way: the text typed now starts a flush of its own
      await client.sendMessage({ threadId: 'general', text: 'typed while it was written' })
    }
    await client.sendVoiceNote({ threadId: 'general', attachment: voiceAtt() })
    await waitFor(() => fromApp('message').length === 1, 6000, 'the text went out')
    // The text goes out after the note on the same socket, so a second write of the note would already be here.
    expect(fromApp('voice_note')).toHaveLength(1)
  })
})

describe('a voice note that can no longer be sent', () => {
  it('does not hold the text behind it', async () => {
    skew = -8 * DAY // past what the relay keeps: it is shown as failed when the queue is flushed
    const old = await client.sendVoiceNote({ threadId: 'general', attachment: voiceAtt() })
    skew = 0
    await client.sendMessage({ threadId: 'general', text: 'behind the old note' })
    await goOnline()
    await waitFor(() => failedAs(old.clientMsgId) === 'final', 6000, 'the note is shown as failed')
    await waitFor(() => fromApp('message').length === 1, 6000, 'the text went out')
    expect(fromApp('voice_note')).toHaveLength(0)
  })
})

describe('the tries a voice note gets', () => {
  it('are three in a row, and a tap on retry gives it three more', async () => {
    await goOnline()
    uploadFault = () => new Response('{}', { status: 503 })
    const note = await client.queueVoiceNote(webm())
    await waitFor(() => failedAs(note.clientMsgId) === 'retry', 6000, 'marked failed')
    expect(uploads).toBe(3)
    client.retryMessage(note.clientMsgId)
    await waitFor(() => failedAs(note.clientMsgId) === 'retry', 6000, 'marked failed again')
    expect(uploads).toBe(6)
  })

  it('go on after the client is closed and started again', async () => {
    await goOnline()
    uploadFault = () => new Response('{}', { status: 503 })
    const note = await client.queueVoiceNote(webm())
    await waitFor(() => uploads === 1, 4000, 'first try')
    client.close({ keepQueue: true }) // with a timed retry waiting
    await client.start({ pinned: true })
    await waitFor(() => failedAs(note.clientMsgId) === 'retry', 6000, 'marked failed after the restart')
  })
})
