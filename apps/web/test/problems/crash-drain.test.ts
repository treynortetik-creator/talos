// The iPhone shell's crash reports reach the page's queue. The sample is the one the Swift package parses
// (apps/mobile/ios/TalosCrashCore): its expected output is what the plugin hands to the page.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Problem, type ProblemT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { CaptureEnv } from '../../src/features/problems/capture.ts'
import { ProblemController } from '../../src/features/problems/controller.ts'
import { drainCrashes, problemFromCrash, readSummary } from '../../src/features/problems/crashDrain.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../mobile/ios/TalosCrashCore/Tests/TalosCrashCoreTests/Fixtures',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as unknown[]

const env: CaptureEnv = {
  origin: 'https://app.example.com',
  versions: { app: '1.2.3', protocol: '1' },
  device: 'iphone_app',
  routes: ['home'],
  now: () => Date.parse('2026-11-02T10:00:00.000Z'),
}

function shell(summaries: unknown[], platform = 'ios') {
  let drained = 0
  const scope = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      Plugins: {
        TalosCrash: {
          drain: async () => {
            drained++
            return { summaries: drained === 1 ? summaries : [] }
          },
        },
      },
    },
  }
  return { scope, drained: () => drained }
}

function controller() {
  const posted: ProblemT[] = []
  const ctl = new ProblemController({
    storage: createMemoryStorage(),
    client: {
      store: createStore(() => ({ connection: 'offline' })),
      uploadMedia: async () => Promise.reject(new Error('x')),
    } as never,
    env: () => env,
    target: new EventTarget() as never,
    post: async (p) => {
      posted.push(p)
      return { ok: true }
    },
  })
  return { ctl, posted }
}

describe('crash summaries from the iPhone shell', () => {
  it('every summary the Swift side produces from the sample payload becomes a valid ios report', () => {
    const summaries = fixture('expected-summaries')
    expect(summaries).toHaveLength(3)
    for (const raw of summaries) {
      const s = readSummary(raw)
      expect(s).not.toBeNull()
      const p = problemFromCrash(s as NonNullable<typeof s>, env)
      expect(Problem.safeParse(p).success).toBe(true)
      expect(p).toMatchObject({ source: 'ios', kind: 'auto', device: 'iphone_app' })
    }
    const first = problemFromCrash(readSummary(summaries[0]) as never, env)
    expect(first.name).toBe('crash: EXC_BAD_ACCESS (SIGSEGV)')
    expect(first.frames).toEqual([
      { fn: '+0x1000', file: 'Talos' },
      { fn: '+0x200', file: 'libsystem_kernel.dylib' },
    ])
    expect(first.versions.shell).toBe('1.0 (build 12)')
  })

  it('drains once, queues each, and an unreadable summary costs only itself', async () => {
    const { scope, drained } = shell([
      ...fixture('expected-summaries'),
      { kind: 'a future kind', name: 'x' },
      'junk',
      null,
    ])
    const { ctl, posted } = controller()
    expect(await drainCrashes(ctl, scope)).toBe(3)
    expect(posted).toHaveLength(3)
    expect(await drainCrashes(ctl, scope)).toBe(0) // the shell forgot what it handed over
    expect(drained()).toBe(2)
  })

  it('does nothing outside the iPhone shell, or in a build without the plugin', async () => {
    const { ctl, posted } = controller()
    const android = shell(fixture('expected-summaries'), 'android')
    expect(await drainCrashes(ctl, android.scope)).toBe(0)
    expect(android.drained()).toBe(0)
    expect(
      await drainCrashes(ctl, { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} } }),
    ).toBe(0)
    expect(await drainCrashes(ctl, {})).toBe(0)
    expect(posted).toHaveLength(0)
  })

  it('a plugin that throws or answers nonsense is not a crash of its own', async () => {
    const { ctl } = controller()
    const bad = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: {
          TalosCrash: {
            drain: async () => {
              throw new Error('nope')
            },
          },
        },
      },
    }
    expect(await drainCrashes(ctl, bad)).toBe(0)
    const odd = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosCrash: { drain: async () => ({ summaries: 'not a list' }) } },
      },
    }
    expect(await drainCrashes(ctl, odd)).toBe(0)
  })
})
