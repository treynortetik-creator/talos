// The JS bridge between the web app and a native shell (a Mac app or an iPhone app that hosts the app in a web view).
// Version 1 of the shell API. Every message is a JSON object with a `type`; every schema is strict, so a field either
// side does not know about is refused rather than ignored. The web side validates what it receives from the shell and
// the shell validates what it receives from the page. Shells cannot do passkeys in a web view; they sign in with the
// one-time setup code (`POST /api/auth/enroll/session`, docs/SPEC.md 5.3).
//
//   web -> native   ready · notify · badge · open_external · haptic · threads · pair_status · companion_state · companion_reply · terminal_view · terminal_resume · terminal_leave
//   native -> web   navigate · compose · voice_note (reserved) · enroll_code · companion_reply_request · notify_permission · terminal_sessions · terminal_resume_result · terminal_select
import { z } from 'zod'
import { normalizeEnrollCode } from './enroll.ts'
import { ThreadId } from './ids.ts'

export const NATIVE_SHELL_API = 1
export const NATIVE_FEATURES_MAX = 32
/** A voice note a shell hands to the page is at most 25 MB of audio (decoded). Reserved: no shell sends one yet. */
export const NATIVE_VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024

const Feature = z.string().min(1).max(64)
/**
 * An in-app path: starts with a single "/", only URL-safe characters (no backslash, whitespace, control character or
 * quote), resolves to the same origin whatever the base is, and never into the media or API spaces. A shell may resolve it
 * against the relay origin, so every string that a URL parser would send elsewhere is refused (WP-N0 review F3).
 */
const APP_PATH_BASE = 'https://app.invalid'
const AppPath = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/)
  .refine((p) => {
    try {
      const u = new URL(p, APP_PATH_BASE)
      // Percent-escapes are decoded before the rule is applied, so "/%6dedia" and "/%61pi" are the media and API spaces.
      // Decoding repeats until stable, so a double-encoded spelling ("%256dedia") cannot hide either.
      let decoded = u.pathname
      for (let i = 0; i < 4; i++) {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break
        decoded = next
      }
      return (
        u.origin === APP_PATH_BASE &&
        !decoded.startsWith('//') &&
        !decoded.includes('\\') &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
        !/[\u0000-\u001f\u007f]/.test(decoded) &&
        !/^\/(media|api|bridge|hook|ws)(\/|$)/i.test(decoded)
      )
    } catch {
      return false
    }
  }, 'not an in-app path')

const ExternalUrl = z
  .string()
  .max(2048)
  .regex(/^(https?:\/\/|mailto:)/i)
  .refine((u) => {
    try {
      return ['http:', 'https:', 'mailto:'].includes(new URL(u).protocol)
    } catch {
      return false
    }
  }, 'http(s) or mailto only')

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape })

// ---- web -> native ----------------------------------------------------------------------------------------------

export const NativeReady = msg('ready', {
  shell_api: z.literal(NATIVE_SHELL_API),
  features: z.array(Feature).max(NATIVE_FEATURES_MAX),
  signed_in: z.boolean(),
})
export const NativeNotify = msg('notify', {
  title: z.string().max(200),
  body: z.string().max(2000),
  navigate: AppPath,
  tag: z.string().min(1).max(100).optional(),
})
export const NativeBadge = msg('badge', { count: z.number().int().min(0).max(99_999) })
export const NativeOpenExternal = msg('open_external', { url: ExternalUrl })
export const NativeHaptic = msg('haptic', {
  kind: z.enum(['light', 'medium', 'heavy', 'selection', 'success', 'warning', 'error']),
})
export const NativeThreads = msg('threads', {
  items: z.array(z.strictObject({ id: ThreadId, name: z.string().min(1).max(80) })).max(100),
})
export const NativePairStatus = msg('pair_status', { state: z.enum(['waiting_pin', 'pinned', 'failed']) })

