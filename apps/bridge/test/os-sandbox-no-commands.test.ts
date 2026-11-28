// The OS sandbox's refusal lines name the item (a hook's event and number, a setting key, a server) and never print a command, its
// arguments, or an env value: those can hold a secret (an apiKeyHelper, an otelHeadersHelper, a server's token).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOsSandbox } from '../src/guards/os-sandbox.ts'

const SECRET = 'sk-live-TESTSECRET123'
const KIT_WAS = process.env.TALOS_KIT_HOME
const made: string[] = []
afterEach(() => {
  if (KIT_WAS === undefined) delete process.env.TALOS_KIT_HOME
  else process.env.TALOS_KIT_HOME = KIT_WAS
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A throwaway folder and user home; the given files are written (path relative to the root, content as JSON), then the start is tried. */
function start(files: Record<string, unknown>): string | null {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'osbx-nocmd-')))
  made.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), JSON.stringify(body).replaceAll('{ROOT}', root))
  }
  process.env.TALOS_KIT_HOME = join(root, 'Kit')
  mkdirSync(join(root, 'Agent'), { recursive: true })
  mkdirSync(join(root, 'Home'), { recursive: true })
  const out = prepareOsSandbox(
    {
      talosHome: join(root, 'Home'),
      userHome: join(root, 'User'),
      folder: join(root, 'Agent'),
      claudeDir: join(root, 'User', '.claude'),
      // darwin on any host: the Mac's recipe is what the golden and these lines are built from; the checks here are the same on Linux
      platform: 'darwin',
      writableRoots: [],
      trusted: null,
    },
    { ownerExcludes: () => [], write: () => {} },
  )
  return 'refusal' in out ? out.refusal : null
}

const hook = (command: string) => ({ hooks: [{ type: 'command', command }] })

describe('a refusal line never prints a command, an argument or a helper value', () => {
  test('a project hook', () => {
    const line = start({
      'Agent/.claude/settings.json': { hooks: { Stop: [hook(`curl -H "Authorization: ${SECRET}" x`)] } },
    })
    expect(line).not.toBeNull()
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('curl')
    expect(line).toContain('the Stop hook (number 1)')
  })

  test('a hook is numbered as the owner counts it: every entry of the event, flat across matcher groups', () => {
    const prompt = { type: 'prompt', prompt: 'check it' }
    const run = (command: string) => ({ type: 'command', command })
    const line = start({
      'Agent/.claude/settings.json': {
        hooks: { Stop: [{ hooks: [prompt] }, { matcher: 'x', hooks: [prompt, run(`curl ${SECRET}`)] }] },
      },
    })
    expect(line).toContain('the Stop hook (number 3)')
    expect(line).not.toContain(SECRET)
  })

  test('the status line and each helper, in the project settings', () => {
    for (const key of ['apiKeyHelper', 'otelHeadersHelper', 'awsAuthRefresh', 'awsCredentialExport']) {
      const line = start({ 'Agent/.claude/settings.local.json': { [key]: `/tmp/get-key --token ${SECRET}` } })
      expect(line, key).not.toBeNull()
      expect(line, key).not.toContain(SECRET)
      expect(line, key).not.toContain('get-key')
      expect(line, key).toContain(key)
    }
    const status = start({ 'Agent/.claude/settings.json': { statusLine: { type: 'command', command: `x ${SECRET}` } } })
    expect(status).not.toContain(SECRET)
    expect(status).toContain('statusLine')
  })

  test('an .mcp.json server (not the kit’s), with arguments and with an env', () => {
    const byArg = start({
      'Agent/.mcp.json': { mcpServers: { foo: { command: 'npx', args: ['srv', '--key', SECRET] } } },
    })
    expect(byArg).not.toBeNull()
    expect(byArg).not.toContain(SECRET)
    expect(byArg).not.toContain('npx')
    expect(byArg).toContain('the foo server')
    const withEnv = start({
      'Agent/.mcp.json': { mcpServers: { foo: { command: 'npx', args: ['srv'], env: { TOKEN: SECRET } } } },
    })
    expect(withEnv).not.toContain(SECRET)
    expect(withEnv).toContain('the foo server')
  })

  test('a user-settings hook and helper', () => {
    const hooked = start({
      'User/.claude/settings.json': { hooks: { PreToolUse: [hook(`npx guard ${SECRET}`)] } },
    })
    expect(hooked).not.toBeNull()
    expect(hooked).not.toContain(SECRET)
    expect(hooked).toContain('the PreToolUse hook (number 1)')
    const helper = start({ 'User/.claude/settings.json': { apiKeyHelper: `npx get ${SECRET}` } })
    expect(helper).not.toContain(SECRET)
    expect(helper).toContain('apiKeyHelper')
  })
})

describe('a kit server with its own env or cwd', () => {
  test('is refused by its name, with no argument or env value', () => {
    const line = start({
      'Kit/scripts/srv.sh': '#!/bin/sh',
      'Agent/.mcp.json': {
        mcpServers: { foo: { command: '{ROOT}/Kit/scripts/srv.sh', args: ['--key', SECRET], env: { TOKEN: SECRET } } },
      },
    })
    expect(line).toContain('the foo server with its own env')
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('srv.sh')
  })
})
