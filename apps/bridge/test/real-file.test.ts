// A file's real path, resolved by walking it (src/real-file.ts): a file keeps the name it was found by. On macOS a file's realpath
// can come back as another of its hard-linked names, so each check here gives a file a second name, uses that name
// concurrently, and asks again and again. On Linux these pass either way.
// gate-reads: apps/bridge/src/*
import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { real as guardReal } from '../src/guards/rules.ts'
import { planAskRules, writePlan } from '../src/permission/ask-rules.ts'
import { realFileOrNull, realFileSync, walkLinks } from '../src/real-file.ts'
import { openResolvedNoFollow, readRegularFile } from '../src/safe-open.ts'
import { mainSettings } from '../src/supervisor/worker-policy.ts'

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-real-file-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Calls `check` over and over for `ms`, with `other` (a second name of the file under test) opened concurrently by four worker
 * threads (a name missing for a moment is skipped), and returns what `check` said was wrong (each wrong answer once). The
 * workers are stopped and awaited: none is left behind. Threads, not processes: with `cat` children, a child's close was not
 * seen (one run: 328 spawns, 327 closes), which hung this helper in about 1 run in 4 on a loaded Mac (2026-11-13). The cause is
 * unproven (it did not reproduce standalone). The threads also give realpath the other name far more often (about 98% of
 * calls, against 15% with four `cat` loops, on the M5).
 */
