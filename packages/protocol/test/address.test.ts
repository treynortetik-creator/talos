// The one web-address check. Every entry point in the repo runs the same corpus (fixtures/address-corpus.json).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import corpus from '../fixtures/address-corpus.json' with { type: 'json' }
import {
  findBlockedAddress,
  isBlockedAddress,
  isBlockedHost,
  isBlockedHostname,
  isIpLiteral,
  isLoopbackHost,
  normalizeHost,
  parseIPv4,
  parseIPv6,
} from '../src/address.ts'

describe('isBlockedAddress: the corpus', () => {
  it('the core set is the 19 addresses every entry point must agree on', () => {
    expect(corpus.core).toHaveLength(19)
    expect(new Set(corpus.core).size).toBe(19)
  })
  it.each(corpus.core)('refuses core %s', (a) => expect(isBlockedAddress(a)).toBe(true))
  it.each(corpus.alsoBlocked)('refuses %s', (a) => expect(isBlockedAddress(a)).toBe(true))
  it.each(corpus.public)('allows public %s', (a) => expect(isBlockedAddress(a)).toBe(false))
  // an unknown value degrades to "refuse", never to "allow" (class 2)
  it.each(corpus.notAnAddress)('refuses text that is not exactly an address: %j', (a) =>
    expect(isBlockedAddress(a)).toBe(true),
  )
  it('brackets around a v6 literal do not change the verdict', () => {
    for (const a of corpus.core.filter((x) => x.includes(':'))) expect(isBlockedAddress(`[${a}]`)).toBe(true)
    expect(isBlockedAddress('[2606:4700:4700::1111]')).toBe(false)
  })
})

describe('the forms an attacker uses to hide a blocked IPv4 address', () => {
  it.each([
    ['IPv4-mapped, dotted', '::ffff:169.254.169.254'],
    ['IPv4-mapped, hex', '::ffff:a9fe:a9fe'],
    ['IPv4-mapped, long zeros', '0:0:0:0:0:ffff:a9fe:a9fe'],
    ['IPv4-mapped, upper case', '::FFFF:A9FE:A9FE'],
    ['IPv4-compatible', '::169.254.169.254'],
    ['IPv4-compatible, hex', '::a9fe:a9fe'],
    ['translated (SIIT)', '::ffff:0:a9fe:a9fe'],
    ['NAT64 well-known prefix', '64:ff9b::169.254.169.254'],
    ['NAT64 local-use prefix', '64:ff9b:1::a9fe:a9fe'],
    ['6to4 wrapping the metadata address', '2002:a9fe:a9fe::'],
    ['6to4 wrapping loopback', '2002:7f00:1::'],
    ['loopback written out', '0:0:0:0:0:0:0:1'],
    ['zone id on link-local', 'fe80::1%en0'],
  ])('%s: %s', (_n, a) => expect(isBlockedAddress(a)).toBe(true))

  it('decimal, octal, hex and short IPv4 spellings are never accepted as addresses', () => {
    for (const a of ['2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '0177.0.0.01', '127.1', '127.0.1', '0']) {
      expect(parseIPv4(a), a).toBeNull()
      expect(isBlockedAddress(a), a).toBe(true)
      expect(isBlockedHost(a), a).toBe(true)
    }
  })
  it('the URL parser turns those spellings into the plain address, which is then refused', () => {
    for (const h of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://0/',
      'http://169.254.169.254./',
      'http://[::ffff:127.0.0.1]/',
      'http://[0:0:0:0:0:0:0:1]/',
      'http://１２７.0.0.1/',
    ])
      expect(isBlockedHost(new URL(h).hostname), h).toBe(true)
  })
  it('a public IPv4 inside a mapped / NAT64 / 6to4 wrapper is judged as that public address', () => {
    for (const a of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])
      expect(isBlockedAddress(a), a).toBe(false)
  })
})

describe('boundaries of each IPv4 range', () => {
  it.each([
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['126.255.255.255', false],
    ['127.255.255.255', true],
    ['128.0.0.0', false],
    ['169.253.255.255', false],
    ['169.254.0.0', true],
    ['169.255.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.0.0.0', true],
    ['192.0.1.0', false],
    ['192.0.2.255', true],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.169.0.0', false],
    ['198.17.255.255', false],
    ['198.18.0.0', true],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    ['198.51.100.0', true],
    ['203.0.113.255', true],
    ['223.255.255.255', false],
    ['224.0.0.0', true],
    ['255.255.255.255', true],
  ])('%s -> %s', (a, want) => expect(isBlockedAddress(a)).toBe(want))
})

