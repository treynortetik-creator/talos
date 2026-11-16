// Telling the owner (the contract's section 6) on Linux: a desktop notification for each supervisor event through notify-send
// (org.freedesktop.Notifications), one live notification per tag, and a line to the phone for what needs the owner when
// nobody may be at this computer. Quiet means no sound only: the banner always shows. A notification is a nudge: nothing is
// ever answered from one (no actions are offered).
// The banner text is ours: fixed phrases, the agent's cleaned name and the command that opens Main's screen. Text the agent
// or a log can shape (an MCP error) is never put in it (as on the Mac): `talos-app supervise status` shows that.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type MainNeedsYou,
  type MainStopReason,
  SUPERVISOR_NOTICES,
  type SupervisorNoticeT,
  ThreadId,
} from '@talos-app/protocol'
import { postSystemRow } from '../system-post.ts'
import { processEnv } from './launch-env.ts'
import { runTool } from './proc.ts'
import { type Blocker, blockerText } from './takeover.ts'
import { type LimitKind, usageLimitWords } from './usage-limit.ts'

/** What Main's supervisor reports, for the owner. */
export type MainEvent =
  /** `unattended`: Main restarted after a crash and now waits for the owner (nobody may be at this computer). */
  | { kind: 'needs_you'; needs: MainNeedsYou; unattended?: boolean }
  /** Main is running again after a crash; `resumed`: it resumed the conversation (not a new one). */
  | { kind: 'restarted_after_crash'; resumed: boolean }
  /** `gaveUp`: a restart after a crash could not launch at all, MAIN_RESTART.cannot_launch_tries times. */
  | { kind: 'stopped'; reason: MainStopReason; gaveUp?: boolean }
  /** Another session holds Telegram, the bridge or the channel: nothing was started. */
  | { kind: 'blocked'; blockers: Blocker[]; afterCrash?: boolean }

export type Notice = { notice: SupervisorNoticeT; title: string; body: string; phone: string | null }

