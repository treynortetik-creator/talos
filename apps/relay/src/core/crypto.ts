// AES-256-GCM field and file encryption (spec 5.4). Blob layout: 12-byte IV | ciphertext | 16-byte tag.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CryptoService } from '../services.ts'

export function createCryptoService(dataKeyB64: string): CryptoService {
  const key = Buffer.from(dataKeyB64, 'base64')
  if (key.length !== 32) throw new Error('DATA_KEY must decode to 32 bytes')
  return {
    encrypt(plain, aad) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(Buffer.from(aad))
      const ct = Buffer.concat([c.update(plain), c.final()])
      return new Uint8Array(Buffer.concat([iv, ct, c.getAuthTag()]))
    },
    decrypt(blob, aad) {
      const b = Buffer.from(blob)
      if (b.length < 28) throw new Error('ciphertext too short')
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
      d.setAAD(Buffer.from(aad))
      d.setAuthTag(b.subarray(b.length - 16))
      return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]))
    },
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function sealJson(crypto: CryptoService, value: unknown, aad: string): Buffer {
  return Buffer.from(crypto.encrypt(enc.encode(JSON.stringify(value)), aad))
}

export function openJson<T = unknown>(crypto: CryptoService, blob: Uint8Array, aad: string): T {
  return JSON.parse(dec.decode(crypto.decrypt(blob, aad))) as T
}
