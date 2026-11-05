// The apps switch (TALOS_APP_APPS), read the same way by the bridge and by the hooks. `$TALOS_APP_HOME/bridge.env` wins over the
// process environment: a running process's environment cannot change, so the file is the only thing that lets "off" take effect
// without a restart for a bridge started with `TALOS_APP_APPS=1` in its shell. Absent from both, `fallback` decides.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnvFile } from '../config.ts'

export function appsSwitch(home: string, env: Record<string, string | undefined>, fallback = false): boolean {
  try {
    const v = parseEnvFile(readFileSync(join(home, 'bridge.env'), 'utf8')).TALOS_APP_APPS
    if (v !== undefined && v !== '') return v === '1'
  } catch {
    // no file: the process environment decides
  }
  const e = env.TALOS_APP_APPS
  if (e !== undefined && e !== '') return e === '1'
  return fallback
}
