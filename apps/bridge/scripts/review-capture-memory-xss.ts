#!/usr/bin/env bun
// Review of PR #44: runs the REAL memory service over a SYNTHETIC notes folder holding hostile notes (the kind an agent
// or a web clipping can write) and saves the memory.file frames it answers with, for the web XSS specs.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realClock } from '../src/clock.ts'
import { nullLogger } from '../src/log.ts'
import { MemoryBrowser } from '../src/memory/service.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT = join(REPO, 'packages', 'testkit', 'fixtures', 'captured', 'memory', 'review-xss.json')
const FIXED = Date.parse('2026-10-20T12:00:00.000Z') / 1000

export const XSS_NOTES: Record<string, string> = {
  'Overview.md': '# Overview\nhello\n',
  // a link the author writes by hand to the app's internal slot URL, with a title that closes the tag early
  'title-img.md':
    '# T\nSee [Overview](https://memory.invalid/i/0 "x><img src=x onerror=window.__xss=(window.__xss||0)+1>") now.\n',
  // the same against a slot the Mac never listed (null link branch)
  'title-svg.md': '# T\n[gone](https://memory.invalid/i/7 "a><svg onload=window.__xss=(window.__xss||0)+1>")\n',
  // a real wiki link next to a hostile hand-made slot
  'mixed.md':
    '# M\n[[Overview]] and [b](https://memory.invalid/i/0 "q><img src=x onerror=window.__xss=(window.__xss||0)+1>")\n',
  // guards: these must stay text
  'front.md':
    '---\ntitle: <img src=x onerror=window.__xss=1>\nx: <svg onload=window.__xss=1>\n---\n# F\n<script>window.__xss=1</script>\n[[Overview|<img src=x onerror=window.__xss=1>]]\n[j](javascript:window.__xss=1)\n',
}

export async function captureXss() {
  const agent = mkdtempSync(join(tmpdir(), 'talos-rev-xss-'))
  const home = mkdtempSync(join(tmpdir(), 'talos-rev-xss-home-'))
  try {
    const n = join(agent, 'notes')
    for (const [rel, body] of Object.entries(XSS_NOTES)) {
      const f = join(n, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, body)
      utimesSync(f, FIXED, FIXED)
    }
    writeFileSync(
      join(home, 'memory.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        agent_dir: agent,
        roots: [{ id: 'notes', label: 'Notes', path: 'notes' }],
        max_file_kb: 512,
      }),
    )
    const svc = new MemoryBrowser({ home, clock: realClock, log: nullLogger, switchOn: () => true, watch: false })
    await svc.idle()
    const frames = []
    let i = 0
    for (const rel of Object.keys(XSS_NOTES)) {
      const body = await svc.read({ root_id: 'notes', path: rel, offset: 0 } as never)
      i++
      frames.push({
        asked: 'memory.read',
        frame: {
          v: 1,
          id: `01J2000000000000000000${String(i).padStart(4, '0')}`,
          ts: '2026-10-29T12:00:00.000Z',
          type: 'memory.file',
          request_id: `01J3000000000000000000${String(i).padStart(4, '0')}`,
          ...body,
        },
      })
    }
    svc.stop()
    return { scenario: 'review-xss', frames }
  } finally {
    rmSync(agent, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const c = await captureXss()
  writeFileSync(OUT, `${JSON.stringify(c, null, 2)}\n`)
  console.log(`wrote ${c.frames.length} frames to ${OUT}`)
}
