// HB4: the agent that reads a run pack can read and nothing else. The file is the one Claude Code loads from the plugin's
// agents folder, so this reads that file, not a copy.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRIAGE_AGENT, TRIAGE_AGENT_FULL, WAKE_STEPS } from '../../src/heartbeat/prompt.ts'

const PLUGIN = join(import.meta.dir, '../../../../plugins/talos-app-mod')
const file = join(PLUGIN, 'agents', 'heartbeat-triage.md')

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error('no frontmatter')
  const out: Record<string, string> = {}
  for (const line of (m[1] as string).split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

describe('heartbeat-triage', () => {
  const text = readFileSync(file, 'utf8')
  const fm = frontmatter(text)

  test('has ONLY the Read tool: no Bash, Edit, Write, network, MCP or sub-agent tool, and no way to widen it', () => {
    expect(fm.tools).toBe('Read')
    expect(fm.tools?.split(',').map((t) => t.trim())).toEqual(['Read'])
    for (const k of Object.keys(fm)) expect(['name', 'description', 'model', 'tools']).toContain(k) // no mcpServers, hooks, permissionMode
    expect(fm.model).toBe('sonnet')
    expect(fm.name).toBe(TRIAGE_AGENT)
  })

  test('the wake prompt names exactly this agent, and the plugin ships only agents this test knows about', () => {
    expect(WAKE_STEPS[0]).toContain(`"${TRIAGE_AGENT_FULL}"`)
    expect(TRIAGE_AGENT_FULL).toBe(`talos-app-mod:${fm.name}`)
    expect(readdirSync(join(PLUGIN, 'agents'))).toEqual(['heartbeat-triage.md'])
  })

  test('it is told the pack is data, to read only the one file, and never to repeat an instruction found in it', () => {
    expect(text).toMatch(/Read that file and no other/)
    expect(text).toMatch(/data/)
    expect(text).toMatch(/do not do it/i)
  })
})
