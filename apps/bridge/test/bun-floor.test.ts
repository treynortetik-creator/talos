// The oldest Bun Talos supports: the number, the comparison, and the words a person on an older Bun sees (installer, update,
// doctor and the bridge's own start all use these).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUN_FLOOR, bunAtLeast, bunDoctorRow, bunTooOld, reportOldBun } from '../src/bun-floor.ts'

const FILE = join(import.meta.dir, '..', 'src', 'bun-floor.ts')

describe('the Bun floor', () => {
  test('is 1.4.4: an older Bun fails it, 1.4.4 and newer pass', () => {
    expect(BUN_FLOOR).toBe('1.4.4')
    for (const v of ['1.3.11', '1.3.12', '1.4.3', '1.2.99', '0.9.0']) expect(bunAtLeast(v, BUN_FLOOR), v).toBe(false)
    for (const v of ['1.4.4', '1.4.5', '1.10.0', '2.0.0', '1.4.4-canary.1', '1.4.5+abc'])
      expect(bunAtLeast(v, BUN_FLOOR), v).toBe(true)
  })

  test('an older Bun is told how to upgrade, one line per platform; a new enough one is told nothing', () => {
    expect(bunTooOld('1.4.4')).toBeUndefined()
    expect(bunTooOld('1.3.11')).toBe(
      [
        'Bun 1.3.11 is older than 1.4.4, the oldest Talos supports. Upgrade it, then restart the agent:',
        '  macOS or Linux (or a WSL distro you set up yourself): bun upgrade (no Bun at all: curl -fsSL https://bun.sh/install | bash)',
        '  Windows, set up with Talos Setup: download the newest Talos Setup and open it; it installs the Bun Talos needs in its WSL distro',
      ].join('\n'),
    )
  })

  test('the doctor row: ok for a new enough Bun; FAIL for an older one, with the same upgrade lines under it', () => {
    expect(bunDoctorRow('1.4.4')).toEqual({ level: 'ok', detail: '1.4.4 (needs 1.4.4 or newer)' })
    expect(bunDoctorRow('1.3.11')).toEqual({
      level: 'FAIL',
      detail: [
        '1.3.11 (needs 1.4.4 or newer). Upgrade it, then restart the agent:',
        '      macOS or Linux (or a WSL distro you set up yourself): bun upgrade (no Bun at all: curl -fsSL https://bun.sh/install | bash)',
        '      Windows, set up with Talos Setup: download the newest Talos Setup and open it; it installs the Bun Talos needs in its WSL distro',
      ].join('\n'),
    })
  })

  test('run as a script: exit 1 with the words for an older Bun, exit 0 and silent for a new enough one', () => {
    const old = Bun.spawnSync([process.execPath, '--no-env-file', FILE, '1.3.11'], { stdout: 'pipe', stderr: 'pipe' })
    expect(old.exitCode).toBe(1)
    expect(old.stderr.toString()).toBe(`${bunTooOld('1.3.11')}\n`)
    const ok = Bun.spawnSync([process.execPath, '--no-env-file', FILE, '1.4.4'], { stdout: 'pipe', stderr: 'pipe' })
    expect(ok.exitCode).toBe(0)
    expect(`${ok.stdout}${ok.stderr}`).toBe('')
  })

  test('the bridge on an older Bun logs an error (a problem report) and says how on stderr, and keeps running', () => {
    const errors: [string, unknown][] = []
    const written: string[] = []
    const log = { error: (msg: string, fields?: unknown) => errors.push([msg, fields]) }
    reportOldBun('1.3.11', log, (s) => written.push(s))
    expect(errors).toEqual([
      [
        'bun is older than the oldest Talos supports: upgrade it (talos-app doctor says how), then restart the agent',
        { bun: '1.3.11', needs: '1.4.4' },
      ],
    ])
    expect(written).toEqual([`talos-app bridge: ${bunTooOld('1.3.11')}\n`])
    const none: unknown[] = []
    reportOldBun('1.4.4', { error: (m) => none.push(m) }, (s) => none.push(s))
    expect(none).toEqual([])
  })

  test("the bridge's start runs that report with its own Bun", () => {
    const server = readFileSync(join(import.meta.dir, '..', 'src', 'server.ts'), 'utf8')
    expect(server).toContain('reportOldBun(Bun.version, log, ')
  })
})