describe('parsers', () => {
  it('parseIPv6 handles :: at either end, in the middle, and a dotted tail', () => {
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('1:2::7:8')).toEqual([1, 2, 0, 0, 0, 0, 7, 8])
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
  })
  it.each([
    '1::2::3',
    ':::',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    'g::1',
    '12345::',
    '::1.2.3',
    '::1.2.3.256',
    '1.2.3.4',
  ])('parseIPv6 rejects %j', (a) => expect(parseIPv6(a)).toBeNull())
  it('a one-million-character string is refused quickly and without hanging the parser', () => {
    expect(isBlockedAddress('1'.repeat(1_000_000))).toBe(true)
    expect(isBlockedAddress(':'.repeat(1_000_000))).toBe(true)
    expect(isBlockedAddress(`${'0:'.repeat(500_000)}1`)).toBe(true)
  })
})

describe('hosts', () => {
  it('normalizeHost drops brackets, case and every trailing dot', () => {
    expect(normalizeHost('[::1]')).toBe('::1')
    expect(normalizeHost('LocalHost.')).toBe('localhost')
    expect(normalizeHost('127.0.0.1..')).toBe('127.0.0.1')
  })
  it('isBlockedHost: literals and number-shaped hosts are judged before any lookup; real names are not', () => {
    expect(isBlockedHost('127.0.0.1.')).toBe(true) // trailing dot
    expect(isBlockedHost('[fe80::1]')).toBe(true)
    expect(isBlockedHost('')).toBe(true)
    expect(isBlockedHost('93.184.216.34')).toBe(false)
    expect(isBlockedHost('feeds.example.org')).toBe(false) // a name: resolve it, then check the addresses
    expect(isBlockedHost('127.0.0.1.nip.io')).toBe(false) // still a name; its resolved address decides
  })
  it('isBlockedHostname names the hosts that are never public, with or without a trailing dot', () => {
    for (const h of [
      'localhost',
      'localhost.',
      'LOCALHOST',
      'a.localhost',
      'printer.local',
      'metadata.google.internal',
      'db.internal.',
      'intranet',
    ])
      expect(isBlockedHostname(h), h).toBe(true)
    for (const h of ['example.com', 'localhost.example.com', 'internal.example.com', 'a.b.co'])
      expect(isBlockedHostname(h), h).toBe(false)
  })
  it('isIpLiteral', () => {
    expect(isIpLiteral('[::1]')).toBe(true)
    expect(isIpLiteral('8.8.8.8.')).toBe(true)
    expect(isIpLiteral('example.com')).toBe(false)
    expect(isIpLiteral('127.1')).toBe(false)
  })
  it('isLoopbackHost is the named exception: localhost and 127/8 / ::1, never a name that starts with 127.', () => {
    for (const h of ['localhost', 'localhost.', '127.0.0.1', '127.9.9.9', '[::1]', '::ffff:127.0.0.1'])
      expect(isLoopbackHost(h), h).toBe(true)
    for (const h of [
      '127.evil.example.com',
      '127.0.0.1.evil.example.com',
      '10.0.0.1',
      '169.254.169.254',
      'localhost.evil.com',
      '::2',
      '8.8.8.8',
      '',
    ])
      expect(isLoopbackHost(h), h).toBe(false)
  })
  it('findBlockedAddress returns the offender, and one bad address among good ones is enough', () => {
    expect(findBlockedAddress(['93.184.216.34', '2606:4700:4700::1111'])).toBeUndefined()
    expect(findBlockedAddress(['93.184.216.34', '10.0.0.5', '8.8.8.8'])).toBe('10.0.0.5')
    expect(findBlockedAddress([])).toBeUndefined() // callers refuse an empty list themselves; see guarded-fetch tests
  })
})

describe('the module stays usable in the browser bundle', () => {
  it('address.ts imports nothing from node:', () => {
    const src = readFileSync(new URL('../src/address.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from\s+['"]node:/)
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(index).toContain("'./address.ts'")
    expect(index).not.toContain('guarded-fetch')
  })
})
