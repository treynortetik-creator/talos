/** The screen a path belongs to: a thread and its sub-pages are one screen, every other path is its own. */
export function screenOf(pathname: string): string {
  const m = /^\/t\/([^/]+)/.exec(pathname)
  return m ? `/t/${m[1]}` : pathname
}

/**
 * Paths that show a thread without naming it: `/card/:id` renders the thread the card belongs to, and `/open/:ref` redirects to
 * one. Moving to or from them is not leaving the screen (a clip playing in the thread goes on); the next real route decides.
 */
export const isTransientPath = (pathname: string): boolean => /^\/(card|open)\//.test(pathname)
