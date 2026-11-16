// `talos-app enroll`: a one-use setup link for a new device, then the owner's y/N on the four words the device shows.
//   - Text mode (a person at a terminal): the link, a QR of it, and the question `Pin "<name>" [four words]? [y/N]`.
//   - `--json` (a program in front of a person, e.g. the Windows tray): one JSON object per line on stdout, each with an
//     `event`, and exactly one answer line read from stdin, `y` for yes; anything else, or stdin closing, is no. The four
//     words still come from the live bridge's record of the device, never from the program. The events and their order
//     are a contract (docs/bridge.md, "Enroll from a program").
// The y/N is the security step: the relay cannot pin a device, only this Mac or PC's answer can.
import { writeSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  deriveEnrollAuth,
  enrollAuthHash,
  enrollCodeId,
  fingerprintWords,
  newEnrollCode,
  PGP_EVEN_WORDS,
  PGP_ODD_WORDS,
} from '@talos-app/protocol'
import { type BridgeEnv, paths } from './config.ts'
import { DeviceStore } from './devices.ts'
import { EnrollFiles } from './enroll-files.ts'
import { cleanDeviceName } from './enrollment.ts'
import { ensureDir } from './fsutil.ts'
import type { RelayHttp } from './relay-http.ts'
import { RelayHttpError } from './relay-http.ts'

/** What enroll needs of the CLI: kept here as parameters so this file does not import cli-main (which imports it). */
export type EnrollCli = {
  http(): Promise<Pick<RelayHttp, 'enroll'>>
  relayUrl(): string
  /** The live bridge, in words: `ok`, or why nobody can pin a device right now. */
  bridge(): { level: string; text: string }
  renderQr(text: string): Promise<string[] | undefined>
  keyRefusedHint(e: RelayHttpError): Promise<string>
  /** A usage or relay failure, as the CLI reports it (exit 1). */
  fail(message: string): Error
}
export type EnrollIO = {
  out(line: string): void
  prompt(question: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
  /** One JSON event line, written at once (a program reads it through a pipe). Default: a synchronous write to stdout. */
  emit?(line: string): void
}

const CODE_MS = 10 * 60_000
const PIN_WAIT_MS = 60_000
/** An answer sooner than this after the question was typed ahead, before the words could be read: it is a no. */
const READ_MS = 500
/** How long a stdout that takes nothing may hold up an event before the CLI gives up on it. */
const WRITE_GIVE_UP_MS = 5_000
const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a)
/** `--json`: only exactly `y` is yes (a trailing CR from a Windows pipe allowed). */
const jsonYes = (a: string) => /^y\r?$/.test(a)
/**
 * The four words go into a dialog as they are, so they must be the PGP list's own words, each from its list by position
 * (even, odd, even, odd), exactly: only real words can ever be shown. Letters alone are not enough (an invisible or
 * right-to-left letter is a letter), and A-Z alone refused "Yucatán", so about 2 devices in 256 could not pair.
 */
export const plainWords = (w: readonly string[]) =>
  w.length === 4 && w.every((x, i) => (i % 2 === 0 ? PGP_EVEN_WORDS : PGP_ODD_WORDS).includes(x))

/** The whole line, synchronously; a full non-blocking stdout is waited on in 5 ms naps, then given up on (throws). */
export function writeStdout(line: string, fd = 1) {
  const buf = Buffer.from(`${line}\n`)
  const nap = new Int32Array(new SharedArrayBuffer(4))
  let at = 0
  let waited = 0
  while (at < buf.length) {
    try {
      at += writeSync(fd, buf, at)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN' || waited >= WRITE_GIVE_UP_MS) throw e
      Atomics.wait(nap, 0, 0, 5)
      waited += 5
    }
  }
}

/** Always from the device id, as the phone computes them: the confirm file's own copy is never shown. */
const wordsOf = (c: { device_id: string }): string[] => [...fingerprintWords(c.device_id)]

/** The answer to the question asked at `askedAt`, or no: typed ahead, or the question withdrawn meanwhile. */
async function answerFor(
  files: EnrollFiles,
  codeId: string,
  deviceId: string,
  question: string,
  io: EnrollIO,
  isYes: (a: string) => boolean,
) {
  const askedAt = io.now()
  const line = await io.prompt(question)
  const ok = isYes(line) && io.now() - askedAt >= READ_MS
  // a second device enrolling meanwhile takes the question back (the bridge removes the code's files): nothing to answer
  if (files.readConfirm(codeId)?.device_id !== deviceId) return null
  files.writeAnswer(codeId, { yes: ok, device_id: deviceId })
  return ok
}

