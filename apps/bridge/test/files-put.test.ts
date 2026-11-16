// Upload into a thread's folder (src/files/put.ts): the write side of the Files pane's fence. A file is created, never
// opened: nothing that is there is overwritten or reached through a link, a taken name becomes "name (2).ext", hidden names
// and instruction files are refused, the folder is fenced as a listing of it is, and a device has a daily byte budget.
// Every case runs in a temp folder with made-up files and a fake media fetch.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { FILES_PUT_DAY_BYTES, FILES_PUT_MAX_BYTES, FILES_PUT_WORDING, sha256Hex } from '@talos-app/protocol'
import { clashName, FilesPutService, plainUploadName } from '../src/files/put.ts'
import { FilesService } from '../src/files/service.ts'
import { openSeam } from '../src/safe-open.ts'
import { ReadError } from '../src/v2-seams.ts'

/** /tmp, not TMPDIR: a CI run's TMPDIR sits under a hidden folder, which the fence refuses by design. */
const base = () => realpathSync('/tmp')
const T = 'trip'
const DEVICE = 'd_k3j2h4g5f6d7s2a7q2w3'

let top: string
let root: string
let outside: string
let home: string
let now: number
let fetched: number
let svc: FilesPutService

const ref = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
  ({
    media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
    name: 'upload.bin',
    mime: 'application/octet-stream',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    kind: 'file',
    role: 'attachment',
    ...over,
  }) as never
const make = (fetch?: (r: { size: number }) => Promise<Uint8Array>) => {
  const files = new FilesService({
    rootFor: (id) => (id === T ? root : null),
    refused: [home],
    media: { uploadBytes: async () => ({}) as never },
  })
  return new FilesPutService({
    fencedDir: (id, dir) => files.fencedDir(id, dir),
    fetch:
      fetch ??
      (async (r) => {
        fetched++
        return body.subarray(0, r.size)
      }),
    now: () => now,
  })
}
let body = Buffer.from('hello from the phone\n')
const put = (name: string, dir = '', bytes: Uint8Array = body, device = DEVICE) =>
  svc.put({ thread_id: T, dir, name, media: ref(bytes), device_id: device })
const fail = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(ReadError)
  return e as ReadError
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(base(), 'talos-files-put-')))
  root = join(top, 'trip')
  outside = join(top, 'outside')
  home = join(root, 'talos-home') // the bridge's own home, if it ever sits inside a thread's folder
  for (const d of [root, outside, home, join(root, 'docs')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n')
  now = Date.parse('2026-11-11T12:00:00Z')
  fetched = 0
  body = Buffer.from('hello from the phone\n')
  svc = make()
})
afterEach(() => {
  openSeam.beforeOpen = undefined
  rmSync(top, { recursive: true, force: true })
})

describe('putting a file in the folder', () => {
  test('in the folder or a folder in it: the bytes fetched, under the name asked, readable by the owner', async () => {
    expect(await put('notes.md')).toEqual({ thread_id: T, dir: '', name: 'notes.md', size: body.length })
    expect(await put('plan.md', 'docs')).toMatchObject({ dir: 'docs', name: 'plan.md' })
    expect(readFileSync(join(root, 'docs', 'plan.md'), 'utf8')).toBe('hello from the phone\n')
    expect(statSync(join(root, 'notes.md')).mode & 0o777).toBe(0o644)
  })

  test('a taken name is never overwritten: it becomes "name (2).ext", then (3)', async () => {
    writeFileSync(join(root, 'plan.md'), 'MINE\n')
    expect((await put('plan.md')).name).toBe('plan (2).md')
    expect((await put('plan.md')).name).toBe('plan (3).md')
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('MINE\n')
    expect(clashName('archive.tar.gz', 2)).toBe('archive.tar (2).gz')
    expect(clashName('README', 2)).toBe('README (2)')
  })

  test('a link where the file would go is not followed: the file it points at is untouched, the upload takes the next name', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'x.md'))
    expect((await put('x.md')).name).toBe('x (2).md')
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET\n')
  })
})

describe('the name', () => {
  test('hidden names, instruction files, separators and anything that is not a plain name are refused', async () => {
    for (const n of [
      '.env',
      '.git',
      'node_modules',
      'NODE_MODULES',
      '.claude',
      'a/b',
      '../x',
      '..',
      '.',
      ' x',
      'x ',
      'a\nb',
    ]) {
      const e = await fail(put(n))
      expect(e.message, n).toBe(FILES_PUT_WORDING.badName)
    }
    for (const n of ['AGENTS.md', 'agents.MD', 'CLAUDE.md', 'claude.local.md']) {
      expect((await fail(put(n))).message, n).toBe(FILES_PUT_WORDING.instructions)
    }
    expect(plainUploadName('é'.repeat(128))).toBeNull() // 256 bytes
    expect(plainUploadName('plan.md')).toBe('plan.md')
    expect(readdirSync(root).sort()).toEqual(['docs', 'talos-home'])
    expect(fetched).toBe(0) // refused before anything is fetched
  })
})

