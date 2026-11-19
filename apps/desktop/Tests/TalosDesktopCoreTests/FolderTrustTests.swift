import Foundation
import Testing
import TalosTestSupport

@testable import TalosDesktopCore

/// Folder trust answered by the owner's own choice of folder (`FolderTrust`): what it writes, what it refuses, and a concurrent writer.
/// Temp folders only; the config file is a stand-in for Claude Code's `.claude.json`. Fixture paths are under /home/alex where a path is
/// only text.
@Suite struct FolderTrustTests {
  struct World {
    let root: String, home: String, agent: String, talos: String, trip: String, config: String
    func input(folder: String? = nil, chosen: [String]? = nil) -> (String, [String]) { (folder ?? trip, chosen ?? [trip]) }
    func accept(folder: String? = nil, chosen: [String]? = nil, hook: (() -> Void)? = nil) -> FolderTrust.Result {
      let (f, c) = input(folder: folder, chosen: chosen)
      return FolderTrust.preAccept(
        configFile: config, folder: f, chosen: c, home: home, talosHome: talos, agentDir: agent, beforeRename: hook)
    }
    func object() throws -> [String: Any] { try #require(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: config))) as? [String: Any]) }
    func bytes() throws -> Data { try Data(contentsOf: URL(fileURLWithPath: config)) }
    func projects() throws -> [String: Any] { (try object())["projects"] as? [String: Any] ?? [:] }
    func leftovers() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: home)) ?? []).filter { $0.hasPrefix(".claude.json.tmp.") } }
  }

  func makeWorld() throws -> World { try make() }

  private func make() throws -> World {
    let base = TestTemp.base + "talos-folder-trust-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    let home = base + "/home"
    for d in [home + "/agent", home + "/.talos", home + "/work/trip", home + "/.claude"] {
      try fm.createDirectory(atPath: d, withIntermediateDirectories: true)
    }
    let root = try TestTemp.real(base)
    let h = root + "/home"
    let agent = h + "/agent"
    let original: [String: Any] = [
      "numStartups": 7, "userID": "not-a-real-id", "tipsHistory": ["one": 3],
      "projects": [
        agent: ["hasTrustDialogAccepted": true, "allowedTools": ["Read"], "lastCost": 1.5],
        h + "/other": ["hasTrustDialogAccepted": false, "mcpServers": ["a": ["command": "x"]]],
      ],
    ]
    let config = h + "/.claude.json"
    try JSONSerialization.data(withJSONObject: original, options: [.prettyPrinted]).write(to: URL(fileURLWithPath: config))
    chmod(config, 0o600)
    return World(root: root, home: h, agent: agent, talos: h + "/.talos", trip: h + "/work/trip", config: config)
  }

  @Test func writesExactlyThatKeyAndKeepsEverythingElse() throws {
    let w = try make()
    chmod(w.config, 0o640)
    let before = try w.object()
    #expect(w.accept() == .wrote)
    let now = try w.object()
    let entry = try #require((now["projects"] as? [String: Any])?[w.trip] as? [String: Any])
    #expect(entry as NSDictionary == ["hasTrustDialogAccepted": true] as NSDictionary)
    // the same file with that one entry taken out is the original
    var stripped = now
    var projects = try #require(stripped["projects"] as? [String: Any])
    projects.removeValue(forKey: w.trip)
    stripped["projects"] = projects
    #expect(stripped as NSDictionary == before as NSDictionary)
    var st = stat()
    stat(w.config, &st)
    #expect(st.st_mode & 0o777 == 0o640)
    #expect(w.leftovers().isEmpty)
  }

  @Test func anAcceptedFolderIsNotRewrittenAndAHalfEntryKeepsItsOtherKeys() throws {
    let w = try make()
    var o = try w.object()
    var p = try #require(o["projects"] as? [String: Any])
    p[w.trip] = ["allowedTools": ["Bash"], "hasTrustDialogAccepted": false, "lastCost": 2]
    o["projects"] = p
    try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: w.config))
    #expect(w.accept() == .wrote)
    let e = try #require(try w.projects()[w.trip] as? [String: Any])
    #expect(e as NSDictionary == ["allowedTools": ["Bash"], "hasTrustDialogAccepted": true, "lastCost": 2] as NSDictionary)
    var before = stat()
    stat(w.config, &before)
    #expect(w.accept() == .already)
    var after = stat()
    stat(w.config, &after)
    #expect(before.st_ino == after.st_ino)  // not replaced
  }

  @Test func aConfigThatIsALinkIsWrittenWhereItIsAndStaysALink() throws {
    let w = try make()
    let real = w.root + "/dotfiles.json"
    try FileManager.default.moveItem(atPath: w.config, toPath: real)
    try FileManager.default.createSymbolicLink(atPath: w.config, withDestinationPath: real)
    #expect(w.accept() == .wrote)
    #expect((try FileManager.default.destinationOfSymbolicLink(atPath: w.config)) == real)
    let o = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: real))) as? [String: Any])
    #expect(((o["projects"] as? [String: Any])?[w.trip] as? [String: Any])?["hasTrustDialogAccepted"] as? Bool == true)
  }

  private func refused(_ w: World, _ r: FolderTrust.Result, _ why: String, _ line: UInt = #line) throws {
    guard case .refused(let said) = r else {
      Issue.record("expected a refusal containing \"\(why)\", got \(r)")
      return
    }
    #expect(said.contains(why), "\(said)")
    #expect(w.leftovers().isEmpty)
  }

  @Test func aParentTheHomeFolderAndSlashAreRefusedWithTheConfigUntouched() throws {
    let w = try make()
    let before = try w.bytes()
    try refused(w, w.accept(folder: w.home + "/work"), "not one the owner chose")  // the parent of the chosen folder
    for f in [w.home, w.root, "/"] { try refused(w, w.accept(folder: f, chosen: [f]), "inside the home folder") }  // even when "chosen"
    #expect(try w.bytes() == before)
  }

  @Test func theAgentFolderTheTalosDataAndClaudeSettingsAreRefused() throws {
    let w = try make()
    let before = try w.bytes()
    try refused(w, w.accept(folder: w.agent, chosen: [w.agent]), "agent folder")
    try refused(w, w.accept(folder: w.talos, chosen: [w.talos]), "Talos data")
    try refused(w, w.accept(folder: w.home + "/.claude", chosen: [w.home + "/.claude"]), "~/.claude")
    #expect(try w.bytes() == before)
  }

  @Test func symlinksToAParentAreRefused() throws {
    let w = try make()
    let before = try w.bytes()
    let toHome = w.home + "/work/toHome"
    try FileManager.default.createSymbolicLink(atPath: toHome, withDestinationPath: w.home)
    // named as the folder: not its own real path
    try refused(w, w.accept(folder: toHome, chosen: [toHome]), "real path")
    // configured as a link into its own parent: the real folder is "work", written under it
    let up = w.home + "/work/up"
    try FileManager.default.createSymbolicLink(atPath: up, withDestinationPath: w.home + "/work")
    try refused(w, w.accept(folder: w.home + "/work", chosen: [up]), "link into its own parent")
    // a link to $HOME as the configured folder is the home folder
    try refused(w, w.accept(folder: w.home, chosen: [toHome]), "inside the home folder")
    #expect(try w.bytes() == before)
  }

  @Test func aFolderOutsideTheChosenSetIsRefused() throws {
    let w = try make()
    let before = try w.bytes()
    let elsewhere = w.home + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try refused(w, w.accept(folder: elsewhere), "not one the owner chose")
    try refused(w, w.accept(chosen: []), "not one the owner chose")
    try refused(w, w.accept(chosen: ["trip", w.trip + "/.."]), "not one the owner chose")
    try refused(w, w.accept(folder: w.trip + "/."), "plain absolute path")
    try refused(w, w.accept(folder: "work/trip"), "plain absolute path")
    try refused(w, w.accept(folder: w.home + "/gone", chosen: [w.home + "/gone"]), "does not exist")
    #expect(try w.bytes() == before)
  }

  @Test func aChosenLinkToTheFolderIsFineAndItsRealPathIsWhatIsTrusted() throws {
    let w = try make()
    let alias = w.home + "/alias"
    try FileManager.default.createSymbolicLink(atPath: alias, withDestinationPath: w.trip)
    #expect(w.accept(chosen: [alias]) == .wrote)
    #expect(try w.projects()[w.trip] != nil)
    #expect(try w.projects()[alias] == nil)
  }

  @Test func aConfigThatIsMissingNotJSONOrTheWrongShapeIsLeftAloneAndSaid() throws {
    let w = try make()
    let good = try w.bytes()
    for bad in ["{ not json", "[1,2]", "{\"projects\": []}", "{\"projects\": {\"\(w.trip)\": 5}}"] {
      try Data(bad.utf8).write(to: URL(fileURLWithPath: w.config))
      try refused(w, w.accept(), "left as it is")
      #expect(try w.bytes() == Data(bad.utf8))
    }
    try FileManager.default.removeItem(atPath: w.config)
    try refused(w, w.accept(), "no config file")
    #expect(!FileManager.default.fileExists(atPath: w.config))  // never made from nothing
    try good.write(to: URL(fileURLWithPath: w.config))
  }

  @Test func aChangeBetweenTheReadAndTheRenameIsKeptAndTheWriteStartsOver() throws {
    let w = try make()
    var hits = 0
    let r = w.accept(hook: {
      hits += 1
      if hits > 1 { return }
      // Claude Code rewrites its own file: a changed value and a new top-level key land after our read
      var o = (try? w.object()) ?? [:]
      o["numStartups"] = 8
      o["addedByClaude"] = ["x": 1]
      try? JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: w.config))
    })
    #expect(r == .wrote)
    #expect(hits == 2)
    let now = try w.object()
    #expect(now["numStartups"] as? Int == 8)
    #expect((now["addedByClaude"] as? [String: Any])?["x"] as? Int == 1)
    #expect((try w.projects()[w.trip] as? [String: Any])?["hasTrustDialogAccepted"] as? Bool == true)
    #expect(w.leftovers().isEmpty)
  }

  @Test func aWriterThatNeverLetsUpIsSaidAndItsFileIsIntact() throws {
    let w = try make()
    var n = 0
    let r = w.accept(hook: {
      var o = (try? w.object()) ?? [:]
      o["numStartups"] = 100 + n
      n += 1
      try? JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: w.config))
    })
    try refused(w, r, "kept changing")
    #expect(n == FolderTrust.tries)
    #expect(try w.object()["numStartups"] as? Int == 100 + n - 1)
  }

  @Test func twoFoldersBackToBackAreBothThere() throws {
    let w = try make()
    let two = w.home + "/work/two"
    try FileManager.default.createDirectory(atPath: two, withIntermediateDirectories: true)
    #expect(w.accept() == .wrote)
    #expect(w.accept(folder: two, chosen: [two]) == .wrote)
    let keys = Set(try w.projects().keys)
    #expect(keys.isSuperset(of: [w.trip, two]))
  }

  @Test func theConfigFileIsInTheConfigHome() {
    #expect(FolderTrust.configFile(configHome: "/home/alex") == "/home/alex/.claude.json")
    #expect(FolderTrust.configFile(configHome: "/home/alex/.claude/") == "/home/alex/.claude/.claude.json")
    #expect(FolderTrust.configFile(configHome: "/") == "/.claude.json")
  }
}