async function promptPending(files: EnrollFiles, codeId: string, io: EnrollIO) {
  const c = files.readConfirm(codeId)
  if (!c) return
  const q = `Pin ${JSON.stringify(cleanDeviceName(c.name))} [${wordsOf(c).join(' ')}]? [y/N] `
  const ok = await answerFor(files, codeId, c.device_id, q, io, yes)
  if (ok === null)
    io.out('This question was withdrawn (another device used the code, or it timed out). Nothing was pinned.')
  else io.out(ok ? 'Answered yes; the live bridge will pin the device.' : 'Answered no; the device will not be pinned.')
}

/** A new one-use code: kept here, its hash sent to the relay. Returns the link and when it stops working. */
async function newCode(
  relay: { http: Pick<RelayHttp, 'enroll'>; url: string },
  cli: EnrollCli,
  files: EnrollFiles,
  label: string | undefined,
  now: number,
) {
  const { http, url: relayUrl } = relay
  const code = newEnrollCode()
  const hash = enrollAuthHash(deriveEnrollAuth(code))
  const codeId = enrollCodeId(hash)
  const expiresAt = new Date(now + CODE_MS).toISOString()
  files.writePending(codeId, {
    code,
    ...(label ? { label } : {}),
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  })
  // only the hash goes to the relay; the code itself stays on this machine and in the link fragment
  try {
    await http.enroll({ code_id: codeId, code_auth_hash: hash, expires_at: expiresAt, ...(label ? { label } : {}) })
  } catch (e) {
    files.removeAll(codeId) // the file above holds a code the relay never heard of: take it back
    if (e instanceof RelayHttpError && e.status === 401)
      throw Object.assign(cli.fail(await cli.keyRefusedHint(e)), { keyRefused: true })
    throw e
  }
  return { codeId, link: `${relayUrl}/enroll#${code}`, expiresAt }
}

export async function cmdEnroll(env: BridgeEnv, args: string[], io: EnrollIO, cli: EnrollCli): Promise<number> {
  let values: { label?: string; confirm?: boolean; 'no-qr'?: boolean; json?: boolean }
  try {
    values = parseArgs({
      args,
      options: {
        label: { type: 'string' },
        confirm: { type: 'boolean' },
        'no-qr': { type: 'boolean' },
        json: { type: 'boolean' },
      },
      strict: true,
    }).values
  } catch (e) {
    if (args.some((a) => a === '--json' || a.startsWith('--json=')))
      return jsonEnd(io, { event: 'error', code: 'usage', text: (e as Error).message })
    throw e
  }
  const p = paths(env.home)
  const files = new EnrollFiles(p.enrollPending)
  if (values.json) {
    if (values.confirm) return jsonEnd(io, { event: 'error', code: 'usage', text: '--json does not go with --confirm' })
    try {
      return await enrollJson(env, values.label, io, cli, files)
    } catch (e) {
      // whatever went wrong, the program hears it as an event, and an open question is answered no
      try {
        for (const id of files.awaitingAnswer()) {
          const c = files.readConfirm(id)
          if (c && enrollingNow.has(id)) files.writeAnswer(id, { yes: false, device_id: c.device_id })
        }
      } catch {
        // no answer file is a no too: the bridge pins only on a written yes
      }
      return jsonEnd(io, { event: 'error', code: 'internal', text: (e as Error).message })
    } finally {
      enrollingNow.clear()
    }
  }
  if (values.confirm) {
    const ids = files.awaitingAnswer()
    if (!ids.length) io.out('nothing is waiting for confirmation')
    for (const id of ids) await promptPending(files, id, io)
    return 0
  }
  const relay = { http: await cli.http(), url: cli.relayUrl() }
  // D56: the phone's four words only reach a live bridge. Say so BEFORE the one-use code is made and shown.
  const bridge = cli.bridge()
  if (bridge.level !== 'ok') {
    io.out(`Warning: ${bridge.text}`)
    io.out(
      'Nobody can pin the new device until a live bridge is running, and this link works only once. Start the agent first if you can; continuing.',
    )
  }
  const now = io.now()
  ensureDir(p.enrollPending)
  const { codeId, link } = await newCode(relay, cli, files, values.label, now)
  io.out('Open this link on the device you want to add (it works once, for 10 minutes):')
  io.out(link)
  if (!values['no-qr']) {
    io.out('Or point the phone camera at this code:')
    const lines = await cli.renderQr(link)
    if (lines) for (const l of lines) io.out(l)
    else io.out('(The code could not be drawn here; use the link above.)')
  }
  io.out('Waiting for the device… (Ctrl-C to stop; `talos-app enroll --confirm` answers later)')
  while (io.now() - now < CODE_MS) {
    if (files.readConfirm(codeId)) {
      await promptPending(files, codeId, io)
      return 0
    }
    if (!files.readPending(codeId)) {
      io.out('This code was used or removed.')
      return 0
    }
    await io.sleep(500)
  }
  io.out('Timed out. Run `talos-app enroll` again for a new link.')
  return 0
}

