// Claude Code starts the talos-app MCP server with the PATH of the session, and Main can start with a bare one (2026-11-09: "Executable not
// found in $PATH: bun", the bridge never ran). The entry install-mcp, adopt and onboarding write names bun by its absolute path and carries a
// PATH that has bun's folder; talos-app doctor flags a bare `bun` (or any command that is not absolute) and says how to fix it.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { bunPath, mcpEntry, mergeMcpConfig } from '../src/mcp-config.ts'
import { type Harness, startHarness } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..')
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

function cliIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })

describe('the entry written for the talos-app MCP server', () => {
  test('names bun by its absolute path, carries NO PATH (the session keeps its own: ~/.local/bin, /opt/homebrew/bin), and runs server.ts directly', () => {
    const e = mcpEntry(BRIDGE_DIR, '/home/app', '/agent')
    expect(isAbsolute(e.command)).toBe(true)
    expect(e.command.endsWith('/bun')).toBe(true)
    expect(e.args).toEqual(['--no-env-file', `--config=${BRIDGE_DIR}/bunfig.toml`, `${BRIDGE_DIR}/src/server.ts`])
    expect(e.env.PATH).toBeUndefined()
    expect(e.env.TALOS_APP_HOME).toBe('/home/app')
  })

  test('bunPath prefers the bun on PATH over the running binary (a versioned Cellar path breaks on upgrade)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-bunpath-'))
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\n', { mode: 0o755 })
    const was = process.env.PATH
    process.env.PATH = `${dir}:${was ?? ''}`
    try {
      expect(bunPath()).toBe(join(dir, 'bun'))
    } finally {
      process.env.PATH = was
    }
  })

  test('a bun path can be given (the install picks the one that is running)', () => {
    const e = mcpEntry(BRIDGE_DIR, '/home/app', undefined, '/opt/bun/bin/bun')
    expect(e.command).toBe('/opt/bun/bin/bun')
    expect(e.env.PATH).toBeUndefined()
  })

  test('a PATH the owner put in the entry is kept, but the one an earlier Talos wrote is migrated away', () => {
    const mine = { mcpServers: { 'talos-app': { command: 'bun', args: [], env: { PATH: '/my/path', MINE: '1' } } } }
    const kept = mergeMcpConfig(mine, mcpEntry(BRIDGE_DIR, '/home/app', '/agent', '/opt/bun/bin/bun')).config
    const e = (kept.mcpServers as Record<string, { command: string; env: Record<string, string> }>)['talos-app']
    expect(e.env.PATH).toBe('/my/path')
    expect(e.env.MINE).toBe('1')
    expect(e.command).toBe('/opt/bun/bin/bun')
    const ours = {
      mcpServers: {
        'talos-app': {
          command: '/opt/bun/bin/bun',
          args: ['run', '--cwd', BRIDGE_DIR, '--silent', 'src/server.ts'],
          env: {
            PATH: '/opt/bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            TALOS_APP_HOME: '/home/app',
            KEEP: 'y',
          },
        },
      },
    }
    const m = mergeMcpConfig(ours, mcpEntry(BRIDGE_DIR, '/home/app', '/agent', '/opt/bun/bin/bun'))
    const g = (m.config.mcpServers as Record<string, { args: string[]; env: Record<string, string> }>)['talos-app']
    expect(m.changed).toBe(true)
    expect(g.env.PATH).toBeUndefined()
    expect(g.env.KEEP).toBe('y')
    expect(g.args.at(-1)).toBe(`${BRIDGE_DIR}/src/server.ts`)
  })
})

describe('talos-app doctor and the older entry form', () => {
  const oldEntry = (agent: string) => ({
    command: process.execPath,
    args: ['run', '--cwd', BRIDGE_DIR, '--silent', 'src/server.ts'],
    env: { TALOS_AGENT_DIR: agent },
  })
  const withOld = (agent: string) =>
    writeFileSync(
      join(agent, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'talos-app': oldEntry(agent), other: { command: 'npx', args: ['x'] } } }),
    )

  test('the older form is a warning with the extra lock off and a FAIL with it on, both naming the one fix', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    withOld(agent)
    const off = cliIO()
    await runCli(['doctor', '--agent-dir', agent], off.io, env(h))
    const offRow = off.out.find((l) => l.includes('.mcp.json entry form'))
    expect(offRow?.startsWith('warn')).toBe(true)
    expect(offRow).toContain('talos-app doctor --fix-mcp')
    writeFileSync(
      join(h.home, 'config.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8')), os_sandbox: true }),
    )
    const on = cliIO()
    await runCli(['doctor', '--agent-dir', agent], on.io, env(h))
    const onRow = on.out.find((l) => l.includes('.mcp.json entry form'))
    expect(onRow?.startsWith('FAIL')).toBe(true)
    expect(onRow).toContain('refuses it')
  })

  test('doctor --fix-mcp rewrites the entry in the current form, keeps the other servers, and the row goes away', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    withOld(agent)
    const fix = cliIO()
    await runCli(['doctor', '--agent-dir', agent, '--fix-mcp'], fix.io, env(h))
    expect(fix.out.find((l) => l.includes('.mcp.json entry fix'))).toContain('rewrote the talos-app entry')
    expect(fix.out.some((l) => l.includes('.mcp.json entry form'))).toBe(false)
    const cfg = JSON.parse(readFileSync(join(agent, '.mcp.json'), 'utf8'))
    expect(cfg.mcpServers['talos-app'].args).toEqual([
      '--no-env-file',
      `--config=${BRIDGE_DIR}/bunfig.toml`,
      `${BRIDGE_DIR}/src/server.ts`,
    ])
    expect(cfg.mcpServers.other).toEqual({ command: 'npx', args: ['x'] })
    const again = cliIO()
    await runCli(['doctor', '--agent-dir', agent, '--fix-mcp'], again.io, env(h))
    expect(again.out.find((l) => l.includes('.mcp.json entry fix'))).toContain('already current')
  })
})

describe('talos-app doctor and the command in .mcp.json', () => {
  const write = (dir: string, command: string) =>
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'talos-app': {
            command,
            args: ['--no-env-file', `--config=${BRIDGE_DIR}/bunfig.toml`, `${BRIDGE_DIR}/src/server.ts`],
            env: { TALOS_AGENT_DIR: dir },
          },
        },
      }),
    )

  test('a bare bun is flagged with the fix, an absolute one is ok', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    write(agent, 'bun')
    const bare = cliIO()
    await runCli(['doctor', '--agent-dir', agent], bare.io, env(h))
    const line = bare.out.find((l) => l.includes('.mcp.json entry') && l.includes('bun'))
    expect(line?.startsWith('warn')).toBe(true)
    expect(line).toContain('not an absolute path')
    expect(line).toContain('install-mcp')
    write(agent, process.execPath)
    const abs = cliIO()
    await runCli(['doctor', '--agent-dir', agent], abs.io, env(h))
    expect(abs.out.find((l) => l.includes('.mcp.json entry'))?.startsWith('ok')).toBe(true)
  })

  test('any other relative command is flagged the same way', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    write(agent, './bin/bun')
    const r = cliIO()
    await runCli(['doctor', '--agent-dir', agent], r.io, env(h))
    expect(r.out.find((l) => l.includes('.mcp.json entry'))?.startsWith('warn')).toBe(true)
  })
})
