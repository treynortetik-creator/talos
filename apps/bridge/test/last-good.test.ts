// The last-good history of the agent's Claude Code setup: saved after a healthy start, put back by
// `talos-app restore-last-good`. Fictional data only; a temp folder per test; the clock is passed in.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { writeFileAtomic } from '../src/fsutil.ts'
import {
  agentDirFromEnv,
  LAST_GOOD_FILES,
  LAST_GOOD_KEEP,
  listVersions,
  restoreLastGood,
  saveLastGood,
  type Version,
} from '../src/last-good.ts'
import { DEFAULT_ASK_RULES } from '../src/permission/ask-rules.ts'
import { COMMANDS, runTalos } from '../src/talos.ts'

const roots: string[] = []
function world() {
  // tmpdir() can sit under a link (/var, /tmp -> /private): compare against the real path, as the code does
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lg')))
  roots.push(root)
  const agent = join(root, 'agent')
  const saved = join(root, 'home', 'last-good')
  mkdirSync(join(agent, '.claude'), { recursive: true })
  const put = (rel: string, body: string) => writeFileSync(join(agent, rel), body)
  const get = (rel: string) => readFileSync(join(agent, rel), 'utf8')
  const logs: string[] = []
  const log = { warn: (m: string) => logs.push(m), info: (m: string) => logs.push(m) }
  let t = Date.UTC(2026, 10, 2, 17, 0, 0)
  const now = () => {
    t += 60_000
    return new Date(t)
  }
  const save = () => saveLastGood({ agentDir: agent, dir: saved, log, now })
  return { root, agent, saved, put, get, logs, log, now, save }
}
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      chmodSync(join(r, 'agent', '.claude'), 0o700)
    } catch {}
    rmSync(r, { recursive: true, force: true })
  }
})

const MCP = '{"mcpServers":{"talos-app":{"command":"bun","args":["run","server.ts"]}}}\n'
const MCP2 = '{"mcpServers":{}}\n'
const SETTINGS = '{"permissions":{"ask":["Bash(git push *)"]}}\n'
const versions = (w: ReturnType<typeof world>) => listVersions(w.saved).versions

function io(answer = 'y', during?: () => void) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  return {
    out,
    err,
    asked,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async (q: string) => {
        asked.push(q)
        during?.()
        return answer
      },
    },
  }
}
const env = (w: ReturnType<typeof world>) => ({ TALOS_APP_HOME: join(w.root, 'home') })
const run = (w: ReturnType<typeof world>, args: string[], i: ReturnType<typeof io>) =>
  restoreLastGood(args, i.io, env(w))

describe('where the agent folder comes from', () => {
  test('TALOS_AGENT_DIR, when it is an absolute path; nothing else (not the working folder)', () => {
    expect(agentDirFromEnv({ TALOS_AGENT_DIR: '/home/alex/agent' })).toBe('/home/alex/agent')
    expect(agentDirFromEnv({})).toBeUndefined()
    expect(agentDirFromEnv({ TALOS_AGENT_DIR: '' })).toBeUndefined()
    expect(agentDirFromEnv({ TALOS_AGENT_DIR: 'relative/dir' })).toBeUndefined()
  })
})

