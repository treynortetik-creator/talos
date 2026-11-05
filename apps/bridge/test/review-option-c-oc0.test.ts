// Independent review of PR #63 (Option C WP-OC0). Real seams: the full bridge harness (signed config.patch through
// FakeRelay, the agent's MCP tools via callTool) and ConfigFile.applyPatch. Tests named REVIEW-FAIL fail on 9b0aa80 and
// pin a finding; the rest are controls that pass and back a "holds up" claim in the review.
// Builder follow-up: Option C refusals now answer `thread_session_refused` (finding 7) instead of `bad_frame`.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid, threadSessionMode } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const H = () => h as Harness
const errFor = async (id: string) =>
  (await H().relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })).code
const syncAt = (rev: number) => H().relay.expectFrame('config.sync', (f) => f.rev === rev, { direction: 'from_bridge' })
const onDisk = () => JSON.parse(readFileSync(join(H().home, 'config.json'), 'utf8'))
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

/** Owner dedicates an agent thread the agent created, with the master switch on. Returns the rev after. */
async function dedicatedAgentThread(): Promise<number> {
  h = await startHarness()
  await syncAt(0)
  expect((await H().bridge.callTool('create_thread', { name: 'Trip', id: 'trip' })).isError).toBeFalsy()
  await syncAt(1)
  const threads = onDisk().threads.map((t: { id: string }) => (t.id === 'trip' ? { ...t, session: 'dedicated' } : t))
  await H().app.sendConfigPatch(1, { threads, dedicated: { enabled: true } })
  await syncAt(2)
  expect(threadSessionMode(H().bridge.ctx.config.config, 'trip')).toBe('dedicated')
  return 2
}

describe('review OC0: the owner can always turn it off', () => {
  test('REVIEW-FAIL: after the agent archives a dedicated thread, the owner can still switch option C off from the phone', async () => {
    let rev = await dedicatedAgentThread()
    // the agent's own MCP tool (threads.ts archive_thread -> config.update, no Option C check)
    expect((await H().bridge.callTool('archive_thread', { thread_id: 'trip' })).isError).toBeFalsy()
    rev += 1
    await syncAt(rev)
    // builder fix: archiving turns the thread's own session off, so no archived+dedicated thread is left behind
    const archived = onDisk().threads.find((t: { id: string }) => t.id === 'trip')
    expect(archived).toMatchObject({ archived: true })
    expect(archived.session).toBeUndefined()
    // the master switch OFF: must never be refused
    const off = await H().app.sendConfigPatch(rev, { dedicated: { enabled: false } })
    const outcome = await Promise.race([syncAt(rev + 1).then(() => 'synced'), errFor(off.id).then((c) => `error:${c}`)])
    expect(outcome).toBe('synced')
    expect(onDisk().dedicated.enabled).toBe(false)
  })

  // Passes on 9b0aa80 only because the old app's patch wipes `session` (finding 3). After the rebase onto main
  // (#60 resolveThreadsPatch keeps keys the app left out) optionCPatchIssue checks a plain merge while the bridge
  // writes the resolved one, so this writes archived+dedicated and the switch-off is refused. Verified on a trial merge.
  test('REVIEW-FAIL (after rebase on main): an older app archives a dedicated thread, then the owner can still switch option C off', async () => {
    let rev = await dedicatedAgentThread()
    // an older app's view of the threads: its schema strips session / session_opts
    const old = onDisk().threads.map(({ session: _s, session_opts: _o, ...t }: Record<string, unknown>) => t)
    const threads = old.map((t: { id: string }) => (t.id === 'trip' ? { ...t, archived: true } : t))
    const f = await H().app.sendConfigPatch(rev, { threads })
    const archived = await Promise.race([syncAt(rev + 1).then(() => 'synced'), errFor(f.id).then((c) => `error:${c}`)])
    expect(archived).toBe('synced')
    rev += 1
    const off = await H().app.sendConfigPatch(rev, { dedicated: { enabled: false } })
    const outcome = await Promise.race([syncAt(rev + 1).then(() => 'synced'), errFor(off.id).then((c) => `error:${c}`)])
    expect(outcome).toBe('synced')
  })

  test('REVIEW-FAIL (after rebase on main): an older app cannot make a dedicated thread the default past the check', async () => {
    const rev = await dedicatedAgentThread()
    const old = onDisk().threads.map(({ session: _s, session_opts: _o, ...t }: Record<string, unknown>) => t)
    const f = await H().app.sendConfigPatch(rev, { default_thread: 'trip', threads: old })
    const outcome = await Promise.race([syncAt(rev + 1).then(() => 'synced'), errFor(f.id).then((c) => `error:${c}`)])
    const d = onDisk()
    const trip = d.threads.find((t: { id: string }) => t.id === 'trip')
    // either refused, or what was written obeys the rule the check claims to enforce
    if (outcome === 'synced') expect(d.default_thread === 'trip' && trip.session === 'dedicated').toBe(false)
  })
})

