// Fake command-line tools (gh, pnpm, bun, ...) for the scripts/ tests: each one is written once per content into a shared
// folder and linked into the test's own bin. On macOS a newly written executable pays a check on its first run (0.1-0.4 s on
// an idle Mac, over a second under load); a link to a file that has already run does not, so a test's fakes cost nothing
// after the first test that used the same ones. The file is named by a hash of its content: a changed fake is a new file.
// Writing or chmodding a linked tool would change the shared file, so a test that alters one of its tools links a new one.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const shared = (() => {
  const dir = join(tmpdir(), `talos-fake-tools-${userInfo().uid}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    // only a folder of our own that nobody else can write to: anything else and each test writes its own files
    if (!st.isDirectory() || st.uid !== userInfo().uid || (st.mode & 0o022) !== 0) return null
    return dir
  } catch {
    return null
  }
})()

/** `bin`/`name` runs `script` (a whole file, shebang included). */
export function fakeTool(bin: string, name: string, script: string): void {
  const at = join(bin, name)
  rmSync(at, { force: true })
  if (!shared) {
    writeFileSync(at, script, { mode: 0o755 })
    chmodSync(at, 0o755)
    return
  }
  const file = join(shared, createHash('sha256').update(script).digest('hex').slice(0, 32))
  if (!existsSync(file)) {
    // beside it, then renamed in: a test in another worker sees the whole file or none
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, script, { mode: 0o755 })
    chmodSync(tmp, 0o755)
    renameSync(tmp, file)
  }
  symlinkSync(file, at)
}
