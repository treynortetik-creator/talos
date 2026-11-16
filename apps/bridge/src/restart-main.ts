// `restart_main` (docs/bridge.md "restart_main"): Main, or a thread's lead, asks the Mac app to restart Main. The bridge
// writes the same agent-request.json the phone's Restart agent writes (agent-recover.ts), with no owner's proof in it; the
// session's own Write, Edit and shell commands that name the file are denied it (guards/rules.ts), which stops the direct
// routes, not a determined process: the Mac app checks again when it reads the request. Before writing, the bridge reads the Mac app's
// main-restart-check.json: only the app can tell whether Main would come back, and anything but a fresh "yes" is no.
//
// Every caller writes from its OWN bridge: a lead's bridge shares $TALOS_APP_HOME and history.sqlite with Main's, so its
// request works whether or not Main's bridge (the hub) is up. The limits live in history.sqlite (`main_restarts`, thread_session's ledger, under MAIN_SESSION_KEY), checked
// and recorded in one IMMEDIATE transaction around the file write, so two bridges asking at once get one winner and a
// failed write counts nothing. `main_restart_notices` keeps who asked and why, as a record only: the bridge posts nothing.
// The Mac app tells the owner itself, through its own route (`talos-app post`), when it acts on the request and for every
// outcome that is not "came back": Main's bridge dies with the restart, so a line from it would often never go out.
import type { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_REQUEST_MIN_GAP_MS,
  MAIN_RESTART_CHECK_FILE,
  MAIN_RESTART_CHECK_MAX_BYTES,
  MAIN_RESTART_CHECK_MAX_FUTURE_MS,
  MAIN_RESTART_CHECK_STALE_MS,
  MAIN_RESTART_WHY_MAX,
  MainRestartCheckFile,
  type MainRestartLastT,
  MainRestartReason,
  type MainRestartReasonT,
  needsYouStep,
  newUlid,
  threadSessionMode,
} from '@talos-app/protocol'
import { writeAgentRequest } from './agent-recover.ts'
import type { BridgeContext } from './context.ts'
import { readRegularFile } from './safe-open.ts'
import { cleanHandoffText } from './worker/handoff.ts'
import { MAIN_RESTARTS_PER_HOUR, MAIN_SESSION_KEY, MainRestartLedger } from './worker/main-restarts.ts'

const HOUR_MS = 3_600_000
/** Rows older than this are never read again (the hourly count and the gap look back an hour at most). */
const KEEP_MS = 24 * HOUR_MS

/** The words' shape: every sentence the bridge says about restarting Main. */
export type RestartWords = {
  reasons: Record<MainRestartReasonT, string>
  ownerCanRestart: string
  noFile: string
  unreadable: string
  future: string
  stale: (ageMs: number) => string
  noReason: string
  yesChecked: string
  needsYou: (kind: string, since: string) => string
  last: (l: MainRestartLastT) => string
  gapRefused: (wait: string) => string
  notWritten: string
}

/**
 * The Mac's words, byte for byte as they were before Linux had a supervisor (Fable R1-8: pinned sentence by sentence in
 * restart-main.test.ts). Only `restart_limit` is new (the Mac never writes it).
 */
