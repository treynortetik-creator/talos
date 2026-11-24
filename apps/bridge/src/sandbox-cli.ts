// `talos-app sandbox on|off|status`: the opt-in OS sandbox switch ("Extra lock on protected files", config.json `os_sandbox`, guards/
// os-sandbox.ts). Like the other settings commands an agent may run, "Lock Talos settings" refuses every agent run (agent-cli.ts);
// typed in a terminal it is the owner's own. `on` and `off` write config.json; both take effect at the next start of Main and of each
// thread session. `on` prints the experimental limits (protocol dev.ts, OS_SANDBOX_LIMITS) every time. `status` also says whether the
// preflight would refuse a launch now.
import { osSandboxHelpLines } from '@talos-app/protocol'
import { type BridgeEnv, paths } from './config.ts'
import { ConfigFile } from './config-file.ts'
import { osSandboxPreflight } from './guards/os-sandbox.ts'

type Out = { out: (l: string) => void; err: (l: string) => void }

export const SANDBOX_USAGE = 'usage: talos-app sandbox on|off|status'

export function cmdSandbox(env: BridgeEnv, args: string[], io: Out): number {
  const sub = args[0]
  if (args.length !== 1 || (sub !== 'on' && sub !== 'off' && sub !== 'status')) {
    io.err(SANDBOX_USAGE)
    return 2
  }
  const file = new ConfigFile(paths(env.home).configJson, {
    log: { warn: (m, f) => io.err(`talos-app: ${m}${f?.error ? `: ${String(f.error)}` : ''}`) },
  })
  let cfg: ReturnType<ConfigFile['load']>
  try {
    cfg = file.load()
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
  const on = cfg.os_sandbox === true
  if (sub === 'status') {
    io.out(`extra lock on protected files (OS sandbox): ${on ? 'on' : 'off'}`)
    const bad = on ? osSandboxPreflight(env.home) : null
    if (bad) io.out(`a start is refused now: ${bad}`)
    return 0
  }
  const want = sub === 'on'
  if (on === want) {
    io.out(`the extra lock on protected files is already ${sub}`)
    if (want) for (const l of osSandboxHelpLines()) io.out(l)
    return 0
  }
  file.update((c) => {
    const { os_sandbox: _drop, ...rest } = c
    return want ? { ...rest, os_sandbox: true } : rest
  })
  io.out(
    want
      ? 'the extra lock on protected files is on. It takes effect when Main and each thread session next start; undo with: talos-app sandbox off'
      : 'the extra lock on protected files is off. It ends when Main and each thread session next start.',
  )
  // EXPERIMENTAL: what it does not stop is said every time `on` runs (no marker file to keep: it is rare, and the words are short)
  if (want) for (const l of osSandboxHelpLines()) io.out(l)
  return 0
}
