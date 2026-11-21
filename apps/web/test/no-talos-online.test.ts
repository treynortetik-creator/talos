// One plain name for the server Talos runs through: "Talos server" (the lead's call for every app, 2026-11-20). "Talos
// online" was used for the same thing in some screens; it must not come back. Comments are skipped; any other line of the web
// app's source that says it fails here, with where.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', 'src')

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** The line without a trailing // comment (a // inside a string, like a URL, is kept: good enough for prose). */
const code = (line: string) => {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
  return line.replace(/\s\/\/\s.*$/, '')
}

describe('the server has one name', () => {
  it('no screen text says "Talos online"', () => {
    const all = files(SRC)
    expect(all.length).toBeGreaterThan(300) // the scan really ran over the app
    const hits: string[] = []
    for (const f of all)
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/talos online/i.test(code(line))) hits.push(`${relative(SRC, f)}:${i + 1}  ${line.trim().slice(0, 120)}`)
        })
    expect(hits).toEqual([])
  })
})
