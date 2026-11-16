// v2 feature seams for the UI (docs/V2-FEATURES.md V1, V3, V5; WP-V0). FROZEN after WP-V0 (V2/V5 may extend, not change).
//   `lib/fakeV2.ts` implements both clients in memory and is wired into fakeClient. WP-V2 / WP-V5 add the socket
//   versions and make `TalosClient.search` / `.memory` required.
// Every call sends one signed owner frame and rejects with `TalosClientError` on `error{code}`
// (`mac_offline`, `search_unavailable`, `bad_query`, `memory_off`, `memory_not_found`).
import {
  type AttachmentRefT,
  type BugReportBodyT,
  type BugReportDestinationT,
  type FilesSentFiltersT,
  HEALTH_FEATURE,
  type MemoryEntryT,
  type MemoryHitT,
  type MemoryLinkT,
  type MemoryRootInfoT,
  type MessageT,
  type PresenceT,
  type SearchFiltersT,
  type SearchHitT,
  type SentFileT,
  SHARE_FEATURE,
  UNDO_FEATURE,
} from '@talos-app/protocol'
import { useTalos } from './client.ts'

export type SearchSortT = 'relevance' | 'newest'
export type SearchIndexStateT = 'ready' | 'indexing' | 'dirty'

export interface SearchClient {
  /** `search.query` -> `search.results`. */
  search(args: {
    q: string
    filters: SearchFiltersT
    sort: SearchSortT
    cursor: string | null
    limit: number
  }): Promise<{ hits: SearchHitT[]; nextCursor: string | null; totalEstimate: number; index: SearchIndexStateT }>
  /** `history.request` with `around_id` / `before_id` / `after_id` (V3.2): the past-conversation view. */
  context(
    threadId: string,
    args: { aroundId?: string; beforeId?: string; afterId?: string },
  ): Promise<{ messages: MessageT[]; hasMore: boolean; hasNewer: boolean }>
}

export interface MemoryClient {
  /** `memory.tree`; `rootId: null` lists the roots, `path: ''` is the top of a root. */
  tree(
    rootId: string | null,
    path: string,
    cursor: string | null,
  ): Promise<{ roots?: MemoryRootInfoT[]; entries: MemoryEntryT[]; nextCursor: string | null }>
  /** `memory.read`: one chunk from a UTF-8 byte offset; `nextOffset: null` = end. */
  read(
    rootId: string,
    path: string,
    offset: number,
  ): Promise<{
    text: string
    mime: string
    size: number
    mtime: string
    sha256: string
    nextOffset: number | null
    links?: MemoryLinkT[]
  }>
  /** `memory.search`; `rootIds: []` = all roots. */
  search(
    q: string,
    rootIds: string[],
    cursor: string | null,
    limit: number,
  ): Promise<{ hits: MemoryHitT[]; nextCursor: string | null; index: SearchIndexStateT }>
  /** `memory.graph`: every visible note and the links between them, for the 3D view. Checked against the frame schema. */
  graph?(): Promise<MemoryGraph>
}

/** The graph as the 3D view draws it: notes by index, links as index pairs; `total` counts every visible note. */
export type MemoryGraph = {
  roots: Array<{ id: string; label: string }>
  nodes: Array<{ root: number; path: string; title: string }>
  edges: Array<[number, number]>
  total: number
  truncated: boolean
}

/** What the Mac answered to one `speak.request`. `working` means ask again; an unknown state from a newer Mac reads as `working`. */
export type SpeakAnswer =
  | { state: 'ready'; media: AttachmentRefT; chars?: number; totalChars?: number; truncated?: boolean }
  | { state: 'working'; waitS?: number; chars?: number; totalChars?: number; truncated?: boolean }
  | { state: 'failed'; reason: string; message: string }

export interface SpeakClient {
  /**
   * `speak.request` -> `speak.result`: asks the Mac to read one of its stored agent messages aloud. `fresh` is true on the first
   * ask of a tap (a remembered failure is forgotten, so Retry really retries) and false on the follow-up asks. Rejects with
   * `TalosClientError` (`mac_offline`, `rate_limited`, `device_not_pinned`, ...).
   */
  request(args: { messageId: string; threadId: string; fresh: boolean }): Promise<SpeakAnswer>
}

/** What the Mac answered to one `fs.list`: folder names only (src/folders in the bridge). */
export type FolderListing = {
  /** The owner's home on the Mac, absolute. The app shows paths under it as ~/… . */
  home: string
  /** The main agent folder, when the Mac knows it. */
  agentDir?: string
  /** The folder listed, absolute (absent when the ask had no path). */
  path?: string
  parent: string | null
  entries: string[]
  /** Folders past the cap that were not sent. */
  more: number
}

export interface FolderClient {
  /**
   * `fs.list` -> `fs.listing`. `path: null` only asks where home and the agent folder are. Rejects with `TalosClientError`
   * (`bad_frame` with the Mac's one fixed sentence for a folder it will not open, `mac_offline`, `rate_limited`).
   */
  list(path: string | null, hidden: boolean): Promise<FolderListing>
}

/** One folder of a thread's folder, as the Files pane shows it (src/files in the bridge). Paths are relative to the thread's folder. */
export type FilesListing = {
  threadId: string
  /** The thread's folder on the Mac, absolute, for display (the app shows it as ~/…). */
  root: string
  /** The folder listed: '' is the thread's folder itself. */
  path: string
  /** Folders first, then files, by name. */
  entries: Array<{ name: string; kind: 'dir' | 'file'; size?: number }>
  /** Entries past the cap that were not sent. */
  more: number
  /** A very large folder: only part of it was looked at (`more` does not count the rest). */
  partial?: boolean
}

