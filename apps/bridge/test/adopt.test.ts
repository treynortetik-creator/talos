// `talos-app adopt`: connect a Claude Code folder you already use. It may change .mcp.json and the app-catalog hooks in
// .claude/settings.local.json, and nothing else; it never runs the kit upgrade (it only says how). Owner only, in a terminal.

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { type CliIO, runCli } from '../src/cli-main.ts'
import { mcpEntry } from '../src/mcp-config.ts'
import { approvedFixture, tmp } from './apps/helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..')
const REPO = resolve(BRIDGE_DIR, '..', '..')

function run(argv: string[], opts: { home?: string; terminal?: boolean; answers?: string[]; userHome?: string } = {}) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const answers = [...(opts.answers ?? [])]
  const io: CliIO = {
    isTerminal: opts.terminal ?? true,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q) => {
      asked.push(q)
      return answers.shift() ?? 'n'
    },
    sleep: async () => {},
    now: () => Date.now(),
  }
  const env = {
    TALOS_APP_HOME: opts.home ?? tmp('adopt-home-'),
    TALOS_APP_RELAY_URL: 'https://relay.example.com',
    PATH: process.env.PATH,
    HOME: opts.userHome ?? tmp('adopt-user-'),
  }
  return runCli(argv, io, env).then((code) => ({ code, out: out.join('\n'), err: err.join('\n'), asked }))
}

/** Every file under dir (not .git) with its sha256, so "touches nothing else" is a comparison. */
function tree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name
    if (statSync(join(dir, r)).isDirectory()) Object.assign(out, tree(dir, r))
    else
      out[r] = createHash('sha256')
        .update(readFileSync(join(dir, r)))
        .digest('hex')
  }
  return out
}
const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()

/** A Claude Code folder with the owner's own files in every Yours place. */
function ownerFolder(extra: Record<string, string> = {}): string {
  const dir = tmp('adopt-agent-')
  const files: Record<string, string> = {
    'CLAUDE.md': '# Mine\nDo it my way.\n',
    'memory/STATE.md': 'owner state\n',
    'memory/notes/a.md': 'a note\n',
    'wiki/me.md': 'about me\n',
    '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nmy skill\n',
    ...extra,
  }
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  return dir
}
const mcpOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))

