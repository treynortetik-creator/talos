// `form_save` on the owner's signed schedule.patch: "Save in my own schedule form". It is part of what the device signs, only
// `true` means anything, and a frame from before it (no field) is unchanged.
import { describe, expect, it } from 'vitest'
import {
  createDeviceKey,
  newUlid,
  ownerSignedString,
  parseFrame,
  SchedulePatchFrame,
  signOwnerFrame,
  verifyOwnerFrame,
} from '../src/index.ts'

const change = { op: 'delete', id: 'daily-digest', base_etag: `sha256:${'0'.repeat(64)}` }
const base = () => ({
  v: 1,
  type: 'schedule.patch',
  id: newUlid(),
  ts: new Date().toISOString(),
  change,
  thread_id: 'general',
})

describe('schedule.patch form_save', () => {
  it('is optional, and only true is accepted', async () => {
    const key = await createDeviceKey()
    const sign = (extra: Record<string, unknown>) =>
      signOwnerFrame({ ...base(), device_id: key.deviceId, ...extra }, key.privateKey)
    expect(SchedulePatchFrame.safeParse(await sign({})).success).toBe(true)
    expect(SchedulePatchFrame.safeParse(await sign({ form_save: true })).success).toBe(true)
    expect(SchedulePatchFrame.safeParse(await sign({ form_save: false })).success).toBe(false)
    expect(SchedulePatchFrame.safeParse(await sign({ form_save: 'yes' })).success).toBe(false)
    expect(SchedulePatchFrame.safeParse(await sign({ other: true })).success).toBe(false) // still strict
    expect(parseFrame(await sign({ form_save: true })).ok).toBe(true)
  })

  it('is inside the signature: adding it to, or taking it from, a signed frame breaks the signature', async () => {
    const key = await createDeviceKey()
    const without = await signOwnerFrame({ ...base(), device_id: key.deviceId }, key.privateKey)
    const withField = await signOwnerFrame({ ...base(), device_id: key.deviceId, form_save: true }, key.privateKey)
    expect(await verifyOwnerFrame(without, key.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame(withField, key.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame({ ...without, form_save: true }, key.publicJwk)).toBe(false)
    const { form_save: _removed, ...stripped } = withField
    expect(await verifyOwnerFrame(stripped, key.publicJwk)).toBe(false)
    expect(ownerSignedString(withField)).toContain('"form_save":true')
  })
})

describe('ack applied', () => {
  it('is optional on an ack, and only true is accepted', async () => {
    const { AckFrame } = await import('../src/index.ts')
    const ack = { v: 1, type: 'ack', id: newUlid(), ts: new Date().toISOString(), ref: newUlid() }
    expect(AckFrame.safeParse(ack).success).toBe(true)
    expect(AckFrame.safeParse({ ...ack, applied: true }).success).toBe(true)
    expect(AckFrame.safeParse({ ...ack, applied: false }).success).toBe(false)
  })
})
