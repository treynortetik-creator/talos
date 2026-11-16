// The app's words for the agent's computer, from the bridge's host feature (packages/protocol/src/host.ts). "Your
// computer" when the host is not known: an older bridge, or a device not pinned yet (it gets no presence features).
import { type Host, hostOf } from '@talos-app/protocol'
import { useTalos } from './client.ts'

export type HostWords = {
  /** "your Mac", "your PC", "your computer" */
  computer: string
  /** The agent's computer is not reachable. */
  offline: string
  /** The running session needs a restart for a change to take effect. */
  restart: string
  /** Where the owner puts back the last good setup: it is never done from the phone. */
  restore: string
  /** What runs the agent there: "the Mac app", "Talos". */
  app: string
  /**
   * Claude Code there is not signed in (presence.main is `signin`): what to do, in plain words. Null where the host sends
   * no such state (a Mac's supervisor publishes none yet), so the app shows no banner rather than a wrong one.
   */
  signin: string | null
}

export function hostWords(host: Host | null): HostWords {
  if (host === 'mac')
    return {
      computer: 'your Mac',
      app: 'the Mac app',
      offline: 'Your Mac is offline.',
      restart:
        'On your Mac, choose Restart session in the Talos menu bar, or quit and restart Claude Code in your terminal.',
      signin: null,
      restore: 'To put back the last good setup, use the Talos menu on your Mac: Restore last good setup.',
    }
  if (host === 'windows')
    return {
      computer: 'your PC',
      app: 'Talos',
      offline: 'Your PC is off or asleep. Talos answers again when it is on.',
      restart: 'Talos needs a restart on your PC: click the Talos icon by the clock, then Restart Talos.',
      signin: 'Claude needs you to sign in on your PC: use the Talos icon by the clock, Sign in to Claude.',
      restore: 'To put back the last good setup, use the Talos icon by the clock on your PC: Restore last good setup.',
    }
  return {
    computer: 'your computer',
    app: 'Talos',
    offline: 'Your computer is offline.',
    restart: 'On your computer, restart Talos (or quit and restart Claude Code in its terminal).',
    signin: 'Claude needs you to sign in on your computer: open Claude Code there and sign in.',
    restore: 'To put back the last good setup, do it on your computer, not from here.',
  }
}

export function useHostWords(): HostWords {
  return hostWords(useHost())
}

// The last host this device heard, kept on the device: before sign-in (login, enroll) and while not connected there are no
// presence features, and a returning Mac owner should still read the Mac words there. Only 'mac' | 'windows' | 'linux'.
const HOST_KEY = 'talos.host'
export function rememberHost(host: Host | null): void {
  if (!host) return
  try {
    if (localStorage.getItem(HOST_KEY) !== host) localStorage.setItem(HOST_KEY, host)
  } catch {
    // storage blocked (private window): the words fall back to "your computer"
  }
}
export function rememberedHost(): Host | null {
  try {
    const h = localStorage.getItem(HOST_KEY)
    return h === 'mac' || h === 'windows' || h === 'linux' ? h : null
  } catch {
    return null
  }
}

/** The agent's computer: from the bridge's live features, else the last one this device heard, else unknown. */
export const hostFrom = (features: readonly string[] | undefined): Host | null => hostOf(features) ?? rememberedHost()
export function useHost(): Host | null {
  return hostFrom(useTalos((s) => s.presence.features))
}

/**
 * A Mac sentence for the host it is shown on. On a Mac it is the very same text, byte for byte. Elsewhere only the place
 * words change: "your Mac", "the Mac", "a Mac" → "your computer", "this Mac" → "this computer", "Mac online/offline" →
 * "Computer online/offline". "Mac app" is never touched (that is the viewer, not the agent's computer). A sentence that
 * names a Mac-only control or command does not go through here: it gets its own words per host (hostSteps).
 */
