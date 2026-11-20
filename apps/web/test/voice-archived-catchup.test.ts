// @vitest-environment node
// Voice input was archived 2026-11-19 (docs/archived/voice.md). A relay keeps owner frames for days, so a catch-up can
// still bring a stored voice note or call frame from before. This build no longer reads them, and they are no sign of a
// newer app: no "update the app" note (the review of the archive found one on every catch-up for a week).
import { describe, expect, it } from 'vitest'
import { unknownOfFrame } from '../src/lib/unknownFrames.ts'

describe('a stored voice frame from before the archive', () => {
  it('is skipped quietly, while a truly unknown frame still asks for an update', () => {
    const id = '01JC0000000000000000000000'
    for (const type of ['voice_note', 'voice.state', 'voice.ask', 'voice.progress', 'voice.ended'])
      expect(unknownOfFrame({ type, id, thread_id: 'general' }), type).toBeNull()
    expect(unknownOfFrame({ type: 'some.new_thing', id })).toEqual({
      kind: 'frame:some.new_thing',
      id,
      threadId: undefined,
    })
  })
})
