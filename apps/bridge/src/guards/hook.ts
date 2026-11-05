// `talos-app guard-hook --config <guards.json> --sha <hex>`: the PreToolUse hook that `install-guards` registers. It fails
// closed: anything it cannot read or decide is answered with a deny. The rules file is checked against the hash that was
// written into the hook command at install time, so editing or emptying guards.json blocks every call instead of loosening it.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type GuardConfig, guardDecision } from './rules.ts'

const answer = (reason: string) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** The rules, only if the file is byte for byte what install wrote and has every field. Throws otherwise. */
export function loadGuardConfig(path: string, sha: string | undefined): GuardConfig {
  const raw = readFileSync(path)
  if (!sha || createHash('sha256').update(raw).digest('hex') !== sha)
    throw new Error('guards.json does not match install')
  const c = JSON.parse(raw.toString('utf8')) as GuardConfig
  const ok =
    ['home', 'checkout', 'claudeHome', 'userHome'].every(
      (k) => typeof (c as Record<string, unknown>)[k] === 'string',
    ) &&
    strings(c.protectedPaths) &&
    strings(c.writeDenied) &&
    c.writeDenied.length > 0
  if (!ok) throw new Error('guards.json is incomplete')
  return c
}

export async function mainGuardHook(args: string[]): Promise<number> {
  try {
    const at = args.indexOf('--config')
    const sat = args.indexOf('--sha')
    const cfg = loadGuardConfig(args[at + 1] as string, sat < 0 ? undefined : args[sat + 1])
    const call = JSON.parse(await Bun.stdin.text()) as { tool_name?: unknown; tool_input?: unknown }
    if (typeof call.tool_name !== 'string') throw new Error('no tool_name')
    const d = guardDecision({ tool_name: call.tool_name, tool_input: call.tool_input }, cfg)
    if (d) process.stdout.write(`${answer(d.deny)}\n`)
  } catch {
    process.stdout.write(
      `${answer('Talos guard could not read this call or its rules (or the rules changed since install), so it is blocked. Tell the owner; they run `talos-app install-guards` again.')}\n`,
    )
  }
  return 0
}
