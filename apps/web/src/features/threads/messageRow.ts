// The look of the row of actions under a message (time, Copy, Listen and the menu button).

/** The row's actions show while the message is hovered or has focus (a mouse), and always on a touch screen. The row is the
 *  message's own `group`. A short wait before it appears under a mouse, so scrolling past does not flicker it; focus shows it at once. A Listen that is playing, loading or failed stays put: it is a status, not just a button. */
export const REVEAL =
  'opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100 group-hover:delay-150 group-focus-within:opacity-100 group-focus-within:delay-0 focus-visible:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100 data-[state=open]:opacity-100 data-[state=loading]:opacity-100 data-[state=playing]:opacity-100 data-[state=paused]:opacity-100 data-[state=failed]:opacity-100'
