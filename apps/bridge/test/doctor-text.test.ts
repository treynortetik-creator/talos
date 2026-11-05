import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
const realHome = process.env.HOME
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR
afterEach(async () => {
  await h?.stop()
  h = undefined
  // A temp HOME is set per test below; put the real one back.
  if (realHome === undefined) process.env.HOME = undefined
  else process.env.HOME = realHome
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = realClaudeDir
})

/** A HOME with nothing in it, so the doctor never reads the developer's own ~/.claude/settings.json. */
function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'talos-home-'))
  mkdirSync(join(home, '.claude'))
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  return join(home, '.claude') // also passed as --claude-dir: that flag is what the doctor's settings read follows
}

/** Replaces the parts that differ per run (temp paths, ports, the key, the Bun version) with fixed names. */
function normalise(lines: string[], parts: Record<string, string>): string[] {
  return lines.map((l) => {
    let s = l
    for (const [from, to] of Object.entries(parts)) s = s.split(from).join(to)
    return s
  })
}

/** The Bun and MCP SDK versions and the Codex line depend on the machine; the floor in "(needs >= 1.3.11)" is fixed text and stays. */
function stabilise(l: string): string {
  if (l.startsWith('ok    codex (optional):')) return 'ok    codex (optional): <varies>'
  return l
    .replace(`bun version: ${Bun.version} `, 'bun version: <bun> ')
    .replace(/^(ok {4}|warn {2}|FAIL {2})MCP SDK version: \S+ /, '$1MCP SDK version: <sdk> ')
}

describe('talos-app doctor text', () => {
  test('prints exactly these lines for a healthy setup', async () => {
    const claudeDir = emptyHome()
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const env = { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl }
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    await runCli(['install-mcp', '--agent-dir', agent], { ...io, out: () => {} }, env)
    // No process list: the real `ps` would show whatever channels this machine happens to be running.
    expect(
      await runCli(['doctor', '--agent-dir', agent, '--claude-dir', claudeDir], io, env, { processes: () => [] }),
    ).toBe(0)
    const key = JSON.parse(readFileSync(paths(h.home).bridgeKey, 'utf8')) as { public: string }
    const lines = normalise(out, {
      [h.relay.httpUrl]: '<relay>',
      [key.public]: '<pubkey>',
      [h.relay.bridgeKey.keyId]: '<keyid>',
      [h.home]: '<home>',
      [agent]: '<agent>',
    })
    const stable = lines.map(stabilise)
    expect(stable.join('\n')).toMatchSnapshot()
  })

  test('prints these lines, and exits 1, when the relay is down and nothing is set up', async () => {
    const claudeDir = emptyHome()
    const home = mkdtempSync(join(tmpdir(), 'talos-nohome-')) // exists, but has no key and no config
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    // Port 1 refuses connections, so the relay is really unreachable.
    const env = { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: 'http://127.0.0.1:1' }
    const args = ['doctor', '--agent-dir', agent, '--claude-dir', claudeDir]
    expect(await runCli(args, io, env, { processes: () => [] })).toBe(1)
    const lines = normalise(out, { [home]: '<home>', [agent]: '<agent>' }).map((l) =>
      // Bun words the connection error its own way; the row and its FAIL level are what is pinned.
      stabilise(l.startsWith('FAIL  relay /healthz:') ? 'FAIL  relay /healthz: <unreachable>' : l),
    )
    expect(lines.join('\n')).toMatchSnapshot()
  })
})
