// The commands JSON v1 (docs/HOOKS-AND-COMMANDS.md A): the shape `talos commands --json` prints, read by agents.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { COMMAND_EFFECTS, CommandsList, commandWho } from '../src/index.ts'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/commands-list.json', import.meta.url), 'utf8'))

describe('CommandsList', () => {
  test('the fixture parses, and keys a reader does not know are ignored', () => {
    const r = CommandsList.safeParse(fixture)
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true)
    expect(r.data?.commands).toHaveLength(4)
    const future = {
      ...fixture,
      future_top_level_key: 1,
      commands: fixture.commands.map((c: object) => ({ ...c, future_row_key: 1 })),
    }
    const f = CommandsList.parse(future)
    expect(Object.keys(f)).not.toContain('future_top_level_key')
    expect(Object.keys(f.commands[0] ?? {})).not.toContain('future_row_key')
  })

  test('a rename or removal is a schema bump: schema 2 and a missing schema are refused', () => {
    expect(CommandsList.safeParse({ ...fixture, schema: 2 }).success).toBe(false)
    const { schema: _s, ...none } = fixture
    expect(CommandsList.safeParse(none).success).toBe(false)
  })

  test('bad values are refused: who, risk, effects', () => {
    const row = fixture.commands[0]
    for (const bad of [{ who: 'root' }, { risk: 'medium' }, { effects: ['rm_rf'] }]) {
      expect(CommandsList.safeParse({ ...fixture, commands: [{ ...row, ...bad }] }).success, JSON.stringify(bad)).toBe(
        false,
      )
    }
    expect(COMMAND_EFFECTS).toEqual(['read', 'writes_home', 'writes_agent_dir', 'network', 'changes_app'])
  })

  test('who is derived from agent_may_run and needs_terminal', () => {
    expect(commandWho({ agent_may_run: true })).toBe('agent')
    expect(commandWho({ agent_may_run: false })).toBe('owner')
    expect(commandWho({ agent_may_run: false, needs_terminal: true })).toBe('owner_terminal')
  })
})
