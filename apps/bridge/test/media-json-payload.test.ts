// BSVC-1: a .json attachment and its metadata sidecar were both written to media/<id>.json, so the sidecar replaced the
// attachment. A .json payload is now stored as <id>.data.json; the sidecar keeps <id>.json.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AttachmentRefT, newId, sha256Hex } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { paths } from '../src/config.ts'
import { MediaStore } from '../src/media.ts'
import { MediaRetention } from '../src/media-retention.ts'
import type { RelayHttp } from '../src/relay-http.ts'
import { type Harness, startHarness } from './helpers.ts'

const dirs: string[] = []
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BYTES = new TextEncoder().encode('{"a":1}')

function store() {
  const home = mkdtempSync(join(tmpdir(), 'media-json-'))
  dirs.push(home)
  const p = paths(home)
  const puts: Array<{ id: string; bytes: Uint8Array; sha: string }> = []
  const http = {
    getMedia: async () => BYTES,
    putMedia: async (id: string, bytes: Uint8Array, sha: string) => {
      puts.push({ id, bytes, sha })
    },
  } as unknown as RelayHttp
  return { media: new MediaStore(p, http), p, puts }
}

const refOf = (name: string, mime: string): AttachmentRefT => ({
  media_id: newId('md'),
  kind: 'file',
  role: 'attachment',
  mime,
  name,
  size: BYTES.length,
  sha256: sha256Hex(BYTES),
})

describe('a .json attachment keeps its own file', () => {
  test('(a) application/json: the payload reads back exact, the sidecar is separate metadata', async () => {
    const { media, p } = store()
    const ref = refOf('x.json', 'application/json')
    const d = await media.download(ref)
    expect(d.path).toBe(join(p.media, `${ref.media_id}.data.json`))
    expect(new Uint8Array(readFileSync(d.path))).toEqual(BYTES)
    const side = JSON.parse(readFileSync(join(p.media, `${ref.media_id}.json`), 'utf8'))
    expect(side.path).toBe(d.path)
    expect(side.ref.media_id).toBe(ref.media_id)
  })

  test('(b) named x.json with another MIME: same', async () => {
    const { media, p } = store()
    const ref = refOf('x.json', 'application/octet-stream')
    const d = await media.download(ref)
    expect(d.path).toBe(join(p.media, `${ref.media_id}.data.json`))
    expect(new Uint8Array(readFileSync(d.path))).toEqual(BYTES)
    expect(JSON.parse(readFileSync(join(p.media, `${ref.media_id}.json`), 'utf8')).path).toBe(d.path)
  })

  test('(c) rehydrate passes its sha check and re-uploads the attached bytes', async () => {
    const { media, puts } = store()
    const ref = refOf('x.json', 'application/json')
    await media.download(ref)
    expect(await media.rehydrate(ref.media_id)).toBe(true)
    expect(puts[0]?.bytes).toEqual(BYTES)
  })

  test('(d) retention removes the payload under its new name and keeps the sidecar, marked removed', async () => {
    const clock = fakeClock('2026-11-10T12:00:00.000Z')
    h = await startHarness({ clock, startBridge: false })
    const ctx = h.bridge.ctx
    const dir = paths(h.home).media
    mkdirSync(dir, { recursive: true })
    const http = { getMedia: async () => BYTES } as unknown as RelayHttp
    const media = new MediaStore(paths(h.home), http)
    const ref = refOf('x.json', 'application/json')
    const d = await media.download(ref)
    const t = (clock.now() - 100 * 86_400_000) / 1000
    utimesSync(d.path, t, t)
    const retention = new MediaRetention(ctx, dir)
    retention.tick()
    ctx.config.update((c) => ({ ...c, media_keep_days: 30 }))
    retention.tick()
    clock.advance(2 * 3_600_000)
    retention.tick()
    expect(existsSync(d.path)).toBe(false)
    expect(existsSync(join(dir, `${ref.media_id}.json`))).toBe(true)
    expect(ctx.media.removedInfo(ref.media_id)?.after_days).toBe(30)
  })

  test('(e) a non-json attachment keeps <id>.<ext>', async () => {
    const { media, p } = store()
    const ref = refOf('x.txt', 'text/plain')
    const d = await media.download(ref)
    expect(d.path).toBe(join(p.media, `${ref.media_id}.txt`))
  })
})
