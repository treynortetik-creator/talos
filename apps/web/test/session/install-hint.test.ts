// L1: the phone must never show a raw command with a literal placeholder.
import { describe, expect, it } from 'vitest'
import { INSTALL_HINT } from '../../src/features/session/logic.ts'

describe('INSTALL_HINT', () => {
  it('tells him the mod needs loading on the Mac, with no placeholder and no raw command', () => {
    expect(INSTALL_HINT).toMatch(/mod/i)
    expect(INSTALL_HINT).toMatch(/Mac/)
    expect(INSTALL_HINT).not.toMatch(/[<>]/)
    expect(INSTALL_HINT).not.toContain('TALOS_APP_DIR')
    expect(INSTALL_HINT).not.toContain('--plugin-dir')
    expect(INSTALL_HINT).not.toMatch(/\bclaude\b\s+--/)
  })
})
