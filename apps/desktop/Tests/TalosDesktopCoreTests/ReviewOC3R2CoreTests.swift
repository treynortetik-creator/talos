import Foundation
import Testing
import TalosDesktopCore

/// Re-review of PR #68 at 0b5c05c. Tests named FINDING fail until the finding is fixed; the others are controls.
@Suite("Review OC3 R2 core", .serialized)
struct ReviewOC3R2CoreTests {
  private func tempHome() throws -> String {
    let t = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-r2-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: t, withIntermediateDirectories: true)
    let p = realpath(t, nil)!
    defer { free(p) }
    return String(cString: p)
  }

  private func mkdir(_ p: String) throws {
    try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
  }

  /// `h + "/.claude"` is the one root folderProblem doesn't resolve. With `~/.claude` a symlink into the home folder (stow,
  /// chezmoi and friends do exactly this) the real folder passes, and so does anything symlinked to it. The check exists
  /// to keep a worker out of that folder. checkWorkerCwd in the protocol package has the same hole.
  @Test func FINDING_aSymlinkedDotClaudeIsStillRefused() throws {
    let home = try tempHome()
    defer { try? FileManager.default.removeItem(atPath: home) }
    try mkdir(home + "/dotfiles/claude/projects")
    try FileManager.default.createSymbolicLink(atPath: home + "/.claude", withDestinationPath: home + "/dotfiles/claude")
    try FileManager.default.createSymbolicLink(atPath: home + "/innocent", withDestinationPath: home + "/.claude/projects")
    for p in ["/dotfiles/claude", "/dotfiles/claude/projects", "/.claude", "/.claude/projects", "/innocent"] {
      #expect(WorkerSpec.folderProblem(home + p, home: home, talosHome: home + "/t") != nil, "\(p) passed")
    }
  }

  /// Control: case variants of ~/.claude, of the home folder, and a symlink to a case variant, on this volume.
  @Test func caseVariantsOfDotClaudeAreRefused() throws {
    let home = try tempHome()
    defer { try? FileManager.default.removeItem(atPath: home) }
    try mkdir(home + "/.claude/projects")
    guard FileManager.default.fileExists(atPath: home + "/.CLAUDE/projects") else { return }  // a case-sensitive volume
    for v in [".CLAUDE", ".Claude", ".cLaUdE"] {
      #expect(WorkerSpec.folderProblem(home + "/" + v + "/projects", home: home, talosHome: home + "/t") != nil, "\(v)")
      #expect(WorkerSpec.folderProblem(home + "/" + v, home: home, talosHome: home + "/t") != nil, "\(v)")
    }
    try FileManager.default.createSymbolicLink(atPath: home + "/link", withDestinationPath: home + "/.CLAUDE/projects")
    #expect(WorkerSpec.folderProblem(home + "/link", home: home, talosHome: home + "/t") != nil)
    #expect(WorkerSpec.folderProblem(home.uppercased() + "/.CLAUDE", home: home, talosHome: home + "/t") != nil)
    // and the neighbours stay allowed
    try mkdir(home + "/.claude-work")
    #expect(WorkerSpec.folderProblem(home + "/.claude-work", home: home, talosHome: home + "/t") == nil)
  }

  /// The fix round writes the realpath into `workers.json` (WorkerManager.swift:513). The protocol's `AbsolutePath` allows
  /// no control characters and 512 at most, and one bad entry makes parseWorkersFile return null for the whole file: the
  /// hub then reads the supervisor as down and every dedicated thread falls back. A short, clean symlink gets past the
  /// bridge's check of the raw value; this is the last check that sees the resolved one.
  @Test func FINDING_aFolderTheProtocolCantCarryIsRefused() throws {
    let home = try tempHome()
    defer { try? FileManager.default.removeItem(atPath: home) }
    try mkdir(home + "/we\u{7f}ird")
    try FileManager.default.createSymbolicLink(atPath: home + "/clean", withDestinationPath: home + "/we\u{7f}ird")
    #expect(WorkerSpec.folderProblem(home + "/clean", home: home, talosHome: home + "/t") != nil, "control character")
    var deep = home
    for _ in 0..<10 { deep += "/" + String(repeating: "d", count: 60) }
    try mkdir(deep)
    #expect(WorkerSpec.folderProblem(deep, home: home, talosHome: home + "/t") != nil, "\(deep.utf8.count) bytes")
  }

  /// `workerScreen` handles trust, MCP and login by shape; the other screens still go through on words alone. A Talos thread
  /// about Talos quotes these. Dev warning: `isDialog`, so a resume stops as needs_mac. Resume error: no pointer is ever
  /// typed while it is on screen.
  @Test func FINDING_aQuotedDevWarningIsNotADialog() {
    #expect(DialogMatcher.workerScreen(["  the log said WARNING: Loading development channels at that point"]) == .none)
  }

  @Test func FINDING_aQuotedResumeErrorIsNotAScreen() {
    #expect(DialogMatcher.workerScreen(["  the supervisor treats No session found with ID as a failure"]) == .none)
  }

  /// `exited` asks this on the last 40 rows of a dead pane: a crash in a thread that quoted the line fails as
  /// `resume_missing`, whose way out is Start fresh, which drops the conversation.
  @Test func FINDING_aQuotedResumeErrorIsNotAMissingSession() {
    #expect(!DialogMatcher.resumeMissing(["  the supervisor treats No session found with ID as a failure"]))
  }
}
