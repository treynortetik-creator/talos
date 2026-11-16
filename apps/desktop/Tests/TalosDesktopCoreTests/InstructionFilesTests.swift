import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The instruction-files setting on every launch, the MCP allow list leaving that plugin alone, and the sub-thread folder rule.

private func instructionFilesOf(_ settings: [String: Any]?, _ id: String) -> Any? {
  (((settings?["pluginConfigs"] as? [String: Any])?[id] as? [String: Any])?["options"] as? [String: Any])?["instructionFiles"]
}

@Suite("Instruction files setting")
struct InstructionFilesSettingTests {
  let ids = ["cc-plugin-agents-md@builtin", "agents-md@builtin"]

  @Test func bothPluginIdsAskForClaudeMdAndAgentsMd() {
    #expect(InstructionFiles.pluginIds == ids)
    let out = InstructionFiles.merged([:])
    for id in ids { #expect(instructionFilesOf(out, id) as? String == "claude-md-and-agents-md", "\(id)") }
  }

  @Test func mergingKeepsWhatTheSettingsAlreadyHold() {
    let before: [String: Any] = [
      "effortLevel": "high",
      "pluginConfigs": [
        "agents-md@builtin": ["options": ["instructionFiles": "claude-md", "other": 1], "extra": true],
        "zoom@market": ["options": ["a": "b"]],
      ],
    ]
    let out = InstructionFiles.merged(before)
    #expect(out["effortLevel"] as? String == "high")
    #expect(instructionFilesOf(out, "agents-md@builtin") as? String == "claude-md-and-agents-md")
    let kept = (out["pluginConfigs"] as? [String: Any])?["agents-md@builtin"] as? [String: Any]
    #expect(kept?["extra"] as? Bool == true)
    #expect((kept?["options"] as? [String: Any])?["other"] as? Int == 1)
    #expect(((out["pluginConfigs"] as? [String: Any])?["zoom@market"] as? [String: Any])?["options"] as? [String: String] == ["a": "b"])
  }

  @Test func aWorkersOneSettingsFileCarriesItAlongsideTheGuardsAndTheFence() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.installGuards(#"{"permissions":{"deny":["Bash(rm:*)"]}}"#)
    let spec = try WorkerSpec.build(fenceInputs(t))
    let settings = jsonObject(spec.settingsJSON)
    for id in ids { #expect(instructionFilesOf(settings, id) as? String == "claude-md-and-agents-md", "\(id)") }
    #expect(denyList(spec).contains("Bash(rm:*)"), "the guards are still merged in")
    #expect(spec.args.filter { $0 == "--settings" }.count == 1, "one --settings, not two")
    #expect(spec.settingsJSON.contains(WorkerSpec.telegramPlugin))
    try spec.validate()
  }

  @Test func aHandOpenedSessionCarriesItToo() throws {
    var file = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    var entry = WorkersFile.Entry(threadId: "trip", cwd: "/home/alex/trip")
    entry.state = "failed"
    entry.error = .init(code: "needs_mac", detail: "Trust this folder?", at: "2026-11-01T00:00:00Z")
    file.threads["trip"] = entry
    let row = try #require(ThreadSessions.rows(from: file).first)
    let inv = try #require(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: "/home/alex/.talos"))
    let settings = jsonObject(try #require(inv.args.last))
    for id in ids { #expect(instructionFilesOf(settings, id) as? String == "claude-md-and-agents-md", "\(id)") }
  }
}

@Suite("Instruction files plugin and the MCP allow list")
struct InstructionFilesAllowListTests {
  /// Both ids and one other plugin installed and switched on; the other plugin has the one listed server.
  func install(_ t: FenceTree) throws {
    func rec(_ path: String) -> [Any] { [["scope": "user", "installPath": path, "version": "1.0.0"]] }
    let cache = t.claudeDir + "/plugins/cache"
    try t.write(
      t.claudeDir + "/plugins/installed_plugins.json",
      [
        "version": 2,
        "plugins": [
          "cc-plugin-agents-md@builtin": rec(cache + "/builtin/cc-plugin-agents-md"),
          "agents-md@builtin": rec(cache + "/builtin/agents-md"),
          "notes-plugin@market": rec(cache + "/market/notes"),
          "zoom@market": rec(cache + "/market/zoom"),
        ],
      ])
    try t.write(
      t.claudeDir + "/settings.json",
      ["enabledPlugins": ["cc-plugin-agents-md@builtin": true, "agents-md@builtin": true, "notes-plugin@market": true, "zoom@market": true]])
    try t.write(cache + "/market/zoom/.mcp.json", ["mcpServers": ["zoom-mcp": ["command": "zoom"]]])
    try t.write(cache + "/builtin/cc-plugin-agents-md/.mcp.json", ["mcpServers": ["files": ["command": "files"]]])
    try t.write(cache + "/builtin/agents-md/.mcp.json", ["mcpServers": ["files": ["command": "files"]]])
  }

  @Test func aListThatNamesNeitherIdNeverSwitchesThemOff() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    try install(t)
    for allow in [[], ["plugin:zoom:zoom-mcp"]] {
      let plan = try #require(t.plan(allow))
      #expect(plan.disabledPlugins.contains("notes-plugin@market"), "other plugins off still")
      for id in InstructionFiles.pluginIds { #expect(!plan.disabledPlugins.contains(id), "\(id)") }
      let spec = try WorkerSpec.build(
        fenceInputs(t, mcp: plan, mainMcp: WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)))
      let plugins = try #require(jsonObject(spec.settingsJSON)?["enabledPlugins"] as? [String: Bool])
      #expect(plugins["notes-plugin@market"] == false)
      for id in InstructionFiles.pluginIds { #expect(plugins[id] != false, "\(id)") }
      for id in InstructionFiles.pluginIds { #expect(instructionFilesOf(jsonObject(spec.settingsJSON), id) as? String == "claude-md-and-agents-md") }
      try spec.validate()
    }
  }

  @Test func theLauncherLeavesThemOnEvenIfAPlanNamesThem() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.standardServers()
    var plan = try #require(t.plan([]))
    plan.disabledPlugins += InstructionFiles.pluginIds + ["notes-plugin@market"]
    let spec = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir)))
    let plugins = try #require(jsonObject(spec.settingsJSON)?["enabledPlugins"] as? [String: Bool])
    #expect(plugins["notes-plugin@market"] == false)
    for id in InstructionFiles.pluginIds { #expect(plugins[id] == nil, "\(id)") }
    try spec.validate()
  }
}

@Suite("Sub-thread folder")
struct SubThreadFolderTests {
  final class Tree {
    let root: String
    init() throws {
      let base = (TestTemp.base as NSString).appendingPathComponent("talos-sub-\(UUID().uuidString.prefix(8))")
      try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
      // the temp folder is itself behind a link on macOS; the tests name folders by their real path so only the links they make count
      root = realpath(base, nil).map { String(cString: $0) } ?? base
      for d in ["/parent/child/deep", "/parent2", "/outside"] {
        try FileManager.default.createDirectory(atPath: root + d, withIntermediateDirectories: true)
      }
    }
    var parent: String { root + "/parent" }
    func link(_ name: String, to target: String) throws {
      try FileManager.default.createSymbolicLink(atPath: root + "/" + name, withDestinationPath: target)
    }
    func cleanup() { try? FileManager.default.removeItem(atPath: root) }
  }

  @Test func aFolderInsideTheParentIsFine() throws {
    let t = try Tree()
    defer { t.cleanup() }
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child", parentCwd: t.parent) == nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child/deep", parentCwd: t.parent) == nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child/../child/deep", parentCwd: t.parent) == nil, ".. that stays inside")
    try t.link("parent/inlink", to: t.parent + "/child")
    #expect(SubThreadFolder.problem(cwd: t.parent + "/inlink", parentCwd: t.parent) == nil, "a link that stays inside")
  }

  @Test func theParentItselfASiblingAndAnythingOutsideAreRefused() throws {
    let t = try Tree()
    defer { t.cleanup() }
    #expect(SubThreadFolder.problem(cwd: t.parent, parentCwd: t.parent) != nil, "not a subfolder of itself")
    #expect(SubThreadFolder.problem(cwd: t.parent + "/", parentCwd: t.parent) != nil)
    // a shared name prefix is not inside; an existing folder outside is the sub-thread's own folder (see ownFolder below)
    #expect(SubThreadFolder.problem(cwd: t.root + "/parent2", parentCwd: t.parent) == nil)
    #expect(SubThreadFolder.problem(cwd: t.root + "/outside-missing", parentCwd: t.parent) != nil, "a missing one outside is never made")
    #expect(SubThreadFolder.problem(cwd: "/", parentCwd: "/") != nil, "the root is not inside itself")
    #expect(SubThreadFolder.problem(cwd: t.parent, parentCwd: "/") == nil, "everything is inside the root")
  }

  @Test func aDotDotEscapeIsRefused() throws {
    let t = try Tree()
    defer { t.cleanup() }
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child/../../outside", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child/../..", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child/../../parent2", parentCwd: t.parent) != nil)
  }

  @Test func aSymlinkThatLeadsOutIsRefused() throws {
    let t = try Tree()
    defer { t.cleanup() }
    try t.link("parent/escape", to: t.root + "/outside")
    #expect(SubThreadFolder.problem(cwd: t.parent + "/escape", parentCwd: t.parent) != nil)
    try t.link("viaparent", to: t.parent)  // the parent named through a link is still the same folder
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child", parentCwd: t.root + "/viaparent") == nil)
    #expect(SubThreadFolder.problem(cwd: t.parent, parentCwd: t.root + "/viaparent") != nil, "the parent named through a link is equal, not an own folder")
    #expect(SubThreadFolder.problem(cwd: t.parent + "/", parentCwd: t.root + "/viaparent") != nil)
  }

  @Test func anExistingFolderOutsideTheParentIsTheSubThreadsOwnAndNothingIsMade() throws {
    let t = try Tree()
    defer { t.cleanup() }
    #expect(SubThreadFolder.problem(cwd: t.root + "/outside", parentCwd: t.parent) == nil)
    #expect(SubThreadFolder.check(cwd: t.root + "/outside", parentCwd: t.parent) == nil)
    #expect(SubThreadFolder.check(cwd: t.root + "/outside/", parentCwd: t.parent) == nil, "a trailing slash")
    #expect(try SubThreadFolder.prepare(cwd: t.root + "/outside", parentCwd: t.parent).get() == t.root + "/outside", "used as it is")
    try t.link("viaoutside", to: t.root + "/outside")  // named through a link: the folder it resolves to
    #expect(try SubThreadFolder.prepare(cwd: t.root + "/viaoutside", parentCwd: t.parent).get() == t.root + "/outside")
    try t.link("viaparent", to: t.parent)  // the parent named through a link
    #expect(SubThreadFolder.problem(cwd: t.root + "/outside", parentCwd: t.root + "/viaparent") == nil)
  }

  @Test func anOwnFolderIsRefusedWhenMissingEqualDottedRelativeOrAnEscapeThroughALink() throws {
    let t = try Tree()
    defer { t.cleanup() }
    let missing = t.root + "/not-there"
    #expect(SubThreadFolder.check(cwd: missing, parentCwd: t.parent) != nil)
    if case .success = SubThreadFolder.prepare(cwd: missing, parentCwd: t.parent) { Issue.record("a missing outside folder was accepted") }
    #expect(!FileManager.default.fileExists(atPath: missing), "never made")
    for same in [t.parent, t.parent + "/", t.parent.uppercased()] {
      #expect(SubThreadFolder.check(cwd: same, parentCwd: t.parent) != nil, "equal: \(same)")
    }
    for dotted in [t.root + "/outside/../outside", t.parent + "/../outside", t.root + "/./outside", "outside", "../outside"] {
      #expect(SubThreadFolder.problem(cwd: dotted, parentCwd: t.parent) != nil, "\(dotted)")
    }
    try t.link("parent/escape", to: t.root + "/outside")  // written under the parent, leads out: still an escape
    #expect(SubThreadFolder.check(cwd: t.parent + "/escape", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.fence(cwd: t.root + "/outside", parentCwd: t.parent) == .inside, "a running own-folder child is not parked")
    #expect(SubThreadFolder.fence(cwd: t.parent, parentCwd: t.parent) == .outside)
    #expect(SubThreadFolder.fence(cwd: t.root + "/not-there", parentCwd: t.parent) == .outside)
  }

  @Test func aMissingOrRelativeFolderIsRefused() throws {
    let t = try Tree()
    defer { t.cleanup() }
    #expect(SubThreadFolder.problem(cwd: t.parent + "/nope", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/nope/../child", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.problem(cwd: "child", parentCwd: t.parent) != nil)
    #expect(SubThreadFolder.problem(cwd: t.parent + "/child", parentCwd: t.root + "/gone") != nil)
  }

  /// R1-1: an own-folder sub-thread keeps the parent's privacy rules too (the parent's `.claude/settings.json` deny), parent first.
  @Test func anOwnFolderSubThreadCarriesTheParentLeadsDenyRulesAndAnInsideOneAddsNothing() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let childFolder = t.root + "/own-child"
    try FileManager.default.createDirectory(atPath: childFolder, withIntermediateDirectories: true)
    try t.write(t.cwd + "/.claude/settings.json", ["permissions": ["deny": ["Read(/secrets/**)"]]])
    try t.write(childFolder + "/.claude/settings.json", ["permissions": ["deny": ["Read(/own-folder-rule/**)"]]])
    var own = fenceInputs(t)
    own.cwd = childFolder
    own.parentCwd = t.cwd
    let deny = denyList(try WorkerSpec.build(own))
    // `/x` in a settings file means that file's folder (absolutize), so each rule is named by its file's folder
    func real(_ p: String) -> String { realpath(p, nil).map { r in defer { free(r) }; return String(cString: r) } ?? p }
    let parentRule = "Read(/\(real(t.cwd))/secrets/**)", childRule = "Read(/\(real(childFolder))/own-folder-rule/**)"
    #expect(deny.contains(parentRule), "the parent lead's rule reaches the own-folder child: \(deny)")
    #expect(deny.contains(childRule), "its own folder's rules still apply")
    let rules = WorkerSpec.folderRules(cwd: childFolder, home: t.home, parentCwd: t.cwd)
    #expect(rules.deny == [parentRule, childRule], "parent chain first, then the child's: \(rules.deny)")
    // a parent with no rules adds nothing; a child inside its parent is as before
    #expect(WorkerSpec.folderRules(cwd: childFolder, home: t.home, parentCwd: t.talosHome).deny == [childRule])
    try FileManager.default.createDirectory(atPath: t.cwd + "/child", withIntermediateDirectories: true)
    #expect(WorkerSpec.folderRules(cwd: t.cwd + "/child", home: t.home, parentCwd: t.cwd) == WorkerSpec.folderRules(cwd: t.cwd + "/child", home: t.home))
  }

@Test func theLauncherRefusesASubThreadOutsideItsParentAndStartsOneInside() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let child = t.cwd + "/child"
    try FileManager.default.createDirectory(atPath: child, withIntermediateDirectories: true)
    var inside = fenceInputs(t)
    inside.cwd = child
    inside.parentCwd = t.cwd
    #expect(try WorkerSpec.build(inside).cwd == child)
    var outside = inside
    outside.cwd = t.root + "/not-there"
    do {
      _ = try WorkerSpec.build(outside)
      Issue.record("a missing folder outside the parent's was accepted")
    } catch WorkerSpec.BuildError.subThreadFolder {
    }
    outside.cwd = t.cwd
    do {
      _ = try WorkerSpec.build(outside)
      Issue.record("the parent's own folder was accepted")
    } catch WorkerSpec.BuildError.subThreadFolder {
    }
    // an existing folder outside is the sub-thread's own: the spec builds, in that folder
    var own = inside
    own.cwd = t.agentDir
    #expect(try WorkerSpec.build(own).cwd == t.agentDir)
    var escape = inside
    escape.cwd = child + "/../../agent"
    do {
      _ = try WorkerSpec.build(escape)
      Issue.record("a .. escape was accepted")
    } catch WorkerSpec.BuildError.subThreadFolder {
    }
    // no parent: the rule does not apply
    var plain = fenceInputs(t)
    plain.cwd = t.agentDir
    #expect(try WorkerSpec.build(plain).cwd == t.agentDir)
  }
}
