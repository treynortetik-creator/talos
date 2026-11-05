// "Copy diagnostics" (audit D62): the versions plus the content-free Health status, as plain text a person can paste into a
// message. Built only from fields that cannot hold a message: no thread names, no message text, no keys, no device ids,
// no addresses. Times are the same relative words the rows show.
import type { HealthRow } from './rows.ts'

export type DiagnosticsInput = {
  app: string
  protocol: number
  where: 'Mac app' | 'iPhone app' | 'Browser'
  rows: HealthRow[]
  /** The status' own timestamp (ISO), or null when Health did not load. */
  at: string | null
  /** The Mac app's own version (from the shell's user agent), when this page runs inside it. */
  macApp?: string | null
  /** The iPhone app's `1.0 (build 12)`. Left out, it is read from the page's own user agent when `where` is 'iPhone app'. */
  iosApp?: string | null
  /** The user agent to read it from; the page's own by default. Tests pass one. */
  userAgent?: string
  /** The relay's version, when Health loaded. */
  relay?: string | null
  /** What macOS said about notifications; 'unknown' inside the Mac app means the shell never said (an older app). */
  macNotify?: 'unknown' | 'granted' | 'denied' | 'not_asked' | undefined
  /** The Health notes (no TTS command, no FTS5): plain status sentences. */
  notes?: string[]
}

/** The version in the Mac app's user-agent suffix (`TalosDesktop/1.2.3`), or null outside it. */
export function macAppVersion(userAgent: string | undefined): string | null {
  const m = /\sTalosDesktop\/([A-Za-z0-9.-]{1,40})(?:\s|$)/.exec(userAgent ?? '')
  return m?.[1] ?? null
}

/**
 * The iPhone app's version and build in its user-agent suffix (`TalosIOS/1.0+12`, audit D62), as `1.0 (build 12)`; null
 * outside the iPhone app or in a build that does not add the suffix.
 */
export function iosAppVersion(userAgent: string | undefined): string | null {
  const m = /\sTalosIOS\/([A-Za-z0-9.-]{1,20})\+([A-Za-z0-9.-]{1,20})(?:\s|$)/.exec(userAgent ?? '')
  return m ? `${m[1]} (build ${m[2]})` : null
}

const WORD = { ok: 'OK', warn: 'Needs a look', bad: 'Problem', idle: 'Not active' } as const

export function diagnosticsText(d: DiagnosticsInput): string {
  const lines = ['Talos diagnostics', `App: ${d.app}`, `Protocol: v${d.protocol}`, `Running in: ${d.where}`]
  if (d.macApp) lines.push(`Mac app: ${d.macApp}`)
  if (d.where === 'iPhone app') {
    const ios = d.iosApp !== undefined ? d.iosApp : iosAppVersion(d.userAgent ?? globalThis.navigator?.userAgent)
    lines.push(`iPhone app: ${ios ?? 'no version reported (an older build?)'}`)
  }
  if (d.relay) lines.push(`Relay version: ${d.relay}`)
  if (d.where === 'Mac app')
    lines.push(
      `Mac notifications: ${d.macNotify && d.macNotify !== 'unknown' ? d.macNotify : 'no report from the Mac app (an older app?)'}`,
    )
  if (d.at) lines.push(`Status at: ${d.at}`)
  if (d.rows.length === 0) lines.push('Status: not loaded')
  for (const r of d.rows) lines.push(`${r.label}: ${WORD[r.tone]} - ${r.detail}`)
  for (const n of d.notes ?? []) lines.push(`Note: ${n}`)
  return `${lines.join('\n')}\n`
}
