import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The key guard (`KeyGuard`) through the real senders, on real panes (a private tmux server, never `-L talos`, and the app-owned pty), where
/// the guard is the only thing between the key and the screen: every other check the sender makes says yes.
@Suite("The key guard on real panes", .serialized)
struct KeyGuardIntegrationTests {
  /// Main's auto-accept: the warning's words sit in the scrollback above a frame rule, and the live select below it reads like the warning's
  /// options. `classify` on the whole pane names the warning and `AutoConfirmGuard` allows the Enter; the guard reads the live region alone,
  /// refuses, and the owner is asked (the cold start's Needs-you), with no key sent.
  @Test(arguments: bothHosts)
  func mainsAutoAcceptPressesNothingWhenOnlyTheScrollbackNamesTheWarning(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-scrollback.sh")
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.screenContains("Pick how this session pays") })
    if case .devChannels = DialogMatcher.classify(r.host.visibleRows() ?? []) {} else { Issue.record("control: the whole pane reads as the warning") }
    r.expectHeldAtNeedsYou("screenChanged")
    #expect(r.audit.contains("key_refused intent=dev_channels session=main why=not_dev_channels"), "audit: \(r.audit)")
  }

  /// The owed pointer: an unknown menu drawn under Claude's empty input box (SYNTHETIC: Fixtures/synthetic/unknown-menu-under-box.txt). The
  /// screen reads as no dialog and no prompt, the box as empty, so the typing guard says yes; the key guard refuses (a row under the box that
  /// Claude Code never draws there), nothing is typed, and the thread is told once why, as needs-you, never silent.
  @Test(.enabled(if: Rig.hasTmux))
  func anUnknownMenuUnderTheBoxGetsNoPointerAndTheThreadIsTold() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "screen:unknown-menu-under-box"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    let audit = r.root + "/audit.log"
    r.mgr.tune {
      $0.draftNoticeAfter = 1.5
      $0.auditLogPath = audit
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let pane = { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out }
    #expect(r.wait(10) { pane().contains("Buy $50 of extra usage") })
    let rows = TmuxCommands.parseCapture(pane())
    #expect(DialogMatcher.liveDialog(rows) == .none && PromptDetector.detect(rows) == nil, "control: nothing else stops the pointer")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind }, "\(r.mgr.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == WorkerNotice.refusedLine())
    usleep(1_500_000)
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    #expect(!pane().contains("❯\u{00A0}Talos"), "nothing typed into the box")
    #expect(log.all.count == 1, "once: \(log.all)")
    #expect(completeLines(audit).contains { $0.contains("key_refused thread=trip intent=box-empty why=row_under_box") }, "\(completeLines(audit))")
  }
}
