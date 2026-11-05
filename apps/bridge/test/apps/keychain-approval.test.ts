import { describe, expect, it } from 'bun:test'
import { defaultShow, diffManifests, keyOf, labelProblem, manifestOf, renderApproval } from '../../src/apps/approval.ts'
import {
  bunKeychainSpawn,
  KeychainError,
  type KeychainSpawn,
  securityRunner,
  serverIdOf,
} from '../../src/apps/keychain.ts'
import { memSecrets } from './helpers.ts'

type Call = { argv: string[]; stdin: string | undefined }

function spy(handler: (c: Call) => { code: number; stdout: string } = () => ({ code: 0, stdout: '' })) {
  const calls: Call[] = []
  const spawn: KeychainSpawn = async (argv, stdin) => {
    const c = { argv, stdin }
    calls.push(c)
    return handler(c)
  }
  return { calls, spawn }
}
const ACCT = `${'a'.repeat(16)}/config`

describe('the real Keychain runner (against a spawn spy; the real Keychain is never touched)', () => {
  it('writes through `security -i` with the value on STDIN, never in argv', async () => {
    const s = spy()
    const secret = 'Bearer s3cr3t-value-123'
    await securityRunner(s.spawn).write(ACCT, secret)
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]?.argv).toEqual(['/usr/bin/security', '-i'])
    const line = s.calls[0]?.stdin ?? ''
    expect(line).toStartWith(`add-generic-password -U -s talos-app.direct -a ${ACCT} -w v1.`)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.stringify(s.calls.map((c) => c.argv))).not.toContain('s3cr3t')
    // not even encoded in a way that survives a plain grep of the stdin
    expect(line).not.toContain('s3cr3t')
  })
  it('reads with find-generic-password -w and decodes what it wrote', async () => {
    const store = new Map<string, string>()
    const s = spy((c) => {
      if (c.stdin) {
        const m = /-a (\S+) -w (\S+)\n/.exec(c.stdin)
        store.set(m?.[1] as string, m?.[2] as string)
        return { code: 0, stdout: '' }
      }
      const v = store.get(c.argv[c.argv.indexOf('-a') + 1] as string)
      return v ? { code: 0, stdout: `${v}\n` } : { code: 44, stdout: '' }
    })
    const r = securityRunner(s.spawn)
    await r.write(ACCT, '{"url":"https://x.example.com","headers":{"a":"b"}}')
    expect(await r.read(ACCT)).toBe('{"url":"https://x.example.com","headers":{"a":"b"}}')
    const readCall = s.calls[s.calls.length - 1]
    expect(readCall?.argv).toEqual([
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      'talos-app.direct',
      '-a',
      ACCT,
      '-w',
    ])
    expect(await r.read(`${'b'.repeat(16)}/oauth`)).toBeUndefined() // missing item: code 44
  })
  it('a locked or unreadable Keychain is an error, not "missing"', async () => {
    const r = securityRunner(spy(() => ({ code: 36, stdout: '' })).spawn)
    await expect(r.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
    await expect(r.write(ACCT, 'x')).rejects.toBeInstanceOf(KeychainError)
  })
  it('an unknown value in the item is refused, not parsed', async () => {
    const r = securityRunner(spy(() => ({ code: 0, stdout: 'plain-text-from-someone-else\n' })).spawn)
    await expect(r.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
  })
  it('an account that could carry a command is refused before anything is spawned', async () => {
    const s = spy()
    const r = securityRunner(s.spawn)
    for (const bad of [
      'x',
      `${'a'.repeat(16)}/config\nadd-generic-password -s evil`,
      `${'a'.repeat(16)}/other`,
      `${'A'.repeat(16)}/config`,
      '../../x',
    ]) {
      await expect(r.write(bad, 'v')).rejects.toBeInstanceOf(KeychainError)
      await expect(r.read(bad)).rejects.toBeInstanceOf(KeychainError)
    }
    expect(s.calls.length).toBe(0)
  })
  it('spawn failure (no /usr/bin/security) is KeychainError', async () => {
    const r = securityRunner(async () => {
      throw new Error('ENOENT')
    })
    await expect(r.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
  })
  it('the default spawn really does take stdin and argv separately (exercised on /bin/cat, not security)', async () => {
    const r = await bunKeychainSpawn(['/bin/cat'], 'hello\n')
    expect(r).toEqual({ code: 0, stdout: 'hello\n' })
  })
})

describe('server secrets', () => {
  it('serverId is stable and differs by source', () => {
    expect(serverIdOf('a', 'local')).toBe(serverIdOf('a', 'local'))
    expect(serverIdOf('a', 'local')).not.toBe(serverIdOf('a', 'user'))
    expect(serverIdOf('a', 'local')).toMatch(/^[0-9a-f]{16}$/)
  })
  it('fingerprint changes with url, headers and command, not with key order; the HMAC key is created once', async () => {
    const { kc, secrets } = memSecrets()
    const id = serverIdOf('s', 'local')
    const a = await secrets.fingerprint(id, {
      type: 'http',
      url: 'https://x.example.com/mcp',
      headers: { A: '1', B: '2' },
    })
    const b = await secrets.fingerprint(id, {
      headers: { B: '2', A: '1' },
      url: 'https://x.example.com/mcp',
      type: 'http',
    })
    expect(a).toBe(b)
    expect(
      await secrets.fingerprint(id, { type: 'http', url: 'https://x.example.com/mcp', headers: { A: '1', B: '3' } }),
    ).not.toBe(a)
    expect(
      await secrets.fingerprint(id, { type: 'http', url: 'https://y.example.com/mcp', headers: { A: '1', B: '2' } }),
    ).not.toBe(a)
    expect(await secrets.fingerprint(id, { type: 'stdio', command: 'node', args: ['a'] })).not.toBe(
      await secrets.fingerprint(id, { type: 'stdio', command: 'node', args: ['b'] }),
    )
    expect(kc.log.filter((l) => l.op === 'write').length).toBe(1) // one hmac-key write
    // a different server has a different key, so equal configs do not collide across servers
    const other = await secrets.fingerprint(serverIdOf('s2', 'local'), {
      type: 'http',
      url: 'https://x.example.com/mcp',
      headers: { A: '1', B: '2' },
    })
    expect(other).not.toBe(a)
  })
  it('config round-trips and logout deletes the oauth and config items', async () => {
    const { kc, secrets } = memSecrets()
    const id = serverIdOf('s', 'local')
    await secrets.saveConfig(id, {
      type: 'http',
      url: 'https://x.example.com',
      headers: { Authorization: 'Bearer abc' },
    })
    expect(await secrets.loadConfig(id)).toEqual({
      type: 'http',
      url: 'https://x.example.com',
      headers: { Authorization: 'Bearer abc' },
    })
    await secrets.saveOauth(id, { tokens: { access_token: 't' } })
    await secrets.logout(id)
    expect(kc.items.has(`${id}/config`)).toBe(false)
    expect(kc.items.has(`${id}/oauth`)).toBe(false)
    expect(await secrets.loadConfig(id)).toBeUndefined()
  })
  it('a corrupt stored value reads as missing, not as a crash', async () => {
    const { kc, secrets } = memSecrets()
    const id = serverIdOf('s', 'local')
    kc.items.set(`${id}/config`, 'not json')
    expect(await secrets.loadConfig(id)).toBeUndefined()
    kc.items.set(`${id}/config`, '[1,2]')
    expect(await secrets.loadConfig(id)).toBeUndefined()
  })
})

const base = {
  server: 's',
  source: 'local',
  resource: {
    uri: 'ui://s/a.html',
    html_sha256: 'a'.repeat(64),
    csp: {
      connect_domains: [],
      resource_domains: [],
      frame_domains: [],
      base_uri_domains: [],
      script_hashes: [],
      script_urls: [],
      style_urls: [],
    },
    permissions_requested: [],
  },
  tools: [
    {
      name: 'read_note',
      resource_uri: 'ui://s/a.html',
      visibility: ['model', 'app'] as Array<'model' | 'app'>,
      read_only: true,
      destructive: false,
      open_world: true,
    },
    {
      name: 'set_note',
      visibility: ['model', 'app'] as Array<'model' | 'app'>,
      read_only: false,
      destructive: true,
      open_world: true,
    },
  ],
}

describe('approval key, diff, labels, screen', () => {
  it('an annotation change moves the key and the diff names the tool and the new rule', () => {
    const a = manifestOf(base)
    const flipped = manifestOf({
      ...base,
      tools: [base.tools[0] as never, { ...base.tools[1], read_only: true, destructive: false } as never],
    })
    expect(keyOf(base)).not.toBe(
      keyOf({
        ...base,
        tools: [base.tools[0] as never, { ...base.tools[1], read_only: true, destructive: false } as never],
      }),
    )
    expect(diffManifests(a, flipped)).toContain('`set_note` is now marked read-only, so it would run without a tap')
    expect(diffManifests(flipped, a)).toContain('`set_note` is no longer marked read-only')
  })
  it('names the other kinds of change: html, new connect domain, new and removed tools, config', () => {
    const a = manifestOf(base)
    const csp = { ...base.resource.csp, connect_domains: ['https://api2.example.com'] }
    const b = manifestOf({
      ...base,
      resource: { ...base.resource, html_sha256: 'b'.repeat(64), csp },
      tools: [
        base.tools[0] as never,
        { name: 'new_tool', visibility: ['app'], read_only: false, destructive: true, open_world: true },
      ],
    })
    const d = diffManifests(a, b).join('\n')
    expect(d).toContain('HTML changed')
    expect(d).toContain('now may also connect to: https://api2.example.com')
    expect(d).toContain('new tool `new_tool`')
    expect(d).toContain('tool `set_note` is gone')
    const c1 = manifestOf({ ...base, direct: { type: 'http', config_fingerprint: 'c'.repeat(64), auth: 'static' } })
    const c2 = manifestOf({ ...base, direct: { type: 'http', config_fingerprint: 'd'.repeat(64), auth: 'static' } })
    expect(diffManifests(c1, c2)).toContain("the server's launch command, URL or headers changed")
  })
  it('an unchanged manifest has an empty diff; the owner choices are not part of the key', () => {
    expect(diffManifests(manifestOf(base), manifestOf(base))).toEqual([])
    expect(keyOf(base)).toBe(keyOf({ ...base, owner: { label: 'whatever' } } as never))
  })
  it('the diff never grows past 2,000 characters', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `t_${i}_${'x'.repeat(30)}`,
      visibility: ['app'] as Array<'app'>,
      read_only: false,
      destructive: true,
      open_world: true,
    }))
    const d = diffManifests(manifestOf(base), manifestOf({ ...base, tools: many }))
    expect(d.join('\n').length).toBeLessThanOrEqual(2000)
    expect(d[d.length - 1]).toBe('(more changes not shown)')
  })
  it('reserved words, the agent name, control characters and length are refused in a label', () => {
    for (const w of ['Talos', 'APPROVE it', 'my Card', 'Sign in', 'Code', 'Password', 'x talos x'])
      expect(labelProblem(w)).toBeDefined()
    expect(labelProblem('Ada helper', ['Ada'])).toBeDefined()
    expect(labelProblem('Notes board')).toBeUndefined()
    expect(labelProblem('')).toBeDefined()
    expect(labelProblem('a'.repeat(61))).toBeDefined()
    expect(labelProblem('bad\u0007label')).toBeDefined()
    expect(labelProblem('<b>x</b>')).toBeDefined()
  })
  it('show defaults to ask for remote or non-local sources, auto for a local stdio server', () => {
    expect(defaultShow('local', 'stdio')).toBe('auto')
    expect(defaultShow('project', undefined)).toBe('auto')
    expect(defaultShow('plugin', 'stdio')).toBe('ask')
    expect(defaultShow('local', 'http')).toBe('ask')
    expect(defaultShow('claudeai', 'unsupported')).toBe('ask')
  })
  it('the screen lists every tool with its visibility and run rule, and asks no per-tool question', () => {
    const lines = renderApproval({
      server: 's',
      source: 'local',
      resource: { ...base.resource, size: 10 },
      key: 'f'.repeat(64),
      tools: base.tools,
      boundTools: ['read_note'],
      permissions: ['camera'],
      directLines: [],
    })
    const text = lines.join('\n')
    expect(text).toContain('read_note  [agent + app]  runs without a tap (server says read-only)')
    expect(text).toContain('set_note  [agent + app]  asks you each time')
    expect(text).toContain("Approving lets this app run the tools marked 'without a tap'")
    expect(text).toContain('Approval key: ffffffffffffffff')
    expect(text).toContain('requested permissions: camera (requested, will be denied)')
    expect(text).toContain('stored on your relay for 7 days')
    expect(lines.filter((l) => l.includes('?')).length).toBe(0)
  })
})
