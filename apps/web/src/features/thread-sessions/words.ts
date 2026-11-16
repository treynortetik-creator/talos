// A thread session's status in plain words, from `workers.status` (what the supervisor wrote in workers.json): waiting on the
// owner and for what, working since when, why it stopped. One table, so the thread list row, the header sheet and the tests
// all read the same words. `short` fits one line of a phone row; `long` is the sheet's sentence; `step` is what to do at the Mac.
import type { Host, WorkerStatusItemT } from '@talos-app/protocol'
import { PC_ANSWER, placeWords } from '../../lib/hostWords.ts'
import { workerErrorText } from './store.ts'

export type SessionTone = 'needs' | 'working' | 'long' | 'idle' | 'parked' | 'failed' | 'offline' | 'none'

export type SessionWords = {
  tone: SessionTone
  short: string
  long: string
  step?: string
  /** A permission request for this thread waits as a card: the row and sheet offer to open it. */
  openCard?: true
}

export type SessionWordsInput = {
  item: WorkerStatusItemT | undefined
  now: number
  /** False when the Mac's supervisor has not been heard from: what we have is the last known, never live. */
  supervisorOnline: boolean
  /** `workers.status.at`: when that last known picture was taken. */
  statusAt?: string | undefined
  /** The usage governor's resume time (`workers.status.governor.resets_at`). */
  governorResetsAt?: string | undefined
  /** The plan window's reset for this session's scope (`session.state.rate_limits`), used as "about" when the screen's is missing. */
  aboutResetsAt?: string | undefined
  /** A permission card for this thread is pending. */
  pendingCard?: boolean
  /** This page is not connected (the phone, not the Mac, is the one out of touch). */
  pageOffline?: boolean
  /** For tests: the zone the times are read in. The device's own otherwise. */
  timeZone?: string
  /** The agent's computer (lib/hostWords.ts): the Mac's words on a Mac (the default), that host's own elsewhere. */
  host?: Host | null
}

/** A turn longer than this reads amber: still working, but long enough that the owner should know. */
export const LONG_TURN_MS = 2 * 60 * 60_000

const USAGE_LIMIT = 'usage limit'
const RUNNING = new Set<WorkerStatusItemT['state']>(['starting', 'live', 'busy'])

/** "9:40 AM" today, "Nov 12, 9:40 AM" another day; empty for a time that does not parse. */
export function clockWords(iso: string | undefined, now: number, timeZone?: string): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return ''
  const zone = timeZone ? { timeZone } : {}
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...zone })
  const year = (ms: number) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', ...zone })
  const clock = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...zone })
  if (year(at) !== year(now)) return `${day(at)} ${year(at)}, ${clock}`
  return day(at) === day(now) ? clock : `${day(at)}, ${clock}`
}

