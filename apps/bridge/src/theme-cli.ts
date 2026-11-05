// `talos-app theme reset|show`: the way back from a theme the owner cannot read, from the Mac. It removes the `theme` key
// from config.json, so every device returns to talos; the running bridge notices the edit and syncs the phone. Settings >
// Default theme and the `?theme=default` link do the same job from a phone, without this command.
import type { BridgeEnv } from './config.ts'
import { paths } from './config.ts'
import { ConfigFile } from './config-file.ts'

export const THEME_USAGE = 'usage: talos-app theme reset|show'

type Out = { out(line: string): void; err(line: string): void }

export function cmdTheme(env: BridgeEnv, args: string[], io: Out): number {
  const sub = args[0]
  if (args.length !== 1 || (sub !== 'reset' && sub !== 'show')) {
    io.err(THEME_USAGE)
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
  const now =
    cfg.theme === undefined ? 'talos' : typeof cfg.theme === 'string' ? cfg.theme : `custom "${cfg.theme.name}"`
  if (sub === 'show') {
    io.out(`theme: ${now}`)
    return 0
  }
  if (cfg.theme === undefined) {
    io.out('theme is already the default (talos)')
    return 0
  }
  file.update((c) => {
    const { theme: _drop, ...rest } = c
    return rest
  })
  io.out('theme reset to the default (talos). Your phone sees the change in a moment.')
  return 0
}
