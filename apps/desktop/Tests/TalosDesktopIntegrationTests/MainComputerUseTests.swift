import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The computer-use permission dialog on MAIN's pane: after its normal start (the warning's Enter, the notice), the fake draws the REAL
/// 2.1.322 dialog and logs every key it gets (`main-computer-use.sh`). The supervisor presses Escape and nothing else, once, says so in its
/// log and tells the phone in one fixed line, and Main is needs-you only while it is up. Real private tmux server; the fake `talos-app`.
@Suite("Computer-use dialog on Main", .serialized, .enabled(if: Rig.hasTmux))
struct MainComputerUseTests {
  @Test func mainGetsEscapeOnlyAndTheOwnerOneLine() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "main-computer-use.sh", env: ["FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: r.stateDir + "/cu", contents: nil)
    #expect(r.wait(15) { keys.keys == ["ESC"] }, "keys: \(keys.keys) audit: \(r.audit)")
    #expect(r.wait(5) { r.audit.contains("dialog_dismissed kind=computer_use_permissions") }, "audit: \(r.audit)")
    #expect(r.wait(10) { r.posts.contains { $0.contains(ComputerUseDismiss.ownerLine) } }, "posts: \(r.posts)")
    #expect(r.wait(10) { !r.screenContains(DialogMatcher.Strings.computerUseTitle) })
    #expect(r.wait(10) { r.sup.status.needsYou == nil }, "\(String(describing: r.sup.status.needsYou))")
    Thread.sleep(forTimeInterval: 1.5)
    #expect(keys.keys == ["ESC"], "no Enter, no arrow, no second Escape: \(keys.keys)")
    #expect(r.posts.filter { $0.contains(ComputerUseDismiss.ownerLine) }.count == 1)
    #expect(isRunning(r.phase()), "Main was not stopped for it: \(r.phase())")
  }

  /// Which needs-you raises Terminals: never the computer-use dialog's, still every other dialog's.
  @Test func theComputerUseDialogNeverOpensTerminals() {
    #expect(!Supervisor.opensTerminal(for: .dialog(DialogMatcher.Screen.computerUsePermissions.label)))
    #expect(Supervisor.opensTerminal(for: .dialog(DialogMatcher.Screen.trust.label)))
  }

  /// An Escape that does not take leaves the dialog for the owner. Main is needs-you on it (the stuck path and the generic dialog stall, with
  /// `dialogStall` 0 so both fire), and Terminals is NOT brought forward with "open the terminal when the agent needs you" on (the default):
  /// Enter on the dialog's first row opens System Settings. The menu line names Esc and never "answer". Still one key in all.
  @Test func aDialogLeftForTheOwnerNeverRaisesTerminalsAndItsLineSaysEsc() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    var t = Rig.defaultTimings()
    t.dialogStall = 0
    let r = try Rig(.tmux, scenario: "main-computer-use.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_DLG_STICKY": "1"], timings: t)
    defer { r.teardown() }
    #expect(r.config.openTerminalOnDialog, "the setting is on, so only the kind can keep Terminals back")
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: r.stateDir + "/cu", contents: nil)
    #expect(r.wait(15) { keys.keys == ["ESC"] }, "keys: \(keys.keys) audit: \(r.audit)")
    let label = DialogMatcher.Screen.computerUsePermissions.label
    #expect(
      r.wait(ComputerUseDismiss.stuckAfter + 10) { r.audit.contains("why=stall:\(label)") && r.sup.status.needsYou == .dialog(label) },
      "needsYou \(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    #expect(r.allEvents.contains(.needsYou(.dialog(label))))
    Thread.sleep(forTimeInterval: 1.5)
    #expect(!r.allEvents.contains(.openTerminal), "Terminals is never raised onto this dialog: \(r.allEvents)")
    #expect(keys.keys == ["ESC"], "no Enter, no arrow, no second Escape: \(keys.keys)")
    let line = SupervisorNotice.mainDialog(label)
    #expect(line == "the computer-use permissions dialog is on Main's pane; press Esc there to close it (Esc only: Enter opens System Settings)")
    for word in ["answer", "approve", "accept", "confirm", "grant"] { #expect(!line.lowercased().contains(word), "\(word): \(line)") }
  }
}