describe('saving a version', () => {
  test('saves the files that parse into a timestamped folder that records where they came from, and nothing else', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.put('.claude/settings.json', SETTINGS)
    w.put('.claude/settings.local.json', '{"model":"x"}')
    w.put('.claude/notes.txt', 'private')
    w.put('CLAUDE.md', 'private')
    w.save()
    const [v] = versions(w)
    expect(versions(w).length).toBe(1)
    expect(v?.agentDir).toBe(w.agent)
    expect(v?.files).toEqual([...LAST_GOOD_FILES])
    expect(v?.savedAt).toBe('2026-11-02T17:01:00.000Z')
    expect(readFileSync(join(v?.path as string, '.mcp.json'), 'utf8')).toBe(MCP)
    expect(readFileSync(join(v?.path as string, '.claude', 'settings.json'), 'utf8')).toBe(SETTINGS)
    expect(readdirSync(v?.path as string).sort()).toEqual(['.claude', '.mcp.json', 'meta.json'])
    expect(readdirSync(join(v?.path as string, '.claude')).sort()).toEqual(['settings.json', 'settings.local.json'])
  })

  test('the folders are 0700, the copies 0600, and a loose existing last-good folder is tightened', () => {
    const w = world()
    mkdirSync(w.saved, { recursive: true, mode: 0o755 })
    chmodSync(w.saved, 0o755)
    w.put('.mcp.json', MCP)
    w.save()
    expect(statSync(w.saved).mode & 0o777).toBe(0o700)
    const v = versions(w)[0]?.path as string
    expect(statSync(v).mode & 0o777).toBe(0o700)
    expect(statSync(join(v, '.mcp.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(v, 'meta.json')).mode & 0o777).toBe(0o600)
  })

  test('the same content again saves nothing; changed content saves a new version', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.save()
    expect(versions(w).length).toBe(1)
    w.put('.mcp.json', MCP2)
    w.save()
    expect(versions(w).length).toBe(2)
  })

  test('a broken-but-parseable config is a new version and the older good one is still there', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', '{"mcpServers":{"talos-app":null,"other":{}}}')
    w.save()
    const vs = versions(w)
    expect(vs.length).toBe(2)
    expect(readFileSync(join(vs[1]?.path as string, '.mcp.json'), 'utf8')).toBe(MCP)
  })

  test('files of the wrong shape are not saved: .mcp.json not an object or mcpServers not an object, a settings file not an object', () => {
    for (const [rel, body] of [
      ['.mcp.json', '[]'],
      ['.mcp.json', '{"mcpServers":[]}'],
      ['.mcp.json', '"text"'],
      ['.claude/settings.json', '[1]'],
      ['.claude/settings.local.json', 'null'],
    ] as const) {
      const w = world()
      w.put(rel, body)
      w.save()
      expect(versions(w).length, `${rel} ${body}`).toBe(0)
      expect(w.logs.join('\n')).toContain('last-good')
    }
  })

  test('a file that does not parse is not saved, and says so in the log; older versions stay', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.put('.claude/settings.json', SETTINGS)
    w.save()
    w.put('.mcp.json', '')
    w.put('.claude/settings.json', '{"permissions": ')
    w.save()
    expect(versions(w).length).toBe(1)
    expect(w.logs.join('\n')).toContain('does not parse')
  })

  test('keeps the newest 10 distinct versions', () => {
    const w = world()
    for (let i = 0; i < LAST_GOOD_KEEP + 4; i++) {
      w.put('.mcp.json', `{"mcpServers":{"s${i}":{}}}`)
      w.save()
    }
    const vs = versions(w)
    expect(LAST_GOOD_KEEP).toBe(10)
    expect(vs.length).toBe(10)
    expect(readFileSync(join(vs[0]?.path as string, '.mcp.json'), 'utf8')).toContain('s13')
    expect(readFileSync(join(vs[9]?.path as string, '.mcp.json'), 'utf8')).toContain('s4')
  })

  test('restore backups never push out the newest 3 start versions', async () => {
    const w = world()
    for (let i = 0; i < 3; i++) {
      w.put('.mcp.json', `{"mcpServers":{"start${i}":{}}}`)
      w.save()
    }
    for (let i = 0; i < LAST_GOOD_KEEP + 4; i++) {
      const starts = versions(w).filter((v) => v.source === 'start')
      const pick: Version | undefined = starts[i % 2 === 0 ? starts.length - 1 : 0]
      if (!pick) break // every start version is gone: the assertions below say so
      const n = versions(w).findIndex((v) => v.name === pick.name) + 1
      expect(await run(w, ['--version', String(n), '--yes'], io())).toBe(0)
    }
    const vs = versions(w)
    const starts = vs.filter((v) => v.source === 'start')
    expect(vs.length).toBeLessThanOrEqual(LAST_GOOD_KEEP)
    expect(starts.map((v) => readFileSync(join(v.path, '.mcp.json'), 'utf8').match(/start\d/)?.[0])).toEqual([
      'start2',
      'start1',
      'start0',
    ])
  })

  test('skips a file that is not a regular file, and one over 1 MB', () => {
    const w = world()
    mkdirSync(join(w.agent, '.mcp.json'))
    w.put('.claude/settings.json', `{"pad":"${'x'.repeat(1024 * 1024)}"}`)
    w.put('.claude/settings.local.json', '{"model":"x"}')
    w.save()
    const [v] = versions(w)
    expect(v?.files).toEqual(['.claude/settings.local.json'])
    expect(w.logs.join('\n')).toContain('not saved')
  })

  test('a new version of the same content from another agent folder is kept apart', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    const other = join(w.root, 'agent2')
    mkdirSync(other)
    writeFileSync(join(other, '.mcp.json'), MCP)
    saveLastGood({ agentDir: other, dir: w.saved, log: w.log, now: w.now })
    expect(versions(w).map((v) => v.agentDir)).toEqual([other, w.agent])
  })

  test('never touches the agent folder, and leaves no temp file behind', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    const before = statSync(join(w.agent, '.mcp.json')).mtimeMs
    w.save()
    expect(statSync(join(w.agent, '.mcp.json')).mtimeMs).toBe(before)
    expect(readdirSync(w.agent).sort()).toEqual(['.claude', '.mcp.json'])
    expect(readdirSync(w.saved).filter((n) => n.includes('tmp'))).toEqual([])
  })

  test('a failed save only logs', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    mkdirSync(join(w.root, 'home'), { recursive: true })
    writeFileSync(w.saved, 'a file where the folder should be')
    expect(() => w.save()).not.toThrow()
    expect(w.logs.join('\n')).toContain('last-good')
  })

  test('a missing agent folder only logs', () => {
    const w = world()
    expect(() => saveLastGood({ agentDir: join(w.root, 'nope'), dir: w.saved, log: w.log })).not.toThrow()
  })

  test('writeFileAtomic removes its temp file when it fails', () => {
    const w = world()
    mkdirSync(join(w.root, 'dest'))
    expect(() => writeFileAtomic(join(w.root, 'dest'), 'x')).toThrow()
    expect(readdirSync(w.root).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('talos-app restore-last-good', () => {
  function two(w: ReturnType<typeof world>) {
    w.put('.mcp.json', MCP)
    w.put('.claude/settings.json', SETTINGS)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
  }

  test('with the current content equal to the newest version, it restores the one before it', async () => {
    const w = world()
    two(w)
    const i = io()
    expect(await run(w, [], i)).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP)
  })

  test('with a broken current file, it restores the newest version', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    expect(await run(w, [], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('lists the versions with dates and files, newest first, and --list changes nothing', async () => {
    const w = world()
    two(w)
    const i = io()
    expect(await run(w, ['--list'], i)).toBe(0)
    const text = i.out.join('\n')
    expect(text).toMatch(/1\..*2026-11-02 17:02/)
    expect(text).toMatch(/2\..*2026-11-02 17:01/)
    expect(text).toContain('.mcp.json')
    expect(text).toContain('.claude/settings.json')
    expect(i.asked).toEqual([])
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('the plan shown before the question lists the versions too', async () => {
    const w = world()
    two(w)
    const i = io('n')
    await run(w, [], i)
    expect(i.out.join('\n')).toContain('2026-11-02 17:01')
  })

  test('--version n restores that one; a number that is not in the list is refused', async () => {
    const w = world()
    two(w)
    expect(await run(w, ['--version', '2'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP)
    const i = io()
    expect(await run(w, ['--version', '99'], i)).toBe(1)
    expect(i.err.join('\n')).toContain('no version 99')
    expect(await run(w, ['--version', 'x'], io())).toBe(1)
  })

  test('writes into the folder recorded in the version, not the working folder', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    const cwdBefore = readdirSync(process.cwd()).sort()
    const i = io()
    expect(await restoreLastGood(['--yes'], i.io, env(w))).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore)
  })

  test('--agent-dir must match the recorded folder; another folder is refused and nothing is written', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    const other = join(w.root, 'elsewhere')
    mkdirSync(other)
    const i = io()
    expect(await restoreLastGood(['--yes', '--agent-dir', other], i.io, env(w))).toBe(1)
    expect(i.err.join('\n')).toContain(w.agent)
    expect(w.get('.mcp.json')).toBe('')
    expect(readdirSync(other)).toEqual([])
    expect(await restoreLastGood(['--yes', '--agent-dir', w.agent], io().io, env(w))).toBe(0)
  })

  test('the files it is about to replace are saved as a new version first, and --version brings them back exactly', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{ my half-written edit')
    expect(await run(w, ['--yes'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(versions(w).length).toBe(3)
    const undo = io()
    expect(await run(w, ['--yes', '--version', '1'], undo)).toBe(0)
    expect(w.get('.mcp.json')).toBe('{ my half-written edit')
  })

  test('the default restore never lands on a version that was saved before a restore', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{ broken')
    await run(w, ['--yes'], io())
    w.put('.mcp.json', '{ broken again')
    expect(await run(w, ['--yes'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('--file restores that file only', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    w.put('.claude/settings.json', '{"x":1}')
    expect(await run(w, ['--yes', '--file', '.claude/settings.json'], io())).toBe(0)
    expect(w.get('.claude/settings.json')).toBe(SETTINGS)
    expect(w.get('.mcp.json')).toBe('')
    const i = io()
    expect(await run(w, ['--yes', '--file', 'CLAUDE.md'], i)).toBe(1)
    expect(i.err.join('\n')).toContain('.mcp.json')
  })

  test('a file that changed after the plan was shown is not overwritten, and nothing is written or saved', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{"first":1}')
    w.put('.claude/settings.json', '{"x":1}')
    const i = io('y', () => w.put('.claude/settings.json', '{"edited while the question was open":1}'))
    expect(await run(w, [], i)).toBe(1)
    expect(i.err.join('\n')).toContain('changed')
    expect(w.get('.mcp.json')).toBe('{"first":1}')
    expect(w.get('.claude/settings.json')).toBe('{"edited while the question was open":1}')
    expect(versions(w).length).toBe(2)
  })

  test('a partial failure names the files written and the file that failed', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    w.put('.claude/settings.json', '{"x":1}')
    chmodSync(join(w.agent, '.claude'), 0o500)
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    expect(i.out.join('\n')).toMatch(/wrote.*\.mcp\.json/)
    expect(i.err.join('\n')).toContain('.claude/settings.json')
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(readdirSync(join(w.agent, '.claude')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  test('writes through a symlink: the link stays a link and the target changes', async () => {
    const w = world()
    two(w)
    const real = join(w.root, 'dotfiles-mcp.json')
    writeFileSync(real, '', { mode: 0o640 })
    rmSync(join(w.agent, '.mcp.json'))
    symlinkSync(real, join(w.agent, '.mcp.json'))
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(lstatSync(join(w.agent, '.mcp.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(w.agent, '.mcp.json'))).toBe(real)
    expect(readFileSync(real, 'utf8')).toBe(MCP2)
    expect(statSync(real).mode & 0o777).toBe(0o640)
    expect(i.out.join('\n')).toContain(`wrote .mcp.json (through the link to ${real})`)
    // the plan names the outside file before anything is written, so the owner approves the write they get
    const planned = i.out.findIndex((l) => l.includes(`this writes ${real}, outside the agent folder`))
    const wrote = i.out.findIndex((l) => l.includes('wrote .mcp.json (through the link'))
    expect(planned).toBeGreaterThan(-1)
    expect(planned).toBeLessThan(wrote)
  })

  test('a file link into a folder outside the agent folder is written through, for both setup files', async () => {
    for (const rel of ['.mcp.json', '.claude/settings.json'] as const) {
      const w = world()
      two(w)
      w.put('.claude/settings.json', '{"changed":true}\n')
      const outside = join(w.root, 'dotfiles', 'shared.json')
      mkdirSync(join(w.root, 'dotfiles'))
      writeFileSync(outside, '{}\n')
      rmSync(join(w.agent, rel))
      symlinkSync(outside, join(w.agent, rel))
      const i = io()
      expect(await run(w, ['--yes'], i)).toBe(0)
      expect(readlinkSync(join(w.agent, rel))).toBe(outside)
      expect(readFileSync(outside, 'utf8')).toBe(rel === '.mcp.json' ? MCP2 : SETTINGS)
      expect(i.out.join('\n')).toContain(`wrote ${rel} (through the link to ${outside})`)
    }
  })

  test('refuses to restore through a .claude that is a link to a folder outside the agent folder', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.json', '{"changed":true}\n')
    const outside = join(w.root, 'dotfiles-claude')
    renameSync(join(w.agent, '.claude'), outside)
    symlinkSync(outside, join(w.agent, '.claude'))
    const before = readFileSync(join(outside, 'settings.json'), 'utf8')
    const savedBefore = versions(w).length
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    const msg = i.err.join('\n')
    expect(msg).toContain('.claude is a symlink')
    expect(msg).toContain(outside)
    expect(msg).toContain('--file .mcp.json')
    expect(readFileSync(join(outside, 'settings.json'), 'utf8')).toBe(before)
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(versions(w).length).toBe(savedBefore)
    // a file outside .claude can still be restored
    expect(await run(w, ['--yes', '--file', '.mcp.json'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP)
  })

  test('a .claude that is a link to a folder inside the agent folder is restored through', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.json', '{"changed":true}\n')
    const inside = join(w.agent, 'config-claude')
    renameSync(join(w.agent, '.claude'), inside)
    symlinkSync(inside, join(w.agent, '.claude'))
    expect(await run(w, ['--yes'], io())).toBe(0)
    expect(readFileSync(join(inside, 'settings.json'), 'utf8')).toBe(SETTINGS)
  })

  test('a .mcp.json that is a dangling link inside the agent folder keeps the link and gets the file written at its target', async () => {
    const w = world()
    two(w)
    const target = join(w.agent, 'config', 'mcp.json')
    rmSync(join(w.agent, '.mcp.json'))
    symlinkSync(target, join(w.agent, '.mcp.json'))
    expect(await run(w, ['--yes'], io())).toBe(0)
    expect(lstatSync(join(w.agent, '.mcp.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(w.agent, '.mcp.json'))).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(MCP2)
  })

  test('a .mcp.json that is a dangling link to outside the agent folder is refused and nothing is created', async () => {
    const w = world()
    two(w)
    const target = join(w.root, 'dotfiles', 'mcp.json')
    rmSync(join(w.agent, '.mcp.json'))
    symlinkSync(target, join(w.agent, '.mcp.json'))
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    const msg = i.err.join('\n')
    expect(msg).toContain(join(w.agent, '.mcp.json'))
    expect(msg).toContain('outside the agent folder')
    expect(msg).toContain('Nothing was written')
    expect(msg).toContain(join(versions(w)[0]?.path ?? 'missing', '.mcp.json')) // the saved copy, to copy by hand
    expect(existsSync(join(w.root, 'dotfiles'))).toBe(false)
    expect(lstatSync(join(w.agent, '.mcp.json')).isSymbolicLink()).toBe(true)
  })

  test('a .claude that becomes a link outside while the question is open is caught before the write', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.json', '{"changed":true}\n')
    const outside = join(w.root, 'dotfiles-claude')
    const i = io('y', () => {
      renameSync(join(w.agent, '.claude'), outside) // same contents, so the "changed" check alone cannot tell
      symlinkSync(outside, join(w.agent, '.claude'))
    })
    expect(await run(w, [], i)).toBe(1)
    expect(i.err.join('\n')).toContain('.claude is a symlink')
    expect(readFileSync(join(outside, 'settings.json'), 'utf8')).toBe('{"changed":true}\n')
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('a .claude that is a broken link to outside the agent folder is refused up front, naming the link', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.json', '{"changed":true}\n')
    rmSync(join(w.agent, '.claude'), { recursive: true })
    const nowhere = join(w.root, 'nowhere', 'claude')
    symlinkSync(nowhere, join(w.agent, '.claude'))
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    const msg = i.err.join('\n')
    expect(msg).toContain(`${join(w.agent, '.claude')} is a symlink to ${nowhere}`)
    expect(msg).not.toMatch(/EEXIST|mkdir/)
    expect(existsSync(join(w.root, 'nowhere'))).toBe(false)
  })

  test('a sibling folder whose name starts with the agent folder name is outside it', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.json', '{"changed":true}\n')
    const sibling = join(w.root, 'agent-x', 'claude')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'settings.json'), 'keep\n')
    rmSync(join(w.agent, '.claude'), { recursive: true })
    symlinkSync(sibling, join(w.agent, '.claude'))
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    expect(i.err.join('\n')).toContain('outside the agent folder')
    expect(readFileSync(join(sibling, 'settings.json'), 'utf8')).toBe('keep\n')
  })

  test('asks y/N first, and a no changes nothing', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{}')
    const i = io('n')
    expect(await run(w, [], i)).toBe(1)
    expect(i.asked.length).toBe(1)
    expect(w.get('.mcp.json')).toBe('{}')
    expect(versions(w).length).toBe(2)
  })

  test('--yes does not ask', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{}')
    const i = io('n')
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(i.asked).toEqual([])
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('a saved copy that does not parse is refused, plainly, and nothing is written', async () => {
    const w = world()
    two(w)
    writeFileSync(join(versions(w)[0]?.path as string, '.claude', 'settings.json'), '{"permissions":')
    w.put('.mcp.json', '')
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    expect(i.err.join('\n')).toContain('does not parse')
    expect(w.get('.mcp.json')).toBe('')
  })

  test('a version folder with unreadable notes is skipped, not fatal', async () => {
    const w = world()
    two(w)
    mkdirSync(join(w.saved, '20260101T000000000Z'))
    writeFileSync(join(w.saved, '20260101T000000000Z', 'meta.json'), '{nope')
    w.put('.mcp.json', '')
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(i.out.concat(i.err).join('\n')).toContain('unreadable')
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('nothing saved yet says so', async () => {
    const w = world()
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(1)
    expect(i.err.join('\n')).toContain('nothing saved')
  })

  test('a folder already equal to the newest version, with no older one, says so and writes nothing', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    const i = io()
    expect(await run(w, [], i)).toBe(0)
    expect(i.asked).toEqual([])
    expect(i.out.join('\n')).toContain('Nothing to do')
  })

  const HOOK = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"exit 2"}]}]}}\n'

  test('a setup file that is not in the chosen version is named, moved aside after the y/N, and kept in the backup', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.local.json', HOOK)
    const i = io()
    expect(await run(w, [], i)).toBe(0)
    const shown = i.out.join('\n')
    expect(shown).toContain('.claude/settings.local.json')
    expect(shown).toMatch(/moved aside|not in this version/)
    expect(shown).not.toContain('already matches')
    expect(i.asked.length).toBe(1)
    expect(existsSync(join(w.agent, '.claude', 'settings.local.json'))).toBe(false)
    expect(w.get('.mcp.json')).toBe(MCP2) // the newest version: the extra file is what differs
    const backup = versions(w)[0]
    expect(backup?.source).toBe('restore')
    expect(readFileSync(join(backup?.path as string, '.claude', 'settings.local.json'), 'utf8')).toBe(HOOK)
  })

  test('a no leaves that extra file in place; --yes moves it without asking; --version brings it back', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.local.json', HOOK)
    expect(await run(w, [], io('n'))).toBe(1)
    expect(w.get('.claude/settings.local.json')).toBe(HOOK)
    const i = io('n')
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(i.asked).toEqual([])
    expect(existsSync(join(w.agent, '.claude', 'settings.local.json'))).toBe(false)
    expect(await run(w, ['--yes', '--version', '1'], io())).toBe(0)
    expect(w.get('.claude/settings.local.json')).toBe(HOOK)
  })

  test('the files that are there but not in the version are the only difference: still not "already matches"; --file limits it', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.claude/settings.local.json', HOOK)
    const i = io()
    expect(await run(w, ['--file', '.mcp.json'], i)).toBe(0)
    expect(w.get('.claude/settings.local.json')).toBe(HOOK) // not the file asked for
    expect(await run(w, ['--yes', '--file', '.claude/settings.local.json'], io())).toBe(0)
    expect(existsSync(join(w.agent, '.claude', 'settings.local.json'))).toBe(false)
  })

  test('an extra file that changes while the question is open is not moved', async () => {
    const w = world()
    two(w)
    w.put('.claude/settings.local.json', HOOK)
    const i = io('y', () => w.put('.claude/settings.local.json', '{"edited":1}'))
    expect(await run(w, [], i)).toBe(1)
    expect(w.get('.claude/settings.local.json')).toBe('{"edited":1}')
  })

  test('is dispatched by the talos-app entry', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    const i = io()
    const code = await runCli(['restore-last-good', '--yes'], i.io as never, env(w), undefined)
    expect(code).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('the list of files is exactly the three setup files', () => {
    expect([...LAST_GOOD_FILES]).toEqual(['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'])
  })
})

describe('a folder name far in the future cannot stall a save', () => {
  const FUTURE = '99991231T235959999Z'
  test('a 9999 folder exists: the save finishes at once, is named from the clock, and says it ignored the odd folder', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    mkdirSync(join(w.saved, FUTURE), { recursive: true })
    const t0 = Date.now()
    w.save()
    expect(Date.now() - t0).toBeLessThan(2000)
    const names = readdirSync(w.saved).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toBe('20261102T170100000Z')
    expect(w.logs.some((l) => l.includes('ignored') && l.includes(FUTURE))).toBe(true)
  })
  test('a restore does not hang on it either (the backup is named from the clock)', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
    mkdirSync(join(w.saved, FUTURE), { recursive: true })
    const t0 = Date.now()
    expect(await run(w, ['--yes'], io())).toBe(0)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(w.get('.mcp.json')).toBe(MCP)
  })
  test('a clock that went back a little (folder an hour ahead) still sorts the new version after it, in O(1)', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    const hourAhead = '20261102T180000000Z'
    mkdirSync(join(w.saved, hourAhead), { recursive: true })
    w.save()
    expect(readdirSync(w.saved).sort().pop()).toBe('20261102T180000001Z')
    expect(w.logs.filter((l) => l.includes('ignored'))).toEqual([])
  })
})

describe('a far-future folder is foreign everywhere', () => {
  const FUT = (i: number) => `9999123${i}T235959999Z`
  const seed = (w: ReturnType<typeof world>) => {
    for (let i = 0; i < 10; i++) mkdirSync(join(w.saved, FUT(i)), { recursive: true })
  }
  const printed = (i: ReturnType<typeof io>) => /saved as version (\d+)/.exec(i.out.join('\n'))?.[1]
  test('10 future folders, then a restore: the backup survives and is listed under the number printed', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    seed(w)
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    const n = Number(printed(i))
    expect(n).toBeGreaterThan(0)
    const list = versions(w)
    expect(list[n - 1]?.source).toBe('restore')
    expect(readFileSync(join(list[n - 1]?.path ?? '', '.mcp.json'), 'utf8')).toBe(MCP2)
    for (let k = 0; k < 10; k++) expect(existsSync(join(w.saved, FUT(k)))).toBe(true) // left alone, not deleted
  })
  test('a future folder never appears in --list, and is not counted as unreadable', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    seed(w)
    const i = io()
    expect(await run(w, ['--list'], i)).toBe(0)
    expect(i.out.join('\n')).not.toContain('9999')
    expect(i.out.join('\n')).not.toContain('unreadable')
    expect(
      versions(w)
        .map((v) => v.name)
        .some((n) => n.startsWith('9999')),
    ).toBe(false)
  })
  test('restoring a future folder by number is refused: the numbers cover real versions only', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    seed(w)
    const i = io()
    expect(await run(w, ['--version', '2', '--yes'], i)).toBe(1)
  })
  test('the printed number matches --list after a restore', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
    w.put('.mcp.json', SETTINGS)
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    const n = Number(printed(i))
    const l = io()
    await run(w, ['--list'], l)
    const lines = l.out.filter((x) => /^ {2}\d+\./.test(x))
    expect(lines[n - 1]).toContain('the files a restore replaced')
  })
  test('a save with 10 future folders does not trim itself away', () => {
    const w = world()
    w.put('.mcp.json', MCP)
    seed(w)
    w.save()
    expect(versions(w)).toHaveLength(1)
  })
})

describe('restore only suggests or picks start versions', () => {
  function withNewerBackup(w: ReturnType<typeof world>) {
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
    // a restore leaves a newer pre-restore backup holding what it replaced
    w.put('.mcp.json', '{"mcpServers":{"mine":{}}}\n')
  }
  test('with a newer backup present, the default pick is the newest start version, never the backup', async () => {
    const w = world()
    withNewerBackup(w)
    expect(await run(w, ['--yes'], io())).toBe(0) // writes MCP2, backs up "mine"
    expect(versions(w)[0]?.source).toBe('restore')
    w.put('.mcp.json', '{ broken')
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(i.out.join('\n')).toContain('will put back version 2')
  })
  test('when only a backup differs from the folder, the default says nothing to do instead of picking it', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', '{"mcpServers":{"mine":{}}}\n')
    await run(w, ['--yes'], io()) // folder is MCP again; the only newer version is the backup of "mine"
    expect(versions(w)[0]?.source).toBe('restore')
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP)
    expect(i.out.join('\n')).toContain('Nothing to do')
  })
  test('--version N on a backup still works and says it is a pre-restore backup', async () => {
    const w = world()
    withNewerBackup(w)
    await run(w, ['--yes'], io())
    const i = io()
    expect(await run(w, ['--yes', '--version', '1'], i)).toBe(0)
    expect(w.get('.mcp.json')).toBe('{"mcpServers":{"mine":{}}}\n')
    expect(i.out.join('\n')).toContain('version 1 is a pre-restore backup')
  })
  test('a start version by number carries no such line', async () => {
    const w = world()
    withNewerBackup(w)
    const i = io()
    expect(await run(w, ['--yes', '--version', '1'], i)).toBe(0)
    expect(i.out.join('\n')).not.toContain('pre-restore backup')
  })
})

describe('a restore through a link to a file outside the agent folder says so, even with --yes', () => {
  test('a warning line goes to the error output, naming the real file', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
    const real = join(w.root, 'dotfiles-mcp.json')
    writeFileSync(real, '{}\n')
    rmSync(join(w.agent, '.mcp.json'))
    symlinkSync(real, join(w.agent, '.mcp.json'))
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(readFileSync(real, 'utf8')).toBe(MCP2)
    expect(i.err.join('\n')).toContain(
      `warning: .mcp.json is a link, so this restore writes ${real}, outside the agent folder`,
    )
  })
  test('no warning when the file is inside the agent folder', async () => {
    const w = world()
    w.put('.mcp.json', MCP)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
    const i = io()
    expect(await run(w, ['--yes'], i)).toBe(0)
    expect(i.err).toEqual([])
  })
})

describe('talos-app restore-last-good --newest-start', () => {
  function two(w: ReturnType<typeof world>) {
    w.put('.mcp.json', MCP)
    w.put('.claude/settings.json', SETTINGS)
    w.save()
    w.put('.mcp.json', MCP2)
    w.save()
  }
  const whenOf = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

  test('with the folder equal to the newest start version it does nothing, and never falls back to an older one', async () => {
    const w = world()
    two(w)
    const i = io()
    expect(await run(w, ['--yes', '--newest-start'], i)).toBe(0)
    expect(i.out.join('\n')).toContain('Nothing to do')
    expect(w.get('.mcp.json')).toBe(MCP2)
    expect(versions(w).length).toBe(2)
    expect(i.asked).toEqual([])
  })

  test('with a different folder it puts back the newest start version', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '')
    expect(await run(w, ['--yes', '--newest-start'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('it never picks a restore backup, even when that is the newest version', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{"broken":')
    expect(await run(w, ['--yes'], io())).toBe(0) // writes a restore backup holding the broken file
    expect(versions(w)[0]?.source).toBe('restore')
    w.put('.mcp.json', '{}')
    expect(await run(w, ['--yes', '--newest-start'], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('it is refused together with --version or --file, and writes nothing', async () => {
    for (const other of [
      ['--version', '1'],
      ['--file', '.mcp.json'],
    ]) {
      const w = world()
      two(w)
      w.put('.mcp.json', '{}')
      const i = io()
      expect(await run(w, ['--yes', '--newest-start', ...other], i)).toBe(1)
      expect(i.err.join('\n')).toContain('--newest-start')
      expect(w.get('.mcp.json')).toBe('{}')
      expect(versions(w).length).toBe(2)
    }
  })

  test('with --agent-dir, a newest start version from another folder is refused, and no older version is tried', async () => {
    const w = world()
    two(w) // two versions from the agent folder
    const other = join(w.root, 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, '.mcp.json'), MCP)
    saveLastGood({ agentDir: other, dir: w.saved, log: w.log, now: w.now }) // the newest start version, from elsewhere
    w.put('.mcp.json', '{}')
    const i = io()
    expect(await run(w, ['--yes', '--newest-start', '--agent-dir', w.agent], i)).toBe(1)
    expect(i.err.join('\n')).toContain('was saved from')
    expect(i.err.join('\n')).toContain('Nothing was written')
    expect(w.get('.mcp.json')).toBe('{}')
    expect(versions(w).length).toBe(3)
  })

  test('with --agent-dir for the folder the newest start version came from, it restores', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{}')
    expect(await run(w, ['--yes', '--newest-start', '--agent-dir', w.agent], io())).toBe(0)
    expect(w.get('.mcp.json')).toBe(MCP2)
  })

  test('success prints one stable line: the files and the date saved', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{}')
    const i = io()
    expect(await run(w, ['--yes', '--newest-start'], i)).toBe(0)
    const at = whenOf(versions(w).find((v) => v.source === 'start')?.savedAt ?? '')
    expect(i.out.filter((l) => l.startsWith('restore-last-good: restored '))).toEqual([
      `restore-last-good: restored .mcp.json from the version saved ${at}`,
    ])
  })

  test('a file moved aside is named in that line', async () => {
    const w = world()
    two(w)
    w.put('.mcp.json', '{}')
    w.put('.claude/settings.local.json', SETTINGS)
    const i = io()
    expect(await run(w, ['--yes', '--newest-start'], i)).toBe(0)
    const at = whenOf(versions(w).find((v) => v.source === 'start')?.savedAt ?? '')
    expect(i.out).toContain(
      `restore-last-good: restored .mcp.json, .claude/settings.local.json (moved aside) from the version saved ${at}`,
    )
  })

  test('nothing to do prints no restored line', async () => {
    const w = world()
    two(w)
    const i = io()
    await run(w, ['--yes', '--newest-start'], i)
    expect(i.out.some((l) => l.startsWith('restore-last-good: restored '))).toBe(false)
  })
})

describe('restore-last-good is owner only and asks first', () => {
  const asks = (cmd: string) =>
    DEFAULT_ASK_RULES.some((rule) => {
      const inner = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? ''
      return new RegExp(
        `^${inner
          .split('*')
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ).test(cmd)
    })

  test('the ask rules match every spelling rollback has', () => {
    for (const cmd of [
      'talos-app restore-last-good',
      'talos-app restore-last-good --yes',
      '/home/alex/.local/bin/talos-app restore-last-good --yes',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts restore-last-good --yes',
      'bun run apps/bridge/src/cli.ts restore-last-good --dry-run',
      'bun /home/alex/talos/apps/bridge/src/cli.ts restore-last-good',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts  restore-last-good --yes',
      'bun run /home/alex/talos/apps/bridge/src/cli.ts "restore-last-good" --yes',
      "talos-app 'restore-last-good' --yes",
      'talos-app  restore-last-good --yes',
      '"talos-app" restore-last-good --yes',
      "'talos-app' restore-last-good --yes",
      'bun run "/home/alex/my repo/apps/bridge/src/cli.ts" restore-last-good --yes',
      "bun run '/home/alex/my repo/apps/bridge/src/cli.ts' restore-last-good --yes",
      'pnpm cli restore-last-good --yes',
      'bun run cli -- restore-last-good --yes',
      'pnpm cli -- restore-last-good --yes',
      'bun apps/bridge/src/cli.ts -- restore-last-good --yes',
      'talos-app -- restore-last-good --yes',
      'talos-app\trestore-last-good',
      'talos-app   restore-last-good',
      '"talos-app" "restore-last-good"',
      'bun run --cwd /home/alex/talos/apps/bridge --silent cli restore-last-good --yes',
      'cd /home/alex/talos && talos-app restore-last-good --yes',
      'talos-app "restore-last-good" --yes',
      'talos restore-last-good --yes',
      'talos restore-last-good',
      '/home/alex/.local/bin/talos restore-last-good --yes',
      'bun run /home/alex/talos/apps/bridge/src/talos.ts restore-last-good --yes',
      'bun run apps/bridge/src/talos.ts restore-last-good --dry-run',
      'bun /home/alex/talos/apps/bridge/src/talos.ts  restore-last-good',
      'bun run "/home/alex/my repo/apps/bridge/src/talos.ts" restore-last-good --yes',
      "bun run '/home/alex/my repo/apps/bridge/src/talos.ts' restore-last-good --yes",
      'bun apps/bridge/src/talos.ts -- restore-last-good --yes',
      '"talos" restore-last-good --yes',
      "talos 'restore-last-good' --yes",
      'talos\trestore-last-good',
      'talos -- restore-last-good --yes',
      'cd /home/alex/talos && talos restore-last-good --yes',
    ])
      expect(asks(cmd), cmd).toBe(true)
  })

  test('it does not ask on a command that only mentions the name later', () => {
    expect(asks('git add apps/bridge/src/cli.ts apps/bridge/src/last-good.ts')).toBe(false)
    expect(asks('git commit -m "talos-app note: restore-last-good"')).toBe(false)
    expect(asks('talos-app status --after restore-last-good')).toBe(false)
    for (const cmd of [
      'echo restore-last-good',
      'cat restore-last-good.txt',
      'git log --grep restore-last-good',
      'git add apps/bridge/src/Talos.ts apps/bridge/src/last-good.ts',
      'talos    status --after restore-last-good',
      'talos -- status restore-last-good',
    ])
      expect(asks(cmd), cmd).toBe(false)
  })

  test('talos commands lists it as owner only', async () => {
    const out: string[] = []
    const code = await runTalos(
      ['commands', '--json'],
      { out: (l: string) => out.push(l), err: () => {}, prompt: async () => '', sleep: async () => {}, now: () => 0 },
      {},
    )
    expect(code).toBe(0)
    const rows = JSON.parse(out.join('\n')).commands as Array<{ name: string; agent_may_run: boolean }>
    expect(rows.find((c) => c.name === 'restore-last-good')?.agent_may_run).toBe(false)
    expect(COMMANDS.find((c) => c.name === 'restore-last-good')?.agent_may_run).toBe(false)
  })
})
