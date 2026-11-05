// `pnpm drive` argument handling, run through the real script. Every case here is refused (or answered) before any
// Playwright run starts, so nothing is spawned beyond the script itself.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../e2e/drive.ts', import.meta.url))
const drive = (...args: string[]) => {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('pnpm drive arguments', () => {
  it('list prints the journeys and exits 0', () => {
    const r = drive('list')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/revoke/)
  })

  it('list and help refuse extra words and flags, and say so', () => {
    for (const args of [
      ['list', 'revoke'],
      ['list', '--repeat-each', '3'],
      ['help', '-x'],
      ['--help', '--repeat-each', '3'],
    ]) {
      const r = drive(...args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(r.err, args.join(' ')).toMatch(/takes no other words or flags/)
    }
  })

  it('the hint for an unknown flag keeps the flag value', () => {
    const r = drive('revoke', '--repeat-each', '3')
    expect(r.code).toBe(2)
    expect(r.err).toContain('pnpm drive revoke -- --repeat-each 3')
    expect(r.err).not.toMatch(/One journey at a time/)
  })

  it('a flag written with = is one token', () => {
    expect(drive('revoke', '--workers=2').err).toContain('pnpm drive revoke -- --workers=2')
  })

  it('a short flag gets the flag message, not "no journey called"', () => {
    const r = drive('revoke', '-g', 'tablet')
    expect(r.code).toBe(2)
    expect(r.err).toContain('pnpm drive revoke -- -g tablet')
    expect(r.err).not.toMatch(/No journey called/)
  })

  it('two journey names are refused', () => {
    const r = drive('revoke', 'relay-restart')
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/One journey at a time/)
  })
})
