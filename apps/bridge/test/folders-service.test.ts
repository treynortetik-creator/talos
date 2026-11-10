// The folder lister (src/folders/service.ts): what the picker may see of the Mac. Folder NAMES only, under the owner's home,
// never a symlink followed, never a refused root or anything under it. Every case runs in a temp home with made-up folders.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  promises as fsp,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FOLDER_LIST_MAX, FOLDER_WORDING } from '@talos-app/protocol'
import { FolderService, folderRefusedRoots } from '../src/folders/service.ts'
import { defaultLeadRoots, LEAD_SECRET_PATHS } from '../src/lead/fence.ts'
import { ReadError } from '../src/v2-seams.ts'

let top: string
let home: string
let outside: string
let talosHome: string
let agentDir: string
let svc: FolderService

const dir = (...p: string[]) => mkdirSync(join(home, ...p), { recursive: true })
const names = async (path: string | null, hidden = false) =>
  (await svc.list({ path, hidden })).entries.map((e) => e.name)
const refused = async (path: string, hidden = false) => {
  const e = await svc.list({ path, hidden }).then(
    () => null,
    (x: unknown) => x,
  )
  expect(e, path).toBeInstanceOf(ReadError)
  expect((e as ReadError).message).toBe(FOLDER_WORDING.refused)
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'talos-folders-')))
  home = join(top, 'home')
  outside = join(top, 'outside')
  talosHome = join(home, '.config', 'talos', 'app')
  agentDir = join(home, 'agents', 'main')
  mkdirSync(home)
  mkdirSync(join(outside, 'secret-folder'), { recursive: true })
  svc = new FolderService({ home, talosHome, claudeDir: join(home, '.claude'), agentDir })
})
afterEach(() => rmSync(top, { recursive: true, force: true }))

describe('what a listing holds', () => {
  test('folders only, sorted, with the home and the agent folder named; files never appear', async () => {
    dir('Projects')
    dir('Documents')
    dir('agents', 'main')
    writeFileSync(join(home, 'notes.txt'), 'a file')
    writeFileSync(join(home, 'Projects', 'readme.md'), 'a file inside')
    const r = await svc.list({ path: home, hidden: false })
    expect(r.entries.map((e) => e.name)).toEqual(['agents', 'Documents', 'Projects'])
    expect(r.home).toBe(home)
    expect(r.agent_dir).toBe(agentDir)
    expect(r.path).toBe(home)
    expect(r.more).toBe(0)
    expect(JSON.stringify(r)).not.toContain('notes.txt')
    expect(JSON.stringify(r)).not.toContain('readme.md')
    // an entry is its name and nothing else: no size, no time, no mode
    for (const e of r.entries) expect(Object.keys(e)).toEqual(['name'])
  })

  test('a null path lists nothing and only says where home and the agent folder are', async () => {
    dir('Projects')
    const r = await svc.list({ path: null, hidden: false })
    expect(r.entries).toEqual([])
    expect(r.home).toBe(home)
    expect(r.agent_dir).toBe(agentDir)
    expect(r.path).toBeUndefined()
  })

  test('no agent folder known: the answer leaves it out', async () => {
    const bare = new FolderService({ home, talosHome, claudeDir: join(home, '.claude') })
    const r = await bare.list({ path: null, hidden: false })
    expect('agent_dir' in r).toBe(false)
  })

  test('dot-folders are hidden unless asked for', async () => {
    dir('Projects')
    dir('.cache')
    dir('.hidden-work')
    expect(await names(home)).toEqual(['Projects'])
    expect(await names(home, true)).toEqual(['.cache', '.hidden-work', 'Projects'])
  })

  test('the parent is given for a folder inside home, and null at home itself', async () => {
    dir('Projects', 'alpha')
    expect((await svc.list({ path: join(home, 'Projects', 'alpha'), hidden: false })).parent).toBe(
      join(home, 'Projects'),
    )
    expect((await svc.list({ path: home, hidden: false })).parent).toBeNull()
  })

  test('a symlink is left out of the listing, even one that points at a folder inside home', async () => {
    dir('Projects')
    symlinkSync(join(home, 'Projects'), join(home, 'shortcut'))
    symlinkSync(outside, join(home, 'elsewhere'))
    expect(await names(home)).toEqual(['Projects'])
  })

  test('a folder whose name has a control character is left out; one with a hidden direction mark stays (the app shows it)', async () => {
    dir('plain')
    dir('bad\u0007bell')
    dir('mark‮gnp.txt')
    const got = await names(home)
    expect(got).toContain('plain')
    expect(got).toContain('mark‮gnp.txt')
    expect(got.some((n) => n.includes('\u0007'))).toBe(false)
  })

  test('more than the cap: the first 500 by name, and the count of the rest', async () => {
    for (let i = 0; i < FOLDER_LIST_MAX + 25; i++) dir('many', `d${String(i).padStart(4, '0')}`)
    const r = await svc.list({ path: join(home, 'many'), hidden: false })
    expect(r.entries).toHaveLength(FOLDER_LIST_MAX)
    expect(r.entries[0]?.name).toBe('d0000')
    expect(r.entries.at(-1)?.name).toBe(`d${String(FOLDER_LIST_MAX - 1).padStart(4, '0')}`)
    expect(r.more).toBe(25)
  })

  test('a listing that runs past its time cap is refused in words, not cut off quietly', async () => {
    for (let i = 0; i < 50; i++) dir('slow', `d${i}`)
    let t = 0
    const slow = new FolderService({
      home,
      talosHome,
      claudeDir: join(home, '.claude'),
      timeMs: 5,
      now: () => (t += 10), // every look at the clock is 10 ms later
    })
    const e = await slow.list({ path: join(home, 'slow'), hidden: false }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ReadError)
    expect((e as ReadError).message).toBe(FOLDER_WORDING.slow)
  })
})

