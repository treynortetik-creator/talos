// A drawn status mark (never a unicode glyph): ring = idle, half = working, solid = needs you, solid + ring = on a call,
// quarter = queued. Always next to the status word; colour comes from the surrounding text colour.
export type DotShape = 'ring' | 'half' | 'solid' | 'live' | 'quarter'

export function StatusDot({ shape, size = 10, className }: { shape: DotShape; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={`inline-block shrink-0 ${className ?? ''}`}
      fill="currentColor"
    >
      {shape === 'ring' && <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {shape === 'solid' && <circle cx="5" cy="5" r="4" />}
      {shape === 'half' && (
        <>
          <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 1.25a3.75 3.75 0 0 1 0 7.5z" />
        </>
      )}
      {shape === 'quarter' && (
        <>
          <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 5V1.25A3.75 3.75 0 0 1 8.75 5z" />
        </>
      )}
      {shape === 'live' && (
        <>
          <circle cx="5" cy="5" r="2.25" />
          <circle cx="5" cy="5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1" />
        </>
      )}
    </svg>
  )
}
