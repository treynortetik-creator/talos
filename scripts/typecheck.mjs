#!/usr/bin/env node
// The one place that picks the compiler of every typecheck: each package's `typecheck` script, `typecheck:mod`, so the gate (scripts/gate.sh),
// CI (scripts/ci-local/jobs-check.sh, .github/workflows/ci.yml) and a person at a prompt all go through here.
//
//   default                   tsgo, the native compiler (@typescript/native-preview, pinned exactly in the root package.json)
//   TALOS_TYPECHECK=tsc       tsc (typescript, also pinned): the fallback, and the nightly's second look (jobs-check.sh)
//
// The compiler is the repo's own: <repo root>/node_modules/.bin/<name>, never one found on PATH (a global tsc or tsgo of another version must not run).
// Arguments are passed on as they are; with none, `--noEmit -p tsconfig.json` (what each package ran before). tsc exits 2 on type errors
// and tsgo exits 1: both mean "type errors", so this exits 1 for any compiler failure (a signal, a missing or unstartable compiler) and 0 only on 0.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const choice = (process.env.TALOS_TYPECHECK ?? '').trim() || 'tsgo'
if (choice !== 'tsgo' && choice !== 'tsc') {
  console.error(`typecheck: TALOS_TYPECHECK must be tsgo (the default) or tsc, not "${choice}"`)
  process.exit(1)
}
const win = process.platform === 'win32'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', '.bin', win ? `${choice}.cmd` : choice)
if (!existsSync(bin)) {
  console.error(`typecheck: ${choice} is not installed here (${bin}); run pnpm install`)
  process.exit(1)
}
const given = process.argv.slice(2)
const args = given.length > 0 ? given : ['--noEmit', '-p', 'tsconfig.json']
const r = spawnSync(bin, args, { stdio: 'inherit', shell: win })
if (r.error) {
  console.error(`typecheck: could not run ${choice}: ${r.error.message}`)
  process.exit(1)
}
process.exit(r.status === 0 ? 0 : 1)
