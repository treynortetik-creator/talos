// A worker as worker-dialogs.ts sees it (split out of workers.ts, which is at its size limit): the offer lives in the entry's `dialog`, so
// workers.json carries it; the folder's own `.mcp.json` names are what a wrapped MCP server name is checked against (dialog-reader.ts).
import type { OfferTarget } from './worker-dialogs.ts'
import { projectMcpNames } from './worker-mcp.ts'
import type { WorkerRuntime } from './worker-types.ts'

/** `changed` is called when the entry's dialog was set or cleared (the manager writes workers.json at its next look). */
export function offerTargetOf(w: WorkerRuntime, changed: () => void): OfferTarget {
  return {
    id: w.id,
    offer: w.offer,
    dialog: () => w.entry.dialog,
    mcpNames: () => projectMcpNames(w.entry.cwd),
    setDialog: (dialog) => {
      const { dialog: _old, ...rest } = w.entry
      w.entry = dialog ? { ...rest, dialog } : rest
      changed()
    },
  }
}
