// The JS bridge between the web app and a native shell (a Mac app or an iPhone app that hosts the app in a web view).
// Version 1 of the shell API. Every message is a JSON object with a `type`; every schema is strict, so a field either
// side does not know about is refused rather than ignored. The web side validates what it receives from the shell and
// the shell validates what it receives from the page. Shells cannot do passkeys in a web view; they sign in with the
// one-time setup code (`POST /api/auth/enroll/session`, docs/SPEC.md 5.3).
//
//   web -> native   ready · notify · badge · open_external · haptic · threads · pair_status · companion_state · companion_reply · terminal_view · terminal_resume · terminal_leave · pick_folder · shell_pane · shell_pane_close · run_witness · capture_ack
//   native -> web   navigate · compose · enroll_code · companion_reply_request · notify_permission · terminal_sessions · terminal_resume_result · terminal_select · run_result · folder_picked · capture_drop
import { z } from 'zod'
import { normalizeEnrollCode } from './enroll.ts'
import { MsgId, ThreadId } from './ids.ts'

export const NATIVE_SHELL_API = 1
export const NATIVE_FEATURES_MAX = 32

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

// ---- the folder picker (Mac app): the Mac's own open panel for a thread's folder ----
/** The feature the Mac app lists in its user agent (`TalosFeatures/pick-folder`) when it can answer `pick_folder`. */
export const SHELL_FEATURE_PICK_FOLDER = 'pick-folder'
/** A request id the page makes up; the answer carries it back. Same shape as the companion's. */
const PickReq = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const PICK_PATH = /^\/[^\u0000-\u001f\u007f]*$/
const PickPath = z.string().max(512).regex(PICK_PATH)
/**
 * The owner pressed Choose… next to a thread's folder. The shell shows its open panel (folders only, nothing created) at
 * `start` when it is given, and answers `folder_picked`. The page never names what the panel may choose; it only says where to begin.
 */
export const NativePickFolder = msg('pick_folder', { req: PickReq, start: PickPath.optional() })

// ---- the owner's own shell in the Mac app's Terminal pane (docs/TERMINAL-PANE.md) ----
/** The feature the Mac app lists in its user agent (`TalosFeatures/…,shell-pane`) when it lays a shell over the pane's slot. */
export const SHELL_FEATURE_SHELL_PANE = 'shell-pane'
/**
 * Where the page has left room for a thread's Terminal pane, in page pixels from the top-left of the page, or null while the
 * slot is not showing (another pane tab is in front, a dialog covers it, the column is collapsed): the shells keep running.
 * The pane is a native view on this Mac running the owner's login shell. The page says where and for which thread, nothing
 * else: no folder the shell must use, no command, no text. `cwd` is what the page believes the thread's folder is; a shell
 * may check it against its own record but never starts a shell there on the page's word.
 */
export const NativeShellPane = msg('shell_pane', {
  thread_id: ThreadId,
  rect: z.strictObject({ x: TerminalCoord, y: TerminalCoord, width: TerminalCoord, height: TerminalCoord }).nullable(),
  cwd: PickPath.optional(),
})
/** The owner closed the Terminal pane of this thread: its shells end. Opening the pane again starts a new shell. */
export const NativeShellPaneClose = msg('shell_pane_close', { thread_id: ThreadId })
/**
 * The page is sending a Run for the Terminal pane (`run_where: 'pane'`, run.ts RUN_PANE_FEATURE): the Mac app records a witness
 * of THIS message, bound to the script's sha256 (hex of the UTF-8 script as the bridge hands it over), only if a real human
 * click or Return reached its window within RUN_PANE_CLICK_MS; a JS call alone records nothing. A pane Run the bridge hands
 * over runs only with a fresh, unused witness for its id and script hash, so a Run signed on a phone or a browser (never
 * witnessed here) is refused. Carries no script text and nothing the shell reads: the shell still gets only what the app writes.
 */
export const NativeRunWitness = msg('run_witness', {
  thread_id: ThreadId,
  client_msg_id: MsgId,
  script_sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * The page's answer to `capture_drop`. ok: the image is in the composer as a pending attachment (it may still be uploading),
 * not sent. Not ok: why, so the shell can tell the owner; the shell then discards the image.
 */
export const NativeCaptureAck = msg('capture_ack', {
  req: PickReq,
  ok: z.boolean(),
  reason: z.enum(['not_signed_in', 'bad_image', 'no_thread']).optional(),
})

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
  pick_folder: NativePickFolder,
  shell_pane: NativeShellPane,
  shell_pane_close: NativeShellPaneClose,
  run_witness: NativeRunWitness,
  capture_ack: NativeCaptureAck,
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
  NativePickFolder,
  NativeShellPane,
  NativeShellPaneClose,
  NativeRunWitness,
  NativeCaptureAck,
])
export type WebToNativeT = z.infer<typeof WebToNative>

