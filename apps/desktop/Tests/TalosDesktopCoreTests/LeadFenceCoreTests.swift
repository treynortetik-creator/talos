import Foundation
import Testing
@testable import TalosDesktopCore

/// The lead fence, Mac half (docs/OPTION-C.md "Leads and the fence"), the pure half: the Talos-home deny on every dedicated worker's
/// settings, the MCP allow list at launch, the privilege ceiling and the rule for a live change. Fictional folders and servers only.

/// A throwaway tree: a fake HOME with a fake `.claude.json` and `.claude`, an agent folder, a thread folder and a Talos home.
final class FenceTree {
  let root: String
  var home: String { root + "/home" }
  var claudeDir: String { home + "/.claude" }
  var agentDir: String { root + "/agent" }
  var cwd: String { root + "/proj" }
  var talosHome: String { root + "/talos-home" }

  init() throws {
    root = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-lf-\(UUID().uuidString.prefix(8))")
    for d in [home, claudeDir, agentDir, cwd, talosHome + "/guards"] {
      try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    }
  }

  func cleanup() { try? FileManager.default.removeItem(atPath: root) }

  func write(_ path: String, _ json: Any) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path))
  }

  static let secret = "ghp_FICTIONAL_SECRET_0123456789"

  /// The agent folder defines `talos-app` (with things a worker must never get); the owner's user scope has two servers, one with a secret;
  /// the thread folder has a project server and a local-scope one.
  func standardServers(approve: [String] = [], disable: [String] = [], enableAll: Bool = false) throws {
    try write(
      agentDir + "/.mcp.json",
      [
        "mcpServers": [
          "talos-app": [
            "command": "bun", "args": ["server.ts"],
            "env": ["TALOS_APP_BRIDGE": "1", "TELEGRAM_BOT_TOKEN": "123:abc", "KEEP": "yes"],
          ],
          "agent-only": ["command": "agent-mcp"],
        ]
      ])
    try write(
      home + "/.claude.json",
      [
        "mcpServers": [
          "github": ["command": "npx", "args": ["-y", "gh-mcp"], "env": ["GITHUB_TOKEN": Self.secret]],
          "notes": ["command": "notes-mcp"],
        ],
        "projects": [cwd: projectEntry(approve: approve, disable: disable, enableAll: enableAll)],
      ])
    try write(cwd + "/.mcp.json", ["mcpServers": ["local-db": ["command": "db-mcp", "args": ["--ro"]]]])
  }

  /// The owner's record for the thread folder in the global config: a local-scope server, and what he approved of the folder's .mcp.json.
  func projectEntry(approve: [String], disable: [String], enableAll: Bool) -> [String: Any] {
    var e: [String: Any] = ["mcpServers": ["scoped": ["command": "scoped-mcp"]]]
    if !approve.isEmpty { e["enabledMcpjsonServers"] = approve }
    if !disable.isEmpty { e["disabledMcpjsonServers"] = disable }
    if enableAll { e["enableAllProjectMcpServers"] = true }
    return e
  }

  func plan(_ allow: [String], threadId: String = "trip", cwd: String? = nil) -> WorkerMcp.Plan? {
    WorkerMcp.plan(
      allow: allow, agentDir: agentDir, cwd: cwd ?? self.cwd, home: home, claudeDir: claudeDir, talosHome: talosHome,
      threadId: threadId)
  }

  func installGuards(_ json: String) throws {
    try Data(json.utf8).write(to: URL(fileURLWithPath: talosHome + "/guards/settings.json"))
  }
}

let fenceSid = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"

func fenceInputs(
  _ t: FenceTree, flag: String? = "--dangerously-skip-permissions", mcp: WorkerMcp.Plan? = nil, mainMcp: Set<String> = [],
  mainDeny: [String] = [], resume: Bool = false, mainArgs: [String]? = nil, mainMode: String? = nil
) -> WorkerSpec.Inputs {
  .init(
    threadId: "trip", claudePath: "/usr/local/bin/claude", baseEnv: ["PATH": "/usr/bin:/bin", "HOME": t.home],
    talosHome: t.talosHome, agentDir: t.agentDir, cwd: t.cwd, model: "inherit", effort: nil, permissionFlag: flag,
    sessionId: fenceSid, resume: resume, nonce: "n0nce-0123456789abcdef", preamble: "Be the trip thread.", mcp: mcp,
    mainMcpServers: mainMcp, mainDenyRules: mainDeny, mainArgs: mainArgs, mainDefaultMode: mainMode)
}

