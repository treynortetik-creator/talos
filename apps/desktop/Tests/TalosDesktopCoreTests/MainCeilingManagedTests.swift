import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The ceiling under Claude Code's managed settings, main's `--setting-sources` and its arguments as Claude Code reads them: the
/// Linux supervisor's cases (apps/bridge/test/supervisor/workers-wiring.test.ts). The managed folder is always one of the test's own.
@Suite("Main's ceiling: managed settings, --setting-sources and main's arguments")
struct MainCeilingManagedTests {
  final class Home {
    let t: FenceTree
    var managed: String { t.root + "/managed" }
    init() throws {
      t = try FenceTree()
      try FileManager.default.createDirectory(atPath: managed + "/managed-settings.d", withIntermediateDirectories: true)
      try FileManager.default.createDirectory(atPath: t.agentDir + "/.claude", withIntermediateDirectories: true)
    }
    func put(_ path: String, _ permissions: Any) throws { try t.write(path, ["permissions": permissions]) }
    func text(_ path: String, _ s: String) throws { try Data(s.utf8).write(to: URL(fileURLWithPath: path)) }
    func ceiling(_ args: [String] = []) -> MainOwnSettings.Ceiling {
      let own = MainOwnSettings.read(args: args, agentDir: t.agentDir, env: [:], uid: 501)
      return MainOwnSettings.ceiling(own, args: args, agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: managed)
    }
    var user: String { t.claudeDir + "/settings.json" }
    var managedFile: String { managed + "/managed-settings.json" }
    func dropIn(_ n: String) -> String { managed + "/managed-settings.d/" + n }
  }

