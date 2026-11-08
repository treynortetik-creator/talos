#!/usr/bin/env bun
// `talos-app` entry (spec 4.8). Thin on purpose: `talos-app subagent-tee` is Claude Code's `subagentStatusLine` command,
// run every few seconds while subagent rows are on screen, and must exit in under 100 ms (docs/SUBAGENTS.md 5.2). So it
// is dispatched here, before the rest of the CLI (relay, sqlite, MCP SDK) is loaded, and so are `rollback` and `restore-last-good` (they have to work
// when the packages are broken); every other command loads
// cli-main.ts on demand. Type exports are erased at build time, so importing them loads nothing.
import { workerCliRefusal } from './worker/cli-refusal.ts'

export type { CliDeps, CliIO } from './cli-main.ts'

type Main = typeof import('./cli-main.ts')

export async function runCli(...args: Parameters<Main['runCli']>): ReturnType<Main['runCli']> {
  // a thread's own session runs only the commands on its allow list: checked before any of the early dispatches below
  const refusal = workerCliRefusal(args[0], args[2] ?? process.env, args[3]?.cwd)
  if (refusal) {
    args[1].err(refusal)
    return 1
  }
  if (args[0][0] === 'subagent-tee') return (await import('./subagent-tee.ts')).mainTee(args[0].slice(1))
  if (args[0][0] === 'hook') {
    const h = await import('./apps/hook-cli.ts')
    return h.mainHook(args[0].slice(1), h.processHookIO())
  }
  // `rollback` is the way back when an update left the packages broken: it must not need the rest of the CLI to load
  if (args[0][0] === 'rollback') {
    return (await import('./rollback.ts')).runRollback(args[0].slice(1), args[1], args[2], args[3]?.rollback)
  }
  // `restore-last-good` is the undo for a broken customization: like rollback, it must not need the rest of the CLI
  if (args[0][0] === 'restore-last-good') {
    return (await import('./last-good.ts')).restoreLastGood(args[0].slice(1), args[1], args[2])
  }
  return (await import('./cli-main.ts')).runCli(...args)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const refusal = workerCliRefusal(argv, process.env)
  if (refusal) {
    process.stderr.write(`${refusal}\n`)
    process.exit(1)
  }
  if (argv[0] === 'subagent-tee') {
    const { mainTee } = await import('./subagent-tee.ts')
    process.exit(mainTee(argv.slice(1)))
  }
  // `hook` is Claude Code's per-call process (MCP apps): it must not load the relay, sqlite or the MCP SDK
  if (argv[0] === 'hook') {
    const h = await import('./apps/hook-cli.ts')
    process.exit(await h.mainHook(argv.slice(1), h.processHookIO()))
  }
  if (argv[0] === 'rollback') {
    const r = await import('./rollback.ts')
    process.exit(await r.runRollback(argv.slice(1), r.rollbackIO()))
  }
  if (argv[0] === 'restore-last-good') {
    const l = await import('./last-good.ts')
    const r = await import('./rollback.ts')
    process.exit(await l.restoreLastGood(argv.slice(1), r.rollbackIO()))
  }
  const m = await import('./cli-main.ts')
  process.exit(await m.runCli(argv, m.terminalIO()))
}
