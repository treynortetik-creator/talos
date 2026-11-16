// Upload into a thread's folder from the Files pane (or the phone's Files sheet): the app uploads the file through the
// ordinary media path (POST /api/media, sha256 checked), then a signed `files.put` names the folder inside the thread's
// folder and the file's name. The Mac downloads the media, checks its size and sha256, and creates the file there: never
// over an existing one (a taken name becomes "name (2).ext"), never a hidden name or an instruction file, inside the same
// fence the pane reads with. Split out of frames.ts, which re-exports the frames. Like the reads, it is never stored by the
// relay: it goes to the Mac and the answer comes back to the asking socket only.
import { z } from 'zod'
import { FILES_NAME_MAX, FilesPath } from './files.ts'
import { frame, ownerFrame } from './frame-base.ts'
import { ThreadId, Ulid } from './ids.ts'
import { OwnerAttachmentRef } from './models.ts'

/** The Mac takes uploads into a thread's folder (a live main bridge). */
export const FILES_PUT_FEATURE = 'files-put/1'
/** The largest file one upload may put in a folder (the media path's own cap). */
export const FILES_PUT_MAX_BYTES = 50 * 1024 * 1024
/** The most bytes one device may put into thread folders in one UTC day. */
export const FILES_PUT_DAY_BYTES = 1024 * 1024 * 1024
/** How long the app and the relay wait for the Mac's answer to an upload (it fetches up to 50 MB first). */
export const FILES_PUT_ANSWER_MS = 120_000
/** How many "name (n).ext" a clash tries before it gives up. */
export const FILES_PUT_CLASH_MAX = 99

/**
 * Names an upload never takes, in any letter case: the instruction files Claude Code reads (edited from thread settings,
 * not dropped in) and Claude's own folder.
 */
export const FILES_PUT_REFUSED_NAMES: readonly string[] = ['agents.md', 'claude.md', 'claude.local.md', '.claude']

/** What the Mac says, in one place. */
export const FILES_PUT_WORDING = {
  notReady: 'Your Mac is not ready to take files.',
  badName: "That name can't be used for a file here. Rename it and try again.",
  instructions: 'Instruction files are edited in thread settings, not uploaded.',
  protectedName: "Talos doesn't put files under that name in this folder.",
  folder: "That isn't a folder Talos can put files in.",
  tooLarge: 'That file is too large to put in the folder (50 MB at most).',
  budget: "You've put a lot into this Mac's folders today. Try again tomorrow.",
  clash: 'There are already too many files with that name here.',
  download: "Your Mac couldn't fetch that file. Try again.",
  failed: "Your Mac couldn't save that file.",
} as const

export const FilesPutFrame = ownerFrame('files.put', {
  request_id: Ulid,
  thread_id: ThreadId,
  /** The folder inside the thread's folder ('' = the folder itself), as the pane lists it. */
  dir: FilesPath,
  /** The file's name in that folder: one plain name. */
  /** At most 200 characters, as the media ref's own name. */
  name: z.string().min(1).max(200),
  media: OwnerAttachmentRef,
})

/** The file as created: `name` is the one it got (another than asked when that was taken). */
export const FilesPutResultFrame = frame('files.put_result', {
  request_id: Ulid,
  thread_id: ThreadId,
  dir: FilesPath,
  name: z.string().min(1).max(FILES_NAME_MAX),
  size: z.number().int().min(0),
})