const shq = (s: string) => (/^[A-Za-z0-9_./=:@-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`)

/** The command an owner types to see Main's screen, on the socket and config this supervisor uses. */
export const viewCommand = (socket: string, conf: string, session: string) =>
  `tmux -L ${shq(socket)} -f ${shq(conf)} -u attach-session -t ${shq(`=${session}`)}`

/** The agent's name as a banner may show it: no control characters or line breaks, at most 40 characters (the Mac's rule). */
export function cleanAgentName(name: string | null): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const n = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return n === '' ? 'Your agent' : n.length > 40 ? `${n.slice(0, 39)}…` : n
}

/** Notification bodies may be markup (body-markup): `&`, `<` and `>` are escaped so they read as text. */
export const escapeMarkup = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const DIALOG_NAMES: Record<string, string> = {
  trust: 'the folder-trust question',
  mcp_consent: 'the MCP server question',
  login: 'that it is signed out (run /login)',
  dev_channels: 'the development-channels warning',
  unknown: 'a question',
}

/**
 * The notice for an event, or null when there is nothing to tell (the owner's own stop). `agent` is the agent's name from
 * config.json (cleaned here), `clock` the local HH:MM, `view` the command that opens Main's screen.
 */
export function noticeFor(e: MainEvent, agent: string | null, clock: string, view: string): Notice | null {
  const who = cleanAgentName(agent)
  if (e.kind === 'restarted_after_crash')
    return {
      notice: 'restarted_after_crash',
      title: 'Talos',
      body: e.resumed ? `${who} restarted after a crash and resumed` : `${who} restarted after a crash`,
      phone: null,
    }
  if (e.kind === 'needs_you') {
    const n = e.needs
    const title = 'Talos needs you on this computer'
    // after an unattended restart the owner may be away: the phone is told too (the Mac's line), once per start
    const phone = e.unattended
      ? `${who} restarted after a crash and is waiting for you on the computer (${clock})`
      : null
    switch (n.kind) {
      case 'dialog':
        return {
          notice: 'needs_you',
          title,
          body: `${who} is showing ${DIALOG_NAMES[n.dialog] ?? 'a question'}. Answer it in: ${view}`,
          phone,
        }
      case 'confirm_cold_start':
        return {
          notice: 'needs_you',
          title,
          body: `${who} is waiting for you to press Enter on its start warning, in: ${view}`,
          phone,
        }
      case 'start_stalled':
        return {
          notice: 'needs_you',
          title,
          body: `${who} has not finished starting. See its screen: ${view}`,
          phone: null,
        }
      case 'stuck':
        return {
          notice: 'needs_you',
          title,
          body: `${who} is running but not answering. See its screen: ${view}`,
          phone: null,
        }
      case 'bridge_not_live':
        return {
          notice: 'needs_you',
          title,
          body: `${who} is running but its Talos bridge did not start. See why: talos-app supervise status`,
          phone: null,
        }
      case 'restart_not_confirmed':
        return { notice: 'needs_you', title, body: `${who}'s restart was not confirmed. See: ${view}`, phone: null }
      case 'usage_limit':
        // never "answer": some of the menu's options spend money, and Talos presses nothing there (usage-limit.ts)
        return {
          notice: 'needs_you',
          title,
          body: usageLimitWords({ ...n, kind: n.limit as LimitKind }, who, `its pane (${view})`),
          phone,
        }
    }
  }
  if (e.kind === 'blocked') {
    const first = e.blockers[0]
    return {
      notice: 'start_blocked',
      title: 'Another session holds the channels',
      body: first ? blockerText(first) : 'Another Claude session holds the channels',
      // a restart after a crash that cannot go on: nobody may be at this computer
      phone: e.afterCrash
        ? `${who} crashed, and Talos could not restart it: another Claude session holds the channels (${clock})`
        : null,
    }
  }
  if (e.kind === 'stopped') {
    switch (e.reason) {
      case 'crash_loop':
        return {
          notice: 'crash_loop',
          title: 'Talos stopped restarting',
          body: `${who} kept crashing, so Talos stopped restarting it. Start it again with: talos-app supervise start`,
          phone: `${who}'s session stopped restarting at ${clock}`,
        }
      case 'clean_exit_loop':
        return {
          notice: 'crash_loop',
          title: 'Talos stopped restarting',
          body: `${who} kept exiting cleanly (more than 10 times in an hour), so Talos stopped it`,
          phone: `${who} keeps exiting cleanly, so Talos stopped it at ${clock}`,
        }
      case 'resume_missing':
        return {
          notice: 'resume_failed',
          title: "The last conversation can't be resumed",
          body: `${who}'s conversation could not be resumed; Talos stopped and changed nothing`,
          phone: null,
        }
      case 'start_failed':
        if (e.gaveUp)
          return {
            notice: 'could_not_start',
            title: "Talos couldn't restart",
            body: `${who} stopped and could not be started again, so Talos gave up. See: talos-app supervise status`,
            phone: `${who} stopped and could not be restarted, so Talos gave up at ${clock}`,
          }
        return {
          notice: 'could_not_start',
          title: "Talos couldn't start",
          body: 'See: talos-app supervise status',
          phone: null,
        }
      case 'crashed_no_auto_restart':
        return {
          notice: 'crashed_no_auto_restart',
          title: 'Talos crashed',
          body: `${who} crashed and auto-restart is off. Start it with: talos-app supervise start`,
          phone: null,
        }
      case 'no_notice':
        return {
          notice: 'confirm_failed',
          title: 'Talos stopped',
          body: "The restart wasn't confirmed in time; the session is stopped",
          phone: null,
        }
      case 'user':
        return null
    }
  }
  return null
}

/**
 * notify-send's argv for a notice. `--print-id` and `--replace-id` replace the tag's last notification (the spec's
 * replaces_id, which every daemon honours; omarchy's shell reads only that); the two hints do it on dunst and mako as well.
 * Quiet = low urgency and no sound. The body is escaped markup; `--` keeps either text from being read as an option.
 */
export function notifySendArgv(n: Notice, replaceId: string | null): string[] {
  const { tag, quiet } = SUPERVISOR_NOTICES[n.notice]
  return [
    'notify-send',
    '--app-name=Talos',
    '--print-id',
    ...(replaceId ? [`--replace-id=${replaceId}`] : []),
    `--urgency=${quiet ? 'low' : 'normal'}`,
    `--hint=string:x-canonical-private-synchronous:${tag}`,
    `--hint=string:x-dunst-stack-tag:${tag}`,
    ...(quiet ? ['--hint=boolean:suppress-sound:true'] : []),
    '--',
    // the summary is plain text in the spec; only the body may be markup
    n.title,
    escapeMarkup(n.body),
  ]
}

/** At most one notification per tag with the same text in this long (the Mac's per-tag rate limit). */
export const NOTICE_MIN_GAP_MS = 60_000

