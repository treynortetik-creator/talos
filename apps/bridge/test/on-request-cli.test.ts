// `theme reset`, `memory init` and `lead init` (owner ruling 2026-11-14): the agent runs them when the owner asked and "Lock Talos
// settings" is off; typed in a terminal they are the owner's own. The real config file and the real history.sqlite.
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { loadEnv } from '../src/config.ts'
import { HistoryStore } from '../src/history-store.ts'
import { onRequestRefusal } from '../src/on-request-cli.ts'
import { SETTINGS_LOCKED } from '../src/trust.ts'
import { tempHome } from './helpers.ts'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function world(o: { lock?: boolean; said?: { thread: string; minutes: number; via?: string } } = {}) {
  const home = tempHome('talos-onreq-')
  homes.push(home)
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ ...loadExampleConfig('default'), ...(o.lock ? { settings_lock: true } : {}) }),
    { mode: 0o600 },
  )
  const store = new HistoryStore(join(home, 'history.sqlite'))
  if (o.said)
    store.addMessage({
      id: newId('m'),
      thread_id: o.said.thread,
      author: 'owner',
      kind: 'text',
      text: 'reset the theme, it is unreadable',
      format: 'plain',
      attachments: [],
      via: o.said.via ?? 'app',
      created_at: new Date(Date.now() + o.said.minutes * 60_000).toISOString(),
    } as never)
  store.close()
  return loadEnv({ TALOS_APP_HOME: home } as Record<string, string>)
}

describe('the agent runs them only when the owner asked', () => {
  test('nobody asked: refused, in words that say why', () => {
    const env = world()
    expect(onRequestRefusal(env, ['theme', 'reset'])).toMatch(/only when the owner asked/)
    expect(onRequestRefusal(env, ['memory', 'init'])).toMatch(/only when the owner asked/)
    expect(onRequestRefusal(env, ['lead', 'init', 'inbox'])).toMatch(/in thread inbox or the default thread/)
  })

  test('he asked a minute ago: allowed', () => {
    const env = world({ said: { thread: 'general', minutes: -1 } })
    expect(onRequestRefusal(env, ['theme', 'reset'])).toBeUndefined()
    expect(onRequestRefusal(env, ['memory', 'init'])).toBeUndefined()
    expect(onRequestRefusal(env, ['lead', 'init', 'inbox'])).toBeUndefined() // the default thread vouches
  })

  test('more than two hours ago, or only a share: refused', () => {
    expect(onRequestRefusal(world({ said: { thread: 'general', minutes: -121 } }), ['theme', 'reset'])).toMatch(
      /only when the owner asked/,
    )
    expect(
      onRequestRefusal(world({ said: { thread: 'general', minutes: -1, via: 'share' } }), ['theme', 'reset']),
    ).toMatch(/only when the owner asked/)
  })

  test('the lock on: the one sentence, asked or not', () => {
    const env = world({ lock: true, said: { thread: 'general', minutes: -1 } })
    expect(onRequestRefusal(env, ['theme', 'reset'])).toBe(SETTINGS_LOCKED)
  })

  test('the lock holds in a terminal too (a terminal can be faked); unlocked, a terminal needs no ask', () => {
    expect(onRequestRefusal(world({ lock: true }), ['theme', 'reset'], Date.now(), { terminal: true })).toBe(
      SETTINGS_LOCKED,
    )
    expect(onRequestRefusal(world(), ['theme', 'reset'], Date.now(), { terminal: true })).toBeUndefined()
  })

  test('no config.json: typed in a terminal it goes on to the command (no lock without a config); from the agent, refused', () => {
    const home = tempHome('talos-onreq-')
    homes.push(home)
    const env = loadEnv({ TALOS_APP_HOME: home } as Record<string, string>)
    expect(onRequestRefusal(env, ['memory', 'init'], Date.now(), { terminal: true })).toBeUndefined()
    expect(onRequestRefusal(env, ['memory', 'init'])).toMatch(/config\.json/)
  })

  test('memory init --defaults at install time (no history.sqlite, no memory.json) runs without an ask; the lock still holds', () => {
    const bare = tempHome('talos-onreq-')
    homes.push(bare)
    const env = loadEnv({ TALOS_APP_HOME: bare } as Record<string, string>)
    // no config, no history, no memory.json: an installer before anything else (the Mac app's Create, Windows Setup)
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults'])).toBeUndefined()
    // a config exists (the bridge was set up first) and nothing else: still install time
    writeFileSync(join(bare, 'config.json'), JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults'])).toBeUndefined()
    // the plain interactive form gets no such pass
    expect(onRequestRefusal(env, ['memory', 'init'])).toMatch(/only when the owner asked|history/)
    // the lock on: refused, even at install time
    writeFileSync(join(bare, 'config.json'), JSON.stringify({ ...loadExampleConfig('default'), settings_lock: true }), {
      mode: 0o600,
    })
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults'])).toBe(SETTINGS_LOCKED)
  })

  test('memory init --defaults after the first conversation, or over an owner memory.json: the normal rule (refused unasked)', () => {
    // history.sqlite exists (world() makes it): a conversation can have happened, so the agent needs the owner's ask
    expect(onRequestRefusal(world(), ['memory', 'init', '--defaults'])).toMatch(/only when the owner asked/)
    // no history, but the owner's memory.json is there
    const home = tempHome('talos-onreq-')
    homes.push(home)
    writeFileSync(join(home, 'config.json'), JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
    writeFileSync(join(home, 'memory.json'), '{}', { mode: 0o600 })
    const env = loadEnv({ TALOS_APP_HOME: home } as Record<string, string>)
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults'])).toBeDefined()
  })

  test('memory init --defaults at install time names no other folder, and a broken config is refused, not skipped', () => {
    const home = tempHome('talos-onreq-')
    homes.push(home)
    const env = loadEnv({ TALOS_APP_HOME: home } as Record<string, string>)
    // only the folder it runs in: any --agent-dir (a folder of the caller's choosing) gets the normal rule
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults', '--agent-dir', '/home/alex/Documents'])).toBeDefined()
    expect(onRequestRefusal(env, ['memory', 'init', '--agent-dir', '--defaults'])).toBeDefined()
    // a config that is there but does not parse may hold the lock: refused, as the normal path does
    writeFileSync(join(home, 'config.json'), '{ not json', { mode: 0o600 })
    expect(onRequestRefusal(env, ['memory', 'init', '--defaults'])).toMatch(/config\.json/)
  })

  test('other commands are not its business', () => {
    expect(onRequestRefusal(world(), ['theme', 'show'])).toBeUndefined()
    expect(onRequestRefusal(world(), ['lead', 'check', 'x'])).toBeUndefined()
  })
})