const MAC_REASONS: Record<MainRestartReasonT, string> = {
  launch_changed:
    'The way Main starts has changed since the owner last confirmed it at the Mac, so its startup warning would not be answered and Main would wait at it.',
  claude_path_changed:
    'The claude program Main would start is not the one the owner confirmed at the Mac, so Main would wait at its startup warning.',
  auto_confirm_off:
    'Answering the startup warning automatically is turned off on the Mac, so Main would wait at it for the owner.',
  budget_spent: 'The Mac has used up its automatic restarts for now, so Main would wait at its startup warning.',
  someone_typing: 'Someone is typing in Main’s window on the Mac right now.',
  takeover_held: 'Something else is holding Main’s window on the Mac (a takeover).',
  owner_stopped: 'The owner stopped Main at the Mac, and that stands until they start it again.',
  too_soon: 'Main was restarted less than 2 minutes ago; the Mac would ignore another request this soon.',
  session_id_invalid:
    'The saved conversation id in the Mac app’s desktop.json is not a session id, so Main would not start again; the owner must start a new conversation from the Talos menu.',
  restart_limit:
    'Main was already restarted on request 3 times in the last hour; the limit stops a session restarting it over and over.',
  unknown: 'The Talos app gave a reason this bridge does not know (it is newer than this bridge).',
}
const MAC: RestartWords = {
  reasons: MAC_REASONS,
  ownerCanRestart: 'The owner can still restart Main from the phone (Restart agent) or from the Talos menu on the Mac.',
  noFile:
    'This Talos app does not report whether Main would come back yet (it may be an older app, or not running), so the answer is no.',
  unreadable:
    "The Talos app's restart check could not be read (damaged, or written in a format this bridge does not know), so the answer is no.",
  future:
    "The Talos app's restart check is dated in the future, so a clock is wrong and it cannot be trusted: the answer is no.",
  stale: (ageMs) =>
    `The Talos app is not running (its restart check was last written ${Math.round(ageMs / 1000)} seconds ago), so nothing on the Mac would act on a restart: the answer is no.`,
  noReason: 'The Talos app says Main would not come back, and gave no reason.',
  yesChecked:
    'The Mac app checked that the launch and the claude program match the ones the owner confirmed, answering the startup warning automatically is on with restarts left, nobody is typing in Main’s window, and nothing holds or stopped Main.',
  needsYou: (kind, since) => {
    // a screen that must never read as "answer it" (computer use, the usage limit): the one step there is
    const step = needsYouStep(kind)
    return step
      ? `Main is waiting at the Mac on ${kind} (since ${since}); to go on, the owner has to ${step}.`
      : `Main is waiting at the Mac on ${kind} (since ${since}); the owner has to answer it there.`
  },
  last: (l) => {
    const head = `The last restart the Mac read (request ${l.control_id}, at ${l.at})`
    if (l.outcome === 'came_back') return `${head} came back: Main started and was ready.`
    if (l.outcome === 'stalled')
      return `${head} stalled: Main is waiting at the Mac${l.detail ? ` (${l.detail})` : ''} for the owner.`
    const why = MainRestartReason.safeParse(l.detail)
    const reason = l.detail && why.success && why.data !== 'unknown' ? ` ${MAC_REASONS[why.data]}` : ''
    return `${head} was refused by the Mac; Main was not restarted.${reason}`
  },
  gapRefused: (wait) =>
    `Not restarted: Main was asked to restart less than 2 minutes ago, and the Mac ignores a request this soon. Try again in ${wait}. Nothing was written.`,
  notWritten: 'Not restarted: the request for the Mac could not be written. Nothing was counted.',
}