/// Claude Code's own lock (`<config file>.lock`, proper-lockfile: a folder made by mkdir), and the owner's recorded choice (`OwnerFolders`).
@Suite struct FolderTrustLockTests {
  private func make() throws -> FolderTrustTests.World { try FolderTrustTests().makeWorld() }
  private func lock(_ w: FolderTrustTests.World) -> String { w.config + ".lock" }

  @Test func theWriteIsMadeWhileThatLockIsHeldAndItIsGoneAfterwardsEvenOnARefusal() throws {
    let w = try make()
    var seen = false
    #expect(w.accept(hook: { var d: ObjCBool = false; seen = FileManager.default.fileExists(atPath: lock(w), isDirectory: &d) && d.boolValue }) == .wrote)
    #expect(seen)
    #expect(!FileManager.default.fileExists(atPath: lock(w)))
    try Data("{ broken".utf8).write(to: URL(fileURLWithPath: w.config))
    guard case .refused = w.accept() else { Issue.record("a config that cannot be read is refused"); return }
    #expect(!FileManager.default.fileExists(atPath: lock(w)))
  }

  @Test func aLockClaudeCodeHoldsIsWaitedForNeverTaken() throws {
    let w = try make()
    mkdir(lock(w), 0o755)
    var waits = 0
    let r = FolderTrust.preAccept(
      configFile: w.config, folder: w.trip, chosen: [w.trip], home: w.home, talosHome: w.talos, agentDir: w.agent,
      wait: { _ in waits += 1; if waits == 3 { rmdir(lock(w)) } })
    #expect(r == .wrote)
    #expect(waits == 3)
  }

