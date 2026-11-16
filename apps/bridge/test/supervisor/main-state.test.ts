// Main's one-line state for the Windows tray, and the first-start notes file (supervisor/main-state.ts).
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MainStatus } from '@talos-app/protocol'
import {
  FIRST_START_NOTES_FILE,
  firstStartNotesText,
  MAIN_STATE_FILE,
  mainStateText,
  screenExcerpt,
  writeFirstStartNotes,
  writeMainState,
} from '../../src/supervisor/main-state.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const st = (over: Partial<MainStatus>): MainStatus =>
  ({ phase: 'running', panePid: 1, sessionId: null, restarts: [], bridgeLive: true, ...over }) as MainStatus

describe('the state line', () => {
  it('phases', () => {
    expect(mainStateText(st({ phase: 'running' }))).toBe('main=running\n')
    for (const phase of ['starting', 'cleaning_up', 'waiting_to_restart'] as const)
      expect(mainStateText(st({ phase }))).toBe('main=starting\n')
    expect(mainStateText(st({ phase: 'stopped' }))).toBe('main=stopped\n')
    expect(mainStateText(st({ phase: 'blocked' }))).toBe('main=stopped\n')
  })
  it('sign-in wins over everything; a login dialog is sign-in too', () => {
    expect(mainStateText(st({ phase: 'running' }), { signin: true, waiting: 'trust' })).toBe('main=signin\n')
    expect(mainStateText(st({ needsYou: { kind: 'dialog', dialog: 'login' } as never }))).toBe('main=signin\n')
  })
  it('waits by kind; the warning waiting for a confirmation is dev_channels', () => {
    expect(mainStateText(st({ needsYou: { kind: 'dialog', dialog: 'trust' } as never }))).toBe('main=waiting:trust\n')
    expect(mainStateText(st({ needsYou: { kind: 'confirm_cold_start' } as never }))).toBe('main=waiting:dev_channels\n')
    expect(mainStateText(st({ phase: 'starting' }), { waiting: 'api_key' })).toBe('main=waiting:api_key\n')
    expect(mainStateText(st({ phase: 'starting', needsYou: { kind: 'start_stalled' } as never }))).toBe(
      'main=waiting:unknown\n',
    )
  })
  it('an unknown wait carries the screen, cleaned and redacted, on a second line of at most 200 characters', () => {
    const t = mainStateText(st({ phase: 'starting' }), {
      waiting: 'unknown',
      screen: [
        '\u001b[1m╭────╮ A new screen\u001b[0m',
        `key sk-ant-api03-${'x'.repeat(40)} and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig`,
        'https://example.com/cb?code=abc123&state=zzz',
        '\u2028\u202e hidden',
        'y'.repeat(400),
      ],
    })
    const [line, excerpt, rest] = t.split('\n')
    expect(line).toBe('main=waiting:unknown')
    expect(rest).toBe('')
    expect(excerpt).toContain('A new screen')
    for (const bad of ['sk-ant', 'eyJ', 'abc123', 'zzz', '\\u001b', '\\u2028', '\\u202e', '\\u2500'])
      expect(excerpt, bad).not.toContain(JSON.parse(`"${bad}"`))
    expect([...(excerpt as string)].length).toBeLessThanOrEqual(200)
  })
  it('written atomically, 0600, under run/', () => {
    const d = mkdtempSync(join(tmpdir(), 'talos-state-'))
    dirs.push(d)
    writeMainState(d, 'main=running\n')
    expect(readFileSync(join(d, MAIN_STATE_FILE), 'utf8')).toBe('main=running\n')
    expect(statSync(join(d, MAIN_STATE_FILE)).mode & 0o777).toBe(0o600)
  })
  it('screenExcerpt of nothing is empty', () => {
    expect(screenExcerpt([])).toBe('')
  })
})

describe('the first-start notes file', () => {
  it('a heading the owner can read, then the notes, redacted, 0600', () => {
    const at = new Date('2026-11-12T12:00:00Z')
    const text = firstStartNotesText(
      ['Security notes:', '1. Claude can make mistakes.', `sk-ant-${'z'.repeat(40)}`],
      at,
    )
    expect(text.split('\n')[0]).toBe(
      'Claude Code showed its security notes on first start (2026-11-12T12:00:00.000Z); the supervisor pressed Enter:',
    )
    expect(text).toContain('1. Claude can make mistakes.')
    expect(text).not.toContain('zzzz')
    const d = mkdtempSync(join(tmpdir(), 'talos-notes-'))
    dirs.push(d)
    writeFirstStartNotes(d, ['Security notes:'], at)
    expect(statSync(join(d, FIRST_START_NOTES_FILE)).mode & 0o777).toBe(0o600)
  })
})