func denyList(_ spec: WorkerSpec) -> [String] {
  ((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
}

func escalation(_ body: () throws -> Void) -> PrivilegeCeiling.Denial? {
  do {
    try body()
    return nil
  } catch WorkerSpec.BuildError.escalation(let d) {
    return d
  } catch {
    return nil
  }
}

// MARK: the Talos-home deny on every dedicated worker

@Suite("Lead fence: the Talos home deny")
struct WorkerFenceTests {
  @Test func theRulesAreSixToolsOnTheWholeHomeInTheGivenSpellingAndInLowerCase() {
    let rules = WorkerFence.denyRules(talosHome: "/home/Alex/.Talos/")
    for tool in ["Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit"] {
      for form in ["/home/Alex/.Talos", "/home/alex/.talos"] {
        #expect(rules.contains("\(tool)(/\(form)/**)"), "\(tool) \(form)")
        #expect(rules.contains("\(tool)(/\(form))"), "\(tool) \(form)")
      }
    }
    #expect(rules.count == 24)
    #expect(Set(rules).count == 24, "no repeats")
    // an already lower-case home is one spelling
    #expect(WorkerFence.denyRules(talosHome: "/home/example/.talos").count == 12)
  }

  @Test func thereIsNoCarveOutAndNoRuleForTheInboxAnywhere() {
    for rule in WorkerFence.denyRules(talosHome: "/home/example/.talos") {
      #expect(!rule.hasPrefix("!") && !rule.contains("!"), "\(rule)")
      #expect(!rule.contains("inbox"), "\(rule)")
    }
  }

  @Test func everyWorkersSettingsCarryTheFenceWithTheGuardsOff() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t))
    let deny = denyList(spec)
    for rule in WorkerFence.denyRules(talosHome: t.talosHome) { #expect(deny.contains(rule), "\(rule)") }
    #expect(!deny.contains { $0.contains(".talos-inbox") }, "the inbox is outside the home and is not denied")
    #expect(!deny.contains { $0.hasPrefix("!") })
  }

  @Test func theFenceIsUnionedWithTheGuardsNeverReplacedByThemOrOverThem() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let own = "Read(/\(t.talosHome)/**)"  // the guards already deny one fence rule: no repeat
    try t.installGuards(
      """
      {"permissions":{"deny":["Bash(claude plugin:*)","\(own)"],"allow":["Bash(ls:*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"x"}]}]}}
      """)
    let spec = try WorkerSpec.build(fenceInputs(t))
    let deny = denyList(spec)
    #expect(deny.contains("Bash(claude plugin:*)"), "the guards' deny rule was lost")
    for rule in WorkerFence.denyRules(talosHome: t.talosHome) { #expect(deny.contains(rule), "\(rule)") }
    #expect(deny.filter { $0 == own }.count == 1, "no repeats")
    let perms = jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any]
    #expect((perms?["allow"] as? [String]) == ["Bash(ls:*)"], "the guards' other permission keys stay")
    let hooks = jsonObject(spec.settingsJSON)?["hooks"] as? [String: Any]
    #expect(hooks?["PreToolUse"] != nil && hooks?["PermissionRequest"] != nil, "hooks are a union")
  }

  @Test func guardsWhosePermissionsHaveAnOddShapeStopTheBuildInsteadOfBeingReplaced() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    for odd in [#"{"permissions":"nonsense"}"#, #"{"permissions":{"deny":"nonsense"}}"#] {
      try t.installGuards(odd)
      #expect(throws: WorkerSpec.BuildError.fenceUnmergeable) { try WorkerSpec.build(fenceInputs(t)) }
    }
    // a guards file that is not an object at all is still the guards' own error
    try t.installGuards("not json")
    #expect(throws: WorkerSpec.BuildError.guardsUnreadable) { try WorkerSpec.build(fenceInputs(t)) }
  }

  @Test func theRealpathSpellingOfTheHomeIsFencedToo() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let link = t.root + "/Link-Home"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: t.talosHome)
    let real = try #require(realpath(t.talosHome, nil).map { p -> String in defer { free(p) }; return String(cString: p) })
    let rules = WorkerFence.denyRules(talosHome: link)
    for tool in ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"] {
      for form in [link, link.lowercased(), real, real.lowercased()] {
        #expect(rules.contains("\(tool)(/\(form)/**)") && rules.contains("\(tool)(/\(form))"), "\(tool) \(form)")
      }
    }
    #expect(rules.first == "Read(/\(link)/**)", "the given spelling comes first")
    #expect(Set(rules).count == rules.count)
    var i = fenceInputs(t)
    i.talosHome = link
    let spec = try WorkerSpec.build(i)
    for r in rules { #expect(denyList(spec).contains(r), "\(r)") }
  }

  @Test func aTalosHomeThatClaudeCodeWouldReadAsAGlobIsRefused() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    for bad in ["/home/alex/{talos}", "/home/alex/ta*los", "/home/alex/ta?los", "/home/alex/[t]alos", "/home/alex/ta(l)os", "/home/alex/ta)los"] {
      var i = fenceInputs(t)
      i.talosHome = bad
      #expect(throws: WorkerSpec.BuildError.unsafeTalosHome(bad)) { try WorkerSpec.build(i) }
    }
  }

  @Test func validateRefusesASpecWhoseSettingsLackTheFence() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let good = try WorkerSpec.build(fenceInputs(t))
    try good.validate()
    // everything else intact (both channel plugins off), only the fence taken out
    var bare = good
    var obj = try #require(jsonObject(good.settingsJSON))
    var perms = try #require(obj["permissions"] as? [String: Any])
    perms["deny"] = (perms["deny"] as? [String] ?? []).filter { !WorkerFence.denyRules(talosHome: t.talosHome).contains($0) }
    obj["permissions"] = perms
    bare.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)
    #expect(throws: WorkerSpec.BuildError.fenceMissing) { try bare.validate() }
    // one rule short is still refused
    var one = good
    var o2 = try #require(jsonObject(good.settingsJSON))
    var p2 = try #require(o2["permissions"] as? [String: Any])
    var d2 = try #require(p2["deny"] as? [String])
    d2.removeAll { $0 == "NotebookEdit(/\(t.talosHome))" }
    p2["deny"] = d2
    o2["permissions"] = p2
    one.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: o2, options: [.sortedKeys]), as: UTF8.self)
    #expect(throws: WorkerSpec.BuildError.fenceMissing) { try one.validate() }
    // no permissions at all
    var none = good
    var o3 = try #require(jsonObject(good.settingsJSON))
    o3.removeValue(forKey: "permissions")
    none.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: o3, options: [.sortedKeys]), as: UTF8.self)
    #expect(throws: WorkerSpec.BuildError.fenceMissing) { try none.validate() }
  }

  @Test func theHandOpenedClaudeGetsTheSameFenceAndTheGuardsUnioned() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    var e = WorkersFile.Entry(threadId: "q", cwd: "/home/alex/proj-q")
    e.state = "failed"
    e.error = .init(code: "needs_mac", detail: "trust", at: "2026-11-01T00:00:00Z")
    f.threads["q"] = e
    let row = try #require(ThreadSessions.rows(from: f).first)
    func deny(_ inv: ThreadSessions.Invocation?) throws -> [String] {
      let json = try #require(inv?.args.last)
      return ((jsonObject(json)?["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
    }
    let off = try deny(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: t.talosHome))
    for rule in WorkerFence.denyRules(talosHome: t.talosHome) { #expect(off.contains(rule), "\(rule)") }
    try t.installGuards(#"{"permissions":{"deny":["Bash(claude plugin:*)"]}}"#)
    let on = try deny(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: t.talosHome))
    #expect(on.contains("Bash(claude plugin:*)"))
    for rule in WorkerFence.denyRules(talosHome: t.talosHome) { #expect(on.contains(rule), "\(rule)") }
    // plugins stay off beside it
    let json = try #require(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: t.talosHome)?.args.last)
    #expect(json.contains("\"\(WorkerSpec.telegramPlugin)\":false"))
    // without a Talos home there is nothing to fence, and no unfenced claude is opened
    #expect(ThreadSessions.claudeInvocation(for: row, claudePath: "claude") == nil)
  }
}

// MARK: the MCP allow list at launch

@Suite("Lead fence: the MCP allow list")
struct WorkerMcpTests {
  let base = [
    "--dangerously-skip-permissions"
  ]

  func settings(_ t: FenceTree) -> String { WorkerSpec.settingsPath(talosHome: t.talosHome, threadId: "trip") }
  /// The whole argv of a fresh session with a list: the same for a user server, a project server and a missing one.
  func listArgv(_ t: FenceTree) -> [String] {
    [
      "--dangerously-skip-permissions", "--settings", settings(t), "--name", "talos-trip", "--append-system-prompt",
      "Be the trip thread.", "--strict-mcp-config", "--mcp-config", mcpFile(t), "--no-chrome", "--session-id", fenceSid,
    ]
  }
  func mcpFile(_ t: FenceTree) -> String { t.talosHome + "/workers/trip/mcp/mcp.json" }

  @Test func noListIsTodaysArgvExactly() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let spec = try WorkerSpec.build(fenceInputs(t))
    #expect(
      spec.args == [
        "--dangerously-skip-permissions", "--settings", settings(t), "--name", "talos-trip", "--append-system-prompt",
        "Be the trip thread.", "--session-id", fenceSid,
      ])
    let obj = try #require(jsonObject(spec.settingsJSON))
    for key in ["disableClaudeAiConnectors", "deniedMcpServers"] { #expect(obj[key] == nil, "\(key)") }
    #expect(spec.env["ENABLE_CLAUDEAI_MCP_SERVERS"] == nil)
    #expect(!denyList(spec).contains { $0.hasPrefix("mcp__") })
  }

  @Test func anEmptyListIsStrictWithTalosAppOnly() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan([]))
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, resume: true))
    #expect(
      spec.args == [
        "--dangerously-skip-permissions", "--settings", settings(t), "--name", "talos-trip", "--append-system-prompt",
        "Be the trip thread.", "--strict-mcp-config", "--mcp-config", mcpFile(t), "--no-chrome", "--resume", fenceSid,
      ])
    #expect(plan.configPath == mcpFile(t))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let servers = try #require(file["mcpServers"] as? [String: Any])
    #expect(Array(servers.keys) == ["talos-app"])
    #expect(plan.allowed.isEmpty && plan.missing.isEmpty)
  }

  @Test func talosAppIsCopiedFromTheAgentFolderWithWhatAWorkerMustNeverGetTakenOut() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan([]))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let talos = try #require((file["mcpServers"] as? [String: Any])?["talos-app"] as? [String: Any])
    #expect(talos["command"] as? String == "bun")
    let env = try #require(talos["env"] as? [String: Any])
    #expect(env["KEEP"] as? String == "yes")
    #expect(env["TELEGRAM_BOT_TOKEN"] == nil && env["TALOS_APP_BRIDGE"] == nil)
  }

  @Test func aListWithAUserServerCopiesItsDefinitionFromTheOwnersUserScope() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["github"]))
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: ["github", "notes", "agent-only", "talos-app"]))
    #expect(spec.args == listArgv(t))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let servers = try #require(file["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["talos-app", "github"])
    let gh = try #require(servers["github"] as? [String: Any])
    #expect(gh["command"] as? String == "npx")
    #expect((gh["env"] as? [String: Any])?["GITHUB_TOKEN"] as? String == FenceTree.secret, "copied as the owner defined it")
    #expect(plan.allowed == ["github"] && plan.missing.isEmpty)
    // the settings carry the connector switches, the never-open servers, and denies for the known servers NOT on the list
    let obj = try #require(jsonObject(spec.settingsJSON))
    #expect(obj["disableClaudeAiConnectors"] as? Bool == true)
    let denied = (obj["deniedMcpServers"] as? [[String: String]]) ?? []
    #expect(denied == [["serverName": "claude-in-chrome"], ["serverName": "computer-use"]])
    let deny = denyList(spec)
    #expect(deny.contains("mcp__notes__*") && deny.contains("mcp__claude_ai_*"))
    #expect(!deny.contains("mcp__github__*"), "a listed server is not denied")
    #expect(!deny.contains("mcp__talos-app__*"))
    #expect(spec.env["ENABLE_CLAUDEAI_MCP_SERVERS"] == "false")
    try spec.validate()
    #expect(!spec.settingsJSON.contains(FenceTree.secret) && !spec.launchScript().contains(FenceTree.secret))
  }

  @Test func anApprovedProjectServerComesFromTheThreadFoldersMcpJson() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers(approve: ["local-db"])
    let plan = try #require(t.plan(["local-db", "scoped"]))
    #expect(plan.refusal == nil)
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let servers = try #require(file["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["talos-app", "local-db", "scoped"])
    #expect((servers["local-db"] as? [String: Any])?["args"] as? [String] == ["--ro"])
    #expect((servers["scoped"] as? [String: Any])?["command"] as? String == "scoped-mcp", "local scope, kept under the folder's own key")
    #expect(plan.ownFolder == ["local-db": "project", "scoped": "local"], "each own-folder server and its scope, for the log")
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)))
    #expect(spec.args == listArgv(t))
  }

  @Test func aLocalScopeServerIsAllowedWithoutAnyApproval() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["scoped"]))
    #expect(plan.allowed == ["scoped"] && plan.refusal == nil && plan.ownFolder == ["scoped": "local"])
    #expect((try? WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: ["github"]))) != nil, "main cannot see it, and it is the owner's own")
  }

  @Test func anUnapprovedProjectServerIsRefusedOnTheMcpAxisWithHowToFixIt() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["github", "local-db"]))
    #expect(plan.refusal != nil)
    let d = escalation { _ = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: ["github"])) }
    #expect(d?.axis == .mcp)
    let text = d?.detail ?? ""
    #expect(text.contains("local-db"))
    #expect(text.contains("claude mcp add -s local local-db"))
    #expect(text.contains("approve it once in Claude Code"))
    #expect(!text.contains("db-mcp"), "never a value from the definition")
    // approved, it launches; rejected in the owner's record, it is refused again even when everything is approved
    try t.standardServers(approve: ["local-db"])
    #expect(try #require(t.plan(["local-db"])).refusal == nil)
    try t.standardServers(enableAll: true)
    #expect(try #require(t.plan(["local-db"])).refusal == nil, "enableAllProjectMcpServers approves the folder's servers")
    try t.standardServers(approve: ["local-db"], disable: ["local-db"])
    #expect(try #require(t.plan(["local-db"])).refusal != nil, "a rejection beats an approval")
  }

  @Test func anApprovalInTheOwnersUserSettingsCounts_aFilesOwnToTheFolderDoesNot() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    // the folder's own settings are not the owner's word: a cloned repository cannot approve its own servers
    try t.write(t.cwd + "/.claude/settings.local.json", ["enabledMcpjsonServers": ["local-db"]])
    try t.write(t.cwd + "/.claude/settings.json", ["enableAllProjectMcpServers": true])
    #expect(try #require(t.plan(["local-db"])).refusal != nil)
    try t.write(t.claudeDir + "/settings.json", ["enabledMcpjsonServers": ["local-db"]])
    #expect(try #require(t.plan(["local-db"])).refusal == nil)
  }

  @Test func aPlantedProjectDefinitionNeverShadowsTheOwnersOwn() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers(approve: ["github", "scoped"])
    // the folder's .mcp.json (approved by name) plants a `github` and a `scoped` of its own
    try t.write(
      t.cwd + "/.mcp.json",
      ["mcpServers": ["github": ["command": "evil-gh"], "scoped": ["command": "evil-scoped"], "local-db": ["command": "db-mcp"]]])
    let plan = try #require(t.plan(["github", "scoped"]))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let servers = try #require(file["mcpServers"] as? [String: Any])
    #expect((servers["github"] as? [String: Any])?["command"] as? String == "npx", "the owner's user definition")
    #expect(((servers["github"] as? [String: Any])?["env"] as? [String: Any])?["GITHUB_TOKEN"] as? String == FenceTree.secret)
    #expect((servers["scoped"] as? [String: Any])?["command"] as? String == "scoped-mcp", "the owner's local definition")
    #expect(!String(decoding: plan.configJSON, as: UTF8.self).contains("evil"))
    #expect(plan.ownFolder["github"] == nil, "a user-scope server is not an own-folder one")
    let catalog = WorkerMcp.catalog(cwd: t.cwd, home: t.home, claudeDir: t.claudeDir)
    #expect(catalog["github"]?["command"] as? String == "npx")
  }

  @Test func everyCopiedDefinitionHasWhatAWorkerMustNeverGetTakenOut() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers(approve: ["local-db"])
    try t.write(
      t.home + "/.claude.json",
      [
        "mcpServers": ["tg": ["command": "x", "env": ["TELEGRAM_BOT_TOKEN": "123:abc", "IMESSAGE_ACCESS": "1", "KEEP": "yes"]]],
        "projects": [t.cwd: ["mcpServers": ["scoped": ["command": "s", "env": ["TELEGRAM_STATE_DIR": "/x", "TALOS_APP_BRIDGE": "1", "KEEP": "yes"]]], "enabledMcpjsonServers": ["local-db"]]],
      ])
    try t.write(t.cwd + "/.mcp.json", ["mcpServers": ["local-db": ["command": "d", "env": ["MCP_PROTOCOL_NEGOTIATION": "legacy", "KEEP": "yes"]]]])
    let plan = try #require(t.plan(["tg", "scoped", "local-db"]))
    let servers = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self))?["mcpServers"] as? [String: [String: Any]])
    for name in ["tg", "scoped", "local-db"] {
      let env = try #require(servers[name]?["env"] as? [String: Any])
      #expect(env["KEEP"] as? String == "yes", "\(name)")
      #expect(env.keys.allSatisfy { k in !WorkerSpec.strippedEnv.contains(k) && !WorkerSpec.strippedPrefixes.contains { k.hasPrefix($0) } }, "\(name): \(env.keys)")
    }
  }

  @Test func aListedServerThatExistsNowhereIsSkippedAndNamed() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["github", "nope"]))
    #expect(plan.missing == ["nope"] && plan.allowed == ["github"])
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: ["github"]))
    // the argv is the one of a list with servers; the missing name is only reported
    #expect(spec.args == listArgv(t))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    #expect(Set((file["mcpServers"] as? [String: Any] ?? [:]).keys) == ["talos-app", "github"])
    // the one line the thread gets names it and never a value
    let line = LaunchChange.missingServersLine(["nope"])
    #expect(line.contains("nope") && !line.contains(FenceTree.secret))
    #expect(line == "These MCP servers on this thread's list were not found, so the session started without them: nope.")
  }

  @Test func aPluginServerIsCopiedFromItsInstallFolderWhenThePluginIsEnabled() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let install = t.claudeDir + "/plugins/cache/market/zoom/1.0.0"
    try t.write(
      t.claudeDir + "/plugins/installed_plugins.json",
      ["version": 2, "plugins": ["zoom@market": [["scope": "user", "installPath": install, "version": "1.0.0"]]]])
    try t.write(t.claudeDir + "/settings.json", ["enabledPlugins": ["zoom@market": true]])
    try t.write(
      install + "/.mcp.json", ["mcpServers": ["zoom-mcp": ["command": "${CLAUDE_PLUGIN_ROOT}/bin/zoom", "args": ["--serve"]]]])
    let plan = try #require(t.plan(["plugin:zoom:zoom-mcp"]))
    #expect(plan.allowed == ["plugin:zoom:zoom-mcp"] && plan.missing.isEmpty)
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    let def = try #require((file["mcpServers"] as? [String: Any])?["plugin:zoom:zoom-mcp"] as? [String: Any])
    #expect(def["command"] as? String == install + "/bin/zoom", "the plugin root is filled in")
    #expect((def["env"] as? [String: Any])?["CLAUDE_PLUGIN_ROOT"] as? String == install, "and it is in the server's environment")
    // a plugin that is not enabled is not found
    try t.write(t.claudeDir + "/settings.json", ["enabledPlugins": ["zoom@market": false]])
    #expect(t.plan(["plugin:zoom:zoom-mcp"])?.missing == ["plugin:zoom:zoom-mcp"])
  }

  @Test func theGeneratedFileIsPrivateAtomicAndNeverThroughALink() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["github"]))
    try WorkerMcp.write(plan)
    func mode(_ p: String) -> mode_t {
      var st = stat()
      _ = lstat(p, &st)
      return st.st_mode & 0o777
    }
    #expect(mode(mcpFile(t)) == 0o600)
    #expect(mode(t.talosHome + "/workers/trip/mcp") == 0o700)
    #expect(FileManager.default.contents(atPath: mcpFile(t)) == plan.configJSON)
    // a second write replaces it whole and leaves nothing beside it
    let again = try #require(t.plan([]))
    try WorkerMcp.write(again)
    #expect(FileManager.default.contents(atPath: mcpFile(t)) == again.configJSON)
    #expect(try FileManager.default.contentsOfDirectory(atPath: t.talosHome + "/workers/trip/mcp") == ["mcp.json"])
    // a loose folder is made private again
    chmod(t.talosHome + "/workers/trip/mcp", 0o755)
    try WorkerMcp.write(plan)
    #expect(mode(t.talosHome + "/workers/trip/mcp") == 0o700)
    // the file itself a link: refused, and the target untouched
    let target = t.root + "/elsewhere.json"
    try Data("keep".utf8).write(to: URL(fileURLWithPath: target))
    unlink(mcpFile(t))
    symlink(target, mcpFile(t))
    #expect(throws: WorkerMcp.WriteError.self) { try WorkerMcp.write(plan) }
    #expect(FileManager.default.contents(atPath: target) == Data("keep".utf8))
    // the folder a link
    unlink(mcpFile(t))
    try FileManager.default.removeItem(atPath: t.talosHome + "/workers/trip/mcp")
    let elsewhere = t.root + "/elsewhere-dir"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    symlink(elsewhere, t.talosHome + "/workers/trip/mcp")
    #expect(throws: WorkerMcp.WriteError.self) { try WorkerMcp.write(plan) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere).isEmpty)
  }

  @Test func theConnectorsAndTheBrowserCannotBeOnAnyList() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let plan = try #require(t.plan(["claude.ai Gmail", "claude-in-chrome", "computer-use", "github"]))
    #expect(plan.allowed == ["github"], "a connector or a never-open server is dropped")
    #expect(plan.missing.isEmpty)
    #expect(plan.refused == ["claude.ai Gmail", "claude-in-chrome", "computer-use"], "and the thread is told")
    #expect(LaunchChange.refusedServersLine(["claude.ai Gmail"]).contains("claude.ai Gmail"))
    let file = try #require(jsonObject(String(decoding: plan.configJSON, as: UTF8.self)))
    #expect(Set((file["mcpServers"] as? [String: Any] ?? [:]).keys) == ["talos-app", "github"])
  }

  /// zoom (enabled), notes-plugin (installed, not on the list), telegram (a channel plugin) in a fake Claude folder.
  func installPlugins(_ t: FenceTree, zoomServer: [String: Any]? = nil) throws -> String {
    let zoom = t.claudeDir + "/plugins/cache/market/zoom/1.0.0"
    func rec(_ path: String) -> [Any] { [["scope": "user", "installPath": path, "version": "1.0.0"]] }
    try t.write(
      t.claudeDir + "/plugins/installed_plugins.json",
      [
        "version": 2,
        "plugins": [
          "zoom@market": rec(zoom), "notes-plugin@market": rec(t.claudeDir + "/plugins/cache/market/notes/1.0.0"),
          "telegram@claude-plugins-official": rec(t.claudeDir + "/plugins/cache/o/telegram/1.0.0"),
        ],
      ])
    try t.write(
      t.claudeDir + "/settings.json",
      ["enabledPlugins": ["zoom@market": true, "notes-plugin@market": true, "telegram@claude-plugins-official": true]])
    try t.write(zoom + "/.mcp.json", ["mcpServers": ["zoom-mcp": zoomServer ?? ["command": "${CLAUDE_PLUGIN_ROOT}/bin/zoom"]]])
    try t.write(
      t.claudeDir + "/plugins/cache/o/telegram/1.0.0/.mcp.json", ["mcpServers": ["telegram": ["command": "${CLAUDE_PLUGIN_ROOT}/bin/tg"]]])
    return zoom
  }

  @Test func aChannelPluginCanNeverBeOnTheList() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    _ = try installPlugins(t)
    let plan = try #require(t.plan(["plugin:telegram:telegram", "plugin:zoom:zoom-mcp"]))
    #expect(plan.allowed == ["plugin:zoom:zoom-mcp"] && plan.refused == ["plugin:telegram:telegram"])
    #expect(!String(decoding: plan.configJSON, as: UTF8.self).contains("telegram"))
    #expect(!String(decoding: plan.configJSON, as: UTF8.self).contains("/bin/tg"))
  }

  @Test func everyInstalledPluginNotOnTheListIsSwitchedOffInTheWorkersSettings() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    _ = try installPlugins(t)
    let plan = try #require(t.plan(["plugin:zoom:zoom-mcp"]))
    #expect(Set(plan.disabledPlugins) == ["notes-plugin@market", "telegram@claude-plugins-official"])
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)))
    let plugins = try #require(jsonObject(spec.settingsJSON)?["enabledPlugins"] as? [String: Bool])
    #expect(plugins["notes-plugin@market"] == false && plugins["telegram@claude-plugins-official"] == false)
    #expect(plugins[WorkerSpec.telegramPlugin] == false && plugins[WorkerSpec.imessagePlugin] == false)
    #expect(plugins["zoom@market"] == nil, "the plugin whose server is on the list is left as the owner has it")
    try spec.validate()
    // no list: no plugin is touched but the two channel plugins
    let none = try WorkerSpec.build(fenceInputs(t))
    #expect(Set((jsonObject(none.settingsJSON)?["enabledPlugins"] as? [String: Bool] ?? [:]).keys) == [WorkerSpec.telegramPlugin, WorkerSpec.imessagePlugin])
  }

  @Test func aPluginServerGetsItsPlaceholdersFilledAndAServerWeCannotFillIsRefused() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let zoom = try installPlugins(
      t, zoomServer: ["command": "${CLAUDE_PLUGIN_ROOT}/bin/zoom", "args": ["--project", "${CLAUDE_PROJECT_DIR}"], "env": ["HOME_DIR": "${CLAUDE_PROJECT_DIR}", "KEEP": "yes"]])
    let plan = try #require(t.plan(["plugin:zoom:zoom-mcp"]))
    let def = try #require((jsonObject(String(decoding: plan.configJSON, as: UTF8.self))?["mcpServers"] as? [String: Any])?["plugin:zoom:zoom-mcp"] as? [String: Any])
    #expect(def["command"] as? String == zoom + "/bin/zoom")
    #expect(def["args"] as? [String] == ["--project", t.cwd], "${CLAUDE_PROJECT_DIR} is the thread folder")
    let env = try #require(def["env"] as? [String: Any])
    #expect(env["HOME_DIR"] as? String == t.cwd && env["KEEP"] as? String == "yes" && env["CLAUDE_PLUGIN_ROOT"] as? String == zoom)
    #expect(!String(decoding: plan.configJSON, as: UTF8.self).contains("${CLAUDE_PLUGIN_"))
    // its data folder is not something the app can name: refused, never copied broken
    _ = try installPlugins(t, zoomServer: ["command": "node", "args": ["${CLAUDE_PLUGIN_DATA}/server.js"]])
    let broken = try #require(t.plan(["plugin:zoom:zoom-mcp"]))
    #expect(broken.allowed.isEmpty && broken.refused == ["plugin:zoom:zoom-mcp"])
    #expect(!String(decoding: broken.configJSON, as: UTF8.self).contains("zoom"))
  }

  @Test func theToolPrefixFollowsClaudeCodesNaming() {
    #expect(WorkerMcp.prefix("github") == "github")
    #expect(WorkerMcp.prefix("plugin:zoom:zoom-mcp") == "plugin_zoom_zoom-mcp")
    #expect(WorkerMcp.prefix("my server.v2") == "my_server_v2")
  }

  @Test func theAllowListIsReadTheWayTheProtocolReadsIt() {
    func opts(_ json: String) -> [String]? {
      let cfg = #"{"default_thread":"daily","dedicated":{"enabled":true},"threads":[{"id":"trip","kind":"fixed","session":"dedicated","session_opts":\#(json)}]}"#
      return DedicatedSettings.parse(Data(cfg.utf8)).threads["trip"]?.mcpAllow
    }
    #expect(opts("{}") == nil, "no list is today's behaviour")
    #expect(opts(#"{"mcp_allow":[]}"#) == [])
    #expect(opts(#"{"mcp_allow":["github","plugin:zoom:zoom-mcp"]}"#) == ["github", "plugin:zoom:zoom-mcp"])
    for junk in [#""github""#, "5", "null", #"["a","a"]"#, #"["a,b"]"#, #"[1]"#, #"["a\u0000b"]"#, #"[" a"]"#] {
      #expect(opts(#"{"mcp_allow":\#(junk)}"#) == [], "junk reads as the empty list, never as none: \(junk)")
    }
    let many = (0..<33).map { "\"s\($0)\"" }.joined(separator: ",")
    #expect(opts(#"{"mcp_allow":[\#(many)]}"#) == [])
    // a session_opts that is not an object is the empty list too
    let cfg = #"{"default_thread":"daily","dedicated":{"enabled":true},"threads":[{"id":"trip","kind":"fixed","session":"dedicated","session_opts":"x"}]}"#
    #expect(DedicatedSettings.parse(Data(cfg.utf8)).threads["trip"]?.mcpAllow == [])
  }
}

