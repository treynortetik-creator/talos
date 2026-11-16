// The Files pane's fence (src/files/service.ts): a read-only look at ONE thread's folder. The real path of anything listed or
// read stays inside that folder (a link that leaves is refused, one that stays is followed), hidden names (dot-names, so
// .env* and .git, and node_modules) are never shown or opened at any depth, only plain folders and files are touched, and a
// read is capped. Every case runs in a temp folder with made-up files.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILES_WORDING, MAX_FRAME_BYTES } from '@talos-app/protocol'
import { FilesService } from '../src/files/service.ts'
import { openSeam } from '../src/safe-open.ts'
import { ReadError } from '../src/v2-seams.ts'

/**
 * Where the test folders go: /tmp, not TMPDIR. A CI run's TMPDIR sits under ~/.cache (a hidden folder), and a thread folder
 * inside a hidden folder is refused by design, which made every case fail there.
 */
const base = () => (process.platform === 'win32' ? tmpdir() : realpathSync('/tmp'))

let top: string
let root: string
let outside: string
let guarded: string
let uploads: Array<{ bytes: Uint8Array; name: string; mime: string }>
let svc: FilesService

const T = 'th-work'
/** The service's UPLOAD_MS (src/files/service.ts): the limit on one image upload. */
const UPLOAD_MS_IN_TEST = 30_000

/** Timers the test fires by hand: each set one is kept with its limit until it is fired or cleared. */
function fakeTimers() {
  type Pending = { fn: () => void; ms: number }
  const pending = new Set<Pending>()
  let changed: (() => void) | undefined
  return {
    setTimeout(fn: () => void, ms: number) {
      const t = { fn, ms }
      pending.add(t)
      changed?.()
      return t
    },
    clearTimeout(h: unknown) {
      pending.delete(h as Pending)
    },
    /** Fires (and forgets) every pending timer that `which` picks, all of them by default. */
    fire(which: (t: Pending) => boolean = () => true) {
      for (const t of [...pending].filter(which)) {
        pending.delete(t)
        t.fn()
      }
    },
    /** Resolves once the pending timers meet `cond`: woken by each new timer, never by the clock. */
    until(cond: (t: Pending[]) => boolean) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!cond([...pending])) return
          changed = undefined
          resolve()
        }
        changed = check
        check()
      })
    },
  }
}
const put = (rel: string, body: string | Uint8Array = 'x\n') => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const make = (o: Partial<ConstructorParameters<typeof FilesService>[0]> = {}) =>
  new FilesService({
    rootFor: (id) => (id === T ? root : null),
    refused: [guarded],
    media: {
      uploadBytes: async (bytes, name, mime) => {
        uploads.push({ bytes, name, mime })
        return { media_id: 'md_test', name, mime, size: bytes.length, sha256: '0'.repeat(64), kind: 'image' } as never
      },
    },
    ...o,
  })
const names = async (path: string) => (await svc.list({ thread_id: T, path })).entries.map((e) => `${e.kind}:${e.name}`)
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(ReadError)
  return (e as ReadError).message
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(base(), 'talos-files-')))
  root = join(top, 'project')
  outside = join(top, 'outside')
  guarded = join(root, 'talos-home') // the bridge's own home, if it ever sits inside a thread's folder
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n')
  mkdirSync(join(outside, 'dir'))
  writeFileSync(join(outside, 'dir', 'inner.txt'), 'SECRET\n')
  uploads = []
  svc = make()
})
afterEach(() => {
  openSeam.beforeOpen = undefined
  rmSync(top, { recursive: true, force: true })
})

