// Settings -> Memory folders, the app's side of memory.folders / memory.roots_set: the relay carries the Mac's answer and could
// write anything into it, so a name that is a path, a pick that is not what was sent, or a save that did not come back saved
// is refused, never shown as saved. An offline Mac is an error, so nothing is ever shown as saved that the Mac did not save.
import { MEMORY_ROOTS_WORDING } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createFakeMemoryFolders } from '../../src/lib/fakeMemoryFolders.ts'
import { createSocketMemoryFolders, toMemoryFolders } from '../../src/lib/socketMemoryFolders.ts'

const ok = { folders: [{ name: 'notes', notes: 2 }], chosen: ['notes'], enabled: true }

describe("the Mac's answer is checked", () => {
  it('a plain answer reads as it is', () => {
    expect(toMemoryFolders(ok)).toEqual({ ...ok, saved: false })
  })

  it.each([
    ['a path for a name', { ...ok, folders: [{ name: '../x', notes: 1 }] }],
    ['a parent for a name', { ...ok, chosen: ['..'] }],
    ['a negative count', { ...ok, folders: [{ name: 'notes', notes: -1 }] }],
    ['no list', { chosen: [], enabled: false }],
  ])('%s is refused', (_why, f) => {
    expect(() => toMemoryFolders(f as Record<string, unknown>)).toThrow(TalosClientError)
  })

  it('a save must come back saved, with exactly what was sent', () => {
    expect(() => toMemoryFolders({ ...ok, saved: true, chosen: ['notes', 'journal'] }, ['notes'])).toThrow()
    expect(() => toMemoryFolders({ ...ok }, ['notes'])).toThrow() // not saved, and no line saying why
    expect(toMemoryFolders({ ...ok, saved: true }, ['notes']).saved).toBe(true)
  })

  it("a refused save keeps the Mac's own line", () => {
    const r = toMemoryFolders({ ...ok, error: MEMORY_ROOTS_WORDING.unknown }, ['missing'])
    expect(r).toMatchObject({ saved: false, error: MEMORY_ROOTS_WORDING.unknown })
  })

  it('the socket client sends the signed shapes the Mac reads', async () => {
    const sent: Array<Record<string, unknown>> = []
    const c = createSocketMemoryFolders({
      ask: async (frame) => {
        sent.push(frame)
        return frame.type === 'memory.roots_set' ? { ...ok, saved: true } : ok
      },
    })
    await c.list()
    await c.set(['notes', 'notes'])
    expect(sent.map((f) => f.type)).toEqual(['memory.folders', 'memory.roots_set'])
    expect(sent[1]?.names).toEqual(['notes'])
  })
})

describe('an offline Mac', () => {
  it('a save rejects mac_offline: never shown as saved', async () => {
    const fake = createFakeMemoryFolders({ macOnline: () => false })
    await expect(fake.set(['notes'])).rejects.toMatchObject({ code: 'mac_offline' })
  })
})
