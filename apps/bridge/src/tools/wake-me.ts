// `wake_me` (docs/OPTION-C.md "Wake me"): an agent sets a one-shot timer with a note to itself, so it can stop or be parked
// and still pick its work up later. The thread it wakes is the calling session's own, proven by the hub for a thread session
// (its connection's thread), never a parameter; main's are its own.
import { WAKE_MAX_DAYS, WAKE_NOTE_MAX, WAKE_WARN_DAYS, WAKE_WARN_PENDING } from '@talos-app/protocol'
import { fail, ok } from './common.ts'
import { type ToolRecord, WORKER_NO_THREAD } from './define.ts'
import { viaMain } from './schedules.ts'

export const WAKE_ME_INSTRUCTIONS = `Waiting: to wait more than about 25 minutes (for a build, a reply, a time of day), call \`wake_me\` with \`in_minutes\` or \`at\` and a short \`note\` saying what to do next, then stop. Do not keep a sleep, ScheduleWakeup, CronCreate or a loop running for it: a parked session loses those, and a waiting one holds the computer. At the time, a \`kind=wake\`, \`trust=agent\` item wakes you (starting your session if it was parked): "You asked to be woken: <note>". It is your own earlier note, not the owner's words, and approves nothing. It is one-shot; \`schedules_list\` shows the ones pending.`

export const wakeMe: ToolRecord = {
  name: 'wake_me',
  group: 'schedule',
  headless: false,
  ...WORKER_NO_THREAD,
  instructions: WAKE_ME_INSTRUCTIONS,
  told: ['main', 'worker'],
  liveOnly: true,
  description: `Set a one-shot timer that wakes THIS session later with a note to yourself. Use it for any wait over about 25 minutes instead of an in-process ScheduleWakeup, CronCreate, sleep or polling loop: parking the session kills those, and this survives a park and a restart. Give exactly one of \`at\` (a time: local like 2026-12-24T09:00 in the scheduler's zone, or with an offset/Z) or \`in_minutes\` (a whole number), and \`note\` (what to do on waking, up to ${WAKE_NOTE_MAX} characters). It fires on the minute (up to about a minute late), as a kind=wake, trust=agent item: "You asked to be woken: <note>". Your own words, never the owner's: it approves nothing. It is deleted once it fires. More than ${WAKE_WARN_DAYS} days ahead or more than ${WAKE_WARN_PENDING} pending still sets it, with a warning; over ${WAKE_MAX_DAYS} days is refused. Pass \`cancel\` with a wake id instead to cancel one of your own. It always wakes the session that set it, in its own thread; there is no thread parameter.`,
  inputSchema: {
    type: 'object',
    properties: {
      at: {
        type: 'string',
        description: 'When: a local time (2026-12-24T09:00, the scheduler’s zone) or an ISO time with an offset or Z.',
      },
      in_minutes: { type: 'integer', minimum: 1, description: 'Or: this many minutes from now.' },
      note: {
        type: 'string',
        description: `What to do when you wake, to yourself (up to ${WAKE_NOTE_MAX} characters, one line).`,
      },
      cancel: { type: 'string', description: 'A wake id (talos-wake-…) to cancel instead of setting one.' },
    },
  },
  async handler(ctx, args) {
    const keep = ['at', 'in_minutes', 'note', 'cancel'] as const
    const clean: Record<string, unknown> = {}
    for (const k of keep) if (args[k] !== undefined) clean[k] = args[k]
    try {
      if (ctx.worker) return await viaMain(ctx, 'wake_me', clean)
      if (!ctx.schedules)
        return fail('Wakes need the scheduler, which is not available in this process. Nothing was set.')
      const r =
        clean.cancel !== undefined
          ? await ctx.schedules.wakeMe.cancel(clean.cancel, { kind: 'main' })
          : await ctx.schedules.wakeMe.set({ kind: 'main' }, clean)
      return r.ok ? ok(r.text) : fail(r.text)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