  @Test func aLockThatNeverLetsGoMeansNoWriteAndTheLockIsLeftAsItWas() throws {
    let w = try make()
    mkdir(lock(w), 0o755)
    let old = Date().addingTimeInterval(-3600)  // even one that looks stale (Claude Code's own rule is 10 s) is not ours to remove
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: lock(w))
    let before = try w.bytes()
    var waits = 0
    let r = FolderTrust.preAccept(
      configFile: w.config, folder: w.trip, chosen: [w.trip], home: w.home, talosHome: w.talos, agentDir: w.agent, wait: { _ in waits += 1 })
    guard case .refused(let why) = r else { Issue.record("expected a refusal, got \(r)"); return }
    #expect(why.contains("its lock is held"))
    #expect(waits == FolderTrust.lockDelays.count)
    #expect(try w.bytes() == before)
    #expect(FileManager.default.fileExists(atPath: lock(w)))
    let m = try FileManager.default.attributesOfItem(atPath: lock(w))[.modificationDate] as? Date
    #expect(m.map { abs($0.timeIntervalSince(old)) < 1 } == true)
  }

  @Test func ownerFoldersCountOnlyWhileTheFolderIsStillWhatTheOwnerChose() throws {
    let w = try make()
    let home = w.talos
    func record(_ cwd: String, _ real: String) throws {
      try Data("{\"v\":1,\"threads\":{\"trip\":{\"cwd\":\"\(cwd)\",\"real\":\"\(real)\"}}}".utf8).write(to: URL(fileURLWithPath: home + "/owner-folders.json"))
    }
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.trip, folder: w.trip), "no file, no record")
    try record(w.trip, w.trip)
    #expect(OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.trip, folder: w.trip))
    #expect(OwnerFolders.chose(talosHome: home, ids: ["sub", "trip"], configured: w.trip, folder: w.trip), "a sub-thread sharing its parent's folder")
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["sub"], configured: w.trip, folder: w.trip))
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.home + "/work/other", folder: w.trip), "the config now names another folder")
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.trip, folder: w.home + "/elsewhere"), "it resolves elsewhere now")
    try Data("{ nope".utf8).write(to: URL(fileURLWithPath: home + "/owner-folders.json"))
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.trip, folder: w.trip))
    try FileManager.default.removeItem(atPath: home + "/owner-folders.json")
    try Data("{\"v\":1,\"threads\":{\"trip\":{\"cwd\":\"\(w.trip)\",\"real\":\"\(w.trip)\"}}}".utf8).write(to: URL(fileURLWithPath: w.home + "/real.json"))
    try FileManager.default.createSymbolicLink(atPath: home + "/owner-folders.json", withDestinationPath: w.home + "/real.json")
    #expect(!OwnerFolders.chose(talosHome: home, ids: ["trip"], configured: w.trip, folder: w.trip), "a link is no record")
  }
}
