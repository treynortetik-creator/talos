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
  /// `parentOpts` gets the fake home too. The config is whole before the manager's first tick: a tick reads it once and takes the wakes
  /// under that read, so a config rewritten after ticking has started can be missed by a tick that is already running (a wake taken
  /// under the old config). `prepare` runs before ticking for the same reason (folders the config points at).
  func rig(
    parentId: String = "par", parentOpts: ((String) -> String)? = nil, prepare: (WorkerRig) throws -> Void = { _ in },
    _ subOpts: (String) -> String
  ) throws -> WorkerRig {
    let r = try WorkerRig(scenario: "review-worker.sh")
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"
    try r.fenceWorld(projects: ["par"])
    try prepare(r)
    try config(r, subOpts: subOpts(r.home), parentId: parentId, parentOpts: parentOpts?(r.home))
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
    let r = try rig { #"{"cwd":"\#($0)/par/made/deeper"}"# }
    defer { r.teardown() }
    #expect(!FileManager.default.fileExists(atPath: r.home + "/par/made"))
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(FileManager.default.fileExists(atPath: r.home + "/par/made/deeper"))
    #expect(r.wait(3) { r.entry("sub")?.launched != nil })
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/par/made/deeper")
  }

  @Test func aSubWhoseFolderLeadsOutOfItsParentDoesNotStartAndNothingIsMade() throws {
    for path in ["/par/../esc/x", "/other/x"] {
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
    let r = try rig(
      parentOpts: { #"{"cwd":"\#($0)/.claude/par"}"# },
      prepare: { try FileManager.default.createDirectory(atPath: $0.home + "/.claude/par", withIntermediateDirectories: true) }
    ) { #"{"cwd":"\#($0)/.claude/par/new"}"# }
    defer { r.teardown() }
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

  @Test func aSubWithNoFolderOfItsOwnRunsInItsParentsFolderBesideTheParent() throws {
    let r = try rig { _ in "{}" }
    defer { r.teardown() }
    try r.wake("par")
    #expect(r.wait(10) { r.up("par") }, "\(r.why("par"))")
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "not folder_claimed: \(r.why("sub"))")
    #expect(r.wait(3) { r.entry("sub")?.launched != nil })
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/par")
    #expect(r.starts.count == 2, "the parent and the child both started")
    // it stays up well past the settle time: a running shared-folder child is not judged "outside" and parked
    #expect(!r.wait(2) { !r.up("sub") }, "\(r.why("sub"))")
  }

  @Test func aSubNamingItsParentsOwnFolderIsTheSameAsOneWithNone() throws {
    for name in ["par", "par/"] {
      let r = try rig { _ in "{}" }
      defer { r.teardown() }
      try config(r, subOpts: #"{"cwd":"\#(r.home)/\#(name)"}"#)
      try r.wake("par")
      #expect(r.wait(10) { r.up("par") }, "\(name): \(r.why("par"))")
      try r.wake("sub")
      #expect(r.wait(10) { r.up("sub") }, "\(name): \(r.why("sub"))")
      #expect(r.entry("sub")?.launched?.cwd == r.home + "/par", "\(name)")
      #expect(r.starts.count == 2, "\(name)")
    }
  }

  @Test func anUnrelatedThreadInTheSameFolderIsStillRefusedAsFolderClaimed() throws {
    let r = try rig { _ in "{}" }
    defer { r.teardown() }
    // a third thread, no parent, naming the parent's folder: not in the family
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
    {"id":"par","kind":"fixed","session":"dedicated","session_opts":{"cwd":"\(r.home)/par"}},
    {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"par","session_opts":{}},
    {"id":"stray","kind":"fixed","session":"dedicated","session_opts":{"cwd":"\(r.home)/par"}}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    try r.wake("par")
    #expect(r.wait(10) { r.up("par") }, "\(r.why("par"))")
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    try r.wake("stray")
    #expect(r.wait(10) { r.state("stray") == "failed" }, "\(r.why("stray"))")
    #expect(r.entry("stray")?.error?.code == "folder_claimed")
  }

  @Test func aSubWhoseFolderIsItsParentsFolderIsRefusedUpFrontNotAsFolderClaimed() throws {
    for name in ["parlink", "par/../par"] {
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

  // the owner, 2026-11-19: under a parent with no folder (it runs in the agent folder), a sub-thread's own existing folder is used
  @Test func aSubWhoseParentHasNoFolderStartsInItsOwnExistingFolder() throws {
    let r = try rig(parentOpts: { _ in "{}" }) { #"{"cwd":"\#($0)/par"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
  }

  @Test func aSubWhoseParentHasNoFolderAndWhoseFolderOutsideIsMissingDoesNotStartAndNothingIsMade() throws {
    let r = try rig(parentOpts: { _ in "{}" }) { #"{"cwd":"\#($0)/par/s"}"# }
    defer { r.teardown() }
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.starts.isEmpty && !FileManager.default.fileExists(atPath: r.home + "/par/s"))
  }

  @Test func theMacSaysInWorkersJsonThatItCanLaunchSubThreads() throws {
    let r = try rig { _ in "{}" }
    defer { r.teardown() }
    #expect(r.wait(5) { FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap(WorkersFile.decode)?.supervisor.subthreads_supported == true })
    #expect(r.mgr.snapshot().supervisor.subthreads_supported)
    #expect(r.mgr.snapshot().supervisor.subthreads_folderless_parent)
  }
}
