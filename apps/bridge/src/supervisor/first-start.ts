// Main's first start with nobody at the pane (Linux and WSL; the Windows install has no terminal). A fresh Claude Code shows a few
// screens before its input box. The supervisor answers only the ones that are Talos's own, and only these ways:
//   theme picker        Enter on the default (a look, nothing more)
//   security notes      Enter (shown when a token is set): only the exact screen, the `Security notes:` heading and
//                       `Press Enter to continue…` last, no cursor, no question, nothing about terms, permissions or
//                       accepting (that waits for the owner). Its text is kept for the owner, once (notesShown): a notice
//                       meant for a person is never hidden, only not waited on.
//   folder trust        "Yes, I trust this folder" only for the configured agent folder, when it holds `.talos-version`
//   MCP consent         "Use this MCP server" only when the one new server is exactly `talos-app`
//   dev-channels        Enter only under the auto-confirm guard (screen.ts decideAutoConfirm), with the root-approved launch
// Trust, MCP consent and the warning are also answered only when root approved this launch (launch-approval.ts). Sign-in, the
// API-key question, the bypass warning and anything unknown are never answered: they are reported (main-state.ts). Nothing is
// answered while anyone is attached to the pane, or when the attached clients cannot be read. Each kind gets at most one Enter
// per start, and at most FIRST_START.maxMoves arrow keys; the caller reads the screen again before every key, so an arrow is
// only ever followed by an Enter once the wanted row is the highlighted one. Captures: apps/desktop/Tests/Fixtures/
// real-first-start-2.1.322 (README). Linux only: the Mac's supervisor shows these screens to the owner.
import {
  type DevChannelScreen,
  keyNotSent,
  type MainLaunchConfig,
  type PtyDialogKey,
  type PtyHost,
} from '@talos-app/protocol'
import { readDialog } from './dialog-reader.ts'
import type { MainStateExtras, MainWaitingKind } from './main-state.ts'
import { classify, clean, decideAutoConfirm, inputBox, liveDevChannels, liveDialog, STRINGS } from './screen.ts'

export const FIRST_START = {
  themeTitle: 'Choose the text style that looks best with your terminal',
  themeHint: 'To change this later, run /theme',
  themeOptions: [
    'Auto (match terminal)',
    'Dark mode',
    'Light mode',
    'Dark mode (colorblind-friendly)',
    'Light mode (colorblind-friendly)',
    'Dark mode (ANSI colors only)',
    'Light mode (ANSI colors only)',
  ],
  notesTitle: 'Security notes:',
  notesContinue: 'Press Enter to continue…',
  loginMethod: 'Select login method:',
  oauth: ['Paste code here if prompted', "Browser didn't open? Use the url below to sign in"],
  apiKey: ['Detected a custom API key in your environment', 'Do you want to use this API key?'],
  trustWorkspace: 'Accessing workspace:',
  trustYes: 'Yes, I trust this folder',
  mcpOne: 'New MCP server found in this project: ',
  mcpUse: 'Use this MCP server',
  server: 'talos-app',
  maxMoves: 4,
} as const

/** What is on screen, read for the first start. */
export type FirstStartScreen =
  | { kind: 'theme'; rows: string[] }
  | { kind: 'security_notes'; text: string[] }
  | { kind: 'signin' }
  | { kind: 'api_key' }
  | { kind: 'trust'; rows: string[]; folder: string | null }
  | { kind: 'mcp_consent'; rows: string[]; servers: string[] | null }
  | { kind: 'dev_channels'; dev: DevChannelScreen }
  | { kind: 'bypass' }
  | { kind: 'unknown' }
  | { kind: 'none' }

const highlighted = (r: string) => r.startsWith(STRINGS.pointer)
/** A row's option label: the cursor, a `1. ` index and the `✔ ` of the current choice removed. */
const label = (r: string) =>
  (highlighted(r) ? r.slice(STRINGS.pointer.length) : r)
    .trim()
    .replace(/^\d+\. */, '')
    .replace(/^✔ /, '')
    .trim()

/** The rows cleaned of borders and padding, blank rows dropped (these screens space their parts with them). */
const trimmed = (rows: string[]): string[] => rows.map(clean).filter((r) => r !== '')

