// `talos-app schedules`, `schedules adopt` and `schedules notify` (docs/SCHEDULES.md S1.4, S3.7, S7.4). These run at the
// Mac, in the foreground. They never open the bridge socket (SPEC 4.10) and write nothing in $TALOS_APP_HOME.
import { safeLine } from '@talos-app/protocol'
import { Bridge } from '../bridge.ts'
import type { CliIO } from '../cli.ts'
import type { BridgeEnv } from '../config.ts'
import { testRequiredProblem } from '../heartbeat/tested.ts'
import { ClosedAdapter } from './closed-adapter.ts'
import { discover } from './discovery.ts'
import { listText } from './format.ts'

class SchedulesCliError extends Error {}

const discovery = (env: BridgeEnv) =>
  discover(env, {
    meta: { threadOf: () => null, offerAgeS: () => null },
    now: () => Date.now(),
    clockIso: () => new Date().toISOString(),
  })

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal controls is the point
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Everything this command prints is scheduler text that a local process could have written: no escape sequence gets through. */
const inert = (io: CliIO): CliIO => ({
  ...io,
  out: (l) => io.out(l.replace(TERMINAL_CONTROLS, ' ')),
  err: (l) => io.err(l.replace(TERMINAL_CONTROLS, ' ')),
})

export async function cmdSchedules(env: BridgeEnv, args: string[], rawIo: CliIO): Promise<void> {
  const io = inert(rawIo)
  const [sub, ...rest] = args
  if (sub === undefined || sub === 'list') return list(env, io)
  if (sub === 'adopt') return adopt(env, io)
  if (sub === 'notify') return notify(env, rest, io)
  throw new SchedulesCliError('usage: talos-app schedules [adopt | notify <message>]')
}

async function list(env: BridgeEnv, io: CliIO) {
  const d = await discovery(env)
  if (d.adapter instanceof ClosedAdapter) {
    io.out(d.adapter.agentText())
    return
  }
  io.out(listText(await d.adapter.snapshot()))
}

const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a)

/**
 * S3.7. List every job, approve each unapproved one (y/N) as it is on disk, offer to turn `both` jobs into session-only
 * jobs, and only then switch Chronos to session_runner talos + approval_required true. Safe to run again.
 */
async function adopt(env: BridgeEnv, io: CliIO) {
  const d = await discovery(env)
  const chronos = d.chronos
  if (!chronos) {
    io.out(d.adapter instanceof ClosedAdapter ? d.adapter.agentText() : 'No usable scheduler found.')
    throw new SchedulesCliError('nothing to adopt')
  }
  let snap = await chronos.snapshot()
  io.out(`Chronos ${snap.health.adapter.version ?? ''} on ${snap.health.host_label}: ${snap.schedules.length} job(s).`)
  for (const j of snap.schedules) {
    const x = await chronos.detail(j.id, null)
    // the prompt may have been rewritten by a local process: no escape sequence may reach this terminal
    const head = (x?.detail.prompt ?? j.prompt_preview)
      .split('\n')
      .slice(0, 6)
      .map((l) => safeLine(l))
      .join('\n    ')
    io.out(
      `\n${j.id} | ${JSON.stringify(j.name)}\n  runs: ${j.runner} | permissions: ${j.permissions} | ${safeLine(j.when_text)} | ${j.today === 'held' ? 'ON HOLD' : j.changed_outside ? 'not approved yet' : 'approved'}\n    ${head}`,
    )
  }

  // 2. Approve what is on disk, one by one. N leaves the job held (it stays visible in the app and never runs).
  let approved = 0
  let left = 0
  for (const j of snap.schedules) {
    if (!j.changed_outside) continue
    const a = await io.prompt(`Approve ${JSON.stringify(j.name)} as it is on disk now? [y/N] `)
    if (!yes(a)) {
      left++
      continue
    }
    // An enabled heartbeat is approved only with a passing test of these exact settings (the same rule as the app's adopt card).
    const x = await chronos.detail(j.id, null)
    const needTest = x
      ? testRequiredProblem(
          env.home,
          Date.now(),
          { op: 'adopt', id: j.id, content_hash: j.content_hash },
          { schedule: x.detail.schedule, prompt: x.detail.prompt, guard: x.detail.guard },
        )
      : null
    if (needTest) {
      io.err(`not approving ${j.id}: ${needTest} It stays on hold until you test it in the app, then approve it there.`)
      left++
      continue
    }
    const v = await chronos.validate({ op: 'adopt', id: j.id, content_hash: j.content_hash })
    if (!v.ok) {
      io.err(`could not approve ${j.id}: ${v.errors.map((e) => e.message).join('; ')}`)
      left++
      continue
    }
    const r = await chronos.apply(v.normalized, v.expectedEtag)
    if (!r.ok) {
      io.err(`could not approve ${j.id}: ${r.message}`)
      left++
    } else approved++
  }

  // 3. `both` jobs: session first, then a background run after a grace. Talos won't race itself.
  snap = await chronos.snapshot()
  let blocking = 0
  for (const j of snap.schedules) {
    if (j.runner !== 'both') continue
    const a = await io.prompt(`Run ${JSON.stringify(j.name)} in your live session only (no background backup)? [y/N] `)
    if (!yes(a)) {
      blocking++
      continue
    }
    const v = await chronos.validate({ op: 'update', id: j.id, base_etag: j.etag, set: { runner: 'session' } })
    const r = v.ok ? await chronos.apply(v.normalized, v.expectedEtag) : null
    if (!v.ok || !r?.ok) {
      io.err(
        `could not convert ${j.id}: ${v.ok ? (r && !r.ok ? r.message : '') : v.errors.map((e) => e.message).join('; ')}`,
      )
      blocking++
    }
  }

  // 4. Switch, in one call. Chronos refuses while a `both` job exists (fail closed).
  if (blocking === 0) {
    const sw = await chronos.configSet({ sessionRunner: 'talos', approvalRequired: true })
    if (sw.ok) {
      io.out(
        `\nDone. Talos now runs session jobs${left ? `; ${left} job(s) are on hold until you approve them in the app` : ''}. ${approved} approved.`,
      )
    } else {
      io.out(
        `\nChronos refused the switch: ${sw.message}${sw.blocking.length ? ` (${sw.blocking.join(', ')})` : ''}. Talos stays read-only.`,
      )
      throw new SchedulesCliError('the switch was refused')
    }
  } else {
    io.out(
      `\n${blocking} job(s) still have a background backup, so Talos stays read-only (session_runner_conflict). Run this again to convert them.`,
    )
    throw new SchedulesCliError('jobs with a background backup remain')
  }
  // 5. Hand-off
  io.out('Restart your Claude session now: timers the Chronos hook armed earlier live until the session ends.')
}

/** Chronos's `notify` command (S7.4): posts to the thread of $CHRONOS_JOB over signed HTTP, with no session. */
async function notify(env: BridgeEnv, args: string[], io: CliIO) {
  const text = args.join(' ').trim()
  if (!text) throw new SchedulesCliError('usage: talos-app schedules notify <message>')
  const bridge = await Bridge.create({ env, headless: true })
  try {
    const thread = bridge.ctx.schedules?.headlessJobThread() ?? bridge.ctx.config.config.default_thread
    const res = await bridge.callTool('reply', { thread_id: thread, text })
    io.out(res.content[0]?.text ?? '')
    if (res.isError) throw new SchedulesCliError('notify failed')
  } finally {
    await bridge.stop()
  }
}
