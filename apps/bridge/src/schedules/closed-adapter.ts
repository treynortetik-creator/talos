// The adapter when there is no usable scheduler (docs/SCHEDULES.md S1.4 step 1 and 4, S1.5, S1.6): off, not installed, or
// Chronos older than 0.3. It never manages anything; its snapshot carries the health state the tab explains.
import type {
  ApplyResult,
  ChronosChangeT,
  ClaimResult,
  DueForSession,
  HealthIssueT,
  SchedulerAdapter,
  SchedulerHealthT,
  ScheduleSnapshotT,
  SessionPromptResult,
  ValidateResult,
} from '@talos-app/protocol'
import { issueFor } from './chronos-adapter.ts'

export type ClosedKind = 'off' | 'not_installed' | 'unsupported'

export const NO_SCHEDULER_TEXT =
  "No scheduler is installed on this Mac. Tell the owner they can install Chronos from the Schedules tab. Don't create cron, launchd or in-session timer jobs yourself."

export const UNANSWERED_TEXT =
  "The scheduler didn't answer in time (the Mac may be busy). Talos will ask again shortly. Tell the owner to try again in a minute."

export function unsupportedText(version: string | undefined): string {
  const major = version ? (/^\d+\.\d+/.exec(version)?.[0] ?? version) : '0.2'
  return `Chronos ${major} is installed. Talos needs 0.3 or newer: \`git pull && ./install.sh\``
}

const nope = () => new Error('no scheduler is available')

export class ClosedAdapter implements SchedulerAdapter {
  readonly id = 'none'
  constructor(
    readonly kind: ClosedKind,
    private readonly info: { tz: string; hostLabel: string; now: () => string; version?: string; unanswered?: boolean },
  ) {}

  /** What the agent is told when it asks for the scheduler. */
  agentText(): string {
    if (this.kind === 'off') return 'Schedules are turned off on this Mac.'
    if (this.kind === 'unsupported') return `${unsupportedText(this.info.version)} Tell the owner.`
    if (this.info.unanswered) return UNANSWERED_TEXT
    return NO_SCHEDULER_TEXT
  }

  async detect() {
    return {
      installed: this.kind !== 'not_installed' || Boolean(this.info.unanswered),
      supported: false,
      ...(this.info.version ? { version: this.info.version } : {}),
      reason: this.kind,
    }
  }
  async health(): Promise<SchedulerHealthT> {
    const at = this.info.now()
    const issues: HealthIssueT[] = []
    if (this.kind === 'not_installed' && this.info.unanswered)
      issues.push(issueFor('adapter_timeout', at, null, UNANSWERED_TEXT))
    else if (this.kind === 'not_installed')
      issues.push(issueFor('not_installed', at, null, 'No scheduler is installed on this Mac.'))
    if (this.kind === 'unsupported')
      issues.push(issueFor('version_unsupported', at, null, unsupportedText(this.info.version)))
    return {
      // A scheduler that did not answer is neither installed-and-fine nor missing: 'error' keeps the install screen away.
      state: this.kind === 'not_installed' && this.info.unanswered ? 'error' : this.kind,
      adapter: { id: 'none', version: this.info.version ?? null, api: null },
      tz: this.info.tz,
      host_label: this.info.hostLabel,
      session_runner: 'unknown',
      paused_all: false,
      headless: 'unknown',
      tick_age_s: null,
      issues,
      checked_at: at,
    }
  }
  async snapshot(): Promise<ScheduleSnapshotT> {
    return { protocol: 1, health: await this.health(), schedules: [], unreadable: [], as_of: this.info.now() }
  }
  async detail() {
    return null
  }
  async validate(): Promise<ValidateResult> {
    return { ok: false, code: 'schedule_invalid', errors: [{ path: '', message: this.agentText() }] }
  }
  async apply(_c: ChronosChangeT, _e: string | null): Promise<ApplyResult> {
    return { ok: false, code: 'schedule_invalid', message: this.agentText() }
  }
  async setPaused(): Promise<void> {
    throw nope()
  }
  async disable(): Promise<{ etag: string }> {
    throw nope()
  }
  async approved() {
    return null
  }
  async dueForSession(): Promise<DueForSession[]> {
    return []
  }
  async claim(): Promise<ClaimResult> {
    return { ok: false, reason: 'schedule_invalid' }
  }
  async finish() {
    return { ok: false as const, reason: 'not_owner' as const }
  }
  async orphanedSessionClaims() {
    return []
  }
  async startHeadless() {
    return { ok: false as const, code: 'schedule_invalid' as const, message: this.agentText() }
  }
  async sessionPrompt(): Promise<SessionPromptResult> {
    return { ok: false, code: 'schedule_invalid' }
  }
  async retryHeadless() {
    return { ok: false, text: this.agentText() }
  }
  watchPaths(): string[] {
    return []
  }
}
