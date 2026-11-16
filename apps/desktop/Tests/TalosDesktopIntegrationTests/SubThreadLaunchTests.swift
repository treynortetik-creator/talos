import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A sub-thread's session through the real seams: a private tmux server, the fake claude, a fake HOME and Talos home.
@Suite("Sub-thread launch", .serialized, .enabled(if: Rig.hasTmux))
struct SubThreadLaunchTests {
  /// `par` (folder `home/par`, list github+notes) and a sub-thread `sub` whose `session_opts` is `subOpts` (JSON text), with `parentId` as its parent.
  func config(_ r: WorkerRig, subOpts: String, parentId: String = "par", parentOpts: String? = nil) throws {
    let opts = parentOpts ?? #"{"cwd":"\#(r.home)/par","mcp_allow":["github","notes"]}"#
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
    {"id":"par","kind":"fixed","session":"dedicated","session_opts":\(opts)},
    {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"\(parentId)","session_opts":\(subOpts)}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  /// The rig with the manager ticking; `subOpts` gets the fake home.
  func rig(parentId: String = "par", parentOpts: String? = nil, _ subOpts: (String) -> String) throws -> WorkerRig {
    let r = try WorkerRig(scenario: "review-worker.sh")
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"
    try r.fenceWorld(projects: ["par"])
    try config(r, subOpts: subOpts(r.home), parentId: parentId, parentOpts: parentOpts)
    r.manager(busyWindow: 0.5)
    r.mgr.startTicking()
    return r
  }

  func servers(_ r: WorkerRig, _ id: String) throws -> Set<String> {
    let data = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers/\(id)/mcp/mcp.json"))
    let j = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    return Set((j?["mcpServers"] as? [String: Any] ?? [:]).keys)
  }

  @Test func aSubWithAFolderThatDoesNotExistGetsItMadeInsideItsParentAndRunsThere() throws {
    let r = try rig(parentOpts: nil) { #"{"cwd":"\#($0)/par/made/deeper"}"# }
    defer { r.teardown() }
    #expect(!FileManager.default.fileExists(atPath: r.home + "/par/made"))
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(FileManager.default.fileExists(atPath: r.home + "/par/made/deeper"))
    #expect(r.wait(3) { r.entry("sub")?.launched != nil })
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/par/made/deeper")
  }

  @Test func aSubWhoseFolderLeadsOutOfItsParentDoesNotStartAndNothingIsMade() throws {
    for path in ["/par/../esc/x", "/other/x", "/par"] {
      let r = try rig { #"{"cwd":"\#($0)\#(path)"}"# }
      defer { r.teardown() }
      try r.wake("sub")
      #expect(r.wait(10) { r.state("sub") == "failed" }, "\(path): \(r.why("sub"))")
      #expect(r.entry("sub")?.error?.code == "start_failed", "\(path)")
      #expect(r.entry("sub")?.error?.detail?.contains("sub-thread folder") == true, "\(path): \(String(describing: r.entry("sub")?.error))")
      #expect(!FileManager.default.fileExists(atPath: r.home + "/esc") && !FileManager.default.fileExists(atPath: r.home + "/other"), "\(path)")
      #expect(r.starts.isEmpty, "no session was started")
    }
  }

  @Test func aSubWithItsOwnExistingFolderOutsideItsParentRunsThereAndIsNotParked() throws {
    let r = try rig { #"{"cwd":"\#($0)/own"}"# }
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.home + "/own", withIntermediateDirectories: true)
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(r.wait(3) { r.entry("sub")?.launched != nil })
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/own")
    // it stays up well past the settle time: a running own-folder child is not judged "outside" and parked
    #expect(!r.wait(2) { !r.up("sub") }, "\(r.why("sub"))")
    #expect(r.up("sub"))
  }

  @Test func aSubWithAMissingOwnFolderOutsideItsParentIsRefusedAndNothingIsMade() throws {
    let r = try rig { #"{"cwd":"\#($0)/own-missing"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.detail?.contains("sub-thread folder") == true)
    #expect(!FileManager.default.fileExists(atPath: r.home + "/own-missing"))
    #expect(r.starts.isEmpty)
  }

  @Test func nothingIsMadeInsideAParentFolderNoSessionMayUse() throws {
    let r = try rig(parentOpts: "{}") { _ in "{}" }
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.home + "/.claude/par", withIntermediateDirectories: true)
    try config(r, subOpts: #"{"cwd":"\#(r.home)/.claude/par/new"}"#, parentOpts: #"{"cwd":"\#(r.home)/.claude/par"}"#)
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(!FileManager.default.fileExists(atPath: r.home + "/.claude/par/new"))
    #expect(r.starts.isEmpty)
  }

  @Test func aSubsMcpListIsItsOwnLimitedToItsParentsAndWhatWasDroppedIsNotLaunched() throws {
    let r = try rig { #"{"cwd":"\#($0)/par/s","mcp_allow":["github","zzz"]}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(try servers(r, "sub") == ["talos-app", "github"])
    #expect(r.entry("sub")?.launched?.mcp_allow == ["github"])
  }

  @Test func aSubWithNoListOfItsOwnRunsOnItsParentsListInAFolderOfItsOwn() throws {
    let r = try rig { #"{"cwd":"\#($0)/par/s"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(try servers(r, "sub") == ["talos-app", "github", "notes"])
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/par/s")
    #expect(Set(r.entry("sub")?.launched?.mcp_allow ?? []) == ["github", "notes"])
  }

  @Test func aSubWhoseParentIsGoneDoesNotStart() throws {
    let r = try rig(parentId: "gone") { #"{"cwd":"\#($0)/par/s"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.code == "start_failed")
    #expect(r.starts.isEmpty && !FileManager.default.fileExists(atPath: r.home + "/par/s"))
  }

  @Test func aFolderSettingThatIsNotTextDoesNotStartAndNamesTheValue() throws {
    let r = try rig { _ in #"{"cwd":4711}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.code == "start_failed")
    #expect(r.entry("sub")?.error?.detail?.contains("4711") == true, "\(String(describing: r.entry("sub")?.error))")
    #expect(r.starts.isEmpty, "not started in the parent's folder either")
  }

  @Test func aSubWithNoFolderOfItsOwnIsAConfigErrorEvenWhileItsParentRuns() throws {
    let r = try rig { _ in "{}" }
    defer { r.teardown() }
    try r.wake("par")
    #expect(r.wait(10) { r.up("par") }, "\(r.why("par"))")
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.code == "start_failed", "not folder_claimed: \(String(describing: r.entry("sub")?.error))")
    #expect(r.entry("sub")?.error?.detail?.contains("folder of its own") == true)
    #expect(r.starts.count == 1, "only the parent started")
  }

  @Test func aSubWhoseFolderIsItsParentsFolderIsRefusedUpFrontNotAsFolderClaimed() throws {
    for name in ["par", "parlink", "par/../par"] {
      let r = try rig { _ in "{}" }
      defer { r.teardown() }
      try FileManager.default.createSymbolicLink(atPath: r.home + "/parlink", withDestinationPath: r.home + "/par")
      try config(r, subOpts: #"{"cwd":"\#(r.home)/\#(name)"}"#)
      try r.wake("par")
      #expect(r.wait(10) { r.up("par") }, "\(name): \(r.why("par"))")
      try r.wake("sub")
      #expect(r.wait(10) { r.state("sub") == "failed" }, "\(name): \(r.why("sub"))")
      #expect(r.entry("sub")?.error?.code == "start_failed", "\(name): not folder_claimed: \(String(describing: r.entry("sub")?.error))")
      #expect(r.entry("sub")?.error?.detail?.contains("inside its parent") == true, "\(name)")
      #expect(r.starts.count == 1, "\(name): only the parent started")
      // it stays refused: a retry does not turn into a folder wait
      usleep(1_500_000)
      #expect(r.entry("sub")?.error?.code == "start_failed", "\(name)")
    }
  }

  @Test func aSubWhoseParentHasNoFolderDoesNotStart() throws {
    let r = try rig(parentOpts: "{}") { #"{"cwd":"\#($0)/par/s"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.detail?.contains("give the parent a folder first") == true, "\(String(describing: r.entry("sub")?.error))")
    #expect(r.starts.isEmpty && !FileManager.default.fileExists(atPath: r.home + "/par/s"))
  }

  @Test func theMacSaysInWorkersJsonThatItCanLaunchSubThreads() throws {
    let r = try rig { _ in "{}" }
    defer { r.teardown() }
    #expect(r.wait(5) { FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap(WorkersFile.decode)?.supervisor.subthreads_supported == true })
    #expect(r.mgr.snapshot().supervisor.subthreads_supported)
  }
}