/** One file of a thread's folder: text (a chunk of it), an image (an attachment to load), or something the pane cannot show. */
export type FilesFile = {
  threadId: string
  path: string
  kind: 'text' | 'image' | 'binary'
  size: number
  mtime: string
  text?: string
  offset?: number
  /** Where the next chunk starts; null at the end. */
  nextOffset: number | null
  /** The Mac stopped at its cap: the rest of the file is not shown. */
  truncated: boolean
  media?: AttachmentRefT
  /** Why it is not shown (too big, not text). */
  message?: string
}

export interface FilesClient {
  /** `files.list` -> `files.listing`. Rejects with `TalosClientError` (`bad_frame` with the Mac's sentence, `mac_offline`, ...). */
  list(threadId: string, path: string): Promise<FilesListing>
  /** `files.read` -> `files.file`, from `offset` (0 = start). */
  read(threadId: string, path: string, offset: number): Promise<FilesFile>
  /**
   * `files.put` -> `files.put_result`: puts uploaded media in the folder `dir` of the thread's folder under `name`. Resolves
   * with the name it got (another when that was taken). Absent on a client that cannot ask the Mac to.
   */
  put?(threadId: string, dir: string, name: string, media: AttachmentRefT): Promise<{ name: string; size: number }>
  /**
   * `files.sent` -> `files.sent_list`: the files sent in Talos, newest first (frames-files-sent.ts). Asked again each time the
   * sheet opens, never kept. Absent on a client that cannot ask the Mac.
   */
  sent?(args: { filters: FilesSentFiltersT; cursor: string | null; limit: number }): Promise<FilesSentPage>
}

/** One page of sent files, as checked by the app (rows that don't fit, or name a thread it doesn't know, are dropped). */
export type FilesSentPage = { files: SentFileT[]; nextCursor: string | null; days: number }

/** The thread's AGENTS.md as the Mac has it (`agents_md.file`). */
export type AgentsMdFile = {
  threadId: string
  exists: boolean
  /** The sha256 of the file (null: none, or too large): what a save says it was loaded from. */
  sha: string | null
  text?: string
  tooLarge: boolean
  /** The change since the last save made in Settings, when the file was changed elsewhere (a unified diff). */
  outsideDiff?: string
  saved: boolean
}

/** The thread's instructions in its settings. Both reject with `TalosClientError` (the Mac's sentence, `mac_offline`, ...). */
/** Which folders Memory's Notes show (`memory.folders` / `memory.roots_set` -> `memory.folders_result`). */
export type MemoryFolders = {
  folders: Array<{ name: string; notes: number }>
  chosen: string[]
  /** Memory browsing is on at the Mac. */
  enabled: boolean
  /** Answers a save that was written. */
  saved: boolean
  /** The Mac's plain line when it could not list or save. */
  error?: string
}
export interface MemoryFoldersClient {
  list(): Promise<MemoryFolders>
  /** Notes shows exactly these (names from the last list); none turns Notes off. Rejects `mac_offline` when not saved. */
  set(names: readonly string[]): Promise<MemoryFolders>
}

export interface AgentsMdClient {
  /** `agents_md.read` -> `agents_md.file`. */
  read(threadId: string): Promise<AgentsMdFile>
  /** `agents_md.write` -> `agents_md.file`: saves `text` over the file loaded as `baseSha` (null: there was none). */
  write(threadId: string, text: string, baseSha: string | null): Promise<AgentsMdFile>
}

/** What the Mac knows for a bug report (`bug.context` -> `bug.context_result`): its own versions, the errors it filed, the cleaned log. */
export type BugContext = {
  bridgeVersion: string
  claudeCode: string | null
  recentErrors: string[]
  logs: string
}

/** The bug reporter's calls. Both reject with `TalosClientError` (`mac_offline`, `rate_limited`, `internal`). */
export interface BugReportClient {
  /** The Mac's side of a report. Rejects when the Mac is away or too old to answer; the report is still sendable without it. */
  context(lines: number): Promise<BugContext>
  /** Signs the report with this device's key and posts it to the relay. Resolves with the report's id. */
  send(
    report: BugReportBodyT,
    picture: { type: 'image/png' | 'image/jpeg'; bytes: Uint8Array },
  ): Promise<{ id: string }>
  /** Where a report goes after the relay keeps it (the relay's answer, never an address). Rejects when it cannot be had. */
  destination(): Promise<BugReportDestinationT>
}

export type FeatureState = 'on' | 'needs_mac' | 'off'

/** Features the relay itself provides: usable with the Mac offline (undo/1 is the relay's: its item also needs the message's undo point). */
export const RELAY_FEATURES: readonly string[] = [HEALTH_FEATURE, SHARE_FEATURE, UNDO_FEATURE]

/**
 * Relay features ('health/1', 'share/1'): 'on' when the relay lists them, whatever the bridge does.
 * Bridge features ('search/1', 'memory/1', 'driving/1'): 'on' when the bridge is online and lists them, 'needs_mac' when
 * it is offline but the last-known list (with `features_at`) has them, else 'off'.
 */
export function featureState(
  presence: Pick<PresenceT, 'bridge_online' | 'features' | 'features_at'>,
  relayFeatures: readonly string[],
  name: string,
): FeatureState {
  if (RELAY_FEATURES.includes(name)) return relayFeatures.includes(name) ? 'on' : 'off'
  const listed = presence.features?.includes(name) ?? false
  if (!listed) return 'off'
  if (presence.bridge_online) return 'on'
  return presence.features_at ? 'needs_mac' : 'off'
}

export function useFeature(name: string): FeatureState {
  const presence = useTalos((s) => s.presence)
  const relay = useTalos((s) => s.relayFeatures)
  return featureState(presence, relay, name)
}
