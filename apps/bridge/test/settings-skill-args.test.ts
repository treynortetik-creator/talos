// gate-reads: kit/.claude/skills/talos-settings/SKILL.md
// The `talos-settings` kit skill teaches create_thread, so it names every argument the tool offers, and the other tools it relies
// on. The arguments live only in the bridge (SETUP_PROPS and the tool's own schema), so this check is here, not in protocol.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNUSABLE_LINE } from '../src/peer/link-cli.ts'
import { configPropose, settingsRead } from '../src/tools/config.ts'
import { setThreadInstructions } from '../src/tools/thread-instructions.ts'
import { createThread } from '../src/tools/threads.ts'
import { SETTINGS_LOCKED } from '../src/trust.ts'

const skill = readFileSync(join(import.meta.dir, '../../../kit/.claude/skills/talos-settings/SKILL.md'), 'utf8')

describe('talos-settings names what the bridge offers', () => {
  test('every create_thread argument appears as `name`', () => {
    const args = Object.keys((createThread.inputSchema as { properties: object }).properties)
    expect(args.length).toBeGreaterThan(10)
    for (const a of args) expect(skill, `create_thread argument ${a}`).toContain(`\`${a}\``)
  })
  test('every set_thread_instructions and config_propose argument appears', () => {
    for (const t of [setThreadInstructions, configPropose])
      for (const a of Object.keys((t.inputSchema as { properties: object }).properties))
        expect(skill, `${t.name} argument ${a}`).toContain(`\`${a}\``)
  })
  test('the tools it relies on exist by those names', () => {
    for (const t of [createThread, configPropose, settingsRead, setThreadInstructions])
      expect(skill).toContain(`\`${t.name}\``)
  })
})

// Every sentence of the bridge that the skill quotes. Exported constants are imported; a string written inline in its source is
// matched against the source text itself (the quoted fragment must be in that file), so a reworded bridge line fails here.
const src = (p: string) => readFileSync(join(import.meta.dir, '../src', p), 'utf8')
const quoted = (s: string) => expect(skill).toContain(s)

describe('talos-settings quotes the bridge exactly', () => {
  test('"Saved." starts a made change (inline in config-propose/service.ts)', () => {
    expect(src('config-propose/service.ts')).toContain('`Saved. ${')
    quoted('begins "Saved."')
  })
  test('the lock sentence starts as SETTINGS_LOCKED does (imported)', () => {
    expect(SETTINGS_LOCKED.startsWith('Talos settings are locked')).toBe(true)
    expect(skill).toContain('"Lock Talos settings"')
  })
  test('the card buttons are Apply, Keep settings and (theme) Keep current (inline in protocol config-propose.ts)', () => {
    const p = readFileSync(join(import.meta.dir, '../../../packages/protocol/src/config-propose.ts'), 'utf8')
    for (const b of ["primary_label: 'Apply'", "'Keep current' : 'Keep settings'"]) expect(p).toContain(b)
    for (const b of ['Apply', 'Keep settings', 'Keep current']) quoted(b)
  })
  test('the unusable-code line (imported UNUSABLE_LINE) and the waiting-code line (inline in peer/link-cli.ts)', () => {
    expect(UNUSABLE_LINE).toContain("this link code can't be used")
    quoted("this link code can't be used")
    expect(src('peer/link-cli.ts')).toContain('a link code is already waiting for')
    quoted('a link code is already waiting')
  })
})
