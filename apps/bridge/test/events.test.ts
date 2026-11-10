// The bridge side of the events registry (docs/HOOKS-AND-COMMANDS.md B2): emitEvent refuses what is not registered, every call
// site names a registered event, and the fields a real call carries parse against the registered payload.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as protocol from '@talos-app/protocol'
import { EVENTS, eventInfo, THREAD_FOLDER_CHOSEN_EVENT, type ThreadT } from '@talos-app/protocol'
import { emitEvent, emitFolderEvents } from '../src/events.ts'

const SRC = resolve(import.meta.dir, '..', 'src')

function recorder() {
  const info: Array<[string, Record<string, unknown> | undefined]> = []
  const warn: Array<[string, Record<string, unknown> | undefined]> = []
  return {
    info,
    warn,
    log: {
      info: (m: string, f?: Record<string, unknown>) => void info.push([m, f]),
      warn: (m: string, f?: Record<string, unknown>) => void warn.push([m, f]),
    },
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('emitEvent', () => {
  test('a registered name with fields that parse writes one event line, and says so', () => {
    const r = recorder()
    expect(emitEvent(r.log, THREAD_FOLDER_CHOSEN_EVENT, { thread_id: 'trip', cleared: false })).toBe(true)
    expect(r.info).toEqual([['event', { event: 'thread.folder_chosen', thread_id: 'trip', cleared: false }]])
    expect(r.warn).toEqual([])
  })

  test('an unregistered name writes no event line; the warning names the event and nothing else', () => {
    const r = recorder()
    expect(emitEvent(r.log, 'thread.invented', { thread_id: 'trip' })).toBe(false)
    expect(r.info).toEqual([])
    expect(JSON.stringify(r.warn)).toContain('thread.invented')
    expect(JSON.stringify(r.warn)).not.toContain('trip')
  })

  test('fields that do not parse (a path, a wrong type) write no event line and the warning never repeats their values', () => {
    const r = recorder()
    expect(
      emitEvent(r.log, 'thread.folder_chosen', { thread_id: 'trip', cleared: true, path: '/home/example/private' }),
    ).toBe(false)
    expect(emitEvent(r.log, 'thread.folder_chosen', { thread_id: 'trip', cleared: 'yes-secret-word' })).toBe(false)
    expect(r.info).toEqual([])
    expect(r.warn).toHaveLength(2)
    expect(JSON.stringify(r.warn)).not.toContain('/home/example/private')
    expect(JSON.stringify(r.warn)).not.toContain('secret-word')
  })
})

describe('emitFolderEvents', () => {
  const t = (id: string, cwd?: string) => ({ id, session_opts: cwd ? { cwd } : undefined }) as unknown as ThreadT

  test('what it really emits parses against the registered payload and carries no path', () => {
    const r = recorder()
    emitFolderEvents(r.log, [t('a', '/p/one'), t('b')], [t('a'), t('b', '/p/two')])
    expect(r.warn).toEqual([])
    expect(r.info).toHaveLength(2)
    const info = eventInfo(THREAD_FOLDER_CHOSEN_EVENT)
    for (const [, f] of r.info) {
      const { event, ...fields } = f as Record<string, unknown>
      expect(event).toBe(THREAD_FOLDER_CHOSEN_EVENT)
      expect(info?.payload.safeParse(fields).success).toBe(true)
    }
    expect(JSON.stringify(r.info)).not.toContain('/p/')
  })
})

describe('every emitEvent call site', () => {
  test('names a registered event: a literal, or a constant the protocol exports', () => {
    const names = new Set(EVENTS.map((e) => e.name))
    const found: string[] = []
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bemitEvent\(\s*[\w.]+,\s*([A-Za-z_][\w.]*|'[^']*'|"[^"]*")/g)) {
        const arg = m[1] as string
        const value = /^['"]/.test(arg) ? arg.slice(1, -1) : (protocol as Record<string, unknown>)[arg]
        found.push(`${arg}`)
        expect(typeof value, `${file}: ${arg}`).toBe('string')
        expect(names.has(value as string), `${file}: ${arg} = ${String(value)}`).toBe(true)
      }
    }
    // the scan must not be vacuous: the three events that exist today
    expect(found.length).toBeGreaterThanOrEqual(3)
  })
})