/** The first-start screen on `rows` (the whole visible pane). Anything not read exactly is `none` or `unknown`, never answered. */
export function firstStartScreen(rows: string[]): FirstStartScreen {
  const box = inputBox(rows) !== null
  const dialog = liveDialog(rows)
  if (dialog.kind === 'login_expired') return { kind: 'signin' }
  if (dialog.kind === 'bypass_disclaimer') return { kind: 'bypass' }
  if (liveDevChannels(rows)) {
    const s = classify(rows)
    return s.kind === 'dev_channels' ? { kind: 'dev_channels', dev: s.dev } : { kind: 'unknown' }
  }
  const cleaned = trimmed(rows)
  // trust and MCP consent only when the exact option reader reads them (their options by label, the footer and nothing after):
  // the words quoted in a tool's permission prompt are not the dialog (Fable R4-2)
  if ((dialog.kind === 'trust' || dialog.kind === 'mcp_consent') && readDialog(rows)?.kind !== dialog.kind)
    return { kind: 'unknown' }
  if (dialog.kind === 'trust') {
    const at = cleaned.flatMap((r, i) => (r === FIRST_START.trustWorkspace ? [i] : []))
    const folder = at.length === 1 ? (cleaned[(at[0] as number) + 1] ?? null) : null
    return { kind: 'trust', rows: cleaned, folder }
  }
  if (dialog.kind === 'mcp_consent') {
    const named = cleaned.filter((r) => r.startsWith(FIRST_START.mcpOne))
    const servers = named.length === 1 ? [(named[0] as string).slice(FIRST_START.mcpOne.length)] : null
    return { kind: 'mcp_consent', rows: cleaned, servers }
  }
  // the screens before onboarding is done have no input box under them
  if (box) return { kind: 'none' }
  const one = cleaned.filter(highlighted).length === 1
  // the notes have no cursor: the title, and the continue line as the last row with text
  const notes = cleaned.indexOf(FIRST_START.notesTitle)
  if (notes >= 0 && cleaned[cleaned.length - 1] === FIRST_START.notesContinue) {
    const text = cleaned.slice(notes)
    // a cursor, a question, or a word about agreeing to something is not the notes Claude Code shows: the owner reads it
    const asks = text.some(
      (r) => highlighted(r) || r.includes('?') || /\b(terms|permission|accept|agree|consent)/i.test(r),
    )
    return asks ? { kind: 'unknown' } : { kind: 'security_notes', text }
  }
  if (cleaned.some((r) => FIRST_START.oauth.some((o) => r.startsWith(o)))) return { kind: 'signin' }
  // never answered either way: no cursor needed to say so (a frame drawn without one still reads as sign-in, not "starting")
  if (cleaned.includes(FIRST_START.loginMethod)) return { kind: 'signin' }
  if (FIRST_START.apiKey.every((a) => cleaned.includes(a))) return { kind: 'api_key' }
  const title = cleaned.indexOf(FIRST_START.themeTitle)
  if (title >= 0 && cleaned[title + 1] === FIRST_START.themeHint && one) {
    const h = cleaned.findIndex(highlighted)
    const options = cleaned.slice(title + 2, title + 2 + FIRST_START.themeOptions.length).map(label)
    // the cursor on one of the seven options, never on some other row below them
    const onOption = h >= title + 2 && h < title + 2 + FIRST_START.themeOptions.length
    if (onOption && options.every((o, i) => o === FIRST_START.themeOptions[i])) return { kind: 'theme', rows: cleaned }
    return { kind: 'unknown' }
  }
  if (one && cleaned.some((r) => r.startsWith('Enter to confirm') || r.includes('Esc to cancel')))
    return { kind: 'unknown' }
  return { kind: 'none' }
}

/**
 * The key that brings the cursor to the row labelled `wanted` (Enter once it is there), or null when that row or the cursor is
 * not exactly one row on screen.
 */
export function keyToward(cleaned: readonly string[], wanted: string): PtyDialogKey | null {
  const h = cleaned.flatMap((r, i) => (highlighted(r) ? [i] : []))
  const w = cleaned.flatMap((r, i) => (label(r) === wanted ? [i] : []))
  if (h.length !== 1 || w.length !== 1) return null
  const [hi, wi] = [h[0] as number, w[0] as number]
  return hi === wi ? 'Enter' : wi > hi ? 'Down' : 'Up'
}

