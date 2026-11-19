// The bridge side of the Mac app's screen helper: one request over `$TALOS_APP_HOME/run/screen.sock` (TalosDesktopCore
// ScreenSocket.swift), one JSON line each way. Every way this can fail becomes one plain sentence at once: the app is not
// running, macOS has not given it a permission, the app is not on the owner's list, the filter cannot be made, no answer in
// time. Nothing here waits on a person or raises a dialog.
import { lstatSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { BridgeContext } from './context.ts'

export const screenSockPath = (home: string) => join(home, 'run', 'screen.sock')

/** How long one request may take before the agent is told (the app gives up on its side at 20 s). */
export const SCREEN_TIMEOUT_MS = 15_000
/** The longest answer read: a screenshot is a PNG of at most 1568 pixels a side, base64. */
export const SCREEN_MAX_ANSWER_BYTES = 48 * 1024 * 1024

export const SCREEN_TEXT = {
  notMac: 'The screen tools work only on a Mac running Talos.app. Nothing was done.',
  notRunning: "Talos.app isn't running on this Mac, so the screen tools can't work right now. Nothing was done.",
  notOurs: "The screen socket on this Mac isn't Talos's own (another user owns it), so nothing was sent.",
  noAnswer: `Talos.app didn't answer within ${SCREEN_TIMEOUT_MS / 1000} s. The action may or may not have happened; take a screenshot to check.`,
  badAnswer: 'Talos.app sent an answer the bridge cannot read. Nothing more will happen from this request.',
  screenGrant:
    "macOS hasn't allowed Talos to see the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
  controlGrant:
    "macOS hasn't allowed Talos to control the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
  notAllowed: (app: string) => `${app} isn't on this Mac's allowed list yet.`,
  locked:
    'The Mac is locked (or the screen saver is on); Talos does nothing until the owner unlocks it. Nothing was done.',
  systemPrompt: (app: string) => `A system prompt (${app}) is in front; Talos won't act on it. The owner answers it.`,
  denied: (app: string) =>
    `${app} is part of the Mac's lock screen or its security prompts. Talos never lets an agent use it and never asks the owner to allow it. Nothing was done.`,
  filterUnavailable:
    "Talos couldn't limit the screenshot to the apps allowed on this Mac, so it took no screenshot. Nothing was shown.",
} as const

/**
 * System processes that draw the lock screen, the screen saver or a password and authorisation prompt. An agent is never offered
 * them: they are not put on the allowed list, no consent card is made for them and the Mac refuses them even from a list.
 * Kept equal to `ScreenDenied.bundleIDs` in TalosDesktopCore (ScreenDenied.swift); ids read from this Mac's own bundles.
 */
export const SCREEN_DENIED_BUNDLES: readonly string[] = [
  'com.apple.loginwindow',
  'com.apple.SecurityAgent',
  'com.apple.ScreenSaver.Engine',
  'com.apple.LockScreen',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.coreautha',
  'com.apple.UserNotificationCenter',
  'com.apple.NetAuthAgent',
  'com.apple.EscrowSecurityAlert',
  'com.apple.security.Keychain-Circle-Notification',
  'com.apple.mcx.MCXDiskAuthorization',
  'com.apple.coreservices.uiagent', // the "Open?" prompt for a downloaded app (Gatekeeper)
  'com.apple.accessibility.universalAccessAuthWarn', // the "control this computer" Accessibility prompt
  'com.apple.UniversalAccessControl', // the privacy (TCC) permission UI
  'com.apple.AskPermissionUI', // Ask to Buy and Screen Time permission requests
  'com.apple.AOSAlertManager', // Apple ID and Find My alerts, including a remote lock
  'com.apple.IOUIAgent', // "allow this accessory to connect" prompts
  'com.apple.FileSystemUIAgent', // password prompts for encrypted volumes
  'com.apple.frameworks.diskimages.diuiagent', // disk image password and licence prompts
]

/** True for a system lock, screen saver or auth prompt process (compared without regard to case). */
export const isDeniedScreenApp = (bundleId: string): boolean => {
  const b = bundleId.trim().toLowerCase()
  return SCREEN_DENIED_BUNDLES.some((d) => d.toLowerCase() === b)
}

export type ScreenAnswer =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false
      code: string
      text: string
      app?: string
      /** With `app_not_allowed`: the Mac measured the app and kept it under this id (`ask_info`). */
      ask?: string
      /** With `ask`: the app's name as macOS shows it (the app's own words: one line, clipped, before it is shown). */
      app_name?: string
    }

