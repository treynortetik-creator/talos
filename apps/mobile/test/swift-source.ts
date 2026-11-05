// The Swift here imports UIKit or Capacitor, so `swift test` cannot reach it. These helpers cut one function out of the
// source so a test can pin what that function does, not that its name appears somewhere in the file (a comment would do).

/** The text between the braces of the first function body that starts after `marker`. Throws if there is none. */
export function swiftBody(src: string, marker: string | RegExp): string {
  const at = typeof marker === 'string' ? src.indexOf(marker) : src.search(marker)
  if (at < 0) throw new Error(`no Swift source matches ${marker}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

/** The same source with `//` comments removed, so a word in a comment cannot satisfy a check. */
export const withoutComments = (src: string): string => src.replace(/(?<!:)\/\/[^\n]*/g, '')
