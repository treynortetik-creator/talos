// undoTo (undo-to.ts): restore a message's undo point and say so in its thread with one line that the session hears
// too, so the conversation keeps its context and knows its files moved back. A refusal posts nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunAsync, runCommandAsync } from '../src/run-command.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { snapshotFolder } from '../src/undo/snapshot.ts'
import { undoTo } from '../src/undo/undo-to.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
function repo(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-to-')))
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['commit', '-q', '--allow-empty', '-m', 'one'],
  ])
    spawnSync('git', args, { cwd: r, env: gitEnv })
  writeFileSync(join(r, 'a.txt'), 'a\n')
  return r
}

async function setup() {
  h = await startHarness({ bridge: { undo: { agentDir: undefined } } })
  const r = repo()
  const sent = await h.app.sendMessage('general', 'rename every heading in the notes please')
  await h.waitNotes(1)
  const id = sent.client_msg_id as string
  const points = new UndoPoints(h.bridge.ctx.store.db)
  const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(h.home, 'undo') })
  points.record({ message_id: id, thread_id: 'general', turn: id, snapshot: s, at: 1 }, { replace: true })
  return { hh: h, r, id, points }
}

describe('undoTo', () => {
  test('restores, then one line in the thread that the session hears too', async () => {
    const { hh, r, id } = await setup()
    writeFileSync(join(r, 'a.txt'), 'edited\n')
    const done = await undoTo(hh.bridge.ctx, { messageId: id, deletes: [] })
    expect(done.ok).toBe(true)
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('a\n')
    await hh.waitNotes(2)
    const line = hh.notes[1]
    expect(line?.content).toContain('Files were undone back to "rename every heading in the notes please"')
    const rows = hh.bridge.ctx.store.page({ thread_id: 'general', limit: 10 }).messages
    expect(rows.filter((m) => m.author === 'system' && m.text?.startsWith('Files were undone'))).toHaveLength(1)
  })

  test('nothing to put back: no line', async () => {
    const { hh, id } = await setup()
    const done = await undoTo(hh.bridge.ctx, { messageId: id, deletes: [] })
    expect(done.ok).toBe(true)
    await Bun.sleep(100)
    expect(hh.notes).toHaveLength(1)
  })

  test('the restore runs exclusive on every thread, so no point anywhere is taken of half-restored files', async () => {
    const { hh, r, id } = await setup()
    writeFileSync(join(r, 'a.txt'), 'edited\n')
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    let seen: readonly string[] = []
    const real = undo.exclusive.bind(undo)
    undo.exclusive = (threads, fn) => {
      seen = threads
      return real(threads, fn)
    }
    await undoTo(hh.bridge.ctx, { messageId: id, deletes: [] })
    expect([...seen].sort()).toEqual(hh.bridge.ctx.config.config.threads.map((t) => t.id).sort())
  })

  test('a restore that stopped partway: the session hears the files were partly undone', async () => {
    const { hh, r, id } = await setup()
    writeFileSync(join(r, 'a.txt'), 'edited\n')
    const failsAfterWriting: RunAsync = async (cmd, cwd, o) => {
      const res = await runCommandAsync(cmd, cwd, o)
      return cmd.includes('checkout-index') ? { ...res, code: 1, stderr: 'error: unable to write file' } : res
    }
    const done = await undoTo(hh.bridge.ctx, { messageId: id, deletes: [], run: failsAfterWriting })
    expect(done).toMatchObject({ ok: false, partial: true })
    await hh.waitNotes(2)
    expect(hh.notes[1]?.content).toContain(
      'Files were partly undone back to "rename every heading in the notes please"',
    )
    expect(hh.notes[1]?.content).toContain('check the folder')
  })

  test('an ignored file made after an older point and kept by a later one is never offered for deletion', async () => {
    const { hh, r, id } = await setup()
    const points = new UndoPoints(hh.bridge.ctx.store.db)
    writeFileSync(join(r, '.gitignore'), '.env\n')
    writeFileSync(join(r, '.env'), 'KEY=secret\n') // made after the first point, ignored: no copy of it anywhere
    const later = await snapshotFolder({
      folder: r,
      thread: 'general',
      turn: 'm_later',
      undoDir: join(hh.home, 'undo'),
    })
    points.record({ message_id: 'm_later', thread_id: 'general', turn: 'm_later', snapshot: later, at: Date.now() })
    writeFileSync(join(r, '.gitignore'), '') // a later turn un-ignores it
    await undoTo(hh.bridge.ctx, { messageId: id, deletes: ['.env'] })
    expect(readFileSync(join(r, '.env'), 'utf8')).toBe('KEY=secret\n')
  })

  test('a refusal says why and posts nothing', async () => {
    const { hh, r, id } = await setup()
    writeFileSync(join(r, '.git', 'MERGE_HEAD'), `${'a'.repeat(40)}\n`)
    const done = await undoTo(hh.bridge.ctx, { messageId: id, deletes: [] })
    expect(done.ok).toBe(false)
    expect(hh.notes).toHaveLength(1)
  })

  test('a message with no point is refused', async () => {
    h = await startHarness()
    const done = await undoTo(h.bridge.ctx, { messageId: 'm_01JBF3V7Q8K2M4N6P8R0S9T9T7', deletes: [] })
    expect(done).toMatchObject({ ok: false })
  })
})
