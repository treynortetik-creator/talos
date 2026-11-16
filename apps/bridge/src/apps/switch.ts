// The apps switch (TALOS_APP_APPS), read the same way by the bridge and by the hooks. `$TALOS_APP_HOME/bridge.env` wins over the
// process environment: a running process's environment cannot change, so the file is the only thing that lets "off" take effect
// without a restart for a bridge started with `TALOS_APP_APPS=1` in its shell. Absent from both, `fallback` decides.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flag, parseEnvFile } from '../config.ts'

// A legacy exception in flags.json: bridge.env before the process environment, the reverse of loadEnv.
export function appsSwitch(home: string, env: Record<string, string | undefined>, fallback = false): boolean {
  let file: Record<string, string> | undefined
  try {
    file = parseEnvFile(readFileSync(join(home, 'bridge.env'), 'utf8'))
  } catch {
    // no file: the process environment decides
  }
  return flag('TALOS_APP_APPS', [file, env], fallback)
}
