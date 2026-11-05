// WP-C1: `talos-app install-ask-rules` and the doctor warnings (docs/CLAUDE-CODE.md C3.1, C3.5). Every path is a temp dir:
// nothing here reads or writes the real ~/.claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { DEFAULT_ASK_RULES } from '../src/permission/ask-rules.ts'
import { type Harness, startHarness } from './helpers.ts'

const tmp = (p = 'cc-c1-cli-') => mkdtempSync(join(tmpdir(), p))
function cliIO(answer = 'n') {
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
        return answer
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
const settings = (dir: string) => join(dir, '.claude', 'settings.json')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('install-ask-rules', () => {
  test('--dry-run shows the diff and writes nothing, and never asks', async () => {
    const agent = tmp()
    const c = cliIO('y')
    expect(await runCli(['install-ask-rules', '--agent-dir', agent, '--dry-run'], c.io)).toBe(0)
    expect(existsSync(settings(agent))).toBe(false)
    expect(c.asked).toEqual([])
    expect(c.out.join('\n')).toContain('+ Bash(git push *)')
    expect(c.out.join('\n')).toContain('dry run: nothing was written')
  })

  test('without --dry-run it asks, and anything but y writes nothing', async () => {
    const agent = tmp()
    for (const answer of ['n', '', 'maybe', 'yes please']) {
      const c = cliIO(answer)
      expect(await runCli(['install-ask-rules', '--agent-dir', agent], c.io)).toBe(0)
      expect(c.asked).toHaveLength(1)
      expect(existsSync(settings(agent))).toBe(false)
    }
  })

  test('on y it writes the default rules under permissions.ask and keeps every other key and entry', async () => {
    const agent = tmp()
    mkdirSync(join(agent, '.claude'))
    writeFileSync(
      settings(agent),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls *)'], ask: ['Bash(git push *)', 'Bash(my own *)'], deny: ['Read(.env)'] },
        hooks: { Stop: [] },
      }),
    )
    const c = cliIO('y')
    expect(await runCli(['install-ask-rules', '--agent-dir', agent], c.io)).toBe(0)
    const cfg = read(settings(agent))
    expect(cfg.model).toBe('opus')
    expect(cfg.hooks).toEqual({ Stop: [] })
    expect(cfg.permissions.allow).toEqual(['Bash(ls *)'])
    expect(cfg.permissions.deny).toEqual(['Read(.env)'])
    expect(cfg.permissions.ask.slice(0, 2)).toEqual(['Bash(git push *)', 'Bash(my own *)'])
    expect(new Set(cfg.permissions.ask)).toEqual(new Set(['Bash(my own *)', ...DEFAULT_ASK_RULES]))
    expect(cfg.permissions.ask.length).toBe(new Set(cfg.permissions.ask).size)
    // the rules cover deploys, publishes/sends, deletes and force-pushes
    for (const r of [
      'Bash(git push *)',
      'Bash(rm -rf *)',
      'Bash(* deploy *)',
      'Bash(npm publish *)',
      'Bash(gh pr merge *)',
    ])
      expect(cfg.permissions.ask).toContain(r)
  })

  test('a second run is a no-op', async () => {
    const agent = tmp()
    await runCli(['install-ask-rules', '--agent-dir', agent], cliIO('y').io)
    const before = readFileSync(settings(agent), 'utf8')
    const c = cliIO('y')
    expect(await runCli(['install-ask-rules', '--agent-dir', agent], c.io)).toBe(0)
    expect(c.asked).toEqual([])
    expect(c.out.join('\n')).toContain('already up to date')
    expect(readFileSync(settings(agent), 'utf8')).toBe(before)
  })

  test('invalid JSON or a wrong shape stops the command and leaves the file byte for byte', async () => {
    for (const body of ['{not json', '[]', '{"permissions": 3}', '{"permissions": {"ask": "x"}}']) {
      const agent = tmp()
      mkdirSync(join(agent, '.claude'))
      writeFileSync(settings(agent), body)
      const c = cliIO('y')
      expect(await runCli(['install-ask-rules', '--agent-dir', agent], c.io)).toBe(1)
      expect(c.err.join('\n')).toContain('nothing was changed')
      expect(readFileSync(settings(agent), 'utf8')).toBe(body)
      expect(c.asked).toEqual([])
    }
  })

  test('--scope user edits only the --claude-dir you name', async () => {
    const agent = tmp()
    const claudeDir = tmp('cc-c1-user-')
    const c = cliIO('y')
    expect(
      await runCli(['install-ask-rules', '--agent-dir', agent, '--scope', 'user', '--claude-dir', claudeDir], c.io),
    ).toBe(0)
    expect(read(join(claudeDir, 'settings.json')).permissions.ask).toEqual([...DEFAULT_ASK_RULES])
    expect(existsSync(settings(agent))).toBe(false)
  })

  test('usage errors', async () => {
    expect(await runCli(['install-ask-rules'], cliIO().io)).toBe(1)
    expect(await runCli(['install-ask-rules', '--agent-dir', tmp(), '--scope', 'global'], cliIO().io)).toBe(1)
  })
})

