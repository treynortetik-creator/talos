// O20: the Mac shell hears each thread's real name, not "A thread".
import { AgentConfig } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { attachShell, shellThreadName } from '../../src/features/native/attach.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import type { Shell } from '../../src/lib/native/shell.ts'

const base = AgentConfig.parse(readyFixture.agent_config)

function run(names: Array<{ id: string; name: string; kind: 'fixed' | 'agent' }>, mode: 'all' | 'fixed_only' | 'none') {
  const posted: Array<Record<string, unknown>> = []
  const bridge = createShellBridge({ post: (m) => posted.push(m as Record<string, unknown>) })
  const threads = names.map((n, i) => ({ ...base.threads[0], ...n, archived: false, order: i })) as typeof base.threads
  const config = { ...base, notifications: { show_thread_names: mode } } as typeof base
  const store = createStore(() => ({ ...initialClientState(), config, devicePinned: true, threads }))
  const client = { store, sendMessage: async () => ({}), onFrame: () => () => {} } as unknown as TalosClient
  attachShell({ kind: 'desktop', bridge, platform: {} } as unknown as Shell, client)
  return posted.filter((m) => m.type === 'threads').at(-1)?.items as Array<{ id: string; name: string }>
}

beforeEach(() => useSession.setState({ status: 'authed' }))

describe('the threads message to the Mac shell', () => {
  const cases = [
    { id: 'general', name: 'General', kind: 'fixed' as const },
    { id: 'trip', name: 'Trip to Lisbon', kind: 'agent' as const },
    { id: 'tax', name: 'Taxes 2026', kind: 'agent' as const },
  ]
  for (const mode of ['fixed_only', 'all', 'none'] as const) {
    it(`carries real names for fixed and agent threads under show_thread_names=${mode}`, () => {
      const items = run(cases, mode)
      expect(items.map((i) => i.name)).toEqual(['General', 'Trip to Lisbon', 'Taxes 2026'])
      expect(items.some((i) => i.name === 'A thread')).toBe(false)
    })
  }
})

describe('shellThreadName', () => {
  it('keeps a normal name, trims, and falls back for a blank one', () => {
    expect(shellThreadName('  Trip  ')).toBe('Trip')
    expect(shellThreadName('')).toBe('A thread')
    expect(shellThreadName(' \n\t ')).toBe('A thread')
  })
  it('never exceeds the 80 units the shell accepts, and never cuts a character in half', () => {
    const long = 'x'.repeat(200)
    expect(shellThreadName(long)).toHaveLength(80)
    const emoji = '😀'.repeat(60) // 120 UTF-16 units
    const cut = shellThreadName(emoji)
    expect(cut.length).toBeLessThanOrEqual(80)
    expect(cut.length % 2).toBe(0)
    expect([...cut].every((c) => c === '😀')).toBe(true)
  })
  it('turns control characters and line breaks into spaces', () => {
    expect(shellThreadName('a\nb\u0007c d')).toBe('a b c d')
  })
  it('a very long name does not make the whole list invalid', () => {
    const items = run(
      [
        { id: 'general', name: 'y'.repeat(500), kind: 'fixed' },
        { id: 'trip', name: 'Trip', kind: 'agent' },
      ],
      'fixed_only',
    )
    expect(items.map((i) => i.id)).toEqual(['general', 'trip'])
  })
})
