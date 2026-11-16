// The thread's instructions (AGENTS.md) in its settings: read and saved by the owner's signed device, through the Mac only.
// Split out of frames.ts, which re-exports them. Both are signed requests answered on the bridge's read queue, so the relay
// never stores or replays the text: it goes to the Mac and back to the asking socket, nowhere else.
import { z } from 'zod'
import { frame, ownerFrame } from './frame-base.ts'
import { ThreadId, Ulid } from './ids.ts'

/** The Mac answers `agents_md.*` (a live main bridge): thread settings show the Instructions editor only then. */
export const AGENTS_MD_FEATURE = 'agents-md/1'
/** The most AGENTS.md text Settings reads or saves, in UTF-8 bytes. A larger file is shown as too large, never cut. */
export const AGENTS_MD_MAX_BYTES = 64 * 1024
/** The most of the "changed outside Settings" diff one answer carries, in characters. */
export const AGENTS_MD_DIFF_MAX = 16 * 1024

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** What the Mac says, in one place. */
export const AGENTS_MD_WORDING = {
  notReady: 'Your Mac is not ready to show instructions.',
  shared:
    "This thread runs in the shared agent folder, so its instructions are Main's too. Give it its own folder to give it its own instructions.",
  noFolder: "This thread's folder isn't there any more.",
  refused: "Talos can't edit AGENTS.md in this thread's folder.",
  link: 'AGENTS.md in this folder is a link. Edit it at your Mac.',
  tooLarge: 'AGENTS.md is too large to edit here (over 64 KB, or too much to send). Edit it at your Mac.',
  notText: "AGENTS.md here isn't plain UTF-8 text. Edit it at your Mac.",
  conflict: 'AGENTS.md changed since you opened it. Reload to see the new text, then make your change again.',
  saveFailed: "Your Mac couldn't save AGENTS.md.",
  /** The quiet thread line at the next session start after a change made outside Settings. */
  changedOutside: 'AGENTS.md was changed outside Settings. View the diff in thread settings, under Instructions.',
} as const

/** The thread's AGENTS.md, as the Mac has it. Answered by `agents_md.file`. */
export const AgentsMdReadFrame = ownerFrame('agents_md.read', {
  request_id: Ulid,
  thread_id: ThreadId,
})

/**
 * Saves `text` as the thread's AGENTS.md. `base_sha` is the sha256 of the file the editor loaded (null: there was none); the
 * Mac refuses when the file is not that any more, so a change made meanwhile is never lost. Answered by `agents_md.file`.
 */
export const AgentsMdWriteFrame = ownerFrame('agents_md.write', {
  request_id: Ulid,
  thread_id: ThreadId,
  text: z.string().max(AGENTS_MD_MAX_BYTES),
  base_sha: Sha256Hex.nullable(),
})

/**
 * The file now: `exists` false (and `sha` null) when there is none; `too_large` when it is over AGENTS_MD_MAX_BYTES (no
 * `text` then). `outside_diff`: the change since the last save made from Settings, when the file was changed elsewhere
 * (a unified diff, cut at AGENTS_MD_DIFF_MAX). `saved`: this answers a write that was saved.
 */
export const AgentsMdFileFrame = frame('agents_md.file', {
  request_id: Ulid,
  thread_id: ThreadId,
  exists: z.boolean(),
  sha: Sha256Hex.nullable(),
  text: z.string().max(AGENTS_MD_MAX_BYTES).optional(),
  too_large: z.boolean().optional(),
  outside_diff: z
    .string()
    .max(AGENTS_MD_DIFF_MAX + 200)
    .optional(),
  saved: z.boolean().optional(),
})
