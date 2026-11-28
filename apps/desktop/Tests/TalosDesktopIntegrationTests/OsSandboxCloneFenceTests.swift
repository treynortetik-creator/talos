import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The clone fence through the real start path (`OsSandboxLaunch.prepare`) with a real guards/settings.json that pins a bun and
/// `<clone>/apps/bridge/src/cli.ts`: the record is read from disk as a start reads it, never handed in. Every test works in its own fresh
/// folder made here, and removes only that folder.
@Suite("Clone fence: a start through OsSandboxLaunch.prepare")
struct OsSandboxCloneFenceTests {
  static let cloneLine = "This folder contains the Talos code, or is inside it. Pick another folder and start again."
  static let bunLine = "This folder contains the program Talos runs on, or is inside it. Pick another folder and start again."

  /// `root` (real path) holds `talos` (the Talos home, with the guards' settings), `home`, and whatever a test adds.
  struct Rig {
    let root: String
    var talos: String { root + "/talos" }
    var home: String { root + "/home" }
    var bun: String { root + "/bun/bin/bun" }

    init() throws {
      let made = (TestTemp.base as NSString).appendingPathComponent("talos-fence-\(UUID().uuidString.prefix(8))")
      try FileManager.default.createDirectory(atPath: made, withIntermediateDirectories: true)
      root = try TestTemp.real(made)
      for d in [talos + "/guards", home + "/.claude", root + "/bun/bin"] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
      FileManager.default.createFile(atPath: bun, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
    }

    func cleanup() { try? FileManager.default.removeItem(atPath: root) }

    func mkdir(_ rel: String) throws { try FileManager.default.createDirectory(atPath: root + "/" + rel, withIntermediateDirectories: true) }

    /// A clone at `rel` with its cli.ts, and the guards' hook pinning the bun and that cli (the first line is what refresh keeps current).
    func clone(at rel: String, hook: ((String, String) -> String)? = nil) throws {
      try mkdir(rel + "/apps/bridge/src")
      let cli = root + "/" + rel + "/apps/bridge/src/cli.ts"
      try Data("1".utf8).write(to: URL(fileURLWithPath: cli))
      let cmd = hook?(bun, cli) ?? "\"\(bun)\" \"\(cli)\" guard-hook --config /x"
      let s: [String: Any] = ["hooks": ["PreToolUse": [["hooks": [["type": "command", "command": cmd]]]]]]
      try JSONSerialization.data(withJSONObject: s).write(to: URL(fileURLWithPath: talos + "/guards/settings.json"))
    }

    func prepare(folder: String, agentDir: String? = nil, loadsProject: Bool = true, dry: Bool = true) -> (OsSandbox.Prepared, [String]) {
      var audits: [String] = []
      let r = OsSandboxLaunch.prepare(
        talosHome: talos, home: home, folder: root + "/" + folder, claudeDir: home + "/.claude", env: ["HOME": home], loadsProject: loadsProject, dry: dry,
        agentDir: agentDir.map { root + "/" + $0 }, writableRoots: [], tmpRoots: [], audit: { name, _ in audits.append(name) })
      return (r, audits)
    }

    func denyWrite(_ p: OsSandbox.Prepared) -> [String] {
      ((p.pieces?.sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String]) ?? []
    }
  }

  // (a) the agent folder holds the clone: refused with the clone line, though the clone is "inside the session folder"
  @Test func aFolderThatHoldsTheCloneIsRefusedWithTheCloneLine() throws {
    let r = try Rig()
    defer { r.cleanup() }
    try r.mkdir("agent")
    try r.clone(at: "agent/clone")
    let (got, _) = r.prepare(folder: "agent", agentDir: "agent")
    #expect(got == .refused(Self.cloneLine), "\(got)")
  }

  // (b) the folder is the clone itself (and, separately, its bridge folder)
  @Test func aFolderThatIsTheCloneOrItsBridgeFolderIsRefused() throws {
    let r = try Rig()
    defer { r.cleanup() }
    try r.clone(at: "clone")
    let (a, _) = r.prepare(folder: "clone", agentDir: "clone")
    #expect(a == .refused(Self.cloneLine), "\(a)")
    let (b, _) = r.prepare(folder: "clone/apps/bridge", agentDir: "clone/apps/bridge")
    #expect(b == .refused(Self.cloneLine), "\(b)")
  }

  // (c) the clone sits under the agent folder, the thread's folder is elsewhere: it starts, and the clone, bridge and bun are write-protected
  @Test func aThreadBesideTheCloneStartsAndTheCloneBridgeAndBunAreDenied() throws {
    let r = try Rig()
    defer { r.cleanup() }
    try r.mkdir("agent")
    try r.mkdir("thread")
    try r.clone(at: "agent/clone")
    let (got, _) = r.prepare(folder: "thread", agentDir: "agent", loadsProject: false)
    #expect(got.pieces != nil, "\(got)")
    let deny = r.denyWrite(got)
    for p in [r.root + "/agent/clone", r.root + "/agent/clone/apps/bridge", r.bun] { #expect(deny.contains(p), "\(p) in \(deny)") }
  }

  // (d) Main's own folder is the agent folder and holds the clone: refused (a start with no talos-app server must not pass)
  @Test func theAgentFolderHoldingTheCloneIsRefusedAtMainsStartToo() throws {
    let r = try Rig()
    defer { r.cleanup() }
    try r.mkdir("agent")
    try r.clone(at: "agent/clone")
    let (got, audits) = r.prepare(folder: "agent", agentDir: "agent", loadsProject: true, dry: false)
    #expect(got == .refused(Self.cloneLine), "\(got)")
    #expect(audits.contains("os_sandbox_refused"), "the owner's audit row: \(audits)")
  }
}
