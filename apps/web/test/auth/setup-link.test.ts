import { newEnrollCode } from '@talos-app/protocol'
import { describe, expect, test } from 'vitest'
import { parseSetupLink } from '../../src/features/auth/passkeys.ts'

const code = newEnrollCode()
const FP = 'A'.repeat(42) + 'b'

describe('parseSetupLink', () => {
  test('a plain link and a bare code give the code', () => {
    expect(parseSetupLink(`https://relay.example/enroll#${code}`)).toBe(code)
    expect(parseSetupLink(code)).toBe(code)
  })
  test('a link with a good fp gives the code (a browser pins nothing)', () => {
    expect(parseSetupLink(`https://relay.example/enroll#${code}&fp=${FP}`)).toBe(code)
  })
  test('a link with a bad or repeated fp gives null', () => {
    expect(parseSetupLink(`https://relay.example/enroll#${code}&fp=short`)).toBeNull()
    expect(parseSetupLink(`https://relay.example/enroll#${code}&fp=${FP}&fp=${FP}`)).toBeNull()
  })
  test('garbage gives null', () => expect(parseSetupLink('nonsense')).toBeNull())
})
