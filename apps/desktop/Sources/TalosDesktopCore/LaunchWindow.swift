import Foundation

/// Whether to open the main Talos window as the app starts. Once per launch, and only when there is a relay to show and the
/// first-run setup is done: without a relay the window would be empty, and on a first run (no desktop.json yet) the setup
/// checklist should be the only thing on screen. A start at login counts as a launch, so the window opens then too (the owner
/// can turn it off in Mac settings). A rescue relaunch by the watchdog does not: the owner did not start that one.
public struct LaunchWindowGate: Sendable {
  private var spent = false
  public init() {}

  /// True at most once for the life of this value, and only when every condition holds. A refusal does not use up the gate.
  public mutating func shouldOpen(enabled: Bool, hasRelay: Bool, setUp: Bool = true, rescueRelaunch: Bool = false) -> Bool {
    guard enabled, hasRelay, setUp, !rescueRelaunch, !spent else { return false }
    spent = true
    return true
  }
}
