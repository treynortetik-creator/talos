import { describe, expect, it } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildScanOptions, neverYielding, resolveClaude, sdkStatusSource } from '../../src/apps/sdk-source.ts'
import { tmp } from './helpers.ts'

const input = (over: Record<string, unknown> = {}) => ({
  agentDir: '/agent',
  claudePath: '/usr/local/bin/claude',
  env: { PATH: '/usr/bin', TALOS_APP_BRIDGE: '1', KEEP: 'yes' } as Record<string, string | undefined>,
  excludePlugins: [] as string[],
  ...over,
})

describe('the options the scan hands the SDK (M5.1 step 2)', () => {
  it('hooks off, the installed binary, legacy negotiation, no TALOS_APP_BRIDGE, plugin servers allowed', () => {
    const o = buildScanOptions(input()) as Record<string, unknown>
    expect(o.cwd).toBe('/agent')
    expect(o.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect((o.settings as { disableAllHooks: boolean }).disableAllHooks).toBe(true)
    expect(o.strictMcpConfig).toBe(false)
    const env = o.env as Record<string, string | undefined>
    expect(env.MCP_PROTOCOL_NEGOTIATION).toBe('legacy')
    expect('TALOS_APP_BRIDGE' in env).toBe(false)
    expect(env.KEEP).toBe('yes')
  })
  it('--exclude-plugin turns that plugin off in the inline settings', () => {
    const o = buildScanOptions(input({ excludePlugins: ['chan@mkt', 'other@mkt'] })) as {
      settings: { enabledPlugins: Record<string, boolean> }
    }
    expect(o.settings.enabledPlugins).toEqual({ 'chan@mkt': false, 'other@mkt': false })
  })
  it("does not mutate the caller's environment", () => {
    const i = input()
    buildScanOptions(i)
    expect(i.env.TALOS_APP_BRIDGE).toBe('1')
    expect(i.env.MCP_PROTOCOL_NEGOTIATION).toBeUndefined()
  })
  it('claude is found on PATH, in order, and only if executable; none found is undefined', () => {
    const d1 = tmp()
    const d2 = tmp()
    writeFileSync(join(d2, 'claude'), '#!/bin/sh\n')
    chmodSync(join(d2, 'claude'), 0o755)
    writeFileSync(join(d1, 'claude'), 'not executable')
    chmodSync(join(d1, 'claude'), 0o644)
    expect(resolveClaude(`${d1}:${d2}`)).toBe(join(d2, 'claude'))
    expect(resolveClaude(d1)).toBeUndefined()
    expect(resolveClaude(undefined)).toBeUndefined()
    expect(resolveClaude('')).toBeUndefined()
  })
})

describe('no model turn, ever', () => {
  it('the prompt stream never yields and ends when told', async () => {
    const p = neverYielding()
    const it = p.iterable[Symbol.asyncIterator]()
    const raced = await Promise.race([
      it.next().then(() => 'yielded'),
      new Promise((r) => setTimeout(() => r('quiet'), 40)),
    ])
    expect(raced).toBe('quiet')
    expect(p.yielded()).toBe(0)
    p.end()
    expect((await it.next()).done).toBe(true)
  })
  it('only control requests are used: the fake query records exactly which methods ran, and no message is ever pulled', async () => {
    const calls: string[] = []
    let params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> } | undefined
    const q = {
      initializationResult: async () => {
        calls.push('initializationResult')
        return { claude_code_version: '2.1.312' }
      },
      mcpServerStatus: async () => {
        calls.push('mcpServerStatus')
        return [
          {
            name: 'probe',
            status: 'connected',
            source: 'local',
            config: { type: 'stdio', command: 'x', args: [] },
            tools: [{ name: 't', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://a/b' } } }],
          },
        ]
      },
      reconnectMcpServer: async (n: string) => {
        calls.push(`reconnect:${n}`)
      },
      readMcpResource: async (s: string, u: string) => {
        calls.push(`read:${s}:${u}`)
        return { contents: [{ uri: u, text: 'x' }] }
      },
      close: () => {
        calls.push('close')
      },
      // anything that would run a turn
      next: () => {
        calls.push('NEXT')
        throw new Error('a message was requested')
      },
      interrupt: () => calls.push('INTERRUPT'),
      setModel: () => calls.push('SETMODEL'),
    }
    const src = sdkStatusSource(input(), ((p: typeof params) => {
      params = p
      return q
    }) as never)
    expect(await src.start()).toEqual({ claudeCodeVersion: '2.1.312' })
    const st = await src.status()
    expect(st[0]).toMatchObject({ name: 'probe', status: 'connected', source: 'local' })
    await src.reconnect('probe')
    expect((await src.readResource('probe', 'ui://a/b')).contents.length).toBe(1)
    // the prompt handed to the SDK never produced a message
    const it = (params as NonNullable<typeof params>).prompt[Symbol.asyncIterator]()
    expect(
      await Promise.race([it.next().then(() => 'yielded'), new Promise((r) => setTimeout(() => r('quiet'), 30))]),
    ).toBe('quiet')
    src.close()
    expect((await it.next()).done).toBe(true)
    expect(calls).toEqual([
      'initializationResult',
      'mcpServerStatus',
      'reconnect:probe',
      'read:probe:ui://a/b',
      'close',
    ])
    expect(
      ((params as NonNullable<typeof params>).options.settings as { disableAllHooks: boolean }).disableAllHooks,
    ).toBe(true)
  })
  it('using the source before start() is an error, not a crash', async () => {
    const src = sdkStatusSource(input(), (() => ({})) as never)
    await expect(src.status()).rejects.toThrow('not started')
    src.close()
  })
})
