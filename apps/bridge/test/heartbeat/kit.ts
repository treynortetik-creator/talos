// Shared pieces for the heartbeat runner tests: fake sources (small scripts in a temp dir), a config builder, and a runner
// wired to a REAL bridge context (history store, outbox, transport, FakeRelay at the far end). Nothing here fakes the runner.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HEARTBEAT_CONFIG_SCHEMA,
  HeartbeatConfig,
  type HeartbeatConfigT,
  type HeartbeatResultT,
} from '@talos-app/protocol'
import type { fakeClock } from '@talos-app/testkit'
import { HeartbeatRunner, type RunInput, type RunnerDeps } from '../../src/heartbeat/runner.ts'
import { storeFile } from '../../src/heartbeat/store.ts'
import type { Harness } from '../helpers.ts'

export const MON_1000_UTC = '2026-10-05T10:00:00.000Z'

export function tmpDir(prefix = 'hb-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A source that prints `body` (a shell fragment run after stdin is saved to `<dir>/<name>.stdin`). */
export function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.sh`)
  writeFileSync(path, `#!/bin/sh\ncat > '${join(dir, `${name}.stdin`)}'\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

export const ok = (items: unknown[] = [], cursor: unknown = null) =>
  JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'ok', cursor, items })
export const errAnswer = (error: string) =>
  JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'error', error })

/** A source script that prints a fixed answer. */
export const printing = (dir: string, name: string, answer: string) =>
  script(dir, name, `cat <<'JSON_END'\n${answer}\nJSON_END`)

export const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  sig: '1',
  title: `Item ${key}`,
  level: 'fyi',
  class: 'own',
  why: 'test.rule',
  deadline: null,
  ...over,
})

export const cmd = (id: string, path: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'command' as const,
  enabled: true,
  args: { argv: ['/bin/sh', path] },
  timeout_s: 5,
  ...over,
})

export function config(sources: unknown[], over: Record<string, unknown> = {}): HeartbeatConfigT {
  return HeartbeatConfig.parse({
    schema: HEARTBEAT_CONFIG_SCHEMA,
    mode: 'live',
    sources,
    mutes: [],
    wake_cap_per_day: 3,
    run_timeout_s: 30,
    ...over,
  })
}

export type Kit = {
  runner: HeartbeatRunner
  clock: ReturnType<typeof fakeClock>
  home: string
  run(cfg: HeartbeatConfigT, over?: Partial<RunInput>): ReturnType<HeartbeatRunner['run']>
  /** System rows that reached the relay, text only. */
  rows(): Array<{ text: string; silent: boolean }>
  // biome-ignore lint/suspicious/noExplicitAny: a test's view of a JSON file it pokes at
  store(shadow?: boolean, jobId?: string): Record<string, any>
  storeBytes(shadow?: boolean, jobId?: string): string | null
}

let slot = 0
/** `h` was started with `clock`; the runner shares it. `secondMs` 200 makes a 5 s limit 1 s (the first spawn in a process takes ~200 ms). */
export function kit(h: Harness, clock: ReturnType<typeof fakeClock>, over: Partial<RunnerDeps> = {}): Kit {
  const ctx = h.bridge.ctx
  const thread = { id: ctx.config.config.default_thread, name: 'General' }
  const runner = new HeartbeatRunner({
    ctx,
    builtin: (self) => ({
      home: ctx.paths.home,
      userHome: ctx.env.userHome,
      runs: () => [],
      missed: () => [],
      jobName: (id) => id,
      selfJobId: self,
    }),
    threadFor: () => thread,
    secondMs: 200,
    ...over,
  })
  const read = (shadow: boolean, jobId = 'beat') => {
    try {
      return readFileSync(storeFile(h.home, shadow, jobId), 'utf8')
    } catch {
      return null
    }
  }
  return {
    runner,
    clock,
    home: h.home,
    run: (cfg, o = {}) =>
      runner.run({
        jobId: 'beat',
        jobName: 'Heartbeat',
        runKey: `2026-10-05T10${String(slot++ % 60).padStart(2, '0')}`,
        config: { config: cfg, skipped: 0 },
        trigger: 'clock',
        ...o,
      }),
    rows: () =>
      h.relay.frames
        .filter((r) => r.frame.type === 'reply' && r.direction === 'from_bridge')
        .map((r) => r.frame as unknown as { message: { author: string; text?: string }; silent?: boolean })
        .filter((f) => f.message.author === 'system')
        .map((f) => ({ text: f.message.text ?? '', silent: f.silent === true })),
    store: (shadow = false, jobId) => JSON.parse(read(shadow, jobId) ?? 'null'),
    storeBytes: (shadow = false, jobId) => read(shadow, jobId),
  }
}

export const sourceOf = (r: HeartbeatResultT, id: string) => r.sources.find((s) => s.id === id)
