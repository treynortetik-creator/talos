// The last lines of a quiet session's pane, under its notice (protocol quiet-lines.ts). Plain text in a small box under a small fixed caption (so pane
// text cannot pose as Talos's own words); drawn only while this app holds them (they are never saved), so a reload, an older relay or a Mac without
// them shows the notice alone. Left out of a bug report's screenshot (data-no-capture).
import { useQuietLines } from './quietLines.ts'
import { QUIET_LINES_CAPTION } from './quietLinesWords.ts'

export function QuietLines({ messageId }: { messageId: string }) {
  const lines = useQuietLines((s) => s.byMessage[messageId])
  if (!lines || lines.length === 0) return null
  return (
    <div data-testid="quiet-lines-box" data-no-capture="" className="mx-auto mt-1 max-w-full overflow-hidden text-left">
      <p className="m-0 mb-0.5 text-[11px] uppercase tracking-wide text-text-3">{QUIET_LINES_CAPTION}</p>
      <ul
        data-testid="quiet-lines"
        className="m-0 list-none space-y-0.5 overflow-hidden rounded bg-surface-2 p-2 font-mono text-xs text-text-2"
      >
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are plain text, may repeat, and never reorder
          <li key={`${i}:${l}`} className="truncate">
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}
