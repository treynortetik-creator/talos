// The one registry of named events (docs/HOOKS-AND-COMMANDS.md B2). A lifecycle moment that a hook or a mod may later react to is
// named here, with the shape of what it carries. Names are `<area>.<past_tense_snake>`. A payload is ids and enums only: never
// free text, a path, a token or a card body. The bridge's `emitEvent` refuses a name or a field set that is not registered.
import { z } from 'zod'
import { DialogKind } from './dialog-files.ts'
import { CardId, DeviceId, ThreadId, Ulid } from './ids.ts'
import { SETTING_EVENT_KEYS } from './settings-table.ts'

/** The event name for "a thread's folder was chosen" (the bridge emits it when a saved patch changes `session_opts.cwd`). */
export const THREAD_FOLDER_CHOSEN_EVENT = 'thread.folder_chosen'
/** Named moments for future hooks (the bridge logs them with ids, never the screen's words): a dialog card was posted, and it was answered with a tap. */
export const DIALOG_CARD_POSTED_EVENT = 'dialog.card_posted'
export const DIALOG_CARD_ANSWERED_EVENT = 'dialog.card_answered'

/** Thread and setting changes, from whoever made them (see `CONFIG_EVENT_SOURCES`). */
export const THREAD_CREATED_EVENT = 'thread.created'
export const THREAD_RENAMED_EVENT = 'thread.renamed'
export const THREAD_ARCHIVED_EVENT = 'thread.archived'
export const THREAD_UNARCHIVED_EVENT = 'thread.unarchived'
export const SETTING_CHANGED_EVENT = 'setting.changed'
/** Who made a change: the owner (a signed `config.patch`), an agent proposal the owner approved on a card, or one applied directly because the owner asked (agent_asked; agent_trust in older logs). */
// agent_trust: written by bridges before the settings-on-request change (kept so older logs still read)
export const CONFIG_EVENT_SOURCES = ['owner', 'agent_card', 'agent_trust', 'agent_asked'] as const
export type ConfigEventSource = (typeof CONFIG_EVENT_SOURCES)[number]

/** The bug report a paired device sent, as stored by the relay. */
export const BUG_REPORTED_EVENT = 'bug.reported'

/** Who emits it. `bridge` and `relay` events exist; `mac` and `web` wait for a frame to the bridge (phase 4). */
export const EVENT_EMITTERS = ['bridge', 'relay', 'mac', 'web'] as const
export type EventEmitter = (typeof EVENT_EMITTERS)[number]
/** `live`: something emits it today. `planned`: named, nothing emits it yet. */
export const EVENT_STATUSES = ['live', 'planned'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export type EventInfo = {
  name: string
  /** Strict on purpose: a field that is not listed is refused, so a path cannot ride along. */
  payload: z.ZodObject<z.ZodRawShape>
  emitter: EventEmitter
  status: EventStatus
}

export const EVENTS: readonly EventInfo[] = [
  {
    name: THREAD_FOLDER_CHOSEN_EVENT,
    payload: z.strictObject({ thread_id: ThreadId, cleared: z.boolean() }), // never the path
    emitter: 'bridge',
    status: 'live',
  },
  {
    name: DIALOG_CARD_POSTED_EVENT,
    payload: z.strictObject({ dialog_kind: DialogKind, thread_id: ThreadId, card_id: CardId }),
    emitter: 'bridge',
    status: 'live',
  },
  {
    name: DIALOG_CARD_ANSWERED_EVENT,
    // `choice` is the button's index (null: the login card's one button), never the label or any typed text
    payload: z.strictObject({
      dialog_kind: DialogKind,
      thread_id: ThreadId,
      card_id: CardId,
      choice: z.number().int().nonnegative().nullable(),
    }),
    emitter: 'bridge',
    status: 'live',
  },
  // Ids and enums only: a thread's id, never its name or topic; a setting's name from the table, never its value.
  ...[THREAD_CREATED_EVENT, THREAD_RENAMED_EVENT, THREAD_ARCHIVED_EVENT, THREAD_UNARCHIVED_EVENT].map(
    (name): EventInfo => ({
      name,
      payload: z.strictObject({ thread_id: ThreadId, source: z.enum(CONFIG_EVENT_SOURCES) }),
      emitter: 'bridge',
      status: 'live',
    }),
  ),
  {
    name: SETTING_CHANGED_EVENT,
    // `thread_id` is set for the per-thread fields (`threads.topic`, ...); the value is never carried
    payload: z.strictObject({
      setting: z.enum(SETTING_EVENT_KEYS),
      source: z.enum(CONFIG_EVENT_SOURCES),
      thread_id: ThreadId.optional(),
    }),
    emitter: 'bridge',
    status: 'live',
  },
  {
    name: BUG_REPORTED_EVENT,
    // ids and enums only: never the words, the logs or the picture. `webhook`: whether a webhook call was started for it. `bridge`: whether it was queued to this relay's own bridge.
    payload: z.strictObject({
      report_id: Ulid,
      device_id: DeviceId,
      webhook: z.enum(['off', 'queued']),
      bridge: z.enum(['queued', 'failed']),
    }),
    emitter: 'relay',
    status: 'live',
  },
]

/** The registry row for `name`, or undefined when it is not registered. */
export function eventInfo(name: string): EventInfo | undefined {
  return EVENTS.find((e) => e.name === name)
}

/** What `talos events --json` prints: the registry as data (the payload as its field names), so an agent can read it. */
export const EventsList = z.object({
  schema: z.literal(1),
  events: z.array(
    z.object({
      name: z.string(),
      emitter: z.enum(EVENT_EMITTERS),
      status: z.enum(EVENT_STATUSES),
      fields: z.array(z.string()),
    }),
  ),
})
export type EventsListT = z.infer<typeof EventsList>

/** The registry in the shape `talos events --json` prints. */
export function eventsList(): EventsListT {
  return {
    schema: 1,
    events: EVENTS.map((e) => ({
      name: e.name,
      emitter: e.emitter,
      status: e.status,
      fields: Object.keys(e.payload.shape),
    })),
  }
}