export function placeWords(text: string, host: Host | null): string {
  if (host === 'mac') return text
  // a Windows PC is "your PC" everywhere, as its tray says ("Server accepts this PC"); Linux and unknown, "your computer"
  const n = host === 'windows' ? 'PC' : 'computer'
  return text
    .replace(/\b([Yy])our Mac\b(?! app)/g, `$1our ${n}`)
    .replace(/'s Mac\b(?! app)/g, `'s ${n}`) // "Talos's Mac is offline", whatever the name
    .replace(/\b([Tt])his Mac\b(?! app)/g, `$1his ${n}`)
    .replace(/\bThe Mac\b(?! app)/g, `Your ${n}`)
    .replace(/\b(?:the|a) Mac\b(?! app)/g, `your ${n}`)
    .replace(/\bMac (online|offline)\b/g, `${host === 'windows' ? 'PC' : 'Computer'} $1`)
}

/**
 * Sentences that name a command or a control, in each host's real words (Linux: Hestia; Windows: Titan, 2026-11-14). A
 * Mac's are the app's sentences as they were, byte for byte. Where a host has no way to do it yet, the sentence says so.
 */
export type HostSteps = {
  /** The bridge's key was refused by the server: how to get the key line. */
  keyFix: string
  /** A second bridge took over and both are gone: what to do. */
  superseded: string
  /** Offline long enough to be asleep or stopped: what to check. `days` is the relay's buffer, "7 days". */
  asleep: (days: string) => string
  /** The mod stopped reporting: what to check. */
  modQuiet: string
  /** Sign-in screen, a device whose key could not be proved: how to set it up again. */
  loginProof: string
  /** A thread session stopped at a question only the computer can show: where to answer it. */
  answerThere: string
  /** A thread session stopped for a reason this version does not know: where to look. */
  lookThere: string
  /** Another bridge took over with the same key, and the owner did not start one: what to do. */
  rotate: string
  /** A dialog card whose prompt can't be shown in the app: where to answer it. */
  dialogHere: string
  /** A dialog card nobody answered in time. */
  dialogExpired: string
}

const MAC_STEPS: HostSteps = {
  keyFix:
    'On the Mac, run talos-app doctor. It prints the key line your server needs: paste it into your server settings and deploy again. The setup guide has the steps.',
  superseded:
    'The older bridge reconnects on its own within a minute or two. If it does not, restart the Claude session on your Mac. If you did not start a second bridge, run talos-app rotate on the Mac.',
  asleep: (days) =>
    `Wake the Mac and check that Claude is still running in its terminal. Your messages wait on the server for up to ${days}.`,
  modQuiet: 'Check that Claude is still running on your Mac with the Talos mod loaded.',
  loginProof: "This device couldn't prove its key. Run talos-app enroll on your Mac to set it up again.",
  answerThere:
    'It stopped at a question only the Mac can answer. Open Talos Terminal on the Mac, pick this thread under Thread sessions, and answer it there. Then press Restart here to start it again',
  lookThere: "It stopped for a reason this version doesn't know. Open Talos Terminal on the Mac to see what happened",
  rotate: 'If you did not start a second bridge on purpose, run talos-app rotate on your Mac.',
  dialogHere: "This prompt can't be shown here. Answer it at the Mac.",
  dialogExpired: 'Expired. Nobody answered in time; the session is still waiting at the Mac.',
}

const PC_TRAY = 'click the Talos icon by the clock'
/**
 * Every way to pair, for a computer not known yet (every first pairing: an unpinned device gets no features). A Mac has no
 * pairing menu item: talos-app enroll in Terminal is its way, as Talos Help says; only the PC's tray has Pair a phone….
 */
export const PAIR_WAYS =
  'on a Mac or Linux, run talos-app enroll in Terminal; on a Windows PC, click the Talos icon by the clock and choose Pair a phone…'

/** Pairing on the PC (Titan's tray, apps/windows/tray.ps1): Pair a phone… shows a code and a link to open on the phone. */
export const PC_PAIR = `On the PC, ${PC_TRAY}, choose Pair a phone…, and open the link it shows on this device (or copy it and paste it here).`
// Until the tray's "Open a thread's session…" is on main (Titan): the honest version. Keep it this one constant.
export const PC_ANSWER =
  "This session is waiting for an answer Talos can't show on your phone, and on a Windows PC it can't be opened yet. Stop the thread and start it again to go on: a question it asks as it starts comes back then, but one it asked in the middle of a task is dropped, and that task ends."

export function hostSteps(host: Host | null): HostSteps {
  if (host === 'mac') return MAC_STEPS
  if (host === 'windows')
    return {
      // Titan's Check Talos... window copies the key the server needs (tray.ps1); the tray writes three dots
      keyFix: `On the PC, ${PC_TRAY}, choose Check Talos..., then Copy the relay key, and set it as BRIDGE_PUBKEY in your server's settings.`,
      superseded: `The older bridge reconnects on its own within a minute or two. If it does not, on the PC, ${PC_TRAY} and choose Restart Talos…; if this keeps happening, send the log folder (Open the log folder in the same menu) to whoever helps you.`,
      asleep: (days) =>
        `Wake the PC and check that Talos is running: ${PC_TRAY} and choose Start Talos. Your messages wait on the server for up to ${days}.`,
      modQuiet: `On the PC, ${PC_TRAY} and choose Restart Talos…. If the mod still does not report, run Talos Setup again.`,
      loginProof: `This device couldn't prove its key. On the PC, ${PC_TRAY}, choose Pair a phone…, and open the new link it shows on this device.`,
      answerThere: PC_ANSWER,
      lookThere: `It stopped for a reason this version doesn't know. On the PC, ${PC_TRAY} and choose Open the log folder; send its logs to whoever helps you.`,
      // a key rotation from the tray is not there yet (a gap): restart is real
      rotate: `If you did not start a second bridge on purpose: a new key can't be made from a Windows PC yet. On the PC, ${PC_TRAY} and choose Restart Talos…; if this keeps happening, send the log folder (Open the log folder in the same menu) to whoever helps you.`,
      // the PC has no terminal to answer it in yet (a gap)
      dialogHere: "This prompt can't be shown here, and Talos on a Windows PC can't open it yet.",
      dialogExpired: 'Expired. Nobody answered in time; the session is still waiting on the PC.',
    }
  // Linux, and a computer not known yet: the same talos-app commands, run on the computer itself. Not known yet is also
  // every first pairing (a device not pinned gets no features): there the sentence names the tray's way too.
  const linux: HostSteps = {
    keyFix:
      'On your computer, run talos-app doctor. It prints the key line your server needs: paste it into your server settings and deploy again. The setup guide has the steps.',
    superseded:
      'The older bridge reconnects on its own within a minute or two. If it does not, restart Talos on your computer. If you did not start a second bridge, run talos-app rotate on your computer.',
    asleep: (days) =>
      `Wake your computer and check that Talos is still running on it. Your messages wait on the server for up to ${days}.`,
    modQuiet: 'Check that Claude is still running on your computer with the Talos mod loaded.',
    loginProof: "This device couldn't prove its key. Run talos-app enroll on your computer to set it up again.",
    answerThere:
      'It stopped at a question only your computer can show. On your computer, run talos-app supervise attach for this thread and answer it there. Then press Restart here to start it again',
    lookThere:
      "It stopped for a reason this version doesn't know. On your computer, run talos-app supervise attach for this thread to see what happened",
    rotate: 'If you did not start a second bridge on purpose, run talos-app rotate on your computer.',
    dialogHere: "This prompt can't be shown here. Answer it at your computer.",
    dialogExpired: 'Expired. Nobody answered in time; the session is still waiting at your computer.',
  }
  return host === 'linux'
    ? linux
    : {
        ...linux,
        loginProof: `This device couldn't prove its key. Set it up again: ${PAIR_WAYS}.`,
      }
}

/** What the agent's computer is called on a label: "Mac", "PC", "Computer". */
export const computerLabel = (host: Host | null): string =>
  host === 'mac' ? 'Mac' : host === 'windows' ? 'PC' : 'Computer'

/** placeWords for the host this screen is showing. */
export function usePlaceWords(): (text: string) => string {
  const host = useHost()
  return (text) => placeWords(text, host)
}

/** "your Mac" → "Your Mac", at the start of a sentence. */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