/** "25 min", "3 h 10 min"; at least a minute. */
export function durationWords(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

const SHORT_ERROR: Record<string, string> = {
  needs_mac: 'needs the Mac',
  resume_missing: "can't resume",
  crash_loop: 'kept crashing',
  start_failed: "didn't start",
  folder_claimed: 'folder in use',
  mode_escalation_denied: 'too much access',
  unknown: 'see the Mac',
}

/** "Waiting since 9:12: " or, with no readable time, "Waiting: ". */
const sinceWords = (clock: string) => (clock ? `Waiting since ${clock}: ` : 'Waiting: ')

function restartsLine(n: number | undefined): string {
  if (!n) return ''
  return n === 1
    ? ' It restarted after a crash once in the last hour.'
    : ` It restarted after a crash ${n} times in the last hour.`
}

function live(i: SessionWordsInput, item: WorkerStatusItemT): SessionWords {
  const at = (iso: string | undefined) => clockWords(iso, i.now, i.timeZone)
  const n = item.needs_you
  if (n && n.kind === USAGE_LIMIT) {
    const exact = n.resets_at
    const reset = exact ?? i.aboutResetsAt
    const when = reset ? `${exact ? '' : 'about '}${at(reset)}` : ''
    return {
      tone: 'needs',
      short: when ? `Usage limit · resets ${when}` : 'Usage limit reached',
      long: `${sinceWords(at(n.since))}it reached the usage limit${when ? `, which resets ${when}` : ''}.`,
      ...(n.step ? { step: n.step } : {}),
    }
  }
  if (n && i.host === 'windows') {
    // the PC has no window to answer it in yet (Titan): say so, never "at your computer"
    return { tone: 'needs', short: `Needs you · ${n.kind}`, long: PC_ANSWER, ...(n.step ? { step: n.step } : {}) }
  }
  if (n) {
    return {
      tone: 'needs',
      short: `Needs you at the Mac · ${n.kind}`,
      long: `${at(n.since) ? `Waiting since ${at(n.since)} on` : 'Waiting on'} “${n.kind}” in its window at the Mac.`,
      ...(n.step ? { step: n.step } : {}),
    }
  }
  if (item.state === 'failed') {
    const code = item.error ?? 'unknown'
    return {
      tone: 'failed',
      short: `Failed · ${SHORT_ERROR[code] ?? SHORT_ERROR.unknown}`,
      long: `${workerErrorText(code, i.host ?? null) ?? workerErrorText('unknown', i.host ?? null)}${item.error_at ? ` (${at(item.error_at)})` : ''}.`,
    }
  }
  if (i.pendingCard) {
    return {
      tone: 'needs',
      short: 'Needs you · a permission request',
      long: 'It asked for permission to do something and waits for your answer.',
      openCard: true,
    }
  }
  if (RUNNING.has(item.state)) {
    const crashes = restartsLine(item.restarts_1h)
    if (item.turn_started_at) {
      const ran = i.now - Date.parse(item.turn_started_at)
      const since = at(item.turn_started_at)
      if (Number.isFinite(ran) && ran >= LONG_TURN_MS)
        return {
          tone: 'long',
          short: `Working for ${durationWords(ran)} in one turn`,
          long: `It has been working on one message since ${since} (${durationWords(ran)}). Long, but it has not stopped.${crashes}`,
        }
      if (!since) return { tone: 'working', short: 'Working…', long: `Working on your message.${crashes}` }
      return {
        tone: 'working',
        short: `Working · since ${since}${Number.isFinite(ran) ? ` (${durationWords(ran)})` : ''}`,
        long: `Working on your message since ${since}.${crashes}`,
      }
    }
    if (item.state === 'starting') return { tone: 'working', short: 'Starting…', long: `Starting up.${crashes}` }
    return at(item.last_turn_at)
      ? {
          tone: 'idle',
          short: `Idle · last reply ${at(item.last_turn_at)}`,
          long: `Ready. Its last reply was at ${at(item.last_turn_at)}.${crashes}`,
        }
      : { tone: 'idle', short: 'Ready', long: `Ready for a message.${crashes}` }
  }
  if (item.state === 'parking') return { tone: 'parked', short: 'Parking…', long: 'Saving its place and stopping.' }
  if (item.state === 'stopping') return { tone: 'parked', short: 'Stopping…', long: 'Stopping.' }
  if (item.state === 'off') return { tone: 'none', short: 'Not started', long: 'Starts with the next message.' }
  if (item.state === 'unknown')
    return { tone: 'parked', short: 'Status unknown', long: 'The Mac reported a state this version does not know.' }
  // parked: why it stopped, in words
  const wakes = ' It wakes with the next message.'
  const parked = at(item.parked_at)
  switch (item.stopped_why) {
    case 'idle':
      return {
        tone: 'parked',
        short: parked ? `Parked · idle since ${parked}` : 'Parked · idle',
        long: `Parked${parked ? ` at ${parked}` : ''} after a quiet spell.${wakes}`,
      }
    case 'owner':
      return {
        tone: 'parked',
        short: 'Stopped by you',
        long: `You stopped it${parked ? ` at ${parked}` : ''}.${wakes}`,
      }
    case 'cap':
      return {
        tone: 'parked',
        short: 'Parked · made room for another thread',
        long: `Parked${parked ? ` at ${parked}` : ''} to make room: only so many sessions run at once.${wakes}`,
      }
    case 'governor': {
      // a resume time already past says nothing true
      const r = i.governorResetsAt ? Date.parse(i.governorResetsAt) : Number.NaN
      const resumes = Number.isFinite(r) && r > i.now ? at(i.governorResetsAt) : ''
      return {
        tone: 'parked',
        short: `Paused · usage cap${resumes ? `, resumes ${resumes}` : ''}`,
        long: `Paused to stay inside the plan's usage${resumes ? ` until ${resumes}` : ''}.${wakes}`,
      }
    }
    case 'crash': {
      const n2 = item.restarts_1h
      return {
        tone: 'failed',
        short: n2 ? `Crashed · restarted ${n2}× in the last hour` : 'Crashed',
        long: `It crashed${parked ? ` at ${parked}` : ''}.${restartsLine(n2)}${wakes}`,
      }
    }
    case 'interrupted':
      return {
        tone: 'parked',
        short: 'Stopped mid-turn',
        long: `The Mac or the app went away in the middle of a turn.${wakes}`,
      }
    case 'restart':
      return { tone: 'working', short: 'Restarting…', long: 'Restarting with the same conversation.' }
    default:
      return { tone: 'parked', short: parked ? `Parked · ${parked}` : 'Parked', long: `Parked.${wakes}` }
  }
}

export function sessionWords(i: SessionWordsInput): SessionWords {
  // the Mac's words, then only their place words for another host (a failed worker's reason is already that host's own)
  const host = i.host === undefined ? 'mac' : i.host
  const w = macSessionWords({ ...i, host })
  return host === 'mac' ? w : { ...w, short: placeWords(w.short, host), long: placeWords(w.long, host) }
}

function macSessionWords(i: SessionWordsInput): SessionWords {
  const item = i.item
  if (!item) return { tone: 'none', short: 'No session yet', long: 'Starts with the next message.' }
  const w = live(i, item)
  if (i.supervisorOnline && !i.pageOffline) return w
  // the Mac is not reporting, or this page is not connected: the last known picture, said as such, never as live
  const asOf = clockWords(i.statusAt, i.now, i.timeZone)
  const who = i.pageOffline ? 'Not connected' : 'Mac offline'
  return {
    tone: 'offline',
    short: asOf ? `${who} · last heard ${asOf}` : who,
    long: `${i.pageOffline ? "This device isn't connected" : "The Mac isn't reporting"}${asOf ? ` (last heard ${asOf})` : ''}. Last known: ${w.long}`,
    ...(w.step ? { step: w.step } : {}),
    ...(w.openCard ? { openCard: true as const } : {}),
  }
}