/** The same sentences for a Linux supervisor: nothing in them a Linux machine does not have (no Mac, no app, no menu). */
const LINUX_REASONS: Record<MainRestartReasonT, string> = {
  launch_changed:
    'The way Main starts is not the one approved on this computer (root’s launch approval), so its startup warning would not be answered and Main would wait at it.',
  claude_path_changed: 'The claude program Main would start cannot be found on this computer, so Main would not start.',
  auto_confirm_off:
    'Answering the startup warning automatically is turned off on this computer, so it would need the owner at the keyboard after a restart.',
  budget_spent: 'This computer has used up its automatic restarts for now, so Main would wait at its startup warning.',
  someone_typing: 'Someone is attached to Main’s window on this computer right now.',
  takeover_held: 'Something else is holding Main’s window on this computer (a takeover).',
  owner_stopped: 'The owner stopped Main on this computer, and that stands until they start it again.',
  too_soon: 'Main was restarted less than 2 minutes ago; this computer would ignore another request this soon.',
  session_id_invalid:
    'The saved conversation id is not a session id, so Main would not start again; the owner must start a new conversation on this computer.',
  restart_limit:
    'Main was already restarted on request 3 times in the last hour; the limit stops a session restarting it over and over.',
  unknown:
    'The Talos supervisor on this computer gave a reason this bridge does not know (it is newer than this bridge).',
}
const SUP = 'The Talos supervisor on this computer'
const LINUX: RestartWords = {
  reasons: LINUX_REASONS,
  ownerCanRestart: 'The owner can still restart Main from the phone (Restart agent) or on this computer.',
  noFile: `${SUP} does not report whether Main would come back yet (it may be older, or not running), so the answer is no.`,
  unreadable: `${SUP}’s restart check could not be read (damaged, or written in a format this bridge does not know), so the answer is no.`,
  future: `${SUP}’s restart check is dated in the future, so a clock is wrong and it cannot be trusted: the answer is no.`,
  stale: (ageMs) =>
    `${SUP} is not running (its restart check was last written ${Math.round(ageMs / 1000)} seconds ago), so nothing on this computer would act on a restart: the answer is no.`,
  noReason: `${SUP} says Main would not come back, and gave no reason.`,
  yesChecked:
    'The supervisor on this computer checked that the launch is the one root approved and its claude program is there, answering the startup warning automatically is on, restarts are left this hour, nobody is attached to Main’s window, and nothing holds or stopped Main.',
  needsYou: (kind, since) => {
    // the sentence names the place already: the step's own is "there" (the Mac's sentences keep theirs, byte for byte)
    const step = needsYouStep(kind, 'there')
    return step
      ? `Main is waiting at this computer on ${kind} (since ${since}); to go on, the owner has to ${step}.`
      : `Main is waiting at this computer on ${kind} (since ${since}); the owner has to answer it there.`
  },
  last: (l) => {
    const head = `The last restart this computer read (request ${l.control_id}, at ${l.at})`
    if (l.outcome === 'came_back') return `${head} came back: Main started and was ready.`
    if (l.outcome === 'stalled')
      return `${head} stalled: Main is waiting at this computer${l.detail ? ` (${l.detail})` : ''} for the owner.`
    const why = MainRestartReason.safeParse(l.detail)
    const known = l.detail !== undefined && why.success && why.data !== 'unknown'
    // a refusal for a screen Main waits on names that screen (the Linux supervisor's detail), never as a reason
    const reason = known ? ` ${LINUX_REASONS[why.data as MainRestartReasonT]}` : l.detail ? ` (${l.detail})` : ''
    return `${head} was refused by this computer; Main was not restarted.${reason}`
  },
  gapRefused: (wait) =>
    `Not restarted: Main was asked to restart less than 2 minutes ago, and this computer ignores a request this soon. Try again in ${wait}. Nothing was written.`,
  notWritten: 'Not restarted: the request could not be written. Nothing was counted.',
}

/** Every sentence about restarting Main, in the platform's words: the Mac's on a Mac, this computer's elsewhere. */
export const restartWords = (onMac: boolean): RestartWords => (onMac ? MAC : LINUX)

const WORDS = restartWords(process.platform === 'darwin')
export const OWNER_CAN_RESTART = WORDS.ownerCanRestart
/** One sentence per reason, in the owner's words, never the enum name. */
export const REASON_SENTENCES = WORDS.reasons
export const NO_FILE_SENTENCE = WORDS.noFile
export const UNREADABLE_SENTENCE = WORDS.unreadable
export const FUTURE_SENTENCE = WORDS.future
export const staleSentence = WORDS.stale
export const NO_REASON_SENTENCE = WORDS.noReason
export const YES_CHECKED_SENTENCE = WORDS.yesChecked
export const needsYouSentence = WORDS.needsYou

/** What came of the last request the supervisor read (`last` in its file), as a sentence; absent when it wrote none. */
export type RestartCheck = { yes: boolean; sentences: string[]; last?: string }
export const lastSentence = WORDS.last

