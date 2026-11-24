// A lead folder as the real `lead init --sandbox` makes it must start with the extra lock on, and a hook edited by one byte must not.
// The lead's hook scripts pass only as regular files directly in <folder>/.claude/hooks that are byte for byte the kit's templates in the
// recorded clone (<clone>/kit/templates/lead). The home, the user home and the folder are throwaway folders in the test temp tree.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { paths } from '../src/config.ts'
import { osSandboxPreflight, prepareOsSandbox, readOsSandboxSwitch } from '../src/guards/os-sandbox.ts'
import { folderKitProblem } from '../src/guards/os-sandbox-folder.ts'
import { cmdLead } from '../src/lead/cli.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}
const BRIDGE = resolve(import.meta.dir, '..')
const TRUSTED = { bun: process.execPath, bridgeDir: BRIDGE }

/** The real lead init (--sandbox) into a throwaway Talos home, user home and folder; then the extra lock turned on. */
function leadFolder() {
  const talosHome = tmp('tsl-home-')
  const agentDir = tmp('tsl-agent-')
  writeFileSync(join(agentDir, '.talos-version'), '1')
  const userHome = tmp('tsl-user-')
  const dir = join(userHome, 'leads', 'trip')
  const claudeDir = join(userHome, '.claude')
  const cfg = {
    ...defaultConfig,
    threads: [
      ...(defaultConfig as { threads: unknown[] }).threads,
      {
        id: 'trip',
        name: 'Trip',
        kind: 'agent',
        order: 9,
        notify: 'all',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(paths(talosHome).configJson, JSON.stringify(cfg))
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), isTerminal: true }
  const code = cmdLead(
    { home: talosHome } as never,
    ['init', 'trip', '--folder', dir, '--agent-dir', agentDir, '--sandbox'],
    io,
    {
      home: userHome,
      claudeDir,
      pathDirs: [],
    },
  )
  expect(code, lines.join('\n')).toBe(0)
  writeFileSync(paths(talosHome).configJson, JSON.stringify({ ...cfg, os_sandbox: true }))
  const start = (trusted: typeof TRUSTED | null = TRUSTED) =>
    prepareOsSandbox(
      { talosHome, userHome, folder: dir, claudeDir, trusted },
      { ownerExcludes: () => [], write: () => {} },
    )
  return { talosHome, userHome, dir, claudeDir, start }
}
const refusal = (r: ReturnType<ReturnType<typeof leadFolder>['start']>) => ('refusal' in r ? r.refusal : null)

describe('a lead folder made by `lead init --sandbox`, with the extra lock on', () => {
  test('passes the home’s preflight, and the settings are built: it starts', () => {
    const w = leadFolder()
    expect(readOsSandboxSwitch(w.talosHome)).toBe(true)
    expect(osSandboxPreflight(w.talosHome)).toBeNull()
    const r = w.start()
    expect(refusal(r)).toBeNull()
    const p = 'pieces' in r ? r.pieces : null
    expect(p?.sandbox.enabled).toBe(true)
    expect(p?.sandbox.filesystem.denyWrite).toContain(join(w.dir, '.claude'))
    // the lead's own settings carry the two hooks the kit's templates make
    const settings = JSON.parse(readFileSync(join(w.dir, '.claude', 'settings.json'), 'utf8')) as {
      sandbox: { allowUnsandboxedCommands: boolean }
    }
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false)
  })

  test('a hook script edited by one byte is refused, naming it', () => {
    const w = leadFolder()
    appendFileSync(join(w.dir, '.claude', 'hooks', 'board-stop.sh'), '#')
    expect(refusal(w.start())).toContain('board-stop.sh')
    expect(refusal(w.start())).toContain("which is not the kit's own")
  })

  test('without a recorded bridge the lead’s hooks are refused', () => {
    const w = leadFolder()
    expect(refusal(w.start(null))).toContain("which is not the kit's own")
  })

  test('a hook that is a link, or a hard-linked copy elsewhere, is not the template file in place', () => {
    const w = leadFolder()
    const hook = join(w.dir, '.claude', 'hooks', 'turn-start.sh')
    const body = readFileSync(hook)
    rmSync(hook)
    const elsewhere = join(tmp('tsl-else-'), 'turn-start.sh')
    writeFileSync(elsewhere, body)
    symlinkSync(elsewhere, hook)
    expect(refusal(w.start())).not.toBeNull()
    rmSync(hook)
    writeFileSync(hook, body)
    linkSync(hook, join(tmp('tsl-else-'), 'twin'))
    expect(refusal(w.start())).toContain('has another name')
  })

  test('a script of the same name in another folder under .claude does not count', () => {
    const w = leadFolder()
    mkdirSync(join(w.dir, '.claude', 'own'), { recursive: true })
    writeFileSync(
      join(w.dir, '.claude', 'own', 'turn-start.sh'),
      readFileSync(join(w.dir, '.claude', 'hooks', 'turn-start.sh')),
    )
    const s = join(w.dir, '.claude', 'settings.json')
    const j = JSON.parse(readFileSync(s, 'utf8')) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> }
    }
    const h = j.hooks.UserPromptSubmit[0]?.hooks[0]
    if (h) h.command = h.command.replace('/.claude/hooks/', '/.claude/own/')
    writeFileSync(s, JSON.stringify(j))
    expect(refusal(w.start())).toContain("which is not the kit's own")
  })
})

describe('the kit link is required only when a command names the folder’s own hooks/ or scripts/', () => {
  test('a command in .claude/hooks does not need a hooks link; one in <folder>/hooks does', () => {
    const w = leadFolder()
    expect(folderKitProblem(w.dir)).toBeNull() // real lead: commands name .claude/hooks/...
    const s = join(w.dir, '.claude', 'settings.json')
    writeFileSync(
      s,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/hooks/x.sh' }] }] },
      }),
    )
    expect(folderKitProblem(w.dir)).toContain('hooks is missing')
    writeFileSync(
      s,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash scripts/x.sh' }] }] } }),
    )
    expect(folderKitProblem(w.dir)).toContain('scripts is missing')
  })
})