describe('talos-app adopt: a folder with no .mcp.json', () => {
  it('writes only .mcp.json (the talos-app server) and leaves CLAUDE.md, memory, wiki and skills byte-identical', async () => {
    const dir = ownerFolder()
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(0)
    expect(changed(before, tree(dir))).toEqual(['.mcp.json'])
    const entry = mcpOf(dir).mcpServers['talos-app']
    expect(entry.args).toEqual(mcpEntry(BRIDGE_DIR, '').args)
    expect(entry.env.TALOS_AGENT_DIR).toBe(resolve(dir))
    for (const f of ['CLAUDE.md', 'memory/STATE.md', 'wiki/me.md', '.claude/skills/mine/SKILL.md'])
      expect(tree(dir)[f]).toBe(before[f])
  })

  it('a dry run says what it would do and changes nothing', async () => {
    const dir = ownerFolder()
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--dry-run'], { answers: ['y'] })
    expect(r.code).toBe(0)
    expect(r.asked).toEqual([])
    expect(r.out).toContain('would')
    expect(tree(dir)).toEqual(before)
  })

  it('asks first, and "n" writes nothing; "y" writes', async () => {
    const dir = ownerFolder()
    const before = tree(dir)
    const no = await run(['adopt', '--agent-dir', dir], { answers: ['n'] })
    expect(no.code).toBe(0)
    expect(no.asked).toHaveLength(1)
    expect(no.out).toContain('Not written')
    expect(tree(dir)).toEqual(before)
    const yes = await run(['adopt', '--agent-dir', dir], { answers: ['y'] })
    expect(yes.code).toBe(0)
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true)
  })

  it('--yes does not ask, and a second run changes nothing and says so', async () => {
    const dir = ownerFolder()
    const home = tmp('adopt-home-')
    const first = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(first.asked).toEqual([])
    const after = tree(dir)
    const again = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(again.code).toBe(0)
    expect(again.out).toContain('already up to date')
    expect(tree(dir)).toEqual(after)
  })

  it('without app-catalog hooks it never creates .claude/settings.local.json', async () => {
    const dir = ownerFolder()
    await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('without a catalog the settings file is not touched at all, even a broken one', async () => {
    const dir = ownerFolder({ '.claude/settings.local.json': '{ not json' })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(0)
    expect(changed(before, tree(dir))).toEqual(['.mcp.json'])
  })
})

describe('talos-app adopt: a folder that has an .mcp.json', () => {
  it('keeps the other servers and top-level keys, and changes only .mcp.json', async () => {
    const other = { command: 'npx', args: ['-y', 'some-server'], env: { KEY: 'v' } }
    const dir = ownerFolder({ '.mcp.json': JSON.stringify({ mcpServers: { other }, extra: { keep: true } }, null, 2) })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(0)
    expect(changed(before, tree(dir))).toEqual(['.mcp.json'])
    const cfg = mcpOf(dir)
    expect(cfg.mcpServers.other).toEqual(other)
    expect(cfg.extra).toEqual({ keep: true })
    expect(cfg.mcpServers['talos-app'].command).toBe('bun')
  })

  it('invalid JSON: refuses, says so, and changes nothing', async () => {
    const dir = ownerFolder({ '.mcp.json': '{ "mcpServers": ' })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('not valid JSON')
    expect(tree(dir)).toEqual(before)
  })

  it('valid JSON that is not an object, or an mcpServers that is not an object: refuses, changes nothing', async () => {
    for (const text of ['[]', '"x"', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      const dir = ownerFolder({ '.mcp.json': text })
      const before = tree(dir)
      const r = await run(['adopt', '--agent-dir', dir, '--yes'])
      expect(r.code).toBe(1)
      expect(tree(dir)).toEqual(before)
    }
  })

  it('a talos-app entry that runs another clone is refused with exit 3, changing nothing', async () => {
    const foreign = {
      command: 'bun',
      args: ['run', '--cwd', '/home/alex/other-clone/apps/bridge', '--silent', 'start'],
    }
    const dir = ownerFolder({ '.mcp.json': JSON.stringify({ mcpServers: { 'talos-app': foreign } }) })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(3)
    expect(r.err).toContain('/home/alex/other-clone/apps/bridge')
    expect(r.err).toContain('--repoint')
    expect(tree(dir)).toEqual(before)
    const dry = await run(['adopt', '--agent-dir', dir, '--dry-run'])
    expect(dry.code).toBe(3)
    expect(tree(dir)).toEqual(before)
  })

  it('an entry whose shape cannot be read, or that uses another TALOS_APP_HOME, is refused the same way', async () => {
    const home = tmp('adopt-home-')
    const same = mcpEntry(BRIDGE_DIR, '/home/alex/other-home')
    for (const entry of [{ command: 'bun' }, same, { command: 'bun', args: 'run' }]) {
      const dir = ownerFolder({ '.mcp.json': JSON.stringify({ mcpServers: { 'talos-app': entry } }) })
      const before = tree(dir)
      const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
      expect(r.code).toBe(3)
      expect(tree(dir)).toEqual(before)
    }
  })

  it('an entry for this clone with no TALOS_APP_HOME, while this bridge uses a custom home, is foreign too', async () => {
    const entry = { command: 'bun', args: ['run', '--cwd', BRIDGE_DIR, '--silent', 'start'] }
    const dir = ownerFolder({ '.mcp.json': JSON.stringify({ mcpServers: { 'talos-app': entry } }) })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home: tmp('adopt-home-') })
    expect(r.code).toBe(3)
    expect(tree(dir)).toEqual(before)
  })

  it('--repoint is the owner saying yes: the entry moves to this clone and the other servers stay', async () => {
    const foreign = {
      command: 'bun',
      args: ['run', '--cwd', '/home/alex/other-clone/apps/bridge', '--silent', 'start'],
    }
    const other = { command: 'npx', args: ['x'] }
    const dir = ownerFolder({ '.mcp.json': JSON.stringify({ mcpServers: { 'talos-app': foreign, other } }) })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes', '--repoint'])
    expect(r.code).toBe(0)
    expect(changed(before, tree(dir))).toEqual(['.mcp.json'])
    expect(mcpOf(dir).mcpServers['talos-app'].args).toContain(BRIDGE_DIR)
    expect(mcpOf(dir).mcpServers.other).toEqual(other)
  })

  it('an entry that already runs this clone is fine, not foreign', async () => {
    const home = tmp('adopt-home-')
    const dir = ownerFolder({
      '.mcp.json': JSON.stringify({ mcpServers: { 'talos-app': mcpEntry(BRIDGE_DIR, home) } }),
    })
    const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(r.code).toBe(0)
  })
})

describe('talos-app adopt: app-catalog hooks', () => {
  it('with a catalog it adds the hooks to .claude/settings.local.json, keeps foreign hooks, and changes only the two files', async () => {
    const home = tmp('adopt-home-')
    await approvedFixture(home)
    const foreignHook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' }
    const dir = ownerFolder({ '.claude/settings.local.json': JSON.stringify(foreignHook) })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(r.code).toBe(0)
    expect(changed(before, tree(dir))).toEqual(['.claude/settings.local.json', '.mcp.json'])
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
    expect(s.hooks.Stop[0].hooks[0].command).toBe('echo mine')
    expect(s.hooks.PreToolUse).toBeDefined()
    expect(s.model).toBe('x')
  })

  it('an unreadable settings.local.json stops the whole adopt before .mcp.json is written', async () => {
    const home = tmp('adopt-home-')
    await approvedFixture(home)
    const dir = ownerFolder({ '.claude/settings.local.json': '{ nope' })
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(r.code).toBe(1)
    expect(r.err).toContain('settings.local.json')
    expect(tree(dir)).toEqual(before)
  })
})

