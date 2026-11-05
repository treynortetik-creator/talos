// Pins what each agent tool list holds, in what order, and the exact words agents are told. Written before the tools
// moved into one table, and left alone since: a tool that changes group, or a changed word, fails here.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentInstructions } from '../src/bridge.ts'
import type { BridgeContext } from '../src/context.ts'
import { APP_INSTRUCTIONS, APP_TOOLS } from '../src/tools/apps.ts'
import { ALL_TOOLS, callTool, TOOLS, toolsFor, WORKER_TOOLS } from '../src/tools/index.ts'

const names = (l: Array<{ name: string }>) => l.map((t) => t.name)

const CORE = [
  'reply',
  'attach',
  'card',
  'card_result',
  'set_status',
  'voice_progress',
  'list_threads',
  'create_thread',
  'archive_thread',
  'read_thread',
  'inbox_triage',
  'inbox_raw',
  'talos_mod_hello',
  'talos_mod_sync',
]
const SCHEDULES = ['schedules_list', 'schedule_propose', 'schedule_run_start', 'schedule_run_done']
const APPS = ['app_show', 'app_result', 'list_apps']

describe('which tools each kind of session lists, in order', () => {
  test('TOOLS, ALL_TOOLS and WORKER_TOOLS', () => {
    expect(names(TOOLS)).toEqual(CORE)
    expect(names(ALL_TOOLS)).toEqual([...CORE, ...SCHEDULES, 'config_propose', 'retry_attachment', 'handoff'])
    expect(names(WORKER_TOOLS)).toEqual([
      'reply',
      'attach',
      'card',
      'card_result',
      'set_status',
      'list_threads',
      'read_thread',
      ...SCHEDULES,
      'read_inbound',
      'handoff',
    ])
    expect(names(APP_TOOLS)).toEqual(APPS)
  })

  test('toolsFor: scheduler on, scheduler off, apps on, worker', () => {
    const on = [...CORE, ...SCHEDULES, 'config_propose', 'retry_attachment', 'handoff']
    const off = [...CORE, 'config_propose', 'retry_attachment', 'handoff']
    expect(names(toolsFor({ scheduler: 'auto' }))).toEqual(on)
    expect(names(toolsFor({ scheduler: 'chronos' }))).toEqual(on)
    expect(names(toolsFor({ scheduler: 'off' }))).toEqual(off)
    expect(names(toolsFor({ scheduler: 'auto', apps: true }))).toEqual([...on, ...APPS])
    expect(names(toolsFor({ scheduler: 'off', apps: true }))).toEqual([...off, ...APPS])
    // a thread session has the schedule tools (they ask main's bridge), unless the scheduler is switched off
    const noSchedules = names(WORKER_TOOLS).filter((n) => !SCHEDULES.includes(n))
    for (const [scheduler, want] of [
      ['auto', names(WORKER_TOOLS)],
      ['off', noSchedules],
    ] as const) {
      expect(names(toolsFor({ scheduler, workerThread: 'trip' }))).toEqual(want)
      expect(names(toolsFor({ scheduler, workerThread: 'trip', apps: true }))).toEqual(want)
    }
  })
})

// A context that cannot do anything: a tool that gets past the checks in callTool fails inside its handler, which is
// a different message from the ones asserted on.
const bare = (extra: Record<string, unknown>) => extra as unknown as BridgeContext
const everyTool = [...names(ALL_TOOLS), ...APPS, 'read_inbound']

describe('which tools a headless process may run', () => {
  test('only these are not refused as needing a live session', async () => {
    const allowed: string[] = []
    for (const name of names(toolsFor({ scheduler: 'auto', apps: true }))) {
      const r = await callTool(bare({ mode: 'headless', env: { scheduler: 'auto', apps: true } }), name, {})
      if (!/needs a live session/.test(r.content[0]?.text ?? '')) allowed.push(name)
    }
    expect(allowed).toEqual([
      'reply',
      'attach',
      'card',
      'set_status',
      'list_threads',
      'read_thread',
      'inbox_raw',
      'schedules_list',
    ])
  })
})

describe('which tools are locked to a worker thread', () => {
  const worker = () =>
    bare({
      mode: 'live',
      env: { scheduler: 'auto', workerThread: 'trip' },
      worker: { thread: 'trip' },
      config: {
        refresh() {},
        config: {
          dedicated: { enabled: true },
          threads: [{ id: 'trip', session: 'dedicated' }],
        },
      },
      ledger: { get: () => undefined },
    })

  test('a worker that names another thread is refused only on these', async () => {
    const locked: string[] = []
    for (const name of names(WORKER_TOOLS)) {
      const r = await callTool(worker(), name, { thread_id: 'garden', chat_id: 'garden' })
      if (/can only post there/.test(r.content[0]?.text ?? '')) locked.push(name)
    }
    expect(locked).toEqual(['reply', 'attach', 'card', 'set_status', 'read_thread', 'schedule_propose', 'handoff'])
  })

  test('a worker that names no thread is told it is required on those same tools', async () => {
    const required: string[] = []
    for (const name of names(WORKER_TOOLS)) {
      const r = await callTool(worker(), name, {})
      if (/thread_id is required\. Valid thread ids: trip/.test(r.content[0]?.text ?? '')) required.push(name)
    }
    expect(required).toEqual(['reply', 'attach', 'card', 'set_status', 'read_thread', 'schedule_propose', 'handoff'])
  })

  test('a tool a worker does not have is unknown to it', async () => {
    for (const name of everyTool.filter((n) => !names(WORKER_TOOLS).includes(n))) {
      const r = await callTool(worker(), name, {})
      expect(r.content[0]?.text, name).toBe(`unknown tool ${name}`)
    }
  })
})

describe('the exact words agents are told', () => {
  const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures/agent-instructions', `${n}.txt`), 'utf8')
  const cases: Array<[string, Parameters<typeof agentInstructions>[0]]> = [
    ['main', { worker: false, trust: false }],
    ['main-trust', { worker: false, trust: true }],
    ['main-apps', { worker: false, trust: false, appInstructions: APP_INSTRUCTIONS }],
    ['main-apps-trust', { worker: false, trust: true, appInstructions: APP_INSTRUCTIONS }],
    [
      'main-self',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
    ],
    [
      'main-self-no-relay',
      { worker: false, trust: false, self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234' } },
    ],
    ['worker', { worker: true, trust: false }],
    ['worker-trust', { worker: true, trust: true }],
  ]
  for (const [file, o] of cases)
    test(`${file}`, () => {
      expect(agentInstructions(o)).toBe(fixture(file))
    })
})
