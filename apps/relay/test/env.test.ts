import { describe, expect, it } from 'vitest'
import { apnsConfigFromEnv } from '../src/core/push-apns.ts'
import { loadEnv } from '../src/env.ts'

const KEY = Buffer.alloc(32, 7).toString('base64')
const base = { PUBLIC_ORIGIN: 'https://relay.example.com', RP_ID: 'relay.example.com', DATA_KEY: KEY }

describe('relay env', () => {
  it('applies the section 11 defaults', () => {
    const e = loadEnv(base)
    expect(e).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      DATA_DIR: './data',
      RP_NAME: 'Talos',
      BRIDGE_PUBKEY_FORCE: false,
      VOICE_MODEL: 'gpt-live-1',
      VOICE_DAILY_MAX_MIN: 60,
      VOICE_SESSION_MAX_MIN: 30,
      BUFFER_DAYS: 7,
      MEDIA_MAX_MB: 50,
      MEDIA_UPLOADS_PER_HOUR: 60,
      MEDIA_DAILY_MAX_MB: 200,
      SESSION_TTL_DAYS: 30,
      SESSION_IDLE_DAYS: 14,
      VOLUME_SOFT_CAP_MB: 800,
      TRUST_PROXY_HOPS: 1,
      WORK_INTEGRATIONS: 'allow',
      LOG_LEVEL: 'info',
    })
  })
  it('MEDIA_MAX_MB is 1 to 50; an old VOICE_PROVIDER variable is ignored, whatever its value', () => {
    expect(loadEnv({ ...base, MEDIA_MAX_MB: '50' }).MEDIA_MAX_MB).toBe(50)
    expect(() => loadEnv({ ...base, MEDIA_MAX_MB: '51' })).toThrow(/MEDIA_MAX_MB/)
    expect(loadEnv({ ...base, VOICE_PROVIDER: 'realtime' })).not.toHaveProperty('VOICE_PROVIDER')
    expect(loadEnv({ ...base, VOICE_PROVIDER: 'live' })).not.toHaveProperty('VOICE_PROVIDER')
  })
  it('upload and sign-in limits are settable, bounded, and an idle time longer than the sign-in itself fails boot', () => {
    const e = loadEnv({
      ...base,
      MEDIA_UPLOADS_PER_HOUR: '600',
      MEDIA_DAILY_MAX_MB: '2000',
      SESSION_TTL_DAYS: '90',
      SESSION_IDLE_DAYS: '45',
    })
    expect(e).toMatchObject({
      MEDIA_UPLOADS_PER_HOUR: 600,
      MEDIA_DAILY_MAX_MB: 2000,
      SESSION_TTL_DAYS: 90,
      SESSION_IDLE_DAYS: 45,
    })
    expect(() => loadEnv({ ...base, SESSION_TTL_DAYS: '10', SESSION_IDLE_DAYS: '11' })).toThrow(/SESSION_IDLE_DAYS/)
    expect(() => loadEnv({ ...base, SESSION_IDLE_DAYS: '31' })).toThrow(/SESSION_IDLE_DAYS/) // the default TTL is 30
    expect(loadEnv({ ...base, SESSION_TTL_DAYS: '14', SESSION_IDLE_DAYS: '14' }).SESSION_IDLE_DAYS).toBe(14)
    for (const bad of [
      { MEDIA_UPLOADS_PER_HOUR: '0' },
      { MEDIA_DAILY_MAX_MB: '-1' },
      { SESSION_TTL_DAYS: '0' },
      { SESSION_TTL_DAYS: 'x' },
    ])
      expect(() => loadEnv({ ...base, ...bad })).toThrow(Object.keys(bad)[0] as string)
  })
  it('normalizes PUBLIC_ORIGIN (trailing slash, path) (path still rejected)', () => {
    expect(loadEnv({ ...base, PUBLIC_ORIGIN: 'https://relay.example.com/' }).PUBLIC_ORIGIN).toBe(
      'https://relay.example.com',
    )
    expect(() => loadEnv({ ...base, PUBLIC_ORIGIN: 'https://relay.example.com/x' })).toThrow(/PUBLIC_ORIGIN/)
  })
  it('requires origin, RP id and a 32-byte key', () => {
    expect(() => loadEnv({})).toThrow(/PUBLIC_ORIGIN/)
    expect(() => loadEnv({ ...base, DATA_KEY: 'short' })).toThrow(/DATA_KEY/)
    expect(() => loadEnv({ ...base, DATA_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/DATA_KEY/)
  })
  it('RP_ID must be the origin host', () => {
    expect(() => loadEnv({ ...base, RP_ID: 'other.example.com' })).toThrow(/RP_ID/)
    expect(() => loadEnv({ ...base, PUBLIC_ORIGIN: 'https://relay.example.com/app' })).toThrow(/PUBLIC_ORIGIN/)
  })
  it('production needs https and VAPID settings', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/VAPID/)
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://relay.example.com',
        VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
        VAPID_SUBJECT: 'mailto:owner@example.com',
      }),
    ).toThrow(/https/)
    const ok = loadEnv({
      ...base,
      NODE_ENV: 'production',
      VAPID_PUBLIC_KEY: 'a',
      VAPID_PRIVATE_KEY: 'b',
      VAPID_SUBJECT: 'mailto:owner@example.com',
    })
    expect(ok.NODE_ENV).toBe('production')
  })
  it('VAPID subject must be mailto: or https:', () => {
    expect(() => loadEnv({ ...base, VAPID_SUBJECT: 'http://localhost' })).toThrow(/VAPID_SUBJECT/)
  })
  it('treats empty strings as unset and coerces numbers and flags', () => {
    const e = loadEnv({ ...base, PORT: '9090', BRIDGE_PUBKEY: '', BRIDGE_PUBKEY_FORCE: '1', OPENAI_API_KEY: '' })
    expect(e.PORT).toBe(9090)
    expect(e.BRIDGE_PUBKEY).toBeUndefined()
    expect(e.BRIDGE_PUBKEY_FORCE).toBe(true)
    expect(e.OPENAI_API_KEY).toBeUndefined()
  })
  it('validates the bridge public key shape and WORK_INTEGRATIONS', () => {
    expect(() => loadEnv({ ...base, BRIDGE_PUBKEY: 'nope' })).toThrow(/BRIDGE_PUBKEY/)
    expect(loadEnv({ ...base, BRIDGE_PUBKEY: 'A'.repeat(43), WORK_INTEGRATIONS: 'off' }).WORK_INTEGRATIONS).toBe('off')
    expect(() => loadEnv({ ...base, WORK_INTEGRATIONS: 'maybe' })).toThrow(/WORK_INTEGRATIONS/)
  })
  it('APNs variables never stop the relay booting: partial, malformed or the spec names all load', () => {
    const all = {
      APNS_KEY_ID: 'ABCDE12345',
      APNS_TEAM_ID: 'TEAMID1234',
      APNS_KEY_P8: 'k',
      APNS_BUNDLE_ID: 'com.example.talos',
    }
    expect(loadEnv(base).APNS_KEY_ID).toBeUndefined()
    expect(loadEnv({ ...base, ...all }).APNS_BUNDLE_ID).toBe('com.example.talos')
    expect(() => loadEnv({ ...base, APNS_KEY_ID: 'ABCDE12345' })).not.toThrow()
    expect(() => loadEnv({ ...base, ...all, APNS_TEAM_ID: 'short', APNS_KEY_ID: 'abc' })).not.toThrow()
    expect(() => loadEnv({ ...base, APNS_KEY: 'x', APNS_TOPIC: 'y' })).not.toThrow()
    expect(loadEnv({ ...base, APNS_KEY_ID: '', APNS_TEAM_ID: '' }).APNS_TEAM_ID).toBeUndefined()
  })
  it('apnsConfigFromEnv: all four good = a config; anything else = null and a warning that names variables, not values', () => {
    const lines: string[] = []
    const log = {
      debug() {},
      info() {},
      error() {},
      warn: (o: object | string) => void lines.push(JSON.stringify(o)),
      child() {
        return this
      },
    }
    const all = {
      APNS_KEY_ID: 'ABCDE12345',
      APNS_TEAM_ID: 'TEAMID1234',
      APNS_KEY_P8: 'SECRETKEYBODY',
      APNS_BUNDLE_ID: 'com.example.talos',
    }
    expect(apnsConfigFromEnv(all, log)).toEqual({
      keyId: 'ABCDE12345',
      teamId: 'TEAMID1234',
      keyP8: 'SECRETKEYBODY',
      bundleId: 'com.example.talos',
    })
    expect(apnsConfigFromEnv({}, log)).toBeNull()
    expect(lines).toEqual([]) // nothing set is not a mistake
    expect(apnsConfigFromEnv({ ...all, APNS_TEAM_ID: undefined }, log)).toBeNull()
    expect(apnsConfigFromEnv({ ...all, APNS_KEY_ID: 'abcde12345' }, log)).toBeNull()
    expect(apnsConfigFromEnv({ ...all, APNS_BUNDLE_ID: 'has space' }, log)).toBeNull()
    expect(lines.join('\n')).toMatch(/APNS_TEAM_ID/)
    expect(lines.join('\n')).toMatch(/APNS_KEY_ID/)
    expect(lines.join('\n')).not.toMatch(/SECRETKEYBODY|has space|abcde12345/)
  })
})
