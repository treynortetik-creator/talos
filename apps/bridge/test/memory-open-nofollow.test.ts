// Deterministic proof for the folder-flip hole: the swap is forced INSIDE the race window (after the checks, before the
// open) through the safe-open seam, so nothing here depends on load or timing.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryScope } from '../src/memory/scope.ts'
import { openResolvedNoFollow, openSeam } from '../src/safe-open.ts'

const SECRET = 'zzSECRETzz'
const cleanup: string[] = []
afterEach(() => {
  openSeam.beforeOpen = undefined
  openSeam.afterOpen = undefined
  openSeam.betweenRechecks = undefined
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture() {
  const agent = realpathSync(mkdtempSync(join(tmpdir(), 'talos-nf-')))
  cleanup.push(agent)
  const n = join(agent, 'notes')
  mkdirSync(join(n, 'a', 'b'), { recursive: true })
  mkdirSync(join(agent, 'outside', 'b'), { recursive: true })
  writeFileSync(join(n, 'a', 'b', 'f.md'), '# inside\n')
  writeFileSync(join(n, 'top.md'), '# top\n')
  writeFileSync(join(agent, 'outside', 'b', 'f.md'), `# out\n${SECRET}\n`)
  writeFileSync(join(agent, 'outside.md'), `# out\n${SECRET}\n`)
  const scope = new MemoryScope({
    version: 1,
    enabled: true,
    agent_dir: agent,
    roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md'], exclude: [] }],
    max_file_kb: 512,
  } as never)
  return { agent, n, scope }
}
const slurp = (fd: number) => {
  const b = Buffer.alloc(4096)
  return b.subarray(0, readSync(fd, b, 0, 4096, 0)).toString()
}

describe('open refuses a link in any path component, at the open itself', () => {
  test('top-level folder swapped for a symlink out of the root inside the window: nothing is served', () => {
    const { agent, n, scope } = fixture()
    openSeam.beforeOpen = () => {
      renameSync(join(n, 'a'), join(n, '.real'))
      symlinkSync(join(agent, 'outside'), join(n, 'a'))
    }
    expect(scope.open('notes', 'a/b/f.md')).toBeNull()
  })

  test('a DEEP intermediate folder swapped inside the window: nothing is served', () => {
    const { agent, n, scope } = fixture()
    openSeam.beforeOpen = () => {
      renameSync(join(n, 'a', 'b'), join(n, 'a', '.real'))
      symlinkSync(join(agent, 'outside', 'b'), join(n, 'a', 'b'))
    }
    expect(scope.open('notes', 'a/b/f.md')).toBeNull()
  })

  test('the exact CI leak: link at the open, clean at the realpath re-check, link again at the stat: nothing is served', () => {
    const { agent, n, scope } = fixture()
    const flipIn = () => {
      renameSync(join(n, 'a'), join(n, '.real'))
      symlinkSync(join(agent, 'outside'), join(n, 'a'))
    }
    const flipOut = () => {
      rmSync(join(n, 'a'))
      renameSync(join(n, '.real'), join(n, 'a'))
    }
    openSeam.beforeOpen = flipIn
    openSeam.afterOpen = flipOut
    openSeam.betweenRechecks = flipIn
    const o = scope.open('notes', 'a/b/f.md')
    if (o) expect(slurp(o.fd)).not.toContain(SECRET)
    expect(o).toBeNull()
  })

  test('the final file swapped for a symlink inside the window: nothing is served', () => {
    const { agent, n, scope } = fixture()
    openSeam.beforeOpen = () => {
      renameSync(join(n, 'top.md'), join(n, '.real'))
      symlinkSync(join(agent, 'outside.md'), join(n, 'top.md'))
    }
    expect(scope.open('notes', 'top.md')).toBeNull()
  })

  test('a second caller (allowed) is held to the same rule', () => {
    const { agent, n, scope } = fixture()
    openSeam.beforeOpen = () => {
      renameSync(join(n, 'a'), join(n, '.real'))
      symlinkSync(join(agent, 'outside'), join(n, 'a'))
    }
    expect(scope.allowed('notes', 'a/b/f.md')).toBe(false)
  })

  test('no swap: the same files still open, and the handle reads the inside file', () => {
    const { scope } = fixture()
    const o = scope.open('notes', 'a/b/f.md')
    expect(o).not.toBeNull()
    expect(slurp((o as { fd: number }).fd)).toContain('inside')
    o?.close()
  })

  test('the denylist runs on the resolved real path: a link into a hidden folder is refused', () => {
    const { n, scope } = fixture()
    mkdirSync(join(n, '.hidden'))
    writeFileSync(join(n, '.hidden', 'k.md'), SECRET)
    symlinkSync(join(n, '.hidden'), join(n, 'pub'))
    expect(scope.open('notes', 'pub/k.md')).toBeNull()
  })

  test('openResolvedNoFollow itself (the search attachment reader uses it): swapped folder -> throws, else opens', () => {
    const { agent, n } = fixture()
    const target = join(n, 'a', 'b', 'f.md')
    const fd = openResolvedNoFollow(target)
    expect(slurp(fd)).toContain('inside')
    closeSync(fd)
    openSeam.beforeOpen = () => {
      renameSync(join(n, 'a'), join(n, '.real'))
      symlinkSync(join(agent, 'outside'), join(n, 'a'))
    }
    expect(() => openResolvedNoFollow(target)).toThrow()
  })
})
