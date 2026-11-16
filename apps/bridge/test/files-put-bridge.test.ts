// Upload into a thread's folder through the real Bridge: a signed `files.put` from a (fake) app over the (fake) relay reaches
// the service, the file is created in the thread's folder and `files.put_result` comes back for the same request_id. A refusal
// is the Mac's sentence; the same signed put sent again is refused and puts nothing more.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { FILES_PUT_FEATURE, FILES_PUT_WORDING, newUlid, sha256Hex } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { bridgeFeatures } from '../src/handshake.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const BODY = Buffer.from('# Packing\n- boots\n')
const fresh = () => {
  const folder = join(realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'talos-files-put-bridge-'))), 'trip')
  mkdirSync(join(folder, 'docs'), { recursive: true })
  return folder
}
async function start(folder: string) {
  h = await startHarness({
    bridge: {
      files: { rootFor: (id) => (id === 'general' ? folder : null) },
      filesPut: { fetch: async () => BODY },
    },
  })
  return h
}
const media = {
  media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
  name: 'packing.md',
  mime: 'text/markdown',
  size: BODY.length,
  sha256: sha256Hex(BODY),
  kind: 'file',
  role: 'attachment',
}
const putFrame = (x: Harness, name: string) =>
  x.app.sign({ ...mkFrame('files.put'), request_id: newUlid(), thread_id: 'general', dir: 'docs', name, media })
const inbound = (x: Harness, pick: (r: Record<string, unknown>) => boolean) =>
  waitFor(() => x.app.rec.frames.some((r) => r.direction === 'in' && pick(r.raw)), 5000, 'answer').then(
    () => x.app.rec.frames.find((r) => r.direction === 'in' && pick(r.raw))?.raw as Record<string, unknown>,
  )

describe('files.put through the real Bridge', () => {
  test('the Mac says it takes uploads, puts the file in the folder, and answers the same request', async () => {
    const folder = fresh()
    const x = await start(folder)
    expect(bridgeFeatures(x.bridge.ctx)).toContain(FILES_PUT_FEATURE)
    const f = await putFrame(x, 'packing.md')
    x.app.send(f)
    const r = await inbound(x, (raw) => raw.type === 'files.put_result' && raw.request_id === f.request_id)
    expect(r).toMatchObject({ thread_id: 'general', dir: 'docs', name: 'packing.md', size: BODY.length })
    expect(readFileSync(join(folder, 'docs', 'packing.md'))).toEqual(BODY)
  })

  test('an instruction file is refused in words; the same signed put sent twice puts one file', async () => {
    const folder = fresh()
    const x = await start(folder)
    const bad = await putFrame(x, 'AGENTS.md')
    x.app.send(bad)
    const e = await inbound(x, (raw) => raw.type === 'error' && raw.ref === bad.id)
    expect(e.message).toBe(FILES_PUT_WORDING.instructions)
    const f = await putFrame(x, 'packing.md')
    x.app.send(f)
    await inbound(x, (raw) => raw.type === 'files.put_result' && raw.request_id === f.request_id)
    x.app.send(f)
    const again = await inbound(x, (raw) => raw.type === 'error' && raw.ref === f.id)
    expect(again.message).toBe('That request was already used.')
    expect(readdirSync(join(folder, 'docs'))).toEqual(['packing.md'])
  })

  test('an upload still downloading does not hold the reads behind it', async () => {
    const folder = fresh()
    let release: () => void = () => {}
    h = await startHarness({
      bridge: {
        files: { rootFor: (id) => (id === 'general' ? folder : null) },
        filesPut: { fetch: () => new Promise((res) => (release = () => res(BODY))) },
      },
    })
    const x = h
    const f = await putFrame(x, 'slow.md')
    x.app.send(f)
    const list = await x.app.sign({ ...mkFrame('files.list'), request_id: newUlid(), thread_id: 'general', path: '' })
    x.app.send(list)
    await inbound(x, (raw) => raw.type === 'files.listing' && raw.request_id === list.request_id)
    release()
    await inbound(x, (raw) => raw.type === 'files.put_result' && raw.request_id === f.request_id)
  })
})
