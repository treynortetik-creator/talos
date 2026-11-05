// The hourly upload budget (rate-limit name `media`) comes from MEDIA_UPLOADS_PER_HOUR, through the real auth state.
import { describe, expect, it } from 'vitest'
import { authState } from '../../src/auth/state.ts'
import { createFakeServices } from '../helpers/fake-services.ts'

const used = (env: Record<string, string>) => {
  const fake = createFakeServices({ env })
  const { limiter } = authState(fake.services)
  let n = 0
  while (n < 5000 && limiter.take('media', 'owner').ok) n++
  return { n, limiter, fake }
}

describe('MEDIA_UPLOADS_PER_HOUR', () => {
  it('the default stays 60 an hour', () => {
    expect(used({}).n).toBe(60)
  })
  it('600 allows 600, and one more is refused with a wait time', () => {
    const { n, limiter } = used({ MEDIA_UPLOADS_PER_HOUR: '600' })
    expect(n).toBe(600)
    expect(limiter.take('media', 'owner')).toMatchObject({ ok: false })
  })
  it('a lower number lowers it, and the bucket refills with the clock', () => {
    const { n, limiter, fake } = used({ MEDIA_UPLOADS_PER_HOUR: '5' })
    expect(n).toBe(5)
    fake.clock.advance(3600_000)
    expect(limiter.take('media', 'owner').ok).toBe(true)
  })
  it('only the media bucket changes: other limits keep their built-in numbers', () => {
    const fake = createFakeServices({ env: { MEDIA_UPLOADS_PER_HOUR: '600' } })
    const { limiter } = authState(fake.services)
    let n = 0
    while (n < 5000 && limiter.take('revoke', 'ip').ok) n++
    expect(n).toBe(20)
  })
})
