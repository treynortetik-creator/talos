// Proves the one table of agent tools shows agents the same thing as the three places it replaced. The fixture was captured
// from origin/main (7f89d478) before the change, by running the old code: every tools/list answer, every instruction string,
// every list and every row's membership. Nothing here is re-derived from the new table except the "after" side.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_BRIDGE_TOOLS } from '@talos-app/protocol'
import { agentInstructions } from '../src/bridge.ts'
import { APP_INSTRUCTIONS } from '../src/tools/apps.ts'
import { AGENT_TOOL_GROUPS, READ_THREAD_TOOLS } from '../src/tools/define.ts'
import { toolsFor } from '../src/tools/index.ts'
import { toolInstructions } from '../src/tools/instructions.ts'
import * as T from '../src/tools/table.ts'

type Before = {
  toolsList: Record<string, unknown[]>
  liveOnly: Record<string, boolean>
  lists: Record<string, string[]>
  rows: Record<string, Record<string, unknown>>
  perToolInstructions: Record<string, string | null>
  instructions: Record<string, string>
}
const before = JSON.parse(readFileSync(join(import.meta.dir, 'golden/tool-table-before.json'), 'utf8')) as Before

describe('agents see byte-identical text', () => {
  test('tools/list: name, description and schema of every tool, for every session shape', () => {
    const want = Object.keys(before.toolsList)
    expect(want.length).toBe(8)
    for (const key of want) {
      const m = /scheduler=(\w+) apps=(\w+) worker=(\w+)/.exec(key)
      if (!m) throw new Error(key)
      const got = toolsFor({
        scheduler: m[1] as string,
        apps: m[2] === 'true',
        workerThread: m[3] === 'no' ? undefined : (m[3] as string),
      }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      // compared as the JSON the MCP server sends, so key order and every byte of every description count
      expect(JSON.stringify(got), key).toBe(JSON.stringify(before.toolsList[key]))
    }
  })

  test('the instruction string, for every combination of worker, trust, apps and self map', () => {
    const self = { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' }
    const keys = Object.keys(before.instructions)
    expect(keys.length).toBe(16)
    for (const key of keys) {
      const f = (name: string) => new RegExp(`${name}=(\\w+)`).exec(key)?.[1] === 'true'
      const got = agentInstructions({
        worker: f('worker'),
        trust: f('trust'),
        appInstructions: f('apps') ? APP_INSTRUCTIONS : undefined,
        self: f('self') ? self : undefined,
      })
      expect(got, key).toBe(before.instructions[key] as string)
    }
  })

  test("each tool's own words are the ones it had", () => {
    for (const [name, text] of Object.entries(before.perToolInstructions)) {
      if (text === null) expect(T.AGENT_TOOLS[name]?.instructions, name).toBeNull()
      else expect(toolInstructions(name), name).toBe(text)
    }
  })
})

describe('every list membership is identical, old vs new', () => {
  const LISTS = [
    'BRIDGE_TOOLS',
    'SCHEDULE_BRIDGE_TOOLS',
    'CONFIG_BRIDGE_TOOLS',
    'ATTACHMENT_BRIDGE_TOOLS',
    'APP_BRIDGE_TOOLS',
    'MOD_BRIDGE_TOOLS',
    'HEADLESS_BRIDGE_TOOLS',
    'WORKER_BRIDGE_TOOLS',
    'WORKER_THREAD_LOCKED_TOOLS',
  ] as const
  for (const name of LISTS)
    test(`${name}: same names, same order`, () => {
      expect([...T[name]]).toEqual(before.lists[name] as string[])
    })

  test('the lists that stayed outside the table are unchanged', () => {
    expect([...SESSION_BRIDGE_TOOLS] as string[]).toEqual(before.lists.SESSION_BRIDGE_TOOLS as string[])
    expect([...READ_THREAD_TOOLS] as string[]).toEqual(before.lists.READ_THREAD_TOOLS as string[])
    expect([...AGENT_TOOL_GROUPS] as string[]).toEqual(before.lists.AGENT_TOOL_GROUPS as string[])
    expect([...T.AGENT_TOOL_NAMES]).toEqual(before.lists.AGENT_TOOL_NAMES as string[])
  })

  for (const [name, row] of Object.entries(before.rows))
    test(`${name}: group, headless, worker, locked and thread label are as before`, () => {
      const r = T.AGENT_TOOLS[name] as unknown as Record<string, unknown>
      for (const k of Object.keys(row)) expect(r[k], `${name}.${k}`).toBe(row[k])
      // and the record has no thread label where the old row had none
      expect('thread' in r, `${name} thread`).toBe('thread' in row)
    })

  test('liveOnly is as before for every tool', () => {
    for (const [name, live] of Object.entries(before.liveOnly))
      expect(T.AGENT_TOOLS[name]?.liveOnly === true, name).toBe(live)
  })
})

describe('what a record says is told is really told, from the real instruction builders', () => {
  const main = agentInstructions({ worker: false, trust: false })
  const worker = agentInstructions({ worker: true, trust: false })
  for (const t of T.TOOL_RECORDS) {
    test(`${t.name}: its words are in the text of exactly the sessions its record names`, () => {
      const words = t.instructions
      if (words === null) {
        expect(t.told, `${t.name} has no words to tell`).toEqual([])
        return
      }
      expect(main.includes(words), `${t.name} in main`).toBe(t.told.includes('main'))
      expect(worker.includes(words), `${t.name} in worker`).toBe(t.told.includes('worker'))
      // an apps-group tool's words are the apps text, added only when apps are on
      if (t.group === 'apps')
        expect(agentInstructions({ worker: false, trust: false, appInstructions: words })).toContain(words)
    })
  }
})