describe('doctor: the permission relay', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.stop()
    h = undefined
  })
  const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })

  async function doctor(opts: {
    relay?: boolean
    claudeSettings?: object
    agentSettings?: object
    agentLocalSettings?: object
    procs?: string[]
  }) {
    h = await startHarness({ startBridge: false, config: (c) => ({ ...c, permission_relay: opts.relay ?? false }) })
    const agent = tmp()
    const claudeDir = tmp('cc-c1-user-')
    await runCli(['install-mcp', '--agent-dir', agent], cliIO().io, env(h))
    if (opts.claudeSettings) writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(opts.claudeSettings))
    if (opts.agentSettings || opts.agentLocalSettings) mkdirSync(join(agent, '.claude'))
    if (opts.agentSettings) writeFileSync(settings(agent), JSON.stringify(opts.agentSettings))
    if (opts.agentLocalSettings)
      writeFileSync(join(agent, '.claude', 'settings.local.json'), JSON.stringify(opts.agentLocalSettings))
    const c = cliIO()
    const code = await runCli(['doctor', '--agent-dir', agent, '--claude-dir', claudeDir], c.io, env(h), {
      processes: () => opts.procs ?? [],
    })
    return { code, text: c.out.join('\n') }
  }

  test('warns when another channel plugin is enabled in the user settings', async () => {
    const r = await doctor({
      relay: true,
      claudeSettings: { enabledPlugins: { 'imessage@claude-plugins-official': true } },
    })
    expect(r.text).toMatch(/warn\s+other relaying channels: imessage loaded/)
    expect(r.text).toContain('weakest')
    expect(r.code).toBe(0) // a warning, not a failure
  })

  test('warns when a running claude command line has --channels plugin:imessage@…', async () => {
    const r = await doctor({
      relay: true,
      procs: ['claude --channels plugin:imessage@claude-plugins-official --channels server:talos-app'],
    })
    expect(r.text).toMatch(/warn\s+other relaying channels: imessage/)
  })

  test('a disabled plugin and Talos alone are not a warning', async () => {
    const r = await doctor({
      relay: true,
      claudeSettings: { enabledPlugins: { 'imessage@x': false } },
      procs: ['claude --dangerously-load-development-channels server:talos-app'],
    })
    expect(r.text).toContain('other relaying channels: none found')
  })

  test('relay on with no ask rules warns that nothing will reach the phone; with rules it is ok', async () => {
    const none = await doctor({ relay: true })
    expect(none.text).toMatch(/warn\s+ask rules:/)
    const has = await doctor({ relay: true, agentSettings: { permissions: { ask: [...DEFAULT_ASK_RULES] } } })
    expect(has.text).toMatch(/ok\s+ask rules: permissions.ask is set/)
  })

  test('relay on with an older, shorter ask list says to run install-ask-rules again and names what is missing', async () => {
    const old = DEFAULT_ASK_RULES.slice(0, 3)
    const r = await doctor({ relay: true, agentSettings: { permissions: { ask: [...old] } } })
    expect(r.text).toMatch(/warn\s+ask rules:/)
    expect(r.text).toContain('install-ask-rules')
    expect(r.text).toContain(DEFAULT_ASK_RULES[3] as string)
    expect(r.text).not.toContain(old[0] as string)
    // rules split between the agent folder and the user's settings still count together
    const split = await doctor({
      relay: true,
      agentSettings: { permissions: { ask: [...DEFAULT_ASK_RULES.slice(0, 5)] } },
      claudeSettings: { permissions: { ask: [...DEFAULT_ASK_RULES.slice(5)] } },
    })
    expect(split.text).toMatch(/ok\s+ask rules: permissions.ask is set/)
  })

  test('rules in the project settings.local.json count, and an older spelling of the same rule (git push:*) counts', async () => {
    const local = await doctor({
      relay: true,
      agentSettings: { permissions: { ask: [...DEFAULT_ASK_RULES.slice(0, 5)] } },
      agentLocalSettings: { permissions: { ask: [...DEFAULT_ASK_RULES.slice(5)] } },
    })
    expect(local.text).toMatch(/ok\s+ask rules: permissions.ask is set/)
    const older = DEFAULT_ASK_RULES.map((r) => (r === 'Bash(git push *)' ? 'Bash(git push:*)' : r))
    const spelled = await doctor({ relay: true, agentSettings: { permissions: { ask: older } } })
    expect(spelled.text).toMatch(/ok\s+ask rules: permissions.ask is set/)
  })

  test('an install whose list has no rollback rule is told rollback reaches nobody, in its own words', async () => {
    const noRollback = DEFAULT_ASK_RULES.filter((r) => !r.includes('rollback'))
    const r = await doctor({ relay: true, agentSettings: { permissions: { ask: noRollback } } })
    expect(r.text).toMatch(/warn\s+ask rules:.*rollback/)
    expect(r.text).toContain('install-ask-rules')
  })

  test('an install whose list has no restore-last-good rule is told so, in its own words', async () => {
    const without = DEFAULT_ASK_RULES.filter((r) => !r.includes('restore-last-good'))
    const r = await doctor({ relay: true, agentSettings: { permissions: { ask: without } } })
    expect(r.text).toMatch(/warn\s+ask rules:.*restore-last-good among them/)
    expect(r.text).not.toMatch(/rollback among them/)
    const both = DEFAULT_ASK_RULES.filter((r) => !r.includes('restore-last-good') && !r.includes('rollback'))
    const b = await doctor({ relay: true, agentSettings: { permissions: { ask: both } } })
    expect(b.text).toMatch(/rollback and restore-last-good among them/)
  })

  test('a talos-app entry with no TALOS_AGENT_DIR is told last-good is not saving, and to run install-mcp again', async () => {
    h = await startHarness({ startBridge: false })
    const agent = tmp()
    await runCli(['install-mcp', '--agent-dir', agent], cliIO().io, env(h))
    const ok = cliIO()
    await runCli(['doctor', '--agent-dir', agent, '--claude-dir', tmp('cc-c1-user-')], ok.io, env(h), {
      processes: () => [],
    })
    expect(ok.out.join('\n')).not.toContain('last-good')
    const cfg = JSON.parse(readFileSync(join(agent, '.mcp.json'), 'utf8'))
    delete cfg.mcpServers['talos-app'].env.TALOS_AGENT_DIR
    writeFileSync(join(agent, '.mcp.json'), JSON.stringify(cfg))
    const old = cliIO()
    await runCli(['doctor', '--agent-dir', agent, '--claude-dir', tmp('cc-c1-user-')], old.io, env(h), {
      processes: () => [],
    })
    expect(old.out.join('\n')).toMatch(/warn\s+last-good:.*not saving.*install-mcp/)
  })

  test('relay off: no ask-rules line at all', async () => {
    const r = await doctor({ relay: false })
    expect(r.text).not.toContain('ask rules')
  })
})
