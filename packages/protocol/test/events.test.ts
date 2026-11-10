// The one registry of named events (docs/HOOKS-AND-COMMANDS.md B2). Names, payload shapes and the moved constants.
import { describe, expect, test } from 'vitest'
import {
  DIALOG_CARD_ANSWERED_EVENT,
  DIALOG_CARD_POSTED_EVENT,
  EVENT_EMITTERS,
  EVENT_STATUSES,
  EVENTS,
  eventInfo,
  THREAD_FOLDER_CHOSEN_EVENT,
} from '../src/index.ts'

const CARD = 'c_01HZX0000000000000000000AA'

describe('the events registry', () => {
  test('the three existing names moved here and keep their values', () => {
    expect(THREAD_FOLDER_CHOSEN_EVENT).toBe('thread.folder_chosen')
    expect(DIALOG_CARD_POSTED_EVENT).toBe('dialog.card_posted')
    expect(DIALOG_CARD_ANSWERED_EVENT).toBe('dialog.card_answered')
    expect(EVENTS.map((e) => e.name).sort()).toEqual(
      ['dialog.card_answered', 'dialog.card_posted', 'thread.folder_chosen'].sort(),
    )
  })

  test('names are <area>.<past_tense_snake>, unique, with a known emitter and status', () => {
    const seen = new Set<string>()
    for (const e of EVENTS) {
      expect(e.name, e.name).toMatch(/^[a-z]+\.[a-z]+(_[a-z]+)*$/)
      expect(seen.has(e.name), `duplicate ${e.name}`).toBe(false)
      seen.add(e.name)
      expect(EVENT_EMITTERS).toContain(e.emitter)
      expect(EVENT_STATUSES).toContain(e.status)
      expect(eventInfo(e.name)).toBe(e)
    }
    expect(eventInfo('no.such_event')).toBeUndefined()
  })

  test('each payload is ids and enums only: it parses a real shape and refuses an extra key such as a path', () => {
    const good: Record<string, Record<string, unknown>> = {
      'thread.folder_chosen': { thread_id: 'trip', cleared: false },
      'dialog.card_posted': { dialog_kind: 'dev_channels', thread_id: 'main', card_id: CARD },
      'dialog.card_answered': { dialog_kind: 'login', thread_id: 'main', card_id: CARD, choice: null },
    }
    for (const e of EVENTS) {
      const fields = good[e.name]
      expect(fields, `a sample for ${e.name}`).toBeDefined()
      expect(e.payload.safeParse(fields).success, e.name).toBe(true)
      expect(e.payload.safeParse({ ...fields, path: '/home/example/secret' }).success, `${e.name} + path`).toBe(false)
    }
    expect(
      eventInfo('thread.folder_chosen')?.payload.safeParse({ thread_id: 'Not A Thread', cleared: true }).success,
    ).toBe(false)
  })
})