describe('the folder', () => {
  test('a hidden, missing, outside, refused or lead-protected folder, or a file, is refused, and nothing is written', async () => {
    mkdirSync(join(root, '.git'))
    symlinkSync(outside, join(root, 'out'))
    writeFileSync(join(root, 'file.txt'), 'x')
    mkdirSync(join(root, 'lead', 'private'), { recursive: true })
    writeFileSync(join(root, 'lead', '.talos-lead'), JSON.stringify({ protect: [join(root, 'lead', 'private')] }))
    for (const dir of ['.git', 'nope', 'out', 'talos-home', 'file.txt', 'lead/private', '/etc', '../outside']) {
      expect((await fail(put('a.md', dir))).message, dir).toBe(FILES_PUT_WORDING.folder)
    }
    expect(readdirSync(outside)).toEqual(['secret.txt'])
    expect(existsSync(join(root, '.git', 'a.md'))).toBe(false)
    expect(readdirSync(root).sort()).toEqual(['.git', 'docs', 'file.txt', 'lead', 'out', 'talos-home'])
  })

  test('a name in an allowed folder that a lead marker protects is refused, and so is the next clash name it would take', async () => {
    writeFileSync(join(root, '.talos-lead'), JSON.stringify({ protect: [join(root, 'docs', 'keys.txt')] }))
    expect((await fail(put('keys.txt', 'docs'))).message).toBe(FILES_PUT_WORDING.protectedName)
    expect(existsSync(join(root, 'docs', 'keys.txt'))).toBe(false)
    expect((await put('plan.md', 'docs')).name).toBe('plan.md')
  })

  test('a folder swapped for a link between the fence and the create is not followed: nothing lands outside', async () => {
    openSeam.beforeOpen = (p) => {
      if (!p.endsWith('/docs/a.md')) return
      renameSync(join(root, 'docs'), join(root, 'docs-moved'))
      symlinkSync(outside, join(root, 'docs'))
    }
    expect((await fail(put('a.md', 'docs'))).message).toBe(FILES_PUT_WORDING.failed)
    expect(readdirSync(outside)).toEqual(['secret.txt'])
  })
})

describe('limits and failures', () => {
  test('over 50 MB is refused before the fetch; a fetch that fails or does not match writes nothing', async () => {
    const e = await fail(
      svc.put({
        thread_id: T,
        dir: '',
        name: 'big.bin',
        media: ref(body, { size: FILES_PUT_MAX_BYTES + 1 }),
        device_id: DEVICE,
      }),
    )
    expect(e.message).toBe(FILES_PUT_WORDING.tooLarge)
    expect(fetched).toBe(0)
    svc = make(async () => {
      throw new Error('sha256 mismatch')
    })
    expect((await fail(put('a.md'))).message).toBe(FILES_PUT_WORDING.download)
    expect(readdirSync(root).sort()).toEqual(['docs', 'talos-home'])
  })

  test('a device has a daily byte budget; another device has its own, and the next UTC day starts again', async () => {
    const files = new FilesService({
      rootFor: () => root,
      refused: [home],
      media: { uploadBytes: async () => ({}) as never },
    })
    svc = new FilesPutService({
      fencedDir: (id, dir) => files.fencedDir(id, dir),
      fetch: async (r) => new Uint8Array(r.size),
      now: () => now,
      dayBytes: 100,
    })
    const media = ref(new Uint8Array(60))
    await svc.put({ thread_id: T, dir: '', name: 'one.bin', media, device_id: DEVICE })
    const e = await fail(svc.put({ thread_id: T, dir: '', name: 'two.bin', media, device_id: DEVICE }))
    expect(e.code).toBe('rate_limited')
    expect(e.message).toBe(FILES_PUT_WORDING.budget)
    expect(existsSync(join(root, 'two.bin'))).toBe(false)
    await svc.put({ thread_id: T, dir: '', name: 'other.bin', media, device_id: 'd_a1b2c3d4e5f6g7h8i9j0' })
    now += 24 * 3600_000
    await svc.put({ thread_id: T, dir: '', name: 'two.bin', media, device_id: DEVICE })
    expect(FILES_PUT_DAY_BYTES).toBe(1024 * 1024 * 1024)
  })

  test('a folder that cannot be written leaves nothing behind', async () => {
    chmodSync(join(root, 'docs'), 0o500)
    try {
      expect((await fail(put('a.md', 'docs'))).message).toBe(FILES_PUT_WORDING.failed)
    } finally {
      chmodSync(join(root, 'docs'), 0o700)
    }
    expect(readdirSync(join(root, 'docs'))).toEqual([])
  })
})

