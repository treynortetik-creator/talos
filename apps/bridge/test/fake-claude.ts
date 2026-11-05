// A fake `claude` on PATH for doctor tests, so no test ever runs the real one.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeClaude = {
  /** `claude plugin list --json`: a JSON string to print, or 'unsupported' to exit 2 like an older CLI. */
  json?: string | 'unsupported'
  /** `claude plugin list` without --json. */
  text?: string
  /** `claude doctor`: prints a line and exits 0, exits 1, or never returns. */
  doctor?: 'ok' | 'fail' | 'hang'
  /** `claude doctor` prints exactly this (stdout) and exits 0, as the real one does even with problems. */
  doctorOut?: string
  /** `claude plugin list` never returns. */
  listHang?: boolean
  /** A file the fake appends `cwd=...`, `cfg=...` and, for a hang, `pid=<pid of each sleep>` lines to. */
  record?: string
}

/** Puts a fake `claude` first on PATH; returns the function that restores PATH. */
export function installFakeClaude(spec: FakeClaude = {}): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'fc'))
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  const json = spec.json ?? '[]'
  const doctor = spec.doctor ?? 'ok'
  const rec = spec.record ? q(spec.record) : undefined
  const recLines = rec
    ? `echo "cwd=$(pwd -P)" >> ${rec}\necho "cfg=$CLAUDE_CONFIG_DIR" >> ${rec}\necho "args=$*" >> ${rec}\n`
    : ''
  const hang = rec ? `sleep 60 & echo "pid=$!" >> ${rec}; wait` : 'sleep 60'
  const doctorBody =
    spec.doctorOut !== undefined
      ? `printf '%s\\n' ${q(spec.doctorOut)}`
      : doctor === 'hang'
        ? hang
        : doctor === 'fail'
          ? 'echo broken >&2; exit 1'
          : 'echo "Claude Code is healthy"'
  const script = `#!/bin/sh
${recLines}if [ "$1" = plugin ] && [ "$2" = list ]; then
  ${spec.listHang ? hang : ':'}
  if [ "$3" = --json ]; then
    ${json === 'unsupported' ? 'echo "error: unknown option --json" >&2; exit 2' : `printf '%s\\n' ${q(json)}`}
  else
    printf '%s\\n' ${q(spec.text ?? 'No plugins installed.')}
  fi
  exit 0
fi
if [ "$1" = doctor ]; then
  ${doctorBody}
  exit 0
fi
exit 0
`
  writeFileSync(join(dir, 'claude'), script)
  chmodSync(join(dir, 'claude'), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ''}`
  return () => {
    process.env.PATH = before
  }
}

/** PATH with no `claude` in it at all. */
export function withoutClaude(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'nc'))
  const before = process.env.PATH
  process.env.PATH = dir
  return () => {
    process.env.PATH = before
  }
}
