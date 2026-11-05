// The files that carry device enrollment between the CLI and the live bridge (spec 4.10), all under
// $TALOS_APP_HOME/enroll-pending/, written atomically with 0600:
//   <code_id>.json          {code, label, created_at, expires_at}     written by `talos-app enroll`
//   <code_id>.confirm.json  {device_id, name, fingerprint, ...}       written by the live bridge on device.enrolled
//   <code_id>.answer.json   {yes, device_id}                                   written by the CLI after the y/N prompt
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JwkP256T } from '@talos-app/protocol'
import { readJsonFile, removeFile, writeJsonAtomic } from './fsutil.ts'

export const PENDING_KEEP_MS = 24 * 3600_000
export const CONFIRM_WAIT_MS = 10 * 60_000

export type PendingCode = { code: string; label?: string; created_at: string; expires_at: string }
export type ConfirmFile = {
  device_id: string
  name: string
  fingerprint: string[]
  pubkey_jwk: JwkP256T
  created_at: string
}
/** The CLI binds the answer to the device whose fingerprint the owner saw; the bridge pins only a matching `device_id`
 * (an answer without one is accepted only because a second enrollment on a code withdraws the confirm and answer). */
export type AnswerFile = { yes: boolean; device_id?: string }

const CODE_ID = /^[0-9a-f]{16}$/
export const validCodeId = (id: string) => CODE_ID.test(id)

export class EnrollFiles {
  constructor(readonly dir: string) {}

  private file(codeId: string, suffix = '') {
    if (!validCodeId(codeId)) throw new Error('invalid code_id')
    return join(this.dir, `${codeId}${suffix}.json`)
  }

  writePending(codeId: string, p: PendingCode) {
    writeJsonAtomic(this.file(codeId), p, 0o600)
  }
  readPending(codeId: string): PendingCode | undefined {
    return validCodeId(codeId) ? readJsonFile<PendingCode>(this.file(codeId)) : undefined
  }
  writeConfirm(codeId: string, c: ConfirmFile) {
    writeJsonAtomic(this.file(codeId, '.confirm'), c, 0o600)
  }
  readConfirm(codeId: string): ConfirmFile | undefined {
    return readJsonFile<ConfirmFile>(this.file(codeId, '.confirm'))
  }
  writeAnswer(codeId: string, a: AnswerFile) {
    writeJsonAtomic(this.file(codeId, '.answer'), a, 0o600)
  }
  readAnswer(codeId: string): AnswerFile | undefined {
    const a = readJsonFile<AnswerFile>(this.file(codeId, '.answer'))
    return a && typeof a.yes === 'boolean' ? a : undefined
  }
  removeAll(codeId: string) {
    for (const s of ['', '.confirm', '.answer']) removeFile(this.file(codeId, s))
  }

  /** Every code id that has a pending file. */
  codeIds(): string[] {
    try {
      return readdirSync(this.dir)
        .map((f) => /^([0-9a-f]{16})\.json$/.exec(f)?.[1])
        .filter((x): x is string => Boolean(x))
    } catch {
      return []
    }
  }

  /** Code ids that have a confirm file but no answer yet (what `enroll --confirm` prompts for). */
  awaitingAnswer(): string[] {
    return this.codeIds().filter((id) => this.readConfirm(id) && !this.readAnswer(id))
  }
}
