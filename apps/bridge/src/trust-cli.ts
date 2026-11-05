// `talos-app trust on|off|show`: the owner's shell route to trust mode (docs/SECURITY.md "Trust mode"). The other route is a
// signed config.patch from the app (off is free, on needs the passkey, checked by the relay). No agent tool writes it. The running bridge notices the edit and says so in the default thread.
import { trustOn } from '@talos-app/protocol'
import type { BridgeEnv } from './config.ts'
import { paths } from './config.ts'
import { ConfigFile } from './config-file.ts'

export const TRUST_USAGE = 'usage: talos-app trust on|off|show'

type Out = { out(line: string): void; err(line: string): void }

export function cmdTrust(env: BridgeEnv, args: string[], io: Out): number {
  const sub = args[0]
  if (args.length > 1 || (sub !== 'on' && sub !== 'off' && sub !== 'show')) {
    io.err(TRUST_USAGE)
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
  if (sub === 'show') {
    io.out(`trust mode: ${trustOn(cfg) ? 'on' : 'off'}`)
    return 0
  }
  const want = sub === 'on'
  if (trustOn(cfg) === want) {
    io.out(`trust mode is already ${sub}`)
    return 0
  }
  file.update(
    (c) => {
      const { trust_mode: _drop, ...rest } = c
      return want ? { ...rest, trust_mode: true } : rest
    },
    { setsTrustMode: true },
  )
  io.out(
    want
      ? 'trust mode is on. Restart the agent session so it reads the narrower card rule. Your phone sees the change in a moment.'
      : 'trust mode is off. Restart the agent session so it reads the standard card rule.',
  )
  return 0
}
