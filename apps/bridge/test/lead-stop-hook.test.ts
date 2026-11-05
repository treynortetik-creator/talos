// The BOARD.md Stop hook, run for real with bash: it blocks a stop once, with a plain reason, when the board was not
// rewritten this turn or is over 4 KB; it never blocks twice in a row and it fails open on anything broken.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const TEMPLATES = resolve(import.meta.dir, '..', '..', '..', 'kit', 'templates', 'lead')
const STOP = join(TEMPLATES, 'board-stop.sh')
const TURN = join(TEMPLATES, 'turn-start.sh')
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const lead = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'tl-hook-'))
  made.push(d)
  mkdirSync(join(d, '.claude'))
  return d
}
const at = (p: string, secs: number) => utimesSync(p, secs, secs)
const run = (script: string, dir: string, stdin: string) =>
  spawnSync('bash', [script], {
    input: stdin,
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  })
const stop = (dir: string, active = false) =>
  run(STOP, dir, JSON.stringify({ stop_hook_active: active, session_id: 's' }))
const blocked = (r: { stdout: string }) => (r.stdout.trim() ? JSON.parse(r.stdout) : null)

describe('board-stop.sh', () => {
  test('a board older than the turn blocks once, with a plain reason naming the file and the 4 KB limit', () => {
    const d = lead()
    writeFileSync(join(d, 'BOARD.md'), 'old')
    writeFileSync(join(d, '.claude', '.turn-start'), '')
    at(join(d, 'BOARD.md'), 1000)
    at(join(d, '.claude', '.turn-start'), 2000)
    const r = stop(d)
    expect(r.status).toBe(0)
    const b = blocked(r)
    expect(b.decision).toBe('block')
    expect(b.reason).toContain('BOARD.md')
    expect(b.reason).toMatch(/4 KB/)
    expect(b.reason).not.toMatch(/[\r\n]{3}/)
  })

  test('the stop that follows the block is let through, even though the board is still wrong (never a loop)', () => {
    const d = lead()
    expect(blocked(stop(d))?.decision).toBe('block') // no board at all
    const again = stop(d, true)
    expect(again.status).toBe(0)
    expect(again.stdout.trim()).toBe('')
  })

  test('a board written this turn and within 4 KB passes without a word', () => {
    const d = lead()
    writeFileSync(join(d, '.claude', '.turn-start'), '')
    writeFileSync(join(d, 'BOARD.md'), '# Now\nship it\n')
    at(join(d, '.claude', '.turn-start'), 1000)
    at(join(d, 'BOARD.md'), 2000)
    const r = stop(d)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  test('a board over 4096 bytes blocks even when it is fresh, and says by how much to trim', () => {
    const d = lead()
    writeFileSync(join(d, 'BOARD.md'), 'z'.repeat(4097))
    const b = blocked(stop(d))
    expect(b.decision).toBe('block')
    expect(b.reason).toMatch(/under 4 KB|4096/)
  })

  test('no turn marker: the size is still checked but age is not (fail open on the part it cannot know)', () => {
    const d = lead()
    writeFileSync(join(d, 'BOARD.md'), 'ok')
    at(join(d, 'BOARD.md'), 5)
    expect(stop(d).stdout.trim()).toBe('')
  })

  test('empty or invalid stdin fails open: exit 0 and not one byte on stdout, even with no board', () => {
    const d = lead() // no BOARD.md: a valid stop would be blocked
    for (const input of ['', '\n', 'not json {{{', '[1,2]', '{"stop_hook_active": tru', 'null'] as const) {
      const r = run(STOP, d, input)
      expect(r.status, JSON.stringify(input)).toBe(0)
      expect(r.stdout, JSON.stringify(input)).toBe('')
    }
    expect(blocked(stop(d))?.decision).toBe('block') // a real stop in the same folder still is
  })

  test('a missing or unreadable project folder exits 0 and prints nothing', () => {
    const d = lead()
    for (const dir of [join(d, 'nope'), join(d, 'nope', 'deeper')]) {
      const r = run(STOP, dir, '{"session_id":"s"}')
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
})

describe('turn-start.sh', () => {
  test('stamps the marker the Stop hook compares the board against, and exits 0 even when it cannot', () => {
    const d = lead()
    expect(run(TURN, d, '{}').status).toBe(0)
    expect(require('node:fs').existsSync(join(d, '.claude', '.turn-start'))).toBe(true)
    expect(run(TURN, join(d, 'missing'), '{}').status).toBe(0)
  })
})
