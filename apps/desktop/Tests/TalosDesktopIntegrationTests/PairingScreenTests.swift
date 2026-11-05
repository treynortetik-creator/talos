import Foundation
import SwiftTerm
import Testing
@testable import TalosDesktopCore

/// The pairing pane reads the enroll link from the terminal's own buffer. A relay address longer than the pane is wrapped
/// by the terminal; the rows' `isWrapped` flag joins it back to one link (headless Terminal, no window).
private final class NullDelegate: TerminalDelegate {
  func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

@Suite("Pairing screen text")
struct PairingScreenTests {
  let code = "0123456789ABCDEFGHJKMNPQRS"

  @Test func aWrappedLinkIsStillOneLink() {
    var opts = TerminalOptions.default
    opts.cols = 60
    opts.rows = 12
    let term = Terminal(delegate: NullDelegate(), options: opts)
    let host = "https://a-long-relay-host-name-for-testing.up.example.net"
    term.feed(text: "Open this link on the device you want to add:\r\n\(host)/enroll#\(code)\r\nWaiting for the device\r\n")
    let rows = (0..<term.rows).map { r -> (text: String, wrapped: Bool) in
      let line = term.getLine(row: r)
      return (line?.translateToString(trimRight: true) ?? "", line?.isWrapped ?? false)
    }
    let screen = ScreenText.join(rows)
    var s = PairingSession(relay: RelayOrigin(host))
    #expect(s.update(screen: screen) == code, "screen was: \(screen.debugDescription)")
  }
}
