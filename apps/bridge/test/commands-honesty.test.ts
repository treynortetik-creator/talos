// The commands list tells the truth in both directions (docs/HOOKS-AND-COMMANDS.md A): the CLI has no command COMMANDS does not
// list, the usage text is made from COMMANDS, a terminal-only row is never marked for the agent, and the JSON has a schema.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type CommandInfoT, CommandsList, commandWho, EVENTS, EventsList } from '@talos-app/protocol'
import { runCli } from '../src/cli.ts'
import { COMMANDS, runTalos, usageText } from '../src/talos.ts'
import { BRIDGE_VERSION } from '../src/version.ts'
import { refusedForWorkers, WORKER_COMMANDS_OK, WORKER_OPS_READ_OK } from '../src/worker/cli-refusal.ts'

function io() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

const main = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli-main.ts'), 'utf8')
/** The names the CLI dispatches on: the `case` labels of the command switch in runCli, not the other switches in the file. */
const dispatched = (): string[] => {
  const body = main.slice(main.indexOf('switch (cmd) {'), main.indexOf('default:\n        io.out(USAGE)'))
  return [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1] as string)
}
/** Dispatch cases that are not commands a person types: Claude Code's per-call guard entry. */
const CASE_EXCEPTIONS = new Set(['guard-hook'])
/** Rows that are `talos` only (the kit's verbs and the list itself); `talos-app` has no such command, so its usage text omits them. */
const TALOS_ONLY = new Set(['commands', 'restore', 'update', 'rollback'])

describe('commands honesty', () => {
  test('every case in cli-main.ts is a COMMANDS top-level name, or on the short named list', () => {
    const top = new Set(COMMANDS.map((c) => c.name.split(' ')[0]))
    const cases = dispatched()
    expect(cases.length).toBeGreaterThan(20)
    for (const c of cases) expect(top.has(c) || CASE_EXCEPTIONS.has(c), `case '${c}' is not in COMMANDS`).toBe(true)
  })

  test('the usage text talos-app prints covers every row, and is made from args + summary', async () => {
    const r = io()
    expect(await runCli(['--help'], r.io, {})).toBe(0)
    const text = r.out.join('\n')
    expect(text).toBe(usageText(BRIDGE_VERSION))
    for (const c of COMMANDS) {
      if (TALOS_ONLY.has(c.name)) continue
      const spelled = c.name === 'update app' ? 'update' : c.name === 'rollback app' ? 'rollback' : c.name
      const line = text.split('\n').find((l) => l.startsWith(`  ${spelled}${c.args ? ` ${c.args}` : ''}  - `))
      expect(line, `usage line for ${c.name}`).toBeDefined()
      expect(line, `summary of ${c.name}`).toEndWith(`  - ${c.summary}`)
    }
  })

  test('every needs_terminal row has agent_may_run false', () => {
    for (const c of COMMANDS) if (c.needs_terminal) expect(c.agent_may_run, c.name).toBe(false)
  })

  test('WORKER_COMMANDS_OK is a subset of the agent_may_run rows (hook and guard-hook are Claude Code entries, named here)', () => {
    const rows = new Map(COMMANDS.map((c) => [c.name, c]))
    const ENTRIES = new Set(['hook', 'guard-hook'])
    for (const entry of WORKER_COMMANDS_OK) {
      if (ENTRIES.has(entry)) continue
      expect(rows.get(entry)?.agent_may_run, `${entry} must be an agent_may_run row`).toBe(true)
    }
    expect(WORKER_COMMANDS_OK).toContain('events')
    // the second list (a thread whose owner turned ops_read on): each entry's first word is an agent_may_run row, and the
    // list never overlaps the first one
    for (const entry of WORKER_OPS_READ_OK) {
      const first = entry.split(' ')[0] as string
      expect(rows.get(first)?.agent_may_run, `${entry}: ${first} must be an agent_may_run row`).toBe(true)
      expect(WORKER_COMMANDS_OK, entry).not.toContain(entry)
    }
    expect(refusedForWorkers(['events', '--json'])).toBe(false)
  })

  test("commands --json is schema 1, has app_version, keeps today's keys and parses against CommandsList", async () => {
    const r = io()
    expect(await runTalos(['commands', '--json'], r.io, {})).toBe(0)
    const raw = JSON.parse(r.out.join('\n')) as Record<string, unknown>
    expect(raw.schema).toBe(1)
    expect(raw.app_version).toBe(BRIDGE_VERSION)
    expect(raw.enforced).toBe('terminal')
    expect(typeof raw.note).toBe('string')
    const parsed = CommandsList.parse(raw)
    expect(parsed.commands).toHaveLength(COMMANDS.length)
    for (const c of parsed.commands) {
      expect(c.who, c.name).toBe(commandWho(c))
      expect('needs_mod' in c).toBe(false)
    }
    // the protocol fixture shows real rows: each must equal what this CLI prints now
    const fixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, '..', '..', '..', 'packages', 'protocol', 'fixtures', 'commands-list.json'),
        'utf8',
      ),
    ) as { commands: CommandInfoT[] }
    for (const row of fixture.commands)
      expect(
        parsed.commands.find((c) => c.name === row.name),
        row.name,
      ).toEqual(row)
    const events = parsed.commands.find((c) => c.name === 'events')
    expect(events).toMatchObject({ agent_may_run: true, effects: ['read'], risk: 'low', who: 'agent' })
    expect(parsed.commands.find((c) => c.name === 'devices')?.who).toBe('owner_terminal')
  })
})

describe('talos events', () => {
  test('--json lists the registry and parses against EventsList', async () => {
    const r = io()
    expect(await runTalos(['events', '--json'], r.io, {})).toBe(0)
    const parsed = EventsList.parse(JSON.parse(r.out.join('\n')))
    expect(parsed.events.map((e) => e.name)).toEqual(EVENTS.map((e) => e.name))
    const posted = parsed.events.find((e) => e.name === 'dialog.card_posted')
    expect(posted?.fields).toEqual(['dialog_kind', 'thread_id', 'card_id'])
    expect(posted).toMatchObject({ emitter: 'bridge', status: 'live' })
  })

  test('plain `events` lists each name with its emitter, and talos-app answers the same', async () => {
    for (const run of [
      (io_: ReturnType<typeof io>) => runTalos(['events'], io_.io, {}),
      (io_: ReturnType<typeof io>) => runCli(['events'], io_.io, {}),
    ]) {
      const r = io()
      expect(await run(r)).toBe(0)
      const text = r.out.join('\n')
      for (const e of EVENTS) expect(text).toContain(e.name)
    }
  })

  test('an unknown flag is refused', async () => {
    const r = io()
    expect(await runCli(['events', '--no-such-flag'], r.io, {})).toBe(1)
  })
})
