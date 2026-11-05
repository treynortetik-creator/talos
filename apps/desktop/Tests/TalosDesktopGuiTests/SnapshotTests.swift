import AppKit
import Foundation
import Testing
import WebKit
import TalosDesktopCore
@testable import TalosDesktop

/// Not an assertion suite: renders the web window's page to a PNG so a human can look at it (DESKTOP-SPEC: render and
/// look at any UI). Runs only with TALOS_GUI_TESTS=1 and TALOS_SNAPSHOT_URL (a local dev server) + TALOS_SNAPSHOT_OUT.
@MainActor
@Suite("Snapshot", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled && ProcessInfo.processInfo.environment["TALOS_SNAPSHOT_URL"] != nil))
struct SnapshotTests {
  @Test func rendersTheHostedPage() async throws {
    let env = ProcessInfo.processInfo.environment
    let url = try #require(env["TALOS_SNAPSHOT_URL"].flatMap(RelayOrigin.init))
    let out = env["TALOS_SNAPSHOT_OUT"] ?? "/tmp/talos-window.png"
    _ = NSApplication.shared
    let c = WebController()
    var seen: [WebToNative] = []
    c.testHook = { seen.append($0) }
    c.configure(relay: url)
    c.prepare()
    let wv = try #require(c.webView)
    wv.frame = NSRect(x: 0, y: 0, width: 1120, height: 780)
    try await Task.sleep(nanoseconds: 4_000_000_000)
    let cfg = WKSnapshotConfiguration()
    let image = try await wv.takeSnapshot(configuration: cfg)
    let tiff = try #require(image.tiffRepresentation)
    let rep = try #require(NSBitmapImageRep(data: tiff))
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: out))
    print("SNAPSHOT messages from the page: \(seen)")
  }
}
