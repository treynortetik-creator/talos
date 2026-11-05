// withStepup: trust mode skips the passkey tap on the first try and falls back to it when the relay still asks.
import { describe, expect, it, vi } from 'vitest'
import { TalosClientError } from '../src/lib/client.ts'
import { HttpError } from '../src/lib/http.ts'
import { needsStepup, withStepup } from '../src/lib/stepup.ts'

const on = { trust_mode: true }
const client = () => ({ stepup: vi.fn(async (purpose: string) => `tok-${purpose}`) })

describe('withStepup', () => {
  it('trust off: taps first, sends once with the token (the old order, untouched)', async () => {
    const c = client()
    const run = vi.fn(async (t: string | undefined) => t)
    expect(await withStepup(c, {}, 'config:work', run)).toBe('tok-config:work')
    expect(c.stepup).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('tok-config:work')
  })

  it('trust off, config missing or trust_mode false: still taps first', async () => {
    for (const cfg of [undefined, null, { trust_mode: false }]) {
      const c = client()
      await withStepup(c, cfg, 'device:revoke', async (t) => t)
      expect(c.stepup).toHaveBeenCalledTimes(1)
    }
  })

  it('trust on: sends without a token and never taps when the relay accepts it', async () => {
    const c = client()
    const run = vi.fn(async (t: string | undefined) => t ?? 'no-token')
    expect(await withStepup(c, on, 'config:work', run)).toBe('no-token')
    expect(c.stepup).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('trust on against an older relay: stepup_required on the socket, then one tap and one retry', async () => {
    const c = client()
    const run = vi.fn(async (t: string | undefined) => {
      if (!t) throw new TalosClientError('stepup_required')
      return t
    })
    expect(await withStepup(c, on, 'config:session', run)).toBe('tok-config:session')
    expect(c.stepup).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('trust on against an older relay: the HTTP 403 stepup_invalid also retries with a tap', async () => {
    const c = client()
    const run = vi.fn(async (t: string | undefined) => {
      if (!t) throw new HttpError(403, undefined, { error: 'stepup_invalid' })
      return t
    })
    expect(await withStepup(c, on, 'device:revoke', run)).toBe('tok-device:revoke')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('trust on: any other failure is thrown as it is, with no tap and no second try', async () => {
    const c = client()
    for (const err of [
      new TalosClientError('config_conflict'),
      new HttpError(404, undefined, { error: 'not_found' }),
      new HttpError(403, undefined, { error: 'csrf' }),
      new Error('offline'),
    ]) {
      const run = vi.fn(async () => {
        throw err
      })
      await expect(withStepup(c, on, 'config:work', run)).rejects.toBe(err)
      expect(run).toHaveBeenCalledTimes(1)
    }
    expect(c.stepup).not.toHaveBeenCalled()
  })

  it('trust on: if the retry is refused again, the owner sees that refusal', async () => {
    const c = client()
    const second = new TalosClientError('stepup_invalid')
    const run = vi.fn(async (t: string | undefined) => {
      throw t ? second : new TalosClientError('stepup_required')
    })
    await expect(withStepup(c, on, 'config:work', run)).rejects.toBe(second)
  })

  it('needsStepup knows only the two refusals', () => {
    expect(needsStepup(new TalosClientError('stepup_required'))).toBe(true)
    expect(needsStepup(new TalosClientError('stepup_invalid'))).toBe(true)
    expect(needsStepup(new TalosClientError('bad_frame'))).toBe(false)
    expect(needsStepup(new HttpError(401, undefined, { error: 'stepup_invalid' }))).toBe(false)
    expect(needsStepup('stepup_required')).toBe(false)
  })
})
