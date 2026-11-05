// D4: an attachment must outlive the file the agent named. `upload` keeps its own copy in the media folder, `media.fetch`
// re-uploads from it after the agent's temp file is gone, and retention follows the history window, not 7 days.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../src/config.ts'
import { MediaStore } from '../src/media.ts'
import { pruneTtsFiles, TTS_KEEP_MS } from '../src/tts.ts'
import { tempHome } from './helpers.ts'

const DAY = 24 * 3600_000
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(writeCopy?: (path: string, bytes: Uint8Array, mode: number) => void) {
  const base = realpathSync(tempHome('talos-last-'))
  dirs.push(base)
  const home = join(base, 'home')
  const p = paths(home)
  mkdirSync(p.media, { recursive: true })
  const sent: { id: string; bytes: Uint8Array }[] = []
  const warnings = { msgs: [] as string[], log: { warn: (m: string) => void warnings.msgs.push(m) } as never }
  const store = new MediaStore(
    p,
    {
      putMedia: async (id: string, bytes: Uint8Array) => void sent.push({ id, bytes }),
    } as never,
    warnings.log,
    writeCopy,
  )
  return { base, p, store, sent, warnings }
}

describe('upload keeps its own copy', () => {
  test('a temp file deleted before the relay buffer ends can still be re-uploaded by media.fetch', async () => {
    const { base, p, store, sent } = setup()
    const tmp = join(base, 'report.csv')
    writeFileSync(tmp, 'a,b\n1,2\n')
    const ref = await store.upload(tmp)
    sent.length = 0
    rmSync(tmp) // the agent's temp dir is cleaned long before day 7
    expect(await store.rehydrate(ref.media_id)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]?.bytes ?? []).toString()).toBe('a,b\n1,2\n')
    expect(readdirSync(p.media).some((f) => f.startsWith('up-') && f.endsWith('.csv'))).toBe(true)
  })

  test('an edit to the original after the send does not change what comes back (the sha still matches)', async () => {
    const { base, store, sent } = setup()
    const tmp = join(base, 'a.txt')
    writeFileSync(tmp, 'v1')
    const ref = await store.upload(tmp)
    sent.length = 0
    writeFileSync(tmp, 'v2 edited later')
    expect(await store.rehydrate(ref.media_id)).toBe(true)
    expect(Buffer.from(sent[0]?.bytes ?? []).toString()).toBe('v1')
  })

  test('a file already in the media folder is its own copy: no second one', async () => {
    const { p, store } = setup()
    const own = join(p.media, 'tts-x.m4a')
    writeFileSync(own, 'audio')
    await store.upload(own)
    expect(readdirSync(p.media).filter((f) => f.startsWith('up-'))).toEqual([])
  })

  test('the copy is private (0600)', async () => {
    const { base, p, store } = setup()
    const tmp = join(base, 'k.txt')
    writeFileSync(tmp, 'x')
    await store.upload(tmp)
    const f = readdirSync(p.media).find((n) => n.startsWith('up-')) as string
    expect(statSync(join(p.media, f)).mode & 0o777).toBe(0o600)
  })
})

describe('the kept copy is best effort', () => {
  test('a full disk while copying does not turn a delivered send into a failure; the sidecar keeps the original path', async () => {
    const { base, store, sent, warnings } = setup(() => {
      throw new Error('ENOSPC')
    })
    const tmp = join(base, 'big.zip')
    writeFileSync(tmp, 'zipzip')
    const ref = await store.upload(tmp) // must not throw: the relay already has the bytes
    expect(sent).toHaveLength(1)
    expect(warnings.msgs).toEqual(['kept copy not written'])
    sent.length = 0
    expect(await store.rehydrate(ref.media_id)).toBe(true) // still works while the original is there
  })
})

describe('rehydrating old files', () => {
  test('a second ask for a file already going up joins the first: one PUT, not two', async () => {
    const { base, p, sent } = setup()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let puts = 0
    const store = new MediaStore(p, {
      putMedia: async (id: string, bytes: Uint8Array) => {
        puts++
        await gate
        sent.push({ id, bytes })
      },
    } as never)
    const tmp = join(base, 'a.txt')
    writeFileSync(tmp, 'a')
    const first = store.upload(tmp)
    release()
    const ref = await first
    puts = 0
    let release2: () => void = () => {}
    const gate2 = new Promise<void>((r) => (release2 = r))
    const slow = new MediaStore(p, {
      putMedia: async () => {
        puts++
        await gate2
      },
    } as never)
    const a = slow.rehydrate(ref.media_id)
    const b = slow.rehydrate(ref.media_id)
    release2()
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(puts).toBe(1)
  })

  test('at most two old files go up at once; the rest wait their turn', async () => {
    const { base, p } = setup()
    const seed = new MediaStore(p, { putMedia: async () => {} } as never)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const f = join(base, `f${i}.txt`)
      writeFileSync(f, `file ${i}`)
      ids.push((await seed.upload(f)).media_id)
    }
    let active = 0
    let peak = 0
    const store = new MediaStore(p, {
      putMedia: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
      },
    } as never)
    expect(await Promise.all(ids.map((id) => store.rehydrate(id)))).toEqual([true, true, true, true, true])
    expect(peak).toBe(2)
  })
})

describe('retention follows the history window', () => {
  const age = (path: string, days: number) => {
    const t = new Date(Date.now() - days * DAY)
    utimesSync(path, t, t)
  }
  test('8-day-old audio and upload copies survive a 90-day window; 100-day-old ones go; other files stay', () => {
    const dir = tempHome()
    dirs.push(dir)
    for (const f of ['tts-8.m4a', 'up-8.zip', 'tts-100.m4a', 'up-100.zip', 'md_download.png'])
      writeFileSync(join(dir, f), 'x')
    age(join(dir, 'tts-8.m4a'), 8)
    age(join(dir, 'up-8.zip'), 8)
    age(join(dir, 'tts-100.m4a'), 100)
    age(join(dir, 'up-100.zip'), 100)
    age(join(dir, 'md_download.png'), 100)
    expect(pruneTtsFiles(dir, Date.now(), 90 * DAY)).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['md_download.png', 'tts-8.m4a', 'up-8.zip'])
  })

  test('history kept forever (keep = Infinity) deletes nothing', () => {
    const dir = tempHome()
    dirs.push(dir)
    writeFileSync(join(dir, 'up-old.zip'), 'x')
    age(join(dir, 'up-old.zip'), 4000)
    expect(pruneTtsFiles(dir, Date.now(), Number.POSITIVE_INFINITY)).toBe(0)
    expect(existsSync(join(dir, 'up-old.zip'))).toBe(true)
  })

  test('the default window is still the old 7 days when a caller passes none', () => {
    const dir = tempHome()
    dirs.push(dir)
    writeFileSync(join(dir, 'tts-a.mp3'), 'x')
    age(join(dir, 'tts-a.mp3'), TTS_KEEP_MS / DAY + 1)
    expect(pruneTtsFiles(dir, Date.now())).toBe(1)
  })
})
