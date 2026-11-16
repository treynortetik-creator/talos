// The Files pane through the real Bridge: a signed `files.list` / `files.read` from a (fake) app over the (fake) relay reaches the
// FilesService and the answer comes back for the same request_id. Refusals are the one fixed error, with nothing of the file in
// it; a forged signature is refused like every signed read. The agent has no way to ask at all. Runs on a temp folder.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILES_FEATURE, FILES_WORDING, newUlid } from '@talos-app/protocol'
import { type FakeApp, mkFrame } from '@talos-app/testkit'
import { bridgeFeatures } from '../src/handshake.ts'
import { INSTRUCTIONS } from '../src/instructions.ts'
import { ALL_TOOLS, WORKER_TOOLS } from '../src/tools/index.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

// /tmp, not TMPDIR: a CI run's TMPDIR is under ~/.cache, and a thread folder inside a hidden folder is refused by design
const folder = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'talos-files-bridge-')))
mkdirSync(join(folder, 'docs'))
writeFileSync(join(folder, 'docs', 'plan.md'), '# Plan\n')
writeFileSync(join(folder, '.env'), 'TOKEN=very-secret\n')

async function start() {
  h = await startHarness({ bridge: { files: { rootFor: (id) => (id === 'general' ? folder : null) } } })
  return h
}
const send = async (app: FakeApp, type: 'files.list' | 'files.read', body: Record<string, unknown>) => {
  const f = await app.sign({ ...mkFrame(type), request_id: newUlid(), thread_id: 'general', ...body })
  app.send(f)
  return f
}
const answers = (x: Harness, type: string, requestId: string) =>
  x.app.rec.frames
    .filter((r) => r.direction === 'in' && r.raw.type === type && r.raw.request_id === requestId)
    .map((r) => r.raw as Record<string, unknown>)
const errors = (x: Harness, ref: string) =>
  x.app.rec.frames
    .filter((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === ref)
    .map((r) => r.raw as Record<string, unknown>)

describe('files.* through the real Bridge', () => {
  test('the Mac says it can show files', async () => {
    const x = await start()
    expect(bridgeFeatures(x.bridge.ctx)).toContain(FILES_FEATURE)
  })

  test('a signed list and read come back for the same request, without hidden files', async () => {
    const x = await start()
    const l = await send(x.app, 'files.list', { path: '' })
    await waitFor(() => answers(x, 'files.listing', l.request_id as string).length > 0, 5000, 'files.listing')
    const listing = answers(x, 'files.listing', l.request_id as string)[0]
    expect(listing?.entries).toEqual([{ name: 'docs', kind: 'dir' }])
    expect(JSON.stringify(listing)).not.toContain('.env')
    const r = await send(x.app, 'files.read', { path: 'docs/plan.md', offset: 0 })
    await waitFor(() => answers(x, 'files.file', r.request_id as string).length > 0, 5000, 'files.file')
    expect(answers(x, 'files.file', r.request_id as string)[0]).toMatchObject({ kind: 'text', text: '# Plan\n' })
  })

  test('a refused read comes back as the one fixed refusal, with nothing of the file', async () => {
    const x = await start()
    const r = await send(x.app, 'files.read', { path: '.env', offset: 0 })
    await waitFor(() => errors(x, r.id as string).length > 0, 5000, 'refusal')
    expect(errors(x, r.id as string)[0]?.message).toBe(FILES_WORDING.refused)
    expect(JSON.stringify(x.app.rec.frames.map((f) => f.raw))).not.toContain('very-secret')
    expect(answers(x, 'files.file', r.request_id as string)).toHaveLength(0)
  })

  test('a frame with a forged signature is refused out loud and answers nothing', async () => {
    const x = await start()
    const signed = (await x.app.sign({
      ...mkFrame('files.read'),
      request_id: newUlid(),
      thread_id: 'general',
      path: 'docs/plan.md',
      offset: 0,
    })) as Record<string, unknown>
    const osig = String(signed.osig)
    const forged = { ...signed, id: newUlid(), osig: (osig[0] === 'A' ? 'B' : 'A') + osig.slice(1) }
    x.relay.sendToBridge(forged)
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
    expect(x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'files.file')).toHaveLength(0)
  })

  test('no tool, for main or for a thread session, reads files for the app, and the instructions do not mention the pane', () => {
    const names = [...ALL_TOOLS, ...WORKER_TOOLS].map((t) => t.name)
    expect(names.some((n) => /files?_(list|read)|files\./.test(n))).toBe(false)
    expect(INSTRUCTIONS).not.toMatch(/files\.list|files\.read|Files pane/i)
  })
})
