// The one registry of named events (docs/HOOKS-AND-COMMANDS.md B2). Names, payload shapes and the moved constants.
import { describe, expect, test } from 'vitest'
import {
  DIALOG_CARD_ANSWERED_EVENT,
  DIALOG_CARD_POSTED_EVENT,
  EVENT_EMITTERS,
  EVENT_STATUSES,
  EVENTS,
  eventInfo,
  SETTING_CHANGED_EVENT,
  THREAD_ARCHIVED_EVENT,
  THREAD_CREATED_EVENT,
  THREAD_FOLDER_CHOSEN_EVENT,
  THREAD_RENAMED_EVENT,
} from '../src/index.ts'

const CARD = 'c_01HZX0000000000000000000AA'

describe('the events registry', () => {
  test('the three existing names moved here and keep their values; the app-control moments are registered beside them', () => {
    expect(THREAD_FOLDER_CHOSEN_EVENT).toBe('thread.folder_chosen')
    expect(DIALOG_CARD_POSTED_EVENT).toBe('dialog.card_posted')
    expect(DIALOG_CARD_ANSWERED_EVENT).toBe('dialog.card_answered')
    expect(THREAD_CREATED_EVENT).toBe('thread.created')
    expect(THREAD_RENAMED_EVENT).toBe('thread.renamed')
    expect(THREAD_ARCHIVED_EVENT).toBe('thread.archived')
    expect(SETTING_CHANGED_EVENT).toBe('setting.changed')
    expect(EVENTS.map((e) => e.name).sort()).toEqual(
      [
        'bug.reported',
        'dialog.card_answered',
        'dialog.card_posted',
        'setting.changed',
        'thread.archived',
        'thread.created',
        'thread.folder_chosen',
        'thread.renamed',
        'thread.unarchived',
      ].sort(),
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
      'thread.created': { thread_id: 'trip', source: 'agent_card' },
      'thread.renamed': { thread_id: 'trip', source: 'owner' },
      'thread.archived': { thread_id: 'trip', source: 'agent_trust' },
      'thread.unarchived': { thread_id: 'trip', source: 'agent_card' },
      'setting.changed': { setting: 'threads.topic', thread_id: 'trip', source: 'agent_card' },
      'bug.reported': { report_id: '01HZX0000000000000000000AA', device_id: 'd_abcdefghijklmnopqrst', webhook: 'off' },
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

  test('setting.changed names a setting of the table and nothing else: no free text, no value', () => {
    const info = eventInfo('setting.changed')
    expect(info?.payload.safeParse({ setting: 'timezone', source: 'owner' }).success).toBe(true)
    expect(info?.payload.safeParse({ setting: 'my private note', source: 'owner' }).success).toBe(false)
    expect(info?.payload.safeParse({ setting: 'timezone', source: 'owner', value: 'Europe/Paris' }).success).toBe(false)
    expect(info?.payload.safeParse({ setting: 'timezone', source: 'someone' }).success).toBe(false)
    for (const name of ['thread.created', 'thread.renamed', 'thread.archived'])
      expect(
        eventInfo(name)?.payload.safeParse({ thread_id: 'trip', source: 'owner', name: 'Trip' }).success,
        name,
      ).toBe(false)
  })
})
