// The folder picker through the real Bridge: a signed `fs.list` from a (fake) app over the (fake) relay reaches the
// FolderService and `fs.listing` comes back for the same request_id. Who may ask: only a pinned, unrevoked owner device, once.
// An unsigned frame, a forged one, a replay, an unpinned and a revoked device get no names. The agent has no way to ask at all:
// no tool, nothing in its instructions. The lister runs on a temp home.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventInfo, FOLDER_WORDING, FOLDERS_FEATURE, newUlid, THREAD_FOLDER_CHOSEN_EVENT } from '@talos-app/protocol'
import { FakeApp, mkFrame } from '@talos-app/testkit'
import { bridgeFeatures } from '../src/handshake.ts'
import { INSTRUCTIONS } from '../src/instructions.ts'
import type { Logger } from '../src/log.ts'
import { ALL_TOOLS, WORKER_TOOLS } from '../src/tools/index.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const home = realpathSync(mkdtempSync(join(tmpdir(), 'talos-folders-bridge-')))
mkdirSync(join(home, 'Projects', 'alpha'), { recursive: true })
mkdirSync(join(home, '.ssh', 'keys'), { recursive: true })
writeFileSync(join(home, 'secret.txt'), 'not a folder')

const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = []
const logger = (): Logger => {
  const rec = (msg: string, fields?: Record<string, unknown>) => void lines.push({ msg, ...(fields ? { fields } : {}) })
  return { debug: rec, info: rec, warn: rec, error: rec, security: rec }
}

async function start() {
  lines.length = 0
  h = await startHarness({
    bridge: {
      logger: logger(),
      folders: { home, talosHome: join(home, '.config', 'talos', 'app'), claudeDir: join(home, '.claude') },
    },
  })
  return h
}
const ask = async (app: FakeApp, path: string | null, extra: Record<string, unknown> = {}) => {
  const f = await app.sign({ ...mkFrame('fs.list'), request_id: newUlid(), path, hidden: false, ...extra })
  app.send(f)
  return f
}
const listings = (x: Harness, requestId: string) =>
  x.app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'fs.listing' && r.raw.request_id === requestId)
const errors = (x: Harness, ref: string) =>
  x.app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === ref)

describe('fs.list through the real Bridge', () => {
  test('the Mac says it can list folders', async () => {
    const x = await start()
    expect(bridgeFeatures(x.bridge.ctx)).toContain(FOLDERS_FEATURE)
  })

  test('a signed ask for home comes back as folder names only', async () => {
    const x = await start()
    const f = await ask(x.app, home)
    await waitFor(() => listings(x, f.request_id as string).length > 0, 5000, 'fs.listing')
    const raw = (listings(x, f.request_id as string)[0] as unknown as { raw: Record<string, unknown> }).raw
    expect(raw.entries).toEqual([{ name: 'Projects' }])
    expect(raw.home).toBe(home)
    expect(JSON.stringify(raw)).not.toContain('secret.txt')
    expect(JSON.stringify(raw)).not.toContain('.ssh')
  })

  test('a refused folder comes back as the one fixed refusal, with no names', async () => {
    const x = await start()
    const f = await ask(x.app, join(home, '.ssh'))
    await waitFor(() => errors(x, f.id as string).length > 0, 5000, 'refusal')
    const raw = (errors(x, f.id as string)[0] as unknown as { raw: Record<string, unknown> }).raw
    expect(raw.message).toBe(FOLDER_WORDING.refused)
    expect(JSON.stringify(raw)).not.toContain('keys')
    expect(listings(x, f.request_id as string)).toHaveLength(0)
  })

  test('a replayed frame, an unpinned device and a revoked device get no names', async () => {
    const x = await start()
    const f = await x.app.sign({ ...mkFrame('fs.list'), request_id: newUlid(), path: home, hidden: false })
    const bytes = JSON.stringify(f)
    x.app.sendRaw(bytes)
    await waitFor(() => listings(x, f.request_id as string).length > 0, 5000, 'first answer')
    x.app.sendRaw(bytes)
    await waitFor(() => errors(x, f.id as string).length > 0, 5000, 'replay refused')
    expect(listings(x, f.request_id as string)).toHaveLength(1)
    const rogue = new FakeApp({ relayWs: x.relay.wsBase })
    await rogue.connect()
    const g = await ask(rogue, home)
    await waitFor(
      () => rogue.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === g.id),
      5000,
      'rogue refused',
    )
    expect(rogue.rec.frames.some((r) => r.raw.type === 'fs.listing')).toBe(false)
    await rogue.close()
    x.bridge.ctx.devices.revoke(x.app.device.deviceId, new Date().toISOString())
    const k = await ask(x.app, home)
    await waitFor(() => errors(x, k.id as string).length > 0, 5000, 'revoked refused')
    await sleep(100)
    expect(listings(x, k.request_id as string)).toHaveLength(0)
  })

  test('an unsigned fs.list, and one with a bad signature, is refused and answers nothing', async () => {
    const x = await start()
    const plain = { ...mkFrame('fs.list'), request_id: newUlid(), path: home, hidden: false }
    x.relay.sendToBridge(plain)
    const signed = (await x.app.sign({
      ...mkFrame('fs.list'),
      request_id: newUlid(),
      path: home,
      hidden: false,
    })) as Record<string, unknown>
    const osig = String(signed.osig)
    const forged = { ...signed, id: newUlid(), osig: (osig[0] === 'A' ? 'B' : 'A') + osig.slice(1) }
    x.relay.sendToBridge(forged)
    // the forged one is refused out loud: an error frame for that id, and a security line in the log (not just silence)
    await waitFor(
      () =>
        x.relay.frames.some(
          (r) =>
            r.direction === 'from_bridge' &&
            r.raw.type === 'error' &&
            r.raw.ref === forged.id &&
            r.raw.code === 'sig_invalid',
        ),
      5000,
      'the forged frame to be refused',
    )
    expect(lines.some((l) => l.msg === 'owner frame dropped' && l.fields?.type === 'fs.list')).toBe(true)
    // the unsigned one never parses as an owner frame: the log says so
    expect(lines.some((l) => l.msg === 'relay frame did not parse' && l.fields?.type === 'fs.list')).toBe(true)
    expect(x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'fs.listing')).toHaveLength(0)
  })

  test('a device the Mac never pinned gets an error and no names', async () => {
    h = await startHarness({
      pinApp: false,
      bridge: {
        logger: logger(),
        folders: { home, talosHome: join(home, '.config', 'talos', 'app'), claudeDir: join(home, '.claude') },
      },
    })
    const f = await ask(h.app, home)
    await waitFor(() => errors(h as Harness, f.id as string).length > 0, 5000, 'refusal')
    expect(listings(h, f.request_id as string)).toHaveLength(0)
  })

  test('an ask signed an hour ago is refused as stale, not served', async () => {
    const x = await start()
    const old = new Date(Date.now() - 3600_000).toISOString()
    const f = await x.app.sign({ ...mkFrame('fs.list', {}, old), request_id: newUlid(), path: home, hidden: false })
    x.app.send(f)
    await waitFor(() => errors(x, f.id as string).length > 0, 5000, 'stale refused')
    expect(listings(x, f.request_id as string)).toHaveLength(0)
  })
})

