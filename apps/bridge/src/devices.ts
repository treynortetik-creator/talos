// Pinned devices (spec 3.5, 4.10): `devices.json` on the Mac, never the relay. Read fresh when the file changes, because
// the CLI (`devices revoke`) edits it from another process. A revoked id keeps a tombstone so it is never re-pinned.

import { readFileSync } from 'node:fs'
import { fingerprintWords, type JwkP256T } from '@talos-app/protocol'
import { mtimeMs, writeJsonAtomic } from './fsutil.ts'
import { recordedWrite } from './tripwire.ts'

export type DeviceEntry = {
  id: string
  name: string
  pubkey_jwk?: JwkP256T
  fingerprint?: string[]
  pinned_at?: string
  revoked_at?: string
}
type DevicesFile = { version: 1; devices: DeviceEntry[] }

export class DeviceStore {
  private cache: DevicesFile = { version: 1, devices: [] }
  private seenMtime = -1
  private corrupt = false

  constructor(private readonly path: string) {}

  private load(): DevicesFile {
    const m = mtimeMs(this.path)
    if (m !== this.seenMtime) {
      this.cache = { version: 1, devices: [] }
      this.corrupt = false
      let text: string | undefined
      try {
        text = readFileSync(this.path, 'utf8')
      } catch (e) {
        // a missing file is a fresh install; anything else (permissions, a directory) is not safe to treat as empty
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.corrupt = true
      }
      if (text !== undefined) {
        try {
          const f = JSON.parse(text) as DevicesFile
          if (f && typeof f === 'object' && Array.isArray(f.devices)) this.cache = f
          else this.corrupt = true
        } catch {
          this.corrupt = true
        }
      }
      this.seenMtime = m
    }
    return this.cache
  }

  /** True when devices.json exists but cannot be read. Nobody is trusted then, and nothing is written over it. */
  isCorrupt(): boolean {
    this.load()
    return this.corrupt
  }

  list(): DeviceEntry[] {
    return this.load().devices.map((d) => ({ ...d }))
  }

  get(id: string): DeviceEntry | undefined {
    return this.load().devices.find((d) => d.id === id)
  }

  isRevoked(id: string): boolean {
    return Boolean(this.get(id)?.revoked_at)
  }

  /** The public key of a pinned, not revoked device. */
  pinnedKey(id: string): JwkP256T | undefined {
    const d = this.get(id)
    return d && !d.revoked_at && d.pubkey_jwk ? d.pubkey_jwk : undefined
  }

  pin(
    device: { id: string; name: string; pubkey_jwk: JwkP256T },
    at: string,
  ): { ok: true } | { ok: false; reason: 'revoked' | 'corrupt' } {
    const f = this.load()
    // Fail closed: rewriting a file we could not parse would drop its revoked tombstones and let a revoked device back in.
    if (this.corrupt) return { ok: false, reason: 'corrupt' }
    if (this.isRevoked(device.id)) return { ok: false, reason: 'revoked' }
    const entry: DeviceEntry = {
      id: device.id,
      name: device.name,
      pubkey_jwk: device.pubkey_jwk,
      fingerprint: [...fingerprintWords(device.id)],
      pinned_at: at,
    }
    this.write({ ...f, devices: [...f.devices.filter((d) => d.id !== device.id), entry] })
    return { ok: true }
  }

  revoke(id: string, at: string): void {
    const f = this.load()
    if (this.corrupt) throw new Error(`${this.path} is unreadable; fix or restore it before changing devices`)
    const cur = f.devices.find((d) => d.id === id)
    const next: DeviceEntry = cur ? { ...cur, revoked_at: cur.revoked_at ?? at } : { id, name: id, revoked_at: at }
    this.write({ ...f, devices: [...f.devices.filter((d) => d.id !== id), next] })
  }

  private write(f: DevicesFile) {
    recordedWrite(this.path, 'devices', () => writeJsonAtomic(this.path, f, 0o600))
    this.cache = f
    this.seenMtime = mtimeMs(this.path)
  }
}
