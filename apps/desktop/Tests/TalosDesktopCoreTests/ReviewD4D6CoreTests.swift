import Foundation
import Testing
@testable import TalosDesktopCore

/// Regression tests for the desktop quick-compose, hotkey and install work. Each test states the behaviour the design asks
/// for. `structural` tests read app-layer source because that code has no seam a test can reach;
/// the missing seam is a known gap, and each one should be replaced by a real test when the logic moves to Core.
private func source(_ relative: String) throws -> String {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
}

/// The text between the braces of the first body after `marker`.
private func swiftBody(_ src: String, after marker: String) throws -> String {
  let at = try #require(src.range(of: marker), "no \(marker) in the source")
  let open = try #require(src[at.upperBound...].firstIndex(of: "{"))
  var depth = 0
  var i = open
  while i < src.endIndex {
    if src[i] == "{" { depth += 1 }
    if src[i] == "}" {
      depth -= 1
      if depth == 0 { return String(src[src.index(after: open)..<i]) }
    }
    i = src.index(after: i)
  }
  throw SourceError.unbalanced
}

private enum SourceError: Error { case unbalanced }

@Suite("ReviewD4 status")
struct ReviewD4StatusTests {
  func icon(_ i: HealthModel.Inputs) -> HealthSummary.Icon { HealthModel.summarize(i).icon }
  let running = HealthModel.Session.running(activity: "idle")

  /// Brief: "unknown" must not read as fine or as down. Today every Mac reads this way: the bridge half isn't deployed.
  @Test func anUnknownBridgeIsNotShownAsFine() {
    #expect(icon(.init(session: running, bridge: nil, relayReachable: true)) != .ok)
    #expect(icon(.init(session: running, bridge: nil, relayReachable: true)) != .down)
  }

  @Test func aRelayNotYetCheckedIsNotShownAsFine() {
    #expect(icon(.init(session: running, bridge: .healthy, relayReachable: nil)) != .ok)
  }

  /// 6.2: healthy means fresh, alive, live and connected. Each of these fails that and its own menu line says so.
  @Test(arguments: [BridgeStatus.Health.stale, .relayDown, .headless])
  func aBridgeThatIsNotHealthyNeverShowsTheOKIcon(_ h: BridgeStatus.Health) {
    #expect(icon(.init(session: running, bridge: h, relayReachable: true)) != .ok)
  }

  /// "updated_at < 45 s old": a file stamped in the future, or exactly 45 s ago, is not that.
  @Test func aFutureOrBoundaryTimestampIsNotHealthy() throws {
    func status(_ at: Date) -> BridgeStatus {
      BridgeStatus(
        pid: 1, mode: .live, relayConnected: true, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false,
        updatedAt: at)
    }
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(status(now.addingTimeInterval(3600)).health(now: now, pidAlive: { _ in true }) != .healthy)
    #expect(status(now.addingTimeInterval(-45)).health(now: now, pidAlive: { _ in true }) != .healthy)
  }
}

@Suite("ReviewD4 notifications")
struct ReviewD4NotificationTests {
  /// NotificationPolicy.swift:4 says no message text can get in. `web` passes the page's body straight through.
  @Test func aPageCannotPutMessageTextInABanner() {
    let n = NotificationPolicy.web(
      title: "Talos", body: "the biopsy came back, call Dr Lee", navigate: "/t/general", tag: "thread:general", windowIsKey: false)
    #expect(n == nil || n?.body.contains("biopsy") == false)
  }

  /// Control for the fix: the phrases `buildPushPayload` really makes must keep working.
  @Test(arguments: ["New reply in General", "Needs you in a thread", "Answer ready in a thread"])
  func thePushPhrasesStillPass(_ body: String) {
    #expect(NotificationPolicy.web(title: "Talos", body: body, navigate: "/t/general", tag: nil, windowIsKey: false)?.body == body)
  }
}

@Suite("ReviewD5 hotkey")
struct ReviewD5HotkeyTests {
  /// Compose.swift:60 lists "cmd+opt+esc", but the canonical text is "opt+cmd+esc", so the entry can never match.
  @Test func forceQuitIsRefused() {
    #expect(throws: HotkeySpec.ParseError.self) { try HotkeySpec.parse("cmd+opt+esc") }
  }

  /// A bound hotkey is swallowed in every app. ⌘C anywhere would open compose instead of copying; ⌃C would stop reaching
  /// every terminal; ⌥E is how a lot of people type é.
  @Test(arguments: ["cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+a", "cmd+s", "cmd+w", "cmd+shift+tab", "ctrl+c", "ctrl+d", "opt+e"])
  func everydayKeysCannotBeBoundSystemWide(_ text: String) {
    #expect(throws: HotkeySpec.ParseError.self) { try HotkeySpec.parse(text) }
  }

  /// structural. Nothing a test can call says where the panel lands (the placement is private to QuickCompose and the test
  /// cannot show a panel), so this reads the two places that decide it: `show` falls back to the screen in use, and that
  /// function finds the screen under the pointer. `NSWindow.center()` keeps the panel on the screen it was last on.
  @Test func thePanelOpensOnTheScreenInUse() throws {
    let s = try source("Sources/TalosDesktop/QuickCompose.swift")
    let show = try swiftBody(s, after: "func show(anchor")
    #expect(show.contains("else { centerOnScreenInUse() }"), "an unanchored show goes to the screen in use")
    let place = try swiftBody(s, after: "func centerOnScreenInUse()")
    #expect(place.contains("NSEvent.mouseLocation"))
    #expect(place.contains("NSMouseInRect(mouse, $0.frame, false)"), "the screen the pointer is on")
    #expect(place.contains("setFrameOrigin"), "and the panel is put there, not left where it was")
  }
}

@Suite("ReviewD6 checklist")
struct ReviewD6ChecklistTests {
  func row(_ id: String, _ i: FirstRun.Inputs) -> FirstRun.Row? { FirstRun.rows(i).first { $0.id == id } }

  /// Onboarding.swift:37 passes "" for "found but the version didn't read". Unknown is not "Not found".
  @Test func aClaudeThatWasFoundIsNotReportedMissing() throws {
    let r = try #require(row("claude", .init(claudeVersion: "", home: "/h")))
    if case .fix(let m) = r.state { #expect(!m.contains("Not found")) }
  }

  @Test func anOldTmuxIsNotReportedMissing() throws {
    let r = try #require(row("tmux", .init(tmuxVersionOutput: "tmux 3.1c", home: "/h")))
    if case .fix(let m) = r.state { #expect(!m.contains("Not found")) }
  }
}