export type AnsweredKind = 'theme' | 'security_notes' | 'trust' | 'mcp_consent' | 'dev_channels'

export interface FirstStartContext {
  /** The configured agent folder this start launched in. */
  agentDir: string
  /** The folder holds `.talos-version` (the install made it). */
  talosFolder: boolean
  /** Root approved this exact launch (launch-approval.ts), and the owner's auto_confirm_restart is on. */
  approved: boolean
  /** The channels this launch passed (channelsInArgv). */
  launchChannels: string[]
  /** The pane's attached clients' last key times; [] = nobody attached; null = could not be read. */
  clients: number[] | null
  /** ms since the spawn (monotonic). */
  sinceSpawnMs: number
  startKind: 'cold' | 'crash_restart'
  /** Kinds already given their Enter this start. */
  answered: ReadonlySet<AnsweredKind>
  /** Arrow keys already sent for each kind this start. */
  moves: ReadonlyMap<AnsweredKind, number>
}

export type FirstStartStep =
  | { key: PtyDialogKey; kind: AnsweredKind }
  | { signin: true }
  | { wait: MainWaitingKind; why: string }
  | { none: true }

/** What to do about the screen now: one key, or what to report. Pure; the caller sends the key and records it. */
export function decideFirstStart(s: FirstStartScreen, c: FirstStartContext): FirstStartStep {
  switch (s.kind) {
    case 'none':
      return { none: true }
    case 'signin':
      return { signin: true }
    case 'api_key':
      return { wait: 'api_key', why: 'never answered' }
    case 'bypass':
      return { wait: 'bypass', why: 'never answered' }
    case 'unknown':
      return { wait: 'unknown', why: 'not a screen the supervisor knows' }
    default:
      break
  }
  const kind: AnsweredKind = s.kind
  const wait = (why: string): FirstStartStep => ({ wait: kind, why })
  if (c.clients === null) return wait('the pane’s clients could not be read')
  if (c.clients.length > 0) return wait('someone is attached to the pane')
  if (c.answered.has(kind)) return wait('already answered once this start')
  let key: PtyDialogKey | null
  switch (s.kind) {
    case 'theme':
    case 'security_notes':
      // the default stays: Enter on whatever is highlighted; the notes have only Enter
      return { key: 'Enter', kind }
    case 'trust':
      if (!c.approved) return wait('the launch is not root-approved')
      if (!c.talosFolder) return wait('the folder holds no .talos-version')
      if (s.folder !== c.agentDir) return wait('the folder on screen is not the configured one')
      key = keyToward(s.rows, FIRST_START.trustYes)
      break
    case 'mcp_consent':
      if (!c.approved) return wait('the launch is not root-approved')
      if (s.servers === null || s.servers.length !== 1 || s.servers[0] !== FIRST_START.server)
        return wait('the new server is not exactly talos-app')
      key = keyToward(s.rows, FIRST_START.mcpUse)
      break
    case 'dev_channels': {
      const d = decideAutoConfirm({
        enabled: c.approved,
        isMain: true,
        enterSentThisStart: c.answered.has('dev_channels'),
        screen: s.dev,
        launchChannels: c.launchChannels,
        sealVerified: c.approved,
        sinceSpawnMs: c.sinceSpawnMs,
        // nobody attached (checked above): no client can be typing
        sinceClientKeyMs: Number.MAX_SAFE_INTEGER,
        startKind: c.startKind,
        rateLimitOk: true,
      })
      return d.confirm ? { key: 'Enter', kind } : wait(d.refusal)
    }
  }
  if (key === null) return wait('the wanted option is not exactly one row on screen')
  if (key !== 'Enter' && (c.moves.get(kind) ?? 0) >= FIRST_START.maxMoves)
    return wait('the cursor did not reach the option')
  return { key, kind }
}

