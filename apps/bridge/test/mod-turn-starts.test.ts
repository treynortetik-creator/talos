// The mod link counts the session's turn starts (undo/busy.ts reads it: a hand-over's turn has run once the count
// grew). A turn_start the mod sends again, after a sync whose answer was lost, is the same turn: counted once.
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FakeMod, fakeClock } from '@talos-app/testkit'
import { type Harness, startHarness } from './helpers.ts'
import { signingLink } from './mod-sign.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

test('turn starts are counted from the events the mod syncs, a resent one once', async () => {
  h = await startHarness()
  const hh = h
  const mod = new FakeMod({ clock: fakeClock() })
  const link = signingLink(hh.bridge.ctx.mod, () => Date.now())
  const key = () => readFileSync(hh.bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(key())).toEqual({ ok: true })
  const sync = () => {
    const r = link.sync(mod.syncRequest(key()))
    if (!r.ok) throw new Error(r.message)
  }
  sync()
  const before = hh.bridge.ctx.mod.turnStarts()
  mod.engine.startTurn('turn_1')
  const sent = [...mod.engine.events]
  sync()
  expect(hh.bridge.ctx.mod.turnStarts()).toBe(before + 1)
  mod.engine.events.push(...sent) // the same turn_start again: its answer was lost, so the mod sends it once more
  sync()
  expect(hh.bridge.ctx.mod.turnStarts()).toBe(before + 1)
})

test('a resent batch of two turns counts neither again', async () => {
  h = await startHarness()
  const hh = h
  const mod = new FakeMod({ clock: fakeClock() })
  const link = signingLink(hh.bridge.ctx.mod, () => Date.now())
  const key = () => readFileSync(hh.bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(key())).toEqual({ ok: true })
  const sync = () => {
    const r = link.sync(mod.syncRequest(key()))
    if (!r.ok) throw new Error(r.message)
  }
  sync()
  const before = hh.bridge.ctx.mod.turnStarts()
  mod.engine.startTurn('turn_a')
  mod.engine.completeTurn()
  mod.engine.startTurn('turn_b')
  const sent = [...mod.engine.events]
  sync()
  expect(hh.bridge.ctx.mod.turnStarts()).toBe(before + 2)
  mod.engine.events.push(...sent)
  sync()
  expect(hh.bridge.ctx.mod.turnStarts()).toBe(before + 2)
})
