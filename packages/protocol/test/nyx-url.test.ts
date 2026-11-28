// Where the owner's Nyx lives (memory.nyx_url): https only, checked by one rule in the schema, the patch check and the web form.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_CONFIG_ALLOWLIST,
  AGENT_CONFIG_REFUSED,
  AgentConfig,
  checkConfigPatch,
  nyxHost,
  nyxOpenUrl,
  nyxSignInUrl,
  parseNyxUrl,
  SETTINGS_TABLE,
} from '../src/index.ts'

const BAD = [
  'http://nyx.example.com',
  'javascript:alert(1)',
  'data:text/html,hi',
  'ftp://nyx.example.com',
  'https://nyx.example.com/a b',
  ' https://nyx.example.com',
  'https://nyx.example.com\n',
  `https://user:pw${'@'}nyx.example.com`,
  'https://nyx.example.com/?token=1',
  'https://nyx.example.com/#x',
  'nyx.example.com',
  '',
  'https://',
  'https://nyx.example.com/?',
  'https://nyx.example.com#',
  'https://nyx.example.com.',
  'https://nyx.example.com./nyx',
  'https://nyx.example.com/sign-in',
  'https://nyx.example.com/nyx/Sign-In/',
]

describe('parseNyxUrl', () => {
  it('takes an https address, with or without a path', () => {
    for (const ok of ['https://nyx.example.com', 'https://nyx.example.com/', 'https://example.com:8443/nyx'])
      expect(parseNyxUrl(ok), ok).not.toBeNull()
  })
  it('refuses http, javascript:, spaces, sign-in details, a query and anything that is not text', () => {
    for (const bad of BAD) expect(parseNyxUrl(bad), JSON.stringify(bad)).toBeNull()
    for (const bad of [null, undefined, 7, {}, ['https://nyx.example.com']]) expect(parseNyxUrl(bad)).toBeNull()
    expect(parseNyxUrl(`https://nyx.example.com/${'a'.repeat(2000)}`)).toBeNull()
  })
})

describe('the links Talos builds from the address', () => {
  it('sign-in is the address plus /sign-in, whatever trailing slash was typed', () => {
    expect(nyxSignInUrl('https://nyx.example.com')).toBe('https://nyx.example.com/sign-in')
    expect(nyxSignInUrl('https://nyx.example.com/')).toBe('https://nyx.example.com/sign-in')
    expect(nyxSignInUrl('https://example.com/nyx/')).toBe('https://example.com/nyx/sign-in')
  })
  it('a stored value that is not an https address gives no link at all', () => {
    for (const bad of BAD) {
      expect(nyxSignInUrl(bad)).toBeNull()
      expect(nyxOpenUrl(bad)).toBeNull()
      expect(nyxHost(bad)).toBeNull()
    }
  })
  it('names the host, port included', () => {
    expect(nyxHost('https://nyx.example.com/x')).toBe('nyx.example.com')
    expect(nyxHost('https://example.com:8443')).toBe('example.com:8443')
    expect(nyxOpenUrl('https://nyx.example.com')).toBe('https://nyx.example.com/')
  })
})

describe('where it is saved: checkConfigPatch', () => {
  it('takes an https address and a clear (null)', () => {
    expect(checkConfigPatch({ memory: { nyx_url: 'https://nyx.example.com' } })).toEqual({ ok: true })
    expect(checkConfigPatch({ memory: { nyx_url: null } })).toEqual({ ok: true })
  })
  it('refuses http, javascript:, spaces and a non-string, naming the path', () => {
    for (const bad of [...BAD, 7, true, {}, []])
      expect(checkConfigPatch({ memory: { nyx_url: bad } }), JSON.stringify(bad)).toEqual({
        ok: false,
        path: 'memory.nyx_url',
      })
  })
  it('opens only that one key of memory', () => {
    expect(checkConfigPatch({ memory: { other: 1 } })).toEqual({ ok: false, path: 'memory.other' })
    expect(checkConfigPatch({ memory: null })).toEqual({ ok: false, path: 'memory' })
  })
})

describe('the setting', () => {
  it('has no default: a config that never set it has none', () => {
    expect(SETTINGS_TABLE['memory.nyx_url'].default).toBeUndefined()
    const cfg = AgentConfig.parse({ ...defaultConfig, memory: undefined })
    expect(cfg.memory).toEqual({})
    expect(JSON.stringify(defaultConfig)).not.toMatch(/nyx/i)
  })
  it('reads a good address, and reads a bad stored one as not connected', () => {
    expect(AgentConfig.parse({ ...defaultConfig, memory: { nyx_url: 'https://nyx.example.com' } }).memory.nyx_url).toBe(
      'https://nyx.example.com/',
    )
    for (const bad of ['http://nyx.example.com', 'javascript:alert(1)', 'a b', 5])
      expect(AgentConfig.parse({ ...defaultConfig, memory: { nyx_url: bad } }).memory).toEqual({})
    expect(AgentConfig.parse({ ...defaultConfig, memory: 'x' }).memory).toEqual({})
  })
  it('is the owner only: the agent is refused it by its full name', () => {
    expect(AGENT_CONFIG_ALLOWLIST as readonly string[]).not.toContain('memory.nyx_url')
    expect(AGENT_CONFIG_REFUSED as readonly string[]).toContain('memory.nyx_url')
  })
})
