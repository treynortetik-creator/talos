// @vitest-environment node
// Audit O2, the app side: a `ready` with one element this build cannot read still arrives (the app comes online), and
// the owner is told something is not shown, once per field, never for a ready that lost nothing.
import { readFileSync } from 'node:fs'
import { parseFrame } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { unknownOfReady } from '../src/lib/unknownFrames.ts'

const fixture = JSON.parse(
  readFileSync(new URL('../../../packages/protocol/fixtures/frames/ready.json', import.meta.url), 'utf8'),
) as Record<string, any>

function arrive(raw: Record<string, unknown>) {
  const r = parseFrame(raw, { direction: 'relay_to_app' })
  expect(r.ok, 'the ready reaches the app').toBe(true)
  if (!r.ok || r.frame.type !== 'ready') throw new Error('not a ready')
  return unknownOfReady(raw, r.frame).map((u) => u.kind)
}

describe('a ready with parts this build left out', () => {
  it('a thread of a newer kind: the ready arrives, and the left-out threads are noted', () => {
    const raw = {
      ...fixture,
      threads: [...fixture.threads, { ...fixture.threads[0], id: 'later', kind: 'from_the_future' }],
    }
    expect(arrive(raw)).toEqual(['ready:threads'])
  })

  it('a status state and a session state from a newer Mac: each noted once', () => {
    const raw = {
      ...fixture,
      statuses: [{ ...fixture.statuses[0], state: 'daydreaming' }],
      session_state: { ...fixture.session_state, a_newer_key: true },
    }
    expect(arrive(raw).sort()).toEqual(['ready:session_state', 'ready:statuses'])
  })

  it('a ready that lost nothing notes nothing', () => {
    expect(arrive(fixture)).toEqual([])
    const { session_state: _s, ...without } = fixture // a field that was never sent is not a loss
    expect(arrive(without)).toEqual([])
  })
})
