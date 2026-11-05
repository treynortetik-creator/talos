// The per-storage-jar device key (spec 3.5): ECDSA P-256, non-extractable, stored as a CryptoKey in IndexedDB.
import { createDeviceKey, type DeviceKey } from '@talos-app/protocol'
import type { Storage } from './storage.ts'

const KEY = 'device'

export async function loadDeviceKey(storage: Storage): Promise<DeviceKey | null> {
  const k = await storage.get<DeviceKey>('keys', KEY)
  return k?.privateKey && k.publicJwk && k.deviceId ? k : null
}

export async function ensureDeviceKey(storage: Storage): Promise<DeviceKey> {
  const existing = await loadDeviceKey(storage)
  if (existing) return existing
  const created = await createDeviceKey()
  await storage.put('keys', KEY, created)
  return created
}

export async function deleteDeviceKey(storage: Storage): Promise<void> {
  await storage.del('keys', KEY)
}
