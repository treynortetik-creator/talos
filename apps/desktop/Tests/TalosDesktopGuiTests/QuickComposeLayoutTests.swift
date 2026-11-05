import AppKit
import Foundation
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// The panel's layout, read from frames (a headless test process never paints a window, so pixels can't be checked).
@MainActor
@Suite("QuickCompose layout", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct QuickComposeLayoutTests {
  @Test func signedOutShowsOnlySignInFirstAndTheComposeColumnFillsTheWidth() throws {
    _ = NSApplication.shared
    let root = try #require(QuickCompose.shared.contentViewForTest())
    defer { QuickCompose.shared.toggle() }
    let stacks = root.subviews.compactMap { $0 as? NSStackView }
    #expect(stacks.count == 2)
    let compose = try #require(stacks.first)
    let signIn = try #require(stacks.last)
    #expect(compose.isHidden, "not signed in: no compose field")
    #expect(!signIn.isHidden)
    #expect(compose.frame.width >= root.frame.width - 40, "the compose column fills the panel, not its smallest size")
    let labels = signIn.subviews.compactMap { ($0 as? NSTextField)?.stringValue } + signIn.subviews.compactMap { ($0 as? NSButton)?.title }
    // Which line shows depends on the page: signed out, still loading, or unreachable (this test sets none of them up).
    let lines = ["Sign in first", "Connecting to Talos…", PageState.unreachableLine]
    #expect(labels.contains { lines.contains($0) } && labels.contains("Open Talos"), "labels: \(labels)")
  }
}
