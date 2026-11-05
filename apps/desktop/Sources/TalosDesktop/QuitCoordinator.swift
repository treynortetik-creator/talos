import AppKit
import Foundation
import TalosDesktopCore

/// Every quit passes through here: the top menu, the menu bar, the Dock menu and the system (Activity Monitor, an update, logout).
/// `TalosAppDelegate.applicationShouldTerminate` asks `shouldTerminate()`; the answer follows `QuitPlan`. A held quit stops the
/// agent inside a hard time limit and then replies to AppKit, so nothing calls `terminate` a second time and nothing re-enters.
@MainActor
final class QuitCoordinator {
  static let shared = QuitCoordinator()

  struct Hooks {
    var inputs: () -> QuitPlan.Inputs
    var stop: () -> Void
    var isStopped: () -> Bool
    /// `NSApp.reply(toApplicationShouldTerminate:)`; a test records it instead.
    var reply: (Bool) -> Void
    var uptime: () -> Double = { ProcessInfo.processInfo.systemUptime }
    var limit: Double = QuitPlan.stopLimit
  }

  var hooks: Hooks?
  /// Set by "Quit and stop the agent": stop first even with tmux.
  var stopRequested = false
  /// When the system announced a logout or shutdown (uptime seconds). It counts for `powerOffWindow` only: another app can block
  /// a logout, and Talos then keeps running, so a flag that never expired would skip the safe stop of every later quit.
  private var powerOffAt: Double?
  static let powerOffWindow: Double = 30
  var systemPowerOff: Bool {
    guard let at = powerOffAt else { return false }
    return (hooks?.uptime() ?? ProcessInfo.processInfo.systemUptime) - at < Self.powerOffWindow
  }
  private var driver: QuitDriver?
  private var timer: Timer?
  private var finished = false
  private var answering = false
  private var finishedWhileAnswering = false
  private var observer: NSObjectProtocol?

  /// A logout, restart or shutdown was announced: a held quit ends at once and a new one never waits.
  func systemWillPowerOff() {
    powerOffAt = hooks?.uptime() ?? ProcessInfo.processInfo.systemUptime
    if driver?.isRunning == true { complete() }
  }

  func observePowerOff() {
    guard observer == nil else { return }
    observer = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.systemWillPowerOff() }
    }
  }

  func shouldTerminate() -> NSApplication.TerminateReply {
    if finished { return .terminateNow }
    guard let h = hooks else { return .terminateNow }
    if let d = driver, d.isRunning { return .terminateLater }  // a second Quit joins the stop that is running
    var i = h.inputs()
    i.systemPowerOff = systemPowerOff
    i.stopRequested = stopRequested
    switch QuitPlan.decide(i) {
    case .terminateNow:
      return .terminateNow
    case .terminateNowAfterStopRequest:
      h.stop()
      return .terminateNow
    case .stopThenTerminate:
      let d = QuitDriver(
        limit: h.limit, uptime: h.uptime, stop: h.stop, isStopped: h.isStopped,
        finish: { [weak self] _ in MainActor.assumeIsolated { self?.driverFinished() } })
      driver = d
      answering = true
      finishedWhileAnswering = false
      d.begin()
      d.poll()  // an agent that was never running is already stopped: no need to hold the quit
      answering = false
      if finishedWhileAnswering {
        finished = true
        return .terminateNow
      }
      startTimer(d)
      return .terminateLater
    }
  }

  private func startTimer(_ d: QuitDriver) {
    timer?.invalidate()
    // `.common`: while a quit is held AppKit runs the loop in a modal mode, and a default-mode timer would never fire.
    let t = Timer(timeInterval: 0.2, repeats: true) { _ in d.poll() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func driverFinished() {
    if answering { finishedWhileAnswering = true } else { complete() }
  }

  private func complete() {
    guard !finished else { return }
    finished = true
    timer?.invalidate()
    timer = nil
    hooks?.reply(true)
  }

  /// "Quit and stop the agent": the same path as every other quit, with the stop forced.
  func quitAndStop(terminate: () -> Void = { NSApp.terminate(nil) }) {
    stopRequested = true
    terminate()
  }

  /// Tests only.
  func resetForTests() {
    timer?.invalidate()
    timer = nil
    driver = nil
    hooks = nil
    stopRequested = false
    powerOffAt = nil
    finished = false
    answering = false
    finishedWhileAnswering = false
  }
}