/** One request to the Mac's screen socket. Tests replace it. */
export const screenTransport = {
  request: (ctx: BridgeContext, req: Record<string, unknown>): Promise<ScreenAnswer> =>
    screenRequest(ctx.paths.home, req),
}

const one = (s: string, max = 300) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** The sentence an agent reads for a refusal: Talos's own words for the codes it knows, the app's text for any other. */
export function refusalText(a: { code: string; text: string; app?: string }): string {
  switch (a.code) {
    case 'screen_recording_not_granted':
      return SCREEN_TEXT.screenGrant
    case 'accessibility_not_granted':
      return SCREEN_TEXT.controlGrant
    case 'app_not_allowed':
      return SCREEN_TEXT.notAllowed(one(a.app || 'That app', 200))
    case 'screen_locked':
      return SCREEN_TEXT.locked
    case 'system_prompt':
      return SCREEN_TEXT.systemPrompt(one(a.app || 'an app', 80))
    case 'filter_unavailable':
      return a.text ? one(a.text) : SCREEN_TEXT.filterUnavailable
    case 'not_mac':
      return SCREEN_TEXT.notMac
    case 'not_running':
      return SCREEN_TEXT.notRunning
    case 'not_ours':
      return SCREEN_TEXT.notOurs
    case 'no_answer':
      return SCREEN_TEXT.noAnswer
    case 'bad_answer':
      return SCREEN_TEXT.badAnswer
    default:
      return a.text
        ? one(a.text)
        : `The screen helper refused (${one(a.code, 60) || 'no reason given'}). Nothing was done.`
  }
}

export type ScreenDeps = {
  platform?: string
  uid?: number
  timeoutMs?: number
  maxBytes?: number
}

/** Sends one request and reads one answer. Never throws; never waits past the timeout. */
export async function screenRequest(
  home: string,
  req: Record<string, unknown>,
  deps: ScreenDeps = {},
): Promise<ScreenAnswer> {
  const refused = (code: string): ScreenAnswer => ({ ok: false, code, text: '' })
  if ((deps.platform ?? process.platform) !== 'darwin') return refused('not_mac')
  const path = screenSockPath(home)
  try {
    const st = lstatSync(path)
    if (!st.isSocket()) return refused('not_running')
    const uid = deps.uid ?? process.getuid?.()
    if (uid !== undefined && st.uid !== uid) return refused('not_ours')
  } catch {
    return refused('not_running')
  }
  const timeoutMs = deps.timeoutMs ?? SCREEN_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? SCREEN_MAX_ANSWER_BYTES
  return await new Promise<ScreenAnswer>((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    let connected = false
    const sock = connect(path)
    const done = (a: ScreenAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(a)
    }
    const timer = setTimeout(() => done(refused('no_answer')), timeoutMs)
    sock.on('connect', () => {
      connected = true
      sock.write(`${JSON.stringify({ v: 1, ...req })}\n`)
    })
    sock.on('error', (e: NodeJS.ErrnoException) =>
      done(refused(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'not_running' : 'bad_answer')),
    )
    sock.on('close', () => done(refused(connected ? 'bad_answer' : 'not_running')))
    // the app closed its side with no full line: never a success (Bun may not follow an 'end' with 'close')
    sock.on('end', () => done(refused('bad_answer')))
    sock.on('data', (b: Buffer) => {
      const nl = b.indexOf(0x0a)
      const part = nl >= 0 ? b.subarray(0, nl) : b
      size += part.length
      if (size > maxBytes) return done(refused('bad_answer'))
      chunks.push(part)
      if (nl >= 0) done(parseAnswer(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

/** One answer line. Anything that is not the app's shape is `bad_answer`, never a success. */
export function parseAnswer(line: string): ScreenAnswer {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return { ok: false, code: 'bad_answer', text: '' }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, code: 'bad_answer', text: '' }
  const r = o as Record<string, unknown>
  if (r.ok === true) return { ok: true, body: r }
  const e = r.error as Record<string, unknown> | undefined
  if (r.ok !== false || typeof e !== 'object' || e === null || typeof e.code !== 'string')
    return { ok: false, code: 'bad_answer', text: '' }
  return {
    ok: false,
    code: e.code,
    text: typeof e.text === 'string' ? e.text : '',
    ...(typeof e.app === 'string' ? { app: e.app } : {}),
    ...(typeof e.ask === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(e.ask) ? { ask: e.ask } : {}),
    ...(typeof e.app_name === 'string' ? { app_name: e.app_name } : {}),
  }
}
