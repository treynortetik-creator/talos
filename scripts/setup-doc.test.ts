// The setup docs make promises the code has to keep (audit D54, D57, D60): no alias instructions, every command a doc tells
// you to run exists in the CLI, every "off" state the Health page can show has a how-to, and the README reaches every app's
// page. Reads the source text only; nothing here starts a process.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const cliSource = read('apps/bridge/src/cli-main.ts')
const cliCommands = new Set([...cliSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1] as string))
// `help` is the one command with no `case`; search, memory and share are real cases, so deleting one fails the doc check.
cliCommands.add('help')

const docs = ['docs/SETUP.md', 'docs/bridge.md', 'docs/desktop.md', 'README.md']

describe('D54 the talos-app command is real', () => {
  it('SETUP.md and install.sh no longer tell you to make an alias', () => {
    expect(read('docs/SETUP.md')).not.toMatch(/alias talos-app/)
    expect(read('apps/bridge/scripts/install.sh')).not.toMatch(/alias talos-app/)
  })
  it('SETUP.md says how to start the agent with talos-app start, and the CLI has it', () => {
    expect(read('docs/SETUP.md')).toContain('talos-app start --agent-dir')
    expect(cliCommands.has('start')).toBe(true)
  })
})

describe('review fixes on #125', () => {
  it('SETUP.md Upgrading tells you to run pnpm install after pulling, and to restart the agent (D61)', () => {
    const doc = read('docs/SETUP.md')
    const i = doc.indexOf('## Upgrading')
    expect(i).toBeGreaterThan(-1)
    const section = doc.slice(i, doc.indexOf('\n## ', i + 5))
    expect(section).toContain('talos-app update')
    expect(section).toContain('pnpm install --frozen-lockfile')
    expect(section).toMatch(/Restart the agent/)
    expect(section).toMatch(/never restarts/)
    expect(doc).not.toContain('**Updating.**') // one place for it
  })
  it('the Mac app Sign in pane asks for --no-qr: it reads the link from visible rows and the QR would push it off screen', () => {
    expect(read('apps/desktop/Sources/TalosDesktop/Pairing.swift')).toContain(
      '"enroll", "--label", "Mac app", "--no-qr"',
    )
  })
})

describe('every `talos-app <command>` in the docs is a command the CLI has', () => {
  for (const doc of docs) {
    it(doc, () => {
      const mentioned = new Set([...read(doc).matchAll(/`talos-app ([a-z][a-z-]*)/g)].map((m) => m[1] as string))
      const unknown = [...mentioned].filter((c) => !cliCommands.has(c))
      expect(unknown).toEqual([])
    })
  }
})

describe('D57 every off state in the Health rows has a how-to in SETUP.md', () => {
  const rows = read('apps/web/src/features/health/rows.ts')
  const setup = read('docs/SETUP.md')
  it.each([
    ['Not installed', 'Talos mod'],
    ['Unknown while your Mac is offline', 'Talos mod'],
    ['Nobody can be alerted', 'Phone alerts'],
    ['Voice replies need a TTS command', 'voice'],
    ['no FTS5', 'search'],
    ['nearly full', 'storage and disk'],
    ['offline', 'Mac bridge'],
  ])('%s (%s)', (text) => {
    expect(setup).toContain(text)
  })
  it('every scheduler state the Health row can print has a how-to (not just the three that are easy to fix)', () => {
    const proto = read('packages/protocol/src/schedules.ts')
    const m = proto.match(/state: z\.enum\(\[([^\]]+)\]\)/)
    const states = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => (x[1] as string).replace('_', ' '))
    expect(states.length).toBeGreaterThanOrEqual(8)
    const row = setup.split('\n').filter((l) => l.startsWith('| Scheduler:'))
    expect(row.length).toBeGreaterThan(0)
    const text = row.join('\n')
    // "ok" needs no how-to
    for (const st of states.filter((x) => x !== 'ok')) expect(text).toContain(st)
  })
  it('the strings are still the ones the app shows', () => {
    for (const s of [
      'Not installed',
      'Unknown while your Mac is offline',
      'Nobody can be alerted',
      'FTS5',
      'Voice replies need a TTS command',
    ])
      expect(rows).toContain(s)
  })
  it('has a section for each thing Next steps promises', () => {
    for (const h of [
      '### Memory',
      '### Reindex',
      '### Ask rules',
      '### Schedules',
      '### The Talos mod',
      '## Pick your apps',
    ])
      expect(setup).toContain(h)
  })
})

describe('D60 the README reaches each app', () => {
  const readme = read('README.md')
  it.each(['docs/ios.md', 'docs/desktop.md', 'docs/SETUP.md'])('links %s and it exists', (p) => {
    expect(readme).toContain(`](${p})`)
    expect(existsSync(join(root, p))).toBe(true)
  })
  it('lists apps/desktop and apps/mobile in the repository table', () => {
    expect(readme).toContain('`apps/desktop`')
    expect(readme).toContain('`apps/mobile`')
  })
  it('SETUP.md has a Pick your apps section that links both app pages', () => {
    const setup = read('docs/SETUP.md')
    expect(setup).toContain('](ios.md)')
    expect(setup).toContain('](desktop.md)')
  })
})
