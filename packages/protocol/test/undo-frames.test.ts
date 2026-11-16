// "Undo to here" frames: the owner's signed undo.request and its result, and a message's undo point on the message and
// on its `delivered` receipt. An older peer (the parser from the commit before this one, via git archive) must keep a
// receipt or a message that carries `undo` (dropping the field), and refuse the request (fails closed).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Message, parseFrame } from '../src/index.ts'

const BEFORE_UNDO_REQUEST = 'fbae49b5e577e1db00fc3a44632ff8ebbd3ab51a'
const here = join(import.meta.dirname, '..')
const fx = (n: string) => JSON.parse(readFileSync(join(here, 'fixtures', 'frames', `${n}.json`), 'utf8'))

function oldProtocolDir(): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'undo-compat-'))
    const tar = execFileSync(
      'git',
      ['-C', join(here, '..', '..'), 'archive', BEFORE_UNDO_REQUEST, 'packages/protocol', 'tsconfig.base.json'],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    )
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    symlinkSync(join(here, 'node_modules'), join(dir, 'packages', 'protocol', 'node_modules'))
    return join(dir, 'packages', 'protocol')
  } catch {
    return undefined
  }
}
const oldDir = oldProtocolDir()

const message = (extra: Record<string, unknown>) => ({
  ...(fx('reply').message as Record<string, unknown>),
  author: 'owner',
  ...extra,
})

describe('undo.request', () => {
  it('a signed request parses, from the app to the relay and on to the bridge', () => {
    const f = fx('undo.request')
    expect(parseFrame(f, { direction: 'app_to_relay' }).ok).toBe(true)
    expect(parseFrame(f, { direction: 'relay_to_bridge' }).ok).toBe(true)
    expect(parseFrame(fx('undo.request.result'), { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(parseFrame(fx('undo.request.result'), { direction: 'relay_to_app' }).ok).toBe(true)
  })

  it('is strict: an unknown key, a missing signature or device, or a bad id is refused', () => {
    const f = fx('undo.request')
    expect(parseFrame({ ...f, also_delete: ['x'] }).ok).toBe(false)
    const { osig: _o, ...unsigned } = f
    expect(parseFrame(unsigned).ok).toBe(false)
    const { device_id: _d, ...noDevice } = f
    expect(parseFrame(noDevice).ok).toBe(false)
    expect(parseFrame({ ...f, message_id: 'not-a-message' }).ok).toBe(false)
    expect(parseFrame({ ...f, thread_id: '../etc' }).ok).toBe(false)
  })

  it('goes only from the app to the bridge, never the other way', () => {
    expect(parseFrame(fx('undo.request'), { direction: 'bridge_to_relay' }).ok).toBe(false)
    expect(parseFrame(fx('undo.request.result'), { direction: 'app_to_relay' }).ok).toBe(false)
  })

  it.skipIf(!oldDir)('an older relay refuses the request, so nothing is queued (fails closed)', async () => {
    const old = await import(join(oldDir as string, 'src', 'index.ts'))
    expect(old.parseFrame(fx('undo.request'), { direction: 'app_to_relay' }).ok).toBe(false)
  })
})

describe("a message's undo point", () => {
  it('rides on the message and on its delivered receipt', () => {
    expect(Message.parse(message({ undo: { state: 'ready' } })).undo).toEqual({ state: 'ready' })
    const r = parseFrame({ ...fx('receipt'), state: 'delivered', undo: { state: 'too_large' } })
    expect(r.ok && r.frame.type === 'receipt' && r.frame.undo).toEqual({ state: 'too_large' })
  })

  it('an unreadable one (a newer state) reads as absent: the row and the receipt stay', () => {
    const m = Message.parse(message({ undo: { state: 'archived' } }))
    expect(m.undo).toBeUndefined()
    expect(m.text).toBeDefined()
    const r = parseFrame({ ...fx('receipt'), undo: 'ready' })
    expect(r.ok).toBe(true)
    expect(r.ok && r.frame.type === 'receipt' && r.frame.undo).toBeUndefined()
  })

  it.skipIf(!oldDir)('an older relay or app keeps the receipt and the message, without the field', async () => {
    const old = await import(join(oldDir as string, 'src', 'index.ts'))
    const receipt = { ...fx('receipt'), state: 'delivered', undo: { state: 'ready' } }
    for (const direction of ['bridge_to_relay', 'relay_to_app'] as const) {
      const r = old.parseFrame(receipt, { direction })
      expect(r.ok).toBe(true)
      expect(r.frame.undo).toBeUndefined()
    }
    const m = old.Message.parse(message({ undo: { state: 'ready' } }))
    expect(m.undo).toBeUndefined()
    expect(m.id).toBe(fx('reply').message.id)
  })
})
