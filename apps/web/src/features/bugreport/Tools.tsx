// The markup tools: a column down the left of the picture on a computer, one row under it on a phone. Icons only, each with its
// name for the screen reader and as a tooltip. On a computer the three inks are swatches in a radio group; the phone has no
// ink picker and draws in the first ink.
import type { ComponentType, SVGProps } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconArrowUpRight, IconBlur, IconBox, IconPencil, IconType, IconUndo } from '../../ui/icons.tsx'
import { INK_TOKENS, TOOLS, type Tool } from './ink.ts'
import { BUG_TEXT } from './text.ts'

const TOOL_ICON: Record<Tool, ComponentType<SVGProps<SVGSVGElement>>> = {
  pen: IconPencil,
  arrow: IconArrowUpRight,
  box: IconBox,
  text: IconType,
  blur: IconBlur,
}

const BUTTON =
  'inline-flex items-center justify-center rounded-button border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-40'

export function Tools({
  layout,
  tool,
  setTool,
  ink,
  setInk,
  canUndo,
  undo,
}: {
  layout: 'column' | 'row'
  tool: Tool
  setTool: (t: Tool) => void
  ink: number
  setInk: (i: number) => void
  canUndo: boolean
  undo: () => void
}) {
  const column = layout === 'column'
  const size = column ? 'size-12' : 'h-11 min-w-11 flex-1'
  const glyph = column ? 20 : 18
  return (
    <div data-testid="bug-tools" className={cn(column ? 'flex flex-col items-center gap-2' : 'flex flex-col gap-2')}>
      <div
        role="toolbar"
        aria-label={BUG_TEXT.toolsLabel}
        aria-orientation={column ? 'vertical' : 'horizontal'}
        className={cn('flex gap-2', column ? 'flex-col items-center' : 'justify-between gap-1.5')}
      >
        {TOOLS.map((t) => {
          const Glyph = TOOL_ICON[t]
          const on = tool === t
          return (
            <button
              key={t}
              type="button"
              aria-label={BUG_TEXT.tools[t]}
              title={BUG_TEXT.tools[t]}
              aria-pressed={on}
              onClick={() => setTool(t)}
              className={cn(
                BUTTON,
                size,
                on
                  ? 'border-accent bg-surface-2 text-accent-text'
                  : 'border-transparent text-text-2 hover:bg-surface-2',
                !column && !on && 'border-line',
              )}
            >
              <Glyph width={glyph} height={glyph} />
            </button>
          )
        })}
        {column ? <div aria-hidden="true" className="my-1 h-px w-8 bg-line" /> : null}
        <button
          type="button"
          aria-label={BUG_TEXT.tools.undo}
          title={BUG_TEXT.tools.undo}
          disabled={!canUndo}
          onClick={undo}
          className={cn(BUTTON, size, 'text-text-2 hover:bg-surface-2', column ? 'border-transparent' : 'border-line')}
        >
          <IconUndo width={glyph} height={glyph} />
        </button>
      </div>
      {column ? (
        <div role="radiogroup" aria-label={BUG_TEXT.inkLabel} className="mt-2 flex flex-col items-center">
          {INK_TOKENS.map((token, i) => (
            // biome-ignore lint/a11y/useSemanticElements: a colour swatch in a radio group; the real <input> would not be a swatch
            <button
              key={token}
              type="button"
              role="radio"
              aria-checked={ink === i}
              aria-label={BUG_TEXT.inks[i]}
              title={BUG_TEXT.inks[i]}
              onClick={() => setInk(i)}
              className="group inline-flex size-11 items-center justify-center rounded-pill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span
                className={cn(
                  'block size-5 rounded-pill border border-line outline-2 outline-offset-2',
                  ink === i ? 'outline-text' : 'outline-transparent',
                )}
                style={{ background: `var(${token})` }}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
