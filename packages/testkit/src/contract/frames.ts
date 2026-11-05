import { type Direction, parseFrame } from '@talos-app/protocol'
import { expect } from 'vitest'

/** Every frame a component emits must parse and belong to the direction union. */
export function assertEmittedFramesValid(frames: Array<Record<string, unknown>>, direction: Direction) {
  for (const raw of frames) {
    const res = parseFrame(raw, { direction })
    expect(res.ok, `${String(raw.type)} (${direction}): ${res.ok ? '' : res.message}`).toBe(true)
  }
}
