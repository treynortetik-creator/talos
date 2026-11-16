import CoreGraphics
import Foundation
import Testing
import TalosTestSupport
@testable import TalosDesktopCore

/// The real ScreenCaptureKit filter, on this Mac's real screen. A throwaway helper (`osascript`, so it has no bundle id and is
/// never on an allow list) shows a small magenta window above everything for a few seconds; an agent capture must not contain
/// one magenta pixel. Its control, an owner capture of that same window, must. Nothing is written to disk but the helper's
/// script, and the images stay in memory.
///
/// Runs only when this test process may record the screen (macOS charges the grant to whatever started the tests: the
/// terminal, or Talos.app). Otherwise it is skipped, and says why.
@Suite("Screen capture: the real filter", .serialized)
struct ScreenCaptureRealTests {
  static func granted() -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    print(
      "ScreenCaptureRealTests skipped: macOS has not given Screen Recording to the program that started this test run "
        + "(CGPreflightScreenCaptureAccess() is false), so the real filter cannot be tried. Grant it to that terminal or app "
        + "in System Settings → Privacy & Security → Screen & System Audio Recording, then run the tests again.")
    return false
  }

  static let script = """
    ObjC.import('Cocoa');
    var app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    var w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
      $.NSMakeRect(60, 60, 220, 140), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    w.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0, 1, 1);
    w.level = $.NSFloatingWindowLevel;
    w.sharingType = $.NSWindowSharingReadOnly;
    w.orderFrontRegardless;
    w.display;
    console.log('ready ' + w.windowNumber);
    var end = $.NSDate.dateWithTimeIntervalSinceNow(20);
    while (end.timeIntervalSinceNow > 0) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
    }
    """

  /// Starts the helper and answers its process and window number.
  static func showMagentaWindow() throws -> (Process, UInt32, String) {
    let dir = TestTemp.base + "screen-real-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let path = dir + "/magenta-window.js"
    try Data(script.utf8).write(to: URL(fileURLWithPath: path))
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-l", "JavaScript", path]
    let err = Pipe()
    p.standardError = err
    p.standardOutput = FileHandle.nullDevice
    let lines = LockedText()
    err.fileHandleForReading.readabilityHandler = { h in lines.append(String(decoding: h.availableData, as: UTF8.self)) }
    try p.run()
    let w = waitUntil(timeout: 15, observe: { lines.text }) { $0.contains("ready ") || !p.isRunning }
    err.fileHandleForReading.readabilityHandler = nil
    guard w.ok, let n = lines.text.split(separator: "\n").first(where: { $0.hasPrefix("ready ") }).flatMap({ UInt32($0.dropFirst(6)) })
    else {
      p.terminate()
      try? FileManager.default.removeItem(atPath: dir)
      throw ScreenRefusal.captureFailed("the helper window never came up: \(w)")
    }
    return (p, n, dir)
  }

  @Test(.enabled(if: granted()), .timeLimit(.minutes(1)))
  func anUngrantedAppsWindowNeverAppearsInAnAgentCapture() async throws {
    let (helper, windowID, dir) = try Self.showMagentaWindow()
    defer {
      helper.terminate()
      helper.waitUntilExit()
      try? FileManager.default.removeItem(atPath: dir)
    }
    let core = ScreenCore.live(maxLongEdge: ScreenPNG.largestMaxLongEdge)
    let backend = LiveScreenCapture()
    var window: ScreenWindow?
    for _ in 0..<50 {
      window = try await backend.content().windows.first { $0.id == windowID }
      if window != nil { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    let w = try #require(window, "the helper's window \(windowID) is not in ScreenCaptureKit's list")
    print("ScreenCaptureRealTests: helper window \(w.id) owner \(w.ownerBundleID ?? "no id") pid \(w.ownerPID) at \(w.frame)")
    #expect(w.ownerBundleID == nil)

    // Control: unfiltered, the window is magenta. Without this the check below would pass on a blank image.
    let control = try await core.ownerCapture(mode: .window(windowID))
    #expect(try colours(of: control).contains { near($0, .magenta, slack: 25) }, "the control capture shows no magenta")
    let ownerRegion = try await core.ownerCapture(mode: .region(w.frame))
    #expect(try colours(of: ownerRegion).contains { near($0, .magenta, slack: 25) }, "the owner's region capture shows no magenta")

    // The agent: some other app allowed. Over the window's own region, and the whole display.
    let others: Set<String> = ["com.apple.finder"]
    for area in [ScreenArea.region(w.frame), .full] {
      let shot = try await core.agentCapture(allowedBundleIDs: others, area: area)
      let hits = try colours(of: shot).filter { near($0, .magenta, slack: 25) }
      print("ScreenCaptureRealTests: agent \(area): \(shot.width)x\(shot.height), shows \(shot.shownApps ?? []), hid \(shot.hiddenWindows)")
      #expect(hits.isEmpty, "\(area): the ungranted window showed: \(hits)")
      #expect(shot.hiddenWindows >= 1)
    }
    await #expect(throws: ScreenRefusal.appNotAllowed(app: "an app with no id", subject: .running(pid: w.ownerPID))) {
      try await core.agentCapture(allowedBundleIDs: others, area: .window(windowID))
    }
  }
}

final class LockedText: @unchecked Sendable {
  private let lock = NSLock()
  private var _text = ""
  var text: String { lock.withLock { _text } }
  func append(_ s: String) { lock.withLock { _text += s } }
}