async function withSecondNameUsed(other: string, ms: number, check: () => string | null): Promise<string[]> {
  const src = `const { closeSync, openSync } = require('node:fs')
let go = true
onmessage = () => { go = false }
postMessage('ready')
;(async () => {
  while (go) {
    for (let i = 0; i < 200; i++)
      try {
        closeSync(openSync(${JSON.stringify(other)}, 'r'))
      } catch {} // a test may take the name away and back meanwhile, as \`cat\` would find it gone
    await new Promise((r) => setTimeout(r, 0))
  }
  postMessage('stopped')
})()`
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
  const readers = [0, 1, 2, 3].map(() => new Worker(url))
  // each worker says 'ready', then 'stopped' once asked to stop; an error fails the wait it comes in
  const said = readers.map((w) => {
    const next: Record<string, () => void> = {}
    const ready = new Promise<void>((r) => (next.ready = r))
    const stopped = new Promise<void>((r) => (next.stopped = r))
    const failed = new Promise<never>((_, reject) => (w.onerror = (e) => reject(e)))
    failed.catch(() => {}) // surfaced by the wait it races, not as an unhandled rejection
    w.onmessage = (e) => next[e.data as string]?.()
    // a worker that fails after it is ready only ends its readers sooner; the stop wait below never rejects
    return { ready: Promise.race([ready, failed]), stopped: Promise.race([stopped, failed]).catch(() => {}) }
  })
  const wrong = new Set<string>()
  try {
    // the clock starts once every worker is opening the other name, so a slow start never shortens the check
    await Promise.race([
      Promise.all(said.map((s) => s.ready)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the readers did not start in 10 s')), 10_000)),
    ])
    const until = Date.now() + ms
    while (Date.now() < until) {
      for (let i = 0; i < 20; i++) {
        const why = check()
        if (why !== null) wrong.add(why)
      }
      await new Promise((r) => setTimeout(r, 1))
    }
  } finally {
    for (const w of readers) w.postMessage('stop')
    // a worker that never says 'stopped' is ended anyway after 2 s, so the helper never hangs on one
    await Promise.race([Promise.all(said.map((s) => s.stopped)), new Promise((r) => setTimeout(r, 2000))]).finally(
      () => {
        for (const w of readers) w.terminate()
        URL.revokeObjectURL(url)
      },
    )
  }
  return [...wrong]
}

describe('realFileSync: a path through its links, as the kernel follows them', () => {
  it('is realpathSync for a file with one name, a folder, the root and a relative path', () => {
    const d = tmp()
    mkdirSync(join(d, 'real'))
    writeFileSync(join(d, 'real', 'f'), 'x')
    symlinkSync(join(d, 'real'), join(d, 'dirlink'))
    symlinkSync('real/f', join(d, 'rel'))
    symlinkSync(join(d, 'rel'), join(d, 'chain'))
    for (const p of [
      join(d, 'real', 'f'),
      join(d, 'dirlink', 'f'),
      join(d, 'rel'),
      join(d, 'chain'),
      join(d, 'dirlink'),
      '/',
    ])
      expect(realFileSync(p)).toBe(realpathSync(p))
    expect(realFileSync('.')).toBe(realpathSync('.'))
    expect(realFileSync(join(d, 'real', '..', 'real', 'f'))).toBe(join(d, 'real', 'f'))
  })
  it('a `..` after a linked folder climbs from where that folder really is, not from the link', () => {
    const d = tmp()
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    writeFileSync(join(d, 'a', 'f'), 'right')
    writeFileSync(join(d, 'f'), 'wrong')
    symlinkSync(join(d, 'a', 'b'), join(d, 'blink'))
    symlinkSync('blink/../f', join(d, 'via')) // the kernel: <d>/a/b/.. is <d>/a, so <d>/a/f
    expect(realFileSync(join(d, 'via'))).toBe(join(d, 'a', 'f'))
    expect(readFileSync(realFileSync(join(d, 'via')), 'utf8')).toBe('right')
  })
  it('throws as realpathSync does: missing, a loop of links, an empty path', () => {
    const d = tmp()
    symlinkSync(join(d, 'b'), join(d, 'a'))
    symlinkSync(join(d, 'a'), join(d, 'b'))
    expect(() => realFileSync(join(d, 'nope'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => realFileSync(join(d, 'a'))).toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(() => realFileSync('')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    writeFileSync(join(d, 'file'), 'x')
    for (const p of [join(d, 'file', 'x'), `${join(d, 'file')}/..`, `${join(d, 'file')}/`, `${join(d, 'file')}/.`])
      expect(() => realFileSync(p), p).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(realFileOrNull(join(d, 'nope'))).toBeNull()
  })
  it.skipIf(process.platform !== 'darwin')(
    'the second name, used meanwhile, does throw off a plain realpath (macOS)',
    async () => {
      // the check above is only worth something while withSecondNameUsed really makes realpath answer with the other name
      const d = tmp()
      writeFileSync(join(d, 'mine'), 'x')
      linkSync(join(d, 'mine'), join(d, 'other'))
      const wrong = await withSecondNameUsed(join(d, 'other'), 500, () => {
        const got = realpathSync(join(d, 'mine'))
        return got === join(d, 'mine') ? null : got
      })
      expect(wrong).toEqual([join(d, 'other')])
    },
  )
  it('a file with a second name (a hard link) keeps its own', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mine'), 'x')
    linkSync(join(d, 'mine'), join(d, 'other'))
    const wrong = await withSecondNameUsed(join(d, 'other'), 1500, () => {
      const got = realFileSync(join(d, 'mine'))
      return got === join(d, 'mine') ? null : got
    })
    expect(wrong).toEqual([])
  })
})

// a case-folding volume (a Mac's usual one): another spelling names the same file
const FOLDS = (() => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-real-file-case-')))
  try {
    writeFileSync(join(d, 'a'), '')
    try {
      readFileSync(join(d, 'A'))
      return true
    } catch {
      return false
    }
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})()

describe.skipIf(!FOLDS)(
  'on a case-folding volume, names come back as the disk spells them (as realpath gives them)',
  () => {
    it('a folder and a file asked for in another case', () => {
      const d = tmp()
      mkdirSync(join(d, 'Dir'))
      writeFileSync(join(d, 'Dir', 'File.txt'), 'x')
      symlinkSync(join(d, 'DIR'), join(d, 'link'))
      expect(realFileSync(join(d, 'dir'))).toBe(join(d, 'Dir'))
      expect(realFileSync(join(d, 'link'))).toBe(join(d, 'Dir'))
      expect(realFileSync(join(d, 'dir', 'file.TXT'))).toBe(join(d, 'Dir', 'File.txt'))
    })
    it('a protected folder named in another case still keeps an agent’s linked settings out (ask-rules)', () => {
      const d = tmp()
      mkdirSync(join(d, 'cfg', '.claude'), { recursive: true })
      mkdirSync(join(d, 'agent'))
      symlinkSync(join(d, 'cfg', '.claude'), join(d, 'agent', '.claude'))
      expect(() =>
        planAskRules(join(d, 'agent', '.claude', 'settings.json'), ['Bash(rm:*)'], {
          root: join(d, 'agent'),
          protectedRoots: [join(d, 'cfg', '.Claude')],
        }),
      ).toThrow('which this command never writes for an agent folder')
    })
    it('an open by another spelling is refused, as before, for a file with one name and one with two', () => {
      const d = tmp()
      writeFileSync(join(d, 'one.txt'), 'x')
      writeFileSync(join(d, 'two.txt'), 'x')
      linkSync(join(d, 'two.txt'), join(d, 'other.txt'))
      for (const p of [join(d, 'ONE.txt'), join(d, 'TWO.txt')]) expect(() => openResolvedNoFollow(p), p).toThrow()
      for (const p of [join(d, 'one.txt'), join(d, 'two.txt')]) closeSync(openResolvedNoFollow(p))
    })
  },
)

describe('the guards resolve a path into a folder that cannot be read (only searched) to where it leads', () => {
  it('a protected file reached through a link into a 0311 folder is named by where it is, never by the link', () => {
    const d = tmp()
    mkdirSync(join(d, 'prot'))
    writeFileSync(join(d, 'prot', 'config.json'), '{}')
    symlinkSync(join(d, 'prot'), join(d, 'link'))
    chmodSync(join(d, 'prot'), 0o311)
    try {
      // macOS: a folder's spelling needs it readable (on Linux, or as root, the folder's realpath works and this is not reached)
      if (process.platform === 'darwin' && process.getuid?.() !== 0)
        expect(() => realFileSync(join(d, 'link', 'config.json'))).toThrow(expect.objectContaining({ code: 'EACCES' }))
      expect(walkLinks(join(d, 'link', 'config.json'))).toBe(join(d, 'prot', 'config.json'))
      expect(guardReal(join(d, 'link', 'config.json'))).toBe(join(d, 'prot', 'config.json'))
      expect(guardReal(join(d, 'link', 'new.json'))).toBe(join(d, 'prot', 'new.json'))
    } finally {
      chmodSync(join(d, 'prot'), 0o755)
    }
  })
})

describe('the open that keeps a read inside a folder (safe-open.ts) is judged by the file, not by its name', () => {
  it('a hard-linked file opens and reads every time', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mine'), 'content')
    linkSync(join(d, 'mine'), join(d, 'other'))
    const wrong = await withSecondNameUsed(join(d, 'other'), 1500, () => {
      const text = readRegularFile(join(d, 'mine'), 1024)?.toString('utf8') ?? null
      if (text !== 'content') return `readRegularFile: ${text}`
      try {
        const fd = openResolvedNoFollow(join(d, 'mine'))
        closeSync(fd)
      } catch (e) {
        return `openResolvedNoFollow: ${(e as Error).message}`
      }
      return null
    })
    expect(wrong).toEqual([])
  })
})

describe('Main’s own --settings with another name: its /-rules stay rooted at its own folder', () => {
  it('every read roots Read(/secrets/**) at the folder Main’s file is in', async () => {
    const d = tmp()
    const agentDir = join(d, 'agent')
    for (const f of [agentDir, join(d, 'dotfiles'), join(d, 'elsewhere')]) mkdirSync(f)
    const own = join(d, 'dotfiles', 'main.json')
    writeFileSync(own, JSON.stringify({ permissions: { deny: ['Read(/secrets/**)'] } }))
    linkSync(own, join(d, 'elsewhere', 'x.json'))
    const right = [`Read(/${join(d, 'dotfiles')}/secrets/**)`]
    const wrong = await withSecondNameUsed(join(d, 'elsewhere', 'x.json'), 1500, () => {
      const s = mainSettings(['--settings', own], agentDir)
      const deny = 'deny' in s ? s.deny : null
      return JSON.stringify(deny) === JSON.stringify(right) ? null : `${s.kind}: ${JSON.stringify(deny)}`
    })
    expect(wrong).toEqual([])
  })
})

describe('an ask rule for the owner’s settings file with another name is written to that file', () => {
  it('the plan targets the owner’s file and the rule lands there', async () => {
    const d = tmp()
    const owner = join(d, 'claude', 'settings.json')
    const other = join(d, 'agent', '.claude', 'settings.local.json')
    mkdirSync(join(d, 'claude'))
    mkdirSync(join(d, 'agent', '.claude'), { recursive: true })
    const fresh = () => {
      // each round: the owner's file with one name more (the write replaces it, which ends the link)
      rmSync(other, { force: true })
      writeFileSync(owner, '{}\n')
      linkSync(owner, other)
    }
    fresh()
    const wrong = await withSecondNameUsed(other, 1500, () => {
      try {
        const plan = planAskRules(owner, ['Bash(rm:*)'])
        if (plan.target !== owner) return `planned for ${plan.target}`
        writePlan(plan)
        const rules = JSON.parse(readFileSync(owner, 'utf8')).permissions?.ask
        if (JSON.stringify(rules) !== '["Bash(rm:*)"]') return `the owner's file has ${JSON.stringify(rules)}`
        return null
      } catch (e) {
        return (e as Error).message.replaceAll(d, '<d>')
      } finally {
        fresh()
      }
    })
    expect(wrong).toEqual([])
  })
})

// Every realpath in apps/bridge/src, line by line, against the ones known to be safe. A new one fails here: a FILE's real path goes
// through realFileSync (src/real-file.ts); only a path that is always a folder may use realpath, and is then added below. The
// lines are compared as written (trimmed, comments left out), so a change to one of these lines is a change to the list too.
// Not covered: a call through one of the wrappers these lines define (realOrNull, realOr, real): a new caller of one of those
// must pass it a folder, which review checks.
const SRC = join(import.meta.dir, '..', 'src')
// a path that is always a folder (a folder has one name, so its realpath is sound), a handle checked to have one name (the
// kernel then has no other name to give), or an import
const FOLDER_ONLY: Record<string, string[]> = {
  'adopt.ts': [
    "import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  'apps/cli.ts': ["import { readFileSync, realpathSync } from 'node:fs'", 'return realpathSync(p)'],
  // the deepest existing parent FOLDER of an edited path, to tell whether it sits under a Claude agents/skills/commands folder
  'permission/frontmatter-risk.ts': [
    "import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'",
    'return join(realpathSync(dir), ...rest)',
  ],
  // the agent folder and the folder a gazetteer was built for (memory.json agent_dir, gazetteer `repo`): folders only
  'memory/reflex.ts': [
    "import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  // the agent folder (TALOS_AGENT_DIR), to name the kit's state folder the way the kit does (from the real path): a folder only
  'action-rule-asks.ts': ["import { readFileSync, realpathSync } from 'node:fs'", 'real = realpathSync(dir)'],
  'cli-main.ts': [
    "import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  'files/wiring.ts': ["import { realpathSync } from 'node:fs'", 'return foldPath(realpathSync(p))'],
  // the agent folder a plain-folder record names (start --no-kit, adopt): a folder only
  'kit-marker.ts': ["import { realpathSync, statSync } from 'node:fs'", 'return realpathSync(dir)'],
  'folders/service.ts': [
    "import { promises as fsp, realpathSync } from 'node:fs'",
    "export type FolderFs = Pick<typeof fsp, 'opendir' | 'lstat' | 'realpath' | 'stat'>",
    'const real = await this.fs.realpath(path)',
    'const again = await this.fs.realpath(path)',
    'return realpathSync(p)',
  ],
  'good-starts.ts': ["import { realpathSync } from 'node:fs'", 'const repo = realpathSync(top.out)'],
  'last-good.ts': ['realpathSync,', 'return realpathSync(p)'],
  'mcp-config.ts': [
    "import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  'memory/cli.ts': [
    "import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'",
    'agentDir = realpathSync(dir)',
    'return realpathSync(p)', // memory set-root's --agent-dir: a folder
  ],
  'memory/config.ts': [
    "import { existsSync, realpathSync, statSync } from 'node:fs'",
    'agentReal = realpathSync(o.agent_dir)',
    'homeReal = realpathSync(home)',
    'real = realpathSync(resolve(agentReal, x.path))',
    'return realpathSync(p)',
  ],
  // the agent folder Settings > Memory folders lists (memory/roots.ts realDir): a folder only, checked to be one
  'memory/roots.ts': ["import { realpathSync, statSync } from 'node:fs'", 'const r = realpathSync(p)'],
  'rollback.ts': ["import { existsSync, realpathSync } from 'node:fs'", 'return realpathSync(p)'],
  'secrets/platform.ts': ["import { readFileSync, realpathSync } from 'node:fs'", 'const real = realpathSync(p)'],
  'safe-open.ts': [
    'realpathSync,',
    'if (mine.nlink <= 1n) return realpathSync(`/dev/fd/${fd}`)',
    'realpathSync(folder) === folder &&',
  ],
  'supervisor/cli.ts': ['realpathSync,', 'real = realpathSync(agentDir)', 'real = realpathSync(agentDir)'],
  'supervisor/worker-config.ts': ["import { readFileSync, realpathSync } from 'node:fs'", 'return realpathSync(p)'],
  // the agent folder and a session's launch folder (update-check.ts realOrSelf): folders only
  'supervisor/update-check.ts': ["import { readFileSync, realpathSync } from 'node:fs'", 'return realpathSync(p)'],
  // the threads folder and the agent folder, compared (a link anywhere is refused): folders only
  'supervisor/thread-state-seed.ts': [
    'realpathSync,',
    "fine = fine && !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === join(realpathSync(agentDir), 'threads')",
  ],
  'supervisor/worker-hook.ts': ['realpathSync,', 'return realpathSync(p)'],
  'supervisor/worker-launch.ts': ["import { realpathSync } from 'node:fs'", 'return realpathSync(cwd)'],
  'supervisor/worker-mcp.ts': ['realpathSync,', 'return realpathSync(p)'],
  'supervisor/worker-policy.ts': ['realpathSync,', 'return realpathSync(p)'],
  // a sub-thread's folder and its parent's (moved out of worker-policy.ts): folders only
  'supervisor/sub-thread-folder.ts': [
    "import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  // root's releases FOLDER (rooted-kit.ts rootedHookDir): the prefix a rooted session's hook script must be under
  'supervisor/rooted-kit.ts': [
    "import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'",
    'return realpathSync(releases)',
  ],
  'supervisor/worker-spec.ts': [
    "import { lstatSync, realpathSync } from 'node:fs'",
    'return realpathSync(i.talosHome)',
    'cwd = realpathSync(given)',
  ],
  'supervisor/workers-file.ts': ["import { readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'"],
  'supervisor/workers-wiring.ts': [
    "import { accessSync, constants, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
  'undo/busy.ts': ["import { realpathSync } from 'node:fs'", 'return realpathSync(p)'],
  'undo/snapshot.ts': [
    "import { copyFile, lstat, mkdtemp, readdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises'",
    'const real = await realpath(folder)',
    'return await realpath(abs)',
    'root = await realpath(folder)',
  ],
  'worker/inbox.ts': ['realpathSync,', 'mediaReal = realpathSync(o.mediaDir)'],
  'worker/patch-check.ts': ["import { realpathSync, statSync } from 'node:fs'", 'return realpathSync(p)'],
  'worker/project-settings.ts': [
    "import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'",
    'return realpathSync(p)',
  ],
}
// FILE realpaths the 2026-11-12 audit left as they are: each reads the file by the name it gets back, after checking that
// name (inside a folder, one of a few names), or keeps that name in a record; another name of the same file is the same bytes,
// and several of them refuse a file with more than one name outright. None writes to, deletes by, or roots a rule at that name,
// so another name there is a refusal or the same bytes. Move one to realFileSync when it is touched; never add one here.
const READ_SIDE_FILES: Record<string, string[]> = {
  'apps/captures.ts': [
    "import { closeSync, constants, fstatSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'",
    "const expectedDir = realpathSync(join(dirname(ctx.transcript_path), ctx.session_id, 'tool-results'))",
    'const real = realpathSync(path)',
  ],
  'doctor-mods.ts': [
    "import { constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'",
    'const real = realpathSync(abs)',
    'root = realpathSync(root)',
  ],
  'files/service.ts': [
    "import { closeSync, constants, promises as fsp, fstat, read, realpathSync, type Stats } from 'node:fs'",
    'return [foldPath(r), foldPath(realpathSync(r))]',
    'roots.push(foldPath(realpathSync(r)))',
    'real = await fsp.realpath(r)',
    'real = await fsp.realpath(join(root, ...parts))',
    'target = await fsp.realpath(at)',
    'const again = await fsp.realpath(join(root, ...parts))',
  ],
  'media.ts': [
    'realpathSync,',
    'const home = existsSync(this.p.home) ? realpathSync(this.p.home) : this.p.home',
    'if (existsSync(f) && realpathSync(f) === realPath) return true',
    'const realPath = realpathSync(path)',
    'const root = existsSync(this.p.inbox) ? realpathSync(this.p.inbox) : this.p.inbox',
    'const home = existsSync(this.p.home) ? realpathSync(this.p.home) : this.p.home',
    'const mediaDir = existsSync(this.p.media) ? realpathSync(this.p.media) : this.p.media',
  ],
  'memory/scope.ts': [
    'realpathSync,',
    'agentReal = realpathSync(cfg.agent_dir)',
    'const real = realpathSync(join(cfg.agent_dir, r.path))',
    'real = checkReal(realpathSync(abs))',
    'const again = checkReal(realpathSync(abs))',
    'const real = realpathSync(dir)',
    'if (realpathSync(realDir) !== realDir) return',
    'real = realpathSync(full)',
  ],
  'search/files.ts': [
    "import { closeSync, constants, existsSync, fstatSync, readSync, realpathSync } from 'node:fs'",
    'const real = realpathSync(path)',
    'const root = realpathSync(this.mediaDir) + sep',
  ],
}

/** Each source file's lines that name realpath, trimmed, comments left out. */
function realpathLines(src = SRC): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      // the helper itself is the one place a file's path is worked out
      else if (e.name.endsWith('.ts') && relative(src, p) !== 'real-file.ts')
        for (const raw of readFileSync(p, 'utf8').split('\n')) {
          const t = raw.trim()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
          const code = t.replace(/\s\/\/.*$/, '')
          if (!/\brealpath(Sync)?\b/.test(code)) continue
          const key = relative(src, p)
          out[key] = [...(out[key] ?? []), code]
        }
    }
  }
  walk(src)
  return out
}

describe('no new realpath of a file in apps/bridge/src (realFileSync instead)', () => {
  it('every line that names realpath is one known to take a folder, or a read the audit left', () => {
    const known: Record<string, string[]> = { ...FOLDER_ONLY }
    for (const [f, lines] of Object.entries(READ_SIDE_FILES)) known[f] = [...(known[f] ?? []), ...lines]
    const sorted = (o: Record<string, string[]>) =>
      Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, [...(o[k] as string[])].sort()]),
      )
    // a new line: a file's real path goes through realFileSync; a folder's is added to FOLDER_ONLY. A line gone: drop it here.
    expect(sorted(realpathLines())).toEqual(sorted(known))
  })
  it('the check sees a new one (a realpathSync, a .native, a promises realpath, an alias), and not a comment', () => {
    const d = tmp()
    mkdirSync(join(d, 'sub'))
    writeFileSync(
      join(d, 'sub', 'x.ts'),
      [
        "import { realpathSync as rp } from 'node:fs'",
        '// realpathSync(file) in a comment',
        ' * realpathSync(file) in a doc comment',
        'const a = realpathSync(file) // and a comment after',
        'const b = fs.realpathSync.native(file)',
        'const c = await fsp.realpath(file)',
        'const d = realpathOrAncestor(file)',
      ].join('\n'),
    )
    expect(realpathLines(d)).toEqual({
      'sub/x.ts': [
        "import { realpathSync as rp } from 'node:fs'",
        'const a = realpathSync(file)',
        'const b = fs.realpathSync.native(file)',
        'const c = await fsp.realpath(file)',
      ],
    })
  })
})
