// A linked agent's connection id is a capability (it is in the inbox url), so a report or a log tail must not carry it.
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

describe('linked-agent addresses in reports', () => {
  it('hides an inbox url path and a bare connection id', () => {
    const url = 'https://relay.example.com/hook/peer/cn_8fK2aBcDeFgHiJkLmNoPqR'
    const out = redact(`sending to ${url} failed`)
    expect(out).not.toContain('cn_8fK2aBcDeFgHiJkLmNoPqR')
    expect(out).toContain('https://relay.example.com/hook/peer/')
    const bare = redact('inbound for conn cn_8fK2aBcDeFgHiJkLmNoPqR dropped')
    expect(bare).not.toContain('cn_8fK2aBcDeFgHiJkLmNoPqR')
    expect(bare).toContain('conn')
    expect(redact('nothing here, just cn_short')).toBe('nothing here, just cn_short')
  })
})