describe('what is refused', () => {
  const secret = [
    '.ssh',
    '.gnupg',
    '.aws',
    '.config/gh',
    '.config/talos',
    '.claude',
    '.talos-inbox',
    'Library',
    'private-agent-vault',
  ]
  for (const root of secret) {
    test(`~/${root} and anything under it is refused, and left out of its parent's listing`, async () => {
      dir(root, 'inside', 'deeper')
      dir('Projects')
      await refused(join(home, root))
      await refused(join(home, root, 'inside'))
      await refused(join(home, root, 'inside', 'deeper'))
      // the refused folder is also missing from its own parent's listing, hidden folders shown (a sibling proves the parent is read)
      const parent = join(home, dirname(root))
      mkdirSync(join(parent, 'neighbour'), { recursive: true })
      const seen = await names(parent, true)
      expect(seen).toContain('neighbour')
      expect(seen).not.toContain(root.split('/').at(-1) as string)
    })
  }

  test('the Talos home and the agent folder are refused (the agent folder is the default, not a place to browse into)', async () => {
    dir('.config', 'talos', 'app', 'media')
    dir('agents', 'main', 'sub')
    await refused(talosHome)
    await refused(join(talosHome, 'media'))
    await refused(agentDir)
    await refused(join(agentDir, 'sub'))
  })

  test('a Claude config folder that CLAUDE_CONFIG_DIR moved is refused too', async () => {
    dir('elsewhere-claude', 'projects')
    const moved = new FolderService({ home, talosHome, claudeDir: join(home, 'elsewhere-claude') })
    const e = await moved
      .list({ path: join(home, 'elsewhere-claude', 'projects'), hidden: false })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ReadError)
  })

  test('the refused list is the lead fence list plus a few extras: the fence roots are not copied, they are reused', () => {
    const roots = folderRefusedRoots({ home, talosHome, claudeDir: join(home, '.claude'), agentDir })
    for (const r of defaultLeadRoots({ agentDir, talosHome, home, claudeDir: join(home, '.claude') }))
      expect(roots).toContain(r)
    for (const p of LEAD_SECRET_PATHS) expect(roots).toContain(join(home, p))
    for (const p of [
      '.gnupg',
      '.config/talos',
      '.talos-inbox',
      'Library',
      '.docker',
      '.kube',
      '.config/gcloud',
      '.azure',
      '.codex',
      '.gemini',
      '.password-store',
      '.local/share/keyrings',
    ])
      expect(roots).toContain(join(home, p))
  })

  test('relative paths, .. segments, NUL, other control characters and broken text are refused', async () => {
    dir('Projects')
    for (const bad of [
      'Projects',
      '',
      '~',
      `${home}/Projects/../..`,
      `${home}/Projects/..`,
      `${home}/./Projects`,
      `${home}/Pro\u0000jects`,
      `${home}/Pro\njects`,
      `${home}/Pro\ud800jects`, // half a character: not valid text
    ])
      await refused(bad)
  })

  test('outside the home is refused: the root, /etc, a sibling of home, home itself written with ..', async () => {
    for (const bad of ['/', '/etc', '/private/etc', outside, top, join(home, '..')]) await refused(bad)
  })

  test('a symlink anywhere on the path is refused, whether it leads outside, to a refused root, or to a folder in home', async () => {
    dir('.ssh', 'keys')
    dir('Projects', 'alpha')
    symlinkSync(outside, join(home, 'to-outside'))
    symlinkSync(join(home, '.ssh'), join(home, 'to-ssh'))
    symlinkSync(join(home, 'Projects'), join(home, 'to-projects'))
    await refused(join(home, 'to-outside'))
    await refused(join(home, 'to-outside', 'secret-folder'))
    await refused(join(home, 'to-ssh'))
    await refused(join(home, 'to-ssh', 'keys'))
    await refused(join(home, 'to-projects'))
    await refused(join(home, 'to-projects', 'alpha'))
  })

  test('a file, and a folder that is not there, are refused with the same words as a refused root', async () => {
    writeFileSync(join(home, 'a-file'), 'x')
    await refused(join(home, 'a-file'))
    await refused(join(home, 'nope'))
    await refused(join(home, '.ssh'))
  })

  test('case does not get round a refused root (macOS is case-insensitive)', async () => {
    dir('.ssh', 'keys')
    dir('Library', 'Keychains')
    await refused(join(home, '.SSH'))
    await refused(join(home, '.Ssh', 'keys'))
    await refused(join(home, 'library', 'Keychains'))
  })
})