/**
 * The per-tag rate limit, and each tag's last notification id (for the next replace). A notice counts as shown only once
 * notify-send said so (`shown`): one that failed (no notification service yet, at boot) is tried again next time.
 */
export class NoticeGate {
  private last = new Map<string, { at: number; text: string }>()
  private ids = new Map<string, string>()
  private pending = new Set<string>()
  /**
   * Due when the tag has none in flight and either its last one is a minute old or the text changed (a needs-you of another
   * kind replaces the old card at once: it is raised once and never again). Marks the tag in flight; `shown` or `failed`
   * clears it.
   */
  due(n: Notice, nowMs: number): boolean {
    const tag = SUPERVISOR_NOTICES[n.notice].tag
    if (this.pending.has(tag)) return false
    const last = this.last.get(tag)
    const changed = last !== undefined && last.text !== `${n.title}\n${n.body}`
    if (last !== undefined && !changed && nowMs - last.at < NOTICE_MIN_GAP_MS) return false
    this.pending.add(tag)
    return true
  }
  shown(n: Notice, nowMs: number, id: string | null): void {
    const tag = SUPERVISOR_NOTICES[n.notice].tag
    this.pending.delete(tag)
    this.last.set(tag, { at: nowMs, text: `${n.title}\n${n.body}` })
    if (id && /^[0-9]+$/.test(id)) this.ids.set(tag, id)
  }
  failed(n: Notice): void {
    this.pending.delete(SUPERVISOR_NOTICES[n.notice].tag)
  }
  replaceId(n: Notice): string | null {
    return this.ids.get(SUPERVISOR_NOTICES[n.notice].tag) ?? null
  }
}

/** config.json's agent name and default thread (where the phone line goes). */
export function readAppConfig(raw: unknown): { agentName: string | null; defaultThread: string | null } {
  const o = (raw ?? {}) as { agent?: { name?: unknown }; default_thread?: unknown }
  return {
    agentName: typeof o.agent?.name === 'string' ? o.agent.name : null,
    defaultThread: typeof o.default_thread === 'string' ? o.default_thread : null,
  }
}

/** The system thread every config.json has; the phone line's thread when the default one is unknown. */
export const NOTICE_FALLBACK_THREAD = 'inbox'

/**
 * The phone line's thread: the default one, or the inbox when config.json names none or cannot be read (a damaged
 * config.json is one of the things that stops Main, and must still be heard).
 */
export function phoneThread(app: { defaultThread: string | null }): string {
  const t = app.defaultThread
  return t !== null && ThreadId.safeParse(t).success ? t : NOTICE_FALLBACK_THREAD
}

/**
 * The supervisor's way to tell the owner about Main (cli.ts runSupervisor): a desktop notice when this session has a
 * notification service (`notifySend`, null when none), and, for a stop, a line to the phone. Never waits.
 */
export function ownerTeller(o: {
  home: string
  /** The command that shows Main's pane, for the notice. */
  view: string
  notifySend: string | null
  audit: (e: string, f?: Record<string, string>) => void
}): (e: MainEvent) => void {
  const gate = new NoticeGate()
  return (e: MainEvent) => {
    let app = readAppConfig(undefined)
    try {
      app = readAppConfig(JSON.parse(readFileSync(join(o.home, 'config.json'), 'utf8')))
    } catch {
      // no config.json yet: the defaults
    }
    const now = new Date()
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const n = noticeFor(e, app.agentName, clock, o.view)
    if (!n) return
    const nowMs = Date.now()
    const notifySend = o.notifySend
    if (notifySend && gate.due(n, nowMs)) {
      const argv = notifySendArgv(n, gate.replaceId(n))
      void runTool([notifySend, ...argv.slice(1)], processEnv(), 10_000).then((r) => {
        // shown only when notify-send says so: a notice lost at boot (no notification service yet) is tried again
        if (r.ok) gate.shown(n, nowMs, r.out.trim())
        else gate.failed(n)
        o.audit('notice', { notice: n.notice, ok: r.ok ? '1' : '0' })
      })
    }
    if (n.phone) {
      // a system row, signed with the bridge key in this process: never through a command an agent could run too
      void postSystemRow({ ...processEnv(), TALOS_APP_HOME: o.home }, phoneThread(app), n.phone).then(
        () => o.audit('post', { ok: '1' }),
        (err) => o.audit('post', { ok: '0', error: (err as Error).message }),
      )
    }
  }
}