/** One start's first-start answers (first-start.ts), and what it reports. */
export type FirstStartState = {
  approved: boolean
  talosFolder: boolean
  channels: string[]
  answered: Set<AnsweredKind>
  moves: Map<AnsweredKind, number>
  extras: MainStateExtras
  /** Claude Code's last answer on screen is a 401: the token was refused (oauth-token.ts tokenRefused). */
  refused?: boolean
  /** first_start_signin was written for this start (it is said once per start). */
  signinSaid?: boolean
  /** The screen as last read: a key goes only to a screen read the same twice in a row (no key into a redraw). */
  lastScreen?: string
  /** The screen the last key went to: no key goes to it again (a redraw that lags a tick never takes a second arrow). */
  keyedScreen?: string
  /** Ticks the screen has stayed the one the last key went to: past STILL_AFTER_KEY the start waits, said once. */
  stillAfterKey?: number
  /** The notes screen whose text could not be saved: not tried again (nor audited again) until the screen changes. */
  notesFailedOn?: string
  /** The screen keys were last not sent to (refused by the key guard, or failed), and how many times in a row. */
  unsentOn?: string
  unsentCount?: number
}

/** Keys not sent to one screen before the start waits on it, said once, until the screen changes (Fable R4-5). */
const UNSENT_KEYS = 3

/** Ticks a screen may stay what it was when a key went to it before the start is reported waiting (the key did nothing). */
const STILL_AFTER_KEY = 5

/** What the state file adds for this start: the first-start wait, or sign-in (a sign-in screen or a refused token). */
export const firstStartExtras = (f: FirstStartState): MainStateExtras => (f.refused ? { signin: true } : f.extras)

/** A start's state: whether root approved it (and the owner's auto_confirm_restart allows answering), read once at the start. */
export function newFirstStart(
  d: { approved: (cfg: MainLaunchConfig) => boolean; talosFolder: (agentDir: string) => boolean },
  cfg: MainLaunchConfig,
  channels: string[],
): FirstStartState {
  return {
    // the owner's auto_confirm_restart switch turns every answer but the theme off
    approved: cfg.autoConfirmRestart && d.approved(cfg),
    talosFolder: d.talosFolder(cfg.agentDir),
    channels,
    answered: new Set(),
    moves: new Map(),
    extras: {},
  }
}

/**
 * One step of the first start: at most one key to the pane, after reading who is attached. True when a key was sent. What is
 * not answered is kept for the state file: sign-in, or the kind waiting (with the screen for `unknown`). A key whose sending
 * timed out still counts (an Enter is never sent twice for one kind); a key the key guard refused, or that failed, answered
 * nothing: it is tried again on later ticks, and after UNSENT_KEYS on the same screen the start waits on it (said once) until
 * the screen changes.
 */