// ---- native -> web ----------------------------------------------------------------------------------------------

/** Standard base64 whose decoded size is at most `max` bytes. */
const base64Bytes = (max: number, what: string) =>
  z
    .string()
    .max(Math.ceil(max / 3) * 4) // cheap length cap first: nothing below runs on a huge string
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((s) => {
      if (s.length % 4 !== 0) return false
      const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
      return (s.length / 4) * 3 - pad <= max
    }, `${what} is too big or not base64`)

export const NativeNavigate = msg('navigate', { path: AppPath })
export const NativeCompose = msg('compose', { thread_id: ThreadId, text: z.string().min(1).max(32_000) })
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

/** Why a pane Run did not run, as the Mac app says it: the click was not witnessed, it waited too long, the shell did not start, the pane was busy, the app closed, or the script broke the app's own rules (control, bidi or zero-width characters, empty, no final newline, over 4000 characters). */
export const RUN_RESULT_REASONS = [
  'no_witness',
  'expired',
  'not_started',
  'pane_busy',
  'app_closed',
  'bad_script',
] as const
/**
 * What became of a pane Run (`run_witness`), keyed by its message id: ok when the Mac app wrote it into the owner's shell, else
 * a fixed reason. No text: the page never learns what the shell did, only whether the Run went in.
 */
export const NativeRunResult = msg('run_result', {
  client_msg_id: MsgId,
  ok: z.boolean(),
  reason: z.enum(RUN_RESULT_REASONS).optional(),
})

/**
 * The answer to `pick_folder`: the absolute path the owner chose, or null when they cancelled. The page saves it through the
 * same checked thread patch as a typed path, so the Mac (bridge) still decides whether it may be used.
 */
export const NativeFolderPicked = msg('folder_picked', {
  req: PickReq,
  path: PickPath.nullable(),
  /** Why there is no path when the owner did not simply cancel: the Mac app cannot show the panel now, or the folder's name has a character Talos cannot use. */
  why: z.enum(['not_now', 'bad_name']).optional(),
})

// ---- the screenshot hotkey (Mac app): a capture dropped into a thread's composer, never sent by itself ----
/** The feature the web lists in its `ready` when it can take `capture_drop`; the shell sends one only to a page that lists it. */
export const WEB_FEATURE_CAPTURE_DROP = 'capture-drop'
/** A capture is a PNG of at most 8 MB, its long edge at most 2560 px: the shell scales it down to fit before sending. */
export const NATIVE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024
export const NATIVE_CAPTURE_EDGE_MAX = 2560
const CaptureEdge = z.number().int().min(1).max(NATIVE_CAPTURE_EDGE_MAX)
/**
 * The owner pressed the screenshot hotkey. The image goes into a thread's composer as a pending attachment, ready for a line
 * of text; nothing is sent until the owner sends. `thread_id` is set only when the owner pinned a thread in the shell's
 * settings; null lets the page choose (the thread last on screen, else the default one). No app name, window title or screen:
 * the image is all there is. The page answers `capture_ack` with the same `req`.
 */
export const NativeCaptureDrop = msg('capture_drop', {
  req: PickReq,
  thread_id: ThreadId.nullable(),
  mime: z.literal('image/png'),
  data_b64: base64Bytes(NATIVE_CAPTURE_MAX_BYTES, 'capture'),
  width: CaptureEdge,
  height: CaptureEdge,
  mode: z.enum(['full', 'window', 'region']),
})
export const NATIVE_TO_WEB = {
  navigate: NativeNavigate,
  compose: NativeCompose,
  enroll_code: NativeEnrollCode,
  companion_reply_request: NativeCompanionReplyRequest,
  companion_replies: NativeCompanionReplies,
  notify_permission: NativeNotifyPermission,
  terminal_sessions: NativeTerminalSessions,
  terminal_resume_result: NativeTerminalResumeResult,
  terminal_select: NativeTerminalSelect,
  run_result: NativeRunResult,
  folder_picked: NativeFolderPicked,
  capture_drop: NativeCaptureDrop,
} as const
export const NativeToWeb = z.discriminatedUnion('type', [
  NativeNavigate,
  NativeCompose,
  NativeEnrollCode,
  NativeCompanionReplyRequest,
  NativeCompanionReplies,
  NativeNotifyPermission,
  NativeTerminalSessions,
  NativeTerminalResumeResult,
  NativeTerminalSelect,
  NativeRunResult,
  NativeFolderPicked,
  NativeCaptureDrop,
])
export type NativeToWebT = z.infer<typeof NativeToWeb>

/** The JSON Schema of one message, for the fixtures the native apps are built against (scripts/native-fixtures.ts). */
export const nativeJsonSchema = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { unrepresentable: 'any' })
