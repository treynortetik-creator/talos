// "Undo to here" on a file system not yet on the allowlist (src/undo/fs-type.ts): run this on a folder there to see
// what the bridge reads and whether the birth-time probe passes. It writes one hidden probe file in that folder and
// removes it; nothing else is touched.
//   bun apps/bridge/scripts/undo-fs-probe.ts <folder>
import { realpathSync } from 'node:fs'
import { fsTypeOf, PROVEN_FS } from '../src/undo/fs-type.ts'
import { probeBirthTimes } from '../src/undo/restore.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: bun apps/bridge/scripts/undo-fs-probe.ts <folder>')
  process.exit(2)
}
const folder = realpathSync(arg)
const fs = await fsTypeOf(folder)
const probe = await probeBirthTimes(folder)
console.log(
  JSON.stringify({
    folder,
    platform: process.platform,
    fs: fs ?? 'unknown',
    on_allowlist: fs !== undefined && PROVEN_FS.has(fs),
    probe_keeps_birth_times: probe,
  }),
)
