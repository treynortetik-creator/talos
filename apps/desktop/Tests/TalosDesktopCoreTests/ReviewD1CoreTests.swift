import Foundation
import Testing
@testable import TalosDesktopCore

/// Regression tests for the dev-channel guard. Each test states what the design requires.
@Suite("Review D1: dev-channel guard")
struct ReviewD1GuardTests {
  let id = "0f1e2d3c-4b5a-4968-8776-655443322110"

  func decide(_ rows: [String], approved: [String]) -> AutoConfirmGuard.Decision {
    AutoConfirmGuard.decide(
      AutoConfirmGuard.Inputs(
        enabled: true, startKind: .supervisorRestart, launchedResumeId: id,
        session: DesktopConfig.Session(
          id: id, confirmedAt: "2026-10-30T00:00:00Z", confirmedCliVersion: "2.1.312", approvedDevChannels: approved),
        cliVersion: "2.1.312", screen: DialogMatcher.classify(rows), confirmsThisStart: 0, loop: CrashLoop(), now: 100))
  }

  /// 2.1.312 renders `Channels: a, b` as an Ink <Text> (DevChannelsDialog: `["Channels:", " ", m.map(R).join(", ")]`).
  /// Ink word-wraps that Text itself with hard newlines, so `capture-pane -J` can't re-join it: when the pane is
  /// narrower than the list (the D2 viewer or `tmux attach` from a narrow terminal resizes the window), an extra channel
  /// lands on the next row. The guard must not see only the first row and call it "exactly the approved list".
  @Test func anExtraChannelWrappedOntoTheNextRowIsNotHidden() {
    var rows = devDialog(channels: "server:talos-app,")
    let at = rows.firstIndex { $0.contains("Channels:") }!
    rows.insert(" server:talos-app-evil", at: at + 1)
    #expect(decide(rows, approved: ["server:talos-app"]) != .confirm, "a wrapped extra channel was auto-confirmed")
  }

  /// Spec 4.4: "byte-for-byte". Swift `==` on String is Unicode canonical equivalence, so a channel whose name is a
  /// different byte sequence (NFD vs NFC) compares equal.
  @Test func channelNamesCompareByteForByte() {
    let approved = "server:caf\u{00E9}"  // é precomposed
    let shown = "server:cafe\u{0301}"  // e + combining acute: different bytes, different MCP server name
    #expect(Array(approved.utf8) != Array(shown.utf8))
    #expect(decide(devDialog(channels: shown), approved: [approved]) != .confirm, "canonically-equal lookalike confirmed")
  }
}