  @Test func aManagedModeOutranksTheUsersAndSeveralDocumentsGiveTheNarrowest() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.user, ["defaultMode": "acceptEdits"])
    try h.put(h.managedFile, ["defaultMode": "plan"])
    #expect(h.ceiling().defaultMode == "plan")
    try h.put(h.managedFile, ["defaultMode": "acceptEdits"])
    try h.put(h.dropIn("10-org.json"), ["defaultMode": "default"])
    #expect(h.ceiling().defaultMode == "default")
    // no managed folder given: none is read
    let own = MainOwnSettings.read(args: [], agentDir: h.t.agentDir, env: [:])
    let none = MainOwnSettings.ceiling(own, args: [], agentDir: h.t.agentDir, talosHome: h.t.talosHome, claudeDir: h.t.claudeDir, managedDir: nil)
    #expect(none.defaultMode == "acceptEdits")
  }

  @Test func managedDenyRulesAreInTheCeilingFromTheFileAndTheDropInFolder() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.managedFile, ["deny": ["Bash(curl:*)", "Edit(*)", "Read(/org/**)", 7]])
    try h.put(h.dropIn("20-x.json"), ["deny": ["Read(//etc/secret)"]])
    try h.text(h.dropIn("notes.txt"), "not settings")
    let deny = h.ceiling().denyRules
    for r in ["Bash(curl:*)", "Edit(*)", "Read(//etc/secret)", "Read(/\(h.managed)/org/**)"] { #expect(deny.contains(r), "\(r): \(deny)") }
    // and they reach a worker built under that ceiling
    let c = h.ceiling()
    let spec = try WorkerSpec.build(fenceInputs(h.t, flag: nil, mainDeny: c.denyRules, mainArgs: c.permissionArgs, mainMode: c.defaultMode))
    #expect(denyList(spec).contains("Bash(curl:*)") && denyList(spec).contains("Edit(*)"))
  }

  @Test func aSourceMainLeavesOutIsNotReadForItsModeOrItsDenyRules() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.user, ["defaultMode": "acceptEdits"])
    #expect(h.ceiling().defaultMode == "acceptEdits")
    #expect(h.ceiling(["--setting-sources", "project,local"]).defaultMode == nil)
    #expect(h.ceiling(["--setting-sources=project"]).defaultMode == nil)
    try h.put(h.t.agentDir + "/.claude/settings.json", ["defaultMode": "plan", "deny": ["Bash(rm:*)"]])
    try h.put(h.t.agentDir + "/.claude/settings.local.json", ["deny": ["Bash(dd:*)"]])
    #expect(h.ceiling(["--setting-sources", "project"]).defaultMode == "plan")
    #expect(h.ceiling(["--setting-sources", "user"]).defaultMode == "acceptEdits")
    #expect(h.ceiling(["--setting-sources", " user , bogus"]).defaultMode == "acceptEdits", "a name nobody knows is no source")
    // the last one given counts
    #expect(h.ceiling(["--setting-sources", "user", "--setting-sources", "project"]).defaultMode == "plan")
    // deny rules: only from the project files main loads
    #expect(h.ceiling().denyRules == ["Bash(rm:*)", "Bash(dd:*)"])
    #expect(h.ceiling(["--setting-sources", "project"]).denyRules == ["Bash(rm:*)"])
    #expect(h.ceiling(["--setting-sources", "user,local"]).denyRules == ["Bash(dd:*)"])
    #expect(h.ceiling(["--setting-sources", "user"]).denyRules == [])
    // the guards' rules stay whatever main loads, and so do the managed ones
    try h.t.installGuards(#"{"permissions":{"deny":["Bash(claude plugin:*)"]}}"#)
    try h.put(h.managedFile, ["deny": ["Bash(curl:*)"]])
    #expect(h.ceiling(["--setting-sources", "user"]).denyRules == ["Bash(claude plugin:*)", "Bash(curl:*)"])
  }

  @Test func aManagedModeClaudeCodeCannotReadStandsAsDefault() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.user, ["defaultMode": "bypassPermissions"])  // the chain is as wide as it gets: what is read is the managed side
    try h.put(h.managedFile, ["defaultMode": "bypassPermissions"])
    try h.put(h.dropIn("10.json"), ["defaultMode": "bogus"])
    #expect(h.ceiling().defaultMode == "default")
    try h.put(h.dropIn("10.json"), ["defaultMode": 5])
    #expect(h.ceiling().defaultMode == "default")
    // a deny or ask list it cannot read withholds the mode next to it
    try h.put(h.dropIn("10.json"), [String: Any]())
    try h.put(h.managedFile, ["defaultMode": "bypassPermissions", "deny": "Bash"])
    #expect(h.ceiling().defaultMode == "default")
    try h.put(h.managedFile, ["defaultMode": "bypassPermissions", "ask": ["Bash", 3]])
    #expect(h.ceiling().defaultMode == "default")
    // one it can read is itself
    try h.put(h.managedFile, ["defaultMode": "bypassPermissions", "ask": ["Bash"]])
    #expect(h.ceiling().defaultMode == "bypassPermissions")
  }

  @Test func neverWiderThanTheOrdinaryChain_aHigherManagedSourceMaySetTheFileAside() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.managedFile, ["defaultMode": "acceptEdits"])
    try h.put(h.user, ["defaultMode": "default"])
    #expect(h.ceiling().defaultMode == "default")
    // with no mode in the chain, the chain is the built-in default
    try FileManager.default.removeItem(atPath: h.user)
    #expect(h.ceiling().defaultMode == "default")
    // an unknown mode in the chain keeps its plan fallback, managed settings or not
    try h.put(h.user, ["defaultMode": "yolo"])
    let c = h.ceiling()
    #expect(c.defaultMode == "plan" && c.unknownMode == "yolo")
  }

  @Test func bypassRuledOutMeansTheBypassFlagsAreNotMainsMode() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.managedFile, ["disableBypassPermissionsMode": "disable"])
    let args = ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--name", "x"]
    #expect(h.ceiling(args).permissionArgs == ["--name", "x"] && h.ceiling(args).noBypass)
    // two --permission-mode flags: the last counts, and when it is bypass main falls past both
    #expect(h.ceiling(["--permission-mode", "acceptEdits", "--permission-mode", "bypassPermissions"]).permissionArgs == [])
    #expect(h.ceiling(["--permission-mode=bypassPermissions", "--permission-mode", "plan", "--allow-dangerously-skip-permissions"]).permissionArgs == ["--permission-mode", "plan"])
    // a bypass mode from settings is clamped too
    try h.put(h.user, ["defaultMode": "bypassPermissions"])
    #expect(h.ceiling().defaultMode == "default")
    // any value but false; a permissions value it cannot read is the restrictive one
    for (text, off) in [
      (#"{"permissions":{"disableBypassPermissionsMode":true}}"#, true), (#"{"permissions":{"disableBypassPermissionsMode":0}}"#, true),
      (#"{"permissions":{"disableBypassPermissionsMode":null}}"#, true), (#"{"permissions":"oops"}"#, true),
      (#"{"permissions":{"disableBypassPermissionsMode":false}}"#, false), (#"{"permissions":{}}"#, false), ("", false), ("  \n", false),
    ] {
      try h.text(h.managedFile, text)
      #expect(h.ceiling(["--dangerously-skip-permissions"]).permissionArgs == (off ? [] : ["--dangerously-skip-permissions"]), "\(text)")
    }
    // from a source main loads, not only managed files: the user's, the project's, the guards' and its own --settings
    try FileManager.default.removeItem(atPath: h.managedFile)
    try h.put(h.user, ["disableBypassPermissionsMode": "disable", "defaultMode": "acceptEdits"])
    #expect(h.ceiling(["--dangerously-skip-permissions"]).permissionArgs == [])
    #expect(h.ceiling(["--dangerously-skip-permissions"]).defaultMode == "acceptEdits")
    #expect(h.ceiling(["--dangerously-skip-permissions", "--setting-sources", "project"]).permissionArgs.first == "--dangerously-skip-permissions", "a source left out does not rule it out")
    try FileManager.default.removeItem(atPath: h.user)
    try h.put(h.t.root + "/own.json", ["disableBypassPermissionsMode": "disable"])
    #expect(h.ceiling(["--dangerously-skip-permissions", "--settings", h.t.root + "/own.json"]).permissionArgs == ["--settings", h.t.root + "/own.json"])
    // restricted mode: no bypass, and no user, project or local settings
    try h.put(h.user, ["defaultMode": "acceptEdits"])
    let r = h.ceiling(["--restricted", "--dangerously-skip-permissions"])
    #expect(r.permissionArgs == ["--restricted"] && r.defaultMode == nil)
  }

  @Test func aWorkerUnderAMainWhoseBypassIsRuledOutGetsNoBypass() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.managedFile, ["disableBypassPermissionsMode": "disable"])
    let c = h.ceiling(["--dangerously-skip-permissions"])
    // the app's own bypass flag on the worker would be wider than that main: refused, never launched with it
    let d = escalation { _ = try WorkerSpec.build(fenceInputs(h.t, mainDeny: c.denyRules, mainArgs: c.permissionArgs, mainMode: c.defaultMode)) }
    #expect(d?.axis == .permissionMode)
    // and without it the worker starts in the built-in default
    let spec = try WorkerSpec.build(fenceInputs(h.t, flag: nil, mainDeny: c.denyRules, mainArgs: c.permissionArgs, mainMode: c.defaultMode))
    #expect(!spec.args.contains("--dangerously-skip-permissions"))
    #expect(((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "default")
  }

  @Test func argumentsAreReadAsClaudeCodeReadsThem() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.user, ["defaultMode": "plan"])
    // after --: the prompt, not settings
    #expect(h.ceiling(["--", "--settings", #"{"permissions":{"defaultMode":"bypassPermissions"}}"#]).defaultMode == "plan")
    #expect(h.ceiling(["--", "--setting-sources", "project"]).defaultMode == "plan")
    #expect(h.ceiling(["--", "--restricted"]).defaultMode == "plan")
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--", "--dangerously-skip-permissions"]).mode.rank == 1, "a prompt is not a permission flag")
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--", "--permission-mode", "bypassPermissions"]).mode.rank == 1)
    // the value of another flag
    #expect(h.ceiling(["--append-system-prompt", "--setting-sources=project"]).defaultMode == "plan")
    #expect(h.ceiling(["--append-system-prompt", "--restricted"]).defaultMode == "plan")
    #expect(h.ceiling(["--append-system-prompt", "--settings", "--model", "opus"]).defaultMode == "plan")
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--system-prompt", "--dangerously-skip-permissions"]).mode.rank == 1)
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--add-dir", "--permission-mode", "plan"]).mode.rank == 1, "--permission-mode is --add-dir's value")
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--add-dir", "x", "--permission-mode", "plan"]).mode.rank == 0, "and a flag after a value still counts")
    #expect(h.ceiling(["--restricted"]).defaultMode == nil)
    // a flag whose value is optional takes the next word only when it is not a flag
    let own = h.t.agentDir + "/own.json"
    try h.put(own, ["defaultMode": "acceptEdits", "deny": ["Bash(curl:*)"]])
    for args in [["--resume", "--settings", own], ["--resume", "abc", "--settings", own], ["-w", "--settings=" + own]] {
      let c = h.ceiling(args)
      #expect(c.defaultMode == "acceptEdits" && c.denyRules.contains("Bash(curl:*)"), "\(args)")
    }
    #expect(MainArgs.lastValue(["--resume", "--settings"], "--settings") == "")
    #expect(MainArgs.swallowsAppended(["--model", "x", "--", "hi"]) && !MainArgs.swallowsAppended(["--append-system-prompt", "--"]))
    #expect(MainArgs.swallowsAppended(["--model"]) && !MainArgs.swallowsAppended(["--model", "x"]) && !MainArgs.swallowsAppended([]))
    #expect(!MainArgs.swallowsAppended(["--resume"]), "a value that is optional is not waited for by a flag")
  }

  @Test func theGuardsModeCountsOnlyWhenTheGuardsFileReallyIsMainsSettings() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.t.installGuards(#"{"permissions":{"defaultMode":"bypassPermissions","deny":["Bash(claude plugin:*)"]}}"#)
    #expect(h.ceiling().defaultMode == "bypassPermissions", "added to main's launch as --settings")
    // the app does not add the guards' file when the arguments carry the word --settings anywhere, or would add it after a `--`
    // (inside the prompt): main does not run under it then, and its bypass is not main's
    #expect(h.ceiling(["--append-system-prompt", "--settings"]).defaultMode == nil)
    #expect(h.ceiling(["--", "--settings", "x.json"]).defaultMode == nil)
    #expect(h.ceiling(["--", "hello"]).defaultMode == nil)
    #expect(h.ceiling(["--model"]).defaultMode == nil, "the added --settings would be the model's name")
    // its deny rules stay in the ceiling either way
    #expect(h.ceiling(["--", "hello"]).denyRules == ["Bash(claude plugin:*)"])
  }

  @Test func aDotfileIsNotReadAndADocumentThatCannotBeReadIsLeftOutAndCounted() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    try h.put(h.dropIn(".hidden.json"), ["defaultMode": "plan", "deny": ["Bash(x:*)"]])
    try h.put(h.user, ["defaultMode": "acceptEdits"])
    var c = h.ceiling()
    #expect(c.defaultMode == "acceptEdits" && !c.denyRules.contains("Bash(x:*)") && c.managedUnreadable == 0)
    try h.text(h.managedFile, "{nope")
    try h.text(h.dropIn("a.json"), "[]")
    #expect(mkfifo(h.dropIn("b.json"), 0o600) == 0)
    try h.put(h.dropIn("c.json"), ["defaultMode": "plan"])
    c = h.ceiling()
    #expect(c.managedUnreadable == 3 && c.defaultMode == "plan", "the readable one still counts: \(c)")
    // name order, with the last same-named key winning inside a document
    try h.text(h.dropIn("c.json"), #"{"permissions":{"defaultMode":"bypassPermissions"},"permissions":{"defaultMode":"default"}}"#)
    #expect(h.ceiling().defaultMode == "default")
  }

  @Test func everyDocumentFoundationTakesIsReadAndAPipeWhereASettingsFileGoesNeverBlocks() throws {
    let h = try Home()
    defer { h.t.cleanup() }
    // nested past any limit of this reader's own: still a settings file with a mode and a rule
    let deep = String(repeating: "[", count: 400) + String(repeating: "]", count: 400)
    try h.text(h.t.agentDir + "/.claude/settings.json", #"{"x":\#(deep),"permissions":{"defaultMode":"plan","deny":["Bash(rm:*)"],"disableBypassPermissionsMode":"disable"}}"#)
    try h.put(h.user, ["defaultMode": "acceptEdits"])
    let c = h.ceiling(["--dangerously-skip-permissions"])
    #expect(c.defaultMode == "plan" && c.denyRules == ["Bash(rm:*)"] && c.noBypass, "\(c)")
    // a pipe left where the local settings go is not read, and nothing waits on it
    #expect(mkfifo(h.t.agentDir + "/.claude/settings.local.json", 0o600) == 0)
    let t0 = Date()
    #expect(h.ceiling().defaultMode == "plan")
    #expect(Date().timeIntervalSince(t0) < 5)
    // the guards' copy for a worker: the last of two same-named keys, as for main
    try h.t.installGuards(#"{"permissions":{"deny":["Bash(first:*)"]},"permissions":{"deny":["Bash(last:*)"]}}"#)
    guard case .rules(_, let perms) = GuardsSettings.load(talosHome: h.t.talosHome) else {
      Issue.record("the guards' file was not read")
      return
    }
    #expect((perms as? [String: Any])?["deny"] as? [String] == ["Bash(last:*)"])
  }

  @Test func theAppPassesTheSystemsManagedFolderAndNoTestReadsIt() throws {
    #expect(MainManagedSettings.systemDir == "/Library/Application Support/ClaudeCode")
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources")
    let controller = try String(contentsOf: sources.appendingPathComponent("TalosDesktop/SupervisorController.swift"), encoding: .utf8)
    // a line of code, not a comment (WorkerLoginEnvGuiTests asks the built manager itself, where windows are allowed)
    let set = controller.split(separator: "\n").filter { $0.trimmingCharacters(in: .whitespaces) == "o.managedDir = MainManagedSettings.systemDir" }
    #expect(set.count == 1, "the one place the app builds the worker manager")
    // nothing else names the real folder: a manager built without it reads no managed settings
    var named = 0
    for case let f as String in FileManager.default.enumerator(atPath: sources.path)! where f.hasSuffix(".swift") {
      named += try String(contentsOf: sources.appendingPathComponent(f), encoding: .utf8).components(separatedBy: "MainManagedSettings.systemDir").count - 1
    }
    #expect(named == 1)
  }
}