describe('review OC0: backward compat with an older app (THREADS-REVIEW finding 2, applied to the new switch)', () => {
  test('REVIEW-FAIL: an older app renaming ANOTHER thread does not wipe the dedicated switch or its folder settings', async () => {
    const rev = await dedicatedAgentThread()
    const old = onDisk().threads.map(({ session: _s, session_opts: _o, ...t }: Record<string, unknown>) => t)
    const threads = old.map((t: { id: string }) => (t.id === 'general' ? { ...t, name: 'Front door' } : t))
    await H().app.sendConfigPatch(rev, { threads })
    await syncAt(rev + 1)
    const trip = onDisk().threads.find((t: { id: string }) => t.id === 'trip')
    expect(trip.session).toBe('dedicated') // PR base 9520a61 predates #60's resolveThreadsPatch: needs the rebase
  })
})

describe('review OC0: controls (pass on 9b0aa80)', () => {
  test('control: the agent cannot dedicate a thread through create_thread', async () => {
    h = await startHarness()
    await syncAt(0)
    const r = await H().bridge.callTool('create_thread', {
      name: 'Sneaky',
      id: 'sneaky',
      session: 'dedicated',
      session_opts: { cwd: '/tmp' },
    })
    expect(r.isError).toBeFalsy()
    await syncAt(1)
    const t = onDisk().threads.find((x: { id: string }) => x.id === 'sneaky')
    expect(t.session).toBeUndefined()
    expect(t.session_opts).toBeUndefined()
    expect(text(r)).toContain('sneaky')
  })

  test('control: the relay cannot alter a signed Option C patch', async () => {
    h = await startHarness()
    await syncAt(0)
    const f = await H().app.sendConfigPatch(0, { dedicated: { enabled: true } })
    await syncAt(1)
    // the relay replays the signed frame with a new id and a changed patch: the signature no longer matches
    const forged = { ...f, id: newUlid(), base_rev: 1, patch: { dedicated: { max_live: 6, governor: { off: true } } } }
    H().relay.sendToBridge(forged)
    expect(await errFor(forged.id)).toBe('sig_invalid')
    expect(onDisk().dedicated).toMatchObject({ enabled: true, max_live: 3, governor: { off: false } })
  })
})

describe('review OC0: folder check (ConfigFile seam)', () => {
  function rig() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'rv63-home-')))
    const talosHome = join(home, '.talos-app')
    mkdirSync(talosHome)
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    const p = join(talosHome, 'config.json')
    const base = loadExampleConfig('default')
    base.threads.push({
      id: 'trip',
      name: 'Trip',
      kind: 'agent',
      order: 9,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    } as (typeof base.threads)[number])
    writeFileSync(p, JSON.stringify(base))
    return { home, talosHome, f: new ConfigFile(p, { roots: { home, talosHome } }) }
  }
  const dedicate = (f: ConfigFile, cwd: string) =>
    f.applyPatch(f.config.rev, {
      threads: f.config.threads.map((t) =>
        t.id === 'trip' ? { ...t, session: 'dedicated', session_opts: { cwd } } : t,
      ),
    })

  test('control: a case-variant of ~/.claude (APFS is case-insensitive) is refused', () => {
    const { f, home } = rig()
    expect(dedicate(f, join(home, '.CLAUDE', 'projects'))).toMatchObject({ ok: false, code: 'thread_session_refused' })
  })

  test('control: a case-variant of the Talos data folder is refused', () => {
    const { f, home } = rig()
    expect(dedicate(f, join(home, '.TALOS-APP'))).toMatchObject({ ok: false, code: 'thread_session_refused' })
  })

  test('control: moving the default onto a dedicated thread is refused', () => {
    const { f, home } = rig()
    mkdirSync(join(home, 'Projects'))
    expect(dedicate(f, join(home, 'Projects')).ok).toBe(true)
    expect(f.applyPatch(f.config.rev, { default_thread: 'trip' })).toMatchObject({
      ok: false,
      code: 'thread_session_refused',
    })
  })
})