/** Reads the Mac app's status file. Never writes, never throws: any doubt is a no with its own sentence. */
export function readRestartCheck(home: string, nowMs: number): RestartCheck {
  const no = (s: string): RestartCheck => ({ yes: false, sentences: [s] })
  const path = join(home, MAIN_RESTART_CHECK_FILE)
  const buf = readRegularFile(path, MAIN_RESTART_CHECK_MAX_BYTES)
  if (!buf) return no(somethingAt(path) ? UNREADABLE_SENTENCE : NO_FILE_SENTENCE)
  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf8'))
  } catch {
    return no(UNREADABLE_SENTENCE)
  }
  const p = MainRestartCheckFile.safeParse(raw)
  if (!p.success) return no(UNREADABLE_SENTENCE)
  const at = Date.parse(p.data.at)
  if (!Number.isFinite(at)) return no(UNREADABLE_SENTENCE)
  if (at - nowMs > MAIN_RESTART_CHECK_MAX_FUTURE_MS) return no(FUTURE_SENTENCE)
  // what came of the last request stays worth saying when the app has since stopped writing (a lead asking after Main's restart)
  const last = p.data.last ? { last: lastSentence(p.data.last) } : {}
  if (nowMs - at > MAIN_RESTART_CHECK_STALE_MS) return { ...no(staleSentence(nowMs - at)), ...last }
  const sentences = [...new Set(p.data.reasons.map((r) => REASON_SENTENCES[r]))]
  const ny = p.data.needs_you
  // the pane's own words for the dialog: one safe line before an agent reads them
  if (ny) sentences.unshift(needsYouSentence(cleanHandoffText(ny.kind) || 'a dialog', ny.since))
  if (p.data.will_return && !ny) return { yes: true, sentences, ...last }
  if (ny) return { yes: false, sentences, ...last }
  return { yes: false, sentences: sentences.length ? sentences : [NO_REASON_SENTENCE], ...last }
}

