// R1-2: Telegram's plugin can still answer a permission prompt even though Talos no longer mirrors to it, so the doctor
// must keep naming it as another relaying channel.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOtherChannels, OTHER_CHANNEL_PLUGINS } from '../src/permission/doctor.ts'

describe('doctor still lists the Telegram channel plugin', () => {
  test('telegram is in OTHER_CHANNEL_PLUGINS', () => {
    expect(OTHER_CHANNEL_PLUGINS).toContain('telegram')
  })
  test('an enabled telegram plugin in settings.json is found', () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'talos-doc-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true } }),
    )
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    const r = findOtherChannels({ claudeDir, agentDir, processes: () => [] })
    expect(r.names).toEqual(['telegram'])
  })
  test('a running claude --channels plugin:telegram@... line is found', () => {
    const r = findOtherChannels({
      claudeDir: mkdtempSync(join(tmpdir(), 'talos-doc-')),
      agentDir: mkdtempSync(join(tmpdir(), 'talos-agent-')),
      processes: () => ['claude --channels plugin:telegram@claude-plugins-official'],
    })
    expect(r.names).toEqual(['telegram'])
  })
})
