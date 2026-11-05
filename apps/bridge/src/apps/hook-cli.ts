// `talos-app hook <event>`: the process Claude Code runs around catalogued tool calls (MCP-APPS-SPEC M5.2). Loaded on its
// own from cli.ts (no relay, sqlite or MCP SDK), because it sits in the path of a tool call. Always exits 0: the gate
// speaks through its JSON (`deny`), and a hook that crashed would only be a different way to fail.
import { defaultHome } from '../config.ts'
import { HOOK_STDIN_MAX, parseHookArgv, runHook } from './hooks.ts'
import { appPaths } from './paths.ts'
import { appsSwitch } from './switch.ts'

export type HookIO = {
  readStdin: () => Promise<string>
  write: (s: string) => void
  env: Record<string, string | undefined>
  now: () => number
}

export async function mainHook(argv: string[], io: HookIO): Promise<number> {
  const event = parseHookArgv(['hook', ...argv])
  if (!event) return 0
  const live = io.env.TALOS_APP_BRIDGE === '1'
  if (!live) return 0 // scheduled `claude -p` jobs are untouched, without even reading stdin
  let stdin = ''
  try {
    stdin = await io.readStdin()
  } catch {
    stdin = ''
  }
  if (stdin.length > HOOK_STDIN_MAX) stdin = '' // unparseable -> the gate denies, the post hooks stay silent
  const home = io.env.TALOS_APP_HOME || defaultHome()
  // Apps switched off: the post hooks write nothing and tell the agent nothing (it has no app tools then). The gate stays on, so a
  // request that was waiting for a card when the switch went off still cannot be run by a late agent call.
  if (event !== 'pre-tool-use' && !appsSwitch(home, io.env)) return 0
  const out = runHook(event, stdin, {
    paths: appPaths(home),
    now: io.now,
    live,
  })
  if (out) io.write(`${JSON.stringify(out)}\n`)
  return 0
}

export const processHookIO = (): HookIO => ({
  readStdin: () => Bun.stdin.text(),
  write: (s) => process.stdout.write(s),
  env: process.env,
  now: () => Date.now(),
})
