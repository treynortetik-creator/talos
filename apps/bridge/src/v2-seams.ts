// Seams between the bridge's hot files (WP-V0) and the v2 feature folders (docs/V2-FEATURES.md V8). Inbound answers the
// signed reads through these on its readQueue; a missing service answers with a fixed error code. Builders implement
// them in their own folders (src/search/**, src/memory/**, src/health/**) and set them on the context in bridge.ts.
import type { ErrorCodeT, FrameOf, MessageRefT } from '@talos-app/protocol'

/** A read the service refuses, with the code the app shows (`bad_query`, `memory_not_found`, ...). */
export class ReadError extends Error {
  constructor(
    readonly code: ErrorCodeT,
    message: string,
  ) {
    super(message)
  }
}

type Body<
  T extends
    | 'search.results'
    | 'memory.listing'
    | 'memory.file'
    | 'memory.results'
    | 'memory.graph_result'
    | 'speak.result',
> = Omit<FrameOf<T>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>

/** The answer the read-aloud service builds; inbound adds the envelope and `request_id`. */
export type SpeakBody = Body<'speak.result'>

/** WP-V2 (src/search/**). */
export interface SearchService {
  /** FTS5 probe passed: advertise `search/1` (V3.1). */
  readonly available: boolean
  /** Byte-fit results (V1.3). Throws ReadError(`bad_query` | `search_unavailable`). */
  query(f: FrameOf<'search.query'>): Promise<Body<'search.results'>>
  /**
   * `history.request` with `before_id` / `after_id` / `around_id` (the context view, V3.2), paged on `ord`. Null = not
   * handled (the bridge falls back to the plain page).
   */
  history?(
    f: FrameOf<'history.request'>,
  ): { messages: import('@talos-app/protocol').MessageT[]; hasMore: boolean; hasNewer: boolean } | null
}

/** WP-V5 (src/memory/**). */
export interface MemoryService {
  /** FTS5 probe passed (V5.2). The browser can still be switched off: see `enabled()`. */
  readonly available: boolean
  /** `memory.json.enabled && config.memory_browser` (V5.1). */
  enabled(): boolean
  tree(f: FrameOf<'memory.tree'>): Promise<Body<'memory.listing'>>
  read(f: FrameOf<'memory.read'>): Promise<Body<'memory.file'>>
  search(f: FrameOf<'memory.search'>): Promise<Body<'memory.results'>>
  /** Every visible note and the links between them, for the 3D graph (memory/graph.ts). */
  graph?(): Body<'memory.graph_result'>
  /**
   * Re-checks the notes an owner message refers to (V5.2): meta `memory_root`, `memory_path` (absolute), and
   * `memory_changed` when the sha differs; a ref no longer allowed is dropped with a note.
   */
  checkRefs(refs: MessageRefT[]): { meta: Record<string, string>; notes: string[] }
}

/** Read aloud (src/speak/**): the play button on an agent message. */
export interface SpeakServiceSeam {
  readonly available: boolean
  request(f: FrameOf<'speak.request'>): Promise<SpeakBody>
  /** A reply's `voice_text` audio, under the read-aloud parallel limit (waits for a slot). */
  synthesizeForReply(text: string, id: string): Promise<import('./tts.ts').TtsResult>
  /** How long a reply waits for that audio before its text goes out alone. */
  readonly replyWaitMs: number
}

/** The folder picker (src/folders/**): folder names under the owner's home, for the signed device only. */
export interface FolderServiceSeam {
  readonly available: boolean
  list(f: Pick<FrameOf<'fs.list'>, 'path' | 'hidden'>): Promise<FolderBody>
}
export type FolderBody = Omit<FrameOf<'fs.listing'>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>

/** The Files pane (src/files/**): a read-only look at one thread's folder, for the signed device only. */
export interface FilesServiceSeam {
  readonly available: boolean
  list(
    f: Pick<FrameOf<'files.list'>, 'thread_id' | 'path'>,
  ): Promise<Omit<FrameOf<'files.listing'>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>>
  read(
    f: Pick<FrameOf<'files.read'>, 'thread_id' | 'path' | 'offset'>,
  ): Promise<Omit<FrameOf<'files.file'>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>>
}

/** The bug reporter's read (src/bug-context/**): the Mac's versions, filed errors and cleaned log tail, for the signed device only. */
export interface BugContextSeam {
  readonly available: boolean
  read(f: Pick<FrameOf<'bug.context'>, 'lines'>): BugContextBody
}
export type BugContextBody = Omit<FrameOf<'bug.context_result'>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>

/** WP-V1 (src/health/**): advertises `health/1` and sends `health.beat`. */
export interface HealthService {
  readonly available: boolean
  stop?(): void
}