describe('the agent cannot ask', () => {
  test('no tool, for main or for a thread session, lists or picks folders', () => {
    const names = [...ALL_TOOLS, ...WORKER_TOOLS].map((t) => t.name)
    for (const n of names) expect(n, n).not.toMatch(/folder|browse|list_dir|fs_|directory/i)
  })

  test('the agent instructions say nothing about the picker', () => {
    expect(INSTRUCTIONS).not.toMatch(/fs\.list|folder picker|pick a folder|browse folders/i)
  })

  test('fs.list is an owner frame: a plain (unsigned) frame of that type is not accepted by the schema', async () => {
    const { frameSchemas, OWNER_FRAME_TYPES, V2_READ_OWNER_FRAME_TYPES } = await import('@talos-app/protocol')
    expect(OWNER_FRAME_TYPES).toContain('fs.list')
    expect(V2_READ_OWNER_FRAME_TYPES).toContain('fs.list')
    expect(
      frameSchemas['fs.list'].safeParse({ ...mkFrame('fs.list'), request_id: newUlid(), path: null, hidden: false })
        .success,
    ).toBe(false)
  })
})

describe('choosing a folder is an event', () => {
  test('a saved patch that sets a thread folder emits thread.folder_chosen with the thread id, and not the path', async () => {
    const proj = join(home, 'Projects', 'alpha')
    const x = await start()
    const rev = x.bridge.ctx.config.config.rev
    const threads = x.bridge.ctx.config.config.threads
    await x.app.sendConfigPatch(rev, {
      threads: threads
        .map((t) => (t.id === 'general' ? t : t))
        .concat([
          {
            id: 'trip',
            name: 'Trip',
            kind: 'fixed',
            order: 9,
            notify: 'all',
            voice_context: 'recent',
            archived: false,
            created_at: '2026-10-28T00:00:00.000Z',
            session_opts: { cwd: proj },
          } as never,
        ]),
    })
    await waitFor(() => lines.some((l) => l.fields?.event === THREAD_FOLDER_CHOSEN_EVENT), 5000, 'the event')
    const l = lines.find((x) => x.fields?.event === THREAD_FOLDER_CHOSEN_EVENT)
    expect(l?.fields).toMatchObject({ event: THREAD_FOLDER_CHOSEN_EVENT, thread_id: 'trip' })
    const { event: _e, ...fields } = (l?.fields ?? {}) as Record<string, unknown>
    expect(eventInfo(THREAD_FOLDER_CHOSEN_EVENT)?.payload.safeParse(fields).success).toBe(true)
    expect(JSON.stringify(l)).not.toContain(proj)
  })
})
