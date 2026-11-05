import type { ComponentProps } from 'react'

/** A labelled scroll container. Keyboard-focusable so it can be scrolled without a pointer (axe: scrollable-region-focusable). */
export function ScrollRegion({ label, ...props }: ComponentProps<'div'> & { label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled scroll region, not a <section>
    // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1, scrollable regions must take focus
    <div role="region" aria-label={label} tabIndex={0} {...props} />
  )
}
