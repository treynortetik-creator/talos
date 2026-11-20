// The inputs the path-rule test feeds every generator of file-tool permission rules. One file, so the fixture captured from the
// code before the Read/Edit-only change (test/fixtures/path-rules-before.json) and the test read the same inputs. Paths that do
// not exist, with capitals, so no real path resolution and the lower-case copies both show.
import { leadSettings } from '../src/lead/settings.ts'
import {
  agentScriptDenyRules,
  fenceDenyRules,
  settingsFileRules,
  stateFileAllowRules,
  stateFileDenyRules,
  workerFilesDenyRules,
} from '../src/supervisor/worker-policy.ts'

const H = '/Users/alex/.config/Talos/App'
const A = '/Users/alex/Talos-Agent'
const U = '/Users/alex'

export function allPathRules(): Record<string, string[]> {
  const s = settingsFileRules([A, `${A}/threads/T1`], [`${U}/.claude`], [`${A}/.mcp.json`], { home: U })
  // the developer thread fence off: the config folders' agents, skills and the like move to ask
  const off = settingsFileRules([A], [`${U}/.claude`], [], { home: U, fenceOff: true })
  return {
    fenceDenyRules: fenceDenyRules(H),
    workerFilesDenyRules: workerFilesDenyRules(H),
    settingsFileRulesDeny: s.deny,
    settingsFileRulesAsk: s.ask,
    settingsFileRulesFenceOffDeny: off.deny,
    settingsFileRulesFenceOffAsk: off.ask,
    agentScriptDenyRules: agentScriptDenyRules(A, U),
    stateFileAllowRules: stateFileAllowRules(A, 'research'),
    stateFileDenyRules: stateFileDenyRules(A, 'research'),
    leadSettingsLight: leadSettings({
      profile: 'light',
      agentDir: A,
      talosHome: H,
      home: U,
      claudeDir: `${U}/.claude`,
      folder: `${U}/Leads/One`,
      pathDirs: ['/opt/Homebrew/bin', '/usr/local/bin'],
    }).permissions.deny,
    leadSettingsSandbox: leadSettings({
      profile: 'sandbox',
      agentDir: A,
      talosHome: H,
      home: U,
      claudeDir: `${U}/.claude`,
      folder: `${U}/Leads/One`,
    }).permissions.deny,
  }
}
