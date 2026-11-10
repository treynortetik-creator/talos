// The one registry of named events (docs/HOOKS-AND-COMMANDS.md B2). A lifecycle moment that a hook or a mod may later react to is
// named here, with the shape of what it carries. Names are `<area>.<past_tense_snake>`. A payload is ids and enums only: never
// free text, a path, a token or a card body. The bridge's `emitEvent` refuses a name or a field set that is not registered.
import { z } from 'zod'
import { DialogKind } from './dialog-files.ts'
import { CardId, ThreadId } from './ids.ts'

/** The event name for "a thread's folder was chosen" (the bridge emits it when a saved patch changes `session_opts.cwd`). */
export const THREAD_FOLDER_CHOSEN_EVENT = 'thread.folder_chosen'
/** Named moments for future hooks (the bridge logs them with ids, never the screen's words): a dialog card was posted, and it was answered with a tap. */
export const DIALOG_CARD_POSTED_EVENT = 'dialog.card_posted'
export const DIALOG_CARD_ANSWERED_EVENT = 'dialog.card_answered'

/** Who emits it. Only `bridge` events exist; `mac` and `web` wait for a frame to the bridge (phase 4). */
export const EVENT_EMITTERS = ['bridge', 'mac', 'web'] as const
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
