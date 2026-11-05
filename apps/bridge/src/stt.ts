// Speech to text through the owner's own command (spec 4.2). No command: the notification says so and carries audio_path.
import { basename, extname } from 'node:path'
import type { BridgeEnv } from './config.ts'
import { fillArgv, runArgv } from './exec.ts'

export type SttResult =
  | { status: 'done'; text: string; engine: string }
  | { status: 'failed'; reason: string; engine: string }
  | { status: 'none' }

export function engineName(argv: string[]): string {
  const b = basename(argv[0] ?? 'stt', extname(argv[0] ?? ''))
  return b.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'stt'
}

export async function transcribe(env: BridgeEnv, audioPath: string, durationS: number | undefined): Promise<SttResult> {
  const long = durationS !== undefined && durationS > env.sttLongAfterS
  const cmd = long ? (env.sttLongCmd ?? env.sttCmd) : env.sttCmd
  if (!cmd) return { status: 'none' }
  const engine = engineName(cmd)
  const res = await runArgv(fillArgv(cmd, { in: audioPath }), env.sttTimeoutS * 1000)
  if (!res.ok) {
    const reason =
      res.reason === 'timeout' ? 'timed out' : res.reason === 'spawn' ? 'could not start' : `exit ${res.code}`
    return { status: 'failed', reason, engine }
  }
  const text = res.stdout.trim()
  if (!text) return { status: 'failed', reason: 'empty transcript', engine }
  return { status: 'done', text, engine }
}