// ---- the desktop companion's feed (feature `companion/1`, DESKTOP-COMPANION-SPEC 7) -----
/** The most rows the feed carries (Home's order, one row per thread). */
export const COMPANION_ROWS_MAX = 12
/** The longest last reply the page hands the shell, in characters, after it is turned into plain text. */
export const COMPANION_REPLY_MAX = 500
const CompanionCount = z.number().int().min(0).max(99_999)
/** A request id the shell makes up; the answer carries it back so a late answer to an old click is recognised. */
const CompanionReq = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
/**
 * Counts and ids only: no thread name, no message text, ever (the shell shows names it already has from `threads`).
 * The row `state` is a closed set on this side. The Mac app drops a row with a state it does not know instead of the
 * whole frame, because the page updates through the relay and the shell does not.
 */
const CompanionHeld = z.strictObject({ thread_id: ThreadId, seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
export const NativeCompanionState = msg('companion_state', {
  link: z.enum(['connecting', 'online', 'offline', 'unreachable']),
  mac_online: z.boolean(),
  busy: z.boolean(),
  needs: CompanionCount,
  working: CompanionCount,
  queued: CompanionCount,
  on_call: CompanionCount,
  unread: CompanionCount,
  failed: CompanionCount,
  rows: z
    .array(
      z.strictObject({
        thread_id: ThreadId,
        state: z.enum(['needs_you', 'ready', 'working', 'queued', 'on_call']),
      }),
    )
    .max(COMPANION_ROWS_MAX),
  last_reply: z
    .strictObject({ thread_id: ThreadId, seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
    .nullable(),
  /** The thread on screen, by the page's own routing (a card page counts as its thread), or null. Optional: an older page omits it. */
  viewing: ThreadId.nullable().optional(),
  /** Replies the page held back because the companion said he delivers them (`companion_replies`), at most one per thread. */
  held: z.array(CompanionHeld).max(COMPANION_ROWS_MAX).optional(),
  /** The epoch of the `companion_replies {on:true}` the page last applied, or null while off: the shell ignores `held` from a frame of an older epoch. */
  replies_epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
})
/** The answer to `companion_reply_request`: plain text, at most COMPANION_REPLY_MAX characters, or null. */
export const NativeCompanionReply = msg('companion_reply', {
  req: CompanionReq,
  thread_id: ThreadId,
  text: z.string().max(COMPANION_REPLY_MAX).nullable(),
  truncated: z.boolean(),
})

// ---- the agent terminal inside the Mac app's main window ----
/** The largest coordinate or size the rectangle carries, in page pixels (far past any screen; a bigger one is a bug). */
export const TERMINAL_RECT_MAX = 20_000
const TerminalCoord = z.number().int().min(0).max(TERMINAL_RECT_MAX)
/**
 * Where the page has left room for the Mac app's own terminal view, in page pixels from the top-left of the page, or null
 * when the terminal screen is not showing. The terminal itself is a native view on this Mac: nothing it shows or types
 * crosses this message, and nothing about it goes to the relay. The shell clamps the rectangle to its window.
 */
/**
 * Which session the terminal view shows: "main" (the agent) or a thread id (that thread's own session). The shell derives the
 * tmux session name from the id itself; the page never names a session. A Mac app that predates the tabs refuses a message
 * with this field, so the page leaves it out for Main.
 */
export const TerminalSessionId = z.union([z.literal('main'), ThreadId])
export const NativeTerminalView = msg('terminal_view', {
  rect: z.strictObject({ x: TerminalCoord, y: TerminalCoord, width: TerminalCoord, height: TerminalCoord }).nullable(),
  session: TerminalSessionId.optional(),
})
/** The owner pressed Resume (or Start) on a parked thread's panel in the Terminal screen. The shell asks the thread's worker to start. */
export const NativeTerminalResume = msg('terminal_resume', { thread_id: ThreadId })

/**
 * The Terminal screen was left. `terminal_view` with a null rect only means "no terminal to lay over this space right now"
 * (a parked tab shows its own panel, a dialog is open): the screen is still open and its tab list must keep following the
 * sessions. This is the message that says the screen is gone.
 */
export const NativeTerminalLeave = msg('terminal_leave', {})

export const WEB_TO_NATIVE = {
  ready: NativeReady,
  notify: NativeNotify,
  badge: NativeBadge,
  open_external: NativeOpenExternal,
  haptic: NativeHaptic,
  threads: NativeThreads,
  pair_status: NativePairStatus,
  companion_state: NativeCompanionState,
  companion_reply: NativeCompanionReply,
  terminal_view: NativeTerminalView,
  terminal_resume: NativeTerminalResume,
  terminal_leave: NativeTerminalLeave,
} as const
export const WebToNative = z.discriminatedUnion('type', [
  NativeReady,
  NativeNotify,
  NativeBadge,
  NativeOpenExternal,
  NativeHaptic,
  NativeThreads,
  NativePairStatus,
  NativeCompanionState,
  NativeCompanionReply,
  NativeTerminalView,
  NativeTerminalResume,
  NativeTerminalLeave,
])
export type WebToNativeT = z.infer<typeof WebToNative>

// ---- native -> web ----------------------------------------------------------------------------------------------

/** Standard base64 whose decoded size is at most NATIVE_VOICE_NOTE_MAX_BYTES. */
const Base64Bytes = z
  .string()
  .max(Math.ceil(NATIVE_VOICE_NOTE_MAX_BYTES / 3) * 4) // cheap length cap first: nothing below runs on a huge string
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((s) => {
    if (s.length % 4 !== 0) return false
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
    return (s.length / 4) * 3 - pad <= NATIVE_VOICE_NOTE_MAX_BYTES
  }, 'voice note is over 25 MB or not base64')

export const NativeNavigate = msg('navigate', { path: AppPath })
export const NativeCompose = msg('compose', { thread_id: ThreadId, text: z.string().min(1).max(32_000) })
export const NativeVoiceNote = msg('voice_note', {
  thread_id: ThreadId,
  mime: z.string().regex(/^audio\/[a-z0-9.+-]{1,60}$/i),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .max(60 * 60_000),
  bytes_b64: Base64Bytes,
})
/** The one-time setup code, as the shell read it from the link or the clipboard. */
export const NativeEnrollCode = msg('enroll_code', {
  code: z
    .string()
    .max(64)
    .refine((c) => normalizeEnrollCode(c) !== null, 'not a setup code'),
})
/** The companion wants the newest agent reply in one thread as plain text: for a click on his reply card, or the first line of his reply bubble. */
export const NativeCompanionReplyRequest = msg('companion_reply_request', { req: CompanionReq, thread_id: ThreadId })
/**
 * The Mac companion delivers new replies in other threads himself (his bubble), so the page holds back its own jump banner while
 * `on` is true (it lists what it holds in `companion_state.held`) and toasts what is still held the moment `on` goes false or the
 * shell is lost. Sent whenever it changes, with `shown` whenever he shows held replies, and again after every `ready`; a page that
 * was reloaded, or has no shell, is off.
 */
export const NativeCompanionReplies = msg('companion_replies', {
  on: z.boolean(),
  /** Held replies he has put in front of the owner (bubble or banner): the page drops them from `held`. */
  shown: z.array(CompanionHeld).max(COMPANION_ROWS_MAX).optional(),
  /** Which "on" this is. The page echoes it in `companion_state.replies_epoch`, so a frame sent before the page heard an off cannot be mistaken for a new one. */
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})

/**
 * What macOS says about this app's notification permission, so Settings can tell the truth instead of "not supported".
 * `not_asked` = macOS has not been asked yet (it asks the first time a banner would show); `denied` = turned off in System
 * Settings. Sent when the page is ready and whenever the app comes to the front. A value the page does not know is refused.
 */
export const NativeNotifyPermission = msg('notify_permission', { state: z.enum(['granted', 'denied', 'not_asked']) })

// ---- the Terminal screen's session tabs ----
export const TERMINAL_SESSIONS_MAX = 101
export const TERMINAL_SESSION_STATES = [
  'live',
  'working',
  'idle',
  'starting',
  'parked',
  'stopping',
  'failed',
  'needs_you',
  'not_started',
  'unknown',
] as const
/** What the area under the tabs shows: the raw terminal, a Resume/Start panel, the error, or a plain note. */
export const TERMINAL_PANELS = ['terminal', 'resume', 'error', 'note'] as const
export const TerminalSessionItem = z.object({
  id: TerminalSessionId,
  name: z.string().min(1).max(80),
  /** A state this page does not know reads as "unknown": that tab degrades, the list stays. */
  state: z.enum(TERMINAL_SESSION_STATES).catch('unknown'),
  /** The digit of the Ctrl+digit shortcut that switches to this tab, or null past the ninth. */
  key: z
    .string()
    .regex(/^[1-9]$/)
    .nullable()
    .catch(null),
  panel: z.enum(TERMINAL_PANELS).catch('note'),
  /** The button on a "resume" panel. */
  action: z.enum(['resume', 'start']).nullable().catch(null),
  /** One plain sentence: why it stopped, what it waits on, the error. */
  detail: z.string().max(600).catch(''),
})
export type TerminalSessionItemT = z.infer<typeof TerminalSessionItem>
/**
 * Every session the Terminal screen can show a tab for, pushed when the list changes. One item that cannot be read (a bad id,
 * a missing name) is dropped and the rest stay; an unknown state or panel degrades that one tab. Fields a newer shell adds are
 * ignored, not refused: the list is for display and nothing it carries leaves the page.
 */
export const NativeTerminalSessions = z.object({
  type: z.literal('terminal_sessions'),
  items: z
    .array(z.unknown())
    .max(TERMINAL_SESSIONS_MAX)
    .transform((raw) =>
      raw.flatMap((r) => {
        const p = TerminalSessionItem.safeParse(r)
        return p.success ? [p.data] : []
      }),
    ),
})
/** What the shell said to the last Resume/Start press (its `requestResume` outcomes). */
export const TERMINAL_RESUME_OUTCOMES = ['asked', 'already_pending', 'park_pending', 'failed'] as const
export const NativeTerminalResumeResult = msg('terminal_resume_result', {
  thread_id: ThreadId,
  outcome: z.enum(TERMINAL_RESUME_OUTCOMES),
})

/** The owner pressed Ctrl+1 to Ctrl+9 with the Mac's terminal holding the keyboard: the shell switched the tab and says which. */
export const NativeTerminalSelect = msg('terminal_select', { session: TerminalSessionId })

export const NATIVE_TO_WEB = {
  navigate: NativeNavigate,
  compose: NativeCompose,
  voice_note: NativeVoiceNote,
  enroll_code: NativeEnrollCode,
  companion_reply_request: NativeCompanionReplyRequest,
  companion_replies: NativeCompanionReplies,
  notify_permission: NativeNotifyPermission,
  terminal_sessions: NativeTerminalSessions,
  terminal_resume_result: NativeTerminalResumeResult,
  terminal_select: NativeTerminalSelect,
} as const
export const NativeToWeb = z.discriminatedUnion('type', [
  NativeNavigate,
  NativeCompose,
  NativeVoiceNote,
  NativeEnrollCode,
  NativeCompanionReplyRequest,
  NativeCompanionReplies,
  NativeNotifyPermission,
  NativeTerminalSessions,
  NativeTerminalResumeResult,
  NativeTerminalSelect,
])
export type NativeToWebT = z.infer<typeof NativeToWeb>

/** The JSON Schema of one message, for the fixtures the native apps are built against (scripts/native-fixtures.ts). */
export const nativeJsonSchema = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { unrepresentable: 'any' })
