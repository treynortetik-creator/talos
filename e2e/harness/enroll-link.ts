import { parseEnrollFragment } from '@talos-app/protocol'

/** The code in a setup link the bridge printed (`…/enroll#<code>[&fp=…]`), read the way the app reads it. */
export function enrollCodeOf(link: string): string {
  const r = parseEnrollFragment(link)
  if (!r.ok) throw new Error(`not a setup link (${r.error})`)
  return r.code
}