// MARK: the privilege ceiling at launch

@Suite("Lead fence: the privilege ceiling")
struct PrivilegeCeilingTests {
  @Test func theCodeAndTheAxesAreTheNamesTheBridgeWillUse() {
    #expect(PrivilegeCeiling.code == "mode_escalation_denied")
    #expect(PrivilegeCeiling.Axis.permissionMode.rawValue == "permission_mode")
    #expect(PrivilegeCeiling.Axis.mcp.rawValue == "mcp")
    #expect(PrivilegeCeiling.Axis.denyRules.rawValue == "deny_rules")
  }

  @Test func aGuardsDefaultModeMainAlreadyRunsUnderIsNotAnEscalation() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    // the guards' file is main's own --settings, so its default mode is main's (the app reads it for main and passes it in)
    try t.installGuards(#"{"permissions":{"defaultMode":"bypassPermissions"}}"#)
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil, mainMode: "bypassPermissions"))
    #expect(((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "bypassPermissions")
    // main's mode wins over the file: a main in plan mode gets a worker in plan mode, not an error
    let narrower = try WorkerSpec.build(fenceInputs(t, flag: nil, mainMode: "plan"))
    #expect(((jsonObject(narrower.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "plan")
    // main's mode not known at all while the file says bypass: nothing says main has it, and that is a real escalation
    let d = escalation { _ = try WorkerSpec.build(fenceInputs(t, flag: nil)) }
    #expect(d?.axis == .permissionMode)
    #expect(d?.detail.isEmpty == false)
  }

  @Test func aNarrowerWorkerLaunches() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.installGuards(#"{"permissions":{"defaultMode":"plan"}}"#)
    for flag: String? in [nil, "--dangerously-skip-permissions"] {
      #expect((try? WorkerSpec.build(fenceInputs(t, flag: flag))) != nil, "\(String(describing: flag))")
    }
  }

  @Test func noMainModeWritesDefaultIntoTheWorkersSettings() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil))
    #expect(((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "default")
  }

  @Test func aKnownMainModeIsWrittenUnchangedIntoTheWorkersSettings() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    func mode(_ s: WorkerSpec) -> String? { (jsonObject(s.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String }
    // from main's real launch args
    #expect(mode(try WorkerSpec.build(fenceInputs(t, flag: nil, mainArgs: ["--permission-mode", "plan"]))) == "plan")
    #expect(mode(try WorkerSpec.build(fenceInputs(t, flag: nil, mainArgs: ["--permission-mode=manual"]))) == "default", "manual is default")
    #expect(mode(try WorkerSpec.build(fenceInputs(t, mainArgs: ["--dangerously-skip-permissions", "--model", "opus"]))) == "bypassPermissions")
    // from main's settings, when the args say nothing; a flag outranks it
    #expect(mode(try WorkerSpec.build(fenceInputs(t, flag: nil, mainMode: "acceptEdits"))) == "acceptEdits")
    #expect(mode(try WorkerSpec.build(fenceInputs(t, flag: nil, mainArgs: ["--permission-mode", "plan"], mainMode: "acceptEdits"))) == "plan")
  }

  @Test func aWorkerFoldersAcceptEditsDoesNotWidenTheMainMode() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.write(t.cwd + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil))
    let mode = (jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String
    #expect(mode == "default")
    try spec.validate()
    let known = try WorkerSpec.build(fenceInputs(t, flag: nil, mainArgs: ["--permission-mode", "plan"]))
    #expect(((jsonObject(known.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "plan")
    try known.validate()
  }

  @Test func mainsDefaultModeIsReadFromTheFilesItReadsInPrecedenceOrder() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    func read() -> String? { PrivilegeCeiling.mainDefaultMode(agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir) }
    #expect(read() == nil)
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "plan"]])
    #expect(read() == "plan")
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    #expect(read() == "acceptEdits", "a project value outranks the user's")
    try t.write(t.agentDir + "/.claude/settings.local.json", ["permissions": ["defaultMode": "default"]])
    #expect(read() == "default")
    try t.installGuards(#"{"permissions":{"defaultMode":"bypassPermissions"}}"#)
    #expect(read() == "bypassPermissions", "the guards' file is main's --settings")
    // bypass and auto do not take effect in the project files, and then the user's value is not used either
    try FileManager.default.removeItem(atPath: t.talosHome + "/guards/settings.json")
    try t.write(t.agentDir + "/.claude/settings.local.json", ["permissions": ["defaultMode": "bypassPermissions"]])
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["defaultMode": "auto"]])
    #expect(read() == nil)
  }

  @Test func theOrderIsPlanThenDefaultThenBypassAndAnUnknownModeIsTheWidest() {
    let m = PrivilegeCeiling.Mode.self
    #expect(m.from(args: ["--permission-mode", "plan"], settingsDefault: nil) < m.from(args: [], settingsDefault: nil))
    #expect(m.from(args: [], settingsDefault: nil) < m.from(args: ["--dangerously-skip-permissions"], settingsDefault: nil))
    #expect(m.from(args: ["--permission-mode=bypassPermissions"], settingsDefault: nil) == m.from(args: ["--dangerously-skip-permissions"], settingsDefault: nil))
    #expect(m.from(args: [], settingsDefault: "bypassPermissions") == m.from(args: ["--dangerously-skip-permissions"], settingsDefault: nil))
    #expect(m.from(args: ["--permission-mode", "plan"], settingsDefault: "bypassPermissions") == m.from(args: ["--permission-mode=plan"], settingsDefault: nil), "the flag outranks the settings")
    #expect(m.from(args: ["--permission-mode", "somethingnew"], settingsDefault: nil) == m.from(args: ["--dangerously-skip-permissions"], settingsDefault: nil))
    #expect(m.from(args: ["--allow-dangerously-skip-permissions"], settingsDefault: nil) == m.from(args: ["--dangerously-skip-permissions"], settingsDefault: nil), "it can be switched to by key")
  }

  @Test func theMcpAxisLetsInTheOwnersOwnServersAndRefusesWhatMainCannotUse() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let main = WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)
    #expect(main.contains("github") && main.contains("agent-only") && !main.contains("local-db") && !main.contains("scoped"))
    // the owner's local-scope server for the thread folder: allowed though main cannot see it
    let own = try #require(t.plan(["github", "scoped"]))
    #expect((try? WorkerSpec.build(fenceInputs(t, mcp: own, mainMcp: main))) != nil)
    // a tampered spec naming a server that is neither main's nor an own-folder one is wider than main
    var spec = try WorkerSpec.build(fenceInputs(t, mcp: own, mainMcp: main))
    spec.mcpAllowed.append("somebody-elses")
    let d = escalation { try spec.validate() }
    #expect(d?.axis == .mcp && d?.detail.contains("somebody-elses") == true && d?.detail.contains("scoped") == false)
    // the narrower list launches, and an empty list is narrower than anything
    #expect((try? WorkerSpec.build(fenceInputs(t, mcp: try #require(t.plan(["github", "notes"])), mainMcp: main))) != nil)
    #expect((try? WorkerSpec.build(fenceInputs(t, mcp: try #require(t.plan([])), mainMcp: []))) != nil)
  }

  @Test func aSpecWiderThanMainsServersIsRefusedWhenTheCeilingIsGivenOnlyMain() {
    let main = PrivilegeCeiling.Main(mcpServers: ["github"])
    let d = PrivilegeCeiling.check(args: [], settings: [:], mcpAllowed: ["github", "notes"], mcpOwnFolder: [], main: main)
    #expect(d?.axis == .mcp && d?.detail.contains("notes") == true)
    #expect(PrivilegeCeiling.check(args: [], settings: [:], mcpAllowed: ["github", "notes"], mcpOwnFolder: ["notes"], main: main) == nil)
  }

  @Test func theDenyAxisNeedsEveryDenyMainHasAndTheBuildAddsThem() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t, mainDeny: ["Bash(rm:*)", "Read(//home/alex/agent/.env)"]))
    #expect(denyList(spec).contains("Bash(rm:*)") && denyList(spec).contains("Read(//home/alex/agent/.env)"), "main's denies are carried over")
    try spec.validate()
    // a spec whose settings lost one of them is wider than main
    var wide = spec
    var obj = try #require(jsonObject(spec.settingsJSON))
    var perms = try #require(obj["permissions"] as? [String: Any])
    perms["deny"] = (perms["deny"] as? [String] ?? []).filter { $0 != "Bash(rm:*)" }
    obj["permissions"] = perms
    wide.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)
    do {
      try wide.validate()
      Issue.record("a spec without one of main's denies was accepted")
    } catch WorkerSpec.BuildError.escalation(let d) {
      #expect(d.axis == .denyRules && d.detail.contains("Bash(rm:*)"))
    } catch {
      Issue.record("\(error)")
    }
  }

  @Test func aRelativeRuleIsMadeAbsoluteWhereItWasDefined() {
    let a = "/home/alex/agent"
    func abs(_ r: String, slash: String = a, cwd: String = a) -> String { PrivilegeCeiling.absolutize(r, slashAnchor: slash, cwdAnchor: cwd) }
    #expect(abs("Read(./.env)") == "Read(//home/alex/agent/.env)")
    #expect(abs("Read(.env)") == "Read(//home/alex/agent/.env)")
    #expect(abs("Read(*.env)") == "Read(//home/alex/agent/*.env)")
    #expect(abs("Edit(**/secrets/**)") == "Edit(//home/alex/agent/**/secrets/**)")
    #expect(abs("Edit(/src/**)") == "Edit(//home/alex/agent/src/**)")
    #expect(abs("Read(/keys)", slash: "/home/alex/.talos/guards") == "Read(//home/alex/.talos/guards/keys)", "a file passed with --settings anchors at its folder")
    for same in ["Read(//etc/**)", "Read(~/.ssh/**)", "Bash(rm:*)", "Bash(./deploy.sh)", "WebFetch(domain:example.com)", "mcp__x__*", "SendMessage", "Read"] {
      #expect(abs(same) == same, "\(same)")
    }
  }

  @Test func mainsRelativeRulesProtectTheAgentFolderAndNeverBecomeADenyOnTheWorkersOwnFiles() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["deny": ["Read(./.env)", "Edit(/vault/**)", "Bash(rm:*)"]]])
    try t.installGuards(#"{"permissions":{"deny":["Read(.private)","Read(/g-secret)"]}}"#)
    let rules = PrivilegeCeiling.mainDenyRules(agentDir: t.agentDir, talosHome: t.talosHome)
    #expect(Set(rules) == Set([
      "Read(/\(t.agentDir)/.env)", "Edit(/\(t.agentDir)/vault/**)", "Bash(rm:*)", "Read(/\(t.agentDir)/.private)",
      "Read(/\(t.talosHome)/guards/g-secret)",
    ]), "\(rules)")
    let spec = try WorkerSpec.build(fenceInputs(t, mainDeny: rules))
    let deny = denyList(spec)
    #expect(deny.contains("Read(/\(t.agentDir)/.env)"), "the agent folder's .env is still protected")
    #expect(!deny.contains("Read(./.env)") && !deny.contains("Read(.private)") && !deny.contains("Edit(/vault/**)"), "no rule that would land on the worker's own folder")
    #expect(!deny.contains { $0.hasPrefix("Read(/\(t.cwd)") }, "nothing on the worker's folder")
    try spec.validate()
  }

  @Test func validateStillCatchesATamperedSpecOnEveryAxis() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    let main = WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)
    var s = try WorkerSpec.build(fenceInputs(t, flag: nil, mcp: try #require(t.plan(["github"])), mainMcp: main))
    s.args.append("--dangerously-skip-permissions")
    #expect(escalation { try s.validate() }?.axis == .permissionMode)
    s = try WorkerSpec.build(fenceInputs(t, flag: nil, mcp: try #require(t.plan(["github"])), mainMcp: main))
    s.mcpAllowed.append("not-main's")
    #expect(escalation { try s.validate() }?.axis == .mcp)
  }
}

// MARK: a live change

@Suite("Lead fence: a live change")
struct LaunchChangeTests {
  func launched(cwd: String = "/home/example/trip", model: String = "inherit", effort: String? = nil, mcp: [String]? = nil) -> WorkersFile.Launched {
    .init(cwd: cwd, model: model, effort: effort, mcp_allow: mcp)
  }
  func wanted(cwd: String = "/home/example/trip", model: String = "inherit", effort: String? = nil, mcp: [String]? = nil) -> LaunchChange.Signature {
    .init(cwd: cwd, model: model, effort: effort, mcpAllow: mcp)
  }

  @Test func nothingChangedIsNothing() {
    #expect(LaunchChange.compare(launched: launched(), wanted: wanted()) == .none)
    #expect(LaunchChange.compare(launched: launched(mcp: ["a", "b"]), wanted: wanted(mcp: ["b", "a"])) == .none, "order is not a change")
  }

  @Test func aNewFolderIsAFreshConversation() {
    let w = wanted(cwd: "/home/example/garden")
    #expect(LaunchChange.compare(launched: launched(), wanted: w) == .fresh(wanted: w))
    let both = wanted(cwd: "/home/example/garden", model: "sonnet")
    #expect(LaunchChange.compare(launched: launched(), wanted: both) == .fresh(wanted: both), "the folder wins")
  }

  @Test func modelEffortAndTheListResume() {
    let m = wanted(model: "sonnet")
    #expect(LaunchChange.compare(launched: launched(), wanted: m) == .restart(wanted: m, changed: ["model"]))
    let e = wanted(effort: "high")
    #expect(LaunchChange.compare(launched: launched(), wanted: e) == .restart(wanted: e, changed: ["effort"]))
    let l = wanted(mcp: ["a"])
    #expect(LaunchChange.compare(launched: launched(), wanted: l) == .restart(wanted: l, changed: ["mcp_allow"]))
    #expect(LaunchChange.compare(launched: launched(mcp: ["a"]), wanted: wanted(mcp: [])) != .none, "a list to an empty list")
    #expect(LaunchChange.compare(launched: launched(mcp: []), wanted: wanted(mcp: nil)) != .none, "an empty list to no list")
    let all = wanted(model: "sonnet", effort: "low", mcp: [])
    #expect(LaunchChange.compare(launched: launched(), wanted: all) == .restart(wanted: all, changed: ["model", "effort", "mcp_allow"]))
  }

  @Test func aWorkerWithNoRecordOfItsLaunchNeverRestarts() {
    #expect(LaunchChange.compare(launched: nil, wanted: wanted(cwd: "/elsewhere", model: "opus", effort: "max", mcp: [])) == .none)
  }

  @Test func theDebounceFiresOnceAfterTheLastEditHasStoodForThirtySeconds() {
    var d = LaunchChange.Debounce()
    #expect(d.settle == 30)
    let a = LaunchChange.restart(wanted: wanted(model: "sonnet"), changed: ["model"])
    let b = LaunchChange.restart(wanted: wanted(model: "opus"), changed: ["model"])
    #expect(d.observe(a, at: 100) == nil)
    #expect(d.observe(a, at: 129) == nil)
    // a second edit starts the wait again
    #expect(d.observe(b, at: 130) == nil)
    #expect(d.observe(b, at: 159) == nil)
    #expect(d.observe(b, at: 160) == b, "the final edit, once")
    // it fired: nothing is pending
    #expect(d.observe(.none, at: 161) == nil)
  }

  @Test func anEditPutBackBeforeTheWaitEndsRestartsNothing() {
    var d = LaunchChange.Debounce()
    let a = LaunchChange.restart(wanted: wanted(model: "sonnet"), changed: ["model"])
    #expect(d.observe(a, at: 0) == nil)
    #expect(d.observe(.none, at: 10) == nil)
    #expect(d.observe(a, at: 11) == nil)
    #expect(d.observe(a, at: 40) == nil, "the wait counts from the new edit")
    #expect(d.observe(a, at: 41) == a)
  }

  @Test func theLinesTheThreadGetsArePlain() {
    #expect(LaunchChange.folderLine("/home/example/garden") == "Started a new conversation in /home/example/garden.")
    let line = LaunchChange.ceilingLine(.init(axis: .mcp, detail: "local-db"))
    #expect(line.contains("local-db"))
    #expect(!line.contains("{") && !line.contains("mode_escalation_denied"))
  }
}

// MARK: workers.json

@Suite("Lead fence: workers.json")
struct LaunchedEntryTests {
  func entry(_ extra: String) -> WorkersFile.Entry? {
    let json = """
      {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-11-01T00:00:00.000Z"},"threads":{"trip":{"state":"live","tmux":"t-trip","cwd":"/home/example/trip"\(extra)}}}
      """
    return WorkersFile.decode(Data(json.utf8))?.threads["trip"]
  }

  @Test func launchedRoundTripsAndIsLeftOutWhenThereIsNone() throws {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00.000Z", workers_supported: true, main_pane_pid: 2))
    var e = WorkersFile.Entry(threadId: "trip", cwd: "/home/example/trip")
    f.threads["trip"] = e
    #expect(!String(decoding: try f.encoded(), as: UTF8.self).contains("launched"), "a file of every earlier build is unchanged")
    e.launched = .init(cwd: "/home/example/trip", model: "sonnet", effort: "high", mcp_allow: ["a"])
    f.threads["trip"] = e
    let again = try #require(WorkersFile.decode(try f.encoded()))
    #expect(again.threads["trip"]?.launched == e.launched)
    // no list stays no list, an empty list stays empty
    e.launched = .init(cwd: "/x", model: "inherit", effort: nil, mcp_allow: nil)
    f.threads["trip"] = e
    #expect(try #require(WorkersFile.decode(try f.encoded())).threads["trip"]?.launched?.mcp_allow == nil)
    e.launched = .init(cwd: "/x", model: "inherit", effort: nil, mcp_allow: [])
    f.threads["trip"] = e
    #expect(try #require(WorkersFile.decode(try f.encoded())).threads["trip"]?.launched?.mcp_allow == [])
  }

  @Test func aLaunchedThatCannotBeReadIsNoneNotAnUnreadableFile() {
    #expect(entry("")?.launched == nil)
    #expect(entry(#","launched":{"cwd":"relative","model":"inherit"}"#) != nil)
    #expect(entry(#","launched":{"cwd":"relative","model":"inherit"}"#)?.launched == nil)
    #expect(entry(#","launched":"x""#)?.launched == nil)
    #expect(entry(#","launched":{"cwd":"/a","model":5}"#)?.launched == nil)
    #expect(entry(#","launched":{"cwd":"/a","model":"inherit","mcp_allow":"nonsense"}"#)?.launched?.mcp_allow == [], "junk is the empty list, as the protocol reads it")
    #expect(entry(#","launched":{"cwd":"/a"}"#)?.launched?.model == "inherit")
  }
}
