import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// A thread session's start records the owner's folder choice as Claude Code's own trust answer (`FolderTrust`, `acceptFolderTrust`).
/// Real private tmux server and a fake home; the owner's Claude config is never touched: the rig's HOME is its own folder.
@Suite("A thread's folder is trusted by the owner's choice", .serialized, .enabled(if: Rig.hasTmux))
struct FolderTrustStartTests {
  private func config(_ r: WorkerRig) -> String { r.root + "/home/.claude.json" }

  /// What the bridge leaves after a signed config.patch set the folder (`OwnerFolders`).
  private func ownerChose(_ r: WorkerRig, _ folder: String, thread: String = "trip", real: String? = nil) throws {
    try Data("{\"v\":1,\"threads\":{\"\(thread)\":{\"cwd\":\"\(folder)\",\"real\":\"\(real ?? folder)\"}}}".utf8)
      .write(to: URL(fileURLWithPath: r.talosHome + "/" + OwnerFolders.fileName))
  }

  private func objectAt(_ path: String) -> [String: Any]? {
    FileManager.default.contents(atPath: path).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }

  @Test func aStartInTheThreadsOwnFolderWritesThatFoldersKeyOnlyAndTheSessionComesUp() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let folder = try TestTemp.real(r.root) + "/home/alex/trip"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    try r.writeConfig(maxLive: 3, threads: [("trip", folder)])
    try ownerChose(r, folder)
    try JSONSerialization.data(withJSONObject: ["numStartups": 3, "projects": ["/home/alex/else": ["lastCost": 1]]])
      .write(to: URL(fileURLWithPath: config(r)))
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    let o = try #require(objectAt(config(r)))
    #expect(o["numStartups"] as? Int == 3)
    let projects = try #require(o["projects"] as? [String: Any])
    #expect((projects["/home/alex/else"] as? [String: Any])?["lastCost"] as? Int == 1)
    #expect((projects[folder] as? [String: Any])?["hasTrustDialogAccepted"] as? Bool == true, "\(projects.keys)")
    #expect(projects.count == 2, "nothing else was added: \(projects.keys)")
  }

  @Test func theAgentFolderIsNeverWrittenByIt() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let plain: [String: Any] = ["numStartups": 3, "projects": [String: Any]()]
    try JSONSerialization.data(withJSONObject: plain).write(to: URL(fileURLWithPath: config(r)))
    let before = try Data(contentsOf: URL(fileURLWithPath: config(r)))
    r.mgr.startTicking()
    try r.wake("trip")  // the thread has no folder of its own: the agent folder
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(try Data(contentsOf: URL(fileURLWithPath: config(r))) == before)
  }

  /// No config at all, or one that is not JSON: the start goes on, nothing is made from nothing, and what is there is left as it was.
  @Test(arguments: [String?.none, "{ not json"]) func aConfigThatCannotBeWrittenNeverStopsTheStart(existing: String?) throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let folder = try TestTemp.real(r.root) + "/home/alex/trip"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    try r.writeConfig(maxLive: 3, threads: [("trip", folder)])
    try ownerChose(r, folder)
    if let existing { try Data(existing.utf8).write(to: URL(fileURLWithPath: config(r))) }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(FileManager.default.contents(atPath: config(r)) == existing.map { Data($0.utf8) })
  }

  /// A folder `talos-app lead init` or a hand edit put in config.json has no record of the owner choosing it: nothing is pre-accepted, the
  /// session starts, and Claude Code's own question is what the phone's card shows. Same for a record that names another folder, or one whose
  /// folder now resolves somewhere else.
  @Test(arguments: ["none", "otherFolder", "movedLink"]) func aFolderTheOwnerDidNotChooseIsNotPreAccepted(record: String) throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let root = try TestTemp.real(r.root)
    let folder = root + "/home/alex/trip"
    let other = root + "/home/alex/other"
    for d in [folder, other] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    try r.writeConfig(maxLive: 3, threads: [("trip", folder)])
    switch record {
    case "otherFolder": try ownerChose(r, other)
    case "movedLink": try ownerChose(r, folder, real: other)
    default: break
    }
    let plain: [String: Any] = ["numStartups": 3, "projects": [String: Any]()]
    try JSONSerialization.data(withJSONObject: plain).write(to: URL(fileURLWithPath: config(r)))
    let before = try Data(contentsOf: URL(fileURLWithPath: config(r)))
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(try Data(contentsOf: URL(fileURLWithPath: config(r))) == before, "nothing was written for \(record)")
  }
}
