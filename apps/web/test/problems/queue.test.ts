import { newUlid, type ProblemT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { OWNER_QUEUE_MAX, type PostResult, ProblemQueue, QUEUE_MAX } from '../../src/features/problems/queue.ts'
import { TalosClientError } from '../../src/lib/client.ts'
import { HttpError } from '../../src/lib/http.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { countUnsent, discardUnsent } from '../../src/lib/unsent.ts'

function problem(over: Partial<ProblemT> = {}): ProblemT {
  return {
    id: newUlid(),
    source: 'web',
    kind: 'auto',
    fingerprint: 'a'.repeat(32),
    at: '2026-11-02T10:00:00.000Z',
    name: 'TypeError',
    message: 'x is not a function',
    frames: [],
    versions: { app: '1.2.3' },
    device: 'browser',
    routes: [],
    truncated: false,
    ...over,
  }
}
const ref = {
  media_id: `md_${'0'.repeat(26)}`,
  kind: 'image',
  role: 'attachment',
  mime: 'image/png',
  name: 's.png',
  size: 3,
  sha256: 'a'.repeat(64),
} as const
const upload = async () => ({ ...ref })
const shot = { type: 'image/png', name: 's.png', bytes: new Uint8Array([1, 2, 3]).buffer }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('ProblemQueue.flush', () => {
  it('offline: everything stays; back online: everything goes, in order, once', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const a = problem()
    const b = problem()
    await q.add(a, 1)
    await q.add(b, 2)
    let online = false
    const sent: string[] = []
    const post = async (p: ProblemT): Promise<PostResult> => {
      if (!online) return { ok: false, network: true }
      sent.push(p.id)
      return { ok: true }
    }
    const off = await q.flush({ post, upload })
    expect(off).toMatchObject({ sent: 0, kept: 2, stopped: 'offline' })
    expect(await q.size()).toBe(2)
    online = true
    const on = await q.flush({ post, upload })
    expect(on).toMatchObject({ sent: 2, kept: 0 })
    expect(sent).toEqual([a.id, b.id])
    expect(await q.size()).toBe(0)
  })

  it('a 429 stops the run and keeps the rest', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    for (let i = 0; i < 3; i++) await q.add(problem(), i)
    let n = 0
    const r = await q.flush({
      post: async () => (n++ === 0 ? { ok: true } : { ok: false, status: 429 }),
      upload,
    })
    expect(r).toMatchObject({ sent: 1, kept: 2, stopped: 'rate' })
    expect(await q.size()).toBe(2)
  })

  it('names the reports a 400 removed, also when the flush that removed them was joined', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const bad = problem()
    const good = problem()
    await q.add(bad, 1)
    const started = deferred()
    const release = deferred()
    const post = async (p: ProblemT): Promise<PostResult> => {
      if (p.id === bad.id) {
        started.resolve()
        await release.promise
        return { ok: false, status: 400 }
      }
      return { ok: true }
    }
    const first = q.flush({ post, upload })
    await started.promise
    await q.add(good, 2)
    const joined = q.flush({ post, upload })
    release.resolve()
    const r = await joined
    await first
    expect(r.rejectedIds).toEqual([bad.id])
    expect(r.rejected).toBe(1)
    expect(r.sent).toBe(1)
  })

  it('a 400 removes that one report (it will never be accepted) and the rest still go', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const bad = problem()
    await q.add(bad, 1)
    await q.add(problem(), 2)
    const r = await q.flush({
      post: async (p) => (p.id === bad.id ? { ok: false, status: 400 } : { ok: true }),
      upload,
    })
    expect(r).toMatchObject({ sent: 1, rejected: 1, kept: 0 })
    expect(await q.size()).toBe(0)
  })

  it('401, 403 and 5xx keep everything and say why', async () => {
    for (const [status, why] of [
      [401, 'auth'],
      [403, 'auth'],
      [503, 'server'],
    ] as const) {
      const q = new ProblemQueue(createMemoryStorage())
      await q.add(problem(), 1)
      const r = await q.flush({ post: async () => ({ ok: false, status }), upload })
      expect(r).toMatchObject({ sent: 0, kept: 1, stopped: why })
      expect(await q.size()).toBe(1)
    }
  })

  it('two flushes at once are one run: each report is posted once', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    for (let i = 0; i < 3; i++) await q.add(problem(), i)
    const posted: string[] = []
    const post = async (p: ProblemT): Promise<PostResult> => {
      posted.push(p.id)
      await new Promise((r) => setTimeout(r, 5))
      return { ok: true }
    }
    const [x, y] = await Promise.all([q.flush({ post, upload }), q.flush({ post, upload })])
    expect(posted).toHaveLength(3)
    expect(y.sent).toBe(x.sent) // the second call reports the run it waited for
  })

  it('a flush that joins a running one still sends the report added while that one ran', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const a = problem()
    const b = problem()
    await q.add(a, 1)
    const started = deferred()
    const release = deferred()
    const posted: string[] = []
    const post = async (p: ProblemT): Promise<PostResult> => {
      posted.push(p.id)
      if (p.id === a.id) {
        started.resolve()
        await release.promise
      }
      return { ok: true }
    }
    const first = q.flush({ post, upload })
    await started.promise // the first run has read its list: b is not on it
    await q.add(b, 2)
    const joined = q.flush({ post, upload })
    release.resolve()
    await first
    const r = await joined
    expect(posted).toEqual([a.id, b.id])
    expect(r.stopped).toBeUndefined()
    expect(await q.size()).toBe(0) // "sent" means this report went, not the one before it
  })

  it('a flush that joins a run that then throws tries again itself, so the new report is still sent', async () => {
    const base = createMemoryStorage()
    let failDeletes = 1 // the first run's one delete fails
    const storage = {
      ...base,
      async del(name: never, key: string) {
        if (failDeletes-- > 0) throw new Error('storage refused')
        return base.del(name, key)
      },
    }
    const q = new ProblemQueue(storage as never)
    const a = problem()
    const b = problem()
    await q.add(a, 1)
    const started = deferred()
    const release = deferred()
    const posted: string[] = []
    const post = async (p: ProblemT): Promise<PostResult> => {
      posted.push(p.id)
      if (p.id === a.id && posted.length === 1) {
        started.resolve()
        await release.promise
      }
      return { ok: true }
    }
    const first = q.flush({ post, upload })
    await started.promise
    await q.add(b, 2)
    const joined = q.flush({ post, upload })
    release.resolve()
    await expect(first).rejects.toThrow('storage refused')
    const r = await joined // does not throw with it
    expect(r.stopped).toBeUndefined()
    expect(posted).toContain(b.id)
    expect(await q.size()).toBe(0)
  })

  it('a flush that joins a run that was fine but whose own second run stops reports that stop and both counts', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const a = problem()
    const b = problem()
    await q.add(a, 1)
    const started = deferred()
    const release = deferred()
    const post = async (p: ProblemT): Promise<PostResult> => {
      if (p.id === a.id) {
        started.resolve()
        await release.promise
        return { ok: true }
      }
      return { ok: false, network: true }
    }
    const first = q.flush({ post, upload })
    await started.promise
    await q.add(b, 2)
    const joined = q.flush({ post, upload })
    release.resolve()
    await first
    expect(await joined).toMatchObject({ sent: 1, kept: 1, stopped: 'offline' })
    expect(await q.size()).toBe(1)
  })

  it('a flush that joins a run that then stops reports the stop, and the new report stays', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    await q.add(problem(), 1)
    const started = deferred()
    const release = deferred()
    const post = async (): Promise<PostResult> => {
      started.resolve()
      await release.promise
      return { ok: false, network: true }
    }
    const first = q.flush({ post, upload })
    await started.promise
    await q.add(problem(), 2)
    const joined = q.flush({ post, upload })
    release.resolve()
    await first
    expect(await joined).toMatchObject({ sent: 0, stopped: 'offline' })
    expect(await q.size()).toBe(2)
  })

  it('a screenshot is uploaded first and its reference goes in the report; a failed upload keeps the whole row', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    const p = problem({ kind: 'owner', steps: 'look' })
    await q.add(p, 1, { type: 'image/png', name: 's.png', bytes: new Uint8Array([1, 2, 3]).buffer })
    const seen: Array<ProblemT['screenshot']> = []
    const down = await q.flush({
      post: async () => ({ ok: true }),
      upload: async () => {
        throw new Error('offline')
      },
    })
    expect(down).toMatchObject({ sent: 0, kept: 1, stopped: 'offline' })
    expect(await q.size()).toBe(1)
    const up = await q.flush({
      post: async (x) => {
        seen.push(x.screenshot)
        return { ok: true }
      },
      upload,
    })
    expect(up.sent).toBe(1)
    expect(seen[0]?.media_id).toBe(ref.media_id)
  })

  it.each([
    ['no network', new TypeError('Failed to fetch'), 'offline'],
    ['signed out', new HttpError(401), 'auth'],
    ['forbidden', new HttpError(403), 'auth'],
    ['upload budget spent', new HttpError(429), 'rate'],
    ['server error', new HttpError(503), 'server'],
    ['the Mac is out of disk', new HttpError(507), 'server'],
  ] as const)('a picture that cannot be uploaded (%s) keeps the row and says why', async (_name, error, why) => {
    const q = new ProblemQueue(createMemoryStorage())
    await q.add(problem({ kind: 'owner' }), 1, shot)
    let posted = 0
    const r = await q.flush({
      post: async () => {
        posted++
        return { ok: true }
      },
      upload: async () => {
        throw error
      },
    })
    expect(r).toMatchObject({ sent: 0, kept: 1, rejected: 0, stopped: why })
    expect(posted).toBe(0)
    expect(await q.size()).toBe(1)
  })

  it.each([
    ['refused as bad', new HttpError(400)],
    ['too big', new HttpError(413)],
    ['not a supported type', new HttpError(415)],
    ['too big before it left', new TalosClientError('too_large', 'Too big to send (max 50 MB).')],
  ] as const)(
    'a picture that can never be uploaded (%s) is dropped and the words go without it, marked shortened',
    async (_name, error) => {
      const q = new ProblemQueue(createMemoryStorage())
      await q.add(problem({ kind: 'owner', steps: 'the words' }), 1, shot)
      await q.add(problem(), 2)
      const posted: ProblemT[] = []
      const r = await q.flush({
        post: async (p) => {
          posted.push(p)
          return { ok: true }
        },
        upload: async () => {
          throw error
        },
      })
      expect(r).toMatchObject({ sent: 2, kept: 0, rejected: 0 })
      expect(r.stopped).toBeUndefined()
      expect(posted[0]).toMatchObject({ steps: 'the words', truncated: true })
      expect(posted[0]?.screenshot).toBeUndefined()
      expect(posted[1]?.truncated).toBe(false) // a report with no picture is not marked
      expect(await q.size()).toBe(0)
    },
  )

  it('an upload answer that is not an image is not attached: the words go without it', async () => {
    // a text file named .png is stored as a file; the report schema accepts only an image as the screenshot
    const q = new ProblemQueue(createMemoryStorage())
    await q.add(problem({ kind: 'owner', steps: 'the words' }), 1, shot)
    const posted: ProblemT[] = []
    const r = await q.flush({
      post: async (p) => {
        posted.push(p)
        return { ok: true }
      },
      upload: async () => ({ ...ref, kind: 'file' as const }),
    })
    expect(r).toMatchObject({ sent: 1, rejected: 0 })
    expect(posted[0]?.screenshot).toBeUndefined()
    expect(posted[0]).toMatchObject({ steps: 'the words', truncated: true })
  })

  it('a report that has to be tried again uploads its picture again, and the row always stays visible', async () => {
    // The server removes uploaded media after a while, so a stored reference could not be trusted: each try uploads.
    const storage = createMemoryStorage()
    const q = new ProblemQueue(storage)
    await q.add(problem({ kind: 'owner' }), 1, shot)
    let uploads = 0
    const counted = async () => {
      uploads++
      return { ...ref }
    }
    const down = await q.flush({ post: async () => ({ ok: false, network: true }), upload: counted })
    expect(down).toMatchObject({ stopped: 'offline', kept: 1 })
    expect(await q.size()).toBe((await storage.all('problems')).length)
    const sent = await q.flush({ post: async () => ({ ok: true }), upload: counted })
    expect(sent.sent).toBe(1)
    expect(uploads).toBe(2)
    expect((await storage.all('problems')).length).toBe(0)
  })

  it('a wipe that lands while the picture uploads is not undone by the flush', async () => {
    const storage = createMemoryStorage()
    const q = new ProblemQueue(storage)
    await q.add(problem({ kind: 'owner' }), 1, shot)
    const started = deferred()
    const release = deferred()
    const run = q.flush({
      post: async () => ({ ok: false, network: true }),
      upload: async () => {
        started.resolve()
        await release.promise
        return { ...ref }
      },
    })
    await started.promise
    await clearLocalData(storage) // sign-out
    release.resolve()
    await run
    expect(await q.size()).toBe(0)
  })

  it('stays short: the oldest automatic report goes past the cap and is counted; owner reports are kept to the newest five', async () => {
    const q = new ProblemQueue(createMemoryStorage())
    for (let i = 0; i < QUEUE_MAX + 3; i++) await q.add(problem({ message: `m${i}` }), i)
    expect(await q.size()).toBe(QUEUE_MAX)
    expect(q.dropped).toBe(3)
    const q2 = new ProblemQueue(createMemoryStorage())
    for (let i = 0; i < OWNER_QUEUE_MAX + 2; i++) await q2.add(problem({ kind: 'owner', steps: `s${i}` }), i)
    const rows = await q2.rows()
    expect(rows).toHaveLength(OWNER_QUEUE_MAX)
    expect(rows[0]?.problem.steps).toBe('s2')
  })

  it('ignores a row that is not a valid problem instead of sending it', async () => {
    const storage = createMemoryStorage()
    await storage.put('problems', 'junk', { problem: { id: 'nope' }, queued_at: 1 })
    const q = new ProblemQueue(storage)
    expect(await q.size()).toBe(0)
  })
})

describe('what sign-out and revoke do with queued reports', () => {
  it('queued reports do not change the unsent count, and discardUnsent and clearLocalData remove them', async () => {
    const storage = createMemoryStorage()
    const q = new ProblemQueue(storage)
    await q.add(problem(), 1)
    await q.add(problem({ kind: 'owner', steps: 'x' }), 2, {
      type: 'image/png',
      name: 's.png',
      bytes: new ArrayBuffer(4),
    })
    expect(await countUnsent(storage)).toEqual({ sendable: 0, other: 0 })
    await discardUnsent(storage)
    expect(await q.size()).toBe(0)
    await q.add(problem(), 3)
    await clearLocalData(storage, { keepUnsent: false })
    expect(await q.size()).toBe(0)
  })

  it('a session that only ran out of time keeps them, like the unsent messages', async () => {
    const storage = createMemoryStorage()
    const q = new ProblemQueue(storage)
    await q.add(problem(), 1)
    await clearLocalData(storage, { keepUnsent: true })
    expect(await q.size()).toBe(1)
  })
})
