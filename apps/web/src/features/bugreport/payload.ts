// The report, built in one place. The preview shows `JSON.stringify` of this same object, and `send` posts it, so the screen
// cannot say one thing and the relay get another. The owner's own words are cleaned once more here (keys, tokens, home folder);
// the Mac's log and error lines arrive already cleaned by its `redact`.
import { BUG_REPORT_LIMITS, type BugReportBodyT, PROBLEM_LIMITS, redact, scrubOwnerText } from '@talos-app/protocol'
import type { BugContext } from '../../lib/v2Client.ts'

export type ReportInputs = {
  wentWrong: string
  expected: string
  includeMessages: boolean
  /** The automatic parts the owner may leave out; a missing key means attached. */
  attach?: Partial<Record<'versions' | 'thread' | 'errors' | 'logs', boolean>>
  versions: { app: string; relay: string }
  /** What the Mac said; null when it did not answer (away, or an older Mac). */
  context: BugContext | null
  /** The Mac did not answer (away, failed or too slow): the report says so in place of the logs. */
  macMissing?: boolean
  threadId: string | null
  screen: string
  /** Which app is sending: the shell's own marker. */
  client: 'browser' | 'mac_app' | 'iphone_app'
  /** The screens visited by name, newest last. */
  routes: string[]
  /** Newest last. Only the last 5 are ever used, and only when `includeMessages`. */
  messages: ReadonlyArray<{ author: string; text: string }>
}

/** What the report's log field says when there is no log because the Mac did not answer. */
export const NO_MAC_NOTE = 'Sent without Mac details.'

const HOME = /(?:\/Users|\/home)\/[^/\s]+/g

/** The owner's words with secrets and the home folder taken out: `talos-app report`'s redaction, then the owner-text scrub. */
export function cleanWords(input: string, max: number): string {
  return scrubOwnerText(redact(input.replace(HOME, '~')), max).trim()
}

/** The screen name from a route path: `/t/trip` -> `thread`, `/settings/help` -> `settings/help`. Ids never appear. */
export function screenOf(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return 'home'
  if (parts[0] === 't') return 'thread'
  if (parts[0] === 'card') return 'card'
  return parts.slice(0, 2).join('/').slice(0, 80)
}

export function buildReport(i: ReportInputs): BugReportBodyT {
  const on = (k: 'versions' | 'thread' | 'errors' | 'logs') => i.attach?.[k] !== false
  const expected = cleanWords(i.expected, BUG_REPORT_LIMITS.expectedChars)
  const unknown = 'unknown'
  const messages = i.includeMessages
    ? i.messages.slice(-BUG_REPORT_LIMITS.messages).flatMap((m) => {
        const text = cleanWords(m.text, BUG_REPORT_LIMITS.messageChars)
        return text ? [{ role: m.author === 'owner' ? ('you' as const) : ('agent' as const), text }] : []
      })
    : undefined
  return {
    what_went_wrong: cleanWords(i.wentWrong, BUG_REPORT_LIMITS.whatChars),
    ...(expected ? { expected } : {}),
    versions: on('versions')
      ? {
          app: i.versions.app.slice(0, 40) || unknown,
          bridge: i.context?.bridgeVersion || unknown,
          relay: i.versions.relay.slice(0, 40) || unknown,
          claude_code: i.context?.claudeCode || unknown,
        }
      : { app: unknown, bridge: unknown, relay: unknown, claude_code: unknown },
    ...(on('thread') && i.threadId ? { thread_id: i.threadId.slice(0, 80) } : {}),
    ...(on('thread') ? { screen: i.screen.slice(0, 80) } : {}),
    // the app is not private, so no toggle; the screens visited go with the thread part, like the screen
    client: i.client,
    ...(on('thread')
      ? { routes: i.routes.slice(-PROBLEM_LIMITS.routes).map((r) => r.slice(0, PROBLEM_LIMITS.routeChars)) }
      : {}),
    // the Mac cleaned these with the same redaction; once more here, so what leaves the app is held to one rule
    // (cut back to the limit: redaction can lengthen a text, and a field over it would get the whole report refused)
    recent_errors: on('errors')
      ? (i.context?.recentErrors ?? []).map((e) => redact(e).slice(0, BUG_REPORT_LIMITS.errorChars))
      : [],
    logs: i.macMissing
      ? NO_MAC_NOTE
      : on('logs')
        ? redact(i.context?.logs ?? '').slice(0, BUG_REPORT_LIMITS.logChars)
        : '',
    ...(messages ? { messages } : {}),
  }
}

/** The exact text of what will be sent (the report as JSON), plus one line for the picture. */
export function previewText(report: BugReportBodyT, picture: { type: string; bytes: number } | null): string {
  const pic = picture
    ? `Screenshot: ${picture.type}, ${Math.max(1, Math.round(picture.bytes / 1024))} KB`
    : 'Screenshot: none'
  return `${JSON.stringify(report, null, 2)}\n\n${pic}`
}
