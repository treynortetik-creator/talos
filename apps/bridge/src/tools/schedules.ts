// The four Schedules tools (docs/SCHEDULES.md S6.1). `schedules_list` works headless (read-only). The others are live only.
// The agent never writes the registry: `schedule_propose` mints a card the owner approves, and the BRIDGE applies it.
import { fail, needStr, ok, str, type Tool, ToolError } from './common.ts'

function service(ctx: Parameters<Tool['handler']>[0]) {
  if (!ctx.schedules) throw new ToolError('Schedules are not available in this process.')
  return ctx.schedules
}

const WHEN_HELP =
  '{"type":"daily","time":"07:30"} | {"type":"weekdays","time":"07:30"} | {"type":"days","days":["mon","thu"],"time":"07:30"} | {"type":"monthdays","days":[1,15],"time":"07:30"} | {"type":"once","at":"2026-12-24T09:00"} | {"type":"times","days":"weekdays","times":["09:45","12:15","14:45","17:15"]} (several fire times a day: "days" is "daily", "weekdays" or day names like ["mon","wed"]; 1 to 12 times, in order, at least 60 minutes apart; needs a Chronos that supports it)'

export const schedulesList: Tool = {
  name: 'schedules_list',
  description:
    'List the scheduled jobs on this Mac as a plain-text table (id, name, when, next run, today, last result, runner, permissions, state), then any scheduler health issues. Pass `id` for one job in full: its prompt, standing rules and last 10 runs. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'One job id, for its full prompt and recent runs.' } },
  },
  async handler(ctx, args) {
    try {
      const r = await service(ctx).toolList(str(args.id))
      return r.ok ? ok(r.text) : fail(r.text)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const schedulePropose: Tool = {
  name: 'schedule_propose',
  liveOnly: true,
  description:
    "Propose creating, changing or deleting a scheduled job. This NEVER writes anything: it validates the proposal and shows the owner a card; the bridge saves it only after they approve. Never create cron, launchd or in-session timer jobs yourself. Returns `card c_… pending, expires <ISO>`, or the scheduler's validation errors with field paths.",
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'update', 'delete'] },
      thread_id: { type: 'string', description: 'The thread the card goes to (usually the one the owner asked in).' },
      reason: { type: 'string', description: 'Why, in one line (up to 280 characters). Shown on the card.' },
      id: {
        type: 'string',
        description:
          'Job id (a-z, 0-9, hyphen). Slugged from the name on create when absent. Required for update and delete.',
      },
      name: { type: 'string', description: 'Up to 60 characters.' },
      description: { type: 'string' },
      when: { type: 'object', description: `One of ${WHEN_HELP}` },
      meta: {
        type: ['object', 'null'],
        description:
          'An opaque settings object kept with the job (up to 4 KiB of JSON). It is part of what the owner approves and the card shows all of it. On update, null clears it.',
      },
      prompt: { type: 'string', description: 'What the job does each time it fires (up to 16 KiB).' },
      runner: {
        type: 'string',
        enum: ['session', 'headless'],
        description: 'Default session (runs in the live session).',
      },
      permissions: {
        type: 'string',
        enum: ['full', 'restricted'],
        description: 'Default full. Restricted jobs are headless and read-only.',
      },
      allowed_tools: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      notify: { type: 'string', enum: ['failure', 'always', 'never'] },
      catchup_min: {
        type: 'number',
        description: 'Minutes after the time that the job may still start (15-1440, default 180).',
      },
      enabled: { type: 'boolean', description: 'Default true.' },
      result_thread_id: { type: 'string', description: 'The thread the job posts its result to.' },
      supersedes: { type: 'string', description: 'Card id this one replaces.' },
    },
    required: ['op', 'thread_id', 'reason'],
  },
  async handler(ctx, args) {
    try {
      needStr(args, 'op')
      const r = await service(ctx).toolPropose(args)
      return r.ok ? ok(r.text) : fail(r.text)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const scheduleRunStart: Tool = {
  name: 'schedule_run_start',
  liveOnly: true,
  description:
    'Claim a fired scheduled job for the run id in its `kind=schedule_run` notification. Answers GO, or `SKIP: <reason>` (already done, running elsewhere, window passed, on hold, paused). On SKIP, stop.',
  inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
  async handler(ctx, args) {
    try {
      const r = await service(ctx).toolRunStart(needStr(args, 'run_id', 64))
      return r.ok ? ok(r.text) : fail(r.text)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const scheduleRunDone: Tool = {
  name: 'schedule_run_done',
  liveOnly: true,
  description:
    'Finish a scheduled run: `ok` and a one-line `summary` (up to 280 characters), plus an optional plain-text `report`. Answers `recorded`, `not yours: …` or `late: noted on the closed run`.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      ok: { type: 'boolean' },
      summary: { type: 'string', description: 'Up to 280 characters.' },
      report: { type: 'string', description: 'Up to 64 KiB, plain text.' },
    },
    required: ['run_id', 'ok', 'summary'],
  },
  async handler(ctx, args) {
    try {
      const runId = needStr(args, 'run_id', 64)
      if (typeof args.ok !== 'boolean') throw new ToolError('ok must be true or false')
      const summary = needStr(args, 'summary', 280)
      const report = str(args.report)
      if (report !== undefined && Buffer.byteLength(report) > 64 * 1024) throw new ToolError('report is over 64 KiB')
      const r = await service(ctx).toolRunDone({
        runId,
        ok: args.ok,
        summary,
        ...(report !== undefined ? { report } : {}),
      })
      return r.ok ? ok(r.text) : fail(r.text)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
