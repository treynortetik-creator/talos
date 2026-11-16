// Memory -> Graph: every visible note and the links between them, for the 3D view (owner, 2026-11-15: "that 3D interactive
// setup where they can poke around and see how ideas are connected"). Split out of frames.ts, which re-exports them. A
// signed read answered on the bridge's read queue, like memory.tree: the relay passes it to the Mac and back to the asking
// socket and stores nothing. Only notes the Memory screen may show are in it (the same scope, denylist and private markers),
// and only links between two of them. Nodes are referred to by their index in `nodes`, so a large graph stays inside one frame.
import { z } from 'zod'
import { frame, ownerFrame } from './frame-base.ts'
import { MemoryPath, MemoryRootId, Ulid } from './ids.ts'

/** The Mac answers `memory.graph`: Memory shows its Graph view only then. */
export const MEMORY_GRAPH_FEATURE = 'memory-graph/1'
/** The most notes one answer carries; past it (or past the frame's bytes) `truncated` says so. */
export const MEMORY_GRAPH_NODES_MAX = 2000
/** The most links one answer carries. */
export const MEMORY_GRAPH_EDGES_MAX = 10_000
/** A note's title as the graph labels it. */
export const MEMORY_GRAPH_TITLE_MAX = 120

export const MemoryGraphFrame = ownerFrame('memory.graph', {
  request_id: Ulid,
})

export const MemoryGraphRoot = z.object({ id: MemoryRootId, label: z.string().max(40) }).strict()
export const MemoryGraphNode = z
  .object({
    /** Index into `roots`: the folder it is in, which is also its colour. */
    r: z.number().int().min(0).max(19),
    p: MemoryPath,
    t: z.string().max(MEMORY_GRAPH_TITLE_MAX),
  })
  .strict()
/** A link from one note to another, as indexes into `nodes`; each pair once, never a note to itself. */
export const MemoryGraphEdge = z.tuple([z.number().int().min(0), z.number().int().min(0)])

/**
 * Titles are note content: shown as plain text only, and cleaned on the Mac (control and direction characters). Every index
 * must point inside its list, and a link never joins a note to itself, so a garbled answer fails here, never draws a phantom.
 */
export const MemoryGraphResultFrame = frame('memory.graph_result', {
  request_id: Ulid,
  roots: z.array(MemoryGraphRoot).max(20),
  nodes: z.array(MemoryGraphNode).max(MEMORY_GRAPH_NODES_MAX),
  edges: z.array(MemoryGraphEdge).max(MEMORY_GRAPH_EDGES_MAX),
  /** Every visible note, shown or not: "Showing N of M notes" when `nodes` is fewer. */
  total_nodes: z.number().int().min(0),
  /** Some notes or links were left out. Past the cap the most recently changed notes are kept. */
  truncated: z.boolean(),
}).superRefine((f, ctx) => {
  if (f.nodes.some((n) => n.r >= f.roots.length)) ctx.addIssue({ code: 'custom', message: 'a note in no folder' })
  if (f.edges.some(([a, b]) => a === b || a >= f.nodes.length || b >= f.nodes.length))
    ctx.addIssue({ code: 'custom', message: 'a link to no note' })
  if (f.total_nodes < f.nodes.length) ctx.addIssue({ code: 'custom', message: 'fewer notes in all than shown' })
})
export type MemoryGraphResultT = z.infer<typeof MemoryGraphResultFrame>
