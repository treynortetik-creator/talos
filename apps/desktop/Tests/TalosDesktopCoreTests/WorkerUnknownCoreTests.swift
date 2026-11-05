import Foundation
import Testing
import TalosDesktopCore

/// "Uncertain state must never cause an action": the core half. The strings are real output, captured from tmux 3.8 on a
/// private socket and read from the Claude Code 2.1.314 binary on 2026-10-30.
@Suite("Option C unknowns, core")
struct WorkerUnknownCoreTests {
  @Test(arguments: [
    "can't find session: t-trip",
    "no server running on /private/tmp/tmux-501/talos-test-1-a",
    "error connecting to /private/tmp/tmux-501/talos-test-1-a (No such file or directory)",
  ])
  func whatTmuxSaysWhenASessionIsGone(_ err: String) {
    #expect(TmuxCommands.saysGone(status: 1, stderr: err + "\n", timedOut: false))
  }

  @Test(arguments: [
    "error connecting to /private/tmp/tmux-501/talos (Resource temporarily unavailable)",
    "error connecting to /private/tmp/tmux-501/talos (Too many open files)",
    "server exited unexpectedly",
    "lost server",
    "",
    "The file \u{201C}tmux\u{201D} doesn\u{2019}t exist. (No such file or directory)",  // Process.run throwing: status 127
    "some wording from a tmux nobody has seen yet",
  ])
  func anyOtherFailureSaysNothing(_ err: String) {
    #expect(!TmuxCommands.saysGone(status: 1, stderr: err, timedOut: false))
    #expect(!TmuxCommands.saysGone(status: 127, stderr: err, timedOut: false))
  }

  @Test func onlyTmuxsOwnWordsForAServerOnItsWayOutAreAskedAgain() {
    #expect(TmuxCommands.saysServerWentAway(status: 1, stderr: "server exited unexpectedly\n", timedOut: false))
    #expect(!TmuxCommands.saysServerWentAway(status: 1, stderr: "lost server", timedOut: false), "not a tmux 3.8 message")
    #expect(!TmuxCommands.saysServerWentAway(status: 1, stderr: "create window failed: no space for new pane", timedOut: false))
    #expect(!TmuxCommands.saysServerWentAway(status: 1, stderr: "", timedOut: false))
  }

  @Test func aTimedOutOrSuccessfulNewSessionIsNeverAskedAgain() {
    // The command may have run: asking again could start the agent twice.
    #expect(!TmuxCommands.saysServerWentAway(status: 15, stderr: "server exited unexpectedly", timedOut: true))
    #expect(!TmuxCommands.saysServerWentAway(status: 0, stderr: "server exited unexpectedly", timedOut: false))
  }

  @Test func aTimeoutOrSuccessIsNeverGone() {
    #expect(!TmuxCommands.saysGone(status: 15, stderr: "can't find session: t-trip", timedOut: true))
    #expect(!TmuxCommands.saysGone(status: 0, stderr: "can't find session: t-trip", timedOut: false))
  }

  @Test func clientActivity() {
    #expect(TmuxCommands.parseClientActivity("") == [])
    #expect(TmuxCommands.parseClientActivity("1793400000\n") == [1_793_400_000])
    #expect(TmuxCommands.parseClientActivity("1793400000\n1793400005\n") == [1_793_400_000, 1_793_400_005])
    // a client we can't read is not "nobody is typing"
    #expect(TmuxCommands.parseClientActivity("\n") == nil)
    #expect(TmuxCommands.parseClientActivity("soon\n") == nil)
    #expect(TmuxCommands.parseClientActivity("1793400000\nsoon\n") == nil)
  }

  @Test func aDedicatedBlockWeCantReadIsUnreadableNotOff() {
    func read(_ s: String) -> DedicatedSettings? { DedicatedSettings.readable(Data(s.utf8)) }
    #expect(read(#"{"dedicated":"yes"}"#) == nil)
    #expect(read(#"{"dedicated":{"enabled":"yes"}}"#) == nil)
    #expect(read("[]") == nil)
    #expect(read("{ half a file") == nil)
    #expect(read(#"{"dedicated":{"enabled":true},"threads":[1]}"#) == nil)
    #expect(read(#"{"dedicated":{"enabled":true},"threads":[]}"#)?.threads.isEmpty == true)
    // control: a file that says off, or says nothing, is off
    #expect(read(#"{"dedicated":{"enabled":false}}"#) == .off)
    #expect(read(#"{"dedicated":{}}"#) == .off)
    #expect(read("{}") == .off)
  }

  @Test func theRealResumeErrorsAreMissingSessions() {
    for row in ["No conversation found with session ID: 6f1c2a9e-4b3d", "No session found with ID 6f1c2a9e-4b3d."] {
      #expect(DialogMatcher.resumeMissing(["", row]))
      #expect(DialogMatcher.workerScreen([row]) == .resumeMissing)
      #expect(!DialogMatcher.workerScreen([row]).isDialog)
    }
    #expect(!DialogMatcher.resumeMissing(["  we saw No conversation found with session ID: x in the log"]))
  }

  @Test func aQuotedLineCantHideARealDialogBelowIt() {
    let screen = [
      "  the log said WARNING: Loading development channels at that point",
      "  the supervisor treats No session found with ID as a failure",
      "Do you trust the files in this folder?",
      "\u{276F} 1. Yes, I trust this folder",
      "  2. No, exit",
    ]
    #expect(DialogMatcher.workerScreen(screen).isDialog)
    // and with no quoted lines, the same dialog: control
    #expect(DialogMatcher.workerScreen(Array(screen.dropFirst(2))).isDialog)
    // a real development-channels dialog keeps its cursor, so it is still one
    #expect(DialogMatcher.workerScreen(["WARNING: Loading development channels", "\u{276F} 1. I am using this for local development"]).isDialog)
  }

  @Test func exactlyTheLongestPathTheProtocolTakes() throws {
    let t = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-u-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: t, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: t) }
    let home = String(cString: realpath(t, nil))
    var fits = home
    while fits.utf16.count < 512 - 100 { fits += "/" + String(repeating: "d", count: 100) }
    fits += "/" + String(repeating: "e", count: 512 - fits.utf16.count - 1)
    #expect(fits.utf16.count == 512)
    try FileManager.default.createDirectory(atPath: fits, withIntermediateDirectories: true)
    #expect(WorkerSpec.folderProblem(fits, home: home, talosHome: home + "/t") == nil)
    let over = fits + "x"
    try FileManager.default.createDirectory(atPath: over, withIntermediateDirectories: true)
    #expect(WorkerSpec.folderProblem(over, home: home, talosHome: home + "/t") != nil)
  }
}
