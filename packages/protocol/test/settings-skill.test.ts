// gate-reads: kit/.claude/skills/talos-settings/SKILL.md
// The kit skill `talos-settings` is generated from the settings table (src/settings-skill.ts): the file on disk is exactly what the
// generator renders, it lists every setting the agent may change and no setting it may not, and what it says about who may change
// which thread field agrees with what the protocol really refuses.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_RULES,
  AgentConfig,
  type AgentConfigT,
  type AgentSettingPath,
  resolveConfigChanges,
  SETTINGS_TABLE,
  type SettingPath,
  THREAD_FIELD_RULES,
  THREAD_FIELDS,
} from '../src/index.ts'
import { OWN_THREAD_FIELDS, renderSettingsSkill, SETTINGS_SKILL_REGENERATE } from '../src/settings-skill.ts'
import { loadExample } from './helpers.ts'

const FILE = join(import.meta.dirname, '../../../kit/.claude/skills/talos-settings/SKILL.md')
const text = renderSettingsSkill()
const rows = Object.entries(SETTINGS_TABLE) as Array<[SettingPath, (typeof SETTINGS_TABLE)[SettingPath]]>
const word = (s: string) =>
  new RegExp(`(^|[^A-Za-z0-9_.<>-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`)

describe('talos-settings skill', () => {
  it('the file on disk is exactly what the generator renders', () => {
    let disk = ''
    try {
      disk = readFileSync(FILE, 'utf8')
    } catch {
      // missing: the comparison below fails with the command
    }
    expect(
      disk === text,
      `kit/.claude/skills/talos-settings/SKILL.md is out of date. Regenerate it:\n${SETTINGS_SKILL_REGENERATE}`,
    ).toBe(true)
  })

  it('has the frontmatter a kit skill needs', () => {
    expect(text.startsWith('---\nname: talos-settings\ndescription: ')).toBe(true)
  })

  it('lists every setting the agent may change, by path and label', () => {
    for (const [path] of rows.filter(([, r]) => r.agent)) {
      expect(text, path).toContain(`\`${path}\``)
      expect(text, path).toContain(AGENT_RULES[path as AgentSettingPath].label)
      expect(text, path).toContain(AGENT_RULES[path as AgentSettingPath].hint)
    }
  })

  it('never lists a setting the agent may not change', () => {
    const no = rows.filter(([, r]) => !r.agent).map(([p]) => p)
    expect(no.length).toBeGreaterThan(3)
    for (const path of [...no, 'trust_mode', 'devices', 'keys', 'passkey', 'ops_read'])
      expect(text, path).not.toMatch(word(path))
  })

  it('says each risk in words, and no row is left without one', () => {
    for (const [path, row] of rows.filter(([, r]) => r.agent)) {
      const line = text.split('\n').find((l) => l.startsWith(`- \`${path}\``))
      expect(line, path).toBeDefined()
      expect(line, path).toContain(row.risk === 'high' ? 'Matters more' : 'Small change')
    }
  })

  it('lists every thread field, with who may change it', () => {
    for (const f of THREAD_FIELDS) {
      const line = text.split('\n').find((l) => l.startsWith(`- \`threads.<id>.${f}\``))
      expect(line, f).toBeDefined()
      expect(line, f).toContain(THREAD_FIELD_RULES[f].rule.hint)
      expect(line?.includes('its own session may change this'), f).toBe(OWN_THREAD_FIELDS.includes(f))
    }
  })

  it("the fields a thread's own session may change are the ones the protocol lets it change", () => {
    const base = loadExample('default')
    const T = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      name: id,
      kind: 'agent',
      order: 5,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      ...over,
    })
    const cfg: AgentConfigT = AgentConfig.parse({
      ...base,
      threads: [...base.threads, T('site', { session_opts: { cwd: '/Users/example/Code/site' } }), T('other')],
    })
    const roots = { home: '/Users/example', talosHome: '/Users/example/Library/Talos' }
    const sample: Record<string, unknown> = {
      name: 'Zed',
      topic: 'x',
      icon: 'key',
      notify: 'off',
      session: 'dedicated',
      archived: true,
      parent: null,
      idle_park_min: 45,
      color: 'red',
      effort: 'low',
      compact_window: 400000,
      model: 'opus',
      mcp_allow: ['github'],
      'session_opts.cwd': '/Users/example/Code/site/docs',
    }
    for (const f of THREAD_FIELDS) {
      const r = resolveConfigChanges([{ path: `threads.site.${f}`, value: sample[f] }], cfg, { thread: 'site', roots })
      if (OWN_THREAD_FIELDS.includes(f)) expect(r.ok, `${f}: ${r.ok ? '' : r.error}`).toBe(true)
      else {
        expect(r.ok, f).toBe(false)
        if (!r.ok) expect(r.error, f).toMatch(/can't (change|move)/)
      }
    }
  })
})
