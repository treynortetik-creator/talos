import AppKit
import Foundation
import Testing

@testable import TalosDesktop
@testable import TalosDesktopCore

/// A recording rig, not a check: it puts the real sprite view and the real art in a plain window on the main display and drives
/// the real reducer on the real clock for `TALOS_IDLE_RECORD` seconds, so a screen recording shows what he does while he waits
/// (his base loop, and a new clip every 3 to 10 seconds). Off unless that variable is set. It touches no defaults, no session and
/// no other window: the window is its own.
///   TALOS_IDLE_RECORD=25 TALOS_IDLE_STATE=idle|needs TALOS_IDLE_ORIGIN=80,120 TALOS_GUI_TESTS=1 apps/desktop/scripts/test.sh --filter CompanionIdleRecordGuiTests
/// The window is 240 x 240 pt on a dark ground with the figure in the middle; capture it with `screencapture -v -R`.
@MainActor
@Suite("Companion idle recording rig", .serialized, .guiExclusive, .enabled(if: ProcessInfo.processInfo.environment["TALOS_IDLE_RECORD"] != nil))
struct CompanionIdleRecordGuiTests {
  @Test func playsTheIdleLifeOnTheRealClock() throws {
    let env = ProcessInfo.processInfo.environment
    let seconds = Double(env["TALOS_IDLE_RECORD"] ?? "") ?? 25
    let needs = env["TALOS_IDLE_STATE"] == "needs"
    let origin = (env["TALOS_IDLE_ORIGIN"] ?? "80,120").split(separator: ",").compactMap { Double($0) }
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    guard case .success(let atlas) = LoadedAtlas.load(directory: CompanionRenderGuiTests.art, scale: 2, mini: false) else {
      throw CompanionRenderGuiTests.Failure("real art did not load")
    }
    let size = CompanionPlacement.size(mini: false)
    let win = NSWindow(contentRect: NSRect(x: origin[0], y: origin[1], width: 240, height: 240), styleMask: .borderless, backing: .buffered, defer: false)
    win.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.07, blue: 0.065, alpha: 1)
    win.level = .floating
    win.isReleasedWhenClosed = false
    let sprite = CompanionSpriteView(frame: NSRect(x: 72, y: 68, width: size.width, height: size.height))
    sprite.setAtlas(atlas, mini: false)
    win.contentView?.addSubview(sprite)
    win.orderFrontRegardless()

    var model = CompanionModel(random: { Double.random(in: $0) })
    var inputs = CompanionInputs()
    inputs.quiet = false
    inputs.session = .running(busy: false)
    inputs.needs = needs ? 1 : 0
    var e = CompanionEnv()
    e.secondsSinceInput = 1
    e.antics = atlas.manifest.antics(among: CompanionModel.idleAntics.keys)
    e.needsClips = atlas.manifest.antics(among: CompanionModel.needsAntics.keys)
    let t0 = ProcessInfo.processInfo.systemUptime
    var log: [String] = []
    var lastSeq = -1
    while ProcessInfo.processInfo.systemUptime - t0 < seconds {
      let mono = ProcessInfo.processInfo.systemUptime
      let o = model.update(inputs, env: e, mono: mono, wall: Date())
      if let a = o.animation, a.seq != lastSeq {
        lastSeq = a.seq
        log.append(String(format: "%5.1fs %@", mono - t0, a.clip))
      }
      sprite.apply(CompanionLook(output: o, stillOnly: false, animationsAllowed: true, mini: false))
      RunLoop.main.run(until: Date().addingTimeInterval(0.25))
    }
    print("IDLE-RECORD clips: \(log)")
    win.orderOut(nil)
    sprite.release()
  }
}
