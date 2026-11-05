// Thread icons (docs/THREADS.md). A chosen glyph or the black-figure art for the thread; a chosen colour fills a roundel
// behind it in black ink. `framed` sets the icon in a cream roundel when uncoloured, for black grounds (the sidebar
// frieze) where black ink would vanish. Decorative: the thread name is always next to it.
import { cn } from './cn.ts'
import { INK, resolveThreadIcon, threadColorHex } from './threadIcons.ts'

export function ThreadIcon({
  id,
  icon,
  color,
  size = 24,
  className,
  framed,
}: {
  id: string
  icon?: string | undefined
  color?: string | undefined
  size?: number
  className?: string
  framed?: boolean
}) {
  const r = resolveThreadIcon(id, icon)
  const fill = threadColorHex(color)
  const roundel = framed || fill !== undefined || r.kind === 'glyph'
  const inner = roundel ? Math.round(size * (r.kind === 'glyph' ? 0.58 : 0.72)) : size
  const px = inner * 2 <= 64 ? 64 : 128
  const ink = fill !== undefined || framed
  const glyph =
    r.kind === 'glyph' ? (
      <r.icon.C
        aria-hidden="true"
        width={inner}
        height={inner}
        strokeWidth={2.1}
        color={ink ? INK : 'currentColor'}
        className={cn('shrink-0', !roundel && className)}
      />
    ) : (
      <img
        src={`/brand/thread-icons/${r.name}-${px}.png`}
        alt=""
        aria-hidden="true"
        width={inner}
        height={inner}
        draggable={false}
        className={cn('inline-block shrink-0 object-contain', !roundel && className)}
      />
    )
  if (!roundel) return glyph
  return (
    <span
      aria-hidden="true"
      data-thread-color={fill ? color : undefined}
      style={{ width: size, height: size, ...(fill ? { backgroundColor: fill } : {}) }}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-pill',
        fill || framed
          ? 'bg-[var(--talos-cream)] shadow-[inset_0_0_0_1.5px_var(--talos-black)]'
          : 'bg-surface-2 text-text shadow-[inset_0_0_0_1px_var(--line)]',
        className,
      )}
    >
      {glyph}
    </span>
  )
}
