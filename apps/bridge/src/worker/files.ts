// The files the hub and the desktop supervisor share under $TALOS_APP_HOME (docs/OPTION-C.md "Files"). The supervisor
// writes workers.json and each worker's nonce; the hub writes wake and ready. All 0600 in 0700 folders.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseWorkersFile,
  WakeFile,
  type WakeFileT,
  WORKER_FILES,
  WorkerReady,
  type WorkerReadyT,
  type WorkersFileT,
} from '@talos-app/protocol'
import { ensureDir, readJsonFile, writeFileAtomic } from '../fsutil.ts'

export const workersJsonPath = (home: string) => join(home, 'workers.json')
export const workerDir = (home: string, threadId: string) => join(home, 'workers', threadId)
export const hubSockPath = (home: string) => join(home, 'hub.sock')

/** workers.json, re-read only when its mtime or size changed. A torn or invalid file reads as null. */
export class WorkersReader {
  private key = ''
  private cached: WorkersFileT | null = null
  constructor(private readonly home: string) {}

  read(): WorkersFileT | null {
    const path = workersJsonPath(this.home)
    let k: string
    try {
      const s = statSync(path)
      k = `${s.mtimeMs}:${s.size}`
    } catch {
      this.key = ''
      this.cached = null
      return null
    }
    if (k === this.key) return this.cached
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    this.key = k
    this.cached = parseWorkersFile(text)
    return this.cached
  }
}

/** Writes (replaces) a thread's wake file. The supervisor takes it by renaming, so a rewrite never loses a wake. */
export function writeWake(home: string, wake: WakeFileT): void {
  const dir = workerDir(home, wake.thread_id)
  ensureDir(join(home, 'workers'))
  ensureDir(dir)
  writeFileAtomic(join(dir, WORKER_FILES.wake), `${JSON.stringify(WakeFile.parse(wake))}\n`, 0o600)
}

export function readWake(home: string, threadId: string): WakeFileT | undefined {
  const raw = readJsonFile(join(workerDir(home, threadId), WORKER_FILES.wake))
  const r = WakeFile.safeParse(raw)
  return r.success ? r.data : undefined
}

export function readNonce(home: string, threadId: string): string | undefined {
  try {
    const v = readFileSync(join(workerDir(home, threadId), WORKER_FILES.nonce), 'utf8').trim()
    return v.length >= 16 && v.length <= 64 ? v : undefined
  } catch {
    return undefined
  }
}

export function writeReady(home: string, ready: WorkerReadyT): void {
  const dir = workerDir(home, ready.thread_id)
  ensureDir(join(home, 'workers'))
  ensureDir(dir)
  writeFileAtomic(join(dir, WORKER_FILES.ready), `${JSON.stringify(WorkerReady.parse(ready))}\n`, 0o600)
}