type JsonEvent =
  | { event: 'warning'; code: 'bridge_not_live'; text: string }
  | { event: 'link'; link: string; expires_at: string }
  | { event: 'confirm'; device_name: string; words: string[] }
  | { event: 'answered'; yes: boolean }
  | { event: 'pinned'; device_id: string }
  | { event: 'not_pinned'; code: 'timeout' }
  | { event: 'used' }
  | { event: 'expired' }
  | { event: 'error'; code: 'usage' | 'key_refused' | 'relay' | 'bad_words' | 'internal'; text: string }

function emit(io: EnrollIO, e: JsonEvent) {
  ;(io.emit ?? writeStdout)(JSON.stringify(e))
}
/** The last event, and the exit code that goes with it (0: pinned, or answered no). */
function jsonEnd(io: EnrollIO, e: JsonEvent): number {
  emit(io, e)
  return e.event === 'pinned' || (e.event === 'answered' && !e.yes) ? 0 : 1
}

/** The code this `enroll --json` made, so a failure answers no only for its own open question. */
const enrollingNow = new Set<string>()

async function enrollJson(env: BridgeEnv, label: string | undefined, io: EnrollIO, cli: EnrollCli, files: EnrollFiles) {
  const p = paths(env.home)
  let made: Awaited<ReturnType<typeof newCode>>
  try {
    const relay = { http: await cli.http(), url: cli.relayUrl() }
    const bridge = cli.bridge()
    if (bridge.level !== 'ok') emit(io, { event: 'warning', code: 'bridge_not_live', text: bridge.text })
    ensureDir(p.enrollPending)
    made = await newCode(relay, cli, files, label, io.now())
  } catch (e) {
    const refused = (e as { keyRefused?: boolean }).keyRefused === true
    return jsonEnd(io, { event: 'error', code: refused ? 'key_refused' : 'relay', text: (e as Error).message })
  }
  enrollingNow.add(made.codeId)
  const now = io.now()
  emit(io, { event: 'link', link: made.link, expires_at: made.expiresAt })
  while (io.now() - now < CODE_MS) {
    const c = files.readConfirm(made.codeId)
    if (c) {
      const words = wordsOf(c)
      if (!plainWords(words)) {
        files.writeAnswer(made.codeId, { yes: false, device_id: c.device_id })
        return jsonEnd(io, { event: 'error', code: 'bad_words', text: 'the device record holds no four plain words' })
      }
      emit(io, { event: 'confirm', device_name: cleanDeviceName(c.name), words })
      const before = io.now() // a pin from this answer is stamped after this, whatever the answer and emit take
      const ok = await answerFor(files, made.codeId, c.device_id, '', io, jsonYes)
      if (ok === null) return jsonEnd(io, { event: 'used' })
      if (!ok) return jsonEnd(io, { event: 'answered', yes: false })
      emit(io, { event: 'answered', yes: true })
      const store = new DeviceStore(p.devicesJson)
      const asked = io.now()
      while (io.now() - asked < PIN_WAIT_MS) {
        const d = store.get(c.device_id)
        // pinned by this answer: a device pinned before it would say nothing about this run
        if (d?.pinned_at && !d.revoked_at && Date.parse(d.pinned_at) >= before - 1000)
          return jsonEnd(io, { event: 'pinned', device_id: c.device_id })
        await io.sleep(500)
      }
      return jsonEnd(io, { event: 'not_pinned', code: 'timeout' })
    }
    if (!files.readPending(made.codeId)) return jsonEnd(io, { event: 'used' })
    await io.sleep(500)
  }
  return jsonEnd(io, { event: 'expired' })
}