describe('listing', () => {
  test('folders first, then files, by name, with file sizes; hidden names and node_modules are never listed', async () => {
    put('README.md', '# hi\n')
    put('b.ts', 'export {}\n')
    put('apps/web/x.ts')
    put('docs/a.md')
    for (const h of ['.env', '.env.local', '.git/config', '.ssh/id', 'node_modules/x/index.js', '.DS_Store'])
      put(h, 'SECRET\n')
    expect(await names('')).toEqual(['dir:apps', 'dir:docs', 'file:b.ts', 'file:README.md'])
    const l = await svc.list({ thread_id: T, path: '' })
    expect(l.entries.find((e) => e.name === 'README.md')?.size).toBe(5)
    expect(l.root).toBe(root)
    expect(l.path).toBe('')
    expect(await names('apps')).toEqual(['dir:web'])
    expect(await names('apps/web')).toEqual(['file:x.ts'])
  })

  test('more than the limit: the rest are counted, not sent', async () => {
    svc = make({ listMax: 3 })
    for (let i = 0; i < 5; i++) put(`f${i}.txt`)
    const l = await svc.list({ thread_id: T, path: '' })
    expect(l.entries).toHaveLength(3)
    expect(l.more).toBe(2)
  })

  test('a link that stays inside is followed; one that leaves, or lands on a hidden name, is left out', async () => {
    put('real/a.txt')
    put('.env', 'SECRET\n')
    symlinkSync(join(root, 'real'), join(root, 'inside-dir'))
    symlinkSync(join(root, 'real', 'a.txt'), join(root, 'inside-file.txt'))
    symlinkSync(join(outside, 'dir'), join(root, 'out-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'out-file.txt'))
    symlinkSync(join(root, '.env'), join(root, 'env-link'))
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    expect(await names('')).toEqual(['dir:inside-dir', 'dir:real', 'file:inside-file.txt'])
    expect(await names('inside-dir')).toEqual(['file:a.txt'])
  })

  test("the bridge's own home is never shown, even inside the folder", async () => {
    put('talos-home/keys.json', 'SECRET\n')
    put('ok.txt')
    expect(await names('')).toEqual(['file:ok.txt'])
    expect(await refusal(svc.list({ thread_id: T, path: 'talos-home' }))).toBe(FILES_WORDING.refused)
  })
})

describe('refusals: one sentence, whatever the reason', () => {
  test('paths that climb, are absolute, malformed, hidden, or not a folder', async () => {
    put('a/b.txt')
    put('.git/config', 'SECRET\n')
    put('node_modules/x.js', 'SECRET\n')
    for (const p of [
      '..',
      'a/..',
      'a/../..',
      '/etc',
      '/',
      './a',
      'a//b.txt',
      'a/',
      '.git',
      '.git/config',
      'node_modules',
      'a/\u0000',
      'missing',
      'a/b.txt', // a file, not a folder
    ])
      expect(await refusal(svc.list({ thread_id: T, path: p })), p).toBe(FILES_WORDING.refused)
    for (const p of [
      '..',
      '../outside/secret.txt',
      '/etc/passwd',
      '.env',
      '.git/config',
      'node_modules/x.js',
      'a',
      'missing',
    ])
      expect(await refusal(svc.read({ thread_id: T, path: p, offset: 0 })), p).toBe(FILES_WORDING.refused)
  })

  test('a link that leaves the folder is refused by name too, for list and read, and so is one onto a hidden file', async () => {
    put('.env', 'SECRET\n')
    symlinkSync(join(outside, 'dir'), join(root, 'out-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'out-file.txt'))
    symlinkSync(join(root, '.env'), join(root, 'env-link'))
    expect(await refusal(svc.list({ thread_id: T, path: 'out-dir' }))).toBe(FILES_WORDING.refused)
    expect(await refusal(svc.read({ thread_id: T, path: 'out-dir/inner.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
    expect(await refusal(svc.read({ thread_id: T, path: 'out-file.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
    expect(await refusal(svc.read({ thread_id: T, path: 'env-link', offset: 0 }))).toBe(FILES_WORDING.refused)
  })

  test('a hidden name is refused as asked, even when it is a link to a folder that is shown', async () => {
    put('real/a.txt')
    symlinkSync(join(root, 'real'), join(root, '.alias'))
    symlinkSync(join(root, 'real'), join(root, 'node_modules'))
    for (const p of ['.alias', 'node_modules', 'NODE_MODULES'])
      expect(await refusal(svc.list({ thread_id: T, path: p })), p).toBe(FILES_WORDING.refused)
    for (const p of ['.alias/a.txt', 'node_modules/a.txt'])
      expect(await refusal(svc.read({ thread_id: T, path: p, offset: 0 })), p).toBe(FILES_WORDING.refused)
    expect(await names('')).toEqual(['dir:real'])
  })

  test('a named pipe is not opened (it would hang the bridge)', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')])
    expect(await refusal(svc.read({ thread_id: T, path: 'pipe', offset: 0 }))).toBe(FILES_WORDING.refused)
    expect(await names('')).toEqual([])
  })

  test('an unknown thread, or a folder that is gone, says so', async () => {
    expect(await refusal(svc.list({ thread_id: 'th-nobody', path: '' }))).toBe(FILES_WORDING.noFolder)
    rmSync(root, { recursive: true })
    expect(await refusal(svc.list({ thread_id: T, path: '' }))).toBe(FILES_WORDING.noFolder)
  })

  test('a folder swapped for a link out between the check and the open is not followed', async () => {
    put('sub/a.txt', 'fine\n')
    openSeam.beforeOpen = (p) => {
      if (!p.endsWith('a.txt')) return
      renameSync(join(root, 'sub'), join(root, 'sub-was'))
      symlinkSync(join(outside, 'dir'), join(root, 'sub'))
      renameSync(join(outside, 'dir', 'inner.txt'), join(outside, 'dir', 'a.txt'))
    }
    expect(await refusal(svc.read({ thread_id: T, path: 'sub/a.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
  })
})

describe('the review of 2026-11-11: what the first version let through', () => {
  test('a hard link, to a file outside or to .env inside, is neither listed nor read', async () => {
    put('.env', 'ENVSECRET\n')
    put('plain.txt', 'fine\n')
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    linkSync(join(root, '.env'), join(root, 'envcopy.txt'))
    expect(await names('')).toEqual(['file:plain.txt'])
    for (const p of ['hard.txt', 'envcopy.txt'])
      expect(await refusal(svc.read({ thread_id: T, path: p, offset: 0 })), p).toBe(FILES_WORDING.refused)
  })

  test('a thread folder that is a dot-folder, or under one, or inside a refused root, shows nothing', async () => {
    const dot = join(top, '.config')
    mkdirSync(join(dot, 'tool'), { recursive: true })
    writeFileSync(join(dot, 'tool', 'token.conf'), 'SECRET\n')
    for (const r of [dot, join(dot, 'tool'), guarded]) {
      mkdirSync(r, { recursive: true })
      svc = make({ rootFor: () => r })
      expect(await refusal(svc.list({ thread_id: T, path: '' })), r).toBe(FILES_WORDING.hiddenRoot)
      expect(await refusal(svc.read({ thread_id: T, path: 'tool/token.conf', offset: 0 })), r).toBe(
        FILES_WORDING.hiddenRoot,
      )
    }
  })

  test('a thread folder reached through a link is shown (its real path is what is fenced)', async () => {
    put('docs/a.md', '# A\n')
    const link = join(top, 'linked-root')
    symlinkSync(root, link)
    svc = make({ rootFor: () => link })
    expect(await names('')).toEqual(['dir:docs'])
    expect((await svc.read({ thread_id: T, path: 'docs/a.md', offset: 0 })).text).toBe('# A\n')
  })

  test.if(process.platform === 'darwin')(
    'a thread folder under /var/folders (reached as /private/var) is shown',
    async () => {
      const dir = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim()
      if (dir.split('/').some((p) => p.startsWith('.'))) return // a temp folder that is itself hidden cannot be a root
      const r = mkdtempSync(join(dir, 'talos-files-var-'))
      try {
        writeFileSync(join(r, 'a.txt'), 'fine\n')
        svc = make({ rootFor: () => r.replace(/^\/private/, '') })
        expect((await svc.list({ thread_id: T, path: '' })).entries.map((e) => e.name)).toEqual(['a.txt'])
      } finally {
        rmSync(r, { recursive: true, force: true })
      }
    },
  )

  test('inside a refused root, a locked folder and a missing one get the same answer: no oracle', async () => {
    mkdirSync(join(guarded, 'locked'), { recursive: true })
    chmodSync(join(guarded, 'locked'), 0o000)
    try {
      const a = await refusal(svc.read({ thread_id: T, path: 'talos-home/locked/x', offset: 0 }))
      const b = await refusal(svc.read({ thread_id: T, path: 'talos-home/missing/x', offset: 0 }))
      expect(a).toBe(FILES_WORDING.refused)
      expect(b).toBe(a)
      // and through a link that points there
      symlinkSync(join(guarded, 'locked', 'x'), join(root, 'to-locked'))
      expect(await refusal(svc.read({ thread_id: T, path: 'to-locked', offset: 0 }))).toBe(FILES_WORDING.refused)
    } finally {
      chmodSync(join(guarded, 'locked'), 0o755)
    }
  })

  test('an answer that timed out uploads nothing afterwards', async () => {
    put('shot.png', Buffer.from('89504e470d0a1a0a', 'hex'))
    // The order is made certain, not timed: the time limit's own callback is fired from inside the open, so the limit has run out
    // after the checks and before the file is read, let alone uploaded. (Timed, with a 0 ms limit against a 20 ms busy-wait in the
    // open, the read's disk callbacks could run before the timer under a full run on 2 cores, and the answer came in time.)
    let fire: (() => void) | null = null
    svc = make({
      timers: {
        setTimeout: (fn: () => void) => {
          fire = fn
          return 1
        },
        clearTimeout: () => {},
      },
    })
    openSeam.beforeOpen = () => fire?.()
    expect(await refusal(svc.read({ thread_id: T, path: 'shot.png', offset: 0 }))).toBe(FILES_WORDING.slow)
    // the read goes on past its answer (counted as lingering) until it sees the limit and stops, right before the upload: wait
    // for that in turns of the event loop, not in time, then nothing may have been uploaded
    const lingering = () => (svc as unknown as { lingering: number }).lingering
    for (let i = 0; i < 10_000 && lingering() > 0; i++) await new Promise((r) => setImmediate(r))
    expect(lingering()).toBe(0)
    expect(uploads).toHaveLength(0)
  })

  test('a lead folder keeps what its marker protects out of the pane, and a marker it cannot read refuses everything', async () => {
    put('ok.txt')
    put('private/notes.txt', 'SECRET\n')
    writeFileSync(join(root, '.talos-lead'), JSON.stringify({ protect: [join(root, 'private')] }))
    expect(await names('')).toEqual(['file:ok.txt'])
    expect(await refusal(svc.read({ thread_id: T, path: 'private/notes.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
    writeFileSync(join(root, '.talos-lead'), 'not json')
    expect(await refusal(svc.read({ thread_id: T, path: 'ok.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
  })

  test('a folder of long names is cut to fit one frame, and the rest counted', async () => {
    for (let i = 0; i < 1000; i++) put(`${String(i).padStart(4, '0')}-${'n'.repeat(240)}.txt`, '')
    const l = await svc.list({ thread_id: T, path: '' })
    expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThan(MAX_FRAME_BYTES - 16 * 1024)
    expect(l.entries.length).toBeGreaterThan(100)
    expect(l.entries.length + l.more).toBe(1000)
  })
})

describe('the second look of 2026-11-11', () => {
  test('a named pipe where a lead marker would be is refused at once, never waited on', async () => {
    put('ok.txt')
    execFileSync('mkfifo', [join(root, '.talos-lead')])
    const t = Date.now()
    expect(await refusal(svc.list({ thread_id: T, path: '' }))).toBe(FILES_WORDING.refused)
    expect(await refusal(svc.read({ thread_id: T, path: 'ok.txt', offset: 0 }))).toBe(FILES_WORDING.refused)
    expect(Date.now() - t).toBeLessThan(1000)
  })

  test('uploads that never come back do not shut the pane: each answer gives its slot back', async () => {
    put('shot.png', Buffer.from('89504e470d0a1a0a', 'hex'))
    put('a.txt', 'fine\n')
    // No wall clock: the time limits are fired by hand, once the read is waiting on the upload that never comes back (its
    // own upload timer, UPLOAD_MS, is set then). The read of a.txt fires nothing, so a slow Mac cannot make it "slow".
    const timers = fakeTimers()
    svc = make({ timers, media: { uploadBytes: () => new Promise(() => {}) } })
    for (let i = 0; i < 6; i++) {
      const p = svc.read({ thread_id: T, path: 'shot.png', offset: 0 })
      // this read is waiting on the upload once its own upload timer is set (one per read; none of them fires here, so the
      // work behind every answer stays out, as when uploads hang)
      await timers.until((t) => t.filter((x) => x.ms === UPLOAD_MS_IN_TEST).length === i + 1)
      timers.fire((x) => x.ms !== UPLOAD_MS_IN_TEST) // the answer's limit, not the upload's
      expect(await refusal(p)).toBe(FILES_WORDING.slow)
    }
    expect((await svc.read({ thread_id: T, path: 'a.txt', offset: 0 })).text).toBe('fine\n')
  })

  test('a lead folder inside the thread folder keeps its protected roots out', async () => {
    put('lead/ok.txt')
    put('lead/private/notes.txt', 'SECRET\n')
    writeFileSync(join(root, 'lead', '.talos-lead'), JSON.stringify({ protect: [join(root, 'lead', 'private')] }))
    expect(await names('lead')).toEqual(['file:ok.txt'])
    expect(await refusal(svc.list({ thread_id: T, path: 'lead/private' }))).toBe(FILES_WORDING.refused)
    expect(await refusal(svc.read({ thread_id: T, path: 'lead/private/notes.txt', offset: 0 }))).toBe(
      FILES_WORDING.refused,
    )
  })

  test('a very large folder is listed in part and says so; `more` never counts a hidden name', async () => {
    // the scan cap is the service's own (5000 by default); a small one shows the same rule without thousands of files
    svc = make({ scanMax: 10 })
    for (let i = 0; i < 15; i++) put(`f${String(i).padStart(2, '0')}.txt`, '')
    const big = await svc.list({ thread_id: T, path: '' })
    expect(big.partial).toBe(true)
    expect(big.entries.length).toBeLessThanOrEqual(10)
    expect(big.more).toBe(0) // past the cap nothing is counted: `partial` says there is more
    rmSync(root, { recursive: true })
    mkdirSync(root)
    svc = make({ listMax: 2 })
    for (const n of ['a.txt', 'b.txt', 'c.txt', '.env', '.secret', 'node_modules']) put(n)
    const l = await svc.list({ thread_id: T, path: '' })
    expect(l.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(l.more).toBe(1)
    expect(l.partial).toBeUndefined()
  })
})

describe('reading', () => {
  test('a text file: its text, size and time, in one answer when small', async () => {
    put('docs/a.md', '# Title\n\nbody ✓\n')
    const f = await svc.read({ thread_id: T, path: 'docs/a.md', offset: 0 })
    expect(f).toMatchObject({
      kind: 'text',
      text: '# Title\n\nbody ✓\n',
      offset: 0,
      next_offset: null,
      truncated: false,
    })
    expect(f.size).toBe(Buffer.byteLength('# Title\n\nbody ✓\n'))
    expect(f.mtime).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  test('a long one comes in chunks cut on a character boundary, and stops at the cap with `truncated`', async () => {
    svc = make({ textChunk: 10, textMax: 25 })
    put('long.txt', 'aaaaaaaaa✓bbbbbbbbbbcccccccccc') // the ✓ (3 bytes) straddles byte 10
    const a = await svc.read({ thread_id: T, path: 'long.txt', offset: 0 })
    expect(a.text).toBe('aaaaaaaaa')
    expect(a.next_offset).toBe(9)
    const b = await svc.read({ thread_id: T, path: 'long.txt', offset: 9 })
    expect(b.text).toBe('✓bbbbbbb')
    const c = await svc.read({ thread_id: T, path: 'long.txt', offset: b.next_offset as number })
    expect(c.next_offset).toBeNull()
    expect(c.truncated).toBe(true)
    expect(`${a.text}${b.text}${c.text}`).toBe(Buffer.from('aaaaaaaaa✓bbbbbbbbbbcccccccccc').subarray(0, 25).toString())
  })

  test('every answer fits in a frame, even text that grows six-fold as JSON, and the chunks join back to the file', async () => {
    const body = '\u0001'.repeat(150 * 1024) + 'end'
    put('ctl.txt', body)
    let offset: number | null = 0
    let joined = ''
    let asks = 0
    while (offset !== null && asks++ < 50) {
      const f = await svc.read({ thread_id: T, path: 'ctl.txt', offset })
      expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThan(MAX_FRAME_BYTES - 16 * 1024)
      joined += f.text ?? ''
      offset = f.next_offset ?? null
    }
    expect(joined).toBe(body)
  })

  test('an image is uploaded as an attachment; one over the cap is not, and says why', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    put('shot.png', png)
    const f = await svc.read({ thread_id: T, path: 'shot.png', offset: 0 })
    expect(f.kind).toBe('image')
    expect(f.media?.media_id).toBe('md_test')
    expect(uploads).toHaveLength(1)
    expect(Buffer.from(uploads[0]?.bytes ?? []).equals(png)).toBe(true)
    expect(uploads[0]?.mime).toBe('image/png')
    svc = make({ imageMax: 4 })
    const big = await svc.read({ thread_id: T, path: 'shot.png', offset: 0 })
    expect(big).toMatchObject({ kind: 'image', message: FILES_WORDING.tooBig })
    expect(big.media).toBeUndefined()
    expect(uploads).toHaveLength(1)
  })

  test('a binary file is named as such, with no bytes sent', async () => {
    put('blob.bin', Buffer.from([0, 1, 2, 0, 255, 0]))
    const f = await svc.read({ thread_id: T, path: 'blob.bin', offset: 0 })
    expect(f).toMatchObject({ kind: 'binary', message: FILES_WORDING.binary, truncated: false })
    expect(f.text).toBeUndefined()
  })
})

// Bug hunt (Fable, 2026-11-11), MEDIUM-LOW: an image whose upload outlasted the 3 s answer limit never showed, and each try
// uploaded it again. The upload goes on past a timed-out answer; the same bytes are now uploaded once and reused, so a later
// try shows the preview without a second upload.
describe('an image upload slower than the answer limit', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const slowUploads = (ms: number, fail = false) => ({
    uploadBytes: async (bytes: Uint8Array, name: string, mime: string) => {
      uploads.push({ bytes, name, mime })
      await new Promise((r) => setTimeout(r, ms))
      if (fail) throw new Error('relay said no')
      return {
        media_id: `md_up${uploads.length}`,
        name,
        mime,
        size: bytes.length,
        sha256: '0'.repeat(64),
        kind: 'image',
      } as never
    },
  })
  const read = () => svc.read({ thread_id: T, path: 'shot.png', offset: 0 })
  /** Uploads that end only when the test says so: no race with the clock, however loaded the machine. */
  function heldUploads() {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const media = {
      uploadBytes: async (bytes: Uint8Array, name: string, mime: string) => {
        uploads.push({ bytes, name, mime })
        await gate
        return {
          media_id: `md_up${uploads.length}`,
          name,
          mime,
          size: bytes.length,
          sha256: '0'.repeat(64),
          kind: 'image',
        } as never
      },
    }
    return { media, release, settled: () => gate.then(() => new Promise((r) => setTimeout(r, 0))) }
  }

  test('the first try is told the folder is slow; a try after the upload finished shows it, with one upload in all', async () => {
    put('shot.png', PNG)
    const up = heldUploads()
    // the limit only has to pass while the upload is held (it always is, until released); the cached try needs no upload
    svc = make({ timeMs: 300, media: up.media })
    expect(await refusal(read())).toBe(FILES_WORDING.slow) // the upload is still out
    up.release()
    await up.settled() // it finishes after the answer was given
    const f = await read()
    expect(f).toMatchObject({ kind: 'image', media: { media_id: 'md_up1' } })
    expect(uploads).toHaveLength(1)
  })

  test('tries while it is still uploading share that upload, and get the same preview', async () => {
    put('shot.png', PNG)
    const up = heldUploads()
    svc = make({ timeMs: 10_000, media: up.media })
    const first = read()
    const second = read()
    await new Promise((r) => setTimeout(r, 0))
    up.release()
    expect(await first).toMatchObject({ kind: 'image', media: { media_id: 'md_up1' } })
    expect(await second).toMatchObject({ kind: 'image', media: { media_id: 'md_up1' } })
    expect(uploads).toHaveLength(1)
  })

  test('a failed upload is not kept: the next try uploads again', async () => {
    put('shot.png', PNG)
    let fail = true
    svc = make({
      timeMs: 200,
      media: {
        uploadBytes: async (bytes: Uint8Array, name: string, mime: string) => {
          uploads.push({ bytes, name, mime })
          if (fail) throw new Error('relay said no')
          return { media_id: 'md_ok', name, mime, size: bytes.length, sha256: '0'.repeat(64), kind: 'image' } as never
        },
      },
    })
    await refusal(read())
    fail = false
    expect(await read()).toMatchObject({ media: { media_id: 'md_ok' } })
    expect(uploads).toHaveLength(2)
  })

  test('the file changed: its new bytes are uploaded, not the old upload shown', async () => {
    put('shot.png', PNG)
    svc = make({ timeMs: 500, media: slowUploads(1) })
    expect(await read()).toMatchObject({ media: { media_id: 'md_up1' } })
    put('shot.png', Buffer.concat([PNG, Buffer.from('00', 'hex')]))
    expect(await read()).toMatchObject({ media: { media_id: 'md_up2' } })
    expect(uploads).toHaveLength(2)
  })

  // Fable's review of 499426c6 (2026-11-11): the key, the hour, the cap, and what a waiting try counts for
  const readAt = (path: string) => svc.read({ thread_id: T, path, offset: 0 })

  test('the same size with different bytes is a new upload (the key is the bytes, not their length)', async () => {
    put('shot.png', PNG)
    svc = make({ timeMs: 500, media: slowUploads(0) })
    await read()
    const flipped = Buffer.from(PNG)
    flipped[flipped.length - 1] ^= 0xff
    put('shot.png', flipped)
    expect(await read()).toMatchObject({ media: { media_id: 'md_up2' } })
    expect(uploads).toHaveLength(2)
  })

  test('the same bytes under another name is its own upload (the name is part of the key; the type follows from it)', async () => {
    put('shot.png', PNG)
    put('copy.png', PNG)
    svc = make({ timeMs: 500, media: slowUploads(0) })
    expect(await readAt('shot.png')).toMatchObject({ media: { media_id: 'md_up1', name: 'shot.png' } })
    expect(await readAt('copy.png')).toMatchObject({ media: { media_id: 'md_up2', name: 'copy.png' } })
    expect(uploads.map((u) => u.name)).toEqual(['shot.png', 'copy.png'])
  })

  test('an upload is reused for an hour, and uploaded again after it', async () => {
    put('shot.png', PNG)
    let clock = 0
    svc = make({ timeMs: 500, media: slowUploads(0), now: () => clock })
    await read()
    clock = 59 * 60_000
    expect(await read()).toMatchObject({ media: { media_id: 'md_up1' } })
    clock = 61 * 60_000
    expect(await read()).toMatchObject({ media: { media_id: 'md_up2' } })
    expect(uploads).toHaveLength(2)
  })

  test('past the cap the oldest upload is forgotten, and the newer ones kept', async () => {
    for (const n of ['a', 'b', 'c']) put(`${n}.png`, Buffer.concat([PNG, Buffer.from(n)]))
    svc = make({ timeMs: 500, media: slowUploads(0), uploadsKept: 2 })
    for (const n of ['a', 'b', 'c']) await readAt(`${n}.png`)
    expect(uploads).toHaveLength(3)
    await readAt('c.png')
    await readAt('b.png')
    expect(uploads).toHaveLength(3) // b and c are still known
    await readAt('a.png')
    expect(uploads).toHaveLength(4) // a went first
  })

  test('an expired upload done again counts as the newest: the cap drops an older one, not the fresh upload', async () => {
    for (const n of ['a', 'b', 'c']) put(`${n}.png`, Buffer.concat([PNG, Buffer.from(n)]))
    let clock = 0
    svc = make({ timeMs: 500, media: slowUploads(0), uploadsKept: 2, now: () => clock })
    await readAt('a.png') // at 0
    clock = 59 * 60_000
    await readAt('b.png') // at 59 min
    clock = 61 * 60_000
    await readAt('a.png') // expired: uploaded again, now the newest
    await readAt('c.png') // past the cap: b is the oldest
    expect(uploads.map((u) => u.name)).toEqual(['a.png', 'b.png', 'a.png', 'c.png'])
    await readAt('a.png')
    expect(uploads).toHaveLength(4) // the fresh a was kept
    await readAt('b.png')
    expect(uploads).toHaveLength(5) // b was the one dropped
  })

  test('tries that only wait on an upload already out do not count as lingering, so other reads still work', async () => {
    put('shot.png', PNG)
    put('notes.txt', 'hello\n')
    const up = heldUploads()
    svc = make({ timeMs: 100, media: up.media })
    // the first try's upload is still out after its answer: that one try lingers, holding the bytes
    expect(await refusal(read())).toBe(FILES_WORDING.slow)
    // eight more tries join it and time out too; they hold no file and no bytes (the lingering cap is 8)
    for (let i = 0; i < 8; i++) expect(await refusal(read())).toBe(FILES_WORDING.slow)
    expect(uploads).toHaveLength(1)
    expect(await readAt('notes.txt')).toMatchObject({ kind: 'text', text: 'hello\n' })
    up.release()
    await up.settled()
    expect(await read()).toMatchObject({ kind: 'image', media: { media_id: 'md_up1' } })
  })
})
