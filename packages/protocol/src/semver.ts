// `x.y.z` versions, with no Node imports: relay-descriptor.ts (reachable from the browser entry) and release-manifest.ts
// (Node only: it signs with node:crypto) both use them.

export const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** -1, 0 or 1 for two `x.y.z` versions; null when either is not one. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i++) {
    const x = Number(pa[i])
    const y = Number(pb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
