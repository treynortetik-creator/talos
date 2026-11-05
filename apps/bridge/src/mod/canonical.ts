// The byte string both ends MAC. The mod (plugins/talos-app-mod/hooks/lib/hash.ts) carries its own copy of this function;
// a test pins the two together. Keys are sorted at every level so the order the JSON travelled in cannot matter, and
// `undefined` members are left out the way JSON.stringify leaves them out.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue
    parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`)
  }
  return `{${parts.join(',')}}`
}