describe('the review of 2026-11-11', () => {
  test('a name a case-ignoring disk folds onto an instruction file or node_modules is refused (long s, Kelvin, fullwidth)', async () => {
    for (const n of ['AGENTſ.md', 'agentſ.md', 'node_moduleſ', 'ＡＧＥＮＴＳ.md', 'CLAUDE.md'.replace('C', 'Ｃ')]) {
      const e = await fail(put(n))
      expect([FILES_PUT_WORDING.instructions, FILES_PUT_WORDING.badName] as string[], n).toContain(e.message)
    }
    expect(readdirSync(root).sort()).toEqual(['docs', 'talos-home'])
    expect(plainUploadName('naïve.md')).toBe('naïve.md') // a plain name with an accent is still a name
  })

  test('two at once: the day budget is reserved up front, a third is told the folder is busy, a failure gives it back', async () => {
    const files = new FilesService({
      rootFor: () => root,
      refused: [home],
      media: { uploadBytes: async () => ({}) as never },
    })
    const held: Array<() => void> = []
    svc = new FilesPutService({
      fencedDir: (id, dir) => files.fencedDir(id, dir),
      fetch: (r) => new Promise((res) => held.push(() => res(new Uint8Array(r.size)))),
      now: () => now,
      dayBytes: 100,
    })
    const m = ref(new Uint8Array(40))
    const one = svc.put({ thread_id: T, dir: '', name: 'one.bin', media: m, device_id: DEVICE })
    const two = svc.put({ thread_id: T, dir: '', name: 'two.bin', media: m, device_id: 'd_a1b2c3d4e5f6g7h8i9j0' })
    expect((await fail(svc.put({ thread_id: T, dir: '', name: 'three.bin', media: m, device_id: DEVICE }))).code).toBe(
      'internal',
    )
    // both are downloading (the first look at the folder comes before the fetch): then they finish
    while (held.length < 2) await Bun.sleep(5)
    for (const go of held.splice(0)) go()
    await Promise.all([one, two])
    // 40 of 100 spent: 40 more fits, then 40 more does not (reserved before the fetch, so it cannot slip past)
    const three = svc.put({ thread_id: T, dir: '', name: 'three.bin', media: m, device_id: DEVICE })
    const four = svc.put({ thread_id: T, dir: '', name: 'four.bin', media: m, device_id: DEVICE })
    expect((await fail(four)).code).toBe('rate_limited')
    while (held.length < 1) await Bun.sleep(5)
    for (const go of held.splice(0)) go()
    await three
    // a failed one gives its bytes back
    svc = new FilesPutService({
      fencedDir: (id, dir) => files.fencedDir(id, dir),
      fetch: async () => {
        throw new Error('gone')
      },
      now: () => now,
      dayBytes: 100,
    })
    for (let i = 0; i < 5; i++)
      await fail(svc.put({ thread_id: T, dir: '', name: `f${i}.bin`, media: m, device_id: DEVICE }))
  })

  test('the fence is taken after the download: a marker added meanwhile counts', async () => {
    svc = make(async (r) => {
      writeFileSync(join(root, '.talos-lead'), JSON.stringify({ protect: [join(root, 'docs')] }))
      return body.subarray(0, r.size)
    })
    expect((await fail(put('a.md', 'docs'))).message).toBe(FILES_PUT_WORDING.folder)
    expect(readdirSync(join(root, 'docs'))).toEqual([])
  })

  test('a folder swapped for a link before a failed create: the empty file of that name over there is not removed', async () => {
    writeFileSync(join(outside, 'a.md'), '')
    openSeam.beforeOpen = (p) => {
      if (!p.endsWith('/docs/a.md')) return
      renameSync(join(root, 'docs'), join(root, 'docs-moved'))
      symlinkSync(outside, join(root, 'docs'))
    }
    expect((await fail(put('a.md', 'docs'))).message).toBe(FILES_PUT_WORDING.failed)
    expect(existsSync(join(outside, 'a.md'))).toBe(true)
  })

  test('a wrong folder is said before the download', async () => {
    expect((await fail(put('a.md', 'nope'))).message).toBe(FILES_PUT_WORDING.folder)
    expect(fetched).toBe(0)
  })

  test('a create the handle check then refuses leaves no empty file behind', async () => {
    openSeam.afterOpen = (p) => {
      if (p.endsWith('/a.md')) throw new Error('opened file is not at the resolved path')
    }
    try {
      expect((await fail(put('a.md'))).message).toBe(FILES_PUT_WORDING.failed)
    } finally {
      openSeam.afterOpen = undefined
    }
    expect(existsSync(join(root, 'a.md'))).toBe(false)
  })

  test("a folder that is gone says so in the pane's words, not as a refusal", async () => {
    rmSync(root, { recursive: true })
    const e = await fail(put('a.md'))
    expect(e.message).not.toBe(FILES_PUT_WORDING.folder)
  })
})