const real = { opendir: fsp.opendir, lstat: fsp.lstat, realpath: fsp.realpath, stat: fsp.stat }
const deps = (more: Record<string, unknown> = {}) => ({ home, talosHome, claudeDir: join(home, '.claude'), ...more })
const words = async (p: Promise<unknown>) => (await p.catch((x: unknown) => x)) as ReadError

describe('the listing never blocks the bridge', () => {
  test('a big folder is read in turns: other work runs while it is being listed', async () => {
    for (let i = 0; i < 3000; i++) dir('big', `d${i}`)
    let ticks = 0
    let done = false
    const spin = () => {
      if (done) return
      ticks++
      setImmediate(spin)
    }
    setImmediate(spin)
    await svc.list({ path: join(home, 'big'), hidden: false })
    done = true
    expect(ticks).toBeGreaterThan(0)
  })

  test('a folder that never opens is answered "slow to open" at the time cap, not waited for', async () => {
    dir('stuck')
    const hung = new FolderService(deps({ timeMs: 50, fs: { ...real, opendir: () => new Promise(() => {}) } }))
    const started = Date.now()
    const e = await words(hung.list({ path: join(home, 'stuck'), hidden: false }))
    expect(e).toBeInstanceOf(ReadError)
    expect(e.message).toBe(FOLDER_WORDING.slow)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a folder macOS or the file mode will not let Talos open says so in words, not "refused"', async () => {
    dir('locked')
    chmodSync(join(home, 'locked'), 0o000)
    try {
      const e = await words(svc.list({ path: join(home, 'locked'), hidden: false }))
      expect(e).toBeInstanceOf(ReadError)
      expect(e.message).toBe(FOLDER_WORDING.noAccess)
      expect(FOLDER_WORDING.noAccess).toMatch(/macOS hasn't given Talos access to this folder/)
      expect(FOLDER_WORDING.noAccess).not.toBe(FOLDER_WORDING.refused)
    } finally {
      chmodSync(join(home, 'locked'), 0o755)
    }
  })
})

describe('other spellings of a refused root', () => {
  test('a long s (.ſsh) and other case spellings are refused, lexically', async () => {
    dir('.ssh', 'keys')
    await refused(join(home, '.ſsh'))
    await refused(join(home, '.ſsh', 'keys'))
    await refused(join(home, '.SSH', 'keys'))
  })

  test('a decomposed (NFD) spelling of a refused root with an accent is refused', async () => {
    const accented = join(home, 'agents', 'jos\u00e9') // é as one character
    mkdirSync(join(accented, 'sub'), { recursive: true })
    const withAgent = new FolderService(deps({ agentDir: accented }))
    const nfd = join(home, 'agents', 'jose\u0301', 'sub') // e + combining accent
    const e = await words(withAgent.list({ path: nfd, hidden: false }))
    expect(e).toBeInstanceOf(ReadError)
    expect(e.message).toBe(FOLDER_WORDING.refused)
  })

  test("the disk's own spelling is checked too: a path that really is a refused root is refused, whatever it was called", async () => {
    dir('Projects', 'alias')
    dir('.ssh', 'keys')
    // the lexical path looks harmless; the disk (here, a stand-in) says it is the .ssh folder
    const odd = new FolderService(
      deps({
        fs: {
          ...real,
          realpath: async (p: string) => (p.endsWith('/Projects/alias') ? join(home, '.ssh') : fsp.realpath(p)),
        },
      }),
    )
    const e = await words(odd.list({ path: join(home, 'Projects', 'alias'), hidden: false }))
    expect(e).toBeInstanceOf(ReadError)
    expect(e.message).toBe(FOLDER_WORDING.refused)
  })

  test('a folder swapped for another place while it is read gets no names (the disk is looked at again after opening)', async () => {
    dir('Projects', 'alpha', 'inner')
    let calls = 0
    const swapped = new FolderService(
      deps({
        fs: {
          ...real,
          realpath: async (p: string) => {
            if (p.endsWith('/Projects/alpha') && ++calls > 1) return join(home, '.ssh')
            return fsp.realpath(p)
          },
        },
      }),
    )
    const e = await words(swapped.list({ path: join(home, 'Projects', 'alpha'), hidden: false }))
    expect(e).toBeInstanceOf(ReadError)
    expect(e.message).toBe(FOLDER_WORDING.refused)
    expect(calls).toBeGreaterThan(1)
  })
})

describe('a refused root that is home itself', () => {
  test('is ignored rather than refusing everything, and the bridge says so in its log', async () => {
    dir('Projects')
    const warned: string[] = []
    const odd = new FolderService(deps({ agentDir: home, log: { warn: (m: string) => warned.push(m) } }))
    expect((await odd.list({ path: home, hidden: false })).entries.map((e) => e.name)).toEqual(['Projects'])
    expect(warned.join(' ')).toMatch(/home/)
    expect(folderRefusedRoots({ home, talosHome, claudeDir: join(home, '.claude'), agentDir: home })).not.toContain(
      home,
    )
  })
})