export async function firstStartStep(
  d: {
    host: Pick<PtyHost, 'clientActivities' | 'sendDialogKey'>
    audit: (e: string, f?: Record<string, string>) => void
    /** The security notes' text, once, right before their Enter: kept where the owner reads it (cli.ts). False: it could
     * not be kept, and the Enter is withheld (a notice meant for a person is never answered unseen). */
    notesShown?: (text: string[]) => boolean
  },
  l: { agentDir: string; kind: string },
  f: FirstStartState,
  rows: string[],
  sinceS: number,
): Promise<boolean> {
  const screen = firstStartScreen(rows)
  // a key only ever goes to a screen read the same twice in a row: an arrow's redraw, or a dialog still drawing, waits a tick
  const seen = rows.join('\n')
  const stable = f.lastScreen === seen
  f.lastScreen = seen
  // still the screen the last key went to: its redraw has not come yet, so nothing more is sent to it
  if (f.keyedScreen !== undefined) {
    if (f.keyedScreen === seen) {
      f.stillAfterKey = (f.stillAfterKey ?? 0) + 1
      if (f.stillAfterKey === STILL_AFTER_KEY)
        d.audit('first_start_waiting', { kind: 'unknown', why: 'the screen did not change after a key' })
      if (f.stillAfterKey >= STILL_AFTER_KEY) f.extras = { waiting: 'unknown', screen: rows }
      return false
    }
    f.keyedScreen = undefined
    f.stillAfterKey = 0
  }
  if (screen.kind === 'none') {
    f.extras = {}
    return false
  }
  const step = decideFirstStart(screen, {
    agentDir: l.agentDir,
    talosFolder: f.talosFolder,
    approved: f.approved,
    launchChannels: f.channels,
    clients: await d.host.clientActivities(),
    sinceSpawnMs: sinceS * 1000,
    startKind: l.kind === 'crash_restart' ? 'crash_restart' : 'cold',
    answered: f.answered,
    moves: f.moves,
  })
  if ('key' in step) {
    if (!stable) return false
    if (f.unsentOn === seen && (f.unsentCount ?? 0) >= UNSENT_KEYS) return false
    // who is attached, read again right before the key: an owner who attached meanwhile gets the screen untouched
    const again = await d.host.clientActivities()
    if (again === null || again.length > 0) {
      f.extras = { waiting: step.kind }
      return false
    }
    if (step.kind === 'security_notes' && screen.kind === 'security_notes') {
      // saved once per notes screen: a failure is not tried (nor audited) again every tick, only when the screen changes
      if (f.notesFailedOn === seen) return false
      if (d.notesShown?.(screen.text) === false) {
        f.notesFailedOn = seen
        d.audit('first_start_waiting', { kind: 'security_notes', why: 'its text could not be kept for the owner' })
        f.extras = { waiting: 'security_notes' }
        return false
      }
    }
  }
  if ('none' in step) f.extras = {}
  else if ('signin' in step) {
    // said once in the log as it starts (main-state carries it for the tray): a sign-in Claude Code waits for is never answered
    if (!f.signinSaid) d.audit('first_start_signin', { why: 'a sign-in screen' })
    f.signinSaid = true
    f.extras = { signin: true }
  } else if ('wait' in step) {
    if (f.extras.waiting !== step.wait) d.audit('first_start_waiting', { kind: step.wait, why: step.why })
    f.extras = { waiting: step.wait, ...(step.wait === 'unknown' ? { screen: rows } : {}) }
  } else {
    const sent = await d.host.sendDialogKey(step.key, step.kind)
    d.audit('first_start_key', { kind: step.kind, key: step.key, sent })
    // a key that did not go (refused by the guard, or failed) answered nothing: looked at again next tick (Fable R3-1), and
    // after UNSENT_KEYS on this screen the start waits on it where the owner sees it (Fable R4-5)
    if (keyNotSent(sent)) {
      f.unsentCount = f.unsentOn === seen ? (f.unsentCount ?? 0) + 1 : 1
      f.unsentOn = seen
      if (f.unsentCount === UNSENT_KEYS) {
        d.audit('first_start_waiting', { kind: step.kind, why: `its key was not sent (${sent})` })
        f.extras = { waiting: step.kind }
      }
      return false
    }
    f.unsentOn = undefined
    f.unsentCount = 0
    if (step.key === 'Enter') f.answered.add(step.kind)
    else f.moves.set(step.kind, (f.moves.get(step.kind) ?? 0) + 1)
    f.keyedScreen = seen
    f.stillAfterKey = 0
    f.extras = {}
    return true
  }
  return false
}

/**
 * The sign-in state of this start's screen, noted on `f`: a 401 answer row counts while it is Main's latest answer and its input
 * box is up, at any time in a start (a token expired or revoked mid-session is reported, never left silent). A reply that writes
 * the same words reads the same: that costs an amber tray until the next answer, and a restart only on a NEW token from the tray
 * (TokenRestart). Said once per start in the log (main-state carries it for the tray).
 */
export function noteSignin(
  f: { signinSaid?: boolean; refused?: boolean },
  rows: string[],
  audit: (event: string, fields?: Record<string, string>) => void,
  read: {
    claudeIsReady: (r: string[]) => boolean
    tokenRefused: (r: string[]) => boolean
    notLoggedIn: (r: string[]) => boolean
  },
): void {
  const refused =
    read.claudeIsReady(rows) && read.tokenRefused(rows)
      ? 'the token was refused'
      : read.notLoggedIn(rows)
        ? 'not logged in'
        : null
  if (refused && !f.signinSaid) {
    audit('first_start_signin', { why: refused })
    f.signinSaid = true
  }
  f.refused = refused !== null
}
