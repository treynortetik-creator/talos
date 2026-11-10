import Foundation
import Testing

@testable import TalosDesktopCore

/// The real dialog of Main's first start with the seal (Tests/Fixtures/real-dev-channels): the matcher reads it, and the keys to "Exit" are
/// the ones the popup and the card send (Down, then Enter).
@Suite("The real development-channels capture")
struct DevChannelsCaptureTests {
  static let rows: [String] = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(
      "Fixtures/real-dev-channels/dev-channels-capture.txt")
    return ((try? String(contentsOf: url, encoding: .utf8)) ?? "").components(separatedBy: "\n")
  }()

  @Test func theMatcherReadsTheRealCapture() {
    #expect(Self.rows.count > 5, "the fixture was read")
    guard case .devChannels(let d) = DialogMatcher.classify(Self.rows) else {
      Issue.record("not read as the development-channels dialog")
      return
    }
    #expect(d.channels == ["server:talos-app"])
    #expect(d.highlighted == DialogMatcher.Strings.devConfirm)
    #expect(d.titleCount == 1 && d.channelLineCount == 1)
  }

  /// Down moves the highlight to "Exit" (row 2): the screen after the Down is read as Exit highlighted, and from there Enter is the Exit.
  @Test func downFromTheFirstRowLandsOnExit() {
    let afterDown = Self.rows.map { $0.replacingOccurrences(of: "❯ 1.", with: "  1.").replacingOccurrences(of: "  2. Exit", with: "❯ 2. Exit") }
    guard case .devChannels(let d) = DialogMatcher.classify(afterDown) else {
      Issue.record("the screen after Down is not the dialog")
      return
    }
    #expect(d.highlighted == DialogMatcher.Strings.devExit)
  }
}
