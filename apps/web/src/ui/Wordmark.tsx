import { cn } from './cn.ts'
import { WORDMARK_HEIGHT_EM, WORDMARK_PATH, WORDMARK_VIEWBOX, WORDMARK_WIDTH_EM } from './wordmark-path.ts'

// The brand wordmark TΛLOS: a vector drawn from Cinzel Black's own outlines (assets/brand/wordmark/generate.py), so the Λ
// sits exactly where the brand has it at every size, under every theme. It is filled with currentColor, so the theme still
// colours it; its height follows the font size it stands in for. Only the exact default name gets it; a custom agent
// name is text in the display font.
export function Wordmark({ name, className }: { name: string; className?: string }) {
  if (name !== 'Talos') return <span className={cn('font-display', className)}>{name}</span>
  return (
    <span role="img" aria-label="Talos" className={cn('wordmark', className)}>
      <svg
        aria-hidden="true"
        viewBox={WORDMARK_VIEWBOX}
        preserveAspectRatio="xMinYMid meet"
        style={{ height: `${WORDMARK_HEIGHT_EM}em`, width: `${WORDMARK_WIDTH_EM}em` }} // both set: no engine has to infer one
      >
        <path fill="currentColor" d={WORDMARK_PATH} />
      </svg>
    </span>
  )
}