describe('talos-app adopt: a kit 1.x folder', () => {
  const kit = (v: string) => ownerFolder({ '.talos-version': `${v}\n`, 'scripts/upgrade-marker.txt': 'old kit file\n' })

  it('is recognized, the update path is shown but not run, and nothing in the Yours zone moves', async () => {
    const dir = kit('1.1.0')
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('kit 1.x')
    expect(r.out).toContain('1.1.0')
    expect(r.out).toContain(`${join(REPO, 'kit', 'scripts', 'upgrade.sh')} --into ${resolve(dir)} --dry-run`)
    expect(changed(before, tree(dir))).toEqual(['.mcp.json'])
    expect(existsSync(`${dir}.backup`)).toBe(false)
  })

  it('a folder that is not kit 1.x, or has no .talos-version, gets no update offer', async () => {
    for (const dir of [kit('2.0.0'), ownerFolder()]) {
      const r = await run(['adopt', '--agent-dir', dir, '--yes'])
      expect(r.out).not.toContain('kit 1.x')
      expect(r.out).not.toContain('upgrade.sh')
    }
  })
})

describe('talos-app adopt: refusals and the terminal gate', () => {
  it('a folder that is missing, a file, or the home folder is refused', async () => {
    const home = tmp('adopt-user-')
    const file = join(tmp('adopt-agent-'), 'afile')
    writeFileSync(file, 'x')
    expect((await run(['adopt', '--agent-dir', join(home, 'nope'), '--yes'])).code).toBe(1)
    expect((await run(['adopt', '--agent-dir', file, '--yes'])).code).toBe(1)
    const r = await run(['adopt', '--agent-dir', home, '--yes'], { userHome: home })
    expect(r.code).toBe(1)
    expect(readdirSync(home)).toEqual([])
  })

  it('--agent-dir is required', async () => {
    expect((await run(['adopt', '--yes'])).code).toBe(1)
  })

  it('without a terminal it refuses, even with --yes or --dry-run, and writes nothing', async () => {
    for (const extra of [['--yes'], ['--dry-run'], []]) {
      const dir = ownerFolder()
      const before = tree(dir)
      const r = await run(['adopt', '--agent-dir', dir, ...extra], { terminal: false, answers: ['y'] })
      expect(r.code).toBe(1)
      expect(r.err).toContain('only runs in Terminal')
      expect(tree(dir)).toEqual(before)
    }
  })
})

describe('talos-app adopt: links and failed writes', () => {
  const withCatalog = async () => {
    const home = tmp('adopt-home-')
    await approvedFixture(home)
    return home
  }

  it('a .claude folder, settings.local.json or .mcp.json that is a link is refused, and nothing outside the folder is written', async () => {
    const home = await withCatalog()
    for (const make of [
      (dir: string, out: string) => {
        rmSync(join(dir, '.claude'), { recursive: true })
        symlinkSync(out, join(dir, '.claude'))
      },
      (dir: string, out: string) => {
        writeFileSync(join(out, 'settings.local.json'), '{}')
        symlinkSync(join(out, 'settings.local.json'), join(dir, '.claude', 'settings.local.json'))
      },
      (dir: string, out: string) => {
        writeFileSync(join(out, 'real.json'), '{}')
        symlinkSync(join(out, 'real.json'), join(dir, '.mcp.json'))
      },
    ]) {
      const dir = ownerFolder()
      const outside = tmp('adopt-outside-')
      make(dir, outside)
      const outsideBefore = tree(outside)
      const before = tree(dir)
      const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
      expect(r.code).toBe(1)
      expect(r.err).toContain('link')
      expect(tree(outside)).toEqual(outsideBefore)
      expect(tree(dir)).toEqual(before)
    }
  })

  it('a hooks file that cannot be written stops the adopt before .mcp.json is written', async () => {
    const home = await withCatalog()
    const dir = ownerFolder()
    chmodSync(join(dir, '.claude'), 0o500)
    try {
      const before = tree(dir)
      const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
      expect(r.code).toBe(1)
      expect(r.err).toContain('.claude')
      expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
      expect(tree(dir)).toEqual(before)
    } finally {
      chmodSync(join(dir, '.claude'), 0o700)
    }
  })

  it('a .claude that is a file stops the adopt before .mcp.json is written, and says so plainly', async () => {
    const home = await withCatalog()
    const dir = ownerFolder()
    rmSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude'), 'not a folder\n')
    const before = tree(dir)
    const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
    expect(r.code).toBe(1)
    expect(r.err).toContain('.claude is a file, not a folder')
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    expect(tree(dir)).toEqual(before)
  })

  it('a settings.local.json or .mcp.json that is a folder is said to be a folder, not bad JSON', async () => {
    const home = await withCatalog()
    for (const rel of [join('.claude', 'settings.local.json'), '.mcp.json']) {
      const dir = ownerFolder()
      mkdirSync(join(dir, rel))
      const r = await run(['adopt', '--agent-dir', dir, '--yes'], { home })
      expect(r.code).toBe(1)
      expect(r.err).toContain('is a folder, not a file')
      expect(r.err).not.toContain('valid JSON')
      expect(existsSync(join(dir, '.mcp.json', 'x'))).toBe(false)
    }
  })
})
