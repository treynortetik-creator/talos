// Which folder a thread's Files pane shows (src/files/wiring.ts): the folder its session works in, by the Mac's rules. The app
// only names the thread. And the Files pane is on a live main bridge's feature list, so the app knows to offer it.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FILES_FEATURE } from '@talos-app/protocol'
import { filesRefusedRoots, filesRootFor } from '../src/files/wiring.ts'
import { bridgeFeatures } from '../src/handshake.ts'

const AGENT = '/home/alex/agent'
const config = (enabled: boolean) => ({
  default_thread: 'general',
  dedicated: { enabled },
  threads: [
    { id: 'general', kind: 'fixed' },
    { id: 'trip', kind: 'user', session: 'dedicated', session_opts: { cwd: '/home/alex/trip' } },
    { id: 'plain', kind: 'user', session: 'dedicated' },
    { id: 'chat', kind: 'user', session_opts: { cwd: '/home/alex/elsewhere' } },
    { id: 'sub', kind: 'user', parent_id: 'trip', session: 'dedicated', session_opts: { cwd: '/home/alex/trip/sub' } },
  ],
})

describe('filesRootFor', () => {
  test("a thread with its own session shows its own folder, else the agent folder; a shared thread's folder setting is not used", () => {
    const c = config(true)
    expect(filesRootFor(c, AGENT, 'trip')).toBe('/home/alex/trip')
    expect(filesRootFor(c, AGENT, 'plain')).toBe(AGENT)
    expect(filesRootFor(c, AGENT, 'general')).toBe(AGENT)
    // a cwd on a thread that is not dedicated is not where it works: the shared session runs in the agent folder
    expect(filesRootFor(c, AGENT, 'chat')).toBe(AGENT)
    expect(filesRootFor(c, AGENT, 'sub')).toBe('/home/alex/trip/sub')
  })

  test('with the dedicated switch off every thread works in the agent folder', () => {
    for (const id of ['trip', 'plain', 'general', 'chat']) expect(filesRootFor(config(false), AGENT, id)).toBe(AGENT)
  })

  test('an unknown thread, an unreadable config, or no agent folder to fall back to: no folder', () => {
    expect(filesRootFor(config(true), AGENT, 'nobody')).toBeNull()
    expect(filesRootFor(null, AGENT, 'general')).toBeNull()
    expect(filesRootFor({ threads: 'oops' }, AGENT, 'general')).toBeNull()
    expect(filesRootFor(config(true), undefined, 'general')).toBeNull()
    expect(filesRootFor(config(true), undefined, 'trip')).toBe('/home/alex/trip')
  })
})

test('the refused roots: the Talos home, Claude, the secret stores and Library, never the agent folder', () => {
  const r = filesRefusedRoots({
    home: '/home/alex',
    talosHome: '/home/alex/.config/talos/app',
    claudeDir: '/home/alex/.claude',
  })
  for (const p of ['.config/talos/app', '.claude', '.ssh', '.aws', 'Library', '.gnupg', 'private-agent-vault'])
    expect(r, p).toContain(p === '.config/talos/app' ? '/home/alex/.config/talos/app' : join('/home/alex', p))
  expect(r).not.toContain(AGENT)
})

test('the feature is listed only when the service is there', () => {
  expect(bridgeFeatures({ files: { available: true } } as never)).toContain(FILES_FEATURE)
  expect(bridgeFeatures({} as never)).not.toContain(FILES_FEATURE)
})
