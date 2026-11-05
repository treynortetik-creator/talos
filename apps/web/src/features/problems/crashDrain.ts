// The iPhone shell's crash reports (docs/ERRORS.md). The shell's TalosCrash plugin keeps the system's MetricKit crash and
// hang summaries until this page asks; each becomes a problem report from source 'ios' and goes through the same queue as
// every other one. Feature-detected like the other shell plugins: outside the shell, or in an older build without the
// plugin, nothing happens. A summary this build cannot read is skipped alone.
import { newUlid, type ProblemFrameT, type ProblemT, problemFingerprint, scrubProblem } from '@talos-app/protocol'
import { isNativeShell } from '../../lib/native.ts'
import type { CaptureEnv } from './capture.ts'
import type { ProblemController } from './controller.ts'

/** What the plugin hands over (apps/mobile/ios/TalosCrashCore `CrashSummary`). Unknown extra keys are ignored. */
export type CrashSummaryT = {
  kind: 'crash' | 'hang' | 'cpu' | 'disk'
  name: string
  reason: string
  appVersion: string
  appBuild: string
  frames: Array<{ binary: string; offset: number }>
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Reads one summary; null when it is not one (a newer shell that changed shape). Odd optional fields degrade to empty. */
export function readSummary(raw: unknown): CrashSummaryT | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'crash' && r.kind !== 'hang' && r.kind !== 'cpu' && r.kind !== 'disk') return null
  if (typeof r.name !== 'string') return null
  const frames = Array.isArray(r.frames) ? r.frames : []
  return {
    kind: r.kind,
    name: r.name.slice(0, 200),
    reason: str(r.reason, 200),
    appVersion: str(r.appVersion, 40),
    appBuild: str(r.appBuild, 40),
    frames: frames
      .filter(
        (f): f is { binary: string; offset: number } =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as { binary?: unknown }).binary === 'string' &&
          Number.isInteger((f as { offset?: unknown }).offset) &&
          (f as { offset: number }).offset >= 0,
      )
      .slice(0, 100)
      .map((f) => ({ binary: f.binary.slice(0, 80), offset: f.offset })),
  }
}

const KIND_NAME = { crash: 'crash', hang: 'hang', cpu: 'cpu limit', disk: 'disk write limit' } as const

/** One summary as a report. A frame is `binary` + offset: turning the offset into a function needs the build's dSYM. */
export function problemFromCrash(s: CrashSummaryT, env: CaptureEnv): ProblemT {
  const frames: ProblemFrameT[] = s.frames.map((f) => ({ fn: `+0x${f.offset.toString(16)}`, file: f.binary }))
  const build = s.appVersion ? `${s.appVersion}${s.appBuild ? ` (build ${s.appBuild})` : ''}` : undefined
  const draft: ProblemT = {
    id: newUlid(),
    source: 'ios',
    kind: 'auto',
    fingerprint: '0'.repeat(32),
    at: new Date(env.now()).toISOString(),
    name: `${KIND_NAME[s.kind]}: ${s.name}`,
    message: s.reason,
    frames,
    versions: { ...env.versions, ...(build ? { shell: build.slice(0, 40) } : {}) },
    device: 'iphone_app',
    routes: [],
    truncated: false,
  }
  const clean = scrubProblem(draft)
  return { ...clean, fingerprint: problemFingerprint(clean) }
}

type DrainPlugin = { drain?: () => Promise<{ summaries?: unknown }> | undefined }

function plugin(scope: unknown): DrainPlugin | null {
  try {
    const p = (scope as { Capacitor?: { Plugins?: Record<string, DrainPlugin | undefined> } } | null)?.Capacitor
      ?.Plugins
    return p?.TalosCrash ?? null
  } catch {
    return null
  }
}

/** Takes what the shell holds and queues it. Returns how many reports were queued. Never throws. */
export async function drainCrashes(ctl: ProblemController, scope: unknown = globalThis): Promise<number> {
  try {
    if (!isNativeShell(scope)) return 0
    const p = plugin(scope)
    if (typeof p?.drain !== 'function') return 0
    const got = await p.drain()
    const list = Array.isArray(got?.summaries) ? got.summaries : []
    let queued = 0
    for (const raw of list) {
      const summary = readSummary(raw)
      if (!summary) continue // one summary this build cannot read costs only itself
      const report = problemFromCrash(summary, ctl.env())
      if (!ctl.throttle.allow(report.fingerprint)) continue
      await ctl.submit(report)
      queued++
    }
    return queued
  } catch {
    return 0
  }
}