/** Something is at the path (a link, a pipe, a huge file) even though it could not be read as a small regular file. */
function somethingAt(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** The bridge's own reason, beside the Mac app's: Main has an approved card it has not reported on. */
export const OWED_CARD_SENTENCE =
  'Main is acting on something the owner approved; try again when it has reported the result.'
/**
 * An approval older than this no longer holds a restart back: Main may be stuck on it, which is when a restart is wanted
 * (and the owner can always restart from the phone). Fifteen minutes is the thread sessions' own owner-stop limit.
 */
export const OWED_CARD_HOLD_MS = 15 * 60_000

/**
 * Cards in Main's own threads (not a thread with its own session) that the owner approved (state `resolved`, action `primary`)
 * within OWED_CARD_HOLD_MS and that have no `card_result` yet: Main may be in the middle of the approved action. Read from
 * history.sqlite, which a lead's bridge opens too (the same file as the hub's), so the answer is the same from either.
 * Whether Main has READ the approval is not recorded for Main's own threads (only for thread sessions, as inbound claims), so
 * an approval not yet read counts too: the safe side.
 */
export function owedCards(ctx: BridgeContext, nowMs: number): number {
  const rows = ctx.store.db
    .query(
      `SELECT thread_id, resolved_at FROM cards WHERE state = 'resolved'
       AND json_extract(resolution_json, '$.action') = 'primary'`,
    )
    .all() as Array<{ thread_id: string; resolved_at: string | null }>
  ctx.config.refresh()
  return rows.filter((r) => {
    const at = r.resolved_at ? Date.parse(r.resolved_at) : Number.NaN
    if (!Number.isFinite(at) || nowMs - at > OWED_CARD_HOLD_MS) return false
    return threadSessionMode(ctx.config.config, r.thread_id) !== 'dedicated'
  }).length
}

/** The Mac app's answer, with the bridge's own reason added: an approval Main owes a result on is a no. */
export function withOwedCards(ctx: BridgeContext, c: RestartCheck, nowMs: number): RestartCheck {
  if (owedCards(ctx, nowMs) === 0) return c
  return { ...c, yes: false, sentences: [OWED_CARD_SENTENCE, ...c.sentences.filter((s) => s !== NO_REASON_SENTENCE)] }
}

/** How a check reads to the agent. */
export function checkText(c: RestartCheck): string {
  const last = c.last ? [c.last] : []
  if (c.yes)
    return ['Main would come back after a restart: yes.', YES_CHECKED_SENTENCE, ...c.sentences, ...last].join(' ')
  return ['Main would come back after a restart: no.', ...c.sentences, OWNER_CAN_RESTART, ...last].join(' ')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS main_restart_notices (
  control_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  caller TEXT NOT NULL,
  why TEXT NOT NULL,
  posted_at INTEGER
);
`

const ready = new WeakSet<Database>()
function table(db: Database): Database {
  if (!ready.has(db)) {
    db.exec(SCHEMA)
    ready.add(db)
  }
  return db
}

/** Who asked: '' for Main, else the lead's thread id. */
export type Caller = { thread?: string }

function waitWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 90) return `${s} seconds`
  return `${Math.ceil(s / 60)} minutes`
}

export type GoResult = { ok: boolean; text: string; controlId?: string }

/**
 * `go`: the check, then the limits, the request file and the record, all or nothing. `why` must already be cleaned.
 * A refusal at any step writes nothing and counts nothing.
 *
 * The limit, said plainly: this check is advice to the agent, not the gate. The status file can be seconds old
 * by the time the Mac app reads the request. The request carries no owner's proof, so the Mac app runs its own check again
 * when it reads it (the seal, Stop, the gap, someone typing) and restarts only on its own yes.
 */
export function goRestartMain(ctx: BridgeContext, caller: Caller, why: string): GoResult {
  const now = ctx.clock.now()
  const check = withOwedCards(ctx, readRestartCheck(ctx.paths.home, now), now)
  if (!check.yes) return { ok: false, text: `Not restarted: nothing was written. ${checkText(check)}` }
  const db = table(ctx.store.db)
  const controlId = newUlid()
  try {
    // thread_session's ledger, under Main's own key: three an hour and the Mac's gap, one winner across bridges. The notice
    // row and the request file are written inside its transaction, so a failed write counts nothing and leaves no notice.
    const r = new MainRestartLedger(db).attempt(
      MAIN_SESSION_KEY,
      now,
      why,
      () => {
        db.query('DELETE FROM main_restart_notices WHERE at < ?').run(now - KEEP_MS)
        db.query('INSERT INTO main_restart_notices (control_id, at, caller, why) VALUES (?, ?, ?, ?)').run(
          controlId,
          now,
          caller.thread ?? '',
          why,
        )
        writeAgentRequest(ctx.paths.home, controlId, now, { byThread: caller.thread, why })
        return { ok: true as const }
      },
      { minGapMs: AGENT_REQUEST_MIN_GAP_MS },
    )
    if (!r.refused) return { ok: true, text: '', controlId }
    const wait = waitWords(r.next_at - now)
    if (r.limit === 'gap')
      return {
        ok: false,
        text: WORDS.gapRefused(wait),
      }
    return {
      ok: false,
      text: `Not restarted: sessions have asked for ${MAIN_RESTARTS_PER_HOUR} restarts of Main in the last hour, the most allowed. The next is possible in ${wait}. Nothing was written. ${OWNER_CAN_RESTART}`,
    }
  } catch (e) {
    ctx.log.warn('restart_main: request not written', { error: (e as Error).message })
    return { ok: false, text: WORDS.notWritten }
  }
}

/** `why` as given: 1-80 characters, then cleaned as hand-off text is (one safe line). Returns the cleaned text or why not. */
export function cleanWhy(v: unknown): { ok: true; why: string } | { ok: false; text: string } {
  if (typeof v !== 'string' || !v.trim())
    return { ok: false, text: 'why is required: a short reason, 80 characters at most.' }
  if (v.trim().length > MAIN_RESTART_WHY_MAX)
    return { ok: false, text: `why is over ${MAIN_RESTART_WHY_MAX} characters. Shorten it and call again.` }
  const why = cleanHandoffText(v).slice(0, MAIN_RESTART_WHY_MAX).trim()
  if (!why) return { ok: false, text: 'why is required: a short reason, 80 characters at most.' }
  return { ok: true, why }
}
