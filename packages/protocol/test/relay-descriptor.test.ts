import { describe, expect, it } from 'vitest'
import {
  appMeetsMin,
  PROTOCOL_VERSION,
  RELAY_DESCRIPTOR_PATH,
  RelayDescriptor,
  RelayDescriptorRead,
} from '../src/index.ts'

const good = {
  protocol: PROTOCOL_VERSION,
  relay_version: '1.2.3',
  relay_id: 'r_abcdefghijklmnopqrst',
  kind: 'self',
  min_app: '1.0.0',
}

describe('RelayDescriptor', () => {
  it('has the well-known path', () => {
    expect(RELAY_DESCRIPTOR_PATH).toBe('/.well-known/talos-relay')
  })
  it('parses a good descriptor', () => {
    expect(RelayDescriptor.parse(good)).toEqual(good)
    expect(RelayDescriptor.parse({ ...good, kind: 'hosted' }).kind).toBe('hosted')
  })
  it('refuses a bad relay_id, kind, min_app, version or extra field', () => {
    for (const bad of [
      { ...good, relay_id: 'r_ABCDEFGHIJKLMNOPQRST' },
      { ...good, relay_id: 'r_abcdefghijklmnopqrs' },
      { ...good, relay_id: 'd_abcdefghijklmnopqrst' },
      { ...good, kind: 'other' },
      { ...good, min_app: '1.0' },
      { ...good, min_app: 'v1.0.0' },
      { ...good, relay_version: 'x'.repeat(65) },
      { ...good, extra: 1 },
    ])
      expect(RelayDescriptor.safeParse(bad).success).toBe(false)
  })
})

describe('RelayDescriptorRead', () => {
  it('ignores extra fields a newer relay may add', () => {
    const r = RelayDescriptorRead.parse({ ...good, extra: 'x', protocol: 2 })
    expect(r).toEqual({ ...good, protocol: 2 })
  })
  it('still refuses a bad field', () => {
    expect(RelayDescriptorRead.safeParse({ ...good, min_app: 'nope' }).success).toBe(false)
  })
})

describe('appMeetsMin', () => {
  it('is true for newer or equal, false for older or unreadable', () => {
    expect(appMeetsMin('1.2.0', { min_app: '1.1.9' })).toBe(true)
    expect(appMeetsMin('1.1.9', { min_app: '1.1.9' })).toBe(true)
    expect(appMeetsMin('1.1.8', { min_app: '1.1.9' })).toBe(false)
    expect(appMeetsMin('10.0.0', { min_app: '9.9.9' })).toBe(true)
    expect(appMeetsMin('garbage', { min_app: '0.0.0' })).toBe(false)
    expect(appMeetsMin('', { min_app: '0.0.0' })).toBe(false)
  })
  it('refuses a relay_version over 64 characters (the relay then refuses to boot)', () => {
    const good = {
      protocol: PROTOCOL_VERSION,
      relay_version: 'v',
      relay_id: 'r_abcdefghijklmnopqrst',
      kind: 'self',
      min_app: '0.0.0',
    }
    expect(RelayDescriptor.safeParse({ ...good, relay_version: 'x'.repeat(64) }).success).toBe(true)
    expect(RelayDescriptor.safeParse({ ...good, relay_version: 'x'.repeat(65) }).success).toBe(false)
  })
})
